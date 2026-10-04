// AudioWorklet processors: the deck player and the effect hosts. Loaded with audioWorklet.addModule().
import beatFx from '../fx/beat/index.js';
import colorFx from '../fx/color/index.js';
import { BandSplit } from '../fx/bands.js';
import { BeatManager, ColorManager, beatIndex } from '../fx/dsp.js';

const SILENCE = new Float32Array(128);
const players = []; // the DeckProcessors by deck index, for the Beat FX section's beat clock

/** Plays one track: variable rate (tempo, nudge), play/pause, seek. Reports its position ~30 times a second. */
class DeckProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    players[options.processorOptions?.index ?? players.length] = this;
    this.l = this.r = null;
    this.len = 0;
    this.pos = 0; // in source frames, fractional
    this.rate = 1; // tempo * nudge
    this.srcRate = sampleRate; // the track's own sample rate
    this.playing = false;
    this.report = 0;
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    if (m.type === 'load') {
      this.l = m.l;
      this.r = m.r || m.l;
      this.len = this.l.length;
      this.srcRate = m.sampleRate;
      this.pos = 0;
      this.playing = false;
    } else if (m.type === 'unload') {
      this.l = this.r = null;
      this.len = 0;
      this.playing = false;
    } else if (m.type === 'play') {
      this.playing = m.value && this.len > 0;
    } else if (m.type === 'seek') {
      this.pos = Math.max(0, Math.min(this.len - 1, m.seconds * this.srcRate));
    } else if (m.type === 'rate') {
      this.rate = m.value;
    }
    this.send();
  }

  send() {
    this.port.postMessage({ pos: this.pos / this.srcRate, playing: this.playing });
  }

  process(_inputs, outputs) {
    const [oL, oR] = outputs[0];
    if (!this.playing || !this.l) {
      oL.fill(0);
      oR.fill(0);
    } else {
      const step = this.rate * this.srcRate / sampleRate, { l, r, len } = this;
      let p = this.pos;
      for (let i = 0; i < oL.length; i++) {
        const i0 = p | 0;
        if (i0 + 1 >= len) {
          oL.fill(0, i);
          oR.fill(0, i);
          this.playing = false;
          p = len - 1;
          break;
        }
        const f = p - i0;
        oL[i] = l[i0] + (l[i0 + 1] - l[i0]) * f;
        oR[i] = r[i0] + (r[i0 + 1] - r[i0]) * f;
        p += step;
      }
      this.pos = p;
    }
    if (++this.report >= 12) { // 12 x 128 frames at 44.1 kHz = ~29 reports a second
      this.report = 0;
      this.send();
    }
    return true;
  }
}

/**
 * The Beat FX section: the firmware's BeatEffectManager (fx/dsp.js) with every Beat FX in it. The page selects an
 * effect, turns it on and off, routes it, and sends level / beat / bpm / xpad. Like the unit's, it is one instance
 * that runs in place on whichever signal is selected: inside that channel's strip, at the current effect's position
 * (MixerChannel::updateFilter), or on the master bus (MasterOutChannel::update). It runs at most once per 64-sample
 * block, the first time it is asked (the firmware's "operated this block" flag, 0xef). A section that is off and
 * silent stops running its effects (its output is then exactly its input) until the next message.
 */
class BeatSection {
  constructor() {
    this.metas = new Map(beatFx.map((m) => [m.meta.name, m.meta]));
    this.m = new BeatManager(sampleRate, beatFx.map((m) => ({ name: m.meta.name, core: new m.Core(sampleRate) })));
    this.route = 'CH1';
    this.idle = true;
    this.quiet = 0;
    this.done = -1; // the block it last ran in
    // the beat grid of the deck the effects follow ({ deck, firstBeat, bpm }), and where it is each block, for the
    // effects that read it (DRUM)
    this.grid = null;
    this.clock = { playing: false, beat: 0, perSample: 0 };
    for (const core of this.m.cores.values()) core.clock = this.clock;
    this.bands = new BandSplit(sampleRate); // LOW / MID / HI: the bands switched off go around the effect
    this.volume = 1; // VOLUME: how much of the effect's change to the signal gets through (1 = all, as on the unit)
    this.sL = new Float32Array(64);
    this.sR = new Float32Array(64);
  }

  message(m) {
    if (m.type === 'route') {
      this.route = m.value;
      return;
    }
    if (m.type === 'grid') {
      this.grid = m;
      return;
    }
    if (m.type === 'data') { // an effect's assets, decoded on the page (DRUM's samples)
      this.m.cores.get(m.name)?.setData?.(m.value);
      return;
    }
    const s = this.m;
    this.idle = false;
    this.quiet = 0;
    if (m.type === 'band') this.bands.set(m.band, m.value);
    else if (m.type === 'select') s.select(m.name);
    else if (m.type === 'on') s.setOn(m.value);
    else if (m.type === 'param') {
      const v = m.value;
      if (m.name === 'level') s.setLevel(v);
      else if (m.name === 'volume') this.volume = v;
      else if (m.name === 'bpm') { // the BPM manager reports 120 (DEFAULT_BPM) without one, and only changes notify
        const bpm = v > 0 ? v : 120;
        if (Math.round(bpm * 100) !== s.bpm100) s.setBpm(bpm);
      }
      else if (m.name === 'xpad') s.setXpad(v);
      else if (m.name === 'pitch') for (const core of s.cores.values()) core.setPitch?.(v); // DRUM's own control
      else if (m.name === 'beat') {
        const meta = this.metas.get(s.selected);
        if (meta?.unit === '%') s.setPercent(v);
        else if (s.cur === s.off && s.prev !== s.cores.get(s.selected)) {
          // OFF, and the selected effect is not the one the manager remembers: set it directly, so that it
          // starts on the beat the panel shows (on the unit the BEAT would go to the remembered effect)
          s.cores.get(s.selected).setBeatButton(beatIndex(v), true, s.bpm100);
        } else s.setBeatButton(beatIndex(v));
      }
    }
  }

  /** Run on one 64-sample block of `route` in place, if the current effect sits at `position` (null: anywhere). */
  operate(route, position, L, R, block) {
    if (route !== this.route || this.done === block || this.idle) return;
    const s = this.m;
    if (position !== null && s.cur.position !== position) return;
    this.done = block;
    this.tick(block);
    const n = L.length, { sL, sR } = this;
    sL.set(L);
    sR.set(R);
    const split = this.bands.remove(sL, sR);
    s.process(sL, sR, L, R, n);
    if (split) {
      this.bands.restore(L, R);
      this.bands.restore(sL, sR); // the block as it came in, for the silence check
    }
    if (s.cur === s.off ? s.state === 0 : s.state === 3 && s.B.done) {
      let d = 0;
      for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(L[i] - sL[i]), Math.abs(R[i] - sR[i]));
      this.quiet = d < 1e-6 ? this.quiet + n : 0;
      if (this.quiet > sampleRate / 2) this.idle = true;
    } else this.quiet = 0;
    const g = this.volume;
    if (g !== 1) {
      for (let i = 0; i < n; i++) {
        L[i] = sL[i] + (L[i] - sL[i]) * g;
        R[i] = sR[i] + (R[i] - sR[i]) * g;
      }
    }
  }

  /** The followed deck's beat position at this block's first frame. The deck has already rendered this quantum. */
  tick(block) {
    const g = this.grid, p = g && players[g.deck], c = this.clock;
    c.playing = !!(p?.playing && g.bpm > 0);
    if (!c.playing) return;
    const bps = g.bpm / 60, ahead = currentFrame + 128 - block; // frames from here to the end of the quantum
    c.perSample = (p.rate * bps) / sampleRate;
    c.beat = (p.pos / p.srcRate - g.firstBeat) * bps - ahead * c.perSample;
  }
}

/**
 * One channel's Sound Color FX and channel fader: the firmware's SoundColorFxManager (fx/dsp.js) with every Color FX
 * in it. COLOR arrives as -1..1 (0 = centre), PARAMETER as 0..1.
 */
class ColorSection {
  constructor() {
    const cores = [];
    for (const m of colorFx) cores[m.meta.type - 1] = new m.Core(sampleRate);
    this.types = new Map(colorFx.map((m) => [m.meta.name, m.meta.type]));
    this.m = new ColorManager(sampleRate, cores);
    this.gain = this.target = 1;
    this.position = [1, 1]; // the effect's position, read at the start of each block of the quantum
    this.sL = new Float32Array(64);
    this.sR = new Float32Array(64);
  }

  message(m) {
    if (m.type === 'select') this.m.setType(this.types.get(m.name) || 0);
    else if (m.type === 'param') {
      if (m.name === 'color') this.m.setColor((m.value + 1) / 2);
      else if (m.name === 'parameter') this.m.setParameter(m.value);
      else if (m.name === 'fader') this.target = m.value;
    }
  }

  /** The Color FX on a block in place. */
  operate(L, R) {
    const { sL, sR } = this;
    sL.set(L);
    sR.set(R);
    this.m.process(sL, sR, L, R, L.length);
  }

  /** The fader over a block in place, ramped to its target. */
  fade(L, R) {
    const n = L.length, g0 = this.gain, step = (this.target - g0) / n;
    for (let i = 0; i < n; i++) {
      const g = g0 + step * (i + 1);
      L[i] *= g;
      R[i] *= g;
    }
    this.gain = this.target;
  }
}

// Shared by every processor (one AudioWorkletGlobalScope per context), as the firmware's channels share the
// BeatEffectManager: the Beat FX section and each channel's Color FX section.
let beat = null;
const colors = [];
const beatSection = () => beat || (beat = new BeatSection());
const colorSection = (ch) => colors[ch] || (colors[ch] = new ColorSection());

/**
 * The effect hosts, in place on 64-sample blocks. processorOptions.kind:
 *   'pre'    a channel strip before its EQ: position 0 (NOISE, SWEEP; ROLL, HELIX, ...)
 *   'post'   the strip after its EQ: position 1, the channel fader, position 2 (DUB ECHO, SPACE; REVERB, ECHO, ...)
 *   'master' the master bus: the Beat FX when MASTER is selected; its port takes the Beat FX messages
 *   'filter' a channel's own FILTER after the strip (the phone's FILTER X-PAD), apart from its Color FX
 * At each position the Color FX runs first, then the Beat FX, as in MixerChannel::updateFilter.
 */
class FxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { kind, channel } = options.processorOptions;
    this.kind = kind;
    if (kind === 'filter') { // the phone's FILTER X-PAD: its own FILTER, after the channel's Color FX
      this.filter = new (colorFx.find((m) => m.meta.name === 'FILTER').Core)(sampleRate);
      this.sL = new Float32Array(64);
      this.sR = new Float32Array(64);
      this.port.onmessage = (e) => this.filter.setColor((e.data.value + 1) / 2);
      return;
    }
    this.beat = beatSection();
    if (kind === 'master') {
      this.route = 'MASTER';
      this.port.onmessage = (e) => this.beat.message(e.data);
    } else {
      this.route = 'CH' + (channel + 1);
      this.color = colorSection(channel);
      if (kind === 'post') this.port.onmessage = (e) => this.color.message(e.data);
    }
  }

  block(L, R, k, at) {
    const { beat, color, route } = this;
    if (this.kind === 'filter') {
      const { sL, sR } = this;
      sL.set(L);
      sR.set(R);
      this.filter.execute(sL, sR, L, R, L.length);
    } else if (this.kind === 'master') {
      beat.operate(route, null, L, R, at);
    } else if (this.kind === 'pre') {
      const pos = color.position[k] = color.m.cfx.position;
      if (pos === 0) color.operate(L, R);
      beat.operate(route, 0, L, R, at);
    } else {
      const pos = color.position[k];
      if (pos === 1) color.operate(L, R);
      beat.operate(route, 1, L, R, at);
      color.fade(L, R);
      if (pos === 2) color.operate(L, R);
      beat.operate(route, 2, L, R, at);
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0], [oL, oR] = outputs[0], n = oL.length;
    oL.set(inp[0] || SILENCE.subarray(0, n));
    oR.set(inp[1] || inp[0] || SILENCE.subarray(0, n));
    for (let o = 0, k = 0; o < n; o += 64, k++) {
      const m = Math.min(64, n - o);
      this.block(oL.subarray(o, o + m), oR.subarray(o, o + m), k, currentFrame + o);
    }
    return true;
  }
}

registerProcessor('rx3-deck', DeckProcessor);
registerProcessor('rx3-fx', FxProcessor);
