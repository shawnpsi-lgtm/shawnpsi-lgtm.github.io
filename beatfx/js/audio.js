/* AudioContext, effect graphs, routing. Exposes window.Engine.
   Graph:
   BufferSource -> input -+-> dry ----------------------------------+-> master -> out
                          +-> preFilter -> wetIn -> [EFFECT] -> wet -+
   All gain/param moves use setTargetAtTime (no clicks). */
(function () {
  'use strict';
  var TC = 0.02; // default smoothing time constant (s)
  var ENTRY = { reverb: 'preDelay', echo: 'delay', dub: 'dubDelay' };
  var EXIT = { reverb: 'revShelf', echo: 'delay', dub: 'dubOut' };

  function deckState() { // one per deck: exact copies, independent playback + FX
    return { buffer: null, baseBuffer: null, source: null, srcGain: null,
             playing: false, startTime: 0, offset: 0,
             bpm: 120, baseBpm: 120, gridOffset: 0, synced: false,
             // per-deck FX: each deck has its own effect chain + settings, so
             // effects only touch the deck they're on
             fx: null, effect: 'echo', wired: null, on: false, mix: 0.5,
             bands: [], quantize: false, padMode: 'fx', timeKnob: 0.5,
             division: 0.5, filterHold: null, _swap: null,
             // DRUM effect: beat-synced sample roll layered over the track
             drumIndex: 0, drumRate: 1, _drumTimer: null, _drumNext: 0,
             // transport cues + nudge (per deck)
             cuePoint: 0, hotCues: [null, null], _nudgeDir: null, _nudgeStart: 0 };
  }

  // DRUM sample kit: shared read-only decoded buffers, selected per deck by the
  // LEVEL/DEPTH knob. Order = the LEVEL sweep order (low->high) + label order.
  var DRUM_FILES = ['roland-tr-909-kick_G_major.wav',
                    'roland-tr-909-clap_F_minor.wav',
                    'tr-909-snare-shot.wav'];

  var Engine = {
    ctx: null, limiter: null, washIR: null, drumBuffers: [],
    decks: [deckState(), deckState()],
    deck: 0, // the UI-focused deck; both decks are always audible
    bpm: 120, // mirrors the focused deck's tempo (for the app's readout)
    onEnded: function (deckIndex) {}
  };
  // active-deck views so callers keep reading Engine.buffer / Engine.playing
  Object.defineProperty(Engine, 'buffer', {
    get: function () { return Engine.decks[Engine.deck].buffer; }
  });
  Object.defineProperty(Engine, 'playing', {
    get: function () { return Engine.decks[Engine.deck].playing; }
  });

  /* --- lifecycle (call inside a user gesture for iOS) --- */
  Engine.ensure = function () {
    if (!Engine.ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      Engine.ctx = new AC();
      buildGraph();
    }
    if (Engine.ctx.state === 'suspended') Engine.ctx.resume();
    return Engine.ctx;
  };

  function decode(ab) {
    return new Promise(function (res, rej) {
      Engine.ctx.decodeAudioData(ab, res, rej); // callback form for old Safari
    });
  }

  /* WSOLA time-stretch: returns a new AudioBuffer alpha times as long, pitch
     preserved. Overlap-add of Hann frames, each aligned to the naturally-
     continued output by cross-correlation (kills the phasiness plain OLA
     gets). Stereo: the shift is found on a mono reference and applied to both
     channels so the image survives. alpha<1 shortens (faster), >1 lengthens. */
  function timeStretch(buffer, alpha) {
    var c = Engine.ctx, sr = buffer.sampleRate, chN = buffer.numberOfChannels;
    if (Math.abs(alpha - 1) < 0.002) return buffer; // no-op: reuse as-is
    var frame = Math.round(sr * 0.06);      // 60ms analysis/synthesis frame
    var syn = frame >> 1;                    // 50% overlap synthesis hop
    var ana = Math.max(1, Math.round(syn / alpha)); // analysis hop
    var seek = Math.round(sr * 0.008);       // +/-8ms WSOLA search radius
    var win = new Float32Array(frame);       // Hann window
    for (var i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (frame - 1));

    var inLen = buffer.length;
    var outLen = Math.max(frame, Math.round(inLen * alpha));
    var out = c.createBuffer(chN, outLen, sr);
    var ins = [], outs = [];
    for (var ch = 0; ch < chN; ch++) { ins.push(buffer.getChannelData(ch)); outs.push(out.getChannelData(ch)); }
    // mono reference for alignment (avg of channels)
    var ref = ins[0];
    if (chN > 1) {
      ref = new Float32Array(inLen);
      for (var j = 0; j < inLen; j++) { var s = 0; for (var ch2 = 0; ch2 < chN; ch2++) s += ins[ch2][j]; ref[j] = s / chN; }
    }

    var outPos = 0, anaPos = 0;
    // running "natural continuation" tail of the last synthesis frame (mono),
    // used as the correlation template for the next frame's best offset
    var tail = new Float32Array(syn);
    while (outPos + frame < outLen && anaPos + frame < inLen) {
      var best = 0, bestScore = -Infinity;
      if (anaPos > seek) {
        var lo = -Math.min(seek, anaPos), hi = seek;
        for (var d2 = lo; d2 <= hi; d2++) {
          // stride the correlation by 4: music is smooth over a few samples so
          // this finds the same alignment lag ~4x faster (keeps the UI snappy)
          var score = 0;
          for (var k = 0; k < syn; k += 4) score += tail[k] * ref[anaPos + d2 + k];
          if (score > bestScore) { bestScore = score; best = d2; }
        }
      }
      var src = anaPos + best;
      if (src < 0) src = 0;
      if (src + frame >= inLen) src = inLen - frame - 1;
      for (var ch3 = 0; ch3 < chN; ch3++) {
        var xi = ins[ch3], yo = outs[ch3];
        for (var m = 0; m < frame; m++) yo[outPos + m] += xi[src + m] * win[m];
      }
      // refresh the alignment template from the overlap region we just wrote
      for (var t2 = 0; t2 < syn; t2++) tail[t2] = ref[src + syn + t2] * win[syn + t2];
      outPos += syn;
      anaPos += ana;
    }
    return out;
  }

  function makeWashIR(c) {
    // Long DJ-transition wash: 5s RT60 of exponentially decaying noise.
    // A one-pole lowpass that closes over time damps highs progressively
    // (bright attack, dark tail), like a big plate. Independent noise per
    // channel gives stereo width; the convolver normalizes level itself.
    var sr = c.sampleRate, len = Math.floor(sr * 5);
    var buf = c.createBuffer(2, len, sr);
    for (var ch = 0; ch < 2; ch++) {
      var d = buf.getChannelData(ch), lp = 0;
      for (var i = 0; i < len; i++) {
        var t = i / len;
        var a = 0.55 - 0.45 * t; // filter coefficient: open -> closed
        lp += a * ((Math.random() * 2 - 1) - lp);
        d[i] = lp * Math.exp(-6.9 * t); // -60dB at 5s (no truncation click)
      }
    }
    return buf;
  }

  function loadDrums() { // fetch + decode each kit sample into Engine.drumBuffers[i]
    DRUM_FILES.forEach(function (f, i) {
      fetch('./drum/' + f)
        .then(function (r) { return r.arrayBuffer(); })
        .then(decode)
        .then(function (b) { Engine.drumBuffers[i] = b; })
        .catch(function () {}); // a missing sample just leaves that slot silent
    });
  }

  function buildGraph() {
    var c = Engine.ctx;
    Engine.washIR = makeWashIR(c); // one plate IR, shared read-only by both decks
    // shared master limiter: catches the summed overs of both decks' FX so
    // stacked echo build-ups don't hard-clip at the destination
    Engine.limiter = c.createDynamicsCompressor();
    Engine.limiter.threshold.value = -3; Engine.limiter.knee.value = 6;
    Engine.limiter.ratio.value = 12;
    Engine.limiter.attack.value = 0.003; Engine.limiter.release.value = 0.25;
    Engine.limiter.connect(c.destination);
    loadDrums(); // fetch + decode the drum kit (async; scheduler skips until ready)
    // each deck gets its own full FX chain so effects are deck-specific and
    // both decks' effects can run at once (they sum at the limiter)
    Engine.decks.forEach(function (d) {
      d.srcGain = c.createGain();
      buildDeckFx(d);
    });
  }

  // Build one deck's independent FX graph into d.fx and wire it up:
  //   srcGain -> input -+-> dry ------------------------> master -> padLp -> padHp -> [limiter]
  //                     +-> [bands/full] -> wetIn -> [FX] -> wet -+
  function buildDeckFx(d) {
    var c = Engine.ctx, n = d.fx = {};
    n.input = c.createGain();
    d.srcGain.connect(n.input);
    n.dry = c.createGain();
    n.wet = c.createGain(); n.wet.gain.value = 0;
    n.master = c.createGain();
    n.wetIn = c.createGain();
    n.input.connect(n.dry); n.dry.connect(n.master);
    n.wet.connect(n.master);
    // X-PAD lowpass/highpass modes: this deck's master-bus DJ filters in
    // series, both resting fully open so they're inaudible in other modes
    n.padLp = c.createBiquadFilter();
    n.padLp.type = 'lowpass'; n.padLp.frequency.value = 18000; n.padLp.Q.value = 1.2;
    n.padHp = c.createBiquadFilter();
    n.padHp.type = 'highpass'; n.padHp.frequency.value = 20; n.padHp.Q.value = 1.2;
    n.master.connect(n.padLp); n.padLp.connect(n.padHp); n.padHp.connect(Engine.limiter);

    // DRUM: scheduled kit hits sum into master (so the X-PAD filter rides them
    // too), layered on top of the untouched track — not an in-line processor.
    n.drumOut = c.createGain(); n.drumOut.gain.value = 0.9;
    n.drumOut.connect(n.master);

    // FX FREQUENCY: three parallel band filters into the wet path, each
    // behind its own gain so any combination can be active. A plain gain
    // ("full") carries the unfiltered signal when no band is selected.
    n.full = c.createGain();
    n.input.connect(n.full); n.full.connect(n.wetIn);
    n.bandGain = {};
    [['low', 'lowpass', 250, null],
     ['mid', 'bandpass', 1200, 0.7],
     ['hi', 'highpass', 2500, null]].forEach(function (b) {
      var f = c.createBiquadFilter();
      f.type = b[1]; f.frequency.value = b[2];
      if (b[3] !== null) f.Q.value = b[3];
      var g = c.createGain(); g.gain.value = 0;
      n.input.connect(f); f.connect(g); g.connect(n.wetIn);
      n.bandGain[b[0]] = g;
    });

    // Reverb: pre-delay -> convolver -> low cut -> high shelf (shared IR)
    n.preDelay = c.createDelay(0.5);
    n.convolver = c.createConvolver();
    n.convolver.buffer = Engine.washIR;
    n.revHp = c.createBiquadFilter();
    n.revHp.type = 'highpass'; n.revHp.frequency.value = 180;
    n.revShelf = c.createBiquadFilter();
    n.revShelf.type = 'highshelf';
    n.revShelf.frequency.value = 2800; n.revShelf.gain.value = 5;
    n.preDelay.connect(n.convolver);
    n.convolver.connect(n.revHp); n.revHp.connect(n.revShelf);
    // X-PAD reverb mode: dedicated full-range send/return into the plate
    n.padVerbSend = c.createGain(); n.padVerbSend.gain.value = 0;
    n.input.connect(n.padVerbSend); n.padVerbSend.connect(n.preDelay);
    n.padVerbRet = c.createGain(); n.padVerbRet.gain.value = 0;
    n.revShelf.connect(n.padVerbRet); n.padVerbRet.connect(n.master);

    // Echo: delay <-> feedback gain -> lowpass (repeats get darker)
    n.delay = c.createDelay(2);
    n.fb = c.createGain(); n.fb.gain.value = 0.45;
    n.fbFilter = c.createBiquadFilter();
    n.fbFilter.type = 'lowpass'; n.fbFilter.frequency.value = 3500;
    n.delay.connect(n.fb); n.fb.connect(n.fbFilter); n.fbFilter.connect(n.delay);

    // Dub echo: tape-style loop — every repeat is band-limited and
    // saturated again, so it gets darker, thinner, grittier each pass.
    n.dubDelay = c.createDelay(2);
    n.dubHp = c.createBiquadFilter();
    n.dubHp.type = 'highpass'; n.dubHp.frequency.value = 180;
    n.dubLp = c.createBiquadFilter();
    n.dubLp.type = 'lowpass'; n.dubLp.frequency.value = 2500;
    n.dubShaper = c.createWaveShaper(); n.dubShaper.curve = tanhCurve();
    n.dubFb = c.createGain(); n.dubFb.gain.value = 0;
    n.dubDelay.connect(n.dubHp); n.dubHp.connect(n.dubLp);
    n.dubLp.connect(n.dubShaper); n.dubShaper.connect(n.dubFb);
    n.dubFb.connect(n.dubDelay);
    // tape wow: slow LFO wobbles the delay time by a few ms
    n.dubLfo = c.createOscillator(); n.dubLfo.frequency.value = 0.9;
    n.dubLfoAmt = c.createGain(); n.dubLfoAmt.gain.value = 0.003;
    n.dubLfo.connect(n.dubLfoAmt); n.dubLfoAmt.connect(n.dubDelay.delayTime);
    n.dubLfo.start();
    // repeats plus a splash of the plate reverb on them
    n.dubOut = c.createGain();
    n.dubDelay.connect(n.dubOut);
    n.dubVerbSend = c.createGain(); n.dubVerbSend.gain.value = 0.15;
    n.dubDelay.connect(n.dubVerbSend); n.dubVerbSend.connect(n.convolver);
    n.convolver.connect(n.dubOut);

    wire(d, d.effect);   // initialise this deck's effect state
    applyBands(d);
    updateEchoTime(d);
    applyMix(d);
  }

  function wire(d, fx) {
    var n = d.fx;
    if (d.wired && ENTRY[d.wired]) { // DRUM has no inline path: nothing to unwire
      n.wetIn.disconnect(n[ENTRY[d.wired]]);
      n[EXIT[d.wired]].disconnect(n.wet);
    }
    if (ENTRY[fx]) {
      n.wetIn.connect(n[ENTRY[fx]]);
      n[EXIT[fx]].connect(n.wet);
    }
    d.wired = fx;
  }

  /* --- DRUM roll scheduler (per deck) -------------------------------------
     A lookahead timer fires the selected kit sample on the beat grid at the
     BEAT division rate, pitched by the TIME knob. Free-running from engage
     (or the next beat when QUANTIZE is lit), independent of track playback so
     it works as a stand-alone drum machine. */
  function deckPos(d) {
    if (!d.buffer) return 0;
    var p = d.playing ? d.offset + Engine.ctx.currentTime - d.startTime : d.offset;
    return Math.min(p, d.buffer.duration);
  }
  function fireDrum(d, when) {
    var buf = Engine.drumBuffers[d.drumIndex];
    if (!buf) return; // sample not decoded yet: skip this hit
    var s = Engine.ctx.createBufferSource();
    s.buffer = buf; s.playbackRate.value = d.drumRate;
    s.connect(d.fx.drumOut); s.start(when);
  }
  function drumScheduler(d) {
    var c = Engine.ctx, lookahead = 0.1;
    while (d._drumNext < c.currentTime + lookahead) {
      fireDrum(d, d._drumNext);
      // recompute spacing each hit so BEAT / TIME changes apply mid-roll
      d._drumNext += Math.max(0.03, (60 / d.bpm) * d.division);
    }
  }
  function startDrum(d) {
    if (d._drumTimer) return;
    var c = Engine.ctx, t0 = c.currentTime + 0.06;
    if (d.quantize && d.playing) { // align the first hit to the next beat
      var beat = 60 / d.bpm;
      var phase = ((deckPos(d) - d.gridOffset) % beat + beat) % beat;
      t0 = c.currentTime + (beat - phase);
    }
    d._drumNext = t0;
    d._drumTimer = setInterval(function () { drumScheduler(d); }, 25);
    drumScheduler(d);
  }
  function stopDrum(d) {
    if (d._drumTimer) { clearInterval(d._drumTimer); d._drumTimer = null; }
  }

  function echoFb(d) { return Math.min(0.9, d.mix * 0.9); } // repeat regen amount
  function dubFb(d) { return Math.min(0.95, d.mix * 0.95); } // hotter; clip bounds it

  function applyBands(d) { // FX FREQUENCY -> this deck's band gains
    var n = d.fx, t = Engine.ctx.currentTime, any = d.bands.length > 0;
    n.full.gain.setTargetAtTime(any ? 0 : 1, t, TC);
    Object.keys(n.bandGain).forEach(function (b) {
      n.bandGain[b].gain.setTargetAtTime(d.bands.indexOf(b) !== -1 ? 1 : 0, t, TC);
    });
  }

  function tanhCurve() { // tape-style soft clip (unity slope at zero, so
    var N = 1024;        // sub-unity feedback still decays)
    var curve = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      curve[i] = Math.tanh((i / (N - 1)) * 2 - 1);
    }
    return curve;
  }

  function applyMix(d, at) { // `at`: schedule the change in the future (quantize)
    var c = Engine.ctx, n = d.fx, t = at || c.currentTime;
    var m = d.on ? d.mix : 0;
    if (d.effect === 'drum') {
      // DRUM adds hits via drumOut; the track itself stays fully dry, untouched
      n.dry.gain.setTargetAtTime(1, t, TC);
      n.wet.gain.setTargetAtTime(0, t, TC);
      return;
    }
    if (d.effect === 'echo' || d.effect === 'dub') {
      // DJM-style echo / dub: dry stays at full and repeats stack on top.
      // LEVEL/DEPTH is the echo send *and* the feedback amount, and the
      // wet return stays open so the tail rings out after OFF / pause.
      n.dry.gain.setTargetAtTime(1, t, TC);
      n.wet.gain.setTargetAtTime(1, t, TC);
      n.wetIn.gain.setTargetAtTime(m, t, TC);
      n.fb.gain.setTargetAtTime(echoFb(d), t, TC);
      n.dubFb.gain.setTargetAtTime(dubFb(d), t, TC);
      return;
    }
    n.wetIn.gain.setTargetAtTime(1, t, TC);
    // Reverb depth is gated by the TIME knob: at min the crossfade stays
    // fully dry, so no reverb is heard regardless of LEVEL/DEPTH.
    if (d.effect === 'reverb') m *= d.timeKnob;
    n.dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, TC);
    n.wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, TC);
  }

  /* --- transport (operates on the focused deck) --- */
  Engine.setDeck = function (i) { // focus a deck; the other keeps playing
    Engine.deck = i;
    Engine.bpm = Engine.decks[i].bpm; // readout mirrors the focused deck
    // no FX re-apply needed: each deck's chain retains its own settings
  };

  Engine.isSynced = function () { return Engine.decks[Engine.deck].synced; };

  /* SYNC: keylock beat-match the focused deck to the other deck. We pre-render
     a pitch-preserved time-stretch and swap it in, then play at rate 1 — so
     pos/pause/seek/quantize all stay in buffer-time and need no rate math.
     Toggles: returns the new synced state. */
  Engine.sync = function () {
    var f = Engine.decks[Engine.deck], o = Engine.decks[1 - Engine.deck];
    if (!f.baseBuffer || !o.baseBuffer) return f.synced; // nothing to match to
    // Render the new buffer FIRST, while the current source keeps playing. The
    // time-stretch blocks the main thread but not the audio thread, so doing it
    // before the pause/swap means the music never goes silent — only the tiny
    // seek-style gap of the swap itself remains.
    var newBuffer, newBpm, newSynced;
    if (!f.synced) {
      var target = o.bpm;                       // match the other deck as heard
      newBuffer = timeStretch(f.baseBuffer, f.baseBpm / target); // <1 = faster
      newBpm = target; newSynced = true;
    } else {
      newBuffer = f.baseBuffer;                 // restore the original
      newBpm = f.baseBpm; newSynced = false;
    }
    // quick swap: pause (commits the live position), remap, restart on new buffer
    var wasPlaying = f.playing, oldDur = f.buffer.duration;
    if (wasPlaying) Engine.pause();
    f.buffer = newBuffer; f.bpm = newBpm; f.synced = newSynced;
    var ratio = f.buffer.duration / oldDur;     // remap position + grid to it
    f.offset *= ratio; f.gridOffset *= ratio;
    if (f.offset >= f.buffer.duration) f.offset = 0;
    if (wasPlaying) Engine.play();              // restart on the new buffer
    Engine.bpm = f.bpm; updateEchoTime(f);      // echoes follow what's heard
    return f.synced;
  };

  Engine.loadTrack = function (file) {
    Engine.ensure();
    Engine.pause();
    var d = Engine.decks[Engine.deck]; // bind to the deck the load started on
    return file.arrayBuffer().then(decode).then(function (buf) {
      d.buffer = buf; d.baseBuffer = buf; // fresh track: drop any prior sync
      d.offset = 0; d.synced = false;
      d.cuePoint = 0; d.hotCues = [null, null]; // and clear cues
      return buf;
    });
  };

  Engine.play = function () {
    var d = Engine.decks[Engine.deck];
    if (!d.buffer || d.playing) return;
    var c = Engine.ensure();
    if (d.offset >= d.buffer.duration) d.offset = 0;
    var src = c.createBufferSource();
    src.buffer = d.buffer;
    src.connect(d.srcGain);
    var deckIndex = Engine.deck;
    src.onended = function () {
      if (d.source !== src) return; // manual stop already handled
      d.playing = false; d.source = null; d.offset = 0;
      Engine.onEnded(deckIndex);
    };
    src.start(0, d.offset);
    d.source = src;
    d.startTime = c.currentTime;
    d.playing = true;
    d.srcGain.gain.setTargetAtTime(1, c.currentTime, TC);
  };

  Engine.pause = function () {
    var d = Engine.decks[Engine.deck];
    if (!d.playing) return;
    var c = Engine.ctx, src = d.source;
    d.offset = Math.min(d.offset + c.currentTime - d.startTime,
      d.buffer.duration);
    d.playing = false; d.source = null;
    // fade this deck's source only; effect tails ring out through master
    d.srcGain.gain.setTargetAtTime(0, c.currentTime, TC);
    src.onended = null;
    src.stop(c.currentTime + 0.08);
  };

  Engine.seek = function (frac) {
    var d = Engine.decks[Engine.deck];
    if (!d.buffer) return;
    var wasPlaying = d.playing;
    if (wasPlaying) Engine.pause();
    d.offset = Math.max(0, Math.min(1, frac)) * d.buffer.duration;
    if (wasPlaying) Engine.play();
  };

  Engine.pos = function () {
    var d = Engine.decks[Engine.deck];
    if (!d.buffer) return 0;
    var p = d.playing
      ? d.offset + Engine.ctx.currentTime - d.startTime : d.offset;
    return Math.min(p, d.buffer.duration);
  };

  /* --- CUE / HOT CUE / NUDGE (focused deck) --- */
  // Momentary cue preview: press plays from the current spot; release stops and
  // snaps back to where the press began (the cue point).
  Engine.cuePress = function () {
    var d = Engine.decks[Engine.deck];
    if (!d.buffer) return;
    d.cuePoint = Engine.pos(); // return here on release
    if (!d.playing) Engine.play();
  };
  Engine.cueRelease = function () {
    var d = Engine.decks[Engine.deck];
    if (!d.buffer) return;
    if (d.playing) Engine.pause();
    d.offset = Math.min(d.cuePoint, d.buffer.duration);
  };

  // Hot cue: empty slot -> set at the current position (returns 'set'); a set
  // slot -> jump there and play (returns 'hit'). i = 0 (A) or 1 (B).
  Engine.hotCue = function (i) {
    var d = Engine.decks[Engine.deck];
    if (!d.buffer) return null;
    if (d.hotCues[i] == null) { d.hotCues[i] = Engine.pos(); return 'set'; }
    if (d.playing) Engine.pause();
    d.offset = Math.min(d.hotCues[i], d.buffer.duration);
    Engine.play();
    return 'hit';
  };
  Engine.hotCueSet = function (i) { return Engine.decks[Engine.deck].hotCues[i] != null; };
  Engine.clearHotCue = function (i) { Engine.decks[Engine.deck].hotCues[i] = null; }; // long-press

  // Nudge: momentary phase bend for aligning the focused deck to the other.
  // Hold to bend the live source's rate +/-6%; release restores rate 1 and
  // shifts startTime so pos() stays accurate for the phase we moved.
  Engine.nudgeStart = function (dir) { // dir = +1 forward, -1 back
    var d = Engine.decks[Engine.deck];
    if (!d.playing || !d.source || d._nudgeDir != null) return;
    d._nudgeDir = dir; d._nudgeStart = Engine.ctx.currentTime;
    d.source.playbackRate.setTargetAtTime(1 + dir * 0.06, Engine.ctx.currentTime, 0.03);
  };
  Engine.nudgeEnd = function () {
    var d = Engine.decks[Engine.deck];
    if (d._nudgeDir == null) return;
    if (d.source) {
      var elapsed = Engine.ctx.currentTime - d._nudgeStart;
      d.source.playbackRate.setTargetAtTime(1, Engine.ctx.currentTime, 0.03);
      d.startTime -= d._nudgeDir * 0.06 * elapsed; // keep pos() ~accurate
    }
    d._nudgeDir = null;
  };

  /* --- effect + parameter control (all act on the focused deck) --- */
  Engine.setEffect = function (fx) {
    var d = Engine.decks[Engine.deck];
    if (fx === d.effect) return;
    var wasDrum = d.effect === 'drum';
    d.effect = fx;
    if (!Engine.ctx) return;
    if (wasDrum) stopDrum(d); // leaving DRUM: silence the roll
    var n = d.fx, c = Engine.ctx;
    n.wet.gain.setTargetAtTime(0, c.currentTime, TC); // fade wet out...
    clearTimeout(d._swap);
    d._swap = setTimeout(function () {                // ...rewire, fade back in
      wire(d, d.effect);
      updateEchoTime(d);
      applyMix(d);
      if (d.effect === 'drum' && d.on) startDrum(d); // entering DRUM while ON
    }, 120);
  };

  Engine.setOn = function (on) {
    var d = Engine.decks[Engine.deck];
    d.on = on;
    if (!Engine.ctx) return;
    if (d.effect === 'drum') { // ON starts/stops the roll (track stays dry)
      if (on) startDrum(d); else stopDrum(d);
      return;
    }
    var at = Engine.ctx.currentTime;
    if (d.quantize && d.playing) {
      // snap the engage/release to the track's next beat boundary
      // (grid anchored at track start — we detect tempo, not downbeat)
      var beat = 60 / d.bpm;
      var phase = ((Engine.pos() - d.gridOffset) % beat + beat) % beat;
      if (phase > 0.07) at += beat - phase; // within 70ms after a beat = now
    }
    applyMix(d, at);
  };

  Engine.setQuantize = function (q) { Engine.decks[Engine.deck].quantize = q; };

  Engine.setMix = function (v) {
    var d = Engine.decks[Engine.deck];
    if (d.effect === 'drum') { // LEVEL/DEPTH picks the kit sample (3 slots)
      d.drumIndex = Math.min(DRUM_FILES.length - 1, Math.floor(v * DRUM_FILES.length));
      return;
    }
    d.mix = v;
    if (Engine.ctx) applyMix(d);
  };

  Engine.setBands = function (bands) { // array of 'low'/'mid'/'hi'; [] = full range
    var d = Engine.decks[Engine.deck];
    d.bands = bands || [];
    if (Engine.ctx) applyBands(d);
  };

  Engine.setBpm = function (bpm) {
    Engine.bpm = bpm;
    var d = Engine.decks[Engine.deck];
    d.bpm = bpm; d.baseBpm = bpm; // manual/detected native tempo (sync reference)
    updateEchoTime(d);
  };
  Engine.setDivision = function (v) {
    Engine.decks[Engine.deck].division = v;
    updateEchoTime(Engine.decks[Engine.deck]);
  };

  function updateEchoTime(d) {
    if (!Engine.ctx) return;
    var beat = (60 / d.bpm) * d.division;
    var mult = Math.pow(2, (d.timeKnob - 0.5) * 2); // knob scales 0.5x..2x
    var t = Math.max(0.02, Math.min(2, beat * mult));
    d.fx.delay.delayTime.setTargetAtTime(t, Engine.ctx.currentTime, 0.05);
    d.fx.dubDelay.delayTime // headroom for the LFO wobble below 2s max
      .setTargetAtTime(Math.min(t, 1.99), Engine.ctx.currentTime, 0.05);
  }

  Engine.setTimeKnob = function (v) {
    var d = Engine.decks[Engine.deck];
    d.timeKnob = v;
    if (!Engine.ctx) return;
    if (d.effect === 'drum') { // TIME pitches the kit +/- one octave (centre = 1x)
      d.drumRate = Math.pow(2, (v - 0.5) * 2);
      return;
    }
    updateEchoTime(d);                         // echo/dub: delay time scale
    d.fx.preDelay.delayTime                    //  reverb: pre-delay 0..0.25s
      // slow glide: sweeping TIME doppler-bends the reverb input, the
      // Pioneer-style pitch swoop (down when raising, up when lowering)
      .setTargetAtTime(v * 0.25, Engine.ctx.currentTime, 0.2);
    if (d.effect === 'reverb') applyMix(d);    // reverb depth follows TIME
  };

  /* --- X-PAD: direct AudioParam writes, no debounce --- */
  // bipolar FILTER: centre (x=0.5) = both filters open (neutral); left half
  // sweeps a lowpass down (kills highs), right half sweeps a highpass up
  // (kills lows). One strip, deviation from centre = amount.
  function applyFilter(d, x, tc) {
    var n = d.fx, t = Engine.ctx.currentTime;
    if (x <= 0.5) { // lowpass on the left; highpass stays open
      n.padLp.frequency.setTargetAtTime(18000 * Math.pow(90 / 18000, (0.5 - x) * 2), t, tc);
      n.padHp.frequency.setTargetAtTime(20, t, tc);
    } else {        // highpass on the right; lowpass stays open
      n.padHp.frequency.setTargetAtTime(20 * Math.pow(8000 / 20, (x - 0.5) * 2), t, tc);
      n.padLp.frequency.setTargetAtTime(18000, t, tc);
    }
  }
  // double-tap on the FILTER pad latches it here; single-tap releases it
  Engine.setFilterHold = function (x) { Engine.decks[Engine.deck].filterHold = x; };
  Engine.releaseFilterHold = function () { Engine.decks[Engine.deck].filterHold = null; };

  Engine.setPadMode = function (m) { // 'fx' | 'filter' | 'reverb'
    var d = Engine.decks[Engine.deck];
    d.padMode = m;
    d.filterHold = null; // a mode change drops any parked filter
    if (!Engine.ctx) return;
    // rest the mode-specific paths so nothing sticks across a switch
    var n = d.fx, t = Engine.ctx.currentTime;
    n.padLp.frequency.setTargetAtTime(18000, t, 0.05);
    n.padHp.frequency.setTargetAtTime(20, t, 0.05);
    n.padVerbSend.gain.setTargetAtTime(0, t, TC);
    n.padVerbRet.gain.setTargetAtTime(0, t, 0.35);
  };

  Engine.padMove = function (x) { // x = 0..1
    if (!Engine.ctx) return;
    var d = Engine.decks[Engine.deck], n = d.fx, t = Engine.ctx.currentTime;
    if (d.padMode === 'filter') {
      applyFilter(d, x, 0.01);
    } else if (d.padMode === 'reverb') {
      // full-range throw into the plate, whatever effect is selected
      n.padVerbSend.gain.setTargetAtTime(Math.sin(x * Math.PI / 2), t, 0.01);
      n.padVerbRet.gain.setTargetAtTime(1, t, 0.01);
    } else if (d.effect === 'echo') {
      n.fb.gain.setTargetAtTime(Math.min(0.95, x * 0.95), t, 0.01); // hard clamp
    } else if (d.effect === 'dub') {
      // ride feedback past unity: the in-loop soft clip bounds the
      // self-oscillation (classic dub swell)
      n.dubFb.gain.setTargetAtTime(x * 1.05, t, 0.01);
    } else {
      // reverb: pad drives wet amount, still gated by TIME (silent at min)
      n.wet.gain.setTargetAtTime(Math.sin(x * d.timeKnob * Math.PI / 2), t, 0.01);
    }
  };

  Engine.padEnd = function () { // return to knob-set resting values
    if (!Engine.ctx) return;
    var d = Engine.decks[Engine.deck], n = d.fx, t = Engine.ctx.currentTime;
    if (d.padMode === 'filter') {
      // parked (double-tapped) -> stay there; otherwise snap back to centre
      applyFilter(d, d.filterHold != null ? d.filterHold : 0.5, 0.05);
    } else if (d.padMode === 'reverb') {
      n.padVerbSend.gain.setTargetAtTime(0, t, TC);      // stop feeding...
      n.padVerbRet.gain.setTargetAtTime(0, t, 0.35);     // ...tail rings out
    } else if (d.effect === 'echo') n.fb.gain.setTargetAtTime(echoFb(d), t, TC);
    else if (d.effect === 'dub') n.dubFb.gain.setTargetAtTime(dubFb(d), t, TC);
    else applyMix(d);
  };

  /* --- track analysis (rekordbox-style, runs on load) ----------------------
     BPM + beat-grid phase: render up to 60s through a low-pass (isolate the
     kick) offline, find amplitude peaks, tally the tempo implied by peak
     intervals, then take the circular mean of peak positions within a beat
     as the grid anchor. Waveform: peak amplitude per bucket. */
  Engine.analyze = function (buffer) {
    var waveform = makeWaveform(buffer, 240);
    var d = Engine.decks[Engine.deck]; // bind: a deck switch mid-analysis
    return Engine.detectBpm(buffer).then(function (r) { // must not misfile it
      d.gridOffset = r.offset;
      d.bpm = r.bpm; d.baseBpm = r.bpm; // native tempo of the base buffer
      return { bpm: r.bpm, gridOffset: r.offset, waveform: waveform };
    });
  };

  function makeWaveform(buffer, buckets) {
    var d = buffer.getChannelData(0);
    var per = Math.floor(d.length / buckets) || 1;
    var out = new Float32Array(buckets), max = 0, i, j, m, a;
    for (i = 0; i < buckets; i++) {
      m = 0;
      for (j = i * per; j < (i + 1) * per; j += 32) { // stride is fine for peaks
        a = d[j] < 0 ? -d[j] : d[j];
        if (a > m) m = a;
      }
      out[i] = m;
      if (m > max) max = m;
    }
    if (max > 0) for (i = 0; i < buckets; i++) out[i] /= max;
    return out;
  }

  Engine.detectBpm = function (buffer) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var sr = buffer.sampleRate;
    var len = Math.min(buffer.length, Math.floor(sr * 60));
    var oc = new OAC(1, len, sr);
    var src = oc.createBufferSource(); src.buffer = buffer;
    var lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 150;
    var hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
    src.connect(lp); lp.connect(hp); hp.connect(oc.destination);
    src.start(0);
    return oc.startRendering()
      .then(function (r) { return computeBpm(r.getChannelData(0), sr); })
      .catch(function () { return { bpm: 120, offset: 0 }; });
  };

  function computeBpm(data, sr) {
    var i, a, max = 0;
    for (i = 0; i < data.length; i++) { a = data[i] < 0 ? -data[i] : data[i]; if (a > max) max = a; }
    if (max === 0) return { bpm: 120, offset: 0 };
    var gap = Math.floor(sr * 0.25);   // ignore peaks <250ms apart (caps at 240 bpm)
    var peaks, thresh = 0.9;
    do {                               // lower the threshold until we have enough peaks
      peaks = [];
      for (i = 0; i < data.length; i++) {
        if ((data[i] < 0 ? -data[i] : data[i]) / max > thresh) { peaks.push(i); i += gap; }
      }
      thresh -= 0.05;
    } while (peaks.length < 20 && thresh > 0.2);
    var counts = {}, bpm;              // tally candidate tempos from peak intervals
    for (i = 0; i < peaks.length; i++) {
      for (var j = 1; j < 10 && i + j < peaks.length; j++) {
        bpm = 60 * sr / (peaks[i + j] - peaks[i]);
        while (bpm < 90) bpm *= 2;     // fold into 90..180
        while (bpm > 180) bpm /= 2;
        bpm = Math.round(bpm);
        counts[bpm] = (counts[bpm] || 0) + 1;
      }
    }
    var best = 120, bestN = 0;
    for (var b in counts) { if (counts[b] > bestN) { bestN = counts[b]; best = +b; } }
    // beat-grid phase: circular mean of where the peaks fall within a beat
    var P = 60 * sr / best, sx = 0, sy = 0;
    for (i = 0; i < peaks.length; i++) {
      a = (peaks[i] % P) / P * 2 * Math.PI;
      sx += Math.cos(a); sy += Math.sin(a);
    }
    a = Math.atan2(sy, sx);
    if (a < 0) a += 2 * Math.PI;
    return { bpm: best, offset: (a / (2 * Math.PI)) * P / sr };
  }

  window.Engine = Engine;
})();
