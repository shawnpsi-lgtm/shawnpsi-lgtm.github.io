// The phone panel (portrait), after shawnsingh.me/beatfx: one set of controls that drives the focused deck. No EQ,
// faders or crossfader: the X-PAD is the focused channel's COLOR knob, so FILTER brings a deck in or takes it out;
// a tap or sweep springs back to centre on release, a double-tap parks it there. Beat FX goes to the deck you
// switch it on from.
import { BEAT_FX, COLOR_FX } from '../audio/engine.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const SEGS = 24;

export class Phone {
  constructor(app) {
    this.app = app;
    this.parked = [null, null]; // per deck: the X-PAD position (0..1) it's held at, or null
    this.live = null; // { deck, x } while a finger is on the X-PAD
    this.buildButtons();
    this.buildFx();
    this.buildXpad();
  }

  get deck() {
    return this.app.focus;
  }

  buildButtons() {
    const app = this.app;
    $('#ph-deck').onclick = () => {
      app.focus = 1 - app.focus;
      app.screen.render();
    };
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
    // LEVEL/DEPTH knob: drag up to turn it up, double-tap for the middle
    const knob = $('#ph-level');
    let drag = null;
    knob.addEventListener('pointerdown', (ev) => {
      knob.setPointerCapture(ev.pointerId);
      drag = { y: ev.clientY, v: e.fx.level };
    });
    knob.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      e.setLevel(Math.max(0, Math.min(1, drag.v + (drag.y - ev.clientY) / 180)));
      this.renderFx();
      app.screen.renderFxPanel();
    });
    knob.addEventListener('pointerup', () => { drag = null; });
    knob.addEventListener('pointercancel', () => { drag = null; });
    knob.ondblclick = () => {
      e.setLevel(0.5);
      this.renderFx();
      app.screen.renderFxPanel();
    };
  }

  buildXpad() {
    const e = this.app.engine, pad = $('#ph-xpad'), sel = $('#ph-color');
    sel.innerHTML = COLOR_FX.map((m) => `<option value="${m.name}">X-PAD &middot; ${m.name}</option>`).join('');
    sel.value = COLOR_FX.some((m) => m.name === 'FILTER') ? 'FILTER' : COLOR_FX[0]?.name;
    // one Color FX type for both channels, as on the unit; picking it here picks it for the mixer too
    const pick = () => {
      if (e.color.name === sel.value) return;
      e.selectColorFx(sel.value);
      $('#color-select').value = sel.value;
    };
    sel.onchange = pick;
    pad.innerHTML = '<i></i>'.repeat(SEGS);
    const set = (ch, x) => { // x: 0..1 across the strip, 0.5 = centre = off
      e.setColor(ch, (x - 0.5) * 2);
      $(`[data-color="${ch}"]`).value = (x - 0.5) * 2;
    };
    const at = (ev) => {
      const r = pad.getBoundingClientRect();
      return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    };
    let deck = null, x = 0.5, lastTap = 0, latch = false;
    pad.addEventListener('pointerdown', (ev) => {
      if (deck != null) return; // one finger at a time
      e.resume();
      pad.setPointerCapture(ev.pointerId);
      pick();
      deck = this.deck;
      latch = ev.timeStamp - lastTap < 300; // double-tap parks the knob where it lands
      lastTap = ev.timeStamp;
      x = at(ev);
      set(deck, x);
      this.live = { deck, x };
      this.renderXpad();
    });
    pad.addEventListener('pointermove', (ev) => {
      if (deck == null) return;
      x = at(ev);
      set(deck, x);
      this.live = { deck, x };
      this.renderXpad();
    });
    const up = () => {
      if (deck == null) return;
      this.parked[deck] = latch ? x : null;
      if (!latch) set(deck, 0.5); // springs back to centre
      deck = null;
      this.live = null;
      this.renderXpad();
    };
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
  }

  // ---- state -> DOM

  render() {
    const app = this.app, d = app.decks[this.deck];
    $('#ph-deck').textContent = 'DECK ' + (this.deck + 1);
    $('#ph-bpm').textContent = d.bpm ? d.bpm.toFixed(1) : '---.-';
    $('[data-ph="play"]').classList.toggle('lit', d.playing);
    $('[data-ph="cue"]').classList.toggle('lit', d.loaded && !d.playing);
    this.renderFx();
    this.renderXpad();
  }

  renderFx() {
    const e = this.app.engine, m = e.beatMeta();
    $('#ph-beatfx').value = e.fx.name;
    $('#ph-beat').textContent = m?.beats.find((b) => b.value === e.fx.beat)?.label ?? e.fx.beat ?? '';
    $('#ph-level').style.setProperty('--turn', (e.fx.level - 0.5) * 270 + 'deg');
    $('#ph-on').classList.toggle('lit', e.fx.on && e.fx.channel === 'CH' + (this.deck + 1));
  }

  /** Lights the strip centre-out to the finger, or to where the focused deck is parked. */
  renderXpad() {
    const x = this.live?.deck === this.deck ? this.live.x : this.parked[this.deck];
    const segs = $('#ph-xpad').children, c = (SEGS - 1) / 2, p = x == null ? null : x * (SEGS - 1);
    for (let i = 0; i < SEGS; i++) {
      segs[i].className = p != null && i + 0.5 >= Math.min(c, p) && i - 0.5 <= Math.max(c, p) ? 'lit' : '';
    }
  }
}
