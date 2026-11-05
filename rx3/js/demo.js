// The demo on shawnsingh.me/project-rx3.html: the RX3's screen running a short DJ workflow on a loop. No audio: the
// tracks are made up here (waveforms drawn from a beat pattern) and everything runs on the clock. The drawing and
// styles are rx3's own (ui/waveform.js, css/rx3.css), so it looks like the real thing.
//
// The workflow, in seconds from the start of each loop:
//   0   both decks mixing, REVERB on CH2 ready at 50 %
//   3   REVERB on, LEVEL rising slowly from 0 to 75 % ...
//   9   ... held at 75 % ...
//   14  ... then snapped back to 0 and off
//   16  BROWSE: the cursor scrolls down the TRACK list to "see us in the club" by Shawn
//   20  LOAD to deck 2, back to the playing screen; deck 2 drops in on the next bar
import { WAVE_RATE } from './audio/analyze.js';
import { drawOverview, drawZoom } from './ui/waveform.js';

const FX_ON = 3, RAMP_END = 9, CUT = 14, BROWSE = 16, STEP = 0.4, LOAD_PAUSE = 1.2, LOOP = 44;
const LEVEL_MAX = 75, REVERB = 50;
const PX_PER_SEC = 150, HEAD_X = 220; // the screen's ZOOM and playhead, as in ui/screen.js

// ---- made-up tracks: rekordbox-style blue waveforms, a kick on every beat, hats in between, sections that build and drop
function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function synth(seed, bpm, duration, firstBeat, plan) {
  const cols = Math.ceil(duration * WAVE_RATE), peaks = new Uint8Array(cols * 2), per = 60 / bpm;
  const totalBeats = (duration - firstBeat) / per;
  for (let c = 0; c < cols; c++) {
    const t = c / WAVE_RATE, b = (t - firstBeat) / per;
    const noise = hash(c * 0.37 + seed * 91);
    let pk, br;
    if (b < 0) { pk = 10 + 20 * noise; br = 60; } else {
      const ph = b % 1, bar = Math.floor(b / 4), section = plan[Math.floor(b / 64) % plan.length]; // 16-bar sections
      const fade = Math.min(1, (totalBeats - b) / 32), fill = bar % 8 === 7 && b % 4 >= 2; // a fill into each 8th bar
      const drums = section >= 0.6;
      const kick = drums ? Math.exp(-ph * 7) : 0;
      const body = drums ? 0.32 * Math.max(0, 1 - ph * 1.6) : 0; // the bass under each kick
      const hat = Math.exp(-Math.abs(ph - 0.5) * 24) * (drums ? 0.42 : 0.15);
      const tick = Math.exp(-Math.abs((ph * 4) % 1 - 0.5) * 30) * (fill ? 0.3 : 0.1);
      const pad = 0.2 + 0.08 * Math.sin(b * 0.4 + seed);
      pk = 255 * Math.min(1, fade * (section * (0.55 * kick + body + hat + tick + pad) + 0.06 * noise));
      br = Math.min(255, 40 + 210 * Math.min(1, hat * 1.6 + tick * 2) + 25 * noise - 30 * kick);
    }
    peaks[c * 2] = pk;
    peaks[c * 2 + 1] = br;
  }
  return { duration, peaks, bpm, firstBeat };
}

const TRACKS = {
  dirty: { title: 'dirty talk', artist: '', key: '8A', bpm: 124, time: 286.7, a: synth(1, 124, 286.7, 0.42, [0.5, 0.8, 1, 0.9, 0.45, 1, 1, 0.8]) },
  lethim: { title: 'let him go', artist: '', key: '9A', bpm: 122, time: 258.5, a: synth(2, 122, 258.5, 0.31, [0.4, 0.85, 1, 0.55, 1, 0.95, 0.7]) },
  club: { title: 'see us in the club', artist: 'Shawn', key: '8A', bpm: 126, time: 169.4, a: synth(3, 126, 169.4, 0.12, [0.7, 0.85, 1, 1, 0.5, 1]) },
};
// the TRACK list on USB1, by title: what the cursor scrolls through
const LIBRARY = [
  { title: 'all by myself', artist: 'Mita Gami', key: '5A', bpm: 118, time: 209.6 },
  TRACKS.dirty, TRACKS.lethim,
  { title: 'positive', artist: '', key: '11B', bpm: 120, time: 245.4 },
  TRACKS.club,
];
const TARGET = LIBRARY.indexOf(TRACKS.club);
const LOAD = BROWSE + 0.6 + TARGET * STEP + LOAD_PAUSE; // when the track goes to deck 2
const BACK = LOAD + 0.4, READY = LOAD + 1.2, DROP_AFTER = READY + 2; // back to playing, loaded, then in on the next bar

const MASTER = TRACKS.dirty.bpm, PER = 60 / MASTER;
const deck = (index) => ({ index, t: null, cue: 0, pos: 0, loop: null, get analysis() { return this.t?.a; }, position() { return this.pos; } });
const decks = [deck(0), deck(1)];

// ---- the page
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const set = (el, v) => { if (el && el._v !== v) { el._v = v; el.innerHTML = v; } };
const wrap = $('#screen-wrap'), screen = $('#screen');
function fit() { // as Screen.fit()
  const w = wrap.clientWidth, h = wrap.clientHeight, s = Math.min(w / 1280, h / 800);
  screen.style.setProperty('--s', s);
  screen.style.transform = `translate(${(w - 1280 * s) / 2}px, ${(h - 800 * s) / 2}px) scale(${s})`;
}
new ResizeObserver(fit).observe(wrap);
fit();

const clock = (s, ms) => {
  s = Math.max(0, s);
  const t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  return ms ? [t, '.' + String(Math.floor((s % 1) * 1000)).padStart(3, '0')] : t;
};
const bpmHtml = (master) => '<span class="k">BPM</span>' + (master ? '<span class="m">MASTER</span>' : '') +
  `<span class="v">${Math.floor(MASTER)}<small>.${MASTER.toFixed(1).split('.')[1]}</small></span>`;
const tempo = (t) => { const p = (MASTER / t.bpm - 1) * 100; return (p >= 0 ? '' : '-') + Math.abs(p).toFixed(2); };

const ICONS = {
  ARTIST: '<circle cx="17" cy="11" r="6"/><path d="M5 31c1-8 6-11 12-11s11 3 12 11"/>',
  ALBUMS: '<rect x="5" y="9" width="20" height="20"/><path d="M9 5h20v20"/><circle cx="15" cy="19" r="4"/>',
  TRACK: '<path d="M8 26V9l9-2v17M8 26a3 3 0 1 1-1-2M17 24a3 3 0 1 1-1-2M21 27V12l8-2v13M29 23a3 3 0 1 1-1-2"/>',
  KEY: '<rect x="4" y="4" width="26" height="26"/><text x="9" y="24" font-size="14" fill="#fff" stroke="none" font-style="italic">b#</text>',
  PLAYLIST: '<path d="M8 4h13l6 6v20H8z"/><path d="M15 25V14l6-2M15 25a2.5 2.5 0 1 1-1-2"/>',
  HISTORY: '<path d="M6 17a11 11 0 1 0 3-8M6 5v6h6M17 10v8l5 3"/>',
  MATCHING: '<circle cx="13" cy="17" r="9"/><circle cx="21" cy="17" r="9"/>',
  FOLDER: '<path d="M4 9h10l3 3h13v17H4z"/>',
};
$('#cats').innerHTML = Object.entries(ICONS).map(([c, i]) => `<button class="${c === 'TRACK' ? 'sel' : ''}"><svg viewBox="0 0 34 34">${i}</svg>${c}</button>`).join('');
$('#bank').innerHTML = ['ECHO 1/2', 'REVERB 50%', 'FILTER 4', ''].map((s) => `<button>${s}</button>`).join('') + '<button class="trash">CLR</button>';
$('#xpad').className = 'xpad touch'; // REVERB's X-PAD is a strip: LPF left, HPF right, resting in the middle
$('#xpad').innerHTML = '<span class="lo"><i class="tri l"></i> LPF</span><span class="mid"></span><span class="hi">HPF <i class="tri r"></i></span><i style="left:50%"></i>';

function deckPanels(state) { // rebuilt when a deck's track changes, as Screen.renderPlaying() does
  $$('.deck-info').forEach((el) => {
    const d = decks[+el.dataset.deck];
    el.classList.toggle('active', d.index === 1);
    set(el, `<div class="dh">DECK ${d.index + 1}</div><div class="src">${d.t ? '<span class="usb-ico"></span>USB1' : ''}</div>` +
      `<div class="key"><i>b#</i>${d.t?.key || ''}</div><div class="bars"><b class="bars-v">--.-</b>Bars</div><div></div>`);
  });
  $$('.deck-panel').forEach((el) => {
    const d = decks[+el.dataset.deck], loading = state[d.index] === 'loading';
    el.classList.toggle('active', d.index === 1);
    set(el, `<div class="dk">DECK<b>${d.index + 1}</b></div><div class="title ${d.t ? '' : 'none'}">${d.t?.title || ''}</div>` +
      `<div class="trk">TRACK<b>${d.t && !loading ? String(LIBRARY.indexOf(d.t) + 1).padStart(2, '0') : '00'}</b>SINGLE<div class="q">QUANTIZE</div><div class="qv">1</div></div>` +
      '<div class="hc a">A.HOT CUE</div><div class="hc b">AUTO CUE</div>' +
      '<div class="tl">&bull; REMAIN <span class="dim">/ TIME</span></div><div class="time"></div>' +
      '<div class="mt">MT</div><div class="tempo-l">TEMPO</div><div class="range">10%</div>' +
      `<div class="tempo">${loading ? '' : tempo(d.t) + '<small>%</small>'}</div>` +
      `<div class="bpmbox ${d.index ? 'slave' : ''}">${loading ? '<span class="k">BPM</span>' : bpmHtml(d.index === 0)}</div>` +
      (loading ? '<div class="busy">Loading…</div>' : '<canvas width="512" height="58"></canvas>'));
  });
  $$('.mini-deck').forEach((el) => {
    const d = decks[+el.dataset.deck];
    el.classList.toggle('active', d.index === 1);
    set(el, `<span class="lbl">DECK${d.index + 1}</span><span class="rem">REMAIN</span><span class="t"></span>` +
      `<canvas width="410" height="56"></canvas><span class="nl"></span><div class="bpmbox ${d.index ? 'slave' : ''}">${bpmHtml(d.index === 0)}</div>`);
  });
}

function fxPanel(on, level) { // Screen.renderFxPanel() for an effect set in %, as REVERB is
  const panel = $('#fx-panel');
  panel.classList.toggle('on', on);
  set(panel, '<div class="t">BEAT FX</div><div class="name">REVERB</div><div class="chl">CH SELECT</div><div class="ch">2</div>' +
    `<div class="vals"><div class="big" style="top:30px">${REVERB}<small>%</small></div>` +
    `<div style="top:96px;font-size:14px;right:12px">LEVEL ${level}</div><div class="q">QUANTIZE</div></div>`);
}

function browse(cursor) { // Screen.renderBrowse() for the TRACK list; the right column is the highlighted track's INFO
  const loaded = new Set(decks.map((d) => d.t));
  set($('#list-l'), Array.from({ length: 12 }, (_, i) => {
    const t = LIBRARY[i];
    if (!t) return '<li></li>';
    return `<li class="${i === cursor ? 'sel' : ''} ${loaded.has(t) ? 'loaded' : ''}"><span class="meta">${t.artist}</span>${t.title}</li>`;
  }).join(''));
  const t = LIBRARY[cursor];
  set($('#list-r'), [['ARTIST', t.artist || '-'], ['ALBUM', '-'], ['GENRE', '-'], ['BPM', t.bpm.toFixed(1)], ['KEY', t.key],
    ['TIME', clock(t.time)], ['SOURCE', 'USB1']].map(([k, v]) => `<li class="kv">${k}<b>${v}</b></li>`).join('') + '<li></li>'.repeat(5));
}

// ---- the loop
const START = { dirty: 64, lethim: 96 }; // the beat each track is playing from when the loop starts
const s1 = TRACKS.dirty.a.firstBeat + START.dirty * PER;
const s2 = TRACKS.lethim.a.firstBeat + START.lethim * (60 / TRACKS.lethim.bpm);
const sClub = TRACKS.club.a.firstBeat; // auto cue: the first beat
const dropAt = Math.ceil(DROP_AFTER / (4 * PER)) * 4 * PER; // the next bar of deck 1
let last = '';

function frame(now) {
  const T = (still ? 6 : (now - t0) / 1000) % LOOP;
  // decks: deck 1 plays throughout; deck 2 plays "let him go" until it's swapped for "see us in the club"
  decks[0].t = TRACKS.dirty;
  decks[0].pos = s1 + T;
  decks[0].cue = s1;
  const swapped = T >= LOAD;
  decks[1].t = swapped ? TRACKS.club : TRACKS.lethim;
  if (!swapped) {
    decks[1].pos = s2 + T * (MASTER / TRACKS.lethim.bpm);
    decks[1].cue = s2;
  } else {
    decks[1].cue = sClub;
    decks[1].pos = T < dropAt ? sClub : sClub + (T - dropAt) * (MASTER / TRACKS.club.bpm);
  }
  const loading = swapped && T < READY;
  const key = `${decks[1].t.title}|${loading}`;
  if (key !== last) { last = key; deckPanels([null, loading ? 'loading' : null]); }

  // REVERB: on, LEVEL rising slowly to 75 %, held, then cut to 0 at once
  const on = T >= FX_ON && T < CUT;
  const level = !on ? 0 : Math.round(LEVEL_MAX * Math.min(1, (T - FX_ON) / (RAMP_END - FX_ON)) ** 1.4);
  fxPanel(on, level);

  const view = T >= BROWSE && T < BACK ? 'browse' : 'playing';
  if (screen.className !== 'view-' + view) screen.className = 'view-' + view;
  const up = Math.floor(754 + T), hms = [up / 3600, (up / 60) % 60, up % 60].map((x) => String(Math.floor(x)).padStart(2, '0')).join(':');
  $$('#clock-a, .rec-time').forEach((el) => { if (el.textContent !== hms) el.textContent = hms; });

  if (view === 'browse') {
    browse(Math.min(TARGET, Math.max(0, Math.floor((T - BROWSE - 0.6) / STEP) + 1)));
    $$('.mini-deck').forEach((el) => {
      const d = decks[+el.dataset.deck];
      set(el.querySelector('.t'), clock(d.analysis.duration - d.pos));
      drawOverview(el.querySelector('canvas'), d, { waveH: 40 });
    });
  } else {
    $$('canvas.zoom').forEach((cv) => {
      const d = decks[+cv.dataset.deck];
      if (loading && d.index === 1) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      else drawZoom(cv, d, PX_PER_SEC, HEAD_X, false);
    });
    $$('.deck-panel').forEach((el) => {
      const d = decks[+el.dataset.deck], cv = el.querySelector('canvas');
      if (!cv) return;
      const [t, ms] = clock(d.analysis.duration - d.pos, true);
      set(el.querySelector('.time'), `${t}<small>${ms}</small>`);
      drawOverview(cv, d);
    });
    $$('.deck-info').forEach((el) => {
      const d = decks[+el.dataset.deck], v = el.querySelector('.bars-v');
      const n = (d.pos - d.analysis.firstBeat) / (60 / d.analysis.bpm);
      const txt = loading && d.index === 1 ? '--.-' : Math.floor(n / 4 + 1) + '.' + Math.floor(((n % 4) + 4) % 4 + 1);
      if (v && v.textContent !== txt) v.textContent = txt;
    });
  }
  if (!still) requestAnimationFrame(frame);
}

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const t0 = performance.now();
requestAnimationFrame(frame);
