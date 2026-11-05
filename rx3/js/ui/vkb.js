// The on-screen keyboard under the screen: every key shows what it does, lights with the state it drives (playing,
// loop on, hot cue set, Beat FX on...), shows held keys, and can be pressed with the mouse or a finger.
import { KEYMAP } from './keys.js';

// rows of [code, cap, width in key units]
const ROWS = [
  [['Backquote', '`'], ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'],
    ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'],
    ['Equal', '='], ['Backspace', '⌫', 1.6]],
  [['Tab', 'tab', 1.6], ['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'],
    ['KeyU', 'U'], ['KeyI', 'I'], ['KeyO', 'O'], ['KeyP', 'P'], ['BracketLeft', '['], ['BracketRight', ']'],
    ['Backslash', '\\']],
  [['CapsLock', 'caps', 1.9], ['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'],
    ['KeyH', 'H'], ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'], ['Quote', "'"],
    ['Enter', 'return', 1.7]],
  [['ShiftLeft', 'shift', 2.4], ['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'],
    ['KeyN', 'N'], ['KeyM', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/'], ['ShiftRight', 'shift', 2.2]],
  [['Escape', 'esc', 1.6], ['Space', 'space', 7.4], ['ArrowLeft', '←'], ['ArrowUp', '↑'], ['ArrowDown', '↓'],
    ['ArrowRight', '→']],
];

const HOT = 'ABCD';

export class Vkb {
  constructor(app, ctl, el) {
    this.app = app;
    this.ctl = ctl;
    this.el = el;
    this.keys = new Map(); // code -> { el, label, bar, prev }
    this.build();
  }

  build() {
    this.el.innerHTML = '';
    for (const row of ROWS) {
      const r = document.createElement('div');
      r.className = 'vkb-row';
      for (const [code, cap, w = 1] of row) {
        const k = document.createElement('div'), map = KEYMAP[code];
        const deck = map && typeof map[1] === 'number' ? ' d' + (map[1] + 1) : '';
        k.className = 'vk' + (map ? deck || ' g' : code.startsWith('Shift') ? ' mod' : ' off');
        k.style.flexGrow = w;
        k.innerHTML = `<b>${cap}</b><small></small><i></i>`;
        if (map || code.startsWith('Shift')) this.bind(k, code);
        r.append(k);
        this.keys.set(code, { el: k, label: k.querySelector('small'), bar: k.querySelector('i'), prev: {} });
      }
      this.el.append(r);
    }
    const legend = document.createElement('div');
    legend.className = 'vkb-legend';
    legend.innerHTML = '<span class="d1">DECK 1</span><span class="d2">DECK 2</span><span class="g">MIXER / FX / BROWSE</span>' +
      '<span class="hint">click a key or press it · ` mixer · ? help</span>';
    this.el.append(legend);
  }

  bind(k, code) {
    if (code.startsWith('Shift')) { // the on-screen shift latches for the next key
      k.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        this.shift = !this.shift;
      });
      return;
    }
    k.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      k.setPointerCapture(ev.pointerId);
      this.ctl.down(code, ev.shiftKey || this.shift);
      this.shift = false;
    });
    const up = () => this.ctl.up(code);
    k.addEventListener('pointerup', up);
    k.addEventListener('pointercancel', up);
  }

  /** What a key says and shows now: [label, lit colour or '', bar 0..1 or null]. */
  state(code) {
    const app = this.app, e = app.engine, map = KEYMAP[code];
    if (!map) return ['', '', null];
    const [action, deck, arg] = map;
    const d = app.decks[deck ?? 0];
    switch (action) {
      case 'hot': {
        const c = d.hotCue(arg);
        return ['CUE ' + HOT[arg], c ? c.color || (c.loop ? 'var(--orange)' : 'var(--green)') : '', null];
      }
      case 'play': return ['PLAY', d.playing ? 'var(--green)' : '', null];
      case 'cue': return ['CUE', d.loaded && !d.playing ? 'var(--orange)' : '', null];
      case 'sync': return ['SYNC', '', null];
      case 'loop': return [d.loop ? loopLabel(d.loop.beats) : 'LOOP', d.loop ? 'var(--orange)' : '', null];
      case 'loop-half': return ['LOOP ½', '', null];
      case 'loop-double': return ['LOOP 2X', '', null];
      case 'nudge-': return ['◀ NUDGE', '', null];
      case 'nudge+': return ['NUDGE ▶', '', null];
      case 'fader-': return ['FADER −', '', e.faders[deck]];
      case 'fader+': return ['FADER +', '', e.faders[deck]];
      case 'xfader-': return ['◀ XFADE', '', (1 - e.xfader) / 2];
      case 'xfader+': return ['XFADE ▶', '', (1 + e.xfader) / 2];
      case 'color': return [e.color.name || 'COLOR', e.color.amount[deck] ? 'var(--blue)' : '', null];
      case 'color-fx': return [e.color.name || 'COLOR OFF', e.color.name ? 'var(--blue)' : '', null];
      case 'fx': {
        const b = e.beatMeta()?.beats.find((x) => x.value === e.fx.beat)?.label ?? '';
        return [`BEAT FX  ${e.fx.name}  ${b}`, e.fx.on ? 'var(--red)' : '', null];
      }
      case 'fx-prev': return ['◀ FX', '', null];
      case 'fx-next': return ['FX ▶', '', null];
      case 'level-': return ['LEVEL −', '', e.fx.level];
      case 'level+': return ['LEVEL +', '', e.fx.level];
      case 'fx-ch': return ['FX ' + e.fx.channel, '', null];
      case 'beat-down': return ['◀ BEAT', '', null];
      case 'beat-up': return ['BEAT ▶', '', null];
      case 'up': case 'down': return ['BROWSE', '', null];
      case 'push': return ['PUSH', '', null];
      case 'back': return ['BACK', '', null];
      case 'load': return ['LOAD ' + (deck + 1), '', null];
      case 'search': return ['SEARCH', '', null];
      case 'browse': return ['VIEW', '', null];
      case 'menu': return ['MENU', '', null];
      case 'tag': return ['TAG', '', null];
      case 'mute': return ['MUTE', app.muted ? 'var(--red)' : '', null];
      case 'view': return ['MIXER', app.view === 'mixer' ? 'var(--blue)' : '', null];
      default: return [action.toUpperCase(), '', null];
    }
  }

  /** Called every frame; touches the DOM only where something changed. */
  render() {
    if (this.el.offsetParent === null) return; // hidden (mixer view, phone)
    for (const [code, k] of this.keys) {
      const [label, lit, bar] = this.state(code);
      const down = this.ctl.held.has(code) || (code.startsWith('Shift') && this.shift);
      const p = k.prev;
      if (p.label !== label) k.label.textContent = p.label = label;
      if (p.lit !== lit) {
        k.el.style.setProperty('--lit', lit || 'transparent');
        k.el.classList.toggle('lit', !!lit);
        p.lit = lit;
      }
      if (p.down !== down) k.el.classList.toggle('down', (p.down = down));
      const w = bar == null ? '' : Math.round(bar * 100) + '%';
      if (p.bar !== w) k.bar.style.width = p.bar = w;
    }
  }
}

const loopLabel = (beats) => (beats >= 1 ? 'LOOP ' + beats : 'LOOP 1/' + 1 / beats);
