/**
 * Sound Color FX FILTER, ported from the XDJ-RX3 v1.19 player (mixerengine::SoundColorFxFilter).
 *
 * A low-pass and a high-pass biquad, both always running. COLOR (256 steps, followed two steps a block) picks
 * the cutoffs on cubic curves: left of centre the low-pass closes (21 kHz -> 100 Hz), right of it the high-pass
 * opens (20 Hz -> 8.2 kHz), and the output slides between the two (1/441 a sample) as the knob crosses the
 * middle. Around the centre (steps 110..146) the filtered sound fades into the dry signal, which it is entirely
 * at 126..130. PARAMETER is the resonance (low to high); a very low high-pass gets extra Q.
 *   out = in x k + g x (m x lpf + (1 - m) x hpf) x (1 - k)
 */
import { Biquad, ColorCore, f, hex } from '../dsp.js';

export const meta = { name: 'FILTER', type: 1 };

const INV126 = hex(0x3c020821), STEP = f(0.0625), FADE = hex(0x3b149b93), SLEW = f(0.015625);
const W1 = hex(0x39155ff9), W2 = hex(0x32ae5ec9); // 2 pi / fs and its square, for the bilinear transform

/** Bilinear low-pass at fc with damping r: [b0, b1, b2, a1, a2]. */
function lowpass(fc, r, c) {
  const s11 = f(f(fc * r) * W1), s15 = f(f(fc * fc) * W2);
  const norm = f(1 / f(f(s11 + s15) + 4));
  const b0 = f(s15 * norm);
  c[0] = b0;
  c[1] = f(b0 + b0);
  c[2] = b0;
  c[3] = f(norm * f(f(s15 - 4) + f(s15 - 4)));
  c[4] = f(norm * f(f(s15 - s11) + 4));
}

function highpass(fc, r, c) {
  const s11 = f(f(fc * r) * W1), s13 = f(f(fc * fc) * W2);
  const norm = f(1 / f(f(s11 + s13) + 4));
  const b0 = f(norm * 4);
  c[0] = b0;
  c[1] = f(b0 * -2);
  c[2] = b0;
  c[3] = f(norm * f(f(s13 - 4) + f(s13 - 4)));
  c[4] = f(norm * f(f(s13 - s11) + 4));
}

export class FilterCore extends ColorCore {
  constructor(sampleRate) {
    super(1);
    this.sr = sampleRate;
    this.lpf = new Biquad();
    this.hpf = new Biquad();
    this.coef = new Float32Array(5);
    this.m = 1; // +0x34: low-pass (1) .. high-pass (0)
    this.kTarget = 1; // +0x38: dry share
    this.k = 1;
    this.kStep = 0;
    this.g = 0; // +0x30: the filtered signal's gain, slewing to gTarget
    this.gTarget = 0;
    this.lpfMode = true;
    this.changed = false;
    this.cur = this.target = 0;
    this.fcL = this.fcH = 0;
    this.lp = [new Float32Array(64), new Float32Array(64)];
    this.hp = [new Float32Array(64), new Float32Array(64)];
    this.initialize();
  }

  changeColor() {
    this.target = Math.trunc(f(this.color * 1023)) >> 2;
  }

  changeParameter() {
    this.changed = true;
  }

  initialize() {
    this.lpf.clear();
    this.hpf.clear();
    this.fcL = this.fcH = this.g = this.kStep = 0;
    this.cur = this.target = Math.trunc(f(this.color * 1023)) >> 2;
    this.calcParameter();
    this.kStep = 0;
    this.changed = true;
    this.k = this.kTarget;
    this.m = this.lpfMode ? 1 : 0;
  }

  calcParameter() {
    let cur = this.cur;
    const tgt = this.target;
    if (cur < tgt) cur = this.cur = tgt <= cur + 1 ? cur + 1 : cur + 2;
    else if (cur > tgt) cur = this.cur = tgt >= cur - 1 ? cur - 1 : cur - 2;
    const x = f(cur), p = this.param;
    let fcL, fcH, kT, qmin = 0;
    if (x < 126) {
      const t = f(x * INV126);
      fcL = f(100 + f(f(f(t * t) * t) * 21000));
      kT = x >= 110 ? f(f(x - 110) * STEP) : 0;
      fcH = 20;
    } else if (!(x > 130)) {
      fcH = 20;
      fcL = 21100;
      kT = 1;
    } else {
      const u = f(f(x - 130) * INV126);
      fcH = f(20 + f(f(f(u * u) * u) * 8200));
      if (fcH < 249) {
        const w = f(1 - f(f(fcH - 20) * hex(0x3b8e7835)));
        qmin = f(hex(0x3cf5c28f) + f(f(f(w * 4) * w) * w));
        if (qmin > 2) qmin = 2;
      }
      fcL = 21100;
      kT = x > 146 ? 0 : f(f(146 - x) * STEP);
    }
    // PARAMETER: the damping (low = resonant)
    let r;
    if (p < 0.5) {
      const a = f(1 - f(p + p));
      r = f(4 - f(3.5 * f(1 - f(a * a))));
    } else {
      const a = f(p - 0.5);
      r = f(0.5 - f(f(a + a) * 0.46875));
    }
    if (r < qmin) r = qmin;
    const comp = r < 0.5 ? f(r + r) : 1;
    r = f(r + r);
    let v;
    const c = this.coef;
    if (x > 127) {
      v = f(0.5 + f(f((x < 192 ? f(192 - x) : f(x - 192)) * 0.5) * SLEW));
      highpass(fcH, r, c);
      this.hpf.set(c);
      this.fcH = fcH;
      if (this.fcL !== fcL || this.changed) {
        lowpass(fcL, r, c);
        this.lpf.set(c);
        this.fcL = fcL;
      }
      this.lpfMode = false;
    } else {
      v = f(0.5 + f(f((x < 64 ? f(64 - x) : f(x - 64)) * 0.5) * SLEW));
      lowpass(fcL, r, c);
      this.lpf.set(c);
      const redo = this.fcH !== fcH || this.changed;
      this.fcL = fcL;
      if (redo) {
        highpass(fcH, r, c);
        this.hpf.set(c);
        this.fcH = fcH;
      }
      this.lpfMode = true;
    }
    this.kTarget = kT;
    this.changed = false;
    this.gTarget = f(f(1 - v) + f(v * comp));
    this.kStep = f(f(kT - this.k) * FADE);
  }

  execute(inL, inR, outL, outR, n) {
    let slew = 0;
    if (this.cur !== this.target || this.changed) {
      this.calcParameter();
      slew = f(f(this.gTarget - this.g) * SLEW);
    }
    let ms;
    if (this.lpfMode) {
      if (this.m < 1) ms = FADE;
      else {
        this.m = 1;
        ms = 0;
      }
    } else if (this.m <= 0) {
      this.m = 0;
      ms = 0;
    } else ms = -FADE;
    if (this.lp[0].length < n) {
      this.lp = [new Float32Array(n), new Float32Array(n)];
      this.hp = [new Float32Array(n), new Float32Array(n)];
    }
    const [lL, lR] = this.lp, [hL, hR] = this.hp;
    this.lpf.process(inL, inR, lL, lR, n);
    this.hpf.process(inL, inR, hL, hR, n);
    const kT = this.kTarget;
    let { g, k, m } = this;
    for (let i = 0; i < n; i++) {
      g = f(g + slew);
      if (this.kStep !== 0) {
        k = f(this.kStep + k);
        if (f(this.kStep * f(kT - k)) <= 0) {
          k = kT;
          this.kStep = 0;
        }
      }
      m = f(ms + m);
      if (m >= 1) {
        m = 1;
        ms = 0;
      } else if (m <= 0) {
        ms = 0;
        m = 0;
      }
      const a = f(1 - m), d = f(1 - k);
      outL[i] = f(f(inL[i] * k) + f(f(g * f(f(m * lL[i]) + f(a * hL[i]))) * d));
      outR[i] = f(f(inR[i] * k) + f(f(g * f(f(m * lR[i]) + f(a * hR[i]))) * d));
    }
    this.g = g;
    this.k = k;
    this.m = m;
  }
}

export const Core = FilterCore;
