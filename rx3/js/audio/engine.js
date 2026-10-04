// The audio side: two decks, the RX3's mixer path, one Beat FX section and a Sound Color FX section per channel.
//
//   deck -> trim -> [0] -> EQ (low/mid/high) -> [1] -> channel fader -> [2] -> FILTER -> crossfader -> master bus -> [M] -> out
//
// As in the firmware (MixerChannel::updateFilter), each effect has a fixed position in the channel: [0] before the
// EQ, [1] before the fader, [2] after it. At a position the Color FX runs first, then the Beat FX if it is on that
// channel. The Beat FX section is a single instance that runs in place wherever it is routed (so its tail survives
// channel changes); routed to MASTER, it runs on the master bus [M], after both channels' Color FX. FILTER is a second
// copy of the Color FX FILTER per channel, for the phone panel's FILTER X-PAD; at centre it passes the signal untouched.
import beatFx from '../fx/beat/index.js';
import colorFx from '../fx/color/index.js';
import { beatEffectMs } from '../fx/dsp.js';
export { pitchLabel } from '../fx/beat/drum.js';

export const SAMPLE_RATE = 44100; // the firmware's rate: the ported effects' tables are tuned for it
export const BEAT_FX = beatFx.map((m) => m.meta);
export const COLOR_FX = colorFx.map((m) => m.meta);
export const FX_CHANNELS = ['CH1', 'CH2', 'MASTER'];

const db = (x) => Math.pow(10, x / 20);
const RAMP = 0.005; // s, for gain changes that would otherwise click

class Channel {
  constructor(ctx, node, channel) {
    this.trim = new GainNode(ctx);
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 220 });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7 });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3000 });
    const fx = (kind) =>
      new AudioWorkletNode(ctx, 'rx3-fx', { outputChannelCount: [2], processorOptions: { kind, channel } });
    this.pre = fx('pre'); // position 0
    this.color = fx('post'); // position 1, the channel fader, position 2; takes the Color FX messages
    this.filter = fx('filter');
    this.xfade = new GainNode(ctx);
    node.connect(this.trim).connect(this.pre).connect(this.low).connect(this.mid).connect(this.high)
      .connect(this.color).connect(this.filter).connect(this.xfade);
  }
}

export class Engine {
  static async create() {
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(new URL('./worklet.js', import.meta.url));
    return new Engine(ctx);
  }

  constructor(ctx) {
    this.ctx = ctx;
    this.master = new GainNode(ctx, { gain: 0.8 });
    this.bus = new GainNode(ctx);
    // the master bus's Beat FX position; its port takes the Beat FX messages
    this.beat =
      new AudioWorkletNode(ctx, 'rx3-fx', { outputChannelCount: [2], processorOptions: { kind: 'master' } });
    this.meter = new AnalyserNode(ctx, { fftSize: 1024 });
    this.decks = [0, 1].map((index) =>
      new AudioWorkletNode(ctx, 'rx3-deck', { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { index } }));
    this.channels = this.decks.map((d, i) => new Channel(ctx, d, i));
    for (const ch of this.channels) ch.xfade.connect(this.bus);
    this.bus.connect(this.beat).connect(this.master);
    this.master.connect(this.meter);
    this.master.connect(ctx.destination);

    this.fx = { name: null, channel: 'CH1', on: false, level: 0.5, pitch: 0.5, volume: 1, beat: null, xpad: null,
      beats: {}, bands: [true, true, true] };
    this.color = { name: null, amount: [0, 0], parameter: 0.5 };
    this.xfader = 0;
    this.faders = [1, 1];
    if (BEAT_FX.length) this.selectBeatFx(BEAT_FX[0].name);
    this.routeBeatFx('CH1');
    this.setLevel(this.fx.level); // the worklet's manager starts at 0; give it the knob's position
    this.setCrossfader(0);
    this.loadSamples();
  }

  /** The Beat FX that play samples (DRUM): fetch and decode them here, and hand them to the worklet. */
  loadSamples() {
    for (const m of BEAT_FX.filter((x) => x.samples)) {
      Promise.all(m.samples.map((file) =>
        fetch(new URL('../../drum/' + file, import.meta.url))
          .then((r) => r.arrayBuffer())
          .then((b) => this.ctx.decodeAudioData(b))
          .then((a) => ({ l: a.getChannelData(0), r: a.getChannelData(a.numberOfChannels > 1 ? 1 : 0) }))
          .catch(() => null))) // a missing sample just leaves its slot silent
        .then((value) => this.beat.port.postMessage({ type: 'data', name: m.name, value }));
    }
  }

  resume() {
    return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume();
  }

  ramp(param, value) {
    param.setTargetAtTime(value, this.ctx.currentTime, RAMP / 3);
  }

  // ---- mixer

  setTrim(ch, x) { // -1..1 -> -inf..+9 dB, like the TRIM knob
    this.ramp(this.channels[ch].trim.gain, x <= -1 ? 0 : db(x < 0 ? x * 30 : x * 9));
  }

  setEq(ch, band, x) { // -1..1 -> -26..+6 dB (the RX3's EQ range), centre = 0 dB
    this.ramp(this.channels[ch][band].gain, x < 0 ? x * 26 : x * 6);
  }

  setFader(ch, x) { // 0..1, a slightly logarithmic curve
    this.faders[ch] = x;
    this.channels[ch].color.port.postMessage({ type: 'param', name: 'fader', value: x <= 0 ? 0 : Math.pow(x, 1.6) });
  }

  setCrossfader(x) { // -1 (deck 1) .. 1 (deck 2), constant power with a flat middle
    this.xfader = x;
    const a = Math.min(1, Math.cos(((x + 1) / 2) * Math.PI / 2) * Math.SQRT2);
    const b = Math.min(1, Math.sin(((x + 1) / 2) * Math.PI / 2) * Math.SQRT2);
    this.ramp(this.channels[0].xfade.gain, a);
    this.ramp(this.channels[1].xfade.gain, b);
  }

  setMaster(x) {
    this.ramp(this.master.gain, x);
  }

  /** Master output level, 0..1 peak over the last analyser window. */
  peak() {
    const buf = this.peakBuf || (this.peakBuf = new Float32Array(this.meter.fftSize));
    this.meter.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
    return p;
  }

  // ---- Beat FX

  beatMeta(name = this.fx.name) {
    return BEAT_FX.find((m) => m.name === name);
  }

  /** BEAT FX SELECT. Each effect keeps its own beat (as the unit's effects do); while on, it crossfades over. */
  selectBeatFx(name) {
    const m = this.beatMeta(name);
    if (!m) return;
    this.fx.name = name;
    this.beat.port.postMessage({ type: 'select', name });
    this.fx.beat = this.fx.beats[name] ?? m.beats[m.defaultBeat].value;
    this.fx.xpad = m.xpad?.kind === 'strip' ? m.xpad.centre : null;
    if (m.pitch) this.setPitch(0.5);
  }

  setBeat(value) {
    this.fx.beat = value;
    this.fx.beats[this.fx.name] = value;
    this.beat.port.postMessage({ type: 'param', name: 'beat', value });
  }

  /** The time the effect runs at for the selected beat (the firmware's own rounding), or null without a BPM. */
  beatMs(bpm) {
    return bpm ? beatEffectMs(bpm, this.fx.beat) : null;
  }

  /** BEAT left / right: step through the effect's beat (or percent) values. */
  stepBeat(dir) {
    const vals = this.beatMeta().beats.map((b) => b.value);
    let i = 0;
    vals.forEach((v, k) => { if (Math.abs(v - this.fx.beat) < Math.abs(vals[i] - this.fx.beat)) i = k; });
    this.setBeat(vals[Math.max(0, Math.min(vals.length - 1, i + dir))]);
  }

  setLevel(x) {
    this.fx.level = x;
    this.beat.port.postMessage({ type: 'param', name: 'level', value: x });
  }

  /** PITCH, for the effects that have one (DRUM): 0..1, centre = as recorded. */
  setPitch(x) {
    this.fx.pitch = x;
    this.beat.port.postMessage({ type: 'param', name: 'pitch', value: x });
  }

  /** Beat FX VOLUME (the phone panel's; not on the unit): 0..1 of the effect's change to the signal, 1 = as is. */
  setBeatVolume(x) {
    this.fx.volume = x;
    this.beat.port.postMessage({ type: 'param', name: 'volume', value: x });
  }

  setXpad(v) {
    this.fx.xpad = v;
    this.beat.port.postMessage({ type: 'param', name: 'xpad', value: v });
  }

  setBpm(bpm) {
    this.beat.port.postMessage({ type: 'param', name: 'bpm', value: bpm });
  }

  /** The beat grid of the deck the Beat FX follows (DRUM locks to it): its track's own BPM and first beat. */
  setGrid(deck, firstBeat, bpm) {
    this.beat.port.postMessage({ type: 'grid', deck, firstBeat, bpm });
  }

  /** Beat FX frequency band (0 LOW, 1 MID, 2 HI) on or off: a band that is off skips the effect, dry. */
  setBand(band, on) {
    this.fx.bands[band] = on;
    this.beat.port.postMessage({ type: 'band', band, value: on });
  }

  setBeatFxOn(on) {
    this.fx.on = on;
    this.beat.port.postMessage({ type: 'on', value: on });
  }

  /** BEAT FX CH SELECT: CH1, CH2 or MASTER. The section moves there, tail and all. */
  routeBeatFx(channel) {
    this.fx.channel = channel;
    this.beat.port.postMessage({ type: 'route', value: channel });
  }

  // ---- Sound Color FX (one type for both channels, a COLOR knob each, one PARAMETER knob)

  selectColorFx(name) {
    this.color.name = name;
    for (const ch of this.channels) ch.color.port.postMessage({ type: 'select', name });
  }

  setColor(ch, x) { // -1..1, 0 = centre
    this.color.amount[ch] = x;
    this.channels[ch].color.port.postMessage({ type: 'param', name: 'color', value: x });
  }

  /** The channel's own FILTER (the phone's FILTER X-PAD): -1 low-pass .. 0 off .. 1 high-pass. */
  setFilter(ch, x) {
    this.channels[ch].filter.port.postMessage({ value: x });
  }

  setColorParameter(x) { // 0..1, 0.5 = centre
    this.color.parameter = x;
    for (const ch of this.channels) ch.color.port.postMessage({ type: 'param', name: 'parameter', value: x });
  }
}
