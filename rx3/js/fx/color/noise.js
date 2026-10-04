/**
 * Sound Color FX NOISE, ported from the XDJ-RX3 v1.19 player (mixerengine::SoundColorFxNoise).
 *
 * White noise (the firmware's own xor-add generator, so it is the same noise) through a band-pass whose centre
 * follows COLOR (75 Hz .. on a 1.0423^step curve, with a narrowing Q at the ends), fed back on itself, and added
 * to the signal: out = in + bandpass(noise + y' x B) x level x (1 - A^2) x mix. Turning COLOR away from the centre
 * brings the noise in (left: the band moves down, right: up); PARAMETER is the noise level (0 .. 0.6, steeper in
 * its top half). The noise runs at every setting; at the centre mix is 0.
 */
import { Biquad, ColorCore, f, hex } from '../dsp.js';

export const meta = { name: 'NOISE', type: 2 };

const K = hex(0x3b853400), MIX = hex(0x3c37d4dd), EPS = hex(0x34000000);
const dbl = (hi, lo) => new Float64Array(new Uint32Array([lo, hi]).buffer)[0];
const D0 = dbl(0x3fe12bf5, 0x265d36e8), D1 = dbl(0x3f859390, 0x8329f26b);
const TW = hex(0x40c90fdb), T = hex(0x37be37c6), T2 = hex(0x300d56d6);

/** Whitenoise_Fil_Coef: the band-pass for COLOR step c. */
function bandpass(c, out) {
  c &= 0xff;
  let fc = f(f(Math.pow(hex(0x3f856ac0), c <= 127 ? c : c - 128)) * 75);
  let s13 = 1, s12 = -1.5, s14 = -2.5, s15 = 2;
  const edge = c <= 127 ? (c > 116 ? c - 116 : -1) : c > 244 ? c - 244 : -1;
  if (edge >= 0) {
    const y = f(Math.pow(hex(0x3f705dc7), edge));
    s15 = f(y + y);
    const h = f(1 / s15);
    s12 = f(0.5 - s15);
    s14 = f(-0.5 - s15);
    s13 = f(h + h);
  }
  let a = f(f(f(fc * s14) / s12) - fc);
  a = f(f(a * s15) * TW); // w
  const wq = f(f(a * s13) * T), w2 = f(f(a * a) * T2);
  const norm = f(1 / f(f(w2 + wq) + 4));
  const b0 = f(wq * norm);
  out[0] = b0;
  out[1] = 0;
  out[2] = -b0;
  out[3] = f(f(f(w2 - 4) + f(w2 - 4)) * norm);
  out[4] = f(f(f(w2 - wq) + 4) * norm);
}

export class NoiseCore extends ColorCore {
  constructor(sampleRate) {
    super(0);
    this.sr = sampleRate;
    this.bp = new Biquad();
    this.coef = new Float32Array(5);
    this.yL = this.yR = 0; // +0x28: the band-pass output, fed back
    this.aStep = 0;
    this.aT = this.a = 1; // +0x40/+0x44
    this.bStep = 0;
    this.bT = this.b = hex(0x3f333333); // +0x4c/+0x50
    this.level = 0; // +0x54
    this.inv = f(1 / 64); // +0x58: 1 / block
    this.mix = 0; // +0x5c
    this.cur = this.target = 127;
    this.s0 = 0x67452301;
    this.s1 = 0xefcdab89 | 0;
    this.noise = new Float32Array(128);
    this.u = [new Float32Array(1), new Float32Array(1), new Float32Array(1), new Float32Array(1)];
    this.initialize(); // SoundColorFxManager::init
  }

  changeColor() {
    this.target = Math.trunc(f(this.color * 1023)) >> 2;
  }

  initialize(n = 64) {
    this.yL = this.yR = 0;
    this.level = 0;
    this.inv = f(1 / n);
    this.cur = this.target = Math.trunc(f(this.color * 1023)) >> 2;
    this.calcParameter();
    this.a = this.aT;
    this.b = this.bT;
    this.aStep = this.bStep = 0;
    this.bp.clear();
  }

  calcParameter() {
    let cur = this.cur;
    const tgt = this.target, wasLeft = cur <= 127;
    if (cur < tgt) cur = tgt <= cur + 2 ? tgt : cur + 3;
    else if (cur > tgt) cur = tgt >= cur - 2 ? tgt : cur - 3;
    this.cur = cur;
    const x = f(cur), left = cur <= 127;
    let mix, aT, t, arg = cur;
    if (!(x > 127) ? x <= 123 : x > 132) {
      if (x <= 127) { // left: the band moves down
        t = f(1 - f(f(x * K) + f(x * K)));
        aT = t < 0.25 ? f(1 - f(t * 4)) : 0;
        const s13 = x <= 40 ? 1 : pow8(f(1 - f(f(x - 40) * hex(0x3ab78034))));
        mix = f(f(f(124 - x) * MIX) * s13);
      } else { // right: the band moves up
        const k = f(f(x - 132) * K);
        t = f(k + k);
        aT = t < 0.25 ? f(1 - f(t * 4)) : 0;
        const s13 = x <= 180 ? 1 : pow8(f(1 - f(f(x - 180) * hex(0x3b83126f))));
        if (x < 157) {
          const u = f(f(157 - x) * hex(0x3b83126f));
          mix = f(hex(0x3f4ccccd) - f(f(u * 80) * u));
        } else if (x < 182) {
          mix = f(D0 + f(182 - x) * D1);
        } else mix = f(f(f(x - 131) * MIX) * s13);
      }
    } else { // the centre
      mix = 0;
      aT = 1;
      t = 0;
      arg = 131;
    }
    this.mix = mix;
    bandpass(arg, this.coef);
    this.bp.set(this.coef);
    if (wasLeft !== left) this.bp.clear();
    let bT = hex(0x3f333333);
    if (mix === 0) {
      let s = f(t * t);
      s = f(s * s);
      s = f(s * s);
      bT = f(bT + f(f(s * s) * hex(0x3dcccccd)));
    }
    this.aT = aT;
    this.bT = bT;
    const two = f(this.inv + this.inv);
    this.bStep = f(two * f(bT - this.b));
    this.aStep = f(f(aT - this.a) * two);
  }

  execute(inL, inR, outL, outR, n) {
    if (this.noise.length < 2 * n) this.noise = new Float32Array(2 * n);
    const noise = this.noise;
    let s0 = this.s0, s1 = this.s1;
    for (let i = 0; i < 2 * n; i++) {
      noise[i] = f(f(s1) * hex(0x30000000));
      s0 = (s0 ^ s1) | 0;
      s1 = (s1 + s0) | 0;
    }
    this.s0 = s0;
    this.s1 = s1;
    // PARAMETER: the noise level, reached by the middle of the block
    const p = this.param;
    let L = f(p * f(p * 4));
    if (p >= 0.5) {
      const d = f(p - 0.5);
      L = f(f(d * f(d * f(d * 32))) + f(f(p + p) * L));
    }
    L = f(L * hex(0x3e19999a));
    let slew = f(f(L - this.level) * f(this.inv + this.inv));
    if (!(slew >= EPS) && slew > -EPS) slew = 0;
    const half = (n / 2) | 0;
    this.level = f(L - f(f(f(n) * slew) * 0.5));
    const [uL, uR, yL1, yR1] = this.u;
    for (let h = 0; h < 2; h++) {
      if (this.cur !== this.target) this.calcParameter();
      const off = h * half;
      for (let j = 0; j < half; j++) {
        const i = off + j;
        if (this.bStep !== 0) {
          this.b = f(this.bStep + this.b);
          if (f(this.bStep * f(this.bT - this.b)) <= 0) {
            this.bStep = 0;
            this.b = this.bT;
          }
        }
        const B = this.b;
        uL[0] = f(noise[2 * i] + f(this.yL * B));
        uR[0] = f(noise[2 * i + 1] + f(this.yR * B));
        this.bp.process(uL, uR, yL1, yR1, 1);
        const yl = yL1[0], yr = yR1[0];
        this.yL = yl;
        this.yR = yr;
        if (this.aStep !== 0) {
          this.a = f(this.aStep + this.a);
          if (f(this.aStep * f(this.aT - this.a)) <= 0) {
            this.a = this.aT;
            this.aStep = 0;
          }
        }
        if (h === 0) this.level = f(slew + this.level);
        const g = f(f(1 - f(this.a * this.a)) * this.mix), lv = this.level;
        outL[i] = f(inL[i] + f(f(yl * lv) * g));
        outR[i] = f(inR[i] + f(f(yr * lv) * g));
      }
    }
  }
}

function pow8(s) {
  let r = f(s * s);
  for (let k = 0; k < 6; k++) r = f(r * s);
  return r;
}

export const Core = NoiseCore;
