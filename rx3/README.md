# rx3-web

An XDJ-RX3 for the browser: the unit's touch screen (SOURCE, BROWSE and the playing view), its buttons, two
decks, the mixer, and effects ported from the RX3's own firmware: Beat FX ECHO, REVERB, FLANGER, PHASER, FILTER and
TRANS, and all six Sound Color FX (SPACE, DUB ECHO, SWEEP, NOISE, CRUSH, FILTER), together with the firmware's own
Beat FX and Color FX managers that switch them. Two extra Beat FX, DRUM and NOISE, come from shawnsingh.me/beatfx. Everything runs on the device in Web Audio, so there is no server in
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
| [ ] | BEAT left/right | X / H | mute / hide the controls |

The effects work as on the unit:

- **BEAT FX**: pick the effect, BEAT left/right (or an X-PAD pad) sets the beat (1/16 .. 16 or 64 beats of the selected
  channel's BPM; REVERB: 1 .. 100 %), LEVEL/DEPTH the depth, FX ON/OFF switches it. ON crossfades into the effect;
  OFF lets ECHO and REVERB ring out and crossfades the others back to the dry signal; choosing another effect while
  on crossfades over to it. Each effect keeps its own beat. FLANGER, PHASER and FILTER sweep once per beat time
  (a BEAT press restarts the sweep), and their X-PAD strip adds a faster second LFO (left = fastest). REVERB's
  X-PAD closes a low-pass (left) or opens a high-pass (right). Touching the X-PAD with the effect off turns it on
  while held.
- **LOW / MID / HI** (not on the RX3; the DJM-900NXS2's Beat FX frequency buttons): pick which bands (crossovers at
  300 Hz and 3 kHz, Linkwitz-Riley) the Beat FX acts on; a band that is off goes around the effect dry. All on (the
  default) is the RX3's Beat FX exactly. The bank stores them with each setup. `js/fx/bands.js`.
- **DRUM** and **NOISE** (not on the unit; from shawnsingh.me/beatfx) are layered over the untouched track. DRUM rolls
  a TR-909 snare at the beat: LEVEL/DEPTH is its volume, PITCH tunes it in semitones (-12 .. +12;
  double-click / double-tap for 0), the X-PAD strip bends it further while held, and while the
  selected channel's deck plays the hits land on its beat grid (stopped, it free-runs). NOISE is white noise through
  a high-pass and the REVERB, with a tremolo at the beat time: LEVEL/DEPTH is the tremolo depth, the X-PAD sweeps the
  high-pass. Both ring out after OFF. DRUM's sample is in `drum/`.
- **COLOR FX**: one effect for both channels, a COLOR knob per channel (centre = off) and a PARAMETER knob. DUB ECHO
  and SPACE sit after the channel fader, so they keep ringing when it closes, and keep ringing after the effect is
  turned off; picking the same effect again carries on with the tail.

On a phone (portrait) the bars are replaced by one panel that drives the deck tapped on the screen. Between BEAT FX
and FILTER, **PADS / VOL** swaps between (VOL until PADS is picked; the choice is remembered):

- **PADS**: the deck's eight pads. A, B, E and F are HOT CUE pads, read from the track's rekordbox analysis (the
  `.EXT`'s PCO2, with colours and comments, else the `.DAT`'s PCOB), lit in their rekordbox colour. A pad jumps
  there and plays from it, whether the deck was playing or paused. An empty pad stores the playhead (on the beat with QUANTIZE) until the page is closed. Loop cues
  jump to the loop's start. C and D are a 4-bar and a 2-bar beat loop (from the nearest beat with QUANTIZE; press
  again to exit, lit orange while on). Beside the pads, LOOP **1/2X** and **2X** halve or double the loop on from
  its start (1/32 to 512 beats); the pad shows the new length and still exits it. G and H are two of rekordbox's Pad FX, while held and only while playing:
  ROLL repeats a 1/4 beat (from the 1/4 beat it's in with QUANTIZE) and VINYL BRAKE slows the deck to a stop over
  2 beats. Both slip: on release the track carries on where it would have been.
- **VOL**: both channel faders and a Beat FX VOLUME (not on the unit), drawn as a mixer's channel faders: how much of
  the effect's change to the signal gets through, top = the firmware's output as is, bottom = dry. Drag anywhere in
  the strip and the cap follows the finger; double-tap for the top.

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
| `js/lib/` | The library sources (r2music, local files), ID3, and rekordbox beat-grid and hot cue parsing |
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

DRUM and NOISE are not firmware ports (the unit has no such effects), so `npm test` doesn't cover them.

Known differences from the unit: Beat FX quantize (snapping to the beat grid) is not modelled (the effects run as
with QUANTIZE off); the Color FX run after the EQ, where NOISE and SWEEP sit before it on the unit; switching Color
FX from FILTER to SWEEP does not reset the EQ as the unit does; what the X-PAD strip does on release could not be
fully settled from the firmware (here it springs back to rest); CRUSH uses powf, which the reference renders compute
in double precision and round, as the port does, where the unit's libm may differ in the last bit.
Color FX NOISE is louder than the unit's at low and middle PARAMETER settings (up to +9.5 dB, none at full); `npm
test` checks it with the boost off.
