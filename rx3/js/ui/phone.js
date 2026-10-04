// The phone panel (portrait): one set of controls, in the screen's own style, that drives the focused deck (picked
// by tapping it on the screen). No EQ, faders or crossfader: the FILTER X-PAD (the channel's own FILTER) brings a
// deck in or takes it out, and the COLOR FX X-PAD is the channel's COLOR knob. On both, a tap or sweep springs back
// to centre on release and a double-tap parks it there. Beat FX goes to the deck you switch it on from. Between BEAT FX
// and FILTER, PADS / VOL swaps between the focused deck's pads and the volumes: both channel faders and the Beat FX
// volume. The pads are HOT CUE A, B, E and F (rekordbox's), a 4-bar and a 2-bar loop on C and D, and the Pad FX ROLL
// and VINYL BRAKE on G and H.
import { BEAT_FX, COLOR_FX, pitchLabel } from '../audio/engine.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const DOUBLE_TAP = 350; // ms
const PADS = 'ABCDEFGH';
// the pads that aren't hot cues: C and D are 4- and 2-bar beat loops, G and H two of rekordbox's Pad FX
const PAD_FN = {
  2: { loop: 16, label: '4 BAR LOOP' },
  3: { loop: 8, label: '2 BAR LOOP' },
  6: { fx: 'roll', label: 'ROLL 1/4' },
  7: { fx: 'brake', label: 'VINYL BRAKE' },
};

export class Phone {
  constructor(app) {
    this.app = app;
    this.pads = [];
    this.buildButtons();
    this.buildFx();
    this.buildSwap();
    const e = app.engine;
    // one Color FX type for both channels, as on the unit; picking it here picks it for the mixer too. FILTER isn't
    // offered: it has its own pad
    this.colors = COLOR_FX.map((m) => m.name).filter((n) => n !== 'FILTER');
    this.colorName = this.colors[0];
    const pick = (name = this.colorName) => {
      this.colorName = name;
      this.renderColors();
      if (e.color.name === name) return;
      e.selectColorFx(name);
      $('#color-select').value = name;
    };
    const head = $('#ph-color');
    for (const name of this.colors) {
      const btn = document.createElement('button');
      btn.textContent = name;
      btn.onclick = () => pick(name);
      head.append(btn);
    }
    this.renderColors();
    this.buildPad($('#ph-xpad'), () => pick(), (ch, x) => {
      e.setColor(ch, x);
      $(`[data-color="${ch}"]`).value = x;
    });
    this.buildPad($('#ph-filter'), () => {}, (ch, x) => e.setFilter(ch, x));
    this.noDoubleTapZoom();
  }

  get deck() {
    return this.app.focus;
  }

  /**
   * iOS Safari ignores user-scalable=no, so a quick second tap (resetting LEVEL, parking an X-PAD, tapping a list
   * row twice) zooms the page. Swallow the second touchend and click the target ourselves instead.
   */
  noDoubleTapZoom() {
    const phone = matchMedia('(max-width: 600px) and (orientation: portrait)');
    let last = 0;
    document.addEventListener('touchend', (ev) => {
      const quick = ev.timeStamp - last < DOUBLE_TAP;
      last = ev.timeStamp;
      if (!phone.matches || !quick || ev.touches.length || ev.target.closest('input, textarea')) return;
      ev.preventDefault();
      ev.target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }, { passive: false });
  }

  buildButtons() {
    const app = this.app;
    // press and release, so CUE can be held and NUDGE bends while down; the deck is fixed at press
    $$('[data-ph]').forEach((btn) => {
      let deck = 0;
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        btn.setPointerCapture(ev.pointerId);
        deck = this.deck;
        app.key(btn.dataset.ph, deck, true);
      });
      const up = () => app.key(btn.dataset.ph, deck, false);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    });
  }

  buildFx() {
    const app = this.app, e = app.engine;
    const sel = $('#ph-beatfx');
    sel.setOptions(BEAT_FX.map((m) => m.name));
    sel.onchange = () => {
      e.selectBeatFx(sel.value);
      app.changed();
    };
    // ON/OFF: Beat FX is one unit, as on the RX3; pressing ON from the other deck moves it there, tail and all
    $('#ph-on').onclick = () => {
      e.resume();
      const here = 'CH' + (this.deck + 1);
      if (e.fx.on && e.fx.channel !== here) e.routeBeatFx(here);
      else {
        if (!e.fx.on) e.routeBeatFx(here);
        e.setBeatFxOn(!e.fx.on);
      }
      app.changed();
    };
    // LEVEL/DEPTH and DRUM's PITCH: double-tap for the middle
    this.dragBox($('#ph-level'), () => e.fx.level, (v) => e.setLevel(v));
    this.dragBox($('#ph-pitch'), () => e.fx.pitch, (v) => e.setPitch(v));
  }

  /**
   * A value box: drag up to turn it up (`travel` px from 0 to 1), double-tap for `reset` (counted here: no dblclick
   * on touch).
   */
  dragBox(box, get, put, reset = 0.5, travel = () => 180) {
    const app = this.app;
    const set = (v) => {
      put(Math.max(0, Math.min(1, v)));
      app.screen.renderFxPanel();
      app.renderControls();
    };
    let drag = null, lastTap = -1e9;
    box.addEventListener('pointerdown', (ev) => {
      box.setPointerCapture(ev.pointerId);
      if (ev.timeStamp - lastTap < DOUBLE_TAP) set(reset);
      lastTap = ev.timeStamp;
      drag = { y: ev.clientY, v: get(), travel: travel() };
    });
    box.addEventListener('pointermove', (ev) => {
      if (drag) set(drag.v + (drag.y - ev.clientY) / drag.travel);
    });
    box.addEventListener('pointerup', () => { drag = null; });
    box.addEventListener('pointercancel', () => { drag = null; });
  }

  /** PADS / VOL: the section between BEAT FX and FILTER, VOL unless PADS was picked last time. */
  buildSwap() {
    const app = this.app, e = app.engine;
    this.tab = localStorage.getItem('rx3.phTab') === 'pads' ? 'pads' : 'vol';
    $$('#ph-tabs button').forEach((btn) => {
      btn.onclick = () => {
        this.tab = btn.dataset.tab;
        localStorage.setItem('rx3.phTab', this.tab);
        this.renderSwap();
      };
    });
    // the focused deck's pads: press and release (a hot cue pressed while paused plays until let go, a Pad FX lasts
    // while held, a loop pad switches its loop); the deck is fixed at press
    const box = $('#ph-cues');
    for (let i = 0; i < PADS.length; i++) {
      const pad = document.createElement('button'), fn = PAD_FN[i];
      pad.className = 'ph-cue-pad' + (fn ? ' fn' : '');
      pad.innerHTML = `<b>${PADS[i]}</b><small>${fn?.label ?? ''}</small>`;
      let deck = null;
      pad.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        pad.setPointerCapture(ev.pointerId);
        e.resume();
        deck = app.decks[this.deck];
        if (fn?.loop) deck.beatLoop(fn.loop, app.quantize);
        else if (fn) deck.padFxDown(fn.fx, app.quantize);
        else deck.hotCueDown(i, app.quantize);
        pad.classList.add('down');
      });
      const up = () => {
        if (fn?.fx) deck?.padFxUp();
        else if (!fn) deck?.hotCueUp();
        deck = null;
        pad.classList.remove('down');
      };
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
      box.append(pad);
    }
    // the channel faders, drawn as a DJM's: a 0-10 scale with a dot between ticks. The cap follows the finger (drag
    // anywhere in the strip), double-tap for full
    $$('#ph-vol .ph-fader').forEach((el) => {
      const which = el.dataset.vol, track = el.querySelector('.ph-track');
      for (let k = 0; k <= 10; k++) {
        track.insertAdjacentHTML('beforeend', `<span class="${k % 2 ? 'odd' : ''}${k % 5 ? '' : ' major'}" ` +
          `style="--k: ${k}"><em>${k}</em></span>` + (k < 10 ? `<b style="--k: ${k + 0.5}"></b>` : ''));
      }
      const travel = () => track.getBoundingClientRect().height - el.querySelector('i').offsetHeight;
      if (which === 'fx') this.dragBox(el, () => e.fx.volume, (v) => e.setBeatVolume(v), 1, travel);
      else {
        const ch = +which;
        this.dragBox(el, () => e.faders[ch], (v) => {
          e.setFader(ch, v);
          $(`.strip[data-deck="${ch}"] [data-f="fader"]`).value = v; // the desktop mixer's CH FADER
        }, 1, travel);
      }
    });
  }

  /** A touch strip for the focused deck: apply(ch, -1..1); a tap or sweep springs back, a double-tap parks. */
  buildPad(el, before, apply) {
    const pad = { el, parked: [null, null], live: null };
    this.pads.push(pad);
    const at = (ev) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    };
    let deck = null, x = 0.5, lastTap = -1e9, latch = false;
    const go = (ev) => {
      x = at(ev);
      apply(deck, (x - 0.5) * 2);
      pad.live = { deck, x };
      this.renderPad(pad);
    };
    el.addEventListener('pointerdown', (ev) => {
      if (deck != null) return; // one finger at a time
      this.app.engine.resume();
      el.setPointerCapture(ev.pointerId);
      before();
      deck = this.deck;
      latch = ev.timeStamp - lastTap < DOUBLE_TAP;
      lastTap = ev.timeStamp;
      go(ev);
    });
    el.addEventListener('pointermove', (ev) => {
      if (deck != null) go(ev);
    });
    const up = () => {
      if (deck == null) return;
      pad.parked[deck] = latch ? x : null;
      if (!latch) apply(deck, 0); // springs back to centre
      deck = null;
      pad.live = null;
      this.renderPad(pad);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ---- state -> DOM

  render() {
    const d = this.app.decks[this.deck];
    $('#ph-deck').textContent = 'DECK ' + (this.deck + 1);
    $('#ph-bpm').textContent = d.bpm ? d.bpm.toFixed(1) : '---.-';
    $('[data-ph="play"]').classList.toggle('lit', d.playing);
    $('[data-ph="mt"]').classList.toggle('lit', d.masterTempo);
    $('[data-ph="cue"]').classList.toggle('lit', d.loaded && !d.playing);
    this.renderFx();
    this.renderSwap();
    this.pads.forEach((p) => this.renderPad(p));
  }

  renderSwap() {
    const app = this.app, e = app.engine, d = app.decks[this.deck];
    $$('#ph-tabs button').forEach((b) => {
      b.classList.toggle('lit', b.dataset.tab === this.tab);
      b.setAttribute('aria-selected', b.dataset.tab === this.tab);
    });
    $('#ph-cues').hidden = this.tab !== 'pads';
    $('#ph-vol').hidden = this.tab !== 'vol';
    // a stored cue lights its pad in its rekordbox colour (green when it has none, orange for a loop); a loop pad is
    // lit orange while its loop is on, a Pad FX blue while it plays
    $$('#ph-cues .ph-cue-pad').forEach((pad, i) => {
      const fn = PAD_FN[i];
      if (fn) {
        const on = fn.loop ? d.loop?.beats === fn.loop : d.padFx === fn.fx;
        pad.classList.toggle('set', on);
        pad.disabled = !d.loaded;
        pad.style.setProperty('--cue', on ? (fn.loop ? 'var(--orange)' : 'var(--blue)') : '');
        return;
      }
      const c = d.loaded ? d.hotCue(i) : null;
      pad.classList.toggle('set', !!c);
      pad.disabled = !d.loaded;
      pad.style.setProperty('--cue', c ? c.color || (c.loop ? 'var(--orange)' : 'var(--green)') : '');
      pad.querySelector('small').textContent = c?.comment || '';
    });
    $$('#ph-vol .ph-fader').forEach((el) => {
      const which = el.dataset.vol, v = which === 'fx' ? e.fx.volume : e.faders[+which];
      el.style.setProperty('--v', v);
      el.setAttribute('aria-valuenow', Math.round(v * 100));
    });
  }

  renderFx() {
    const e = this.app.engine, m = e.beatMeta();
    $('#ph-beatfx').value = e.fx.name;
    if (this.colors.includes(e.color.name)) this.colorName = e.color.name;
    this.renderColors();
    $('#ph-beat').textContent = m?.beats.find((b) => b.value === e.fx.beat)?.label ?? e.fx.beat ?? '';
    $('#ph-level-v').textContent = Math.round(e.fx.level * 100);
    $('#ph-level').style.setProperty('--lv', e.fx.level * 100 + '%');
    $('.ph-level').classList.toggle('pitch', !!m?.pitch);
    $('#ph-pitch-v').textContent = pitchLabel(e.fx.pitch);
    $('#ph-pitch').style.setProperty('--pv', e.fx.pitch * 100 + '%');
    $('#ph-on').classList.toggle('lit', e.fx.on && e.fx.channel === 'CH' + (this.deck + 1));
  }

  renderColors() {
    $$('#ph-color button').forEach((b) => b.classList.toggle('lit', b.textContent === this.colorName));
  }

  /** The marker at the finger, or where the focused deck is parked (drawn blue); none at rest. */
  renderPad(pad) {
    const live = pad.live?.deck === this.deck ? pad.live.x : null, x = live ?? pad.parked[this.deck];
    pad.el.classList.toggle('held', x != null);
    pad.el.classList.toggle('parked', live == null && x != null);
    if (x != null) pad.el.querySelector('i').style.left = x * 100 + '%';
    // the COLOR FX pad's light: how far the focused deck's COLOR is turned, from the centre out
    if (pad.el.id === 'ph-xpad') {
      const c = this.app.engine.color.amount[this.deck] ?? 0;
      pad.el.style.setProperty('--c0', (50 + Math.min(0, c) * 50) + '%');
      pad.el.style.setProperty('--c1', (50 - Math.max(0, c) * 50) + '%');
    }
  }
}
