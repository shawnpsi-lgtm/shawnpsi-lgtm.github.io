/**
 * Beat FX FLANGER, ported from the XDJ-RX3 v1.19 player (mixerengine::BeatEffectFlanger).
 *
 * A short delay line (up to 2.67 ms) with feedback, its length swept by a triangle LFO whose period is the beat
 * time:  line = in + y x resonance;  y = line read at d + 1 samples (linear interpolation);  out = in x dry + y x wet
 * LEVEL/DEPTH moves the dry/wet balance up to 1/4, then the resonance (0 .. 0.8). Below 0.5 ms the wet signal is
 * turned down (0.37 at no delay). The X-PAD (0-255) adds a second, faster triangle LFO (11 .. 100 ms) on top of
 * the sweep, at up to 10 % of its range, fading out over the right-hand quarter; 255 is off. Turning it on
 * restarts the sweep from the top and fades the wet signal in (4.35 ms); so does a BEAT press, after a fade out.
 */
import { BeatCore, Ramp, beatButtons, f, msLen } from '../dsp.js';

const LFO_DEPTH = f(0.1); // the X-PAD LFO's share of the sweep
const GAIN_THRESHOLD = f(0.0005); // s: below this delay the wet signal is turned down...
const GAIN_AT_ZERO = f(0.6314); // ...to 1 - this at no delay

export const meta = {
  name: 'FLANGER',
  unit: 'beat',
  beats: beatButtons(0, 11), // 1/16 .. 64
  defaultBeat: 7, // 4 beats
  // the X-PAD strip (setBeatEffectXpadLinear) for the second LFO: left is fastest, 255 (the rest) is off
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 255, left: 'FAST', right: 'OFF' },
};

/** dsp::LfoTriangle: a triangle between lo and hi, `ms` per half cycle. */
export class LfoTriangle {
  constructor(sampleRate, ms, hi, lo) {
    this.osr = sampleRate;
    this.hi = f(hi);
    this.lo = f(lo);
    this.v = 0;
    this.up = true;
    this.setTime(ms);
  }

  setTime(ms) {
    this.step = f(f(f(this.hi - this.lo) / f(f(f(this.osr) * f(ms)) * f(0.001))) * 0.5);
  }

  reset() {
    this.v = 0;
    this.up = true;
  }

  tick() {
    if (this.up) {
      this.v = f(this.v + this.step);
      if (this.v > this.hi) {
        this.up = false;
        this.v = f(f(this.hi + this.hi) - this.v);
      }
    } else {
      this.v = f(this.v - this.step);
      if (this.v < this.lo) {
        this.up = true;
        this.v = f(f(this.lo + this.lo) - this.v);
      }
    }
    return this.v;
  }
}

/** mixerengine::DelayUnit: a stereo ring buffer; read(d) after a write is the sample written d - 1 writes ago. */
export class DelayUnit {
  constructor(n) {
    this.len = n * 2;
    this.L = new Float32Array(this.len);
    this.R = new Float32Array(this.len);
    this.w = 0;
  }

  clear() {
    this.L.fill(0);
    this.R.fill(0);
    this.w = 0;
  }

  write(l, r) {
    this.L[this.w] = l;
    this.R[this.w] = r;
    if (++this.w >= this.len) this.w -= this.len;
  }

  index(d) {
    const i = this.w - d;
    return i < 0 ? i + this.len : i;
  }
}

export class FlangerCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 2000, minMs: 10, maxMs: 32000, button: 7, minButton: 0, maxButton: 11, position: 1 });
    const sr = f(sampleRate);
    this.sr = sr;
    const mix = msLen(sr, 3.3333333);
    this.dry = new Ramp(mix, 1);
    this.wet = new Ramp(mix);
    this.start = new Ramp(msLen(sr, 4.3514738)); // the wet signal's fade in/out at ON and BEAT presses
    this.lfo2Gain = new Ramp(mix);
    this.lfo2 = new LfoTriangle(sampleRate, 50, 1, -1);
    this.res = 0;
    this.fbL = this.fbR = 0;
    this.pos = 0; // the sweep, in samples of delay
    this.rate = 0;
    this.up = true;
    this.xpadCur = this.xpadTarget = 255;
    this.init = true;
    this.restart = false;
    this.initialize();
  }

  initialize() {
    const sr = this.sr;
    this.max = f(sr * f(0.0026666666));
    this.min = f(sr * 0);
    this.line = new DelayUnit(Math.trunc(this.max) + 1);
    this.gainFrom = f(sr * GAIN_THRESHOLD);
    this.gainSlope = f(GAIN_AT_ZERO / this.gainFrom);
    this.dry.step = 0;
    this.dry.cur = this.dry.target = 1;
    this.wet.step = this.wet.target = this.wet.cur = 0;
    this.lfo2Gain.step = this.lfo2Gain.target = this.lfo2Gain.cur = 0;
    this.init = true;
    this.changeTime();
  }

  changeLevelDepth() {
    const x = this.level;
    let dry, wet, res;
    if (x < 0.009765625) {
      dry = 1;
      res = wet = 0;
    } else if (x < 0.25) {
      const t = f(f(x - 0.009765625) * f(1.0406504));
      res = 0;
      dry = f(1 - t);
      wet = f(t * 3);
    } else if (x >= 1) {
      wet = dry = 0.75;
      res = f(0.8000001);
    } else {
      res = f(f(x - 0.25) * f(1.0666667));
      wet = dry = 0.75;
    }
    this.res = res;
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

  /** The X-PAD picks the second LFO's half period (11 .. 100 ms) and its gain. */
  setSecondLfo() {
    const x = this.xpadCur;
    const t = x <= 192 ? f(11 + f(x * f(0.203125))) : f(50 + f((x - 192) * f(0.8333333)));
    let g;
    if (t <= 100) {
      this.lfo2.setTime(t);
      g = t <= 50 ? 1 : f(1 - f(f(t - 50) * f(0.02)));
      if (g < 0) g = 0;
    } else {
      this.lfo2.setTime(100);
      g = 0;
    }
    this.lfo2Gain.retarget(g);
  }

  execute(inL, inR, outL, outR, n) {
    if (this.init) {
      this.start.retarget(1);
      this.fbL = this.fbR = 0;
      this.restart = false;
      this.pos = 0;
      this.init = false;
      this.up = true;
      this.xpadCur = this.xpadTarget = 255;
      this.setSecondLfo();
    }
    if (this.restart && this.start.done) {
      this.start.retarget(1);
      this.restart = false;
      this.fbL = this.fbR = 0;
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
    const { line, dry, wet, start, lfo2, lfo2Gain, max, min } = this;
    const depth = f(max * LFO_DEPTH);
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
      let d = f(this.pos + f(f(depth * lfo2Gain.cur) * f(v2 + 1)));
      if (!(max >= d)) d = max;
      if (!(min <= d)) d = min;
      const adj = this.gainFrom < d ? 1 : f(f(1 + f(d * this.gainSlope)) - GAIN_AT_ZERO);
      line.write(f(inL[i] + f(this.fbL * this.res)), f(inR[i] + f(this.fbR * this.res)));
      const k = Math.trunc(d), fr = f(d - k), g = f(1 - fr);
      const a = line.index(k + 2), b = line.index(k + 3);
      const yL = f(f(line.L[a] * g) + f(line.L[b] * fr)), yR = f(f(line.R[a] * g) + f(line.R[b] * fr));
      this.fbL = yL;
      this.fbR = yR;
      const s = start.cur, w = wet.cur, dv = dry.cur;
      outL[i] = f(f(inL[i] * dv) + f(f(f(yL * w) * adj) * s));
      outR[i] = f(f(inR[i] * dv) + f(f(f(yR * w) * adj) * s));
      dry.tick();
      wet.tick();
      start.tick();
      lfo2Gain.tick();
    }
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = FlangerCore;
