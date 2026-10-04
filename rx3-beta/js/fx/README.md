# Effects

Every effect is one ES module, a port of one `mixerengine` class from the XDJ-RX3 player. The modules are hosted
by ports of the player's two effect managers, both in `dsp.js`:

- `BeatManager` (BeatEffectManager): the Beat FX section, one instance of every Beat FX. It does what the unit does
  on ON / OFF / choosing another effect: crossfades between effects, lets ECHO and REVERB ring out after OFF, and
  carries the beat, level and BPM across.
- `ColorManager` (SoundColorFxManager): one channel's Sound Color FX, one instance of every Color FX. It switches
  between them (crossfades), holds DUB ECHO and SPACE ringing after they are turned off, and runs SWEEP's level
  detector every block.

The audio thread (`js/audio/worklet.js`) builds them from the registries (`beat/index.js`, `color/index.js`) and
runs them in the firmware's 64-sample blocks. The page (`js/audio/engine.js`) reads each module's `meta` for the
menus, the BEAT FX panel and the X-PAD. So keep effect modules free of DOM and worklet globals at module level. The
sample rate arrives as a constructor argument (always 44100: the site runs its AudioContext at the firmware's rate).

## The contract

A Beat FX module:

```js
export const meta = {
  name: 'ECHO',                 // menu and BEAT FX panel (and how the manager decides whether OFF rings out)
  unit: 'beat',                 // 'beat': the panel shows BPM, msec and the beat; '%': it shows the percent
  // the values BEAT left/right steps through: beatButtons(first, last) gives the firmware's beat buttons (value = the
  // beat factor, 1/16 .. 64); a '%' effect lists percents
  beats: beatButtons(0, 9),
  defaultBeat: 5,               // index into beats: the effect's own default button
  // X-PAD: omit for eight pads showing the first eight `beats`; or a touch strip that sends 'xpad' while touched
  // and springs back to `centre` on release:
  xpad: { kind: 'strip', param: 'xpad', min: 0, max: 255, centre: 255, left: 'FAST', right: 'OFF' },
};

// mixerengine::BeatEffect: extend BeatCore (dsp.js), which holds the fields the manager reads and writes (on,
// level, ms and its range, button and its range, percent, tail, pressed) and implements adjustParameter and
// checkBeatButtonRange. Pass the effect's position (+0x40): where it runs in the channel, 0 before the EQ, 1 before
// the fader, 2 after it (read it from the firmware object, see ../../../re/README.md). Override the firmware's
// hooks: changeLevelDepth, changeTime, changePercent, statusOn, statusOff, initialize, notifySelected,
// keepEffectInit, setXpad, and execute(inL, inR, outL, outR, n), which writes the effect's whole output (dry + wet).
// Inputs and outputs never alias.
export class EchoCore extends BeatCore { ... }
export const Core = EchoCore;
```

A Sound Color FX module:

```js
export const meta = { name: 'SPACE', type: 5 }; // type: EnSoundColorFxType, 1 FILTER .. 6 CRUSH
// mixerengine::SoundColorFx: extend ColorCore (dsp.js): color / param are 0..1 with 0.5 the centre; position is
// where the effect sits in the channel (0 before the EQ, 1 before the fader, 2 after it; at a position the Color FX
// runs before the Beat FX). Override changeColor, changeParameter, initialize,
// statusOn / statusOff (return 1 to be held ringing when turned off), detect (called every block) and execute.
export class SpaceCore extends ColorCore { ... }
export const Core = SpaceCore;
```

`dsp.js` also has the pieces the ports share: `f` (Math.fround) and `hex` (a float32 constant from its bits), the
firmware's parameter smoother (`Ramp`), its biquad (`Biquad`, which rounds differently in the first two samples of a
block, as the original does), and the beat-time maths.

## Adding an effect

1. Port the class (see `../../../re/README.md`): a new `beat/<name>.js` or `color/<name>.js` with `meta` and `Core`.
2. Add one import line to `beat/index.js` or `color/index.js`.
3. Add its reference scenarios to `re/fx_refs.py`, render them, and add the core to `../../tests/cores.mjs`.
   `npm test` must print PASS.

That's all: it appears in the menus, BEAT left/right steps through its `beats`, the X-PAD shows its pads or strip, and
LEVEL/DEPTH, COLOR, PARAMETER, the channel select and ON/OFF drive it through the manager.
