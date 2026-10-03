// The audio side: two decks, the RX3's mixer path, one Beat FX slot and a Sound Color FX slot per channel.
//
//   deck -> trim -> EQ (low/mid/high) -> COLOR FX -> channel fader -> crossfader -+-> master bus -> master -> out
//                                                                    (CH1/CH2) -+-> BEAT FX -----^
//                                                                 master bus (MASTER) -> BEAT FX -^
// The Beat FX slot is a single instance (its tail survives channel changes), fed by whichever send is open.
import beatFx from '../fx/beat/index.js';
import colorFx from '../fx/color/index.js';

export const SAMPLE_RATE = 44100; // the firmware's rate: the ported effects' tables are tuned for it
export const BEAT_FX = beatFx.map((m) => m.meta);
export const COLOR_FX = colorFx.map((m) => m.meta);
export const FX_CHANNELS = ['CH1', 'CH2', 'MASTER'];

const db = (x) => Math.pow(10, x / 20);
const RAMP = 0.005; // s, for gain changes that would otherwise click

class Channel {
  constructor(ctx, node) {
    this.trim = new GainNode(ctx);
    this.low = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 220 });
    this.mid = new BiquadFilterNode(ctx, { type: 'peaking', frequency: 1000, Q: 0.7 });
    this.high = new BiquadFilterNode(ctx, { type: 'highshelf', frequency: 3000 });
    this.color = new AudioWorkletNode(ctx, 'rx3-fx', { outputChannelCount: [2], processorOptions: { kind: 'color' } });
    this.fader = new GainNode(ctx);
    this.xfade = new GainNode(ctx);
    this.dry = new GainNode(ctx); // to the master bus
    this.send = new GainNode(ctx, { gain: 0 }); // to the Beat FX
    node.connect(this.trim).connect(this.low).connect(this.mid).connect(this.high).connect(this.color)
      .connect(this.fader).connect(this.xfade);
    this.xfade.connect(this.dry);
    this.xfade.connect(this.send);
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
    this.busDry = new GainNode(ctx);
    this.busSend = new GainNode(ctx, { gain: 0 });
    this.beat = new AudioWorkletNode(ctx, 'rx3-fx', { outputChannelCount: [2], processorOptions: { kind: 'beat' } });
    this.meter = new AnalyserNode(ctx, { fftSize: 1024 });
    this.decks = [0, 1].map(() => new AudioWorkletNode(ctx, 'rx3-deck', { numberOfInputs: 0, outputChannelCount: [2] }));
    this.channels = this.decks.map((d) => new Channel(ctx, d));
    for (const ch of this.channels) {
      ch.dry.connect(this.bus);
      ch.send.connect(this.beat);
    }
    this.bus.connect(this.busDry).connect(this.master);
    this.bus.connect(this.busSend).connect(this.beat);
    this.beat.connect(this.master);
    this.master.connect(this.meter);
    this.master.connect(ctx.destination);

    this.fx = { name: null, channel: 'CH1', on: false, level: 0.5, beat: null, xpad: null };
    this.color = { name: null, amount: [0, 0] };
    this.xfader = 0;
    if (BEAT_FX.length) this.selectBeatFx(BEAT_FX[0].name);
    this.routeBeatFx('CH1');
    this.setCrossfader(0);
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
    this.ramp(this.channels[ch].fader.gain, x <= 0 ? 0 : Math.pow(x, 1.6));
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

  selectBeatFx(name) {
    const m = this.beatMeta(name);
    if (!m) return;
    this.fx.name = name;
    this.beat.port.postMessage({ type: 'select', name });
    this.setBeat(m.beats[m.defaultBeat].value);
    this.setLevel(this.fx.level);
    if (m.xpad?.kind === 'strip') this.setXpad(m.xpad.centre);
  }

  setBeat(value) {
    this.fx.beat = value;
    this.beat.port.postMessage({ type: 'param', name: 'beat', value });
  }

  /** BEAT ◀ / ▶: step through the effect's beat (or percent) values. */
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

  setXpad(v) {
    this.fx.xpad = v;
    this.beat.port.postMessage({ type: 'param', name: 'xpad', value: v });
  }

  setBpm(bpm) {
    this.beat.port.postMessage({ type: 'param', name: 'bpm', value: bpm });
  }

  setBeatFxOn(on) {
    this.fx.on = on;
    this.beat.port.postMessage({ type: 'on', value: on });
  }

  routeBeatFx(channel) {
    this.fx.channel = channel;
    this.channels.forEach((ch, i) => {
      const sel = channel === 'CH' + (i + 1);
      this.ramp(ch.dry.gain, sel ? 0 : 1);
      this.ramp(ch.send.gain, sel ? 1 : 0);
    });
    const master = channel === 'MASTER';
    this.ramp(this.busDry.gain, master ? 0 : 1);
    this.ramp(this.busSend.gain, master ? 1 : 0);
  }

  // ---- Sound Color FX (one type for both channels, a COLOR knob each)

  selectColorFx(name) {
    this.color.name = name;
    for (const ch of this.channels) ch.color.port.postMessage({ type: 'select', name });
  }

  setColor(ch, x) {
    this.color.amount[ch] = x;
    this.channels[ch].color.port.postMessage({ type: 'param', name: 'color', value: x });
  }
}
