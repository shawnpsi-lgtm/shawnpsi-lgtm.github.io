// Track analysis after decoding: the waveform the screen draws, and BPM + first beat when the library has none.

export const WAVE_RATE = 150; // waveform columns per second of audio

/**
 * peaks: Uint8Array of [amplitude, brightness] per column. Amplitude is the column's peak level, brightness how
 * much of it is high-frequency content (RX3's blue waveform is pale where the hats are, deep where the bass is).
 */
function waveform(l, r, sr) {
  const hop = sr / WAVE_RATE, cols = Math.floor(l.length / hop);
  const peaks = new Uint8Array(cols * 2);
  let prev = 0;
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * hop), b = Math.floor((c + 1) * hop);
    let pk = 0, hi = 0, lo = 0;
    for (let i = a; i < b; i++) {
      const x = (l[i] + r[i]) * 0.5;
      const ax = Math.abs(x);
      if (ax > pk) pk = ax;
      hi += Math.abs(x - prev); // first difference ~ treble energy
      lo += ax;
      prev = x;
    }
    peaks[c * 2] = Math.min(255, pk * 255);
    peaks[c * 2 + 1] = lo > 0 ? Math.min(255, (hi / lo) * 160) : 0;
  }
  return peaks;
}

/** Onset strength at ~100 Hz: positive change in the low/mid energy envelope. */
function onsets(l, sr) {
  const hop = Math.round(sr / 100), n = Math.floor(l.length / hop), env = new Float32Array(n);
  let lp = 0, last = 0;
  const k = 1 - Math.exp(-2 * Math.PI * 200 / sr); // one-pole low-pass at 200 Hz: kicks and bass
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) {
      lp += k * (l[i] - lp);
      e += lp * lp + 0.25 * l[i] * l[i];
    }
    e = Math.log1p(e * 100);
    env[f] = Math.max(0, e - last);
    last = e;
  }
  return env;
}

/** Tempo by autocorrelation of the onset envelope (78-180 BPM) unless known; then the beat phase. */
function detectBeat(l, sr, knownBpm) {
  const env = onsets(l, sr), fps = 100;
  if (knownBpm) return { bpm: knownBpm, firstBeat: phase(env, fps, knownBpm) };
  const start = Math.floor(env.length * 0.1), end = Math.min(env.length, start + fps * 90);
  let best = 0, bestLag = 0;
  for (let lag = Math.floor(fps * 60 / 180); lag <= Math.ceil(fps * 60 / 78); lag++) {
    let s = 0;
    for (let i = start; i + lag < end; i++) s += env[i] * env[i + lag];
    // a little help for the lags of the double tempo too, so 140 doesn't come out as 70
    for (let i = start; i + 2 * lag < end; i += 2) s += 0.5 * env[i] * env[i + 2 * lag];
    if (s > best) {
      best = s;
      bestLag = lag;
    }
  }
  if (!bestLag) return { bpm: 0, firstBeat: 0 };
  // refine the lag to a fraction of a frame with a parabola through the neighbours
  const ac = (lag) => {
    let s = 0;
    for (let i = start; i + lag < end; i++) s += env[i] * env[i + lag];
    return s;
  };
  const y0 = ac(bestLag - 1), y1 = ac(bestLag), y2 = ac(bestLag + 1);
  const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
  const coarse = 60 * fps / (bestLag + (Math.abs(d) < 1 ? d : 0));
  // fine: the tempo (0.02 BPM steps) whose beat grid, at its best phase, lines up with the most onset energy
  let bpm = coarse, top = -1;
  for (let b = coarse - 1.5; b <= coarse + 1.5; b += 0.02) {
    const s = gridScore(env, fps, b);
    if (s > top) {
      top = s;
      bpm = b;
    }
  }
  bpm = Math.round(bpm * 10) / 10;
  if (Math.abs(bpm - Math.round(bpm)) < 0.15) bpm = Math.round(bpm); // produced music is almost always whole BPM
  return { bpm, firstBeat: phase(env, fps, bpm) };
}

/** Best (over phases) sum of interpolated onset strength on a beat grid of this tempo. */
function gridScore(env, fps, bpm) {
  const period = 60 * fps / bpm;
  let best = 0;
  for (let p = 0; p < period; p += 1) {
    let s = 0;
    for (let t = p; t < env.length - 1; t += period) {
      const i = t | 0, f = t - i;
      s += env[i] * (1 - f) + env[i + 1] * f;
    }
    if (s > best) best = s;
  }
  return best;
}

/** The beat offset (s) whose beat positions collect the most onset energy. */
function phase(env, fps, bpm) {
  const period = 60 * fps / bpm;
  let bestPhase = 0, bestSum = -1;
  for (let p = 0; p < period; p += 0.5) {
    let s = 0;
    for (let t = p; t < env.length; t += period) s += env[Math.round(t)] || 0;
    if (s > bestSum) {
      bestSum = s;
      bestPhase = p;
    }
  }
  return bestPhase / fps;
}

export function analyze(audio, track) {
  const sr = audio.sampleRate, l = audio.getChannelData(0);
  const r = audio.numberOfChannels > 1 ? audio.getChannelData(1) : l;
  const out = { duration: audio.duration, peaks: waveform(l, r, sr), bpm: 0, firstBeat: 0 };
  if (track.grid?.length) { // rekordbox beat grid: [{ time (s), bpm }]
    out.bpm = track.grid[0].bpm;
    out.firstBeat = track.grid[0].time;
  } else {
    Object.assign(out, detectBeat(l, sr, track.bpm));
  }
  return out;
}
