# BEAT FX

A mobile-first static web app that clones the Beat FX section of a Pioneer
DJM-A9 mixer. Upload an audio file from your phone, play it, and manipulate it
live with three Web Audio effects:

- **REVERB** — ConvolverNode with a synthesized 5-second wash IR
  (exponentially decaying noise, highs damped progressively — bright attack,
  dark tail), through a low cut (180 Hz) and a high shelf (+5 dB above
  2.8 kHz) for Pioneer-style shimmer. Built for the DJ transition wash:
  LEVEL/DEPTH at max goes 100% wet. TIME knob scales the reverb amount
  (silent at min) and sets the pre-delay (sweeping it pitch-bends the tail).
- **ECHO** — DJM-style: the dry signal stays at full and repeats stack on
  top. LEVEL/DEPTH drives both the echo send and the feedback (up to 0.9,
  near-infinite build-up), and the tail rings out after OFF or pause. A
  lowpass in the loop darkens repeats. Delay time is beat-synced:
  `(60 / BPM) * beat division`, scaled 0.5x–2x by the TIME knob.
- **DUB** — tape-style dub echo: each repeat re-passes a highpass (180 Hz),
  lowpass (2.5 kHz) and a tanh soft clip, so it gets darker, thinner and
  grittier every pass. A slow LFO wobbles the delay time (tape wow), and a
  small send feeds the repeats through the plate reverb. Beat-synced like
  ECHO; the X-PAD rides feedback past unity into bounded self-oscillation.

Everything is vanilla HTML/CSS/JS — no frameworks, no build step, no CDNs.
Once loaded, the app works fully offline (the impulse responses ship in the
repo).

Tracks are analyzed on load, rekordbox-style: BPM, beat-grid phase (anchors
QUANTIZE), and a waveform drawn in the seek bar. Play enables when analysis
finishes.

## Controls

- **X-PAD** — touch strip; X position drives the current effect's key
  parameter live (echo → feedback, reverb → wet amount, dub → feedback ride
  into self-oscillation). Release to return to the knob-set value.
- **BEAT arrows** — step the echo beat division (1/8, 1/4, 1/2, 3/4, 1, 2).
- **TAP** — tap tempo (average of the last 4 tap intervals). AUTO/TAP resets
  to 120 BPM.
- **QUANTIZE** — when lit, ON/OFF engages/releases on the track's next beat
  boundary, so echo-outs land on the beat even with sloppy timing. The grid
  comes from the on-load analysis (tempo + beat phase from detected kicks).
- **FX FREQUENCY (LOW/MID/HI)** — band-limits what the effect processes; the
  dry signal always stays full-range. Any combination of bands can be active
  (e.g. MID + HI); with no band selected the effect gets the full range.
- **EFFECT SELECT / TIME / LEVEL-DEPTH** — drag knobs vertically.
  LEVEL/DEPTH crossfades dry/wet.
- **ON/OFF** — engages the effect (click-free crossfade; pulses while on).
- **A9 pill (top-right)** — toggles a skeuomorphic hardware skin
  (`css/skin-a9.css`): graphite faceplate, knurled knobs, OLED-style
  display, LED buttons, red-illuminated ON/OFF. Pure CSS, persisted in
  localStorage.

## Run locally

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>. To test on a phone, find your computer's
LAN IP (e.g. `ipconfig getifaddr en0` on macOS) and open
`http://<that-ip>:8000/` in mobile Safari/Chrome on the same Wi-Fi network.

## Deploy to GitHub Pages

1. Push this repo to GitHub (branch `main`).
2. Repo **Settings → Pages → Source**: select `main` branch, `/ (root)`.
3. Wait for Pages to publish; the app appears at
   `https://<username>.github.io/<repo-name>/`.

All asset paths are relative and a `.nojekyll` file is included, so the repo
root deploys as-is with no build step.

## Credits

The `ir/` folder ships **Greg Hopkins EMT 140 Plate Reverb IRs**
(CC Attribution, via the
[oramics/sampled](https://oramics.github.io/sampled/) collection) —
currently unused; the reverb IR is synthesized at startup.
