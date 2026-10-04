/**
 * Beat FX FILTER, ported from the XDJ-RX3 v1.19 player (mixerengine::BeatEffectFilter).
 *
 * A resonant band-pass swept by a triangle LFO (period = the beat time): three first-order low-passes, then three
 * first-order high-passes, the high-pass output fed back to the input.
 *   x = in + y' x fb;  l = lpf3(x);  y = hpf3(l);  out = in x dry + (l + y x fb x 0.8) x wet
 * The sweep (0..1) picks the cutoff through TAB_WAVE_CIRCULAR1; the feedback gain rises toward the bottom of the
 * sweep. LEVEL/DEPTH crossfades into the filter up to 0.16, then raises the resonance (0 .. 0.96). The X-PAD
 * (0-255) adds a second LFO (10 .. 100 ms, +-0.22 of the sweep); 255 is off. ON and BEAT presses restart the sweep
 * from the bottom, fading the wet signal.
 */
import { BeatCore, Ramp, beatButtons, f, hex, msLen } from '../dsp.js';
import { LfoTriangle } from './flanger.js';
import { WAVE } from './filter-table.js';

export const meta = {
  name: 'FILTER',
  unit: 'beat',
  beats: beatButtons(0, 11), // 1/16 .. 64
  defaultBeat: 7, // 4 beats
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 255, left: 'FAST', right: 'OFF' },
};

const SWEEP_MIN = hex(0x3c14ddde); // the lowest sweep the table is read at
const STEPS = 129;
const P0 = hex(0x3f8013f6), P1 = hex(0xbb556774), P2 = hex(0x3a7c2331), P3 = hex(0xba1c9e8c), P4 = hex(0x37d1bfda);
const Q0 = hex(0x3d08d87b), Q1 = hex(0x3f777278);
const FB0 = f(0.9), FB1 = f(0.1), FB_MIX = f(0.8);

/** dsp::firstOrder_IIRFilter on a stereo pair: y = b0 x + b1 x1 - a1 y1. */
class Iir1 {
  constructor() {
    this.b0 = this.b1 = this.a1 = 0;
    this.clear();
  }

  clear() {
    this.xL = this.xR = this.yL = this.yR = 0;
  }

  set(b0, b1, a1) {
    this.b0 = b0;
    this.b1 = b1;
    this.a1 = a1;
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

export class FilterCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 2000, minMs: 10, maxMs: 32000, button: 7, minButton: 0, maxButton: 11, position: 1 });
    const sr = f(sampleRate);
    const mix = msLen(sr, 3.3333333);
    this.dry = new Ramp(mix, 1);
    this.wet = new Ramp(mix);
    this.start = new Ramp(msLen(sr, 4.3514738));
    this.lfo2Gain = new Ramp(mix);
    this.lfo2 = new LfoTriangle(sampleRate, 33, 0.22, -0.22);
    this.lpf = [new Iir1(), new Iir1(), new Iir1()];
    this.hpf = [new Iir1(), new Iir1(), new Iir1()];
    this.reso = 0;
    this.yL = this.yR = 0; // the fed-back high-pass output
    this.pos = 0;
    this.max = 1;
    this.min = 0;
    this.rate = 0;
    this.up = true;
    this.xpadCur = this.xpadTarget = 255;
    this.init = true;
    this.restart = false;
    this.initialize();
  }

  initialize() {
    this.dry.step = 0;
    this.dry.cur = this.dry.target = 1;
    this.wet.step = this.wet.target = this.wet.cur = 0;
    this.lfo2Gain.step = this.lfo2Gain.target = this.lfo2Gain.cur = 0;
    this.init = true;
    this.changeTime();
  }

  changeLevelDepth() {
    const x = this.level;
    // the dry/wet crossfade up to 0.156: a polynomial S-curve in u = 1 - 12.8 x
    const u = f(1 - f(x * hex(0x414ccccd))), u2 = f(u * u);
    let p = f(f(u * hex(0xbf24619a)) * u2);
    p = f(p + f(u * hex(0x3fc90042)));
    p = f(p + f(f(f(u * hex(0x3d932c2b)) * u2) * u2));
    const v = f(0.5 + f(p * 0.5));
    let dry = 0, wet = 1;
    if (v > 0 && x <= 0.15625) {
      if (v <= 1) {
        wet = f(1 - v);
        dry = v;
      } else {
        wet = 0;
        dry = 1;
      }
    }
    let s;
    if (x <= 0.15625) s = 1;
    else if (x > hex(0x3ecc0000)) s = f(1 - x);
    else s = f(1 - f(f(x - 0.15625) * hex(0x3fd3680d)));
    this.reso = f(f(1 - f(s * s)) * hex(0x3f75c28f));
    this.dry.retarget(dry);
    this.wet.retarget(wet);
  }

  changeTime() {
    const n = (Math.floor(this.ms * 2 * 44.1) + 1) >>> 1;
    this.rate = f(this.max / f(n * 0.5));
    if (this.pressed) {
      this.restart = true;
      this.start.retarget(0);
    }
  }

  statusOn() {
    this.start.start(0, 1);
    this.init = true;
  }

  statusOff() {
    this.start.retarget(0);
  }

  setXpad(v) {
    if (v >= 0 && v <= 255) this.xpadTarget = Math.trunc(v);
  }

  setSecondLfo() {
    const x = this.xpadCur;
    const t = x <= 192 ? f(10 + f(x * hex(0x3e555555))) : f(50 + f((x - 192) * hex(0x3f555555)));
    let g;
    if (t <= 100) {
      this.lfo2.setTime(t);
      g = 1;
      if (t > 1) {
        g = f(1 - f(f(t - 1) * hex(0x3c257eb4)));
        if (g < 0) g = 0;
      }
    } else {
      this.lfo2.setTime(100);
      g = hex(0x34000000);
    }
    this.lfo2Gain.retarget(g);
  }

  execute(inL, inR, outL, outR, n) {
    const { lpf, hpf } = this;
    if (this.init) {
      this.start.retarget(1);
      this.restart = false;
      this.init = false;
      this.xpadCur = this.xpadTarget = 255;
      this.pos = 0;
      this.up = true;
      this.setSecondLfo();
      for (const q of lpf) q.clear();
      for (const q of hpf) q.clear();
    }
    if (this.restart && this.start.done) {
      this.start.retarget(1);
      this.restart = false;
      this.pos = 0;
      this.up = true;
      this.lfo2.reset();
    }
    if (this.xpadCur > this.xpadTarget) {
      this.xpadCur--;
      this.setSecondLfo();
    }
    if (this.xpadCur < this.xpadTarget) {
      this.xpadCur++;
      this.setSecondLfo();
    }
    const { dry, wet, start, lfo2, lfo2Gain, max, min } = this;
    let yL = this.yL, yR = this.yR;
    for (let i = 0; i < n; i++) {
      if (this.up) {
        this.pos = f(this.pos + this.rate);
        if (this.pos > max) {
          this.up = false;
          this.pos = f(f(max + max) - this.pos);
        }
      } else {
        this.pos = f(this.pos - this.rate);
        if (this.pos < min) {
          this.up = true;
          this.pos = f(f(min + min) - this.pos);
        }
      }
      const v2 = lfo2.tick();
      let c = f(this.pos + f(v2 * lfo2Gain.cur));
      if (!(max >= c)) c = max;
      if (!(min <= c)) c = min;
      if (c < SWEEP_MIN) c = SWEEP_MIN;
      const t = f(c * STEPS), k = Math.trunc(t);
      const q = f(WAVE[k] + f(f(WAVE[k + 1] - WAVE[k]) * f(t - k)));
      const r = f(1 + f(q * 10)), r2 = f(r * r);
      let P = f(P0 + f(f(r * r2) * P3));
      P = f(P + f(r2 * P2));
      P = f(P + f(f(r2 * r2) * P4));
      const c4 = f(f(c * c) * f(c * c));
      P = f(P + f(r * P1));
      const Q = f(Q0 + f(q * Q1));
      const g = f(f(FB0 + f(f(1 - f(c4 * c4)) * FB1)) * this.reso);
      const qa = f(f(Q + Q) - 1), pa = f(1 - f(P + P));
      for (const s of lpf) s.set(Q, Q, qa);
      for (const s of hpf) s.set(P, -P, pa);
      lpf[0].run(f(f(yL * g) + inL[i]), f(f(yR * g) + inR[i]));
      lpf[1].run(lpf[0].yL, lpf[0].yR);
      lpf[2].run(lpf[1].yL, lpf[1].yR);
      hpf[0].run(lpf[2].yL, lpf[2].yR);
      hpf[1].run(hpf[0].yL, hpf[0].yR);
      hpf[2].run(hpf[1].yL, hpf[1].yR);
      yL = hpf[2].yL;
      yR = hpf[2].yR;
      const pL = f(lpf[2].yL + f(f(yL * g) * FB_MIX)), pR = f(lpf[2].yR + f(f(yR * g) * FB_MIX));
      const dv = dry.cur, wv = wet.cur, s = start.cur;
      outL[i] = f(f(inL[i] * dv) + f(f(pL * wv) * s));
      outR[i] = f(f(inR[i] * dv) + f(f(pR * wv) * s));
      dry.tick();
      wet.tick();
      start.tick();
      lfo2Gain.tick();
    }
    this.yL = yL;
    this.yR = yR;
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = FilterCore;
