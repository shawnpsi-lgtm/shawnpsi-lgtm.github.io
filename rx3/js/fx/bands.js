/**
 * Beat FX frequency bands (LOW / MID / HI), as on the DJM-900NXS2 and A9; the RX3 itself has no band buttons, so
 * there is no firmware to port. A band that is switched off skips the effect: its part of the signal goes around the
 * Beat FX section dry.
 *
 * The split is a Linkwitz-Riley (24 dB/oct) 3-way crossover, the low band all-passed to line up with the other two,
 * so the bands sum to an all-pass of the input: flat, but phase-shifted. So while every band is on the effect gets
 * the untouched signal (the RX3's Beat FX bit for bit), and the crossover only fades in (`m`) while a band is off.
 * Switching a band off fades the crossover in, then the band out; switching the last one back on runs in reverse.
 */
const LOW_HZ = 300;
const HIGH_HZ = 3000;
const RAMP_MS = 10;

/** An RBJ biquad (transposed direct form II): 'lp', 'hp' or 'ap', Q = 1/sqrt 2. Two lp or hp make an LR4. */
class Biquad {
  constructor(sampleRate, type, hz) {
    const w = 2 * Math.PI * hz / sampleRate, cos = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2, a0 = 1 + alpha;
    const b = type === 'lp' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2]
      : type === 'hp' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]
      : [1 - alpha, -2 * cos, 1 + alpha];
    [this.b0, this.b1, this.b2] = b.map((x) => x / a0);
    this.a1 = -2 * cos / a0;
    this.a2 = (1 - alpha) / a0;
    this.z1 = this.z2 = 0;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

/** One audio channel's crossover. */
class Crossover {
  constructor(sr) {
    const lr4 = (type, hz) => [new Biquad(sr, type, hz), new Biquad(sr, type, hz)];
    this.lo = lr4('lp', LOW_HZ);
    this.up = lr4('hp', LOW_HZ);
    this.mid = lr4('lp', HIGH_HZ);
    this.hi = lr4('hp', HIGH_HZ);
    this.ap = new Biquad(sr, 'ap', HIGH_HZ); // the phase the mid / high split gives, for the low band
    this.out = [0, 0, 0];
  }

  /** The three bands of one sample, in `out`. */
  run(x) {
    const two = (f, v) => f[1].run(f[0].run(v)), up = two(this.up, x), o = this.out;
    o[0] = this.ap.run(two(this.lo, x));
    o[1] = two(this.mid, up);
    o[2] = two(this.hi, up);
    return o;
  }
}

export class BandSplit {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.on = [true, true, true];
    this.g = [1, 1, 1]; // how much of each band goes to the effect
    this.m = 0; // how far the effect's input has moved from the signal itself to the crossover's bands
    this.step = 1 / (sampleRate * RAMP_MS / 1000);
    this.bL = new Float32Array(64);
    this.bR = new Float32Array(64);
    this.x = null;
    this.around = 0;
  }

  /** band: 0 LOW, 1 MID, 2 HI. */
  set(band, on) {
    this.on[band] = on;
  }

  get flat() {
    const { on, g } = this;
    return this.m === 0 && on[0] && on[1] && on[2] && g[0] === 1 && g[1] === 1 && g[2] === 1;
  }

  /**
   * Take the switched-off bands out of a block in place (what is left goes to the effect), keeping them in bL, bR
   * for `restore`. Returns false, touching nothing, while every band is on.
   */
  remove(L, R) {
    if (this.flat) {
      this.x = null;
      return false;
    }
    if (!this.x) this.x = [new Crossover(this.sampleRate), new Crossover(this.sampleRate)]; // from silence
    const n = L.length, { g, on, step } = this, allOn = on[0] && on[1] && on[2];
    if (this.bL.length < n) {
      this.bL = new Float32Array(n);
      this.bR = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      if (allOn) {
        if (g[0] === 1 && g[1] === 1 && g[2] === 1) this.m = Math.max(0, this.m - step);
      } else this.m = Math.min(1, this.m + step);
      for (let b = 0; b < 3; b++) {
        if (on[b]) g[b] = Math.min(1, g[b] + step);
        else if (this.m === 1) g[b] = Math.max(0, g[b] - step);
      }
      L[i] = this.split(this.x[0], L[i]);
      this.bL[i] = this.around;
      R[i] = this.split(this.x[1], R[i]);
      this.bR[i] = this.around;
    }
    return true;
  }

  /** One sample: returns what goes to the effect, and leaves what goes around it in `around`. */
  split(x, v) {
    const [lo, mid, hi] = x.run(v), { g, m } = this;
    const around = this.around = m * ((1 - g[0]) * lo + (1 - g[1]) * mid + (1 - g[2]) * hi);
    return (1 - m) * v + m * (lo + mid + hi) - around;
  }

  /** Add the bands `remove` took out back onto the effect's output. */
  restore(L, R) {
    for (let i = 0; i < L.length; i++) {
      L[i] += this.bL[i];
      R[i] += this.bR[i];
    }
  }
}
