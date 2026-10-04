/**
 * Sound Color FX SWEEP, ported from the XDJ-RX3 v1.19 player (mixerengine::SoundColorFxSweep).
 *
 * Left of centre a two-band gate, right of centre a sweeping band-pass, crossfaded in from the dry signal on a
 * smoothstep (1/256 a sample) as COLOR leaves the middle:
 *   - level detector (it runs every block, whatever is selected): the input is split into a low and a high band;
 *     each keeps its recent peak (a 60-slot history of 33 ms windows) as a reference level;
 *   - gate: each band's follower opens its gain while it is over the reference x a threshold set by COLOR and
 *     PARAMETER, and closes it otherwise; the low band is filtered again and the two are summed;
 *   - sweep: two low-passes and two high-passes around a centre that PARAMETER moves over three octaves from
 *     200 Hz or 2 kHz, narrowing as COLOR turns up (one filter pair is updated per block).
 */
import { Biquad, ColorCore, f, hex } from '../dsp.js';
import { GATE_HPF, GATE_LPF, SWEEP_HPF_MIN, SWEEP_LPF_MAX } from './sweep-tables.js';

export const meta = { name: 'SWEEP', type: 3 };

const W1 = hex(0x39155ff9), W2 = hex(0x32ae5ec9), FIXED = hex(0x400f9e4d);
const dbl = (hi, lo) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];

function lowpass(c, r, k) {
  const s15 = f(f(c * f(r + r)) * W1), s17 = f(f(c * c) * W2);
  let n = f(1 / f(f(s15 + s17) + 4));
  let b0 = f(s17 * n);
  k[0].set([b0, f(b0 + b0), b0, f(n * f(f(s17 - 4) + f(s17 - 4))), f(n * f(f(s17 - s15) + 4))]);
  const s = f(f(c * FIXED) * W1);
  n = f(1 / f(f(s17 + s) + 4));
  b0 = f(s17 * n);
  k[1].set([b0, f(b0 + b0), b0, f(f(f(s17 - 4) + f(s17 - 4)) * n), f(n * f(f(s17 - s) + 4))]);
}

function highpass(c, r, k) {
  const s14 = f(f(c * f(r + r)) * W1), s16 = f(f(c * c) * W2);
  let n = f(1 / f(f(s14 + s16) + 4));
  let b0 = f(n * 4);
  const a1 = f(f(s16 - 4) + f(s16 - 4));
  k[0].set([b0, f(b0 * -2), b0, f(n * a1), f(n * f(f(s16 - s14) + 4))]);
  const s = f(f(c * FIXED) * W1);
  n = f(1 / f(f(s16 + s) + 4));
  b0 = f(n * 4);
  k[1].set([b0, f(b0 * -2), b0, f(a1 * n), f(n * f(f(s16 - s) + 4))]);
}

export class SweepCore extends ColorCore {
  constructor(sampleRate) {
    super(0);
    this.sr = sampleRate;
    // level detector: low band (lpfA -> lpfB), high band (hpfA -> hpfB); post filter for the gated low band
    this.det = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.det[0].set(GATE_LPF);
    this.det[1].set(GATE_LPF);
    this.det[2].set(GATE_HPF);
    this.det[3].set(GATE_HPF);
    this.post = new Biquad();
    this.post.set(GATE_LPF);
    this.bp = [new Biquad(), new Biquad(), new Biquad(), new Biquad()]; // lpf, lpf, hpf, hpf
    this.coef = [new Float32Array(5), new Float32Array(5)];
    this.dry = 1; // +0x6c
    this.inv = f(1 / 64); // +0x70
    // per band (low, high)
    this.env = [0, 0]; // +0x74
    this.gain = [0, 0]; // +0x7c
    this.level = [0, 0]; // +0x84: the reference level
    this.lc = [0, 0]; // +0x8c: the threshold's base, chasing level
    this.lstep = [0, 0]; // +0x94
    this.chase = 0; // +0x9c (shared by both bands)
    this.th = [0, 0]; // +0xa0
    this.att = [0, 0]; // +0xa8
    this.rel = [0, 0]; // +0xb0
    this.open = [0, 0]; // +0xb8
    this.close = [0, 0]; // +0xc0
    this.recent = [0, 0]; // +0xc8
    this.peak = [0, 0]; // +0xd0
    this.longer = [0, 0]; // +0xd8
    this.lpfFc = 0; // +0xe0
    this.hpfFc = 0; // +0xe4
    this.fade = 0; // +0xe8: the sweep's fade-in
    this.count = [0, 0]; // +0xec
    this.hold = [0, 0]; // +0xf4
    this.hist = [new Float32Array(60), new Float32Array(60)];
    this.cur = this.target = 127;
    this.changed = false; // +0x104
    this.active = false; // +0x105
    this.pending = 0; // +0x108: 1 = the low-passes moved, the high-passes are due; 2 = the reverse
    this.n = 0;
    this.initialize(); // SoundColorFxManager::init
  }

  changeColor() {
    this.target = Math.trunc(f(this.color * 1023)) >> 2;
  }

  changeParameter() {
    this.changed = true;
  }

  buffers(n) {
    if (n === this.n) return;
    this.n = n;
    this.inv = f(1 / n);
    const z = () => [new Float32Array(n), new Float32Array(n)];
    this.band = [z(), z()]; // +0x48/+0x4c
    this.pre = [z(), z()]; // +0x50/+0x54
    this.mem = [new Float32Array(n), new Float32Array(n)]; // +0x5c/+0x60
    this.out = z(); // +0x58
    this.tmp = z();
  }

  initialize(n = 64) {
    this.buffers(n);
    this.post.clear();
    this.bp[0].set(SWEEP_LPF_MAX);
    this.bp[1].set(SWEEP_LPF_MAX);
    this.bp[2].set(SWEEP_HPF_MIN);
    this.bp[3].set(SWEEP_HPF_MIN);
    this.lpfFc = 20000;
    this.hpfFc = 20;
    for (const b of this.bp) b.clear();
    this.fade = 0;
    this.cur = this.target = Math.trunc(f(this.color * 1023)) >> 2;
    this.dry = 1;
    const x = f(this.cur);
    if (x <= 127) this.updateGate(x);
    else this.updateSweep(x);
    this.changed = false;
    if (this.active && this.cur > 126) this.dry = 0;
  }

  /** peakLevelDetect: the bands, their per-sample levels, and every 1472 samples the reference levels. */
  detect(inL, inR, n) {
    this.buffers(n);
    const [lp, hp] = this.pre;
    this.det[0].process(inL, inR, lp[0], lp[1], n);
    this.det[1].process(lp[0], lp[1], this.band[0][0], this.band[0][1], n);
    this.det[2].process(inL, inR, hp[0], hp[1], n);
    this.det[3].process(hp[0], hp[1], this.band[1][0], this.band[1][1], n);
    for (let b = 0; b < 2; b++) {
      const [L, R] = this.band[b], m = this.mem[b];
      for (let i = 0; i < n; i++) {
        const a = Math.abs(L[i]), c = Math.abs(R[i]);
        m[i] = a < c ? c : a;
      }
    }
    let max = 0, min = 0; // carried from the low band into the high band, as the firmware does
    for (let b = 0; b < 2; b++) {
      const [L, R] = this.band[b];
      for (let i = 0; i < n; i++) {
        for (const v of [L[i], R[i]]) {
          if (v > max) max = v;
          else if (v < min) min = v;
        }
      }
      if (f(max + min) < 0) max = -min;
      if (this.peak[b] < max) this.peak[b] = max;
      this.count[b] += n;
      if (this.count[b] > 1471) {
        this.count[b] = 0;
        let B = 0, A = 0;
        const h = this.hist[b];
        for (let k = 59; k >= 24; k--) {
          h[k] = h[k - 1];
          if (B < h[k - 1]) B = h[k - 1];
        }
        for (let k = 23; k >= 1; k--) {
          h[k] = h[k - 1];
          if (A < h[k - 1]) A = h[k - 1];
        }
        h[0] = this.peak[b];
        if (this.peak[b] > A) A = this.peak[b];
        if (B < A) B = A;
        if (this.level[b] < A) {
          this.level[b] = A;
          this.hold[b] = 0;
          A = 0;
        } else if (!(f(this.level[b] * 0.75) > A)) this.hold[b] = 0;
        else if (this.hold[b] > 59) {
          this.level[b] = B;
          this.hold[b] = 0;
          A = 0;
        } else this.hold[b]++;
        this.recent[b] = A;
        this.longer[b] = B;
        this.peak[b] = 0;
      }
    }
  }

  updateGate(x) {
    const p = this.param;
    const q = f(hex(0x3e8f5c29) + f(p * hex(0x3fb851ec)));
    const s13 = p < 0.5 ? q : f(1 + f(f(p - 0.5) * 3));
    if (x > 107) {
      this.active = false;
      this.th = [hex(0x3e75c28f), hex(0x3ea8f5c3)];
      this.att = [1, 1];
      this.rel = [hex(0x3f7ff427), hex(0x3f7ff427)];
      this.open = [hex(0x3aae427b), 1];
      this.close = [hex(0x3f7ffa13), hex(0x3f7ffa13)];
      return;
    }
    const t = f(x * hex(0x3c191f1a));
    this.rel = [hex(0x3f7ff427), hex(0x3f7ff427)];
    this.open[0] = hex(0x3aae427b);
    this.active = true;
    this.att = [1, 1];
    this.open[1] = 1;
    const a = f(1 - f(t * t)), b = f(f(1 - t) * f(1 - t));
    const th1 = dbl(0x3fd51eb8, 0x60000000) + a * dbl(0x3fcdc28f, 0x5c28f5c3) * q;
    this.th[0] = f(hex(0x3e75c28f) + f(f(a * hex(0x3eb851ec)) * q));
    this.close[0] = f(hex(0x3f7ffa13) - f(f(b * hex(0x3ac18174)) * s13));
    this.close[1] = f(hex(0x3f7ffa13) - f(f(b * hex(0x39bb3836)) * s13));
    this.th[1] = f(th1);
  }

  updateSweep(x) {
    const p = this.param;
    if (x <= 130) {
      this.active = false;
      if (this.lpfFc !== 20000) {
        this.bp[0].set(SWEEP_LPF_MAX);
        this.bp[1].set(SWEEP_LPF_MAX);
        this.lpfFc = 20000;
      }
      if (this.hpfFc !== 20) {
        this.bp[2].set(SWEEP_HPF_MIN);
        this.bp[3].set(SWEEP_HPF_MIN);
        this.hpfFc = 20;
      }
      this.pending = 0;
      return;
    }
    const s8 = f(x - 130);
    const u = f(1 - f(s8 * hex(0x3c031203)));
    let e, base;
    if (p < 0.5) {
      e = f(p * hex(0x40549a78));
      e = f(e + e);
      base = 200;
    } else {
      e = f(f(p - 0.5) * 4);
      base = 2000;
    }
    const k = Math.trunc(e), fr = f(e - k), fr2 = f(fr * fr);
    let scale = base;
    if (k > 0) scale = f(base * (1 << k));
    const Q = f(hex(0x3fb33333) + f(f(u * 16) * u));
    const iq = f(1 / Q);
    const m = f(f(1 + f(fr * hex(0x3f282799))) + f(fr2 * hex(0x3eafb0ce)));
    const fc = f(m * scale);
    let lpc = f(fc * Q), hpc = f(fc * iq), r = hex(0x3f353bef);
    if (x < 162) {
      const w = f(s8 * 0.03125), v = f(1 - w);
      lpc = f(f(v * 20000) + f(w * lpc));
      hpc = f(f(v * 20) + f(w * hpc));
      r = f(r + f(f(f(162 - x) * hex(0x3e99999a)) * 0.03125));
    }
    const setL = () => {
      lowpass(lpc, r, this.coef);
      this.bp[0].set(this.coef[0]);
      this.bp[1].set(this.coef[1]);
      this.lpfFc = lpc;
    };
    const setH = () => {
      highpass(hpc, r, this.coef);
      this.bp[2].set(this.coef[0]);
      this.bp[3].set(this.coef[1]);
      this.hpfFc = hpc;
    };
    if (this.pending === 1) {
      if (this.hpfFc !== hpc) {
        setH();
        this.pending = this.lpfFc !== lpc ? 2 : 0;
      } else if (this.lpfFc !== lpc) {
        setL();
        this.pending = 0;
      } else this.pending = 0;
    } else if (this.lpfFc !== lpc) {
      setL();
      this.pending = 1;
    } else if (this.hpfFc !== hpc) {
      setH();
      this.pending = 0;
    } else this.pending = 0;
    this.active = true;
  }

  update(x) {
    if (x <= 127) this.updateGate(x);
    else this.updateSweep(x);
    this.changed = false;
  }

  gate(n) {
    for (let b = 0; b < 2; b++) {
      const lv = this.level[b];
      const d = f(lv - this.lc[b]);
      if (!(d >= hex(0x37800000)) && d > hex(0xb7800000)) {
        this.chase = 0;
        this.lstep[b] = 0;
        this.lc[b] = lv;
      } else if (this.chase !== 0) this.chase += n;
      else {
        let st;
        if (!(d >= 0.015625) && d > -0.015625) {
          st = f(d * this.inv);
          this.lc[b] = f(lv - f(st * f(n)));
        } else {
          st = f(d * 0.0078125);
          this.lc[b] = f(lv - f(st * 128));
        }
        this.lstep[b] = st;
        this.chase = n;
      }
      let env = this.env[b], g = this.gain[b];
      const m = this.mem[b], [L, R] = this.band[b];
      const th = this.th[b], att = this.att[b], rel = this.rel[b], op = this.open[b], cl = this.close[b];
      for (let i = 0; i < n; i++) {
        const c = this.lc[b] = f(this.lc[b] + this.lstep[b]);
        const t = f(c * th), v = m[i];
        if (env < v) env = f(env + f(f(v - env) * att));
        else env = f(env * rel);
        if (env > t) g = f(f(op + g) - f(g * op));
        else g = f(g * cl);
        L[i] = f(g * L[i]);
        R[i] = f(g * R[i]);
      }
      if (env < hex(0x34000000)) env = 0;
      if (g < hex(0x34000000)) g = 0;
      this.env[b] = env;
      this.gain[b] = g;
    }
  }

  sweep(inL, inR, n) {
    const [oL, oR] = this.out, [tL, tR] = this.tmp;
    for (let i = 0; i < n; i++) {
      let v = f(this.fade + 0.0078125);
      this.fade = v;
      let s;
      if (v <= 1) s = f(f(v * v) * f(3 - f(v + v)));
      else {
        this.fade = 1;
        s = 1;
      }
      oL[i] = f(s * inL[i]);
      oR[i] = f(s * inR[i]);
    }
    this.bp[0].process(oL, oR, tL, tR, n);
    this.bp[1].process(tL, tR, oL, oR, n);
    this.bp[2].process(oL, oR, tL, tR, n);
    this.bp[3].process(tL, tR, oL, oR, n);
  }

  execute(inL, inR, outL, outR, n) {
    const x0 = f(this.cur);
    if (this.cur === this.target) {
      if (this.changed) this.update(x0);
      else if (this.pending !== 0) this.updateSweep(x0);
    } else {
      this.cur += this.cur < this.target ? 1 : -1;
      this.update(f(this.cur));
    }
    const gating = !(x0 >= 127);
    if (gating) this.gate(n);
    else this.sweep(inL, inR, n);
    const [lo, hi] = this.band, [oL, oR] = this.out;
    const y = [new Float32Array(1), new Float32Array(1)], xi = [new Float32Array(1), new Float32Array(1)];
    for (let i = 0; i < n; i++) {
      let eL, eR;
      if (gating) {
        xi[0][0] = lo[0][i];
        xi[1][0] = lo[1][i];
        this.post.process(xi[0], xi[1], y[0], y[1], 1);
        eL = f(y[0][0] + hi[0][i]);
        eR = f(y[1][0] + hi[1][i]);
      } else {
        eL = oL[i];
        eR = oR[i];
      }
      let v;
      if (!this.active) {
        v = this.dry = f(this.dry + 0.00390625);
        if (v > 1) {
          this.dry = v = 1;
          if (gating) this.fade = 0;
        }
      } else {
        v = this.dry = f(this.dry - 0.00390625);
        if (v < 0) {
          this.dry = v = 0;
          if (gating) this.fade = 0;
        }
      }
      const s = f(f(3 - f(v + v)) * f(v * v)), r = f(1 - s);
      outL[i] = f(f(inL[i] * s) + f(eL * r));
      outR[i] = f(f(inR[i] * s) + f(eR * r));
    }
  }
}

export const Core = SweepCore;
