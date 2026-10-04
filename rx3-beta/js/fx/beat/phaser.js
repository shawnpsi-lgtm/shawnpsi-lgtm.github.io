/**
 * Beat FX PHASER, ported from the XDJ-RX3 v1.19 player (mixerengine::BeatEffectPhaser).
 *
 * Six first-order allpass stages swept by a triangle LFO (period = the beat time) over 300 Hz .. 8.9 kHz on a cubic
 * curve, with feedback from a smoothed copy of their output:
 *   x = in + fb x z;  y = allpass6(x);  z = 0.76 y' + 0.24 z;  out = in x dry + (in + y) x (0.7 - 0.4 c) x wet
 * where c (0..1) is the sweep and y' the previous output. LEVEL/DEPTH crossfades into the phased signal up to 1/4,
 * then raises the feedback (0 .. 0.7). The X-PAD (0-255) adds a second, faster LFO (6 .. 33 ms) to the sweep, at
 * less depth the slower it is; 255 is off. ON and BEAT presses restart the sweep from the top, fading the wet signal.
 */
import { BeatCore, Ramp, beatButtons, f, hex, msLen } from '../dsp.js';
import { LfoTriangle } from './flanger.js';

export const meta = {
  name: 'PHASER',
  unit: 'beat',
  beats: beatButtons(0, 11), // 1/16 .. 64
  defaultBeat: 7, // 4 beats
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 255, left: 'FAST', right: 'OFF' },
};

const SMOOTH_A = f(0.7594334483146667), SMOOTH_B = f(0.24056653678417206); // the output smoother (sums to 1)

export class PhaserCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 2000, minMs: 10, maxMs: 32000, button: 7, minButton: 0, maxButton: 11, position: 1 });
    const sr = f(sampleRate);
    this.sr = sr;
    this.inv = f(1 / sr);
    this.w = this.inv * (2 * Math.PI); // rad per Hz, in double as the firmware computes it
    const mix = msLen(sr, 3.3333333);
    this.dry = new Ramp(mix, 1);
    this.wet = new Ramp(mix);
    this.start = new Ramp(msLen(sr, 4.3514738));
    this.lfo2Gain = new Ramp(mix);
    this.lfo2 = new LfoTriangle(sampleRate, 33, 1, -1);
    this.fb = 0;
    this.yL = this.yR = 0; // the last output (y')
    this.zL = this.zR = 0;
    this.stL = new Float32Array(6);
    this.stR = new Float32Array(6);
    this.pos = 1;
    this.max = 1;
    this.min = 0;
    this.rate = 0;
    this.up = false;
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
    this.stL.fill(0);
    this.stR.fill(0);
  }

  changeLevelDepth() {
    const x = this.level;
    let dry, wet, fb;
    if (x < 0.009765625) {
      dry = 1;
      wet = fb = 0;
    } else if (x < 0.25) {
      wet = f(f(x - 0.009765625) * hex(0x40853408));
      dry = f(1 - wet);
      fb = 0;
    } else if (x >= 1) {
      fb = f(0.7);
      wet = 1;
      dry = 0;
    } else {
      fb = f(f(x - 0.25) * hex(0x3f6eeeef));
      wet = 1;
      dry = 0;
    }
    this.fb = fb;
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
    const t = x <= 192 ? f(6 + f(x * hex(0x3d955555))) : f(20 + f((x - 192) * hex(0x3e5dddde)));
    let g;
    if (t <= 33) {
      this.lfo2.setTime(t);
      g = t > 1 ? f(1 - f(f(t - 1) * hex(0x3d0004a5))) : 1;
      if (!(g >= 0)) g = 0;
    } else {
      this.lfo2.setTime(33);
      g = 0;
    }
    this.lfo2Gain.retarget(g);
  }

  execute(inL, inR, outL, outR, n) {
    if (this.init) {
      this.start.retarget(1);
      this.up = false;
      this.pos = 1;
      this.restart = false;
      this.init = false;
      this.xpadCur = this.xpadTarget = 255;
      this.setSecondLfo();
    }
    if (this.restart && this.start.done) {
      this.start.retarget(1);
      this.restart = false;
      this.up = false;
      this.pos = 1;
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
    const { stL, stR, dry, wet, start, lfo2, lfo2Gain, max, min, fb } = this;
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
      this.zL = f(f(SMOOTH_A * yL) + f(SMOOTH_B * this.zL));
      this.zR = f(f(SMOOTH_A * yR) + f(SMOOTH_B * this.zR));
      const xL = f(f(fb * this.zL) + inL[i]), xR = f(f(fb * this.zR) + inR[i]);
      let c = f(this.pos + f(v2 * lfo2Gain.cur));
      if (!(max >= c)) c = max;
      if (!(min <= c)) c = min;
      const fc = f(300 + f(f(f(c * c) * c) * 8600));
      const w = f(fc * this.w);
      const a = f(f(w - 2) / f(w + 2));
      const g = f(f(0.7) - f(c * hex(0x3ecccccd)));
      let uL = f(xL - f(a * stL[0])), uR = f(xR - f(a * stR[0]));
      for (let k = 1; k < 6; k++) {
        const nL = f(f(f(a * uL) + stL[k - 1]) - f(a * stL[k])), nR = f(f(f(a * uR) + stR[k - 1]) - f(a * stR[k]));
        stL[k - 1] = uL;
        stR[k - 1] = uR;
        uL = nL;
        uR = nR;
      }
      yL = f(f(a * uL) + stL[5]);
      yR = f(f(a * uR) + stR[5]);
      stL[5] = uL;
      stR[5] = uR;
      const pL = f(g * f(inL[i] + yL)), pR = f(g * f(inR[i] + yR));
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
export const Core = PhaserCore;
