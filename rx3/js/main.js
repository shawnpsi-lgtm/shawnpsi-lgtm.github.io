// Wires the engine, the decks, the library and the screen to the buttons, knobs and keyboard.
import { Deck, TEMPO_RANGES } from './audio/deck.js';
import { BEAT_FX, COLOR_FX, Engine, FX_CHANNELS } from './audio/engine.js';
import { FolderSource, memory, R2Source } from './lib/library.js';
import { Browser } from './ui/browser.js';
import { Screen } from './ui/screen.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// keyboard, as in the local viewer (rx3_viewer.py), plus a few for the mixer
const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', Enter: 'push', Escape: 'back', Backspace: 'back',
  '1': ['load', 0], '2': ['load', 1], q: ['play', 0], p: ['play', 1], w: ['cue', 0], o: ['cue', 1],
  s: 'source', b: 'browse', t: 'taglist', l: 'playlist', f: 'search', m: 'menu', i: 'info', g: 'tag',
  e: 'fx', '[': 'beat-down', ']': 'beat-up', x: 'mute', h: 'hide',
  a: ['nudge-', 0], d: ['nudge+', 0], k: ['nudge-', 1], ';': ['nudge+', 1],
};

class App {
  constructor(engine) {
    this.engine = engine;
    this.decks = [0, 1].map((i) => new Deck(engine, i, () => this.changed()));
    this.sources = [new R2Source(), new FolderSource()];
    this.deviceCursor = 0;
    this.browser = new Browser();
    this.focus = 0;
    this.quantize = true;
    this.muted = false;
    this.bankArmed = false;
    this.started = performance.now();
    this.screen = new Screen(this);
    this.buildControls();
    this.bindMobile();
    this.bindKeys();
    this.bindFiles();
    this.screen.render();
    this.loop();
    this.sources[0].open().then(() => this.screen.render());
  }

  changed() {
    this.pickMaster();
    this.engine.setBpm(this.fxBpm());
    this.browser.refresh(() => this.masterBpm());
    this.screen.render();
  }

  /** The master deck: the one playing (deck 1 if both), else the last one that was. */
  pickMaster() {
    const playing = this.decks.filter((d) => d.playing && d.loaded);
    const m = playing[0] || this.decks.find((d) => d.master && d.loaded) || this.decks.find((d) => d.loaded);
    this.decks.forEach((d) => { d.master = d === m; });
  }

  masterBpm() {
    return this.decks.find((d) => d.master)?.bpm || 0;
  }

  /** Beat FX tempo: the selected channel's deck, or the master deck for MASTER. */
  fxBpm() {
    const ch = this.engine.fx.channel;
    const d = ch === 'MASTER' ? this.decks.find((x) => x.master) : this.decks[+ch.slice(2) - 1];
    return d?.bpm || this.masterBpm() || 0;
  }

  // ---- the buttons

  key(name, deck, down = true) {
    const e = this.engine, b = this.browser, s = this.screen;
    if (!down) {
      if (name === 'cue') this.decks[deck].cueUp();
      if (name.startsWith('nudge')) this.decks[deck].setNudge(0);
      return;
    }
    e.resume();
    switch (name) {
      case 'source': return s.setView('source');
      case 'browse':
        if (s.view === 'browse') return s.setView('playing');
        if (!b.list) return s.setView('source');
        return s.setView('browse');
      case 'taglist': return this.tagList();
      case 'playlist': return this.openCategory('PLAYLIST');
      case 'search': return this.search();
      case 'menu': return this.menu();
      case 'info': return this.info();
      case 'tag': {
        const t = s.view === 'browse' ? b.selected?.track : this.decks[this.focus].track;
        if (!t) return;
        memory.toggleTag(t);
        s.toast(memory.tags.has(t.id) ? 'ADDED TO TAG LIST' : 'REMOVED FROM TAG LIST');
        return s.render();
      }
      case 'back':
        if (this.closeOverlay()) return;
        if (s.view === 'browse' && !b.back()) return s.setView('source');
        return s.render();
      case 'up': case 'down': {
        const d = name === 'up' ? -1 : 1;
        if (s.view === 'source') this.deviceCursor = Math.max(0, Math.min(this.sources.length - 1, this.deviceCursor + d));
        else if (s.view === 'browse') b.move(d);
        else return;
        return s.render();
      }
      case 'push': return this.push();
      case 'load': return this.load(deck);
      case 'play': return this.decks[deck].play();
      case 'cue': return this.decks[deck].cueDown();
      case 'nudge-': case 'nudge+': return this.decks[deck].setNudge(name === 'nudge+' ? 1 : -1);
      case 'sync': return this.decks[deck].sync(this.decks[1 - deck]);
      case 'fx': {
        e.setBeatFxOn(!e.fx.on);
        return s.render();
      }
      case 'beat-down': case 'beat-up':
        e.stepBeat(name === 'beat-up' ? 1 : -1);
        return s.render();
      case 'mute':
        this.muted = !this.muted;
        e.setMaster(this.muted ? 0 : +$('#master').value);
        return this.renderControls();
      case 'hide': return $('#app').classList.toggle('compact');
    }
  }

  push() {
    const s = this.screen;
    if (s.view === 'source') return this.openSource(this.sources[this.deviceCursor]);
    if (s.view === 'browse') {
      if (!this.browser.push()) { // a track: PUSH loads it to the focused deck, as touching LOAD on screen would
        const t = this.browser.selected?.track;
        if (t) return this.load(this.focus);
      }
      return s.render();
    }
  }

  async openSource(src) {
    const s = this.screen;
    if (src.id === 'USB2' && src.status !== 'ready') return this.pickFolder();
    if (src.status === 'signin') return location.assign(src.signInUrl);
    if (src.status === 'connect') return window.open('https://r2.shawnsingh.me', '_blank', 'noopener');
    if (src.status !== 'ready') {
      src.status = 'empty';
      s.render();
      await src.open();
      s.render();
      if (src.status !== 'ready') return s.toast(src.message || 'COULD NOT OPEN');
    }
    this.browser.root(src, 'TRACK', () => this.masterBpm());
    s.setView('browse');
  }

  openCategory(cat) {
    const src = this.browser.source || this.sources.find((x) => x.status === 'ready');
    if (!src) return this.screen.setView('source');
    this.browser.root(src, cat, () => this.masterBpm());
    this.screen.setView('browse');
  }

  tagList() {
    const all = this.sources.flatMap((s) => s.tracks).filter((t) => memory.tags.has(t.id));
    this.browser.special({ title: 'TAG LIST', head: 'TRACK', items: all.map((t) => ({ label: t.title, meta: t.artist, track: t })) });
    if (!this.browser.source) this.browser.source = this.sources.find((x) => x.status === 'ready') || null;
    this.screen.setView('browse');
  }

  search() {
    const src = this.browser.source || this.sources.find((x) => x.status === 'ready');
    if (!src) return this.screen.setView('source');
    this.browser.source = src;
    const box = $('#search'), input = $('#search-input');
    const run = () => {
      const q = input.value.trim().toLowerCase();
      const hits = src.tracks.filter((t) => !q || (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q));
      this.browser.special({ title: 'SEARCH: ' + (input.value || ''), head: 'TRACK',
        items: hits.map((t) => ({ label: t.title, meta: t.artist, track: t })) });
      this.screen.render();
    };
    input.oninput = run;
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === 'Escape' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        box.hidden = true;
        input.blur();
      }
      ev.stopPropagation();
    };
    box.hidden = false;
    run();
    this.screen.setView('browse');
    input.focus();
    input.select();
  }

  load(i) {
    const s = this.screen;
    const t = s.view === 'browse' ? this.browser.selected?.track : null;
    if (!t) return s.toast('SELECT A TRACK');
    const deck = this.decks[i];
    if (deck.playing) return s.toast('DECK ' + (i + 1) + ' IS PLAYING');
    memory.played(t);
    this.focus = i;
    deck.load(t);
    this.engine.resume();
  }

  action(act) {
    const s = this.screen;
    switch (act) {
      case 'info': return this.info();
      case 'zoom': s.pxPerSec = s.pxPerSec >= 300 ? 150 : 300; break;
      case 'zoom-out': s.pxPerSec = s.pxPerSec > 75 ? s.pxPerSec / 2 : 300; break;
      case 'grid': s.grid = !s.grid; break;
      case 'tab-status': s.tab = 'status'; break;
      case 'tab-fx': s.tab = 'fx'; break;
    }
    s.render();
  }

  // ---- BEAT FX BANK: four stored effect setups

  bankSlots() {
    const slots = JSON.parse(localStorage.getItem('rx3.bank') || '[null,null,null,null]');
    return slots.map((x) => x && BEAT_FX.some((m) => m.name === x.name) ? x : null);
  }

  bank(slot) {
    const slots = this.bankSlots(), e = this.engine;
    if (slot === 'trash') this.bankArmed = !this.bankArmed;
    else if (this.bankArmed) {
      slots[slot] = null;
      this.bankArmed = false;
    } else if (!slots[slot]) {
      const m = e.beatMeta();
      slots[slot] = { name: e.fx.name, beat: e.fx.beat, level: e.fx.level, channel: e.fx.channel,
        label: m.beats.find((b) => b.value === e.fx.beat)?.label || '' };
      this.screen.toast('STORED IN BANK ' + (+slot + 1));
    } else {
      const x = slots[slot];
      e.selectBeatFx(x.name);
      e.setBeat(x.beat);
      e.setLevel(x.level);
      e.routeBeatFx(x.channel);
    }
    localStorage.setItem('rx3.bank', JSON.stringify(slots));
    this.screen.render();
  }

  // ---- overlays: MENU, INFO

  closeOverlay() {
    const m = $('.menu');
    if (!m) return false;
    m.remove();
    return true;
  }

  overlay(title, rows) {
    this.closeOverlay();
    const el = document.createElement('div');
    el.className = 'menu';
    el.innerHTML = `<h2>${title}</h2><button class="close">&times;</button>` + rows.join('');
    el.querySelector('.close').onclick = () => el.remove();
    $('#screen').appendChild(el);
    return el;
  }

  menu() {
    if (this.closeOverlay()) return;
    const row = (label, opts, cur, fn) => `<div class="row">${label}<div>${opts.map((o, i) =>
      `<button data-fn="${fn}" data-v="${i}" class="${o.v === cur ? 'sel' : ''}">${o.label}</button>`).join('')}</div></div>`;
    const ranges = TEMPO_RANGES.map((r) => ({ v: r, label: r >= 100 ? 'WIDE' : '±' + r }));
    const el = this.overlay('MENU', [
      row('DECK 1 TEMPO RANGE', ranges, this.decks[0].range, 'r0'),
      row('DECK 2 TEMPO RANGE', ranges, this.decks[1].range, 'r1'),
      row('QUANTIZE', [{ v: true, label: 'ON' }, { v: false, label: 'OFF' }], this.quantize, 'q'),
      row('USB2 (THIS COMPUTER)', [{ v: 0, label: 'FOLDER…' }, { v: 1, label: 'FILES…' }], -1, 'usb2'),
    ]);
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-fn]');
      if (!b) return;
      const v = +b.dataset.v, fn = b.dataset.fn;
      if (fn === 'r0' || fn === 'r1') this.decks[+fn[1]].setRange(TEMPO_RANGES[v]);
      if (fn === 'q') this.quantize = v === 0;
      if (fn === 'usb2') return v ? $('#files-input').click() : this.pickFolder();
      this.closeOverlay();
      this.menu();
      this.screen.render();
    });
  }

  info() {
    if (this.closeOverlay()) return;
    const s = this.screen;
    const tracks = s.view === 'browse' && this.browser.selected?.track ? [['', this.browser.selected.track]]
      : this.decks.filter((d) => d.track).map((d) => ['DECK ' + (d.index + 1) + ': ', d.track, d]);
    if (!tracks.length) return s.toast('NO TRACK');
    const rows = tracks.flatMap(([p, t, d]) => [
      `<div class="row"><b>${p}${t.title.replace(/</g, '&lt;')}</b></div>`,
      `<div class="row">ARTIST<span>${(t.artist || '-').replace(/</g, '&lt;')}</span></div>`,
      `<div class="row">BPM / KEY<span>${t.bpm ? (+t.bpm).toFixed(1) : '-'} / ${t.key || '-'}` +
      `${t.grid ? ' (rekordbox grid)' : t.bpmDetected ? ' (detected)' : ''}</span></div>`,
    ]);
    this.overlay('INFO', rows);
  }

  // ---- panel, effects bar, mixer

  buildControls() {
    const e = this.engine;
    // hardware buttons: press and release, so CUE can be held
    $$('[data-key]').forEach((btn) => {
      const k = btn.dataset.key, d = +(btn.dataset.deck || 0);
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        btn.setPointerCapture(ev.pointerId);
        this.key(k, d, true);
      });
      const up = () => this.key(k, d, false);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    });
    const fxSel = $('#fx-select');
    fxSel.innerHTML = BEAT_FX.map((m) => `<option>${m.name}</option>`).join('');
    fxSel.onchange = () => {
      e.selectBeatFx(fxSel.value);
      this.changed();
    };
    $('#fx-ch').innerHTML = FX_CHANNELS.map((c) => `<option>${c}</option>`).join('');
    $('#fx-ch').onchange = (ev) => {
      e.routeBeatFx(ev.target.value);
      this.changed();
    };
    $('#fx-level').oninput = (ev) => {
      e.setLevel(+ev.target.value);
      this.screen.renderFxPanel();
    };
    const colorSel = $('#color-select');
    colorSel.innerHTML = '<option value="">(off)</option>' + COLOR_FX.map((m) => `<option>${m.name}</option>`).join('');
    colorSel.onchange = () => e.selectColorFx(colorSel.value || null);
    const param = $('#color-param');
    param.oninput = () => e.setColorParameter(+param.value);
    param.ondblclick = () => { param.value = 0.5; e.setColorParameter(0.5); };
    $$('[data-color]').forEach((inp) => {
      inp.oninput = () => e.setColor(+inp.dataset.color, +inp.value);
      inp.ondblclick = () => { inp.value = 0; e.setColor(+inp.dataset.color, 0); }; // back to centre = off
    });
    $('#xfader').oninput = (ev) => e.setCrossfader(+ev.target.value);
    $('#master').oninput = (ev) => {
      this.muted = false;
      e.setMaster(+ev.target.value);
    };
    // per-deck strips
    $$('.strip').forEach((el) => {
      const i = +el.dataset.deck, deck = this.decks[i];
      const knob = (label, attrs) => `<label class="knob">${label}<input type="range" ${attrs}></label>`;
      el.innerHTML = `<span class="dname">DECK ${i + 1}</span>` +
        knob('TEMPO', 'data-f="tempo" min="-1" max="1" step="0.0005" value="0"') +
        `<button data-f="sync">BEAT SYNC</button>` +
        `<button data-f="nudge-">&#9664;</button><button data-f="nudge+">&#9654;</button>` +
        knob('TRIM', 'data-f="trim" min="-1" max="1" step="0.01" value="0"') +
        knob('HI', 'data-f="high" min="-1" max="1" step="0.01" value="0"') +
        knob('MID', 'data-f="mid" min="-1" max="1" step="0.01" value="0"') +
        knob('LOW', 'data-f="low" min="-1" max="1" step="0.01" value="0"') +
        knob('CH FADER', 'data-f="fader" min="0" max="1" step="0.001" value="1"');
      el.querySelectorAll('input').forEach((inp) => {
        const f = inp.dataset.f;
        inp.oninput = () => {
          const v = +inp.value;
          if (f === 'tempo') deck.setTempo(-v); // like the hardware: slider down = faster
          else if (f === 'trim') e.setTrim(i, v);
          else if (f === 'fader') e.setFader(i, v);
          else e.setEq(i, f, v);
        };
        inp.ondblclick = () => {
          inp.value = f === 'fader' ? 1 : 0;
          inp.oninput();
        };
      });
      el.querySelector('[data-f="sync"]').onclick = () => {
        deck.sync(this.decks[1 - i]);
        el.querySelector('[data-f="tempo"]').value = -deck.tempo;
      };
      for (const dir of ['-', '+']) {
        const b = el.querySelector(`[data-f="nudge${dir}"]`);
        b.onpointerdown = () => deck.setNudge(dir === '+' ? 1 : -1);
        b.onpointerup = b.onpointerleave = () => deck.setNudge(0);
      }
    });
  }

  /** Phones: the tabs pick which pane shows (upright: always one; on its side: a drawer, or none). */
  bindMobile() {
    const app = $('#app'), tabs = $$('#mtabs [data-pane]');
    const upright = matchMedia('(orientation: portrait)');
    const show = (pane) => {
      app.dataset.pane = pane;
      tabs.forEach((b) => b.classList.toggle('on', b.dataset.pane === pane));
    };
    tabs.forEach((b) => {
      b.onclick = () => show(!upright.matches && app.dataset.pane === b.dataset.pane ? '' : b.dataset.pane);
    });
    $('#screen-wrap').addEventListener('pointerdown', () => { if (!upright.matches) show(''); });
    const reset = () => show(upright.matches ? app.dataset.pane || 'panel' : '');
    upright.addEventListener('change', reset);
    reset();
    const fs = $('#fullscreen');
    fs.hidden = !document.fullscreenEnabled; // iPhone Safari has no fullscreen API; add to home screen instead
    fs.onclick = async () => {
      if (document.fullscreenElement) return document.exitFullscreen();
      try {
        await document.documentElement.requestFullscreen();
        await window.screen.orientation.lock('landscape');
      } catch { /* lock is Android-only */ }
    };
  }

  renderControls() {
    const e = this.engine;
    $('#fx-select').value = e.fx.name;
    $('#fx-ch').value = e.fx.channel;
    $('#fx-level').value = e.fx.level;
    $('#fx-on').classList.toggle('lit', e.fx.on);
    $$('.panel [data-key="play"]').forEach((b) => b.classList.toggle('lit', this.decks[+b.dataset.deck].playing));
    $$('.panel [data-key="cue"]').forEach((b) => {
      const d = this.decks[+b.dataset.deck];
      b.classList.toggle('lit', d.loaded && !d.playing);
    });
    $$('.strip').forEach((el) => {
      const d = this.decks[+el.dataset.deck], t = el.querySelector('[data-f="tempo"]');
      if (document.activeElement !== t) t.value = -d.tempo;
    });
  }

  status() {
    const ctx = this.engine.ctx;
    const touch = matchMedia('(pointer: coarse)').matches;
    const sound = ctx.state !== 'running' ? `sound: ${touch ? 'tap' : 'click'} anywhere to start` : this.muted ? 'sound muted (X)' : 'sound on (X to mute)';
    const lat = ctx.baseLatency ? `   |   output ${Math.round((ctx.baseLatency + (ctx.outputLatency || 0)) * 1000)} ms` : '';
    if (touch) return sound.replace(' (X to mute)', '') + lat;
    return `${sound}${lat}   |   H hides controls   |   1/2 load, Q/P play, W/O cue, E beat FX`;
  }

  // ---- keyboard, files, frame loop

  bindKeys() {
    const held = new Set();
    const map = (ev) => {
      const k = KEYS[ev.key.length === 1 ? ev.key.toLowerCase() : ev.key];
      return k && (Array.isArray(k) ? k : [k, 0]);
    };
    addEventListener('keydown', (ev) => {
      if (ev.target.tagName === 'INPUT' && ev.target.type !== 'range') return;
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const k = map(ev);
      if (!k) return;
      ev.preventDefault();
      const id = k.join();
      if (held.has(id) && !['up', 'down'].includes(k[0])) return; // arrows auto-repeat to scroll
      held.add(id);
      this.key(k[0], k[1], true);
    });
    addEventListener('keyup', (ev) => {
      const k = map(ev);
      if (!k) return;
      held.delete(k.join());
      this.key(k[0], k[1], false);
    });
    addEventListener('pointerdown', () => this.engine.resume(), { once: true });
  }

  async pickFolder() {
    if (!window.showDirectoryPicker) return $('#folder-input').click(); // e.g. Firefox/Safari
    let n;
    try {
      n = await this.sources[1].pick((msg) => this.progress(msg));
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('USB2 folder pick failed', e);
      this.screen.toast('COULD NOT OPEN FOLDER (' + e.name + ')');
      return;
    }
    this.closeOverlay();
    this.usb2Opened(n);
  }

  usb2Opened(n) {
    const usb2 = this.sources[1];
    if (!n) return this.screen.toast('NO AUDIO FILES');
    this.screen.toast(n + ' TRACKS' + (usb2.playlists.length ? ', ' + usb2.playlists.length + ' PLAYLISTS' : '') + ' ON USB2');
    this.browser.root(usb2, 'TRACK', () => this.masterBpm());
    this.screen.setView('browse');
  }

  progress(msg) { // throttled: called per file while scanning
    const now = performance.now();
    if (now - (this.lastProgress || 0) < 150) return;
    this.lastProgress = now;
    this.screen.toast(msg, 60000);
    this.screen.render();
  }

  bindFiles() {
    const usb2 = this.sources[1];
    const add = async (files) => this.usb2Opened(await usb2.add(files, (msg) => this.progress(msg)));
    for (const id of ['#folder-input', '#files-input']) {
      $(id).onchange = (ev) => {
        this.closeOverlay();
        add(ev.target.files);
        ev.target.value = '';
      };
    }
    const drop = $('#drop');
    let depth = 0;
    addEventListener('dragenter', (ev) => {
      if (![...ev.dataTransfer.types].includes('Files')) return;
      depth++;
      drop.hidden = false;
    });
    addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        drop.hidden = true;
      }
    });
    addEventListener('dragover', (ev) => ev.preventDefault());
    addEventListener('drop', (ev) => {
      ev.preventDefault();
      depth = 0;
      drop.hidden = true;
      add(ev.dataTransfer.files);
    });
  }

  loop() {
    const meter = $('#meter'), bar = $('#statusbar');
    let last = '';
    const tick = () => {
      this.screen.frame();
      meter.style.width = Math.min(100, this.engine.peak() * 100) + '%';
      const s = this.status();
      if (s !== last) bar.textContent = last = s;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

Engine.create().then((engine) => {
  window.rx3 = new App(engine);
}).catch((err) => {
  if (!window.isSecureContext) { // AudioWorklet only exists on https:// or localhost
    document.body.innerHTML = `<p style="padding:24px;font:16px sans-serif">The RX3 audio engine needs a secure page. ` +
      `Open it over https:// (or on this computer at http://localhost:${location.port || 80}/).</p>`;
    return;
  }
  document.body.innerHTML = `<p style="padding:24px;font:16px sans-serif">This browser can't run the RX3 audio engine ` +
    `(${String(err.message || err).replace(/</g, '&lt;')}). Try a current Chrome, Edge, Firefox or Safari.</p>`;
});
