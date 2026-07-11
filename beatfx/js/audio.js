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

  var Engine = {
    ctx: null, buffer: null, source: null, n: {},
    playing: false, startTime: 0, offset: 0,
    effect: 'echo', wired: null, on: false, mix: 0.5, bands: [], quantize: false,
    bpm: 120, division: 0.5, timeKnob: 0.5, gridOffset: 0,
    onEnded: function () {}
  };

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

  function buildGraph() {
    var c = Engine.ctx, n = Engine.n;
    n.input = c.createGain();
    // sources connect via srcGain; pause fades it (not master) so echo /
    // reverb tails keep ringing out through the still-open wet path
    n.srcGain = c.createGain();
    n.srcGain.connect(n.input);
    n.dry = c.createGain();
    n.wet = c.createGain(); n.wet.gain.value = 0;
    n.master = c.createGain();
    n.wetIn = c.createGain();

    n.input.connect(n.dry); n.dry.connect(n.master);
    // safety limiter: echo build-ups stack on the full dry signal, so
    // catch overs instead of hard-clipping at the destination
    n.limiter = c.createDynamicsCompressor();
    n.limiter.threshold.value = -3; n.limiter.knee.value = 6;
    n.limiter.ratio.value = 12;
    n.limiter.attack.value = 0.003; n.limiter.release.value = 0.25;
    n.wet.connect(n.master);
    n.master.connect(n.limiter); n.limiter.connect(c.destination);

    // FX FREQUENCY: three parallel band filters into the wet path, each
    // behind its own gain so any combination can be active. A plain gain
    // ("full") carries the unfiltered signal when no band is selected.
    n.full = c.createGain();
    n.input.connect(n.full); n.full.connect(n.wetIn);
    n.bandGain = {};
    [['low', 'lowpass', 250, null],
     ['mid', 'bandpass', 1200, 0.7],
     ['hi', 'highpass', 2500, null]].forEach(function (d) {
      var f = c.createBiquadFilter();
      f.type = d[1]; f.frequency.value = d[2];
      if (d[3] !== null) f.Q.value = d[3];
      var g = c.createGain(); g.gain.value = 0;
      n.input.connect(f); f.connect(g); g.connect(n.wetIn);
      n.bandGain[d[0]] = g;
    });

    // Reverb: pre-delay -> convolver -> low cut -> high shelf.
    // The EQ keeps the tail out of the mud and adds Pioneer-style
    // shimmer on top (synthesized wash IR, see makeWashIR).
    n.preDelay = c.createDelay(0.5);
    n.convolver = c.createConvolver();
    n.convolver.buffer = makeWashIR(c);
    n.revHp = c.createBiquadFilter();
    n.revHp.type = 'highpass'; n.revHp.frequency.value = 180;
    n.revShelf = c.createBiquadFilter();
    n.revShelf.type = 'highshelf';
    n.revShelf.frequency.value = 2800; n.revShelf.gain.value = 5;
    n.preDelay.connect(n.convolver);
    n.convolver.connect(n.revHp); n.revHp.connect(n.revShelf);

    // Echo: delay <-> feedback gain -> lowpass (repeats get darker)
    n.delay = c.createDelay(2);
    n.fb = c.createGain(); n.fb.gain.value = 0.45;
    n.fbFilter = c.createBiquadFilter();
    n.fbFilter.type = 'lowpass'; n.fbFilter.frequency.value = 3500;
    n.delay.connect(n.fb); n.fb.connect(n.fbFilter); n.fbFilter.connect(n.delay);

    // Dub echo: tape-style loop — every repeat is band-limited and
    // saturated again, so it gets darker, thinner, grittier each pass.
    // dubDelay -> highpass -> lowpass -> soft clip -> feedback -> dubDelay
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

    wire(Engine.effect);
    Engine.setBands(Engine.bands);
    Engine.setTimeKnob(Engine.timeKnob);
    applyMix();
  }

  function wire(fx) {
    var n = Engine.n;
    if (Engine.wired) {
      n.wetIn.disconnect(n[ENTRY[Engine.wired]]);
      n[EXIT[Engine.wired]].disconnect(n.wet);
    }
    n.wetIn.connect(n[ENTRY[fx]]);
    n[EXIT[fx]].connect(n.wet);
    Engine.wired = fx;
  }

  function echoFb() { // LEVEL/DEPTH sets how hard repeats regenerate
    return Math.min(0.9, Engine.mix * 0.9);
  }

  function dubFb() { // hotter than echo; the in-loop soft clip bounds it
    return Math.min(0.95, Engine.mix * 0.95);
  }

  function tanhCurve() { // tape-style soft clip (unity slope at zero, so
    var N = 1024;        // sub-unity feedback still decays)
    var curve = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      curve[i] = Math.tanh((i / (N - 1)) * 2 - 1);
    }
    return curve;
  }

  function applyMix(at) { // `at`: schedule the change in the future (quantize)
    var c = Engine.ctx, n = Engine.n, t = at || c.currentTime;
    var m = Engine.on ? Engine.mix : 0;
    if (Engine.effect === 'echo' || Engine.effect === 'dub') {
      // DJM-style echo / dub: dry stays at full and repeats stack on top.
      // LEVEL/DEPTH is the echo send *and* the feedback amount, and the
      // wet return stays open so the tail rings out after OFF / pause.
      n.dry.gain.setTargetAtTime(1, t, TC);
      n.wet.gain.setTargetAtTime(1, t, TC);
      n.wetIn.gain.setTargetAtTime(m, t, TC);
      n.fb.gain.setTargetAtTime(echoFb(), t, TC);
      n.dubFb.gain.setTargetAtTime(dubFb(), t, TC);
      return;
    }
    n.wetIn.gain.setTargetAtTime(1, t, TC);
    // Reverb depth is gated by the TIME knob: at min the crossfade stays
    // fully dry, so no reverb is heard regardless of LEVEL/DEPTH.
    if (Engine.effect === 'reverb') m *= Engine.timeKnob;
    n.dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, TC);
    n.wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, TC);
  }

  /* --- transport --- */
  Engine.loadTrack = function (file) {
    Engine.ensure();
    Engine.pause();
    return file.arrayBuffer().then(decode).then(function (buf) {
      Engine.buffer = buf;
      Engine.offset = 0;
      return buf;
    });
  };

  Engine.play = function () {
    if (!Engine.buffer || Engine.playing) return;
    var c = Engine.ensure();
    if (Engine.offset >= Engine.buffer.duration) Engine.offset = 0;
    var src = c.createBufferSource();
    src.buffer = Engine.buffer;
    src.connect(Engine.n.srcGain);
    src.onended = function () {
      if (Engine.source !== src) return; // manual stop already handled
      Engine.playing = false; Engine.source = null; Engine.offset = 0;
      Engine.onEnded();
    };
    src.start(0, Engine.offset);
    Engine.source = src;
    Engine.startTime = c.currentTime;
    Engine.playing = true;
    Engine.n.srcGain.gain.setTargetAtTime(1, c.currentTime, TC);
  };

  Engine.pause = function () {
    if (!Engine.playing) return;
    var c = Engine.ctx, src = Engine.source;
    Engine.offset = Math.min(Engine.offset + c.currentTime - Engine.startTime,
      Engine.buffer.duration);
    Engine.playing = false; Engine.source = null;
    // fade the source only; effect tails ring out through master
    Engine.n.srcGain.gain.setTargetAtTime(0, c.currentTime, TC);
    src.onended = null;
    src.stop(c.currentTime + 0.08);
  };

  Engine.seek = function (frac) {
    if (!Engine.buffer) return;
    var wasPlaying = Engine.playing;
    if (wasPlaying) Engine.pause();
    Engine.offset = Math.max(0, Math.min(1, frac)) * Engine.buffer.duration;
    if (wasPlaying) Engine.play();
  };

  Engine.pos = function () {
    if (!Engine.buffer) return 0;
    var p = Engine.playing
      ? Engine.offset + Engine.ctx.currentTime - Engine.startTime : Engine.offset;
    return Math.min(p, Engine.buffer.duration);
  };

  /* --- effect + parameter control --- */
  Engine.setEffect = function (fx) {
    if (fx === Engine.effect) return;
    Engine.effect = fx;
    if (!Engine.ctx) return;
    var n = Engine.n, c = Engine.ctx;
    n.wet.gain.setTargetAtTime(0, c.currentTime, TC); // fade wet out...
    clearTimeout(Engine._swap);
    Engine._swap = setTimeout(function () {          // ...rewire, fade back in
      wire(Engine.effect);
      Engine.setTimeKnob(Engine.timeKnob);
      applyMix();
    }, 120);
  };

  Engine.setOn = function (on) {
    Engine.on = on;
    if (!Engine.ctx) return;
    var at = Engine.ctx.currentTime;
    if (Engine.quantize && Engine.playing) {
      // snap the engage/release to the track's next beat boundary
      // (grid anchored at track start — we detect tempo, not downbeat)
      var beat = 60 / Engine.bpm;
      var phase = ((Engine.pos() - Engine.gridOffset) % beat + beat) % beat;
      if (phase > 0.07) at += beat - phase; // within 70ms after a beat = now
    }
    applyMix(at);
  };

  Engine.setQuantize = function (q) { Engine.quantize = q; };

  Engine.setMix = function (v) {
    Engine.mix = v;
    if (Engine.ctx) applyMix();
  };

  Engine.setBands = function (bands) { // array of 'low'/'mid'/'hi'; [] = full range
    Engine.bands = bands || [];
    if (!Engine.ctx) return;
    var n = Engine.n, t = Engine.ctx.currentTime;
    var any = Engine.bands.length > 0;
    n.full.gain.setTargetAtTime(any ? 0 : 1, t, TC);
    Object.keys(n.bandGain).forEach(function (b) {
      n.bandGain[b].gain.setTargetAtTime(Engine.bands.indexOf(b) !== -1 ? 1 : 0, t, TC);
    });
  };

  Engine.setBpm = function (bpm) { Engine.bpm = bpm; updateEchoTime(); };
  Engine.setDivision = function (d) { Engine.division = d; updateEchoTime(); };

  function updateEchoTime() {
    if (!Engine.ctx) return;
    var beat = (60 / Engine.bpm) * Engine.division;
    var mult = Math.pow(2, (Engine.timeKnob - 0.5) * 2); // knob scales 0.5x..2x
    var t = Math.max(0.02, Math.min(2, beat * mult));
    Engine.n.delay.delayTime.setTargetAtTime(t, Engine.ctx.currentTime, 0.05);
    Engine.n.dubDelay.delayTime // headroom for the LFO wobble below 2s max
      .setTargetAtTime(Math.min(t, 1.99), Engine.ctx.currentTime, 0.05);
  }

  Engine.setTimeKnob = function (v) {
    Engine.timeKnob = v;
    if (!Engine.ctx) return;
    updateEchoTime();                          // echo/dub: delay time scale
    Engine.n.preDelay.delayTime               //  reverb: pre-delay 0..0.25s
      // slow glide: sweeping TIME doppler-bends the reverb input, the
      // Pioneer-style pitch swoop (down when raising, up when lowering)
      .setTargetAtTime(v * 0.25, Engine.ctx.currentTime, 0.2);
    if (Engine.effect === 'reverb') applyMix(); // reverb depth follows TIME
  };

  /* --- X-PAD: direct AudioParam writes, no debounce --- */
  Engine.padMove = function (x) { // x = 0..1
    if (!Engine.ctx) return;
    var n = Engine.n, t = Engine.ctx.currentTime;
    if (Engine.effect === 'echo') {
      n.fb.gain.setTargetAtTime(Math.min(0.95, x * 0.95), t, 0.01); // hard clamp
    } else if (Engine.effect === 'dub') {
      // ride feedback past unity: the in-loop soft clip bounds the
      // self-oscillation (classic dub swell)
      n.dubFb.gain.setTargetAtTime(x * 1.05, t, 0.01);
    } else {
      // reverb: pad drives wet amount, still gated by TIME (silent at min)
      n.wet.gain.setTargetAtTime(Math.sin(x * Engine.timeKnob * Math.PI / 2), t, 0.01);
    }
  };

  Engine.padEnd = function () { // return to knob-set resting values
    if (!Engine.ctx) return;
    var n = Engine.n, t = Engine.ctx.currentTime;
    if (Engine.effect === 'echo') n.fb.gain.setTargetAtTime(echoFb(), t, TC);
    else if (Engine.effect === 'dub') n.dubFb.gain.setTargetAtTime(dubFb(), t, TC);
    else applyMix();
  };

  /* --- track analysis (rekordbox-style, runs on load) ----------------------
     BPM + beat-grid phase: render up to 60s through a low-pass (isolate the
     kick) offline, find amplitude peaks, tally the tempo implied by peak
     intervals, then take the circular mean of peak positions within a beat
     as the grid anchor. Waveform: peak amplitude per bucket. */
  Engine.analyze = function (buffer) {
    var waveform = makeWaveform(buffer, 240);
    return Engine.detectBpm(buffer).then(function (r) {
      Engine.gridOffset = r.offset;
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
