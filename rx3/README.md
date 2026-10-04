# rx3-web

An XDJ-RX3 for the browser: the unit's touch screen (SOURCE, BROWSE and the playing view), its buttons, two
decks, the mixer, and effects ported from the RX3's own firmware: Beat FX ECHO, REVERB, FLANGER, PHASER, FILTER and
TRANS, and all six Sound Color FX (SPACE, DUB ECHO, SWEEP, NOISE, CRUSH, FILTER), together with the firmware's own
Beat FX and Color FX managers that switch them. Everything runs on the device in Web Audio, so there is no server in
the audio path and no added latency.

Static files only: no build step, no dependencies.

## Run

```sh
npm start            # python3 -m http.server 8080, then open http://localhost:8080
npm test             # every effect against the firmware's own output (must print PASS)
```

Deploy by copying the folder anywhere static (for example next to `/beatfx` on shawnsingh.me). USB1 is the
r2music library and only works on an origin listed in r2music's `TRUSTED_ORIGINS` (`https://shawnsingh.me`);
USB2 is a folder or files from this computer (MENU → USB2, or drop files on the page).

## Using it

The screen works by touch/mouse like the unit; the buttons on the right are the hardware's, the bar below is
the effects section, and the strip under that is the mixer.

| Key | | Key | |
|---|---|---|---|
| ↑ ↓ / Enter | browse, PUSH | Esc / Backspace | BACK |
| 1 / 2 | LOAD deck 1 / 2 | Q / P | PLAY deck 1 / 2 |
| W / O | CUE deck 1 / 2 (hold at the cue to preview) | A D / K ; | nudge deck 1 / 2 |
| S B T L F | SOURCE, BROWSE, TAG LIST, PLAYLIST, SEARCH | M / I | MENU / INFO |
| G | tag the track | E | Beat FX on/off |
| [ ] | BEAT ◀ ▶ | X / H | mute / hide the controls |

The effects work as on the unit:

- **BEAT FX**: pick the effect, BEAT ◀ ▶ (or an X-PAD pad) sets the beat (1/16 .. 16 or 64 beats of the selected
  channel's BPM; REVERB: 1 .. 100 %), LEVEL/DEPTH the depth, FX ON/OFF switches it. ON crossfades into the effect;
  OFF lets ECHO and REVERB ring out and crossfades the others back to the dry signal; choosing another effect while
  on crossfades over to it. Each effect keeps its own beat. FLANGER, PHASER and FILTER sweep once per beat time
  (a BEAT press restarts the sweep), and their X-PAD strip adds a faster second LFO (left = fastest). REVERB's
  X-PAD closes a low-pass (left) or opens a high-pass (right). Touching the X-PAD with the effect off turns it on
  while held.
- **COLOR FX**: one effect for both channels, a COLOR knob per channel (centre = off) and a PARAMETER knob. DUB ECHO
  and SPACE sit after the channel fader, so they keep ringing when it closes, and keep ringing after the effect is
  turned off; picking the same effect again carries on with the tail.

## Layout

| Path | |
|---|---|
| `index.html`, `css/rx3.css` | The page; the screen is built at 1280x800 and scaled to fit |
| `js/main.js` | Buttons, keyboard, overlays, wiring |
| `js/ui/screen.js`, `browser.js`, `waveform.js` | The screen views, the browse tree, waveform drawing |
| `js/audio/engine.js` | AudioContext (44.1 kHz), mixer routing, the Beat FX and Color FX slots |
| `js/audio/deck.js`, `analyze.js` | Players (CUE, tempo, sync, nudge); waveform, BPM and beat detection |
| `js/audio/worklet.js` | The audio-thread processors: deck playback, the Beat FX section, each channel's Color FX + fader |
| `js/fx/` | The effects, the firmware's two effect managers (`dsp.js`) and the registries; see `js/fx/README.md` |
| `js/lib/` | The library sources (r2music, local files), ID3 and rekordbox beat-grid parsing |
| `tests/` | `null-test.mjs`, `cores.mjs` (what it tests and how) and the firmware's reference renders (`ref/`) |

## The ports

Every effect in `js/fx/` is the corresponding `mixerengine` class from the XDJ-RX3 v1.19 player, method for method,
with its tables (`*-table(s).js`) read straight out of the binary. Every operation is rounded to float32 at the same
points as the firmware's NEON code, and the effects run in the firmware's 64-sample blocks (the worklet splits Web
Audio's 128-frame quanta in two), so their per-block behaviour (parameter steps, glides, the managers' state
machines) runs at the unit's rate.

`npm test` checks the ports against the original ARM code, run under an emulator: each effect on its own on several
scenarios (parameter moves, times, X-PAD, on/off), the whole Beat FX section (BeatEffectManager with all six effects:
ON/OFF, tails, switching effects, BEAT presses, BPM changes), and a channel's whole Color FX section
(SoundColorFxManager with all six: switching, the held tails of DUB ECHO and SPACE). They all match sample for
sample; the only differences anywhere are a handful of denormals (around 1e-37, from NEON flushing them to zero),
more than 700 dB down. How it was done, and how to port the next effect, is in `../re/README.md`.

Known differences from the unit: Beat FX quantize (snapping to the beat grid) is not modelled (the effects run as
with QUANTIZE off); the Color FX run after the EQ, where NOISE and SWEEP sit before it on the unit; switching Color
FX from FILTER to SWEEP does not reset the EQ as the unit does; what the X-PAD strip does on release could not be
fully settled from the firmware (here it springs back to rest); CRUSH uses powf, which the reference renders compute
in double precision and round, as the port does, where the unit's libm may differ in the last bit.
