# Effects

Every effect is one ES module. The same file is imported in two places:

- the AudioWorklet (`js/audio/worklet.js`), which runs `Effect` on the audio thread, and
- the page (`js/audio/engine.js`), which reads `meta` to build the menus, the BEAT FX panel and the X-PAD.

So keep effect modules free of DOM and worklet globals at module level. The sample rate arrives as a
constructor argument (always 44100: the site runs its AudioContext at the firmware's rate).

## Adding an effect

1. Create `beat/<name>.js` (Beat FX) or `color/<name>.js` (Sound Color FX) exporting `meta` and `Effect`.
2. Add one import line to `beat/index.js` or `color/index.js`.

That's all: it appears in the menus, BEAT ◀ ▶ steps through its `beats`, the X-PAD shows its pads or strip,
and LEVEL/DEPTH, the channel select and ON/OFF drive it.

## The contract

```js
export const meta = {
  name: 'ECHO',                 // menu and BEAT FX panel
  unit: 'beat',                 // 'beat': the panel shows BPM, msec and the beat; '%': it shows the percent
  // the values BEAT ◀ ▶ steps through; `value` is sent as the 'beat' param, `label` is shown
  beats: [{ label: '1/16', value: 1 / 16 }, ..., { label: '4', value: 4 }],
  defaultBeat: 3,               // index into beats when the effect is selected
  // X-PAD: omit for eight pads showing the first eight `beats`; or a touch strip that sends `param`
  // while touched and springs back to `centre` on release:
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 128, left: 'LPF', right: 'HPF' },
};

export class Effect {
  constructor(sampleRate) {}
  // Beat FX params: 'beat' (a beats[] value), 'level' (LEVEL/DEPTH 0..1), 'bpm' (the selected channel's
  // BPM, for tempo-synced effects), 'xpad' (the strip). Color FX: 'color' (-1..1, 0 = centre = off).
  set(param, value) {}
  // Beat FX only. The effect decides what off means; most let the tail ring out, then pass dry.
  setOn(on) {}
  // Stereo, n = 128 frames. Write the full output (dry + wet) to outL/outR. Inputs and outputs never alias.
  process(inL, inR, outL, outR, n) {}
}
```

Color FX are always running: the knob at centre must be a clean bypass.

## Porting another RX3 effect

`beat/reverb.js` came out of the firmware with the tools in `../../../re/` (see `re/README.md`): decompile the
effect class with Ghidra, read its tables out of the binary, run the original ARM code under an emulator to
render reference audio, and null-test the JavaScript against it (`npm test`). The player has every Beat FX
and Color FX as its own class in the `mixerengine` namespace (`BeatEffectEcho`, `BeatEffectDelay`,
`SoundColorFxSpace`, `SoundColorFxDubecho`, ...), so the next one follows the same path.
