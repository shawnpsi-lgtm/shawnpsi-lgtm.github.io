// The demo on shawnsingh.me: the RX3's screen running a quick tour of its menus and effects on a loop, with a finger
// marker where it's being touched. No audio: the tracks are made up here (waveforms drawn from a beat pattern) and
// everything is worked out from the time since the loop started. The drawing and styles are rx3's own
// (ui/waveform.js, css/rx3.css), and the panels are built the way ui/screen.js builds them.
//
// The tour, in seconds (see TOUR below):
//   0     SOURCE: tap USB1
//   0.8   BROWSE: ARTIST, then PLAYLIST, open "shawn", scroll down to "see us in the club", load it to deck 2
//   5     PLAYING: deck 2 loads and drops in on deck 1's next bar
//   6.4   ECHO: hold the X-PAD and slide 1/2 -> 1/4 -> 1/8 -> 1/16
//   9     BEAT FX BANK: FLANGER, swept on the X-PAD strip
//   12.2  BEAT FX BANK: REVERB, LPF -> HPF on the X-PAD while LEVEL rises to 75
//   16.2  deck 2 beat loop: 4 -> 2 -> 1 beat, then out
//   18.5  GRID on, ZOOM out and back in, STATUS, back to BEAT FX
import { WAVE_RATE } from './audio/analyze.js';
import { drawOverview, drawZoom } from './ui/waveform.js';

const LOOP = 24, HEAD_X = 220;

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

// Keys, BPMs and lengths are placeholders; only the titles, and Shawn on "see us in the club", are real.
const T_DIRTY = { title: 'dirty talk', artist: '', key: '8A', bpm: 124, time: 286.7, a: synth(1, 124, 286.7, 0.42, [0.5, 0.8, 1, 0.9, 0.45, 1, 1, 0.8]) };
const T_CLUB = { title: 'see us in the club', artist: 'Shawn', key: '8A', bpm: 126, time: 169.4, a: synth(3, 126, 169.4, 0.12, [0.7, 0.85, 1, 1, 0.5, 1]) };
const LIBRARY = [
  { title: 'all by myself', artist: 'Mita Gami', key: '5A', bpm: 118, time: 209.6 },
  T_DIRTY,
  { title: 'let him go', artist: '', key: '9A', bpm: 122, time: 258.5 },
  { title: 'positive', artist: '', key: '11B', bpm: 120, time: 245.4 },
  T_CLUB,
];
const PLAYLIST = { name: 'shawn', tracks: [T_DIRTY, LIBRARY[2], LIBRARY[3], T_CLUB] };
const ARTISTS = [['Mita Gami', 1], ['Shawn', 1], ['(no artist)', 3]]; // the ARTIST list, grouped as browser.js does

// ---- the tour: when each thing happens (seconds into the loop)
const TOUR = {
  browse: 0.8, playlist: 1.35, open: 2.1, scroll: [2.55, 2.95, 3.35], load: 3.95, playing: 4.9, ready: 5.5,
  echo: [6.4, 8.8], echoBeats: [[6.4, '1/2'], [7.2, '1/4'], [7.8, '1/8'], [8.3, '1/16']],
  flanger: 9.2, flangerHold: [9.7, 11.9], reverb: 12.3, reverbHold: [12.7, 15.6],
  loop: [[16.2, 4], [17.0, 2], [17.6, 1], [18.2, 0]],
  grid: 18.6, zoomOut: 19.5, zoomIn: 20.4, status: 21.1, fxTab: 22.7,
};
// the finger: [down, up, where] — `where` is an element (centre) or a function of time giving [x, y]
const TAPS = [
  [0.3, 0.55, () => el('#devices li')],
  [1.15, 1.4, () => el('#cats button:nth-child(5)')],
  [1.9, 2.1, () => el('#list-l li:nth-child(1)')],
  [2.4, 3.5, (T) => lerp2(el('#list-l li:nth-child(1)'), el('#list-l li:nth-child(4)'), (T - 2.45) / 0.95)], // drag down the list
  [3.75, 3.95, () => el('#list-l li:nth-child(4)')],
  [6.4, 8.8, (T) => xpadButton(beatAt(T))],
  [9.0, 9.2, () => el('#bank button:nth-child(2)')],
  [9.7, 11.9, (T) => stripAt(flangerX(T))],
  [12.1, 12.3, () => el('#bank button:nth-child(3)')],
  [12.7, 15.6, (T) => stripAt(reverbX(T))],
  [18.4, 18.6, () => el('.zoom-grid button:nth-child(3)')],
  [19.3, 19.5, () => el('.zoom-grid button:nth-child(1)')],
  [20.2, 20.4, () => el('.zoom-grid button:nth-child(2)')],
  [20.9, 21.1, () => el('.tabs button:nth-child(1)')],
  [22.5, 22.7, () => el('.tabs button:nth-child(2)')],
];
const BEAT_FACTOR = { '1/16': 1 / 16, '1/8': 1 / 8, '1/4': 1 / 4, '1/2': 1 / 2, '3/4': 3 / 4, 1: 1, 2: 2, 4: 4 };
const lerp = (a, b, k) => a + (b - a) * Math.max(0, Math.min(1, k));
const lerp2 = (p, q, k) => [lerp(p[0], q[0], k), lerp(p[1], q[1], k)];
const ease = (k) => 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, k)));
const beatAt = (T) => TOUR.echoBeats.filter(([t]) => T >= t).pop()?.[1] || '1/2';
// X-PAD strip positions, 0..1 from the left: FLANGER from OFF (right) to FAST and back part way; REVERB centre -> LPF -> HPF
const flangerX = (T) => T < 10.9 ? lerp(0.97, 0.12, ease((T - 9.7) / 1.2)) : lerp(0.12, 0.55, ease((T - 10.9) / 1));
const reverbX = (T) => T < 13.6 ? lerp(0.5, 0.18, ease((T - 12.7) / 0.9)) : lerp(0.18, 0.86, ease((T - 13.6) / 1.8));

// ---- the page
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const set = (e, v) => { if (e && e._v !== v) { e._v = v; e.innerHTML = v; } };
const wrap = $('#screen-wrap'), screen = $('#screen'), finger = $('.finger');
let scale = 1;
function fit() { // as Screen.fit()
  const w = wrap.clientWidth, h = wrap.clientHeight;
  scale = Math.min(w / 1280, h / 800);
  screen.style.setProperty('--s', scale);
  screen.style.transform = `translate(${(w - 1280 * scale) / 2}px, ${(h - 800 * scale) / 2}px) scale(${scale})`;
}
new ResizeObserver(fit).observe(wrap);
fit();
/** An element's centre in the screen's own 1280x800 coordinates. */
function el(sel) {
  const r = $(sel)?.getBoundingClientRect(), s = screen.getBoundingClientRect();
  return r ? [(r.left + r.width / 2 - s.left) / scale, (r.top + r.height / 2 - s.top) / scale] : [640, 400];
}
const xpadButton = (label) => el(`#xpad button[data-b="${label}"]`);
function stripAt(k) {
  const r = $('#xpad').getBoundingClientRect(), s = screen.getBoundingClientRect();
  return [(r.left - s.left + r.width * k) / scale, (r.top + r.height / 2 - s.top) / scale];
}

const clock = (s, ms) => {
  s = Math.max(0, s);
  const t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  return ms ? [t, '.' + String(Math.floor((s % 1) * 1000)).padStart(3, '0')] : t;
};
const MASTER = T_DIRTY.bpm, PER = 60 / MASTER;
const bpmHtml = (master) => '<span class="k">BPM</span>' + (master ? '<span class="m">MASTER</span>' : '') +
  `<span class="v">${Math.floor(MASTER)}<small>.${MASTER.toFixed(1).split('.')[1]}</small></span>`;
const pct = (t) => (MASTER / t.bpm - 1) * 100;
const pctText = (p) => (p >= 0 ? '' : '-') + Math.abs(p).toFixed(2);

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
$('#cats').innerHTML = Object.entries(ICONS).map(([c, i]) => `<button data-cat="${c}"><svg viewBox="0 0 34 34">${i}</svg>${c}</button>`).join('');
$('#bank').innerHTML = ['ECHO 1/2', 'FLANGER 1', 'REVERB 50%', 'FILTER 4'].map((s) => `<button>${s}</button>`).join('') + '<button class="trash">CLR</button>';

// ---- decks: what drawZoom / drawOverview read (analysis, position(), cue, loop)
const deck = (index) => ({ index, t: null, cue: 0, pos: 0, loop: null, get analysis() { return this.t?.a; }, position() { return this.pos; } });
const decks = [deck(0), deck(1)];
decks[0].t = T_DIRTY;
const s1 = T_DIRTY.a.firstBeat + 64 * PER, sClub = T_CLUB.a.firstBeat;
decks[0].cue = s1;
const dropAt = Math.ceil((TOUR.ready + 0.6) / (4 * PER)) * 4 * PER; // deck 1's next bar after deck 2 is ready
const rate2 = MASTER / T_CLUB.bpm; // deck 2 synced to deck 1

function deckPanels(state2) { // as Screen.renderPlaying() / renderMinis(); state2: 'empty' | 'loading' | 'ready'
  const st = (d) => d.index === 0 ? 'ready' : state2;
  $$('.deck-info').forEach((e) => {
    const d = decks[+e.dataset.deck], ready = st(d) === 'ready';
    e.classList.toggle('active', d.index === 1);
    set(e, `<div class="dh">DECK ${d.index + 1}</div><div class="src">${ready ? '<span class="usb-ico"></span>USB1' : ''}</div>` +
      `<div class="key"><i>b#</i>${ready ? d.t.key : ''}</div><div class="bars"><b class="bars-v">--.-</b>Bars</div><div></div>`);
  });
  $$('.deck-panel').forEach((e) => {
    const d = decks[+e.dataset.deck], s = st(d), ready = s === 'ready';
    e.classList.toggle('active', d.index === 1);
    const title = s === 'empty' ? '' : d.t.title;
    set(e, `<div class="dk">DECK<b>${d.index + 1}</b></div><div class="title ${title ? '' : 'none'}">${title}</div>` +
      `<div class="trk">TRACK<b>${ready ? String(LIBRARY.indexOf(d.t) + 1).padStart(2, '0') : '00'}</b>SINGLE<div class="q">QUANTIZE</div><div class="qv">1</div></div>` +
      '<div class="hc a">A.HOT CUE</div><div class="hc b">AUTO CUE</div>' +
      '<div class="tl">&bull; REMAIN <span class="dim">/ TIME</span></div><div class="time"></div>' +
      '<div class="mt">MT</div><div class="tempo-l">TEMPO</div><div class="range">10%</div>' +
      `<div class="tempo">${ready ? pctText(pct(d.t)) + '<small>%</small>' : ''}</div>` +
      `<div class="bpmbox ${d.index ? 'slave' : ''}">${ready ? bpmHtml(d.index === 0) : '<span class="k">BPM</span>'}</div>` +
      (ready ? '<canvas width="512" height="58"></canvas>' : s === 'loading' ? '<div class="busy">Loading…</div>' : '<div class="nl">Not Loaded.</div>'));
  });
  $$('.mini-deck').forEach((e) => {
    const d = decks[+e.dataset.deck], s = st(d);
    e.classList.toggle('active', d.index === 1);
    set(e, `<span class="lbl ${s === 'empty' ? 'waves' : ''}">DECK${d.index + 1}</span><span class="rem">REMAIN</span><span class="t">00:00</span>` +
      `<canvas width="410" height="56" style="${s === 'ready' ? '' : 'display:none'}"></canvas>` +
      `<span class="nl">${s === 'loading' ? 'Loading…' : s === 'empty' ? 'Not Loaded.' : ''}</span>` +
      `<div class="bpmbox ${d.index ? 'slave' : ''}">${s === 'ready' ? bpmHtml(d.index === 0) : '<span class="k">BPM</span>'}</div>`);
  });
}

function source() { // Screen.renderSource()
  set($('#devices'), '<li class="sel"><span class="dev-ico"><span class="usb-ico"></span>USB1</span><span class="dev-name">R2 MUSIC</span><span class="dev-sub">5 SONGS</span></li>' +
    '<li><span class="dev-ico"><span class="usb-ico"></span>USB2</span><span class="dev-name">THIS COMPUTER</span><span class="dev-sub">CHOOSE A FOLDER</span></li>' +
    '<li class="empty"></li>'.repeat(4));
  set($('#device-info'), [['Songs', 5], ['Playlists', 1], ['Source', 'r2.shawnsingh.me'], ['Status', 'Ready']]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join(''));
}

function browse(T) { // Screen.renderBrowse(): ARTIST, then PLAYLIST, then the "shawn" playlist's tracks
  const info = (t) => [['ARTIST', t.artist], ['ALBUM', ''], ['GENRE', ''], ['BPM', t.bpm.toFixed(1)], ['KEY', t.key],
    ['TIME', clock(t.time)], ['SOURCE', 'USB1']].map(([k, v]) => `<li class="kv">${k}<b>${v || '-'}</b></li>`).join('');
  const rows = (items, cursor, loaded) => Array.from({ length: 12 }, (_, i) => {
    const it = items[i];
    return it ? `<li class="${i === cursor ? 'sel' : ''} ${loaded === i || it.track === T_DIRTY ? 'loaded' : ''}">` +
      (it.meta !== undefined ? `<span class="meta">${it.meta}</span>` : '') + it.label + '</li>' : '<li></li>';
  }).join('');
  let cat, title, head, items, cursor = 0, right, rhead, loaded = -1;
  if (T < TOUR.playlist) {
    cat = 'ARTIST'; title = 'ARTIST'; head = 'ARTIST';
    items = ARTISTS.map(([a, n]) => ({ label: a, meta: n }));
    rhead = 'TRACK'; right = `<li><span class="meta">Mita Gami</span>all by myself</li>`;
  } else if (T < TOUR.open) {
    cat = 'PLAYLIST'; title = 'PLAYLIST'; head = 'PLAYLIST';
    items = [{ label: PLAYLIST.name, meta: PLAYLIST.tracks.length }];
    rhead = 'TRACK'; right = PLAYLIST.tracks.map((t) => `<li class="${t === T_DIRTY ? 'loaded' : ''}">${t.artist ? `<span class="meta">${t.artist}</span>` : ''}${t.title}</li>`).join('');
  } else {
    cat = 'PLAYLIST'; title = PLAYLIST.name; head = 'TRACK';
    items = PLAYLIST.tracks.map((t) => ({ label: t.title, meta: t.artist || undefined, track: t }));
    cursor = TOUR.scroll.filter((t) => T >= t).length;
    if (T >= TOUR.load) loaded = cursor;
    rhead = 'INFO'; right = info(PLAYLIST.tracks[cursor]);
  }
  $$('#cats button').forEach((b) => b.classList.toggle('sel', b.dataset.cat === cat));
  set($('#head-title'), title);
  set($('#col-l'), head);
  set($('#col-r'), rhead);
  set($('#list-l'), rows(items, cursor, loaded));
  set($('#list-r'), right + '<li></li>'.repeat(Math.max(0, 12 - (right.match(/<li/g) || []).length)));
}

function fxPanel(T) { // Screen.renderFxPanel() and renderXpad(), for the effect and tab the tour is on
  const panel = $('#fx-panel'), xp = $('#xpad');
  const inside = ([a, b]) => T >= a && T < b;
  if (T >= TOUR.status && T < TOUR.fxTab) {
    panel.classList.remove('on');
    panel.classList.add('status');
    set(panel, `<div class="t">STATUS</div><div class="name">DECK 1</div><div class="chl">MASTER BPM</div><div class="ch">${MASTER.toFixed(1)}</div>` +
      `<div class="vals"><div style="top:14px">0.00<small>% D1</small></div><div style="top:54px">${pctText(pct(T_CLUB))}<small>% D2</small></div>` +
      '<div class="q">X-FADER ●</div></div>');
  } else {
    panel.classList.remove('status');
    const fx = T >= TOUR.reverb ? 'REVERB' : T >= TOUR.flanger ? 'FLANGER' : 'ECHO';
    const on = fx === 'ECHO' ? inside(TOUR.echo) : fx === 'FLANGER' ? inside(TOUR.flangerHold) : inside(TOUR.reverbHold);
    panel.classList.toggle('on', on);
    let vals;
    if (fx === 'REVERB') {
      const level = T < TOUR.reverbHold[0] ? 50 : Math.round(lerp(50, 75, (T - TOUR.reverbHold[0]) / 2.2));
      vals = `<div class="big" style="top:30px">50<small>%</small></div><div style="top:96px;font-size:14px;right:12px">LEVEL ${level}</div>`;
    } else {
      const beat = fx === 'ECHO' ? beatAt(T) : '1', f = BEAT_FACTOR[beat];
      vals = `<div style="top:14px">${MASTER.toFixed(1)}<small>BPM</small></div><div style="top:46px">${Math.round(PER * 1000 * f)}<small>msec</small></div>` +
        `<div style="top:76px">${beat}<small>BEAT</small></div>`;
    }
    set(panel, `<div class="t">BEAT FX</div><div class="name">${fx}</div><div class="chl">CH SELECT</div><div class="ch">2</div>` +
      `<div class="vals">${vals}<div class="q">QUANTIZE</div></div>`);
    if (fx === 'ECHO') {
      xp.className = 'xpad';
      set(xp, ['1/16', '1/8', '1/4', '1/2', '3/4', '1', '2', '4'].map((b) =>
        `<button data-b="${b}" class="${b === beatAt(T) ? 'sel' : ''}">${b}</button>`).join(''));
    } else {
      // the strip: FLANGER rests at OFF (right), REVERB at the centre; the value shows while it's away from rest
      const [lo, hi, rest, k] = fx === 'FLANGER'
        ? ['FAST', 'OFF', 1, inside(TOUR.flangerHold) ? flangerX(T) : 1]
        : ['LPF', 'HPF', 0.5, inside(TOUR.reverbHold) ? reverbX(T) : 0.5];
      xp.className = 'xpad touch';
      const v = Math.round(k * 255), mid = Math.abs(k - rest) > 0.01 ? v : '';
      set(xp, `<span class="lo">${lo}</span><span class="mid">${mid}</span><span class="hi">${hi}</span><i style="left:${(k * 100).toFixed(2)}%"></i>`);
    }
  }
  $$('.tabs button').forEach((b, i) => b.classList.toggle('on', (T >= TOUR.status && T < TOUR.fxTab) === (i === 0)));
}

// ---- every frame
let last2 = '';
function frame(now) {
  const T = still ? 7 : ((now - t0) / 1000) % LOOP;
  const view = T < TOUR.browse ? 'source' : T < TOUR.playing ? 'browse' : 'playing';
  if (screen.className !== 'view-' + view) screen.className = 'view-' + view;

  // decks: deck 1 plays throughout; deck 2 is empty until "see us in the club" loads, then drops in on the bar
  decks[0].pos = s1 + T;
  const state2 = T < TOUR.load ? 'empty' : T < TOUR.ready ? 'loading' : 'ready';
  decks[1].t = T_CLUB;
  decks[1].cue = sClub;
  const raw = T < dropAt ? sClub : sClub + (T - dropAt) * rate2;
  const len = (TOUR.loop.filter(([t]) => T >= t).pop() || [0, 0])[1];
  if (len && T >= TOUR.loop[0][0]) { // the loop starts on deck 2's beat at TOUR.loop[0][0], then halves from there
    const per2 = 60 / T_CLUB.bpm, start = sClub + Math.round(((TOUR.loop[0][0] - dropAt) * rate2) / per2) * per2;
    decks[1].loop = { start, end: start + len * per2 };
    decks[1].pos = start + ((((raw - start) % (len * per2)) + len * per2) % (len * per2));
  } else {
    decks[1].loop = null;
    decks[1].pos = raw;
  }
  if (state2 !== last2) { last2 = state2; deckPanels(state2); }

  const up = Math.floor(754 + T), hms = [up / 3600, (up / 60) % 60, up % 60].map((x) => String(Math.floor(x)).padStart(2, '0')).join(':');
  $$('#clock-a, .rec-time').forEach((e) => { if (e.textContent !== hms) e.textContent = hms; });
  set($('#head-src'), view === 'source' ? '' : 'USB1');

  if (view === 'source') {
    set($('#head-title'), 'SOURCE');
    source();
  } else if (view === 'browse') {
    browse(T);
  }
  if (view !== 'playing') {
    $$('.mini-deck').forEach((e) => {
      const d = decks[+e.dataset.deck];
      if (d.index === 1 && state2 !== 'ready') return;
      set(e.querySelector('.t'), clock(d.analysis.duration - d.pos));
      drawOverview(e.querySelector('canvas'), d, { waveH: 40 });
    });
  } else {
    const grid = T >= TOUR.grid, px = T >= TOUR.zoomOut && T < TOUR.zoomIn ? 60 : 150;
    $('.zoom-grid button:nth-child(3)').classList.toggle('on', grid);
    $('.zoom-grid button:nth-child(2)').classList.toggle('on', px >= 150);
    $$('canvas.zoom').forEach((cv) => {
      const d = decks[+cv.dataset.deck];
      if (d.index === 1 && state2 !== 'ready') cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
      else drawZoom(cv, d, px, HEAD_X, grid);
    });
    $$('.deck-panel').forEach((e) => {
      const d = decks[+e.dataset.deck], cv = e.querySelector('canvas');
      if (!cv) return;
      const [t, ms] = clock(d.analysis.duration - d.pos, true);
      set(e.querySelector('.time'), `${t}<small>${ms}</small>`);
      drawOverview(cv, d);
    });
    $$('.deck-info').forEach((e) => {
      const d = decks[+e.dataset.deck], v = e.querySelector('.bars-v');
      let txt = '--.-';
      if (d.index === 0 || state2 === 'ready') {
        const n = (d.pos - d.analysis.firstBeat) / (60 / d.analysis.bpm);
        txt = Math.floor(n / 4 + 1) + '.' + Math.floor(((n % 4) + 4) % 4 + 1);
      }
      if (v && v.textContent !== txt) v.textContent = txt;
    });
    fxPanel(T);
  }

  // the finger
  const tap = still ? null : TAPS.find(([a, b]) => T >= a && T < b);
  finger.classList.toggle('down', !!tap);
  if (tap) {
    const [x, y] = typeof tap[2] === 'function' ? (tap[2].length ? tap[2](T) : tap[2]()) : tap[2];
    finger.style.left = x + 'px';
    finger.style.top = y + 'px';
  }
  if (!still) requestAnimationFrame(frame);
}

const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
const t0 = performance.now();
requestAnimationFrame(frame);
