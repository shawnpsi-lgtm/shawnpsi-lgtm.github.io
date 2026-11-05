// The demo on shawnsingh.me/project-rx3.html: the RX3's playing screen with two tracks mixing, as if someone is DJing.
// The tracks are decoded and analyzed with rx3's own code (no sound, so no click is needed to start), and both
// playheads run on the clock: deck 1 is the master, deck 2 is synced to its BPM and lined up on the beat. Every so
// often deck 2 rolls a beat loop and the ECHO goes on, the way a DJ would work the mix.
import { analyze } from './audio/analyze.js';
import { drawOverview, drawZoom } from './ui/waveform.js';

const TRACKS = [
  { src: '/audio/dirty-talk.m4a', title: 'dirty talk', key: '8A', at: 64 }, // `at`: the beat to start from
  { src: '/audio/let-him-go.m4a', title: 'let him go', key: '9A', at: 96 },
];
const PX_PER_SEC = 150, HEAD_X = 220; // the screen's ZOOM setting and playhead, as in ui/screen.js
const XPAD = [['1/8', 0.125], ['1/4', 0.25], ['1/2', 0.5], ['3/4', 0.75], ['1', 1], ['2', 2], ['4', 4], ['8', 8]]; // ECHO's X-PAD, in order

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- fit the 1280x800 screen to the window, as Screen.fit() does
const wrap = $('#screen-wrap'), screen = $('#screen');
function fit() {
  const w = wrap.clientWidth, h = wrap.clientHeight, s = Math.min(w / 1280, h / 800);
  screen.style.setProperty('--s', s);
  screen.style.transform = `translate(${(w - 1280 * s) / 2}px, ${(h - 800 * s) / 2}px) scale(${s})`;
}
new ResizeObserver(fit).observe(wrap);
fit();

function clock(s, ms) {
  s = Math.max(0, s);
  const t = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  return ms ? [t, '.' + String(Math.floor((s % 1) * 1000)).padStart(3, '0')] : t;
}
function bpmHtml(bpm, master) {
  const [i, f] = bpm.toFixed(1).split('.');
  return '<span class="k">BPM</span>' + (master ? '<span class="m">MASTER</span>' : '') + `<span class="v">${i}<small>.${f}</small></span>`;
}

// ---- decks: what drawZoom / drawOverview read (analysis, position(), cue, loop)
const decks = TRACKS.map((t, index) => ({ index, track: t, analysis: null, cue: 0, loop: null, pos: 0, position() { return this.pos; } }));

function panels(state) {
  $$('.deck-info').forEach((el) => {
    const d = decks[+el.dataset.deck];
    el.classList.toggle('active', d.index === 0);
    el.innerHTML = `<div class="dh">DECK ${d.index + 1}</div><div class="src"><span class="usb-ico"></span>R2 MUSIC</div>` +
      `<div class="key"><i>b#</i>${d.track.key}</div><div class="bars"><b class="bars-v">--.-</b>Bars</div><div></div>`;
  });
  $$('.deck-panel').forEach((el) => {
    const d = decks[+el.dataset.deck], ready = !!d.analysis;
    el.classList.toggle('active', d.index === 0);
    el.innerHTML = `<div class="dk">DECK<b>${d.index + 1}</b></div><div class="title">${d.track.title}</div>` +
      `<div class="trk">TRACK<b>${String(d.index + 1).padStart(2, '0')}</b>SINGLE<div class="q">QUANTIZE</div><div class="qv">1</div></div>` +
      '<div class="hc a">A.HOT CUE</div><div class="hc b">AUTO CUE</div>' +
      '<div class="tl">&bull; REMAIN <span class="dim">/ TIME</span></div><div class="time"></div>' +
      '<div class="mt">MT</div><div class="tempo-l">TEMPO</div><div class="range">10%</div><div class="tempo"></div>' +
      `<div class="bpmbox ${d.index ? 'slave' : ''}"><span class="k">BPM</span></div>` +
      (ready ? '<canvas width="512" height="58"></canvas>' : `<div class="busy">${state}</div>`);
  });
  $('#bank').innerHTML = ['ECHO 1/2', 'REVERB 50%', 'FILTER 4', ''].map((s) => `<button>${s}</button>`).join('') + '<button class="trash">CLR</button>';
}

function fxPanel(on, bpm, beat) {
  const panel = $('#fx-panel');
  panel.classList.toggle('on', on);
  const ms = Math.round((60000 / bpm) * XPAD.find(([l]) => l === beat)[1]);
  const html = '<div class="t">BEAT FX</div><div class="name">ECHO</div><div class="chl">CH SELECT</div><div class="ch">2</div>' +
    `<div class="vals"><div style="top:14px">${bpm.toFixed(1)}<small>BPM</small></div><div style="top:46px">${ms}<small>msec</small></div>` +
    `<div style="top:76px">${beat}<small>BEAT</small></div><div class="q">QUANTIZE</div></div>`;
  if (panel._html !== html) panel.innerHTML = panel._html = html;
  const pads = XPAD.map(([b]) => b).map((b) => `<button class="${b === beat ? 'sel' : ''}">${b}</button>`).join('');
  const xp = $('#xpad');
  if (xp._html !== pads) { xp.className = 'xpad'; xp.innerHTML = xp._html = pads; }
}

const set = (el, v) => { if (el && el._v !== v) { el._v = v; el.innerHTML = v; } };

async function load(t) {
  const buf = await fetch(t.src).then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
  const audio = await new OfflineAudioContext(2, 44100, 44100).decodeAudioData(buf);
  return analyze(audio, {});
}

async function start() {
  panels('Loading…');
  try {
    const out = await Promise.all(TRACKS.map(load));
    out.forEach((a, i) => { decks[i].analysis = a; });
  } catch {
    panels('Not Loaded.');
    return;
  }
  panels();
  const [a, b] = decks.map((d) => d.analysis);
  const master = a.bpm || 124, other = b.bpm || master;
  const rate = master / other; // deck 2's tempo, synced to deck 1
  const p1 = 60 / master, p2 = 60 / other;
  const s1 = a.firstBeat + TRACKS[0].at * p1, s2 = b.firstBeat + TRACKS[1].at * p2;
  decks[0].cue = s1;
  decks[1].cue = s2;
  // the stretch both decks loop over before starting again, a whole number of bars that fits in both tracks
  const span = Math.floor(Math.min(a.duration - s1 - 8, (b.duration - s2 - 8) / rate) / (p1 * 16)) * p1 * 16;
  const tempo = ((rate - 1) * 100).toFixed(2);
  set($('.deck-panel[data-deck="0"] .tempo'), '0.00<small>%</small>');
  set($('.deck-panel[data-deck="1"] .tempo'), `${tempo}<small>%</small>`);
  set($('.deck-panel[data-deck="0"] .bpmbox'), bpmHtml(master, true));
  set($('.deck-panel[data-deck="1"] .bpmbox'), bpmHtml(master, false));

  const t0 = performance.now();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(now) {
    const T = (still ? 30 : (now - t0) / 1000) % span;
    const beat = T / p1; // master beats since the start of the stretch
    decks[0].pos = s1 + T;
    // deck 2: a 1-beat loop rolls for the last 4 beats of every 32, then the track slips back to where it would be
    const raw = s2 + T * rate, b32 = beat % 32;
    if (b32 >= 28) {
      const loopStart = s2 + (beat - (b32 - 28)) * p2; // deck 2's time at master beat 28 of this 32
      decks[1].loop = { start: loopStart, end: loopStart + p2 };
      decks[1].pos = loopStart + ((raw - loopStart) % p2);
    } else {
      decks[1].loop = null;
      decks[1].pos = raw;
    }
    // ECHO on deck 2 for beats 12-20 of every 32, at 1/2 beat; 3/4 for the second half
    const b = Math.floor(b32);
    fxPanel(b >= 12 && b < 20, master, b >= 16 && b < 20 ? '3/4' : '1/2');

    $$('canvas.zoom').forEach((cv) => drawZoom(cv, decks[+cv.dataset.deck], PX_PER_SEC, HEAD_X, false));
    $$('.deck-panel').forEach((el) => {
      const d = decks[+el.dataset.deck];
      const [t, ms] = clock(d.analysis.duration - d.pos, true);
      set(el.querySelector('.time'), `${t}<small>${ms}</small>`);
      drawOverview(el.querySelector('canvas'), d);
    });
    $$('.deck-info').forEach((el) => {
      const d = decks[+el.dataset.deck], per = 60 / d.analysis.bpm;
      const n = (d.pos - d.analysis.firstBeat) / per;
      el.querySelector('.bars-v').textContent = Math.floor(n / 4 + 1) + '.' + Math.floor(((n % 4) + 4) % 4 + 1);
    });
    const up = Math.floor(T + 754); // the session timer, as if the set has been going a while
    const hms = [up / 3600, (up / 60) % 60, up % 60].map((x) => String(Math.floor(x)).padStart(2, '0')).join(':');
    $$('.rec-time').forEach((el) => { if (el.textContent !== hms) el.textContent = hms; });
    if (!still) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame); // browsers pause this in background tabs on their own
}

start();
