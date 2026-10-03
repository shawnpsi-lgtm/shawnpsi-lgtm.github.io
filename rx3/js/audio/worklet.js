// AudioWorklet processors: the deck player and the effect hosts. Loaded with audioWorklet.addModule().
import beatFx from '../fx/beat/index.js';
import colorFx from '../fx/color/index.js';

const FX = { beat: beatFx, color: colorFx };
const SILENCE = new Float32Array(128);

/** Plays one track: variable rate (tempo, nudge), play/pause, seek. Reports its position ~30 times a second. */
class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
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
 * Hosts one Beat FX or Sound Color FX slot (processorOptions.kind). The page selects an effect by name and sends
 * params; switching effects keeps the old one's settings out of the new one by building a fresh instance.
 */
class FxProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.list = FX[options.processorOptions.kind];
    this.fx = null;
    this.on = false;
    this.params = {};
    this.port.onmessage = (e) => this.message(e.data);
  }

  message(m) {
    if (m.type === 'select') {
      const mod = this.list.find((x) => x.meta.name === m.name);
      this.fx = mod ? new mod.Effect(sampleRate) : null;
      if (this.fx) {
        for (const k in this.params) this.fx.set(k, this.params[k]);
        this.fx.setOn?.(this.on);
      }
    } else if (m.type === 'param') {
      this.params[m.name] = m.value;
      this.fx?.set(m.name, m.value);
    } else if (m.type === 'on') {
      this.on = m.value;
      this.fx?.setOn?.(m.value);
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0], [oL, oR] = outputs[0];
    const iL = inp[0] || SILENCE, iR = inp[1] || iL;
    if (this.fx) this.fx.process(iL, iR, oL, oR, oL.length);
    else {
      oL.set(iL);
      oR.set(iR);
    }
    return true;
  }
}

registerProcessor('rx3-deck', DeckProcessor);
registerProcessor('rx3-fx', FxProcessor);
