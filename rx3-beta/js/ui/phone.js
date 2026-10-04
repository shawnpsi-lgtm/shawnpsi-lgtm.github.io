// The phone panel (portrait): one set of controls, in the screen's own style, that drives the focused deck (picked
// by tapping it on the screen). No EQ, faders or crossfader: the FILTER X-PAD (the channel's own FILTER) brings a
// deck in or takes it out, and the COLOR FX X-PAD is the channel's COLOR knob. On both, a tap or sweep springs back
// to centre on release and a double-tap parks it there. Beat FX goes to the deck you switch it on from.
import { BEAT_FX, COLOR_FX } from '../audio/engine.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const DOUBLE_TAP = 350; // ms

export class Phone {
  constructor(app) {
    this.app = app;
    this.pads = [];
    this.buildButtons();
    this.buildFx();
    const e = app.engine;
    const color = $('#ph-color');
    color.innerHTML = COLOR_FX.map((m) => `<option>${m.name}</option>`).join('');
    // one Color FX type for both channels, as on the unit; picking it here picks it for the mixer too
    const pick = () => {
      if (e.color.name === color.value) return;
      e.selectColorFx(color.value);
      $('#color-select').value = color.value;
    };
    color.onchange = pick;
    this.buildPad($('#ph-xpad'), pick, (ch, x) => {
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
      if (!phone.matches || !quick || ev.touches.length || ev.target.closest('input, select, textarea')) return;
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
    sel.innerHTML = BEAT_FX.map((m) => `<option>${m.name}</option>`).join('');
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
    // LEVEL/DEPTH: drag up to turn it up, double-tap for the middle (counted here: no dblclick on touch)
    const box = $('#ph-level');
    const set = (v) => {
      e.setLevel(Math.max(0, Math.min(1, v)));
      this.renderFx();
      app.screen.renderFxPanel();
    };
    let drag = null, lastTap = -1e9;
    box.addEventListener('pointerdown', (ev) => {
      box.setPointerCapture(ev.pointerId);
      if (ev.timeStamp - lastTap < DOUBLE_TAP) set(0.5);
      lastTap = ev.timeStamp;
      drag = { y: ev.clientY, v: e.fx.level };
    });
    box.addEventListener('pointermove', (ev) => {
      if (drag) set(drag.v + (drag.y - ev.clientY) / 180);
    });
    box.addEventListener('pointerup', () => { drag = null; });
    box.addEventListener('pointercancel', () => { drag = null; });
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
    $('[data-ph="cue"]').classList.toggle('lit', d.loaded && !d.playing);
    this.renderFx();
    this.pads.forEach((p) => this.renderPad(p));
  }

  renderFx() {
    const e = this.app.engine, m = e.beatMeta();
    $('#ph-beatfx').value = e.fx.name;
    if (e.color.name) $('#ph-color').value = e.color.name;
    $('#ph-beat').textContent = m?.beats.find((b) => b.value === e.fx.beat)?.label ?? e.fx.beat ?? '';
    $('#ph-level-v').textContent = Math.round(e.fx.level * 100);
    $('#ph-level').style.setProperty('--lv', e.fx.level * 100 + '%');
    $('#ph-on').classList.toggle('lit', e.fx.on && e.fx.channel === 'CH' + (this.deck + 1));
  }

  /** The marker at the finger, or where the focused deck is parked (drawn blue); none at rest. */
  renderPad(pad) {
    const live = pad.live?.deck === this.deck ? pad.live.x : null, x = live ?? pad.parked[this.deck];
    pad.el.classList.toggle('held', x != null);
    pad.el.classList.toggle('parked', live == null && x != null);
    if (x != null) pad.el.querySelector('i').style.left = x * 100 + '%';
  }
}
