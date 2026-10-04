/**
 * Sound Color FX DUB ECHO, ported from the XDJ-RX3 v1.19 player (mixerengine::SoundColorFxDubecho).
 *
 * Two filtered feedback delay lines after the channel fader, so they keep ringing when it closes:
 *   line A: in -> low-pass -> high-pass, + its own tap x fbA;  line B: in -> high-pass, + its tap x fbB
 *   out = in + tapA x 0.7 + low-pass(tapB)
 * The delays rest at 55 ms. COLOR left of centre lengthens A (up to ~220 ms) and brings it in, right of centre
 * does the same for B (up to ~175 ms); a new time is crossfaded in over ~410 samples. PARAMETER is the feedback
 * (0.87 / 0.88 at the middle). At start the input fades in and the taps stay silent for 131 blocks while the
 * lines fill; switched off, the input fades out (4.35 ms) and the echoes carry on.
 */
import { Biquad, ColorCore, f, hex } from '../dsp.js';
import { HPF_L, HPF_R, LPF_L, LPF_R } from './dubecho-tables.js';

export const meta = { name: 'DUB ECHO', type: 4 };

const FADE = hex(0x3baaab3a), XFADE = hex(0x3b1f383f), SLEW = f(0.015625), REST = hex(0x45179800);
const THIRD = hex(0x40555555), K = hex(0x3b8d3dcb), TAP_A = hex(0x3f333333);

/** mixerengine::DelayUnit set up with init2: one sample per slot. */
class Line {
  constructor(len) {
    this.len = len;
    this.L = new Float32Array(len);
    this.R = new Float32Array(len);
    this.w = 0;
  }

  read(L, R, d, n) {
    let i = this.w - d;
    if (i < 0) i += this.len;
    for (let k = 0; k < n; k++) {
      L[k] = this.L[i];
      R[k] = this.R[i];
      if (++i >= this.len) i -= this.len;
    }
  }

  at(d) {
    let i = this.w - d;
    if (i < 0) i += this.len;
    return [this.L[i], this.R[i]];
  }

  save(L, R, n) {
    for (let k = 0; k < n; k++) {
      this.L[this.w] = L[k];
      this.R[this.w] = R[k];
      if (++this.w >= this.len) this.w -= this.len;
    }
  }
}

export class DubechoCore extends ColorCore {
  constructor(sampleRate) {
    super(2);
    this.sr = sampleRate;
    this.lpA = new Biquad();
    this.hpA = new Biquad();
    this.lpB = new Biquad();
    this.hpB = new Biquad();
    this.lpA.set(LPF_L);
    this.hpA.set(HPF_L);
    this.lpB.set(LPF_R);
    this.hpB.set(HPF_R);
    this.state = 0; // +0x24: 0 fading in, 1 filling, 2 running, 3 off (ringing out)
    this.dA = hex(0x46023f9a); // +0x58/+0x5c: line A's delay and its target
    this.dAT = 0;
    this.dB = hex(0x45cec000); // +0x60/+0x64
    this.dBT = 0;
    this.lineA = new Line(8448);
    this.lineB = new Line((Math.trunc(this.dB) + 128) & ~63);
    this.fade = 0; // +0x68: input
    this.wet = 0; // +0x6c: taps
    this.gA = this.gAT = 0; // +0x70/+0x74: line A's input gain
    this.gB = this.gBT = 0; // +0x78/+0x7c
    this.fbA = this.fbAT = 0; // +0x80/+0x84
    this.fbB = this.fbBT = 0; // +0x8c/+0x90
    this.xA = this.xB = 0; // +0x98/+0x9c: time crossfades
    this.pend = false; // +0xa0
    this.moveA = this.moveB = false; // +0xa1/+0xa2
    this.warm = 0; // +0xa4
    this.cur = this.target = 0;
    this.buf = [];
    this.n = 0;
    this.initialize(); // SoundColorFxManager::init
  }

  changeColor() {
    this.target = Math.trunc(f(this.color * 1023)) >> 2;
  }

  changeParameter() {
    if (!this.moveA && !this.moveB) this.pend = true;
    else this.calcFeedback();
  }

  statusOn() {
    if (this.state === 3) this.state = 2;
    return 1;
  }

  statusOff() {
    const was = this.state;
    this.state = was === 2 ? 3 : 0;
    return was === 2 ? 1 : 0;
  }

  initialize() {
    this.state = 0;
    for (const q of [this.lpA, this.hpA, this.lpB, this.hpB]) q.clear();
    this.moveA = this.moveB = false;
    this.fade = this.wet = this.gA = this.gB = this.fbA = this.fbB = this.xA = this.xB = 0;
    this.warm = 0;
    this.cur = this.target = Math.trunc(f(this.color * 1023)) >> 2;
    this.calcParameter();
    this.moveA = false;
    this.dA = this.dAT;
    this.dB = this.dBT;
    this.moveB = false;
  }

  /** PARAMETER: the feedback targets and g, the centre's level compensation. */
  feedback() {
    const p = this.param;
    let g = 1;
    if (p < hex(0x3ee8e8e9)) {
      const u = f(p * hex(0x400cb08d));
      this.fbAT = f(u * hex(0x3f5eb852));
      this.fbBT = f(u * hex(0x3f6147ae));
    } else if (p < hex(0x3f0c8c8d)) {
      this.fbAT = hex(0x3f5eb852);
      this.fbBT = hex(0x3f6147ae);
    } else {
      const v = f(f(p - hex(0x3f0b8b8c)) * hex(0x400cb08d));
      this.fbAT = f(hex(0x3f5eb852) + f(v * hex(0x3df5c290)));
      this.fbBT = f(hex(0x3f6147ae) + f(v * hex(0x3de147b0)));
      g = f(f(1 - p) * hex(0x400cb08d));
    }
    return g;
  }

  calcParameter() {
    let d = this.target - this.cur;
    if (this.target > this.cur) {
      if (this.cur <= 115 && d >= 2) d = 2;
    } else if (this.target < this.cur && this.cur > 139 && d < -2) d = -2;
    this.cur += d;
    this.pend = false;
    const x = f(this.cur), g = this.feedback();
    const k = f(hex(0x3f7ae148) + f(g * hex(0x3ca3d70a)));
    if (x > 115 && !(x > 139)) { // the centre: both lines at rest
      this.gAT = this.gBT = 0;
      this.dAT = this.dBT = REST;
      this.fbAT = f(this.fbAT * k);
      this.fbBT = f(this.fbBT * k);
    } else if (!(x > 115)) { // left: line A
      const t = f(1 - f(f(x * K) + f(x * K)));
      this.dBT = REST;
      this.gBT = 0;
      this.fbBT = f(this.fbBT * k);
      const a = f(t * THIRD);
      this.gAT = a <= 1 ? a : 1;
      if (t <= hex(0x3e4ccccd)) this.dAT = REST;
      else {
        const e = f(t - hex(0x3e4ccccd));
        this.fbAT = f(this.fbAT + f(g * f(e * hex(0x3dcccccd))));
        this.dAT = f(REST + f(f(e * hex(0x45b8ab33)) * 1.25));
      }
    } else { // right: line B
      const r = f(f(x - 139) * K), t = f(r + r);
      this.gAT = 0;
      this.dAT = REST;
      const a = f(t * THIRD);
      this.gBT = a > 1 ? 1 : a;
      this.fbAT = f(this.fbAT * k);
      if (t <= hex(0x3e4ccccd)) this.dBT = REST;
      else {
        const e = f(t - hex(0x3e4ccccd));
        this.fbBT = f(this.fbBT + f(g * f(e * hex(0x3dcccccd))));
        this.dBT = f(REST + f(f(e * hex(0x4582ec00)) * 1.25));
      }
    }
    if (this.dAT !== this.dA) {
      this.moveA = true;
      this.xA = 0;
    }
    if (this.dB !== this.dBT) {
      this.moveB = true;
      this.xB = 0;
    }
  }

  /** calcFeedback: PARAMETER moved while a delay time was still crossfading. */
  calcFeedback() {
    const x = f(this.cur), g = this.feedback();
    if (!(x > 115)) {
      const t = f(1 - f(f(x * K) + f(x * K)));
      if (t > hex(0x3e4ccccd)) this.fbAT = f(this.fbAT + f(f(f(t - hex(0x3e4ccccd)) * hex(0x3dcccccd)) * g));
    } else if (!(x > 139)) {
      const k = f(hex(0x3f7ae148) + f(g * hex(0x3ca3d70a)));
      this.fbAT = f(k * this.fbAT);
      this.fbBT = f(this.fbBT * k);
    } else {
      const k = f(hex(0x3f7ae148) + f(g * hex(0x3ca3d70a)));
      const r = f(f(x - 140) * K), t = f(r + r);
      this.fbAT = f(k * this.fbAT);
      if (t > hex(0x3e4ccccd)) this.fbBT = f(this.fbBT + f(f(f(t - hex(0x3e4ccccd)) * hex(0x3dcccccd)) * g));
    }
  }

  buffers(n) {
    if (n === this.n) return;
    this.n = n;
    this.buf = Array.from({ length: 7 }, () => [new Float32Array(n), new Float32Array(n)]);
  }

  /** Read a line's tap at a fractional delay over the block (each sample blended with the next). */
  tap(line, d, X, n) {
    const di = Math.trunc(f(d + 1));
    line.read(X[0], X[1], di, n);
    const [sL, sR] = line.at(di - n);
    const fr = f(d - Math.trunc(d)), g = f(1 - fr);
    for (const [x, s] of [[X[0], sL], [X[1], sR]]) {
      for (let i = 0; i < n - 1; i++) x[i] = f(f(fr * x[i]) + f(g * x[i + 1]));
      x[n - 1] = f(f(fr * x[n - 1]) + f(g * s));
    }
  }

  execute(inL, inR, outL, outR, n) {
    this.buffers(n);
    const [A, B, C, D, E, F, T] = this.buf;
    // the input, faded in or out
    const fadeIn = () => {
      for (let i = 0; i < n; i++) {
        let v = f(this.fade + FADE);
        if (v > 1) v = 1;
        this.fade = v;
        A[0][i] = T[0][i] = f(v * inL[i]);
        A[1][i] = T[1][i] = f(v * inR[i]);
      }
    };
    if (this.state === 0) {
      fadeIn();
      if (this.fade >= 1) this.state = 1;
    } else if (this.state === 3) {
      for (let i = 0; i < n; i++) {
        let v = f(this.fade - FADE);
        if (v <= 0) v = 0;
        this.fade = v;
        A[0][i] = T[0][i] = f(v * inL[i]);
        A[1][i] = T[1][i] = f(v * inR[i]);
      }
    } else if (this.fade >= 1) {
      A[0].set(inL.subarray(0, n));
      A[1].set(inR.subarray(0, n));
      T[0].set(inL.subarray(0, n));
      T[1].set(inR.subarray(0, n));
    } else fadeIn();
    this.hpB.process(T[0], T[1], B[0], B[1], n);
    this.lpA.process(A[0], A[1], T[0], T[1], n);
    this.hpA.process(T[0], T[1], A[0], A[1], n);
    if (this.cur !== this.target || this.pend) {
      if (!this.moveA && !this.moveB) this.calcParameter();
      else this.pend = true;
    }
    this.gain(A, 'gA', 'gAT', n);
    this.gain(B, 'gB', 'gBT', n);
    if (this.state <= 1) {
      this.warm++;
      for (const x of [C[0], C[1], D[0], D[1]]) x.fill(0, 0, n);
      if (this.warm > 130) {
        this.state = 2;
        this.warm = 0;
      }
    } else {
      this.tap(this.lineA, this.dA, C, n);
      this.tap(this.lineB, this.dB, D, n);
      this.tap(this.lineA, this.dAT, E, n);
      this.tap(this.lineB, this.dBT, F, n);
      if (this.moveA) this.cross(C, E, 'xA', n) && ((this.dA = this.dAT), (this.moveA = false));
      if (this.moveB) this.cross(D, F, 'xB', n) && ((this.dB = this.dBT), (this.moveB = false));
      const sA = this.fbA !== this.fbAT ? f(f(this.fbAT - this.fbA) * SLEW) : 0;
      const sB = this.fbB !== this.fbBT ? f(f(this.fbBT - this.fbB) * SLEW) : 0;
      for (let i = 0; i < n; i++) {
        if (this.wet < 1) this.wet = f(this.wet + FADE);
        this.fbA = f(this.fbA + sA);
        this.fbB = f(this.fbB + sB);
        const w = this.wet;
        for (let c = 0; c < 2; c++) {
          C[c][i] = f(C[c][i] * w);
          D[c][i] = f(D[c][i] * w);
          A[c][i] = f(A[c][i] + f(this.fbA * C[c][i]));
          B[c][i] = f(B[c][i] + f(this.fbB * D[c][i]));
        }
      }
      this.fbA = this.fbAT;
      this.fbB = this.fbBT;
    }
    this.lpB.process(D[0], D[1], T[0], T[1], n);
    for (let i = 0; i < n; i++) {
      outL[i] = f(f(inL[i] + f(TAP_A * C[0][i])) + T[0][i]);
      outR[i] = f(f(inR[i] + f(TAP_A * C[1][i])) + T[1][i]);
    }
    this.lineA.save(A[0], A[1], n);
    this.lineB.save(B[0], B[1], n);
  }

  gain(X, cur, tgt, n) {
    const c = this[cur], t = this[tgt];
    if (c !== t) {
      const st = f(f(t - c) * SLEW);
      let v = f(c + f(st * 0.5));
      for (let i = 0; i < n; i++) {
        X[0][i] = f(v * X[0][i]);
        X[1][i] = f(v * X[1][i]);
        v = f(v + st);
      }
      this[cur] = t;
    } else {
      for (let i = 0; i < n; i++) {
        X[0][i] = f(c * X[0][i]);
        X[1][i] = f(c * X[1][i]);
      }
    }
  }

  /** Crossfade the old tap into the new one; true when it has arrived. */
  cross(X, Y, key, n) {
    let x = this[key];
    for (let i = 0; i < n; i++) {
      x = f(x + XFADE);
      if (x >= 1) x = 1;
      const r = f(1 - x);
      X[0][i] = f(f(x * Y[0][i]) + f(r * X[0][i]));
      X[1][i] = f(f(x * Y[1][i]) + f(r * X[1][i]));
    }
    this[key] = x;
    if (x >= 1) {
      this[key] = 0;
      return true;
    }
    return false;
  }
}

export const Core = DubechoCore;
