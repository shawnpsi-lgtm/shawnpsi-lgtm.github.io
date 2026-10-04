/**
 * Building blocks shared by the effects ported from the XDJ-RX3 player. Everything rounds to float32 at the
 * same points as the firmware's NEON code (Math.fround after every operation), so the ports null against it.
 */
export const f = Math.fround;

/** A float32 constant from its bit pattern, as it sits in the firmware's literal pools. */
export const hex = (bits) => new Float32Array(new Uint32Array([bits]).buffer)[0];

/**
 * The player's 40-byte parameter smoother: {step, target, cur} (both lanes equal), count, len, 1/len, done.
 * Read `cur`, then tick(): the value moves by `step` each sample and lands on `target` after len + 1 samples.
 */
export class Ramp {
  constructor(len, cur = 0) {
    this.len = len || 1;
    this.inv = f(1 / this.len);
    this.cur = this.target = f(cur);
    this.step = 0;
    this.count = 0;
    this.done = true;
  }

  /** The firmware's retarget: the step is computed from where the value will be after the next tick. */
  retarget(t) {
    this.step = f(f(t - f(this.cur + this.step)) * this.inv);
    this.target = t;
    this.count = 0;
    this.done = false;
  }

  /** Start a fresh ramp from `from` to `to`. */
  start(from, to) {
    this.step = f(f(to - from) * this.inv);
    this.cur = from;
    this.target = to;
    this.count = 0;
    this.done = false;
  }

  /** Stand still at v (done stays false, as the firmware leaves it: the next ticks land on v). */
  hold(v) {
    this.step = 0;
    this.cur = this.target = v;
    this.count = 0;
    this.done = false;
  }

  tick() {
    if (!this.done) {
      this.cur = f(this.cur + this.step);
      if (this.count >= this.len) {
        this.cur = this.target;
        this.done = true;
      }
      this.count++;
    }
  }
}

/** Samples in `ms` at `sr`, as the constructors compute a smoother length: (int)(sr * ms / 1000). */
export const msLen = (sr, ms) => Math.trunc(f(f(f(sr) * f(ms)) / 1000));

/** Beat button factors (BeatEffect::BEAT_BUTTON_FACTOR) and their labels. */
export const BEAT_FACTOR = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16, 32, 64];
export const BEAT_LABEL = ['1/16', '1/8', '1/4', '1/2', '3/4', '1', '2', '4', '8', '16', '32', '64'];

/** `beats` for a Beat FX's meta: the buttons first..last, valued by their index into BEAT_FACTOR. */
export const beatButtons = (first, last) =>
  BEAT_LABEL.slice(first, last + 1).map((label, k) => ({ label, value: BEAT_FACTOR[first + k] }));

/** The beat button for a beats[] value (its factor). */
export const beatIndex = (v) => BEAT_FACTOR.indexOf(v);

/** The time the firmware sets for a beat factor at a BPM (checkBeatButtonRange, without the range check). */
export const beatEffectMs = (bpm, factor) => {
  const b = Math.round(bpm * 100);
  const beat = f(b > 3999 ? Math.floor(600000 / Math.floor((b + 5) / 10)) : 1500);
  return Math.trunc(f(f(beat * f(factor)) + 0.5));
};

/** The BPM manager reports no BPM as this. */
export const NO_BPM = 0xffffffff;

/**
 * mixerengine::BeatEffect, the base of every Beat FX: the parameters the manager sets and how they arrive.
 * Subclasses override the hooks (changeLevelDepth, changeTime, changePercent, statusOn, statusOff, initialize,
 * notifySelected, keepEffectInit, setXpad) and execute(inL, inR, outL, outR, n).
 */
export class BeatCore {
  constructor({ ms = 500, minMs = 1, maxMs = 4000, button = 5, minButton = 0, maxButton = 11, tail = false,
    position = 1 }) {
    this.position = position; // +0x40: where it runs in the channel, 0 (before the EQ), 1 or 2 (after the fader)
    this.on = false; // +0x3c
    this.level = 0; // +0x20
    this.ms = ms; // +0x24, with its range +0x2c..+0x28
    this.minMs = minMs;
    this.maxMs = maxMs;
    this.percent = 50;
    this.minPercent = -100;
    this.maxPercent = 100;
    this.button = button; // +0x44, with its range +0x4c..+0x48
    this.minButton = minButton;
    this.maxButton = maxButton;
    this.tail = tail; // +0x50: OFF lets it ring out instead of switching it off
    this.pressed = false; // +0x51: the BEAT button was pressed this block
  }

  // BeatEffect::adjustParameter
  setLevel(x) {
    this.level = x >= 0 ? (x > 1 ? 1 : f(x)) : 0;
    this.changeLevelDepth();
  }

  setTime(v) {
    const u = v > 0 ? Math.trunc(v) : 0;
    this.ms = u < this.minMs ? this.minMs : u > this.maxMs ? this.maxMs : u;
    this.changeTime();
  }

  setPercent(p) {
    const i = Math.trunc(p);
    this.percent = i < this.minPercent ? this.minPercent : i > this.maxPercent ? this.maxPercent : i;
    this.changePercent();
  }

  // BeatEffect::changeEffectStatus
  toggle() {
    if (!this.on) {
      this.statusOn();
      this.on = true;
    } else {
      this.statusOff();
      this.on = false;
    }
  }

  /** BeatEffect::checkBeatButtonRange: button i's time at the BPM (hundredths), stepped into [minMs, maxMs]. */
  setBeatButton(i, apply, bpm100) {
    if (i > 11 || bpm100 === NO_BPM) return;
    const beat = bpm100 > 3999 ? f(Math.floor(600000 / Math.floor((bpm100 + 5) / 10))) : 1500;
    for (;;) {
      let t;
      while ((t = Math.trunc(f(f(beat * f(BEAT_FACTOR[i])) + 0.5))) < this.minMs) if (++i === 12) return;
      if (t <= this.maxMs) {
        if (apply) this.ms = t;
        this.button = i;
        this.changeTime();
        return;
      }
      if (i-- === 0) return;
    }
  }

  changeLevelDepth() {}
  changeTime() {}
  changePercent() {}
  statusOn() {}
  statusOff() {}
  initialize() {}
  notifySelected() {}
  keepEffectInit() {}
  setXpad() {}
}

/** BeatEffectOff: what the manager runs while Beat FX is off. */
class OffCore extends BeatCore {
  constructor() {
    super({ maxMs: 64000 });
  }

  execute(inL, inR, outL, outR, n) {
    outL.set(inL.subarray(0, n));
    outR.set(inR.subarray(0, n));
  }
}

const TAIL_TYPES = new Set(['REVERB', 'ECHO', 'DELAY', 'SPIRAL']); // switchNextBeatEffect's 0xe2 mask
const LEVEL_EPS = f(1.1920929e-7);

/**
 * mixerengine::BeatEffectManager: the Beat FX section, owning one instance of every effect, driven the way the
 * RX3's UI drives it. ON selects the chosen effect (setBeatEffectType), OFF selects BeatEffectOff, choosing another
 * effect while on selects that. Every change crossfades (4.35 ms) out of the current effect and into the next,
 * except turning off an effect with a tail (REVERB, ECHO, ...): that effect is switched off but kept running, so it
 * rings out, while the manager brings the dry signal back; turning it on again picks it up as it is. Params: level
 * (LEVEL/DEPTH), beat (a button index, applied next block, as a press), percent, bpm (re-times the effect), xpad.
 */
export class BeatManager {
  /** effects: [{ name, core }] in menu order. */
  constructor(sampleRate, effects) {
    const len = msLen(sampleRate, 4.3514738);
    this.cores = new Map(effects.map((e) => [e.name, e.core]));
    this.names = new Map(effects.map((e) => [e.core, e.name]));
    this.off = new OffCore();
    this.off.on = true;
    this.names.set(this.off, 'OFF');
    this.cur = this.off;
    this.want = this.off;
    this.prev = null; // +0x0c while OFF: the effect a switch to OFF left behind
    this.selected = effects[0]?.name;
    this.on = false;
    this.A = new Ramp(len, 1); // crossfade between effects (on the effect's output)
    this.B = new Ramp(len); // dry mixed in by the manager
    this.C = new Ramp(msLen(sampleRate, 1499.1383));
    this.state = 0;
    this.level = 0;
    this.e0 = this.e4 = 5;
    this.bpm100 = 12000;
    this.tL = new Float32Array(64);
    this.tR = new Float32Array(64);
  }

  // ---- the UI's calls (DjEngineIF -> MixerEngine -> BeatEffectManager)

  select(name) {
    if (!this.cores.has(name)) return;
    this.selected = name;
    if (this.on) this.want = this.cores.get(name);
  }

  setOn(on) {
    this.on = on;
    this.want = on ? this.cores.get(this.selected) : this.off;
  }

  setLevel(x) {
    this.level = f(x);
  }

  setBeatButton(i) {
    this.e4 = i;
    this.cur.pressed = true;
  }

  setBpm(bpm) {
    this.bpm100 = Math.round(bpm * 100);
    this.switchNextBeatButton(true);
  }

  setXpad(v) {
    this.cur.setXpad(v);
    this.other()?.setXpad(v);
  }

  setPercent(p) {
    this.cur.setPercent(p);
    this.other()?.setPercent(p);
  }

  /** +0x0c: the manager applies parameter changes to the current effect and this one. */
  other() {
    return this.cur === this.off ? this.prev : this.off;
  }

  // ---- BeatEffectManager

  switchNextBeatButton(apply) {
    const fx = this.cur, i = this.e4;
    const range = fx.on ? fx : this.off;
    if (i < range.minButton || i > range.maxButton) return;
    this.e0 = i;
    if (!fx.on && (i < fx.minButton || i > fx.maxButton)) return;
    fx.setBeatButton(this.e0, apply, this.bpm100);
    this.other()?.setBeatButton(this.e0, apply, this.bpm100);
  }

  switchNextBeatEffect() {
    const old = this.cur, next = this.want, off = this.off;
    if (old === next) return;
    const level = old.level;
    let reset;
    if (next === off) {
      this.prev = old; // remembered for OFF -> ON; nothing is reset
      reset = off;
    } else reset = old === off ? this.prev : old;
    if ((old === off || next === off) && next.button === old.button && next.ms !== old.ms) next.ms = old.ms;
    if (reset && reset !== next) {
      if (TAIL_TYPES.has(this.names.get(old))) reset.notifySelected();
      else reset.initialize();
    }
    if (next !== off) {
      off.ms = next.ms;
      off.minMs = next.minMs;
      off.maxMs = next.maxMs;
      off.percent = next.percent;
      off.minPercent = next.minPercent;
      off.maxPercent = next.maxPercent;
      off.minButton = next.minButton;
      off.maxButton = next.maxButton;
    }
    off.setBeatButton(next.button, false, this.bpm100);
    next.setLevel(level);
    this.e0 = this.e4 = off.button;
    if (!next.on) next.toggle();
    this.cur = next;
    next.notifySelected();
    if (next.button !== this.e0) next.setBeatButton(this.e0, false, this.bpm100);
    if (this.e0 < next.minButton) this.e4 = next.minButton;
    else if (next.maxButton < this.e0) this.e4 = next.maxButton;
    this.A.retarget(1);
    this.state = 2;
    if (old.on) old.toggle();
  }

  process(inL, inR, outL, outR, n) {
    const { A, B, C } = this;
    let fx = this.cur;
    if (Math.abs(f(this.level - fx.level)) > LEVEL_EPS) fx.setLevel(this.level);
    if (this.e0 !== this.e4 || fx.pressed) {
      this.switchNextBeatButton(true);
      this.e4 = this.e0;
      fx = this.cur;
    }
    const st = this.state;
    if (st !== 1 && st !== 2) {
      if (this.cur === this.want) {
        if (st === 3) { // ON again while the tail rings: carry on where it is
          fx.keepEffectInit();
          fx.toggle();
          if (this.e0 < fx.minButton) this.e4 = fx.minButton;
          else if (fx.maxButton < this.e0) this.e4 = fx.maxButton;
          const t = f(B.cur + B.step);
          B.target = 0;
          C.step = 0;
          C.cur = 1;
          B.step = f(f(0 - t) * B.inv);
          C.target = 1;
          B.count = 0;
          B.done = false;
          this.state = 0;
        }
      } else if (st === 3 && this.want === this.off) {
        // ringing out
      } else if (st === 0 && this.want === this.off && fx.tail) {
        fx.toggle(); // off: the effect rings out, the manager brings the dry signal back
        B.retarget(1);
        C.start(0, 1);
        this.state = 3;
      } else {
        this.state = 1; // crossfade out of the current effect, then switch
        B.retarget(0);
        C.cur = C.target = 1;
        C.step = 0;
        A.retarget(0);
      }
    }
    if (this.tL.length < n) {
      this.tL = new Float32Array(n);
      this.tR = new Float32Array(n);
    }
    const { tL, tR } = this;
    fx.execute(inL, inR, tL, tR, n);
    fx.pressed = false;
    if (this.state === 1 || this.state === 2) {
      for (let i = 0; i < n; i++) {
        const a = A.cur, b = f(1 - a);
        tL[i] = f(f(tL[i] * a) + f(inL[i] * b));
        tR[i] = f(f(tR[i] * a) + f(inR[i] * b));
        A.cur = f(A.cur + A.step);
        if (A.len <= A.count) {
          A.cur = A.target;
          A.done = true;
        }
        A.count++;
      }
      if (A.done) {
        if (this.state === 1) this.switchNextBeatEffect();
        else this.state = 0;
      }
    }
    if (B.done && C.done) {
      const g = B.cur;
      for (let i = 0; i < n; i++) {
        outL[i] = f(f(inL[i] * g) + tL[i]);
        outR[i] = f(f(inR[i] * g) + tR[i]);
      }
    } else {
      for (let i = 0; i < n; i++) {
        const g = B.cur;
        outL[i] = f(f(inL[i] * g) + tL[i]);
        outR[i] = f(f(inR[i] * g) + tR[i]);
        B.cur = f(B.cur + B.step);
        if (B.len <= B.count) {
          B.cur = B.target;
          B.done = true;
        }
        B.count++;
        C.cur = f(C.cur + C.step);
        if (C.len <= C.count) {
          C.cur = C.target;
          C.done = true;
        }
        C.count++;
      }
    }
  }
}

/** Run a processor in the RX3's 64-sample blocks (Web Audio hands the worklet 128 frames at a time). */
export function inBlocks(fn, inL, inR, outL, outR, n) {
  for (let o = 0; o < n; o += 64) {
    const m = Math.min(64, n - o);
    fn(inL.subarray(o, o + m), inR.subarray(o, o + m), outL.subarray(o, o + m), outR.subarray(o, o + m), m);
  }
}

/**
 * dsp::secondOrder_IIRFilter on a stereo pair, coefficients [b0, b1, b2, a1, a2]. It runs a block at a time, as
 * secondOrder_IIRFilter_operate does: the first two samples subtract the feedback terms one by one, the rest
 * subtract their sum (a2 y2 + a1 y1), which rounds differently, so the port has to run the same blocks.
 */
export class Biquad {
  constructor() {
    this.c = new Float32Array(5);
    this.clear();
  }

  set(c) {
    this.c.set(c);
  }

  clear() {
    this.xL1 = this.xL2 = this.xR1 = this.xR2 = 0;
    this.yL1 = this.yL2 = this.yR1 = this.yR2 = 0;
  }

  process(inL, inR, outL, outR, n) {
    if (n === 0) return;
    const [b0, b1, b2, a1, a2] = this.c;
    this.lane(inL, outL, n, b0, b1, b2, a1, a2, 'L');
    this.lane(inR, outR, n, b0, b1, b2, a1, a2, 'R');
  }

  lane(x, y, n, b0, b1, b2, a1, a2, c) {
    const x1 = this['x' + c + '1'], x2 = this['x' + c + '2'], y1 = this['y' + c + '1'], y2 = this['y' + c + '2'];
    y[0] = f(f(f(f(f(b0 * x[0]) + f(b1 * x1)) + f(b2 * x2)) - f(a1 * y1)) - f(a2 * y2));
    if (n === 1) {
      this['x' + c + '2'] = x1;
      this['x' + c + '1'] = x[0];
      this['y' + c + '2'] = y1;
      this['y' + c + '1'] = y[0];
      return;
    }
    y[1] = f(f(f(f(f(b0 * x[1]) + f(b1 * x[0])) + f(b2 * x1)) - f(a1 * y[0])) - f(a2 * y1));
    for (let i = 2; i < n; i++) {
      y[i] = f(f(f(f(b0 * x[i]) + f(b1 * x[i - 1])) + f(b2 * x[i - 2])) - f(f(a2 * y[i - 2]) + f(a1 * y[i - 1])));
    }
    this['x' + c + '2'] = x[n - 2];
    this['x' + c + '1'] = x[n - 1];
    this['y' + c + '2'] = y[n - 2];
    this['y' + c + '1'] = y[n - 1];
  }
}

/** mixerengine::SoundColorFx: COLOR and PARAMETER (0..1, 0.5 = centre) and the hooks the manager calls. */
export class ColorCore {
  constructor(position) {
    this.position = position; // +0x18: 0, 1 or 2 (2 = after the channel fader)
    this.color = 0.5;
    this.param = 0.5;
  }

  setColor(x) {
    this.color = x < 0 ? 0 : x > 1 ? 1 : f(x);
    this.changeColor();
  }

  setParameter(x) {
    this.param = x < 0 ? 0 : x > 1 ? 1 : f(x);
    this.changeParameter();
  }

  changeColor() {}
  changeParameter() {}
  initialize() {}
  detect() {}
  statusOn() {
    return 1;
  }
  statusOff() {
    return 1;
  }
}

/** SoundColorFxOff: what a channel runs with no Color FX selected. */
class ColorOff extends ColorCore {
  constructor() {
    super(1);
  }

  execute(inL, inR, outL, outR, n) {
    outL.set(inL.subarray(0, n));
    outR.set(inR.subarray(0, n));
  }
}

const HELD = 7;

/**
 * mixerengine::SoundColorFxManager: one channel's Sound Color FX. It owns every effect (by type: 1 FILTER, 2 NOISE,
 * 3 SWEEP, 4 DUB ECHO, 5 SPACE, 6 CRUSH) and switches between them: the old one crossfades to the dry signal
 * (4.35 ms), the new one is initialised with the knobs and crossfaded in. Turning off an effect that sits after the
 * fader (DUB ECHO, SPACE) holds it instead: its input is gated out and it rings on, and selecting it again picks it
 * up where it is. SWEEP's level detector runs every block whatever is selected.
 */
export class ColorManager {
  constructor(sampleRate, cores) {
    this.fx = [new ColorOff(), ...cores];
    this.cfx = this.fx[0];
    this.cur = this.next = 0;
    this.held = 0;
    this.state = 0;
    this.X = new Ramp(msLen(sampleRate, 4.3499999), 1);
    this.tL = new Float32Array(64);
    this.tR = new Float32Array(64);
  }

  setType(t) {
    if (this.state === 0 || this.state === 5) this.next = t;
  }

  setColor(x) {
    this.cfx.setColor(x);
  }

  setParameter(x) {
    this.cfx.setParameter(x);
  }

  /** The switch to the next effect once the old one has faded out. */
  switchTo() {
    if (this.cur === this.next) return;
    let nf = this.fx[this.next];
    if (!nf) {
      nf = this.fx[0];
      this.next = 0;
    }
    nf.setColor(this.cfx.color);
    nf.setParameter(this.cfx.param);
    nf.initialize();
    this.X.retarget(1);
    this.cfx = nf;
    this.cur = this.next;
  }

  process(inL, inR, outL, outR, n) {
    this.fx[3].detect(inL, inR, n);
    if ((this.state === 0 || this.state === 5) && this.cur !== this.next) {
      const fx = this.cfx;
      this.state = 1;
      let fade = true;
      if (this.next === 0) {
        if (fx.position === 2 && fx.statusOff()) {
          this.held = this.cur;
          this.cur = this.next = HELD;
          this.state = 5;
          fade = false;
        }
      } else if ((this.cur === 1 && this.next === 3) || (this.cur === 3 && this.next === 1)) {
        if (fx.color < 0.41796875 || fx.color > 0.578125) this.state = 2;
      } else if (this.cur === HELD && this.fx[this.next].position === 2 && this.next === this.held) {
        if (fx.position === 2) fx.statusOn();
        this.cur = this.next;
        this.state = 0;
        fade = false;
      }
      if (fade) this.X.retarget(0);
    }
    if (this.tL.length < n) {
      this.tL = new Float32Array(n);
      this.tR = new Float32Array(n);
    }
    const { tL, tR, X } = this;
    this.cfx.execute(inL, inR, tL, tR, n);
    const mix = (dry) => {
      for (let i = 0; i < n; i++) {
        const a = X.cur;
        if (dry) {
          const b = f(1 - a);
          tL[i] = f(f(tL[i] * a) + f(inL[i] * b));
          tR[i] = f(f(tR[i] * a) + f(inR[i] * b));
        } else {
          tL[i] = f(tL[i] * a);
          tR[i] = f(tR[i] * a);
        }
        X.cur = f(X.cur + X.step);
        if (X.len <= X.count) {
          X.cur = X.target;
          X.done = true;
        }
        X.count++;
      }
    };
    switch (this.state) {
      case 1:
        mix(true);
        if (X.done) {
          this.switchTo();
          this.state = 3;
        }
        break;
      case 2:
        mix(false);
        if (X.done) {
          this.switchTo();
          this.state = 4;
        }
        break;
      case 3:
        if (this.cur !== 2) {
          mix(true);
          if (X.done) this.state = 0;
        } else { // into NOISE: a 44-sample fade of its own
          let g = hex(0x3cba2e8c), s = g;
          for (let i = 0; i < n; i++) {
            const b = f(1 - g);
            tL[i] = f(f(tL[i] * g) + f(inL[i] * b));
            tR[i] = f(f(tR[i] * g) + f(inR[i] * b));
            if (i === n - 1) break;
            g = f(g + s);
            if (g > 1) {
              g = 1;
              s = 0;
            }
          }
          if (g >= 1) {
            X.cur = X.target = 1;
            X.step = 0;
            this.state = 0;
          }
        }
        break;
      case 4:
        mix(false);
        if (X.done) this.state = 0;
        break;
    }
    // + the input x the manager's dry ramp, which never leaves 0
    for (let i = 0; i < n; i++) {
      outL[i] = f(f(inL[i] * 0) + tL[i]);
      outR[i] = f(f(inR[i] * 0) + tR[i]);
    }
  }
}
