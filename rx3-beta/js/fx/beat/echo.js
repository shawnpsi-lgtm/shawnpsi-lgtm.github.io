/**
 * Beat FX ECHO, ported from the XDJ-RX3 v1.19 player (mixerengine::BeatEffectEcho).
 *
 * One stereo delay line (8 s, shared with the other delay effects on the unit) with a fixed feedback of 0.7:
 *   line[w] = in x input fade + tap x 0.7;  out = in x dry + tap x wet
 * The delay is the beat time; a time change crossfades from the old tap to the new one over 3.3 ms. Until the
 * line has filled past the delay the output is dry. Turning it off fades the input out of the line (4.35 ms), so
 * the repeats ring out.
 */
import { BeatCore, Ramp, beatButtons, f, msLen } from '../dsp.js';

const FEEDBACK = f(0.7);

export const meta = {
  name: 'ECHO',
  unit: 'beat',
  beats: beatButtons(0, 9), // 1/16 .. 16
  defaultBeat: 5, // 1 beat
};

export class EchoCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 500, minMs: 1, maxMs: 4000, button: 5, minButton: 0, maxButton: 9, tail: true, position: 2 });
    const sr = f(sampleRate);
    this.len = Math.trunc(sampleRate) * 8;
    this.buf = new Float32Array(this.len * 2);
    const mix = msLen(sr, 3.3333333), on = msLen(sr, 4.3514738);
    this.xfade = new Ramp(mix);
    this.inFade = new Ramp(on);
    this.dry = new Ramp(mix, 1);
    this.wet = new Ramp(mix);
    this.delay = 1; // samples, current tap
    this.prev = 1; // the tap being crossfaded from
    this.w = 0;
    this.filled = 0; // twice the samples written since the start (bit 0: keep the old state, see keepInit)
    this.timeChanged = false;
    this.initialize();
  }

  initialize() {
    this.filled = 0;
  }

  notifySelected() {
    this.filled = 0;
    this.statusOn();
  }

  keepEffectInit() {
    this.filled = 1;
  }

  changeTime() {
    this.timeChanged = true;
  }

  statusOn() {
    this.inFade.start(0, 1);
    this.changeLevelDepth();
  }

  statusOff() {
    this.inFade.retarget(0);
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
    this.wet.retarget(wet);
  }

  samples() {
    return (Math.floor(this.ms * 2 * 44.1) + 1) >>> 1;
  }

  execute(inL, inR, outL, outR, n, bypass) {
    const { buf, len, xfade, inFade, dry, wet } = this;
    let filled = this.filled;
    if (filled === 0) {
      inFade.start(0, 1);
      this.w = 0;
      this.timeChanged = true;
      this.delay = this.prev = this.samples();
      xfade.step = xfade.target = xfade.cur = 0;
    }
    let advance = false, silent = false;
    let delay = this.delay;
    if ((filled >> 1) < len) {
      advance = true;
      if (delay < filled >> 1) {
        if (delay + n >= filled >> 1) {
          this.changeLevelDepth();
          delay = this.delay;
        }
      } else if ((filled & 1) === 0) {
        dry.step = 0;
        dry.cur = dry.target = 1;
        silent = true;
        wet.step = wet.target = wet.cur = 0;
      } else if (dry.target < 1) {
        dry.retarget(1);
      }
    }
    let next = delay;
    if (this.timeChanged) {
      next = this.samples();
      if (next === delay) this.timeChanged = false;
    }
    const on = this.on;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      let j = w - delay;
      if (j < 0) j += len;
      let k = w - this.prev;
      if (k < 0) k += len;
      let aL = buf[j * 2], aR = buf[j * 2 + 1];
      let bL = buf[k * 2], bR = buf[k * 2 + 1];
      if (advance) {
        if (silent) {
          aL = aR = bL = bR = 0;
          if (delay <= this.filled >> 1) {
            silent = false;
            aL = buf[j * 2];
            aR = buf[j * 2 + 1];
            bL = buf[k * 2];
            bR = buf[k * 2 + 1];
          }
        }
        this.filled += 2;
      }
      if (!xfade.done) {
        const c = xfade.cur;
        aL = f(bL + f(f(aL - bL) * c));
        aR = f(bR + f(f(aR - bR) * c));
        xfade.tick();
      } else if (this.timeChanged && !silent) {
        this.timeChanged = false;
        xfade.start(0, 1);
        this.prev = delay;
        this.delay = delay = next;
      }
      const g = inFade.cur;
      const wL = f(f(inL[i] * g) + f(aL * FEEDBACK)), wR = f(f(inR[i] * g) + f(aR * FEEDBACK));
      inFade.tick();
      const d = dry.cur, v = wet.cur;
      if (!on || (this.filled & 1)) {
        outL[i] = f(f(f(inL[i] * d) * g) + f(aL * v));
        outR[i] = f(f(f(inR[i] * d) * g) + f(aR * v));
        if (bypass) bypass[i] = 1 - d * g;
      } else {
        outL[i] = f(f(inL[i] * d) + f(aL * v));
        outR[i] = f(f(inR[i] * d) + f(aR * v));
        if (bypass) bypass[i] = 0;
      }
      dry.tick();
      wet.tick();
      buf[w * 2] = wL;
      buf[w * 2 + 1] = wR;
      if (++w >= len) w -= len;
    }
    this.w = w;
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = EchoCore;
