/**
 * Beat FX TRANS, ported from the XDJ-RX3 v1.19 player (mixerengine::BeatEffectTrans).
 *
 * A gate: each beat time the sound is cut after the open part of the period, with a 147-sample ramp in and out.
 * The gate is decided every 8 samples. LEVEL/DEPTH first blends the gated sound in (up to 1/2), then shortens
 * the open part from half the period to 1/16 of it (never under 5 ms). ON and BEAT presses restart the period.
 *   out = in x gate x (1 - dry) + in x dry
 */
import { BeatCore, Ramp, beatButtons, f, hex, msLen } from '../dsp.js';

const CHUNK = 8;
const RATE = hex(0x3bdef417); // the gate's ramp per sample

export const meta = {
  name: 'TRANS',
  unit: 'beat',
  beats: beatButtons(0, 9), // 1/16 .. 16
  defaultBeat: 5, // 1 beat
};

export class TransCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 500, minMs: 10, maxMs: 16000, button: 5, minButton: 0, maxButton: 9, position: 1 });
    this.sr = f(sampleRate);
    this.mix = new Ramp(msLen(this.sr, 3.3333333), 1); // the dry share
    this.env = 1;
    this.open = true;
    this.count = 0;
    this.duty = 0; // samples open
    this.period = 0;
    this.minOpen = 0;
    this.initialize();
  }

  /** The open fraction of the period: 1/2 up to LEVEL/DEPTH 1/2, then down to 1/16. */
  dutyFactor() {
    const x = this.level;
    return x > 0.5 ? f(0.9375 - f(x * 0.875)) : 0.5;
  }

  periodSamples() {
    return Math.trunc(f(0.5 + f(f(this.sr * f(this.ms)) * hex(0x3a83126f))));
  }

  setDuty(factor) {
    const d = Math.trunc(f(f(this.period) * factor));
    this.duty = d < this.minOpen ? this.minOpen : d;
  }

  initialize() {
    this.minOpen = Math.trunc(f(this.sr * hex(0x3ba3d70a)));
    this.mix.cur = this.mix.target = 1;
    this.mix.step = 0;
    const factor = this.dutyFactor();
    this.period = this.periodSamples();
    this.setDuty(factor);
    this.count = 0;
    this.open = true;
  }

  changeLevelDepth() {
    const x = this.level;
    let d;
    if (x < 0.009765625) d = 1;
    else if (x < 0.5) {
      d = f(1 - f(f(x - 0.009765625) * hex(0x40028cc0)));
      d = f(d * d);
    } else d = 0;
    this.mix.retarget(d);
    this.setDuty(this.dutyFactor());
  }

  changeTime() {
    const factor = this.dutyFactor();
    this.period = this.periodSamples();
    this.setDuty(factor);
    if (this.pressed) {
      this.count = 0;
      this.open = true;
    }
  }

  statusOn() {
    const factor = this.dutyFactor();
    this.period = this.periodSamples();
    this.setDuty(factor);
    this.count = 0;
    this.open = true;
    this.env = 1;
  }

  execute(inL, inR, outL, outR, n) {
    const mix = this.mix;
    for (let done = 0; done < n;) {
      const m = Math.min(n - done, CHUNK);
      let rate;
      if (this.period <= this.count) {
        this.open = true;
        this.count = 0;
        rate = RATE;
      } else if (!this.open) {
        if (this.count > this.duty) rate = -RATE;
        else {
          this.open = true;
          rate = RATE;
        }
      } else if (this.duty <= this.count) {
        this.open = false;
        rate = -RATE;
      } else rate = RATE;
      for (let i = done; i < done + m; i++) {
        let e = f(rate + this.env);
        this.env = e;
        if (e < 0) e = this.env = 0;
        else if (e > 1) e = this.env = 1;
        const d = mix.cur, g = f(1 - d);
        outL[i] = f(f(f(inL[i] * e) * g) + f(inL[i] * d));
        outR[i] = f(f(f(inR[i] * e) * g) + f(inR[i] * d));
        mix.tick();
      }
      done += m;
      this.count += m;
    }
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = TransCore;
