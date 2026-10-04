// The 1280x800 touch screen: SOURCE, BROWSE and the PLAYING view, drawn from the app state. render() rebuilds
// what changed state touches; frame() runs every animation frame for the clocks and waveforms.
import { FX_CHANNELS } from '../audio/engine.js';
import { memory } from '../lib/library.js';
import { CATEGORIES, ROWS } from './browser.js';
import { drawOverview, drawZoom } from './waveform.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

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

function clock(s, ms) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  const t = String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return ms ? [t, '.' + String(Math.floor((s % 1) * 1000)).padStart(3, '0')] : t;
}

function bpmHtml(deck, master) {
  if (!deck.loaded || !deck.bpm) return '<span class="k">BPM</span>';
  const [i, f] = deck.bpm.toFixed(1).split('.');
  return '<span class="k">BPM</span>' + (master ? '<span class="m">MASTER</span>' : '') +
    `<span class="v">${i}<small>.${f}</small></span>`;
}

export class Screen {
  constructor(app) {
    this.app = app;
    this.el = $('#screen');
    this.wrap = $('#screen-wrap');
    this.view = 'source';
    this.tab = 'fx';
    this.pxPerSec = 150;
    this.grid = false;
    this.cache = new Map(); // element -> last text, so frame() only touches what changed
    this.buildStatic();
    new ResizeObserver(() => this.fit()).observe(this.wrap);
    this.fit();
  }

  fit() {
    const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
    const s = Math.min(w / 1280, h / 800);
    this.scale = s;
    this.el.style.setProperty('--s', s); // the frame (#screen::after) stays the same width at any size
    this.el.style.transform = `translate(${(w - 1280 * s) / 2}px, ${(h - 800 * s) / 2}px) scale(${s})`;
  }

  set(el, html) {
    if (this.cache.get(el) !== html) {
      this.cache.set(el, html);
      el.innerHTML = html;
    }
  }

  setView(v) {
    this.view = v;
    this.el.className = 'view-' + v;
    this.render();
  }

  toast(msg, ms = 1600) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---- static parts and their touch handlers

  buildStatic() {
    const app = this.app;
    $('#cats').innerHTML = CATEGORIES.map((c) =>
      `<button data-cat="${c}"><svg viewBox="0 0 34 34">${ICONS[c]}</svg>${c}</button>`).join('');
    $('#cats').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (b) app.openCategory(b.dataset.cat);
    });
    $('#devices').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]');
      if (!li) return;
      const i = +li.dataset.i;
      if (app.deviceCursor === i) app.push();
      else {
        app.deviceCursor = i;
        this.render();
      }
    });
    for (const side of ['l', 'r']) {
      $('#list-' + side).addEventListener('click', (e) => {
        const li = e.target.closest('li[data-i]');
        if (!li) return;
        const i = +li.dataset.i;
        if (side === 'r') { // a row of the preview column: open the highlighted folder, then pick it
          if (app.browser.push()) app.browser.select(i);
        } else if (app.browser.list.cursor === i) app.push();
        else app.browser.select(i);
        this.render();
      });
    }
    this.bindListSwipe();
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) app.action(b.dataset.act);
    });
    // decks: tap the deck panel to focus it (LOAD from the screen goes to the focused deck); tap the overview to seek.
    // The first tap on an unfocused deck only focuses it, so switching decks never jumps the track
    $$('.deck-panel, .deck-info').forEach((el) => el.addEventListener('pointerdown', (e) => {
      const d = +el.dataset.deck;
      const focused = app.focus === d;
      app.focus = d;
      const cv = el.querySelector('canvas');
      const deck = app.decks[d];
      if (focused && cv && e.target === cv && deck.loaded) {
        const r = cv.getBoundingClientRect();
        deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
      }
      this.render();
    }));
    // the deck strips under SOURCE / BROWSE: tap one to focus it, so a track loads there
    $$('.mini-deck').forEach((el) => el.addEventListener('pointerdown', () => {
      app.focus = +el.dataset.deck;
      this.render();
    }));
    // drag the zoom waveform to scrub (like touching the jog's top while paused)
    $$('canvas.zoom').forEach((cv) => {
      let last = null;
      cv.addEventListener('pointerdown', (e) => {
        last = e.clientX;
        cv.setPointerCapture(e.pointerId);
      });
      cv.addEventListener('pointermove', (e) => {
        if (last == null) return;
        const deck = app.decks[+cv.dataset.deck];
        if (deck.loaded && !deck.playing) deck.seek(deck.position() - (e.clientX - last) / this.scale / this.pxPerSec);
        last = e.clientX;
      });
      cv.addEventListener('pointerup', () => { last = null; });
    });
    this.buildXpad();
    $('#bank').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) app.bank(b.dataset.slot);
    });
  }

  /**
   * Scrolling the track list moves its 12-row window, 1:1 with the finger or the wheel: swipe (flick to coast), or
   * trackpad / mouse wheel. The highlighted row stays put, and a drag never selects a row. iPhones get raw touch
   * events with touchmove cancelled, since Safari can take a pointer drag over for its own panning.
   */
  bindListSwipe() {
    const el = $('#list-l'), b = this.app.browser;
    const rowPx = () => 50 * this.scale; // a row's height on screen
    let drag = null, coast = 0, swallow = false, wheel = 0;
    const scroll = (rows, acc) => { // fractional rows in; scrolls whole rows, keeps the rest; false at either end
      acc.n += rows;
      const n = Math.trunc(acc.n);
      if (!n) return true;
      acc.n -= n;
      const moved = b.scroll(n);
      if (moved) this.render();
      return moved;
    };
    const start = (y, t) => {
      cancelAnimationFrame(coast);
      swallow = false;
      drag = { y, t, n: 0, v: 0, moved: false };
    };
    const move = (y, t) => { // returns true once it's a drag
      if (!drag) return false;
      const dy = drag.y - y;
      if (!drag.moved && Math.abs(dy) < 8) return false;
      drag.moved = true;
      const rows = dy / rowPx(), dt = Math.max(1, t - drag.t);
      drag.v = 0.7 * Math.max(-0.04, Math.min(0.04, rows / dt)) + 0.3 * drag.v; // rows per ms, smoothed and capped
      drag.y = y;
      drag.t = t;
      scroll(rows, drag);
      return true;
    };
    const end = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      swallow = d.moved;
      if (!d.moved) return;
      if (Math.abs(d.v) > 0.004) {
        let last = performance.now();
        const fly = (now) => {
          const dt = now - last;
          last = now;
          d.v *= Math.pow(0.994, dt);
          if (Math.abs(d.v) > 0.001 && scroll(d.v * dt, d)) coast = requestAnimationFrame(fly);
        };
        coast = requestAnimationFrame(fly);
      } else if (Math.abs(d.n) >= 0.5) scroll(Math.sign(d.n) * 0.5, d); // settle on the nearest row
    };
    // touch
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) start(e.touches[0].clientY, e.timeStamp);
      else drag = null;
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      e.preventDefault(); // the list isn't natively scrollable: never let Safari pan or zoom from here
      if (e.touches.length === 1) move(e.touches[0].clientY, e.timeStamp);
    }, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    // mouse / pen drag
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') start(e.clientY, e.timeStamp);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch' || !drag) return;
      const was = drag.moved;
      if (move(e.clientY, e.timeStamp) && !was) el.setPointerCapture(e.pointerId); // not before: it retargets the click
    });
    el.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') end(); });
    el.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') end(); });
    // trackpad / mouse wheel: pixels (or lines, or pages) to rows
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      cancelAnimationFrame(coast);
      const rows = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * 12 : e.deltaY / rowPx();
      const acc = { n: wheel };
      scroll(rows, acc);
      wheel = acc.n;
    }, { passive: false });
    el.addEventListener('click', (e) => { // runs before the row handler (capture)
      if (!swallow) return;
      swallow = false;
      e.stopImmediatePropagation();
    }, true);
  }

  buildXpad() {
    const el = $('#xpad');
    let dragging = false;
    const valueAt = (e) => {
      const m = this.app.engine.beatMeta()?.xpad;
      const r = el.getBoundingClientRect(), x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      return Math.round(m.min + x * (m.max - m.min));
    };
    let momentary = false; // touching the X-PAD with Beat FX off turns it on while held, as on the unit
    const hold = () => {
      const eng = this.app.engine;
      if (!eng.fx.on) {
        momentary = true;
        eng.setBeatFxOn(true);
        this.renderFxPanel();
      }
    };
    const unhold = () => {
      if (!momentary) return;
      momentary = false;
      this.app.engine.setBeatFxOn(false);
      this.renderFxPanel();
    };
    el.addEventListener('pointerdown', (e) => {
      const m = this.app.engine.beatMeta();
      if (m?.xpad?.kind === 'strip') hold();
      else if (e.target.closest('button[data-i]')) {
        hold();
        el.setPointerCapture(e.pointerId);
      }
      if (m?.xpad?.kind === 'strip') {
        dragging = true;
        el.setPointerCapture(e.pointerId);
        this.app.engine.setXpad(valueAt(e));
        this.renderXpad();
      } else {
        const b = e.target.closest('button[data-i]');
        if (b) {
          this.app.engine.setBeat(m.beats[+b.dataset.i].value);
          this.render();
        }
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.app.engine.setXpad(valueAt(e));
      this.renderXpad();
    });
    const up = () => {
      unhold();
      if (!dragging) return;
      dragging = false;
      const m = this.app.engine.beatMeta().xpad;
      this.app.engine.setXpad(m.centre); // the strip springs back when released
      this.renderXpad();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ---- state -> DOM

  render() {
    const app = this.app;
    if (this.view === 'source') this.renderSource();
    if (this.view === 'browse') this.renderBrowse();
    if (this.view === 'playing') this.renderPlaying();
    if (this.view !== 'playing') this.renderMinis();
    app.renderControls();
  }

  renderSource() {
    const app = this.app;
    $('#head-title').textContent = 'SOURCE';
    this.set($('#devices'), app.sources.map((s, i) => {
      const sub = s.status === 'ready' ? s.tracks.length + ' SONGS' : s.status === 'loading' ? 'LOADING…'
        : s.id === 'USB2' ? 'CHOOSE A FOLDER' : s.message || 'TOUCH TO OPEN';
      return `<li data-i="${i}" class="${app.deviceCursor === i ? 'sel' : ''}"><span class="dev-ico"><span class="usb-ico"></span>${s.id}</span>` +
        `<span class="dev-name">${esc(s.label)}</span><span class="dev-sub">${esc(sub)}</span></li>`;
    }).join('') + '<li class="empty"></li>'.repeat(Math.max(0, 6 - app.sources.length)));
    const s = app.sources[app.deviceCursor];
    const rows = [['Songs', s.status === 'ready' ? s.tracks.length : '-'], ['Playlists', s.status === 'ready' ? s.playlists.length : '-'],
      ['Source', s.id === 'USB1' ? 'r2.shawnsingh.me' : 'Local files'],
      ['Status', s.status === 'ready' ? 'Ready' : s.status === 'loading' ? 'Loading' : s.message || 'Not opened']];
    this.set($('#device-info'), rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join(''));
  }

  renderBrowse() {
    const app = this.app, b = app.browser, l = b.list;
    $('#head-src').textContent = b.source?.id || '';
    $('#head-title').textContent = b.stack.length > 1 ? b.stack.slice(1).map((x) => x.title).join(' / ') : l?.title || '';
    $$('#cats button').forEach((btn) => btn.classList.toggle('sel', btn.dataset.cat === b.category));
    $('#col-l').textContent = l?.head || '';
    const loaded = new Set(app.decks.map((d) => d.track?.id));
    const cls = (it, i, sel) => [i === sel ? 'sel' : '', it.track && loaded.has(it.track.id) ? 'loaded' : '',
      it.track && memory.tags.has(it.track.id) ? 'tagged' : '', it.act ? 'action' : ''].join(' ');
    const inner = (it) => (it.meta !== undefined && it.meta !== '' ? `<span class="meta">${esc(it.meta)}</span>` : '') +
      esc(it.label);
    const row = (it, i, sel) => `<li data-i="${i}" class="${cls(it, i, sel)}">${inner(it)}</li>`;
    // the left list keeps its ROWS <li>s and rewrites what's in them: replacing the row under a finger mid-swipe
    // would send the rest of that touch to a detached node (iOS), and the swipe would stop
    const ul = $('#list-l');
    if (ul.children.length !== ROWS) ul.innerHTML = '<li></li>'.repeat(ROWS);
    for (let k = 0; k < ROWS; k++) {
      const li = ul.children[k], i = l ? l.top + k : -1, it = l?.items[i];
      if (it) li.dataset.i = i;
      else delete li.dataset.i;
      li.className = it ? cls(it, i, l.cursor) : '';
      const html = it ? inner(it) : '';
      if (this.cache.get(li) !== html) {
        this.cache.set(li, html);
        li.innerHTML = html;
      }
    }
    // right column: the next level of the highlighted folder, or the highlighted track's details
    const it = b.selected;
    let right = '', head = '';
    if (it?.open) {
      const next = it.open();
      head = next.head;
      right = next.items.slice(0, ROWS).map((x, i) => row(x, i, -1)).join('');
    } else if (it?.track) {
      const t = it.track, d = t.duration;
      head = 'INFO';
      right = [['ARTIST', t.artist], ['ALBUM', t.album], ['GENRE', t.genre], ['BPM', t.bpm ? (+t.bpm).toFixed(1) : ''],
        ['KEY', t.key], ['TIME', d ? clock(d) : ''], ['SOURCE', t.source]]
        .map(([k, v]) => `<li class="kv">${k}<b>${esc(v || '-')}</b></li>`).join('');
    }
    $('#col-r').textContent = head;
    this.set($('#list-r'), right + '<li></li>'.repeat(Math.max(0, ROWS - (right.match(/<li/g) || []).length)));
  }

  renderMinis() {
    const app = this.app;
    $$('.mini-deck').forEach((el) => {
      const d = app.decks[+el.dataset.deck];
      if (!el.firstChild) {
        el.innerHTML = `<span class="lbl"></span><span class="rem">REMAIN</span><span class="t"></span>` +
          `<canvas width="410" height="56"></canvas><span class="nl"></span><div class="bpmbox"></div>`;
      }
      el.classList.toggle('active', app.focus === d.index);
      el.querySelector('.lbl').textContent = 'DECK' + (d.index + 1);
      el.querySelector('.lbl').classList.toggle('waves', !d.loaded && !d.loading);
      el.querySelector('.nl').textContent = d.loading ? 'Loading…' : d.loaded ? '' : d.error || 'Not Loaded.';
      el.querySelector('canvas').style.display = d.loaded ? '' : 'none';
      el.querySelector('.bpmbox').className = 'bpmbox' + (d.master ? '' : ' slave');
      this.set(el.querySelector('.bpmbox'), bpmHtml(d, d.master));
    });
  }

  renderPlaying() {
    const app = this.app;
    $$('.deck-info').forEach((el) => {
      const d = app.decks[+el.dataset.deck];
      el.classList.toggle('active', app.focus === d.index);
      this.set(el, `<div class="dh">DECK ${d.index + 1}</div>` +
        `<div class="src">${d.track ? '<span class="usb-ico"></span>' + esc(d.track.source) : ''}</div>` +
        `<div class="key"><i>b#</i>${esc(d.track?.key || '')}</div><div class="bars"><b class="bars-v">--.-</b>Bars</div><div></div>`);
    });
    $$('.deck-panel').forEach((el) => {
      const d = app.decks[+el.dataset.deck];
      el.classList.toggle('active', app.focus === d.index);
      const loaded = d.loaded;
      const range = d.range >= 100 ? 'WIDE' : d.range + '%';
      this.set(el, `<div class="dk">DECK<b>${d.index + 1}</b></div>` +
        `<div class="title ${d.track ? '' : 'none'}">${esc(d.track ? d.track.title : '')}</div>` +
        `<div class="trk">TRACK<b>${loaded ? String(d.index + 1).padStart(2, '0') : '00'}</b>SINGLE` +
        `<div class="q ${app.quantize ? '' : 'off'}">QUANTIZE</div><div class="qv">1</div></div>` +
        `<div class="hc a">A.HOT CUE</div><div class="hc b">AUTO CUE</div>` +
        `<div class="tl">&bull; REMAIN <span class="dim">/ TIME</span></div><div class="time"></div>` +
        `<div class="mt ${d.masterTempo ? '' : 'off'}">MT</div><div class="tempo-l">TEMPO</div><div class="range ${d.range >= 100 ? 'wide' : ''}">${range}</div><div class="tempo"></div>` +
        `<div class="bpmbox ${d.master ? '' : 'slave'}">${bpmHtml(d, d.master)}</div>` +
        (loaded ? '<canvas width="512" height="58"></canvas>' : d.loading ? '<div class="busy">Loading…</div>'
          : `<div class="nl">${esc(d.error || 'Not Loaded.')}</div>`));
      this.cache.delete(el.querySelector('.time'));
      this.cache.delete(el.querySelector('.tempo'));
    });
    this.renderFxPanel();
    this.renderXpad();
    this.renderBank();
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.act === 'tab-' + this.tab));
    $('[data-act="grid"]').classList.toggle('on', this.grid);
    $('[data-act="zoom"]').classList.toggle('on', this.pxPerSec >= 150);
  }

  renderFxPanel() {
    const app = this.app, e = app.engine, m = e.beatMeta(), panel = $('#fx-panel');
    panel.classList.toggle('on', e.fx.on);
    panel.classList.toggle('status', this.tab === 'status');
    if (this.tab === 'status') {
      const md = app.decks.find((d) => d.master);
      this.set(panel, `<div class="t">STATUS</div><div class="name">${md ? 'DECK ' + (md.index + 1) : '-'}</div>` +
        `<div class="chl">MASTER BPM</div><div class="ch">${md?.bpm ? md.bpm.toFixed(1) : '---.-'}</div>` +
        `<div class="vals"><div style="top:14px">${app.decks[0].tempo ? (app.decks[0].tempo * app.decks[0].range).toFixed(2) : '0.00'}<small>% D1</small></div>` +
        `<div style="top:54px">${app.decks[1].tempo ? (app.decks[1].tempo * app.decks[1].range).toFixed(2) : '0.00'}<small>% D2</small></div>` +
        `<div class="q">X-FADER ${e.xfader < -0.05 ? '<i class="tri l"></i>' : e.xfader > 0.05 ? '<i class="tri r"></i>' : '●'}</div></div>`);
      return;
    }
    const ch = e.fx.channel === 'MASTER' ? 'MASTER' : e.fx.channel.slice(2);
    let vals;
    if (m?.unit === '%') {
      vals = `<div class="big" style="top:30px">${e.fx.beat}<small>%</small></div>` +
        `<div style="top:96px;font-size:14px;right:12px">LEVEL ${Math.round(e.fx.level * 100)}</div>`;
    } else {
      const bpm = app.fxBpm();
      const beat = m?.beats.find((b) => b.value === e.fx.beat)?.label || e.fx.beat;
      const ms = e.beatMs(bpm) ?? '---';
      vals = `<div style="top:14px">${bpm ? bpm.toFixed(1) : '---.-'}<small>BPM</small></div>` +
        `<div style="top:46px">${ms}<small>msec</small></div><div style="top:76px">${beat}<small>BEAT</small></div>`;
    }
    this.set(panel, `<div class="t">BEAT FX</div><div class="name">${esc(m?.name || '-')}</div>` +
      `<div class="chl">CH SELECT</div><div class="ch">${ch}</div><div class="vals">${vals}<div class="q">QUANTIZE</div></div>`);
  }

  renderXpad() {
    const e = this.app.engine, m = e.beatMeta(), el = $('#xpad');
    if (!m) return;
    if (m.xpad?.kind === 'strip') {
      const x = ((e.fx.xpad - m.xpad.min) / (m.xpad.max - m.xpad.min)) * 100;
      el.className = 'xpad touch';
      el.innerHTML = `<span class="lo"><i class="tri l"></i> ${m.xpad.left}</span><span class="mid">${e.fx.xpad === m.xpad.centre ? '' : e.fx.xpad}</span>` +
        `<span class="hi">${m.xpad.right} <i class="tri r"></i></span><i style="left:${x}%"></i>`;
    } else {
      el.className = 'xpad';
      this.set(el, m.beats.slice(0, 8).map((b, i) =>
        `<button data-i="${i}" class="${b.value === e.fx.beat ? 'sel' : ''}">${b.label}</button>`).join(''));
    }
  }

  renderBank() {
    const slots = this.app.bankSlots();
    this.set($('#bank'), slots.map((s, i) =>
      `<button data-slot="${i}" class="${this.app.bankArmed ? 'armed' : ''}">${s ? esc(s.name) + ' ' + s.label : ''}</button>`).join('') +
      '<button class="trash" data-slot="trash" title="Hold a slot to store; CLR clears">CLR</button>');
  }

  // ---- every frame

  frame() {
    const app = this.app;
    const up = Math.floor((performance.now() - this.app.started) / 1000); // session time, like the unit's timer
    const hms = [up / 3600, (up / 60) % 60, up % 60].map((x) => String(Math.floor(x)).padStart(2, '0')).join(':');
    $$('#clock-a, .rec-time').forEach((el) => { if (el.textContent !== hms) el.textContent = hms; });
    if (this.view === 'playing') {
      $$('canvas.zoom').forEach((cv) => drawZoom(cv, app.decks[+cv.dataset.deck], this.pxPerSec, 220, this.grid));
      $$('.deck-panel').forEach((el) => {
        const d = app.decks[+el.dataset.deck];
        if (!d.loaded) return;
        const [t, ms] = clock(d.duration - d.position(), true);
        this.set(el.querySelector('.time'), `${t}<small>${ms}</small>`);
        const pct = d.tempo * d.range;
        const s = (pct >= 0 ? '' : '-') + Math.abs(pct).toFixed(2);
        this.set(el.querySelector('.tempo'), `${s}<small>%</small>`);
        this.set(el.querySelector('.bpmbox'), bpmHtml(d, d.master));
        drawOverview(el.querySelector('canvas'), d);
      });
      $$('.deck-info').forEach((el) => {
        const d = app.decks[+el.dataset.deck], v = el.querySelector('.bars-v');
        if (!v) return;
        let txt = '--.-';
        if (d.loaded && d.analysis.bpm && !d.playing && d.position() < d.cue) {
          const beats = (d.cue - d.position()) / (60 / d.analysis.bpm);
          txt = Math.floor(beats / 4) + '.' + Math.floor(beats % 4 + 1);
        } else if (d.loaded && d.analysis.bpm) {
          const beats = (d.position() - d.analysis.firstBeat) / (60 / d.analysis.bpm);
          txt = beats < 0 ? '--.-' : Math.floor(beats / 4 + 1) + '.' + Math.floor(((beats % 4) + 4) % 4 + 1);
        }
        if (v.textContent !== txt) v.textContent = txt;
      });
    } else {
      $$('.mini-deck').forEach((el) => {
        const d = app.decks[+el.dataset.deck];
        const t = el.querySelector('.t');
        const txt = d.loaded ? clock(d.duration - d.position()) : '00:00';
        if (t && t.textContent !== txt) t.textContent = txt;
        if (d.loaded) drawOverview(el.querySelector('canvas'), d, { waveH: 40 });
      });
    }
  }
}
