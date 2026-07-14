/* AudioContext, effect graphs, routing. Exposes window.Engine.
   Graph:
   BufferSource -> input -+-> dry ----------------------------------+-> master -> out
                          +-> preFilter -> wetIn -> [EFFECT] -> wet -+
   All gain/param moves use setTargetAtTime (no clicks). */
(function () {
  'use strict';
  var TC = 0.02; // default smoothing time constant (s)
  var ENTRY = { reverb: 'preDelay', echo: 'delay', dub: 'dubDelay' };
  var EXIT = { reverb: 'revMix', echo: 'delay', dub: 'dubOut' };

  function deckState() { // one per deck: exact copies, independent playback + FX
    return { buffer: null, baseBuffer: null, source: null, srcGain: null,
             playing: false, startTime: 0, offset: 0,
             bpm: 120, baseBpm: 120, gridOffset: 0, synced: false,
             // per-deck FX: each deck has its own effect chain + settings, so
             // effects only touch the deck they're on
             fx: null, effect: 'echo', wired: null, on: false, mix: 0.5,
             fxVol: 1, // FX VOL trim: scales what the effect adds, never the dry track
             bands: [], quantize: false, padMode: 'filter', timeKnob: 0.5,
             division: 0.5, filterHold: null, _swap: null,
             // DRUM effect: beat-synced sample roll layered over the track
             drumIndex: 2, drumRate: 1, _drumTimer: null, _drumNext: 0, // snare default
             // NOISE effect: white-noise-through-reverb wash, tremolo'd.
             // TIME (depth) reuses timeKnob above; tempo gets its own field
             // since it's re-read by updateNoiseTempo on every BPM/division change
             noiseTempo: 0.5,
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

  function makeWashIR(c, secs) {
    // DJ-transition wash: `secs` RT60 of exponentially decaying noise.
    // A one-pole lowpass that closes over time damps highs progressively
    // (bright attack, dark tail), like a big plate. Independent noise per
    // channel gives stereo width; the convolver normalizes level itself.
    var sr = c.sampleRate, len = Math.floor(sr * secs);
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

  function makeNoiseBuffer(c) { // shared white-noise loop for the NOISE effect
    var len = c.sampleRate * 2, buf = c.createBuffer(1, len, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
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
    Engine.washIR = makeWashIR(c, 5); // one plate IR, shared read-only by both decks
    Engine.washIRShort = makeWashIR(c, 1.2); // tight plate for low reverb TIME
    // shared master limiter: catches the summed overs of both decks' FX so
    // stacked echo build-ups don't hard-clip at the destination
    Engine.limiter = c.createDynamicsCompressor();
    Engine.limiter.threshold.value = -3; Engine.limiter.knee.value = 6;
    Engine.limiter.ratio.value = 12;
    Engine.limiter.attack.value = 0.003; Engine.limiter.release.value = 0.25;
    Engine.limiter.connect(c.destination);
    loadDrums(); // fetch + decode the drum kit (async; scheduler skips until ready)
    Engine.noiseBuffer = makeNoiseBuffer(c); // shared white-noise source for NOISE effect
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
    // FX VOL: output trim on everything the effect adds (wet path + drum
    // hits); the dry track goes straight to master, untouched
    n.fxVol = c.createGain(); n.fxVol.gain.value = d.fxVol;
    n.wet.connect(n.fxVol); n.fxVol.connect(n.master);
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
    n.drumOut.connect(n.fxVol);

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
    // Knob-reverb TIME = reverb length. A convolver's decay is fixed, so
    // length is a crossfade between a tight 1.2s plate and the 5s wash,
    // fading to silence at TIME 0 (see updateReverbTime). The blend is the
    // knob reverb's private exit (EXIT.reverb = revMix); the pad/dub/noise
    // paths keep the fixed long plate.
    n.convShort = c.createConvolver();
    n.convShort.buffer = Engine.washIRShort;
    n.revHpS = c.createBiquadFilter();
    n.revHpS.type = 'highpass'; n.revHpS.frequency.value = 180;
    n.preDelay.connect(n.convShort); n.convShort.connect(n.revHpS);
    n.revLongG = c.createGain(); n.revLongG.gain.value = 0;
    n.revShortG = c.createGain(); n.revShortG.gain.value = 0;
    n.revMix = c.createGain();
    n.revShelf.connect(n.revLongG); n.revLongG.connect(n.revMix);
    n.revHpS.connect(n.revShortG); n.revShortG.connect(n.revMix);

    // Echo: delay <-> feedback gain -> lowpass (repeats get darker) -> soft
    // clip. The clipper (unity slope at zero, so decay is untouched) bounds
    // the loop: at max LEVEL the continuous send would otherwise build up to
    // ~10x dry (steady state 1/(1-fb)) and run away.
    n.delay = c.createDelay(2);
    n.fb = c.createGain(); n.fb.gain.value = 0.45;
    n.fbFilter = c.createBiquadFilter();
    n.fbFilter.type = 'lowpass'; n.fbFilter.frequency.value = 3500;
    n.fbClip = c.createWaveShaper(); n.fbClip.curve = tanhCurve();
    n.delay.connect(n.fb); n.fb.connect(n.fbFilter);
    n.fbFilter.connect(n.fbClip); n.fbClip.connect(n.delay);

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

    // NOISE: white noise -> highpass -> tremolo -> the SAME shared reverb
    // plate as REVERB/X-PAD reverb mode. Not an inline processor (no
    // ENTRY/EXIT, like DRUM) — the track stays dry. The source loops forever
    // (started once here, like dubLfo/noiseLfo below) and ON/OFF gates
    // noiseSend instead of stopping it: once a BufferSource's audio-rate
    // input to a subgraph stops, Chrome silently freezes setTargetAtTime
    // automation on that subgraph's params (confirmed: ctx.currentTime keeps
    // advancing but the gain value doesn't move) — keeping the source live
    // sidesteps that. Gating one node earlier still lets the convolver's
    // tail ring out naturally through the always-open noiseOut after OFF.
    n.noiseSrc = c.createBufferSource();
    n.noiseSrc.buffer = Engine.noiseBuffer; n.noiseSrc.loop = true;
    n.noiseSend = c.createGain(); n.noiseSend.gain.value = 0;
    n.noiseHp = c.createBiquadFilter();
    n.noiseHp.type = 'highpass'; n.noiseHp.frequency.value = 600; // ponytail: fixed cutoff, add a knob if tunable shaping is wanted
    n.noiseSrc.connect(n.noiseSend); n.noiseSend.connect(n.noiseHp);
    n.noiseHp.connect(n.preDelay);
    n.noiseSrc.start();
    n.noiseOut = c.createGain(); // post-reverb tap, parity with drumOut
    n.noiseOut.gain.value = 0;   // closed outside NOISE mode (see updateNoiseDepth)
    n.revShelf.connect(n.noiseOut); n.noiseOut.connect(n.fxVol);
    // tremolo pumps the post-reverb tap: modulating before the convolver is
    // inaudible (the 5s plate smears any chop flat), after it you hear the
    // classic LFO pump. Depth rides noiseOut's base gain +/- the LFO.
    n.noiseLfo = c.createOscillator(); n.noiseLfo.frequency.value = 4;
    n.noiseLfoAmt = c.createGain(); n.noiseLfoAmt.gain.value = 0;
    n.noiseLfo.connect(n.noiseLfoAmt); n.noiseLfoAmt.connect(n.noiseOut.gain);
    n.noiseLfo.start();

    wire(d, d.effect);   // initialise this deck's effect state
    applyBands(d);
    updateEchoTime(d);
    updateReverbTime(d);
    updateNoiseDepth(d);
    updateNoiseTempo(d);
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
     A lookahead timer fires the selected kit sample at the BEAT division
     rate, pitched by the TIME knob. While the track plays, every hit is
     locked to its beat grid so the roll always matches the song; paused,
     it free-runs as a stand-alone drum machine. */
  function fireDrum(d, when) {
    var buf = Engine.drumBuffers[d.drumIndex];
    if (!buf) return; // sample not decoded yet: skip this hit
    var s = Engine.ctx.createBufferSource();
    s.buffer = buf; s.playbackRate.value = d.drumRate;
    s.connect(d.fx.drumOut); s.start(when);
  }
  function drumScheduler(d) {
    var c = Engine.ctx, horizon = c.currentTime + 0.1; // lookahead
    // recompute spacing each tick so BEAT / TAP changes apply mid-roll
    var step = Math.max(0.03, (60 / d.bpm) * d.division);
    if (d.playing) {
      // grid-locked: hits land on the track's beat-grid subdivisions, so the
      // roll always matches the song. Re-anchored from the live transport
      // every tick, so seek / hot cue / nudge can't drift it. _drumNext is a
      // watermark (first grid time not yet scheduled) to avoid re-fires.
      var gridT = d.startTime - d.offset + d.gridOffset; // ctx time of grid zero
      var from = Math.max(d._drumNext, c.currentTime);
      var t = gridT + Math.ceil((from - gridT) / step - 1e-9) * step;
      for (; t < horizon; t += step) fireDrum(d, t);
      d._drumNext = Math.max(d._drumNext, t);
    } else { // paused: free-run from the last hit (stand-alone drum machine)
      while (d._drumNext < horizon) {
        fireDrum(d, d._drumNext);
        d._drumNext += step;
      }
    }
  }
  function startDrum(d) {
    if (d._drumTimer) return;
    // playing: the scheduler grid-aligns every hit, first one included
    d._drumNext = Engine.ctx.currentTime + (d.playing ? 0 : 0.06);
    d._drumTimer = setInterval(function () { drumScheduler(d); }, 25);
    drumScheduler(d);
  }
  function stopDrum(d) {
    if (d._drumTimer) { clearInterval(d._drumTimer); d._drumTimer = null; }
  }

  /* --- NOISE roll (per deck): the white-noise source loops forever (started
     once in buildDeckFx); ON/OFF gates noiseSend so the tail still rings out
     through the always-open noiseOut, same trick echo's wetIn gating uses. --- */
  function startNoise(d) {
    d.fx.noiseSend.gain.setTargetAtTime(1, Engine.ctx.currentTime, TC);
  }
  function stopNoise(d) {
    d.fx.noiseSend.gain.setTargetAtTime(0, Engine.ctx.currentTime, TC);
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
    if (d.effect === 'drum' || d.effect === 'noise') {
      // DRUM/NOISE add their own layer via drumOut/noiseOut; the track
      // itself stays fully dry, untouched
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
    // Reverb (the only effect reaching here): sonically identical to the X-PAD
    // reverb throw, and it tails out the same way. Same shared 5s plate
    // (updateReverbTime keeps it long-only), dry stays full, and LEVEL drives
    // the return on the exact same sin curve and unity gain the pad uses
    // (send sin(x) x return 1 == wetIn 1 x wet sin(m)).
    n.dry.gain.setTargetAtTime(1, t, TC);
    n.wetIn.gain.setTargetAtTime(d.on ? 1 : 0, t, TC); // OFF stops feeding the plate
    if (d.on) n.wet.gain.setTargetAtTime(Math.sin(d.mix * Math.PI / 2), t, TC);
    else n.wet.gain.setTargetAtTime(0, t, 0.6); // ...but the return rings the tail out (like padEnd)
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
    Engine.bpm = f.bpm;                         // FX follow what's heard
    updateEchoTime(f); updateReverbTime(f);
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

  Engine.play = function (idx) { // idx: optional deck override (default focused)
    var deckIndex = idx == null ? Engine.deck : idx;
    var d = Engine.decks[deckIndex];
    if (!d.buffer || d.playing) return;
    var c = Engine.ensure();
    if (d.offset >= d.buffer.duration) d.offset = 0;
    var src = c.createBufferSource();
    src.buffer = d.buffer;
    src.connect(d.srcGain);
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

  Engine.pause = function (idx) { // idx: optional deck override (default focused)
    var d = Engine.decks[idx == null ? Engine.deck : idx];
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

  Engine.posOf = function (i) { // live position of either deck (s into its buffer)
    var d = Engine.decks[i];
    if (!d.buffer) return 0;
    var p = d.playing
      ? d.offset + Engine.ctx.currentTime - d.startTime : d.offset;
    return Math.min(p, d.buffer.duration);
  };
  Engine.pos = function () { return Engine.posOf(Engine.deck); };

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

  /* --- SCRATCH (waveform view): vinyl-style scrub on either deck ----------
     A BufferSource can't play backwards, so scratching runs through a tiny
     AudioWorklet that reads the buffer at a position slewed toward the
     finger each sample — the slew velocity IS the playback rate, so drag
     speed and direction become pitch, both ways, with no direction-flip
     seams. Scratching pauses the deck (offset = the finger), feeds the
     deck's FX input (so effects ride the scrub), and release resumes play
     if the deck was playing (vinyl let-go). */
  var SCRATCH_SRC =
    "class S extends AudioWorkletProcessor {\n" +
    "  constructor() { super(); this.chs = null; this.bsr = 48000;\n" +
    "    this.pos = 0; this.tgt = 0; this.on = false;\n" +
    "    var self = this;\n" +
    "    this.port.onmessage = function (e) { var m = e.data;\n" +
    "      if (m.buf) { self.chs = m.buf; self.bsr = m.sr; }\n" +
    "      if (m.jump != null) { self.pos = m.jump; self.tgt = m.jump; }\n" +
    "      if (m.target != null) self.tgt = m.target;\n" +
    "      if (m.active != null) self.on = m.active; }; }\n" +
    "  process(inputs, outputs) {\n" +
    "    var o = outputs[0];\n" +
    "    if (!this.chs || !this.on) return true; // outputs pre-zeroed\n" +
    "    var k = 1 - Math.exp(-1 / (sampleRate * 0.02)); // ~20ms position slew\n" +
    "    for (var i = 0; i < o[0].length; i++) {\n" +
    "      this.pos += (this.tgt - this.pos) * k;\n" +
    "      var idx = this.pos * this.bsr, i0 = Math.floor(idx), fr = idx - i0;\n" +
    "      for (var c = 0; c < o.length; c++) {\n" +
    "        var d = this.chs[c < this.chs.length ? c : 0];\n" +
    "        var a = d[i0] || 0, b = d[i0 + 1] || 0;\n" +
    "        o[c][i] = a + (b - a) * fr;\n" +
    "      }\n" +
    "    }\n" +
    "    return true;\n" +
    "  }\n" +
    "}\n" +
    "registerProcessor('scratch', S);";
  var scratchModule = null;
  function ensureScratchModule() {
    if (!scratchModule) {
      var url = URL.createObjectURL(new Blob([SCRATCH_SRC], { type: 'application/javascript' }));
      scratchModule = Engine.ctx.audioWorklet.addModule(url);
    }
    return scratchModule;
  }

  Engine.scratchStart = function (i) {
    var d = Engine.decks[i];
    if (!d.buffer || d._scratching) return;
    Engine.ensure(); // pointerdown = the required user gesture
    d._scratchWasPlaying = d.playing;
    if (d.playing) Engine.pause(i); // commits offset = live position
    d._scratching = true;
    ensureScratchModule().then(function () {
      if (!d._scratching) return; // finger already lifted
      if (!d._scratchNode) {
        d._scratchNode = new AudioWorkletNode(Engine.ctx, 'scratch', { outputChannelCount: [2] });
        d._scratchNode.connect(d.fx.input); // post-srcGain: FX ride the scrub
      }
      if (d._scratchBuf !== d.buffer) { // (re)send on new track / sync swap
        // ponytail: full channel copy into the worklet (~2x track memory);
        // stream windows instead if mobile memory becomes a problem
        var chs = [];
        for (var c = 0; c < Math.min(2, d.buffer.numberOfChannels); c++)
          chs.push(d.buffer.getChannelData(c));
        d._scratchNode.port.postMessage({ buf: chs, sr: d.buffer.sampleRate });
        d._scratchBuf = d.buffer;
      }
      d._scratchNode.port.postMessage({ active: true, jump: d.offset });
    });
  };
  Engine.scratchMove = function (i, pos) { // pos: finger's buffer position (s)
    var d = Engine.decks[i];
    if (!d._scratching || !d.buffer) return;
    d.offset = Math.max(0, Math.min(pos, d.buffer.duration)); // view + resume point
    if (d._scratchNode) d._scratchNode.port.postMessage({ target: d.offset });
  };
  Engine.scratchEnd = function (i) {
    var d = Engine.decks[i];
    if (!d._scratching) return;
    d._scratching = false;
    if (d._scratchNode) d._scratchNode.port.postMessage({ active: false });
    if (d._scratchWasPlaying) Engine.play(i); // vinyl let-go: resume from here
  };

  /* --- effect + parameter control (all act on the focused deck) --- */
  Engine.setEffect = function (fx) {
    var d = Engine.decks[Engine.deck];
    if (fx === d.effect) return;
    var wasDrum = d.effect === 'drum', wasNoise = d.effect === 'noise';
    d.effect = fx;
    if (!Engine.ctx) return;
    if (wasDrum) stopDrum(d); // leaving DRUM: silence the roll
    if (wasNoise) stopNoise(d); // leaving NOISE: let the tail ring out
    var n = d.fx, c = Engine.ctx;
    n.wet.gain.setTargetAtTime(0, c.currentTime, TC); // fade wet out...
    clearTimeout(d._swap);
    d._swap = setTimeout(function () {                // ...rewire, fade back in
      wire(d, d.effect);
      updateEchoTime(d);
      updateReverbTime(d); // resync decay blend to the TIME knob on entry
      if (d.effect === 'drum' && d.on) startDrum(d); // entering DRUM while ON
      updateNoiseDepth(d); // self-gating: closes the plate's noise exit outside NOISE
      if (d.effect === 'noise') {
        // resync tempo to whatever LEVEL already shows, so the sound
        // doesn't lag the visible knob position after a switch
        updateNoiseTempo(d);
        if (d.on) startNoise(d);
      }
      applyMix(d);
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
    if (d.effect === 'noise') { // ON starts/stops the noise wash (track stays dry)
      if (on) startNoise(d); else stopNoise(d);
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

  Engine.setFxVol = function (v) { // FX VOL knob: effect-output level, 0..1
    var d = Engine.decks[Engine.deck];
    d.fxVol = v;
    if (Engine.ctx) d.fx.fxVol.gain.setTargetAtTime(v, Engine.ctx.currentTime, TC);
  };

  Engine.setMix = function (v) {
    var d = Engine.decks[Engine.deck];
    if (d.effect === 'drum') { // LEVEL/DEPTH picks the kit sample (3 slots)
      d.drumIndex = Math.min(DRUM_FILES.length - 1, Math.floor(v * DRUM_FILES.length));
      return;
    }
    if (d.effect === 'noise') { // LEVEL/DEPTH sets the tremolo tempo (BEAT-synced)
      d.noiseTempo = v;
      updateNoiseTempo(d);
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
    updateReverbTime(d);
    updateNoiseTempo(d);
  };
  Engine.setDivision = function (v) {
    var d = Engine.decks[Engine.deck];
    d.division = v;
    updateEchoTime(d);
    updateReverbTime(d); // noise tempo ignores division on purpose
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

  function updateReverbTime(d) { // knob reverb == the X-PAD throw: the full 5s
    if (!Engine.ctx) return;     // long plate only, LEVEL sets the amount.
    var t = Engine.ctx.currentTime, v = d.timeKnob;
    var beat = (60 / d.bpm) * d.division;
    // long plate only (revMix == revShelf), so the wet is the exact same
    // signal the X-PAD reverb taps; the short plate stays out of the blend
    d.fx.revLongG.gain.setTargetAtTime(1, t, TC);
    d.fx.revShortG.gain.setTargetAtTime(0, t, TC);
    // pre-delay rides the grid (shared node, so the X-PAD reverb inherits the
    // same swoop): TIME sweeps 0..1 beat-division, the Pioneer-style pitch
    // bend when TIME/tempo moves. 0.5s = delay line max.
    d.fx.preDelay.delayTime.setTargetAtTime(Math.min(0.5, beat * v), t, 0.2);
  }

  function updateNoiseDepth(d) { // TIME knob (0..1) -> tremolo depth
    if (!Engine.ctx) return;
    var t = Engine.ctx.currentTime, v = d.timeKnob;
    // noiseOut is the shared plate's third exit and it is NOT gated by
    // ON/OFF or the wet crossfade — outside NOISE mode both its base gain
    // and the LFO swing must sit at 0, or the reverb/dub plate leaks to
    // master even with the effect off.
    if (d.effect !== 'noise') {
      d.fx.noiseOut.gain.setTargetAtTime(0, t, TC);
      d.fx.noiseLfoAmt.gain.setTargetAtTime(0, t, TC);
      return;
    }
    // base gain sits at 1-v/2, LFO swings +/- v/2: depth 0 = steady wash,
    // depth 1 = full 0..1 pump of the post-reverb tail
    d.fx.noiseOut.gain.setTargetAtTime(1 - v / 2, t, TC);
    d.fx.noiseLfoAmt.gain.setTargetAtTime(v / 2, t, TC);
  }

  function updateNoiseTempo(d) { // LEVEL knob (0..1) -> tremolo rate
    if (!Engine.ctx) return;
    // BPM-synced but deliberately ignores d.division: the BEAT arrows steer
    // echo/dub/drum, the pump speed is the TEMPO knob's job alone
    var beat = 60 / d.bpm;
    // knob up = faster pump: 1/16x..16x the beat rate (period shrinks as v
    // rises), clamped to a 4s crawl .. ~33Hz buzz
    var mult = Math.pow(2, (0.5 - d.noiseTempo) * 8);
    var period = Math.max(0.03, Math.min(4, beat * mult));
    d.fx.noiseLfo.frequency.setTargetAtTime(1 / period, Engine.ctx.currentTime, 0.05);
  }

  Engine.setTimeKnob = function (v) {
    var d = Engine.decks[Engine.deck];
    d.timeKnob = v;
    if (!Engine.ctx) return;
    if (d.effect === 'drum') { // TIME pitches the kit +/- one octave (centre = 1x)
      d.drumRate = Math.pow(2, (v - 0.5) * 2);
      return;
    }
    if (d.effect === 'noise') { updateNoiseDepth(d); return; } // TIME -> tremolo depth
    updateEchoTime(d);                         // echo/dub: delay time scale
    updateReverbTime(d);                       // reverb: pre-delay swoop (5s plate fixed)
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
      // reverb: pad drives wet amount, same curve as LEVEL (no TIME gate)
      n.wet.gain.setTargetAtTime(Math.sin(x * Math.PI / 2), t, 0.01);
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
