/**
 * Sound Color FX CRUSH, ported from the XDJ-RX3 v1.19 player (mixerengine::SoundColorFxCrush).
 *
 * A sample-and-hold decimator with bit reduction by masking the float's low mantissa bits. Left of centre the
 * hold lengthens as COLOR turns down; right of centre the same, with the held signal run through a resonant
 * high-pass (biquad + one-pole feedback loop, 60 Hz .. 4.3 kHz) faded in on a square law. PARAMETER sets the
 * longest hold (4.6 .. 33 samples) and, in its top half, how many mantissa bits survive (6 .. 0). Crossing the
 * centre switches between the two halves and clears the filter.
 */
import { ColorCore, f, hex } from '../dsp.js';

export const meta = { name: 'CRUSH', type: 6 };

const STEP = hex(0x3c042108); // 1/124
const MASK_FROM = hex(0x40930000); // holds up to this keep every bit
const T = hex(0x37be37c6), W = hex(0x40c90fdb), R2 = hex(0x403504f3), T2 = hex(0x300d56d6);
// steps 116..123: fixed low-pass coefficients
const NEAR = [0x3f5030c1, 0x3fd030c1, 0x3f5030c1, 0x3fcbafbc, 0x3f29638c, 0x3e034d65, 0xbe034d65, 0x3f3e594d].map(hex);

const bits = new Float32Array(2), word = new Uint32Array(bits.buffer);

export class CrushCore extends ColorCore {
  constructor(sampleRate) {
    super(1);
    this.sr = sampleRate;
    this.init = true;
    this.active = false; // +0x28: the right half (with the filter)
    this.flip = false; // +0x2c: switch halves at the end of this block
    this.step = 0; // +0x30: COLOR, 0..255
    this.pstep = 0; // +0x34: PARAMETER, 0..255
    this.hold = 0; // +0x38: longest hold
    this.phase = 0; // +0x3c
    this.count = 1; // +0x40
    this.hL = this.hR = 0; // +0x48: the held sample
    this.c = new Float32Array(8).fill(0); // +0x50..0x6c
    this.z = new Float32Array(8); // +0x70..0x88: z1, z2, z3, w (L/R pairs)
    this.fb = 0; // +0x90
    this.mix = 0; // +0x94: unfiltered share (squared)
    this.tmpL = new Float32Array(64);
    this.tmpR = new Float32Array(64);
    this.initialize(); // SoundColorFxManager::init
  }

  changeColor() {
    const c = Math.trunc(f(this.color * hex(0x437fe666)));
    this.step = c < 0 ? 0 : c >= 255 ? 255 : c;
  }

  changeParameter() {
    const p = Math.trunc(f(this.param * hex(0x437fe666)));
    if (p < 0) {
      this.hold = MASK_FROM;
      this.pstep = 0;
    } else if (p > 255) {
      this.pstep = 255;
      this.hold = hex(0x4203f499);
    } else if (p <= 127) {
      this.pstep = p;
      this.hold = f(MASK_FROM + f(f(p * 0.0078125) * hex(0x418ba666)));
    } else {
      this.pstep = p;
      this.hold = f(f(hex(0x418ba666) + f(f(f((p - 128) * 0.0078125) * 0.5) * hex(0x41b06666))) + MASK_FROM);
    }
  }

  /** make_cfx_crush_coef: the filter for COLOR step c (biquad c[0..4], one-pole c[5..7]). */
  coef(c) {
    const k = this.c;
    k.set([1, 0, 0, 0, 0, 0, 0, 0]);
    let n, hp;
    if (c < 0) {
      n = 0;
      hp = false;
    } else if (c > 255) {
      n = 123;
      hp = true;
    } else if (c <= 115) {
      n = c;
      hp = false;
    } else if (c <= 123) {
      k.set(NEAR);
      return;
    } else if (c <= 131) return;
    else {
      n = c - 132;
      hp = true;
    }
    if (hp) {
      const x = f(Math.pow(hex(0x3f848801), n));
      const w = f(f(x * 60) * W);
      const s8 = f(f(w * R2) * T), s13 = f(f(w * w) * T2), s12 = f(w * T);
      const n2 = f(1 / f(f(s13 + s8) + 4)), n1 = f(1 / f(s12 + 2));
      const b0 = f(n2 * 4);
      k[0] = b0;
      k[1] = f(b0 * -2);
      k[2] = b0;
      k[3] = f(f(f(s13 - 4) + f(s13 - 4)) * n2);
      k[4] = f(f(f(s13 - s8) + 4) * n2);
      k[5] = k[6] = f(s12 * n1);
      k[7] = f(f(s12 - 2) * n1);
    } else {
      const x = f(Math.pow(hex(0x3f87ead3), n));
      const w = f(f(x * 96) * W);
      const s8 = f(f(w * R2) * T), s15 = f(f(w * w) * T2), s9 = f(w * T);
      const n2 = f(1 / f(f(s8 + s15) + 4)), n1 = f(1 / f(s9 + 2));
      const b0 = f(s15 * n2);
      k[0] = b0;
      k[1] = f(b0 + b0);
      k[2] = b0;
      k[3] = f(n2 * f(f(s15 - 4) + f(s15 - 4)));
      k[4] = f(n2 * f(f(s15 - s8) + 4));
      k[5] = f(n1 + n1);
      k[6] = -k[5];
      k[7] = f(n1 * f(s9 - 2));
    }
  }

  initialize() {
    this.changeColor();
    this.changeParameter();
    const c = this.step;
    this.count = 1;
    this.phase = 0;
    this.hL = this.hR = 0;
    this.flip = false;
    if (c <= 123) {
      this.active = false;
      this.mix = 1;
    } else if (c <= 131) {
      this.active = true;
      this.mix = 1;
    } else {
      this.active = true;
      let x = f(f((c - 132) * hex(0x3b853408)) * 2);
      this.mix = x >= 0.5 ? 0 : f(1 - f(x + x));
    }
    this.coef(c);
    this.z.fill(0);
    this.fb = 0;
    this.init = false;
  }

  /** The decimator over a block: out (and, on the right half, tmp too) = the held, masked input. */
  decimate(inL, inR, outL, outR, n, len, mask, tmp) {
    let count = this.count, phase = this.phase, hL = this.hL, hR = this.hR;
    for (let i = 0; i < n; i++) {
      const cf = f(count);
      bits[0] = inL[i];
      bits[1] = inR[i];
      word[0] &= mask;
      word[1] &= mask;
      let take;
      if (count !== 1 && cf <= len) {
        count++;
        take = false;
      } else {
        count++;
        if (len >= cf) take = true;
        else {
          count = 2;
          phase = f(phase + f(f(len + 1) - cf));
          if (phase >= 1) {
            phase = f(phase - 1);
            count = 1;
            take = false;
          } else take = true;
        }
      }
      if (take) {
        hL = bits[0];
        hR = bits[1];
      }
      outL[i] = hL;
      outR[i] = hR;
      if (tmp) {
        this.tmpL[i] = hL;
        this.tmpR[i] = hR;
      }
    }
    this.count = count;
    this.phase = phase;
    this.hL = hL;
    this.hR = hR;
  }

  /** The bits kept: all, unless PARAMETER is past 144 and the hold is long. */
  mask(len) {
    if (this.pstep > 144) return len <= MASK_FROM ? 0xffffffff : (0xffffffff << (((this.pstep - 128) >>> 4) + 16)) >>> 0;
    return 0xffffffff;
  }

  holdLength(amount) {
    let len = f(this.hold * amount);
    if (this.pstep <= 7) len = f(len * f(this.pstep * 0.125));
    return len;
  }

  execute(inL, inR, outL, outR, n) {
    if (this.init) this.initialize();
    const c = this.step;
    if (!this.active) {
      let amount;
      if (c <= 124) amount = f((124 - c) * STEP);
      else {
        amount = 0;
        this.flip = true;
      }
      const len = this.holdLength(amount);
      this.decimate(inL, inR, outL, outR, n, len, this.mask(len), false);
    } else {
      let sel, r9, amount;
      if (c >= 124 && c <= 130) {
        r9 = -1;
        sel = 131;
        amount = 0;
      } else if (c <= 123) {
        r9 = -1;
        sel = 131;
        amount = 0;
        this.flip = true;
      } else {
        amount = f((c - 131) * STEP);
        r9 = c - 132;
        sel = c;
      }
      const len = this.holdLength(amount);
      if (this.tmpL.length < n) {
        this.tmpL = new Float32Array(n);
        this.tmpR = new Float32Array(n);
      }
      this.decimate(inL, inR, outL, outR, n, len, this.mask(len), true);
      this.coef(sel);
      let target;
      if (sel === 131) {
        this.fb = 0;
        target = 1;
      } else {
        const t = f(r9 * hex(0x3b853408));
        let a = f(1 - f(t + t));
        a = f(a * a);
        a = f(a * a);
        a = f(a * a);
        let s = f(f(t + 0.5) - 0.5);
        this.fb = f(f(1 - f(a * a)) * hex(0x3fa660cc));
        s = f(s + s);
        target = s < 0.5 ? f(1 - f(s + s)) : 0;
      }
      const slew = f(f(target - this.mix) * 0.015625);
      this.filter(outL, outR, n);
      let x = this.mix;
      for (let i = 0; i < n; i++) {
        x = f(x + slew);
        const q = f(x * x), r = f(1 - q);
        outL[i] = f(f(outL[i] * r) + f(this.tmpL[i] * q));
        outR[i] = f(f(outR[i] * r) + f(this.tmpR[i] * q));
      }
      const as = Math.abs(slew);
      if (as > x) x = 0;
      if (f(1 - as) < x) x = 1;
      this.mix = x;
    }
    if (this.flip) {
      this.z.fill(0);
      this.count = 1;
      this.active = !this.active;
      this.phase = 0;
      this.flip = false;
    }
  }

  /** iir_filter21_fb11, in place: y = biquad(x + fb w), w = one-pole(y); out = y. */
  filter(L, R, n) {
    const [c0, c1, c2, a1, a2, g0, g1, p1] = this.c, fb = this.fb, z = this.z;
    for (const [buf, o] of [[L, 0], [R, 1]]) {
      let z1 = z[o], z2 = z[2 + o], z3 = z[4 + o], w = z[6 + o];
      for (let i = 0; i < n; i++) {
        const u = f(buf[i] + f(fb * w));
        const y = f(f(c0 * u) + z1);
        buf[i] = y;
        w = f(f(g0 * y) + z3);
        z1 = f(f(f(c1 * u) - f(a1 * y)) + z2);
        z2 = f(f(c2 * u) - f(a2 * y));
        z3 = f(f(g1 * y) - f(p1 * w));
      }
      z[o] = z1;
      z[2 + o] = z2;
      z[4 + o] = z3;
      z[6 + o] = w;
    }
  }
}

export const Core = CrushCore;
