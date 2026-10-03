// Canvas drawing for the RX3's waveforms: the scrolling zoom view, and the whole-track overview with the
// playhead and cue marker.
import { WAVE_RATE } from '../audio/analyze.js';

/** RX3 blue: deep where the energy is low-frequency, pale where it is bright. */
const PALETTE = Array.from({ length: 256 }, (_, b) => {
  const t = Math.min(1, b / 200);
  return `rgb(${Math.round(20 + 150 * t)},${Math.round(90 + 140 * t)},${Math.round(230 + 25 * t)})`;
});

function beats(deck, from, to, fn) {
  const a = deck.analysis;
  if (!a?.bpm) return;
  const period = 60 / a.bpm;
  let k = Math.ceil((from - a.firstBeat) / period);
  for (let t = a.firstBeat + k * period; t < to; t += period, k++) fn(t, ((k % 4) + 4) % 4 === 0);
}

/** The zoom view: `pxPerSec` across, the playhead `headX` pixels from the left. */
export function drawZoom(cv, deck, pxPerSec, headX, showGrid) {
  const g = cv.getContext('2d'), w = cv.width, h = cv.height;
  g.fillStyle = '#000';
  g.fillRect(0, 0, w, h);
  const a = deck.analysis;
  if (!a) return;
  const now = deck.position(), t0 = now - headX / pxPerSec, t1 = t0 + w / pxPerSec;
  const tick = 14, mid = h / 2, amp = (h - 2 * tick - 8) / 2;
  const peaks = a.peaks, cols = peaks.length / 2, colPerPx = WAVE_RATE / pxPerSec;
  for (let x = 0; x < w; x++) {
    const c0 = Math.floor((t0 + x / pxPerSec) * WAVE_RATE);
    const c1 = Math.max(c0 + 1, Math.floor(c0 + colPerPx));
    if (c1 <= 0 || c0 >= cols) continue;
    let pk = 0, br = 0;
    for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) {
      if (peaks[c * 2] > pk) {
        pk = peaks[c * 2];
        br = peaks[c * 2 + 1];
      }
    }
    if (!pk) continue;
    const y = (pk / 255) * amp;
    g.fillStyle = PALETTE[br];
    g.fillRect(x, mid - y, 1, 2 * y);
    g.fillStyle = 'rgba(255,255,255,0.35)'; // the bright core
    g.fillRect(x, mid - y * 0.35, 1, y * 0.7);
  }
  beats(deck, t0, t1, (t, bar) => {
    const x = Math.round((t - t0) * pxPerSec);
    g.fillStyle = bar ? '#ff2020' : '#e8e8e8';
    g.fillRect(x, 0, 2, tick);
    g.fillRect(x, h - tick, 2, tick);
    if (showGrid) {
      g.fillStyle = bar ? 'rgba(255,40,40,0.35)' : 'rgba(255,255,255,0.12)';
      g.fillRect(x, tick, 1, h - 2 * tick);
    }
  });
  if (deck.cue >= t0 && deck.cue <= t1) { // memory cue: orange marker at the bottom
    const x = Math.round((deck.cue - t0) * pxPerSec);
    g.fillStyle = '#ff5a1a';
    g.beginPath();
    g.moveTo(x - 7, h);
    g.lineTo(x + 7, h);
    g.lineTo(x, h - 10);
    g.fill();
  }
}

/** Whole-track overview, cached per track and size; the played part is dimmed. */
export function drawOverview(cv, deck, opts = {}) {
  const g = cv.getContext('2d'), w = cv.width, h = cv.height;
  const waveH = opts.waveH || h - 16;
  g.clearRect(0, 0, w, h);
  const a = deck.analysis;
  if (!a) return;
  const key = a.peaks.length + ':' + w + ':' + waveH;
  if (cv._key !== key) {
    const off = cv._off || (cv._off = document.createElement('canvas'));
    off.width = w;
    off.height = waveH;
    const og = off.getContext('2d'), cols = a.peaks.length / 2;
    for (let x = 0; x < w; x++) {
      const c0 = Math.floor((x / w) * cols), c1 = Math.max(c0 + 1, Math.floor(((x + 1) / w) * cols));
      let pk = 0, br = 0, n = 0, sum = 0;
      for (let c = c0; c < c1; c++) {
        pk = Math.max(pk, a.peaks[c * 2]);
        br += a.peaks[c * 2 + 1];
        sum += a.peaks[c * 2];
        n++;
      }
      const y = (pk / 255) * waveH;
      og.fillStyle = PALETTE[Math.round(br / n)];
      og.fillRect(x, waveH - y, 1, y);
      og.fillStyle = 'rgba(255,255,255,0.3)';
      const yy = (sum / n / 255) * waveH * 0.8;
      og.fillRect(x, waveH - yy, 1, yy);
    }
    cv._key = key;
  }
  const px = Math.round((deck.position() / a.duration) * w);
  g.drawImage(cv._off, 0, 0);
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, px, waveH);
  // progress bar, bar ticks (every 16 bars, as on the unit), playhead, cue
  g.fillStyle = '#555';
  g.fillRect(0, waveH + 2, w, 4);
  g.fillStyle = '#fff';
  g.fillRect(px, waveH + 2, w - px, 4);
  if (a.bpm) {
    const every = (60 / a.bpm) * 4 * 16;
    for (let t = a.firstBeat + every; t < a.duration; t += every) g.fillRect(Math.round((t / a.duration) * w), waveH + 9, 2, 7);
  }
  g.fillRect(px - 1, 0, 2, waveH + 6);
  const cx = Math.round((deck.cue / a.duration) * w);
  g.fillStyle = '#ff5a1a';
  g.beginPath();
  g.moveTo(cx - 6, h);
  g.lineTo(cx + 6, h);
  g.lineTo(cx, h - 8);
  g.fill();
}
