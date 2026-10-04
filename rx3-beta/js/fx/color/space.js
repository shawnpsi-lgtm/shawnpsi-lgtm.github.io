/**
 * Sound Color FX SPACE, ported from the XDJ-RX3 v1.19 player (mixerengine::SoundColorFxSpace).
 *
 * A mono reverb after the channel fader: L+R, gated and levelled by COLOR, through a band-pass, four allpass
 * stages (gain 0.8) and two damped combs, added back to both channels:
 *   x = bp((L + R) x level x gate);  a1..a4 = allpasses;  R' = a3 - x;  L' = a4 - x
 *   outL = in + 2 comb(L', fb0);  outR = in + 2 comb(R', fb1)
 * Left of centre and right of centre are two voicings (delay lengths, damping, filters); COLOR away from the
 * middle raises the level and the comb feedback, PARAMETER sets the feedback's range. When it starts each stage
 * passes its input through until its line has filled (0.03 .. 0.31 s); switched off, the input is gated out and
 * the tail rings on. The firmware works in static 64-sample scratch buffers laid out side by side, and reaches
 * across them; S below is that memory.
 */
import { ColorCore, f, hex } from '../dsp.js';
import { LEFT_HPF, LEFT_LPF, RIGHT_HPF, RIGHT_LPF } from './space-tables.js';

export const meta = { name: 'SPACE', type: 5 };

const SIZE = 0x8000, MASK = SIZE - 1;
// the static buffers, by float index from m_output_tmp_lch
const OL = 0, O = 64, IG = 128, SM = 192, TB = 256, FB = 384, OR = 448;
const INV116 = hex(0x3c0d3dcb), G = hex(0x3f4ccccd), XSTEP = hex(0x3d0b51d8), LSTEP = hex(0x3d0b51da);

/** dsp::secondOrder_IIRFilter's mono operate (its own order of accumulation). */
class MonoBiquad {
  constructor() {
    this.c = new Float32Array(5);
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  set(c) {
    this.c.set(c);
  }

  clear() {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  /** x from S[xi..], y to S[yi..]. */
  run(S, xi, yi, n) {
    const [c0, c1, c2, c3, c4] = this.c;
    const one = (x, x1, x2, y1, y2) => f(f(f(f(f(c1 * x1) + f(c0 * x)) + f(c2 * x2)) - f(c3 * y1)) - f(c4 * y2));
    if (n === 1) {
      const y = one(S[xi], this.x1, this.x2, this.y1, this.y2);
      this.x2 = this.x1;
      this.x1 = S[xi];
      this.y2 = this.y1;
      this.y1 = S[yi] = y;
      return;
    }
    S[yi] = one(S[xi], this.x1, this.x2, this.y1, this.y2);
    S[yi + 1] = one(S[xi + 1], S[xi], this.x1, S[yi], this.y1);
    for (let i = 2; i < n; i++) S[yi + i] = one(S[xi + i], S[xi + i - 1], S[xi + i - 2], S[yi + i - 1], S[yi + i - 2]);
    this.x2 = S[xi + n - 2];
    this.x1 = S[xi + n - 1];
    this.y2 = S[yi + n - 2];
    this.y1 = S[yi + n - 1];
  }
}

export class SpaceCore extends ColorCore {
  constructor(sampleRate) {
    super(2);
    this.sr = sampleRate;
    this.S = new Float32Array(512);
    this.line = Array.from({ length: 6 }, () => new Float32Array(SIZE));
    this.lpf = new MonoBiquad();
    this.hpf = new MonoBiquad();
    this.init = true;
    this.right = false; // +0x2c
    this.flip = false; // +0x30
    this.cur = 0; // +0x34
    this.pos = 0; // +0x50 (a float in the firmware)
    this.stage = 1; // +0x54
    this.count = [0, 0, 0, 0, 0]; // +0x58..+0x68
    this.len = [0, 0, 0, 0, 8723, 13882]; // +0x6c..+0x80
    this.fb0 = this.fb1 = 0; // +0x8c/+0x90
    this.lp0 = this.lp1 = 0; // +0x94/+0x98
    this.level = 0; // +0x9c
    this.x = 1; // +0xa0: the delay-set crossfade
    this.gate = 0; // +0xa8
    this.gateStep = hex(0x3bdee95c); // +0xac
    this.initialize(); // SoundColorFxManager::init
  }

  statusOn() {
    this.gateStep = hex(0x3bdee95c);
    return 1;
  }

  statusOff() {
    this.gateStep = hex(0xbbdee95c);
    return 1;
  }

  voicing(right) {
    this.right = right;
    this.len.splice(0, 4, ...(right ? [1099, 1686, 2916, 1508] : [1223, 1876, 3246, 1679]));
    this.lpf.set(right ? RIGHT_LPF : LEFT_LPF);
    this.hpf.set(right ? RIGHT_HPF : LEFT_HPF);
  }

  initialize() {
    const c = Math.trunc(f(this.color * hex(0x437fe666)));
    this.flip = false;
    this.pos = 0;
    this.count.fill(0);
    this.stage = 1;
    if (c < 0) {
      this.cur = 0;
      this.voicing(false);
    } else if (c <= 255) {
      this.cur = c;
      this.voicing(c > 115);
    } else {
      this.cur = 255;
      this.voicing(true);
    }
    this.lpf.clear();
    this.hpf.clear();
    this.lp0 = this.lp1 = this.level = this.gate = 0;
    this.len[4] = 8723;
    this.len[5] = 13882;
    this.gateStep = hex(0x3bdee95c);
    this.init = false;
    this.x = 1;
  }

  /** Read n samples from line k at delay len[k] into S[FB..]. */
  read(k, pos, n) {
    const L = this.line[k], S = this.S;
    let i = pos - this.len[k];
    if (i < 0) i += SIZE;
    for (let j = 0; j < n; j++) S[FB + j] = L[(i + j) & MASK];
  }

  write(k, pos, n) {
    const L = this.line[k], S = this.S;
    for (let j = 0; j < n; j++) L[(pos + j) & MASK] = S[O + j];
  }

  /** An allpass stage: O = in - 0.8 x d, OL = O + x d (stage 1 reads the filtered input, the others OL). */
  allpass(n, src = OL) {
    const S = this.S;
    for (let i = 0; i < n; i++) {
      const d = S[FB + i], x = S[SM + i];
      const u = f(S[src + i] - f(f(d * G) * x));
      S[O + i] = u;
      S[OL + i] = f(u + f(d * x));
    }
  }

  execute(inL, inR, outL, outR, n) {
    if (this.init) this.initialize();
    const S = this.S;
    let g = this.gate;
    for (let i = 0; i < n; i++) {
      g = f(g + this.gateStep);
      if (g > 1) g = 1;
      else if (g < 0) g = 0;
      S[IG + i] = g;
    }
    this.gate = g;
    // PARAMETER is scaled by 255.9 twice in the firmware, so any non-zero value is the top step
    let ps = Math.trunc(f(f(this.param * hex(0x437fe666)) * hex(0x437fe666)));
    ps = ps < 0 ? 0 : ps >= 255 ? 255 : ps;
    let cs = Math.trunc(f(this.color * hex(0x437fe666)));
    cs = cs < 0 ? 0 : cs >= 255 ? 255 : cs;
    let cur = this.cur, a, b, fb0, fb1, lvl, over, damp, keep, mono, set;
    if (!this.right) {
      if (cs > cur) {
        cur++;
        if (cs < cur) cur = cs;
      } else if (cs < cur) {
        cur--;
        if (cs > cur) cur = cs;
      }
      if (cur > 139) {
        cur = 139;
        this.flip = true;
      }
      if (ps <= 115) {
        const t = f(f(ps) * INV116);
        a = f(t * hex(0x3f29c0fe));
        b = f(t * hex(0x3f425f20));
      } else if (ps <= 139) {
        a = hex(0x3f29c0fe);
        b = hex(0x3f425f20);
      } else {
        const t = f(f(ps - 139) * INV116);
        a = f(hex(0x3f29c0fe) + f(t * hex(0x3d75c28f)));
        b = f(hex(0x3f425f20) + f(t * hex(0x3dcccccd)));
      }
      if (cur > 115) {
        over = false;
        fb1 = hex(0x3de8c4aa);
        fb0 = hex(0x3e8295e4);
        lvl = 0;
      } else {
        const c = f(f(cur) * INV116), s = f(1 - f(c * c));
        fb0 = f(hex(0x3e8295e4) + f(s * a));
        fb1 = f(hex(0x3de8c4aa) + f(b * s));
        lvl = f(f(116 - cur) * hex(0x3d0d3dcb));
        over = lvl > 1;
      }
      set = [1223, 1876, 3246, 1679];
      damp = hex(0x3f2dc3ae);
      keep = hex(0x3ea478a3);
      this.lpf.set(LEFT_LPF);
      this.hpf.set(LEFT_HPF);
      mono = 0.5;
    } else {
      if (cs > cur) {
        cur++;
        if (cs < cur) cur = cs;
      } else if (cs < cur) {
        cur--;
        if (cs > cur) cur = cs;
      }
      if (cur <= 115) {
        cur = 116;
        this.flip = true;
      }
      if (ps <= 115) {
        const t = f(f(ps) * INV116);
        a = f(t * hex(0x3f2dcd7a));
        b = f(t * hex(0x3f48877b));
      } else if (ps <= 139) {
        a = hex(0x3f2dcd7a);
        b = hex(0x3f48877b);
      } else {
        const t = f(f(ps - 139) * INV116);
        a = f(hex(0x3f2dcd7a) + f(t * hex(0x3d75c28f)));
        b = f(hex(0x3f48877b) + f(t * hex(0x3dcccccd)));
      }
      if (cur <= 139) {
        over = false;
        fb1 = hex(0x3de8c4aa);
        fb0 = hex(0x3e8295e4);
        lvl = 0;
      } else {
        const c = f(f(255 - cur) * INV116), s = f(1 - f(c * c));
        fb0 = f(hex(0x3e8295e4) + f(s * a));
        fb1 = f(hex(0x3de8c4aa) + f(b * s));
        lvl = f(f(cur - 139) * hex(0x3d0d3dcb));
        over = lvl > 1;
      }
      set = [1099, 1686, 2916, 1508];
      damp = hex(0x3f507b71);
      keep = hex(0x3e3e123d);
      this.lpf.set(RIGHT_LPF);
      this.hpf.set(RIGHT_HPF);
      mono = hex(0x3f333333);
    }
    this.cur = cur;
    this.fb1 = fb1;
    this.fb0 = fb0;
    // the delay-set crossfade: up while the lines are this side's lengths, down (then swap) otherwise
    const xs = this.len[0] === set[0] ? XSTEP : hex(0xbd0b51d8);
    let x = this.x;
    for (let i = 0; i < n; i++) {
      x = f(x + xs);
      if (x > 1) x = 1;
      else if (x < 0) x = 0;
      S[SM + i] = x;
    }
    this.x = x;
    if (over) lvl = 1;
    let L = this.level;
    const ls = f(f(lvl - L) * LSTEP);
    for (let i = 0; i < n; i++) {
      L = f(L + ls);
      S[TB + i] = f(f(inL[i] + inR[i]) * f(f(mono * L) * S[IG + i]));
    }
    this.level = lvl;
    this.lpf.run(S, TB, TB + 64, n);
    this.hpf.run(S, TB + 64, TB, n);
    const pos = Math.trunc(this.pos);
    // stage 1
    if (this.stage === 1) {
      this.count[0] += n;
      if (this.count[0] > 1234) this.stage = 2;
      for (let i = 0; i < n; i++) S[O + i] = S[OL + i] = S[TB + i];
    } else {
      this.read(0, pos, n);
      this.allpass(n, TB);
    }
    this.write(0, pos, n);
    let next = pos + n;
    if (next >= SIZE) next -= SIZE;
    // stages 2 .. 4
    const passOrAllpass = (k, active) => {
      if (active) {
        this.read(k, pos, n);
        this.allpass(n);
      } else for (let i = 0; i < n; i++) S[O + i] = S[OL + i];
      this.write(k, pos, n);
    };
    if (this.stage <= 2) {
      this.count[1] += n;
      if (this.count[1] > 1895) this.stage = 3;
      passOrAllpass(1, false);
    } else passOrAllpass(1, true);
    if (this.stage <= 3) {
      this.count[2] += n;
      if (this.count[2] > 3262) this.stage = 4;
      passOrAllpass(2, false);
    } else passOrAllpass(2, true);
    for (let i = 0; i < n; i++) S[OR + i] = f(S[OL + i] - S[TB + i]);
    passOrAllpass(3, this.stage > 3);
    for (let i = 0; i < n; i++) S[OL + i] = f(S[OL + i] - S[TB + i]);
    // the combs
    const comb = (k, at, fb, lpKey, active) => {
      let lp = this[lpKey];
      if (active) {
        this.read(k, pos, n);
        for (let i = 0; i < n; i++) {
          lp = f(f(f(S[at + i] + f(fb * S[FB + i])) * damp) + f(lp * keep));
          S[O + i] = S[at + i] = lp;
        }
      } else {
        for (let i = 0; i < n; i++) {
          lp = f(f(S[at + i] * damp) + f(lp * keep));
          S[at + i] = S[O + i] = lp;
        }
      }
      this[lpKey] = lp;
      this.write(k, pos, n);
    };
    if (this.stage <= 4) {
      this.count[3] += n;
      if (this.count[3] > 8731) this.stage = 5;
      comb(4, OL, this.fb0, 'lp0', false);
    } else comb(4, OL, this.fb0, 'lp0', true);
    if (this.stage <= 5) {
      this.count[4] += n;
      if (this.count[4] > 13891) this.stage = 6;
      comb(5, OR, this.fb1, 'lp1', false);
    } else comb(5, OR, this.fb1, 'lp1', true);
    this.pos = next;
    for (let i = 0; i < n; i++) {
      outL[i] = f(f(S[OL + i] + S[OL + i]) + inL[i]);
      outR[i] = f(f(S[OR + i] + S[OR + i]) + inR[i]);
    }
    if (this.flip) {
      this.right = !this.right;
      this.lpf.clear();
      this.hpf.clear();
      this.flip = false;
    }
    if (this.x < 0.03125) {
      this.x = 0;
      this.len.splice(0, 4, ...set);
      this.len[4] = 8723;
      this.len[5] = 13882;
    }
  }
}

export const Core = SpaceCore;
