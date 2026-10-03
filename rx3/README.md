# rx3-web

An XDJ-RX3 for the browser: the unit's touch screen (SOURCE, BROWSE and the playing view), its buttons, two
decks, the mixer, and a Beat FX REVERB ported from the RX3's own firmware. Everything runs on the device in
Web Audio, so there is no server in the audio path and no added latency.

Static files only: no build step, no dependencies.

## Run

```sh
npm start            # python3 -m http.server 8080, then open http://localhost:8080
npm test             # the reverb against the firmware's own output (must print PASS)
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

REVERB works as on the unit: BEAT ◀ ▶ picks 1, 10, 25, 50, 75, 90 or 100 %, LEVEL/DEPTH sets the balance,
and the X-PAD is a touch strip that closes a low-pass (left) or opens a high-pass (right) on the reverb and
springs back when released. Turning it off lets the tail ring out.

## Layout

| Path | |
|---|---|
| `index.html`, `css/rx3.css` | The page; the screen is built at 1280x800 and scaled to fit |
| `js/main.js` | Buttons, keyboard, overlays, wiring |
| `js/ui/screen.js`, `browser.js`, `waveform.js` | The screen views, the browse tree, waveform drawing |
| `js/audio/engine.js` | AudioContext (44.1 kHz), mixer routing, the Beat FX and Color FX slots |
| `js/audio/deck.js`, `analyze.js` | Players (CUE, tempo, sync, nudge); waveform, BPM and beat detection |
| `js/audio/worklet.js` | The audio-thread processors: deck playback and the effect hosts |
| `js/fx/` | The effects and their registries; see `js/fx/README.md` to add one |
| `js/lib/` | The library sources (r2music, local files), ID3 and rekordbox beat-grid parsing |
| `tests/` | `null-test.mjs` and the firmware's reference renders it compares against |

## The reverb port

`js/fx/beat/reverb.js` is `mixerengine::BeatEffectReverb` from the XDJ-RX3 v1.19 player, method for method,
with its tables (`reverb-tables.js`) read straight out of the binary. Every operation is rounded to float32
as the firmware's NEON code does, and `npm test` checks it against the original ARM code (run under an
emulator) on seven scenarios: steady state, full wet, smallest room, percent glides, on/off tails, level moves
and X-PAD sweeps. All seven match sample for sample (zero difference). How it was done, and how to port the
next effect, is in `../re/README.md`.
