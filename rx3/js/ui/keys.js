// The desktop keyboard. Every performance control has a key, mirrored per hand: deck 1 on the left, deck 2 on the
// right. Keys are matched by position (KeyboardEvent.code), so the layout is the same on AZERTY or Dvorak and Shift+1
// is still "1". Cmd/Ctrl/Alt combinations are left to the browser. The on-screen keyboard (ui/vkb.js) shows this map
// and drives the same actions with the mouse.
//
// The knobs that have no key (EQ, TRIM, MASTER, MASTER TEMPO, PARAMETER...) are on the mixer view (`): Tab to one,
// then the arrows turn it (Shift = fine, Page Up/Down = coarse, Home = back to its default).
import { BEAT_FX, COLOR_FX, FX_CHANNELS } from '../audio/engine.js';

const $ = (sel) => document.querySelector(sel);

// code -> [action, deck, arg]
export const KEYMAP = {
  Digit1: ['hot', 0, 0], Digit2: ['hot', 0, 1], Digit3: ['hot', 0, 2], Digit4: ['hot', 0, 3],
  Digit7: ['hot', 1, 0], Digit8: ['hot', 1, 1], Digit9: ['hot', 1, 2], Digit0: ['hot', 1, 3],
  Digit5: ['fx-prev'], Digit6: ['fx-next'], Minus: ['level-'], Equal: ['level+'],
  KeyQ: ['play', 0], KeyP: ['play', 1],
  KeyW: ['cue', 0], KeyO: ['cue', 1],
  KeyE: ['sync', 0], KeyI: ['sync', 1],
  KeyR: ['loop', 0], KeyU: ['loop', 1],
  KeyT: ['tag'], KeyY: ['fx-ch'],
  KeyF: ['loop-half', 0], KeyG: ['loop-double', 0], KeyJ: ['loop-half', 1], KeyH: ['loop-double', 1],
  KeyA: ['nudge-', 0], KeyD: ['nudge+', 0], KeyK: ['nudge-', 1], Semicolon: ['nudge+', 1],
  KeyS: ['color', 0], KeyL: ['color', 1], KeyN: ['color-fx'],
  KeyZ: ['fader-', 0], KeyX: ['fader+', 0], Comma: ['fader-', 1], Period: ['fader+', 1],
  KeyC: ['xfader-'], KeyV: ['xfader+'],
  Space: ['fx'], BracketLeft: ['beat-down'], BracketRight: ['beat-up'],
  ArrowUp: ['up'], ArrowDown: ['down'], Enter: ['push'], NumpadEnter: ['push'],
  Escape: ['back'], Backspace: ['back'],
  ArrowLeft: ['load', 0], ArrowRight: ['load', 1],
  Slash: ['search'], KeyB: ['browse'], KeyM: ['menu'],
  Backslash: ['mute'], Backquote: ['view'],
};

// riding speeds, full travel per second
const RATE = { fader: 1, xfader: 2, tempo: 0.25, level: 0.8, color: 2 };
const HOLD_MS = 300; // Space held longer than this is momentary

/** Binds the keyboard; returns { down(code, shift), up(code) } for the on-screen keyboard. */
export function bindKeys(app) {
  const e = app.engine;
  const rides = new Map(); // code -> { kind, deck, dir, speed }
  const held = new Set(); // codes down, for the on-screen keyboard
  let fxHold = null;
  let last = 0;

  const pct = (x) => Math.round(x * 100);

  const ride = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const r of rides.values()) {
      const step = r.dir * RATE[r.kind] * r.speed * dt;
      if (r.kind === 'fader') {
        const v = Math.max(0, Math.min(1, e.faders[r.deck] + step));
        e.setFader(r.deck, v);
        const inp = $(`.strip[data-deck="${r.deck}"] [data-f="fader"]`);
        if (inp) inp.value = v;
        app.screen.toast(`CH${r.deck + 1} FADER ${pct(v)}`);
      } else if (r.kind === 'xfader') {
        const v = Math.max(-1, Math.min(1, e.xfader + step));
        e.setCrossfader(v);
        $('#xfader').value = v;
        app.screen.toast(`CROSSFADER ${v < -0.01 ? 'A ' : v > 0.01 ? 'B ' : ''}${Math.abs(pct(v))}`);
      } else if (r.kind === 'tempo') {
        const d = app.decks[r.deck];
        d.setTempo(d.tempo + step);
        app.screen.toast(`DECK ${r.deck + 1} BPM ${d.bpm ? d.bpm.toFixed(2) : '-'}`);
      } else if (r.kind === 'level') {
        const v = Math.max(0, Math.min(1, e.fx.level + step));
        e.setLevel(v);
        $('#fx-level').value = v;
        app.screen.renderFxPanel();
        app.screen.toast(`BEAT FX LEVEL ${pct(v)}`);
      } else if (r.kind === 'color') { // towards the end the key pushes to; let go and it springs back
        const v = Math.max(-1, Math.min(1, e.color.amount[r.deck] + step));
        e.setColor(r.deck, v);
        const inp = $(`[data-color="${r.deck}"]`);
        if (inp) inp.value = v;
      }
    }
    app.phone?.render();
    if (rides.size) requestAnimationFrame(ride);
  };
  const startRide = (code, r) => {
    if (!rides.size) {
      last = performance.now();
      requestAnimationFrame(ride);
    }
    rides.set(code, r);
  };

  // a focused slider (mixer view) turns in sensible steps (their own step is 1/1000 of the travel)
  const turn = (inp, ev) => {
    const min = +inp.min, max = +inp.max, span = max - min;
    let v = +inp.value;
    const k = ev.key;
    if (k === 'Home') v = +inp.defaultValue;
    else {
      const dir = ['ArrowUp', 'ArrowRight', 'PageUp'].includes(k) ? 1 : ['ArrowDown', 'ArrowLeft', 'PageDown'].includes(k) ? -1 : 0;
      if (!dir) return false;
      const size = k.startsWith('Page') ? 0.1 : ev.shiftKey ? 0.005 : 0.02;
      // the tempo slider runs like the hardware's: down = faster, so "up" means a higher BPM
      const flip = inp.dataset.f === 'tempo' ? -1 : 1;
      v = Math.max(min, Math.min(max, v + flip * dir * size * span));
    }
    inp.value = v;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  };

  const cycle = (list, cur, dir) => list[(list.indexOf(cur) + dir + list.length) % list.length];

  const press = (code, shift) => {
    const [action, deck, arg] = KEYMAP[code];
    const d = app.decks[deck ?? 0];
    const speed = shift ? 0.25 : 1;
    e.resume();
    switch (action) {
      case 'hot':
        if (shift) {
          if (d.track?.cues) d.track.cues = d.track.cues.filter((c) => c.pad !== arg);
          app.screen.toast(`DECK ${deck + 1} HOT CUE ${'ABCD'[arg]} DELETED`);
          return d.onChange();
        }
        return d.hotCueDown(arg, app.quantize);
      case 'sync':
        d.sync(app.decks[1 - deck]);
        return app.renderControls();
      case 'loop':
        if (!d.loaded) return;
        if (d.loop) {
          d.loop = null;
          d.sendLoop();
        } else d.beatLoop(4, app.quantize);
        return app.screen.render();
      case 'nudge-': case 'nudge+':
        if (shift) return startRide(code, { kind: 'tempo', deck, dir: action === 'nudge+' ? 1 : -1, speed: 1 });
        return app.key(action, deck, true);
      case 'fader-': case 'fader+':
        return startRide(code, { kind: 'fader', deck, dir: action === 'fader+' ? 1 : -1, speed });
      case 'xfader-': case 'xfader+':
        return startRide(code, { kind: 'xfader', dir: action === 'xfader+' ? 1 : -1, speed });
      case 'level-': case 'level+':
        return startRide(code, { kind: 'level', dir: action === 'level+' ? 1 : -1, speed });
      case 'color':
        if (!e.color.name) return app.screen.toast('PICK A COLOR FX WITH N');
        return startRide(code, { kind: 'color', deck, dir: shift ? -1 : 1, speed: 1 });
      case 'color-fx': {
        const names = [null, ...COLOR_FX.map((m) => m.name)];
        const name = cycle(names, e.color.name, shift ? -1 : 1);
        e.selectColorFx(name);
        $('#color-select').value = name || '';
        return app.screen.toast('COLOR FX ' + (name || 'OFF'));
      }
      case 'fx-prev': case 'fx-next': {
        e.selectBeatFx(cycle(BEAT_FX.map((m) => m.name), e.fx.name, action === 'fx-next' ? 1 : -1));
        app.changed();
        app.renderControls();
        return app.screen.toast('BEAT FX ' + e.fx.name);
      }
      case 'fx-ch':
        e.routeBeatFx(cycle(FX_CHANNELS, e.fx.channel, shift ? -1 : 1));
        app.changed();
        app.renderControls();
        return app.screen.toast('BEAT FX ON ' + e.fx.channel);
      case 'fx': {
        const wasOn = e.fx.on;
        e.setBeatFxOn(!wasOn);
        fxHold = wasOn ? null : performance.now();
        app.renderControls();
        return app.screen.render();
      }
      case 'search':
        if (shift) return help(app);
        return app.key('search', 0, true);
      case 'view':
        return app.setView(shift ? 'compact' : app.view === 'mixer' ? 'keys' : 'mixer');
      default:
        return app.key(action, deck ?? 0, true);
    }
  };

  const release = (code) => {
    const [action, deck] = KEYMAP[code];
    const r = rides.get(code);
    rides.delete(code);
    if (r?.kind === 'color') {
      e.setColor(r.deck, 0);
      const inp = $(`[data-color="${r.deck}"]`);
      if (inp) inp.value = 0;
      return;
    }
    if (action === 'fx') {
      if (fxHold && performance.now() - fxHold > HOLD_MS) {
        e.setBeatFxOn(false);
        app.renderControls();
        app.screen.render();
      }
      fxHold = null;
      return;
    }
    app.key(action, deck ?? 0, false); // CUE and nudge act on release
  };

  const ctl = {
    held,
    down(code, shift = false) {
      if (!KEYMAP[code] || held.has(code)) return;
      held.add(code);
      press(code, shift);
    },
    up(code) {
      if (!held.delete(code)) return;
      release(code);
    },
  };

  addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (t.tagName === 'INPUT' && t.type !== 'range') return; // typing in SEARCH
    if (t.tagName === 'INPUT' && t.type === 'range') {
      if (turn(t, ev)) return ev.preventDefault();
      if (ev.key === 'Escape') return t.blur();
    }
    // a focused button or dropdown takes Enter / Space for itself
    if ((ev.code === 'Space' || ev.key === 'Enter') && t.closest?.('button, rx-select')) return;
    const k = KEYMAP[ev.code];
    if (!k) return;
    ev.preventDefault();
    if (ev.repeat) { // arrows auto-repeat to scroll
      if (k[0] === 'up' || k[0] === 'down') app.key(k[0], 0, true);
      return;
    }
    ctl.down(ev.code, ev.shiftKey);
  });

  addEventListener('keyup', (ev) => ctl.up(ev.code));

  // a key let go while the window was in the background never sends keyup: let go of everything
  addEventListener('blur', () => [...held].forEach((c) => ctl.up(c)));

  addEventListener('pointerdown', () => e.resume(), { once: true });
  return ctl;
}

// the ? overlay
const HELP = [
  ['', 'DECK 1', 'DECK 2'],
  ['HOT CUES (SHIFT: DELETE)', '1 2 3 4', '7 8 9 0'],
  ['PLAY / CUE', 'Q / W', 'P / O'],
  ['BEAT SYNC', 'E', 'I'],
  ['LOOP ON/OFF, 1/2X, 2X', 'R F G', 'U J H'],
  ['NUDGE (SHIFT: TEMPO)', 'A / D', 'K / ;'],
  ['COLOR FX, HELD (SHIFT: OTHER WAY)', 'S', 'L'],
  ['CH FADER', 'Z / X', ', / .'],
  ['LOAD', '←', '→'],
  ['CROSSFADER', 'C / V', ''],
  ['BEAT FX ON (HOLD: MOMENTARY)', 'SPACE', ''],
  ['BEAT FX TYPE, LEVEL, CHANNEL', '5 6, - =, Y', ''],
  ['BEAT ◀ / ▶, COLOR FX TYPE', '[ ], N', ''],
  ['BROWSE', '↑ ↓ ENTER ESC', ''],
  ['SEARCH, VIEW, MENU, TAG', '/ B M T', ''],
  ['MUTE, MIXER (SHIFT: HIDE), HELP', '\\ ` ?', ''],
];

function help(app) {
  if (app.closeOverlay()) return;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = HELP.map(([what, a, b], i) => {
    if (i === 0) return `<div class="row keys head"><span></span><span>${a}</span><span>${b}</span></div>`;
    return `<div class="row keys"><span>${esc(what)}</span><kbd>${esc(a)}</kbd>${b ? `<kbd>${esc(b)}</kbd>` : '<span></span>'}</div>`;
  });
  app.overlay('KEYBOARD', rows).classList.add('help');
}
