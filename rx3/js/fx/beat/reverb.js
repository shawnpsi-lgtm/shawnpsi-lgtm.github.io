/**
 * Beat FX REVERB, ported from the XDJ-RX3 v1.19 player (mixerengine::BeatEffectReverb).
 *
 * Topology, per sample:
 *   in x input volume x on/off fade -> pre LPF -> pre HPF = x
 *   7 delay lines, each read at two slewing taps (A -> left, B -> right) with linear interpolation
 *   lines 0-4: feedback combs. tap x gain(percent) -> damping LPF -> written back L/R swapped, plus x
 *   S = x + the five comb taps -> two Schroeder allpasses (lines 5, 6; g = 0.7) -> post LPF -> post HPF = wet
 *   out = in x dry + wet x (wet level x filter make-up)
 * The percent (1-100) scales every delay and picks the comb gains; it moves one step per block, and the taps
 * glide to their new lengths, as on the hardware. The X-PAD (0-255, 128 = neutral) sweeps the post LPF (below
 * 128) or HPF (above). Every operation is rounded to float32 like the firmware's NEON code, so ReverbCore nulls
 * against the original (tests/null-test.mjs).
 */
import { BeatCore } from '../dsp.js';
import { CHASE, DAMP_LPF, DELAY, FEEDBACK, POST_HPF, POST_LPF, PRE_HPF, PRE_LPF } from './reverb-tables.js';

const f = Math.fround;
const FADE_STEP = f(0.0052109998); // on/off fade: ~192 samples
const ALLPASS = f(0.7);

export const meta = {
  name: 'REVERB',
  unit: '%',
  // BEAT left/right steps through these (BeatFxBeatButton in the player's UI)
  beats: [1, 10, 25, 50, 75, 90, 100].map((v) => ({ label: v + '%', value: v })),
  defaultBeat: 3,
  // the X-PAD is a touch strip for the post filter: left closes the LPF, right opens the HPF, release = centre
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 128, left: 'LPF', right: 'HPF' },
};

/** First-order IIR on a stereo pair: y = b0 x + b1 x1 - a1 y1 (dsp::firstOrder_IIRFilter). */
class Iir {
  constructor(table, index = 0) {
    this.set(table, index);
    this.clear();
  }

  set(table, index) {
    this.b0 = table[index * 3];
    this.b1 = table[index * 3 + 1];
    this.a1 = table[index * 3 + 2];
  }

  clear() {
    this.xL = this.xR = this.yL = this.yR = 0;
  }

  run(l, r) {
    const yl = f(f(f(this.b0 * l) + f(this.b1 * this.xL)) - f(this.a1 * this.yL));
    const yr = f(f(f(this.b0 * r) + f(this.b1 * this.xR)) - f(this.a1 * this.yR));
    this.xL = l;
    this.xR = r;
    this.yL = yl;
    this.yR = yr;
  }
}

/** Linear parameter ramp over `len` samples (the firmware's 40-byte smoother; both lanes are always equal). */
class Ramp {
  constructor(len) {
    this.len = len;
    this.inv = f(1 / len);
    this.cur = this.target = this.step = 0;
    this.count = 0;
    this.done = true;
  }

  retarget(t) {
    this.step = f(f(t - f(this.cur + this.step)) * this.inv);
    this.target = t;
    this.count = 0;
    this.done = false;
  }

  jump(v) {
    this.cur = this.target = v;
    this.step = 0;
  }

  tick() {
    if (!this.done) {
      this.cur = f(this.cur + this.step);
      if (this.count >= this.len) {
        this.cur = this.target;
        this.done = true;
      }
      this.count++;
    }
    return this.cur;
  }
}

/** The firmware effect, method for method. Process in blocks: the percent and the X-PAD move once per block. */
export class ReverbCore extends BeatCore {
  constructor(sampleRate, blockSize = 128) {
    super({ ms: 50, minMs: 1, maxMs: 100, button: 5, minButton: 0, maxButton: 11, tail: true, position: 2 });
    const sr = f(sampleRate);
    this.sr = sr;
    const rampLen = Math.trunc(f(f(sr * f(3.3333333)) / 1000)) || 1; // 3.3 ms
    this.inVol = new Ramp(rampLen);
    this.dry = new Ramp(rampLen);
    this.wet = new Ramp(rampLen);
    this.dry.jump(1);
    this.level = 0;
    this.percent = 50;
    this.pctCur = this.pctNext = 50;
    this.pctChanged = false;
    this.xpadCur = this.xpadTarget = 128;
    this.on = false;
    this.keepInit = false;
    this.reset = true;
    this.lpfGain = this.hpfGain = 1;
    this.fade = this.fadeStep = this.fadeTarget = 0;

    this.preLpf = new Iir(PRE_LPF);
    this.preHpf = new Iir(PRE_HPF);
    this.damp = [0, 1, 2, 3, 4].map(() => new Iir(DAMP_LPF));
    this.postLpf = new Iir(POST_LPF, 63);
    this.postHpf = new Iir(POST_HPF, 0);
    this.gL = new Float32Array(5);
    this.gR = new Float32Array(5);
    this.ap = 0;

    // initialize(): tap targets at size 1, and delay lines long enough for the largest size (2.08)
    this.tA = new Int32Array(7);
    this.tB = new Int32Array(7);
    this.posA = new Float32Array(7);
    this.posB = new Float32Array(7);
    this.stepA = new Float32Array(7);
    this.stepB = new Float32Array(7);
    this.lines = [];
    for (let i = 0; i < 7; i++) {
      const a = DELAY[i], b = DELAY[i + 7];
      this.tA[i] = Math.trunc(f(sr * a));
      this.tB[i] = Math.trunc(f(sr * b));
      this.posA[i] = this.tA[i];
      this.posB[i] = this.tB[i];
      const len = blockSize + Math.trunc(f(f(f(sr * Math.max(a, b)) * f(2.0803)) + 0.5));
      const size = (len & ~7) + 8;
      this.lines.push({ buf: new Float32Array(size * 2), len: size, w: 0 });
    }
    this.aL = new Float32Array(7);
    this.aR = new Float32Array(7);
    this.bL = new Float32Array(7);
    this.bR = new Float32Array(7);
    this.notifySelected();
  }

  // ---- parameters (BeatEffect::adjustParameter / adjustSecondParameter / changeEffectStatus)

  setLevel(x) {
    this.level = x < 0 ? 0 : x > 1 ? 1 : f(x);
    this.changeLevelDepth();
  }

  setPercent(p) {
    p = Math.trunc(p);
    this.percent = p < 1 ? 1 : p > 100 ? 100 : p;
    this.pctChanged = true;
  }

  setXpad(v) {
    if (v >= 0 && v <= 255) this.xpadTarget = Math.trunc(v);
  }

  /** BeatEffectReverb::initialize: taps back to size 1, empty lines, then notifySelected. */
  initialize() {
    const sr = this.sr;
    for (let i = 0; i < 7; i++) {
      this.tA[i] = Math.trunc(f(sr * DELAY[i]));
      this.tB[i] = Math.trunc(f(sr * DELAY[i + 7]));
      this.posA[i] = this.tA[i];
      this.posB[i] = this.tB[i];
      this.stepA[i] = this.stepB[i] = 0;
      this.lines[i].buf.fill(0);
      this.lines[i].w = 0;
    }
    this.notifySelected();
    this.pctCur = this.pctNext = this.percent;
  }

  keepEffectInit() {
    this.keepInit = true;
  }

  toggle() {
    if (!this.on) {
      this.statusOn();
      this.on = true;
    } else {
      this.statusOff();
      this.on = false;
    }
  }

  // ---- the effect's own methods

  notifySelected() {
    this.fadeStep = 0;
    this.fadeTarget = 1;
    this.fade = 1;
    this.dry.jump(1);
    this.wet.jump(0);
    this.inVol.jump(0);
    this.changeLevelDepth();
    this.reset = true;
  }

  changeLevelDepth() {
    const x = this.level;
    let dry, wet;
    if (x < 0.009765625) {
      dry = 1;
      wet = 0;
    } else if (x >= 0.75) {
      wet = 1;
      dry = x >= 0.990234375 ? 0 : f(f(0.990234375 - x) * f(4.1626015));
    } else {
      dry = 1;
      wet = f(f(x - 0.009765625) * f(1.3509235));
    }
    this.dry.retarget(dry);
    this.wet.retarget(f(wet * f(0.70709997)));
  }

  inputVolume(p) {
    const x = f(p * f(0.01));
    const a = f(1 - f(x * f(1.81818)));
    let boost = 0;
    if (x > f(0.9)) {
      const t = f(f(x - f(0.9)) * 10);
      boost = f(f(f(f(t * t) * t) * t) * f(0.016528927));
    }
    const v = f(f(f(0.2) + f(f(a * a) * f(-0.2))) + boost);
    return v < 0 ? 0 : v;
  }

  statusOn() {
    this.fade = 0;
    this.fadeStep = FADE_STEP;
    this.fadeTarget = 1;
    if (!this.keepInit) {
      this.pctNext = this.pctCur = this.percent;
      this.pctChanged = true;
      this.changeLevelDepth();
    }
    this.inVol.jump(this.inputVolume(this.pctNext));
  }

  statusOff() {
    this.fadeStep = f(f(0 - this.fade) * FADE_STEP);
    this.fadeTarget = 0;
    this.inVol.retarget(0);
  }

  setGains(p) {
    for (let i = 0; i < 5; i++) {
      this.gL[i] = FEEDBACK[i * 100 + p - 1];
      this.gR[i] = FEEDBACK[(i + 5) * 100 + p - 1];
    }
    this.ap = ALLPASS;
  }

  /** Move the percent one step toward its target: new tap targets, glide rates, input volume. */
  calcFromPercent() {
    const cur = this.pctCur;
    let d = this.percent - cur, next;
    if (d >= 1) next = this.pctNext = cur + 1;
    else if (d === 0) next = this.pctNext;
    else {
      next = this.pctNext = cur - 1;
      d = -d;
    }
    if (d > 30) d = 30;
    const x = f(next * f(0.01));
    const b = f(f(1.01) + f(x * f(2.306)));
    const size = f(f(0.2) + f(f(b * b) * f(0.171)));
    this.inVol.retarget(this.inputVolume(next));
    const len = f(this.sr * size);
    for (let i = 0; i < 7; i++) {
      this.tA[i] = Math.trunc(f(len * DELAY[i]));
      this.tB[i] = Math.trunc(f(len * DELAY[i + 7]));
    }
    let p;
    if (d === 0) {
      for (let i = 0; i < 7; i++) {
        this.posA[i] = this.tA[i];
        this.posB[i] = this.tB[i];
        this.stepA[i] = this.stepB[i] = 0;
      }
      p = this.pctCur = this.pctNext = this.percent;
    } else {
      const rate = CHASE[d];
      for (let i = 0; i < 7; i++) {
        this.stepA[i] = f(f(this.tA[i] - this.posA[i]) * rate);
        this.stepB[i] = f(f(this.tB[i] - this.posB[i]) * rate);
      }
      p = cur;
    }
    this.setGains(p);
    this.pctChanged = false;
  }

  /** The X-PAD position picks the post LPF/HPF and their make-up gains. */
  changeFilterCutoff() {
    const v = this.xpadCur >> 1;
    const lpf = v > 62 ? 63 : v, hpf = v - 64 > 0 ? v - 64 : 0;
    this.postLpf.set(POST_LPF, lpf);
    this.postHpf.set(POST_HPF, hpf);
    this.lpfGain = f(f(f(1 - f(lpf * f(0.015873015))) * 0.5) + 1);
    let k = f(0.085);
    if (this.pctCur > 84) {
      const q = this.pctCur - 85, s = f(0.06666667);
      k = f(k + f(f(f(f(q * s) * q) * s) * f(0.3764706)));
    }
    const h = f(hpf * f(0.015625));
    const g = f(f(f(f(h * h) * h) * k) + f(h * f(1.4635295)));
    this.hpfGain = f(f(f(g * g) * g) + 1);
  }

  clear() {
    for (const line of this.lines) {
      line.buf.fill(0);
      line.w = 0;
    }
    for (const fl of [this.preLpf, this.preHpf, ...this.damp, this.postLpf, this.postHpf]) fl.clear();
  }

  /**
   * One block. `bypass`, if given, receives the per-sample gain of the dry signal the Beat FX manager mixes in
   * around the effect while it is off (so off = dry + the tail, without the effect's own dry/wet balance).
   */
  execute(inL, inR, outL, outR, n, bypass) {
    if (this.reset) {
      this.xpadCur = this.xpadTarget = 128;
      this.reset = false;
      outL.set(inL.subarray(0, n));
      outR.set(inR.subarray(0, n));
      bypass?.fill(0, 0, n);
      this.clear();
      this.pctNext = this.pctCur = this.percent;
      this.calcFromPercent();
      return;
    }
    if (this.on) {
      if (this.xpadTarget < this.xpadCur) {
        this.xpadCur--;
        this.changeFilterCutoff();
      }
      if (this.xpadCur < this.xpadTarget) {
        this.xpadCur++;
        this.changeFilterCutoff();
      }
    }
    const { lines, posA, posB, stepA, stepB, tA, tB, aL, aR, bL, bR, gL, gR, damp, ap } = this;
    for (let n0 = 0; n0 < n; n0++) {
      if (this.fadeStep !== 0) {
        const nv = f(this.fadeStep + this.fade);
        this.fade = nv;
        if (f(this.fadeStep * f(this.fadeTarget - nv)) <= 0) {
          this.fade = this.fadeTarget;
          this.fadeStep = 0;
        }
      }
      const fv = this.fade;
      const iv = this.inVol.tick();
      this.preLpf.run(f(f(inL[n0] * iv) * fv), f(f(inR[n0] * iv) * fv));
      this.preHpf.run(this.preLpf.yL, this.preLpf.yR);
      const xL = this.preHpf.yL, xR = this.preHpf.yR;

      for (let i = 0; i < 7; i++) {
        let s = stepA[i];
        if (s !== 0) {
          const np = f(s + posA[i]);
          posA[i] = np;
          if (f(s * f(tA[i] - np)) <= 0) {
            posA[i] = tA[i];
            stepA[i] = 0;
          }
        }
        s = stepB[i];
        if (s !== 0) {
          const np = f(s + posB[i]);
          posB[i] = np;
          if (f(s * f(tB[i] - np)) <= 0) {
            posB[i] = tB[i];
            stepB[i] = 0;
          }
        }
        const pa = posA[i], pb = posB[i], ia = Math.trunc(pa), ib = Math.trunc(pb);
        const fa = f(pa - ia), fb = f(pb - ib);
        const { buf, len, w } = lines[i];
        let j0 = w - ia, j1 = w - ia - 1, k0 = w - ib, k1 = w - ib - 1;
        if (j0 < 0) j0 += len;
        if (j1 < 0) j1 += len;
        if (k0 < 0) k0 += len;
        if (k1 < 0) k1 += len;
        const a0 = buf[j0 * 2], a1 = buf[j1 * 2], b0 = buf[k0 * 2 + 1], b1 = buf[k1 * 2 + 1];
        aL[i] = f(a0 + f(fa * f(a1 - a0)));
        aR[i] = f(b0 + f(fb * f(b1 - b0)));
      }

      let sL = xL, sR = xR;
      for (let i = 0; i < 5; i++) {
        const cl = f(gL[i] * aL[i]), cr = f(gR[i] * aR[i]);
        damp[i].run(cl, cr);
        bL[i] = f(xL + damp[i].yR);
        bR[i] = f(xR + damp[i].yL);
        sL = f(sL + cl);
        sR = f(sR + cr);
      }
      const y5L = f(aL[5] - f(ap * sL)), y5R = f(aR[5] - f(ap * sR));
      bL[5] = f(sL + f(ap * y5L));
      bR[5] = f(sR + f(ap * y5R));
      const y6L = f(aL[6] - f(ap * y5L)), y6R = f(aR[6] - f(ap * y5R));
      bL[6] = f(y5L + f(ap * y6L));
      bR[6] = f(y5R + f(ap * y6R));
      for (let i = 0; i < 7; i++) {
        const line = lines[i];
        line.buf[line.w * 2] = bL[i];
        line.buf[line.w * 2 + 1] = bR[i];
        if (++line.w >= line.len) line.w -= line.len;
      }
      this.postLpf.run(y6L, y6R);
      this.postHpf.run(this.postLpf.yL, this.postLpf.yR);

      const wv = this.wet.tick(), dv = this.dry.tick();
      const wg = f(wv * f(this.lpfGain * this.hpfGain));
      const oL = f(this.postHpf.yL * wg), oR = f(this.postHpf.yR * wg);
      if (!this.on || this.keepInit) {
        outL[n0] = f(f(f(inL[n0] * dv) * fv) + oL);
        outR[n0] = f(f(f(inR[n0] * dv) * fv) + oR);
        if (bypass) bypass[n0] = 1 - dv * fv;
        if (this.keepInit && !(this.fade < 1)) this.keepInit = false;
      } else {
        outL[n0] = f(f(inL[n0] * dv) + oL);
        outR[n0] = f(f(inR[n0] * dv) + oR);
        if (bypass) bypass[n0] = 0;
      }
    }

    if (stepA[0] !== 0) return;
    const p = this.pctNext;
    this.setGains(p);
    this.pctCur = p;
    if (this.percent === p && !this.pctChanged) return;
    this.calcFromPercent();
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = ReverbCore;
