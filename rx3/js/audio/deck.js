// One player: load, play/pause, CDJ-style CUE, tempo, sync and nudge. The samples play in the worklet
// (DeckProcessor); this side keeps the state the screen draws and interpolates the position between reports.
import { analyze } from './analyze.js';

export const TEMPO_RANGES = [6, 10, 16, 100]; // %, 100 = WIDE

export class Deck {
  constructor(engine, index, onChange) {
    this.engine = engine;
    this.index = index;
    this.node = engine.decks[index];
    this.onChange = onChange;
    this.track = null;
    this.analysis = null; // { peaks, bpm, firstBeat, duration }
    this.loading = false;
    this.error = null;
    this.playing = false;
    this.cue = 0;
    this.cueHeld = false;
    this.hotHeld = null; // the hot cue being previewed from pause
    this.tempo = 0; // -1..1 of the range
    this.range = 10;
    this.nudge = 1;
    this.masterTempo = true; // MASTER TEMPO: tempo changes keep the key
    this.master = false;
    this.pos = 0; // seconds, as last reported
    this.at = 0; // context time of that report
    this.node.port.onmessage = (e) => {
      this.pos = e.data.pos;
      this.at = engine.ctx.currentTime;
      if (this.playing !== e.data.playing) {
        this.playing = e.data.playing;
        this.onChange();
      }
    };
    this.send({ type: 'masterTempo', value: this.masterTempo });
  }

  get loaded() {
    return !!this.analysis;
  }

  get rate() {
    return (1 + this.tempo * this.range / 100) * this.nudge;
  }

  get bpm() {
    return this.analysis?.bpm ? this.analysis.bpm * (1 + this.tempo * this.range / 100) : 0;
  }

  get duration() {
    return this.analysis?.duration || 0;
  }

  /** The playhead now, extrapolated from the worklet's last report. */
  position() {
    if (!this.playing) return this.pos;
    return Math.min(this.duration, this.pos + (this.engine.ctx.currentTime - this.at) * this.rate);
  }

  send(m) {
    this.node.port.postMessage(m);
  }

  async load(track) {
    this.send({ type: 'unload' });
    this.track = track;
    this.analysis = null;
    this.playing = false;
    this.loading = true;
    this.error = null;
    this.cue = 0;
    this.pos = 0;
    this.hotHeld = null;
    this.onChange();
    try {
      const [file] = await Promise.all([track.file(), track.prepare?.()]);
      if (this.track !== track) return; // something else was loaded meanwhile
      const audio = await this.engine.ctx.decodeAudioData(await file.arrayBuffer());
      if (this.track !== track) return;
      const a = analyze(audio, track);
      this.analysis = a;
      track.duration = track.duration || Math.round(a.duration);
      if (!track.bpm && a.bpm) { // remember what we found, for INFO, the browse columns and MATCHING
        track.bpm = a.bpm;
        track.bpmDetected = true;
      }
      this.cue = a.firstBeat > 0 && a.firstBeat < 30 ? a.firstBeat : 0;
      this.send({ type: 'load', l: audio.getChannelData(0), r: audio.numberOfChannels > 1 ? audio.getChannelData(1) : null,
        sampleRate: audio.sampleRate });
      this.seek(this.cue);
      this.sendRate();
    } catch (e) {
      if (this.track === track) this.error = 'Unable to play this file.';
      console.error(e);
    } finally {
      if (this.track === track) this.loading = false;
      this.onChange();
    }
  }

  seek(seconds) {
    this.pos = Math.max(0, Math.min(this.duration, seconds));
    this.at = this.engine.ctx.currentTime;
    this.send({ type: 'seek', seconds: this.pos });
  }

  sendRate() {
    this.send({ type: 'rate', value: this.rate });
  }

  play(on = !this.playing) {
    if (!this.loaded) return;
    if (this.hotHeld) { // PLAY while previewing a hot cue: keep playing when the pad is let go
      this.hotHeld = null;
      return this.onChange();
    }
    this.engine.resume();
    this.pos = this.position();
    this.at = this.engine.ctx.currentTime;
    this.playing = on;
    this.send({ type: 'play', value: on });
    this.onChange();
  }

  /** CDJ CUE: while playing, back to the cue and pause; while paused, set the cue here, or (held at the cue) play. */
  cueDown() {
    if (!this.loaded) return;
    if (this.playing) {
      this.play(false);
      this.seek(this.cue);
    } else if (Math.abs(this.position() - this.cue) < 0.01) {
      this.cueHeld = true;
      this.play(true);
    } else {
      this.cue = this.snap(this.position());
      this.seek(this.cue);
    }
    this.onChange();
  }

  cueUp() {
    if (!this.cueHeld) return;
    this.cueHeld = false;
    this.play(false);
    this.seek(this.cue);
  }

  /** The track's hot cue on pad i (0-7 = A-H), from rekordbox or set here. */
  hotCue(i) {
    return this.track?.cues?.find((c) => c.pad === i);
  }

  /**
   * HOT CUE pad: playing, jump to the cue and play on; paused, play from it while the pad is held. An empty pad
   * stores the playhead (on the beat with QUANTIZE). Loop cues jump to the loop's start (loops aren't modelled).
   */
  hotCueDown(i, quantize) {
    if (!this.loaded) return;
    const c = this.hotCue(i);
    if (!c) {
      const t = this.position();
      (this.track.cues ||= []).push({ pad: i, time: quantize ? this.snap(t) : t, loop: false, color: null, comment: '' });
    } else {
      this.seek(c.time);
      if (!this.playing) {
        this.play(true);
        this.hotHeld = c;
      }
    }
    this.onChange();
  }

  hotCueUp() {
    const c = this.hotHeld;
    if (!c) return;
    this.hotHeld = null;
    this.play(false);
    this.seek(c.time);
  }

  /** Snap to the nearest beat (QUANTIZE) when there is a grid. */
  snap(t) {
    const a = this.analysis;
    if (!a?.bpm) return t;
    const beat = 60 / a.bpm;
    return a.firstBeat + Math.round((t - a.firstBeat) / beat) * beat;
  }

  setTempo(x) {
    this.tempo = Math.max(-1, Math.min(1, x));
    this.sendRate();
    this.onChange();
  }

  setMasterTempo(on = !this.masterTempo) {
    this.masterTempo = on;
    this.send({ type: 'masterTempo', value: on });
    this.onChange();
  }

  setRange(r) {
    const bpm = this.bpm;
    this.range = r;
    if (bpm && this.analysis.bpm) this.tempo = Math.max(-1, Math.min(1, (bpm / this.analysis.bpm - 1) * 100 / r));
    this.sendRate();
    this.onChange();
  }

  /** Pitch bend while held (the jog wheel's outer edge). */
  setNudge(dir) {
    this.nudge = 1 + dir * 0.04;
    this.sendRate();
  }

  /** BEAT SYNC to the other deck: match its BPM, then line the beats up. */
  sync(other) {
    if (!this.loaded || !other.loaded || !other.bpm || !this.analysis.bpm) return;
    let ratio = other.bpm / this.analysis.bpm;
    while (ratio > 1.5) ratio /= 2; // half/double time
    while (ratio < 0.75) ratio *= 2;
    const needed = (ratio - 1) * 100;
    if (Math.abs(needed) > this.range) this.range = TEMPO_RANGES.find((r) => r >= Math.abs(needed)) || 100;
    this.tempo = needed / this.range;
    this.sendRate();
    if (other.playing) {
      const ob = 60 / other.analysis.bpm, mb = 60 / this.analysis.bpm;
      const phase = (((other.position() - other.analysis.firstBeat) / ob) % 1 + 1) % 1;
      const here = this.position(), mine = (((here - this.analysis.firstBeat) / mb) % 1 + 1) % 1;
      let d = (phase - mine) * mb;
      if (d > mb / 2) d -= mb;
      if (d < -mb / 2) d += mb;
      this.seek(here + d);
    }
    this.onChange();
  }

  eject() {
    this.send({ type: 'unload' });
    this.track = this.analysis = this.hotHeld = null;
    this.playing = false;
    this.onChange();
  }
}
