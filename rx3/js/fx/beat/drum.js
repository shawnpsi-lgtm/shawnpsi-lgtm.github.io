/**
 * Beat FX DRUM, from shawnsingh.me/beatfx (not an RX3 effect, so there is no firmware to null against).
 *
 * A TR-909 snare rolled at the BEAT and layered over the untouched signal, LEVEL/DEPTH its volume. While the routed deck plays, every hit lands on its beat grid (re-read every block, so seek, hot cue and
 * nudge can't drift it); with the deck stopped it free-runs at the beat time, a stand-alone drum machine. PITCH
 * tunes the next hits (whole semitones, an octave either way) and the X-PAD strip bends them further while held.
 * OFF stops new hits and lets the ringing ones finish.
 *
 * The sample is decoded on the page (it arrives through setData); the section hands the deck's beat position in
 * through `clock` ({ playing, beat, perSample }: beats since the grid's first beat at the block's first sample,
 * and beats per sample), or leaves it null without a grid.
 */
import { BEAT_FACTOR, BeatCore, Ramp, beatButtons, msLen } from '../dsp.js';

const GAIN = 0.9; // at full LEVEL/DEPTH
/** PITCH (0..1) in semitones: -12 .. +12, centre 0. */
export const pitchSemitones = (x) => Math.round((x - 0.5) * 24);
/** PITCH as the controls show it: -12 .. 0 .. +12. */
export const pitchLabel = (x) => { const n = pitchSemitones(x); return (n > 0 ? '+' : '') + n; };
const VOICES = 8;

export const meta = {
  name: 'DRUM',
  unit: 'beat',
  beats: beatButtons(0, 8), // 1/16 .. 8
  defaultBeat: 3, // 1/2
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 128, left: 'PITCH -', right: 'PITCH +' },
  samples: ['tr-909-snare-shot.wav'], // fetched from /drum/ by the page
  pitch: true, // has a PITCH control (whole semitones, -12 .. +12; selecting DRUM recentres it)
};

export class DrumCore extends BeatCore {
  constructor(sampleRate) {
    super({ ms: 250, minMs: 1, maxMs: 16000, button: 3, minButton: 0, maxButton: 8, tail: true, position: 2 });
    this.sr = sampleRate;
    this.kit = []; // [{ l, r }]: the snare, once decoded
    this.voices = []; // { l, r, pos, rate }
    this.pitch = 1; // PITCH, as a playback rate
    this.bend = 1; // the X-PAD strip, on top of it
    this.clock = null;
    this.vol = new Ramp(msLen(sampleRate, 20)); // LEVEL/DEPTH, glided so a move doesn't zipper
    this.g = new Float32Array(64);
    this.dryFade = new Ramp(msLen(sampleRate, 4.3514738), 1); // the dry fading out under the manager's after OFF
    this.initialize();
  }

  setData(kit) {
    this.kit = kit;
  }

  initialize() {
    this.voices.length = 0;
    this.notifySelected();
  }

  notifySelected() {
    this.next = NaN; // grid: the beat position of the next hit
    this.wait = 0; // free-running: samples to the next hit
  }

  changeTime() {
    this.next = NaN; // re-align to the new division
  }

  changeLevelDepth() {
    this.vol.retarget(this.level * GAIN);
  }

  statusOn() {
    this.dryFade.hold(1);
    this.notifySelected();
  }

  statusOff() {
    this.dryFade.retarget(0);
  }

  setPitch(x) { // 0..1, centre = as recorded
    this.pitch = Math.pow(2, pitchSemitones(x) / 12);
  }

  setXpad(v) {
    this.bend = Math.pow(2, (v - 128) / 128); // 0.5x .. ~2x, centre 1x
  }

  hit(at) {
    const s = this.kit[0];
    if (!s) return; // not decoded yet
    if (this.voices.length >= VOICES) this.voices.shift();
    const rate = this.pitch * this.bend;
    this.voices.push({ l: s.l, r: s.r, pos: -at * rate, rate });
  }

  schedule(n) {
    const c = this.clock;
    if (c?.playing && c.perSample > 0) {
      const step = BEAT_FACTOR[this.button], end = c.beat + n * c.perSample;
      // first block, a new division, or the playhead jumped (seek, hot cue): the next grid line from here
      if (!(this.next >= c.beat && this.next <= c.beat + step + 1e-9)) this.next = Math.ceil(c.beat / step - 1e-9) * step;
      for (; this.next < end; this.next += step) this.hit(Math.round((this.next - c.beat) / c.perSample));
      this.wait = 0;
    } else {
      this.next = NaN;
      const len = Math.max(1, Math.round(this.ms * this.sr / 1000));
      for (; this.wait < n; this.wait += len) this.hit(this.wait);
      this.wait -= n;
    }
  }

  execute(inL, inR, outL, outR, n) {
    if (this.on) this.schedule(n);
    const fade = this.dryFade, on = this.on;
    for (let i = 0; i < n; i++) {
      const g = on ? 1 : fade.cur;
      outL[i] = inL[i] * g;
      outR[i] = inR[i] * g;
      fade.tick();
    }
    if (this.g.length < n) this.g = new Float32Array(n);
    const g = this.g, vol = this.vol;
    for (let i = 0; i < n; i++) {
      g[i] = vol.cur;
      vol.tick();
    }
    const voices = this.voices;
    for (let v = voices.length - 1; v >= 0; v--) {
      const s = voices[v], { l, r, rate } = s, last = l.length - 1;
      let p = s.pos;
      for (let i = 0; i < n; i++, p += rate) {
        if (p < 0) continue; // starts later in this block
        const i0 = p | 0;
        if (i0 >= last) break;
        const t = p - i0;
        outL[i] += (l[i0] + (l[i0 + 1] - l[i0]) * t) * g[i];
        outR[i] += (r[i0] + (r[i0 + 1] - r[i0]) * t) * g[i];
      }
      s.pos = p;
      if (p >= last) voices.splice(v, 1);
    }
  }
}

/** What the Beat FX section (dsp.js BeatManager) hosts. */
export const Core = DrumCore;
