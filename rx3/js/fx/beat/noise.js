/**
 * Beat FX NOISE, from shawnsingh.me/beatfx (not an RX3 effect, so there is no firmware to null against).
 *
 * A white-noise wash layered over the untouched signal: noise -> high-pass -> the ported REVERB (fully wet, at a
 * large size) -> tremolo. The tremolo sits after the reverb (before it, the tail would smear the pump flat); its
 * period is the beat time, and LEVEL/DEPTH is its depth (0 = a steady wash, 1 = a full 0..1 pump). The X-PAD strip
 * sweeps the high-pass (left = full and dark, right = thin and airy). OFF stops feeding the reverb, so the wash
 * rings out.
 */
import { BeatCore, Biquad, Ramp, beatButtons, msLen } from '../dsp.js';
import { ReverbCore } from './reverb.js';

const SIZE = 45; // the reverb's percent: an RT60 of about 5 s, like beatfx's plate
const GAIN = 0.3; // the wash's level: about -18 dB RMS at no depth
const CUTOFF = 600; // Hz, the high-pass at rest

export const meta = {
  name: 'NOISE',
  unit: 'beat',
  beats: beatButtons(0, 9), // 1/16 .. 16
  defaultBeat: 5, // 1 beat
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 128, left: 'LOW', right: 'HIGH' },
};

/** RBJ high-pass, Q 0.707, as [b0, b1, b2, a1, a2]. */
function highpass(sr, hz) {
  const w = (2 * Math.PI * hz) / sr, cos = Math.cos(w), alpha = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + alpha;
  return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

export class NoiseCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 500, minMs: 1, maxMs: 64000, button: 5, minButton: 0, maxButton: 9, tail: true, position: 2 });
    this.sr = sampleRate;
    this.send = new Ramp(msLen(sampleRate, 20)); // noise into the reverb: ON/OFF
    this.depth = new Ramp(msLen(sampleRate, 20));
    this.dryFade = new Ramp(msLen(sampleRate, 4.3514738), 1); // the dry fading out under the manager's after OFF
    this.hp = new Biquad();
    this.xpad = this.xpadTarget = 128;
    this.hp.set(highpass(sampleRate, CUTOFF));
    this.phase = 0;
    this.nL = new Float32Array(64);
    this.nR = new Float32Array(64);
    this.fL = new Float32Array(64);
    this.fR = new Float32Array(64);
    this.wL = new Float32Array(64);
    this.wR = new Float32Array(64);
    this.verb = new ReverbCore(sampleRate, 64);
    this.verb.setPercent(SIZE);
    this.verb.setLevel(1);
    this.verb.toggle();
    this.initialize();
  }

  initialize() {
    this.verb.initialize();
    this.verb.execute(this.nL, this.nR, this.wL, this.wR, 64); // its first block passes the input through: spend it
    this.hp.clear();
    this.phase = 0;
  }

  changeLevelDepth() {
    this.depth.retarget(this.level);
  }

  statusOn() {
    this.send.retarget(1);
    this.dryFade.hold(1);
    this.changeLevelDepth();
  }

  statusOff() {
    this.send.retarget(0);
    this.dryFade.retarget(0);
  }

  setXpad(v) {
    this.xpadTarget = v;
  }

  execute(inL, inR, outL, outR, n) {
    if (this.nL.length < n) for (const k of ['nL', 'nR', 'fL', 'fR', 'wL', 'wR']) this[k] = new Float32Array(n);
    const { nL, nR, fL, fR, wL, wR, send, depth, dryFade } = this;
    if (this.xpad !== this.xpadTarget) { // glide a step per block, so a jump on the strip doesn't click
      this.xpad += Math.max(-8, Math.min(8, this.xpadTarget - this.xpad));
      this.hp.set(highpass(this.sr, CUTOFF * Math.pow(2, ((this.xpad - 128) / 128) * 3.5)));
    }
    for (let i = 0; i < n; i++) {
      const g = send.cur;
      nL[i] = (Math.random() * 2 - 1) * g;
      nR[i] = (Math.random() * 2 - 1) * g;
      send.tick();
    }
    this.hp.process(nL, nR, fL, fR, n);
    this.verb.execute(fL, fR, wL, wR, n);
    const dphi = 1000 / (this.ms * this.sr), on = this.on;
    let phi = this.phase;
    for (let i = 0; i < n; i++) {
      const d = depth.cur, trem = (1 - d / 2 + (d / 2) * Math.sin(2 * Math.PI * phi)) * GAIN;
      const g = on ? 1 : dryFade.cur;
      outL[i] = inL[i] * g + wL[i] * trem;
      outR[i] = inR[i] * g + wR[i] * trem;
      depth.tick();
      dryFade.tick();
      phi += dphi;
      if (phi >= 1) phi -= 1;
    }
    this.phase = phi;
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = NoiseCore;
