// The desktop keyboard, in two layers.
//
// 1. Fixed keys for everything that has to land on time, mirrored per hand: deck 1 on the left, deck 2 on the right.
//    Keys are matched by position (KeyboardEvent.code), so the layout is the same on AZERTY or Dvorak and Shift+1 is
//    still "1". Cmd/Ctrl/Alt combinations are left to the browser.
// 2. Everything else (EQ, trim, Color FX, levels...): Tab to the control, then arrows to turn it (Shift = fine,
//    Page Up/Down = coarse, Home = back to its default), Enter/Space to press a focused button.

const $ = (sel) => document.querySelector(sel);

// code -> [action, deck, arg]
export const KEYMAP = {
  Digit1: ['hot', 0, 0], Digit2: ['hot', 0, 1], Digit3: ['hot', 0, 2], Digit4: ['hot', 0, 3],
  Digit7: ['hot', 1, 0], Digit8: ['hot', 1, 1], Digit9: ['hot', 1, 2], Digit0: ['hot', 1, 3],
  KeyQ: ['play', 0], KeyP: ['play', 1],
  KeyW: ['cue', 0], KeyO: ['cue', 1],
  KeyE: ['sync', 0], KeyI: ['sync', 1],
  KeyR: ['loop', 0], KeyU: ['loop', 1],
  KeyF: ['loop-half', 0], KeyG: ['loop-double', 0], KeyJ: ['loop-half', 1], KeyH: ['loop-double', 1],
  KeyA: ['nudge-', 0], KeyD: ['nudge+', 0], KeyK: ['nudge-', 1], Semicolon: ['nudge+', 1],
  KeyZ: ['fader-', 0], KeyX: ['fader+', 0], Comma: ['fader-', 1], Period: ['fader+', 1],
  KeyC: ['xfader-'], KeyV: ['xfader+'],
  Space: ['fx'], BracketLeft: ['beat-down'], BracketRight: ['beat-up'],
  ArrowUp: ['up'], ArrowDown: ['down'], Enter: ['push'], NumpadEnter: ['push'],
  Escape: ['back'], Backspace: ['back'],
  ArrowLeft: ['load', 0], ArrowRight: ['load', 1],
  Slash: ['search'], KeyB: ['browse'], KeyM: ['menu'], KeyT: ['tag'],
  Backslash: ['mute'], Backquote: ['hide'],
};

// for the ? overlay and the status bar
export const HELP = [
  ['', 'DECK 1', 'DECK 2'],
  ['HOT CUES (SHIFT: DELETE)', '1 2 3 4', '7 8 9 0'],
  ['PLAY / PAUSE', 'Q', 'P'],
  ['CUE', 'W', 'O'],
  ['BEAT SYNC', 'E', 'I'],
  ['LOOP ON/OFF', 'R', 'U'],
  ['LOOP 1/2X / 2X', 'F / G', 'J / H'],
  ['NUDGE (SHIFT: TEMPO)', 'A / D', 'K / ;'],
  ['CH FADER', 'Z / X', ', / .'],
  ['LOAD', '←', '→'],
  ['CROSSFADER', 'C / V', ''],
  ['BEAT FX (HOLD: MOMENTARY)', 'SPACE', ''],
  ['BEAT ◀ / ▶', '[ / ]', ''],
  ['BROWSE', '↑ ↓ ENTER ESC', ''],
  ['SEARCH, VIEW, MENU, TAG', '/ B M T', ''],
  ['MUTE, HIDE, HELP', '\\ ` ?', ''],
  ['OTHER CONTROLS', 'TAB, THEN ↑ ↓ (HOME: RESET)', '*'],
];

// riding speeds, full travel per second
const RATE = { fader: 1, xfader: 2, tempo: 0.25 };
const HOLD_MS = 300; // Space held longer than this is momentary

export function bindKeys(app) {
  const e = app.engine;
  const rides = new Map(); // code -> { kind, deck, dir }
  let fxHold = null;
  let last = 0;

  const fine = (ev) => (ev.shiftKey ? 0.25 : 1);
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

  // layer 2: a focused slider turns in sensible steps (their own step is 1/1000 of the travel)
  const turn = (inp, ev) => {
    const min = +inp.min, max = +inp.max, span = max - min;
    let v = +inp.value;
    const k = ev.key;
    if (k === 'Home') v = +inp.defaultValue;
    else if (k === 'End') return false;
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

  const press = (action, deck, arg, ev) => {
    const d = app.decks[deck ?? 0];
    switch (action) {
      case 'hot':
        if (ev.shiftKey) {
          if (d.track?.cues) d.track.cues = d.track.cues.filter((c) => c.pad !== arg);
          app.screen.toast(`DECK ${deck + 1} HOT CUE ${'ABCD'[arg]} DELETED`);
          return d.onChange();
        }
        e.resume();
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
        if (ev.shiftKey) return startRide(ev.code, { kind: 'tempo', deck, dir: action === 'nudge+' ? 1 : -1, speed: 1 });
        return app.key(action, deck, true);
      case 'fader-': case 'fader+':
        return startRide(ev.code, { kind: 'fader', deck, dir: action === 'fader+' ? 1 : -1, speed: fine(ev) });
      case 'xfader-': case 'xfader+':
        return startRide(ev.code, { kind: 'xfader', dir: action === 'xfader+' ? 1 : -1, speed: fine(ev) });
      case 'fx': {
        const wasOn = e.fx.on;
        e.setBeatFxOn(!wasOn);
        fxHold = wasOn ? null : performance.now();
        app.renderControls();
        return app.screen.render();
      }
      case 'search':
        if (ev.shiftKey) return help(app);
        return app.key('search', 0, true);
      default:
        return app.key(action, deck ?? 0, true);
    }
  };

  const release = (action, deck, code) => {
    rides.delete(code);
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
    if (ev.repeat && !['up', 'down'].includes(k[0])) return; // arrows auto-repeat to scroll
    e.resume();
    press(k[0], k[1], k[2], ev);
  });

  addEventListener('keyup', (ev) => {
    const k = KEYMAP[ev.code];
    if (k) release(k[0], k[1], ev.code);
  });

  // a key let go while the window was in the background never sends keyup: let go of everything
  addEventListener('blur', () => {
    rides.clear();
    app.decks.forEach((d) => d.setNudge(0));
    if (fxHold) release('fx', 0, 'Space');
  });

  addEventListener('pointerdown', () => e.resume(), { once: true });
}

function help(app) {
  if (app.closeOverlay()) return;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = HELP.map(([what, a, b], i) => {
    if (i === 0) return `<div class="row keys head"><span></span><span>${a}</span><span>${b}</span></div>`;
    const keys = b === '*' ? `<kbd class="wide">${esc(a)}</kbd>` : `<kbd>${esc(a)}</kbd>` + (b ? `<kbd>${esc(b)}</kbd>` : '<span></span>');
    return `<div class="row keys"><span>${esc(what)}</span>${keys}</div>`;
  });
  app.overlay('KEYBOARD', rows).classList.add('help');
}
