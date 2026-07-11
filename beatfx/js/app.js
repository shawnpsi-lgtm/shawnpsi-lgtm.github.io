/* UI wiring + state. Talks to Engine (audio.js) and Knob (knob.js). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* iOS: create/resume AudioContext inside the first user gesture */
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
    document.addEventListener(ev, function () { Engine.ensure(); },
      { once: true, capture: true, passive: true });
  });

  /* --- file load --- */
  var fileInput = $('file-input'), fileName = $('file-name'), playBtn = $('play-btn');
  fileInput.addEventListener('change', function () {
    var f = fileInput.files[0];
    if (!f) return;
    fileName.textContent = 'DECODING…';
    playBtn.disabled = true;
    Engine.loadTrack(f).then(function (buf) {
      // rekordbox-style: analyze (BPM, beat grid, waveform) before playing
      fileName.textContent = 'ANALYZING…';
      bpmValue.textContent = '…';
      return Engine.analyze(buf).then(function (res) {
        detectedBpm = res.bpm; taps = [];
        autoTapBtn.classList.add('active'); // switch into AUTO
        setBpm(res.bpm);
        waveform = res.waveform;
        seekBar.classList.add('has-wave');
        fileName.textContent = f.name.toUpperCase();
        fileName.parentElement.classList.add('loaded');
        playBtn.disabled = false;
        setPlayUI(false);
      });
    }).catch(function () { fileName.textContent = 'COULD NOT DECODE FILE'; });
  });

  /* --- transport --- */
  function setPlayUI(playing) {
    playBtn.innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
    playBtn.classList.toggle('playing', playing);
  }
  playBtn.addEventListener('click', function () {
    if (Engine.playing) { Engine.pause(); setPlayUI(false); }
    else { Engine.play(); setPlayUI(true); }
  });
  Engine.onEnded = function () { setPlayUI(false); updateProgress(0); };

  /* --- seek bar + waveform (drag updates visual, release commits) --- */
  var seekBar = $('seek-bar'), seekFill = $('seek-fill'), seeking = false;
  var seekWave = $('seek-wave'), waveform = null;

  function drawWave(frac) { // two-tone: played part lit, rest dim
    var dpr = window.devicePixelRatio || 1;
    var w = Math.floor(seekBar.clientWidth * dpr);
    var h = Math.floor(seekBar.clientHeight * dpr);
    if (seekWave.width !== w || seekWave.height !== h) {
      seekWave.width = w; seekWave.height = h;
    }
    var g = seekWave.getContext('2d');
    g.clearRect(0, 0, w, h);
    var n = waveform.length, bw = w / n, mid = h / 2, split = frac * n;
    for (var i = 0; i < n; i++) {
      var bh = Math.max(dpr, waveform[i] * mid * 0.92);
      g.fillStyle = i < split ? '#4aa3ff' : 'rgba(255,255,255,0.28)';
      g.fillRect(i * bw + bw * 0.15, mid - bh, bw * 0.7, bh * 2);
    }
  }

  function updateProgress(frac) {
    seekFill.style.width = frac * 100 + '%';
    if (waveform) drawWave(frac);
  }

  function seekFrac(clientX) {
    var r = seekBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }
  function seekStart(x) { seeking = true; updateProgress(seekFrac(x)); }
  function seekMove(x) { if (seeking) updateProgress(seekFrac(x)); }
  function seekEnd(x) {
    if (!seeking) return;
    seeking = false;
    Engine.seek(seekFrac(x));
  }
  bindDrag(seekBar, seekStart, seekMove, seekEnd);

  (function tick() { // progress readout
    if (!seeking && Engine.buffer) {
      updateProgress(Engine.pos() / Engine.buffer.duration);
    }
    requestAnimationFrame(tick);
  })();

  /* --- BPM: tap tempo (average of last 4 intervals) --- */
  var bpmValue = $('bpm-value'), autoTapBtn = $('auto-tap'), taps = [], detectedBpm = 120;
  function setBpm(bpm) {
    bpm = Math.round(Math.max(40, Math.min(240, bpm)));
    bpmValue.textContent = bpm;
    Engine.setBpm(bpm);
  }
  $('tap-btn').addEventListener('click', function () {
    var now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 5) taps.shift(); // keep at most 4 intervals
    if (taps.length >= 2) {
      var sum = 0;
      for (var i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
      setBpm(60000 / (sum / (taps.length - 1)));
    }
    autoTapBtn.classList.remove('active'); // tapping implies TAP mode
  });
  autoTapBtn.addEventListener('click', function () {
    var auto = autoTapBtn.classList.toggle('active');
    if (auto) { taps = []; setBpm(detectedBpm); } // AUTO = detected tempo
  });
  $('quantize').addEventListener('click', function () {
    Engine.setQuantize(this.classList.toggle('q-on'));
  });

  /* --- BEAT division --- */
  var DIVS = [0.125, 0.25, 0.5, 0.75, 1, 2];
  var LABELS = ['1/8', '1/4', '1/2', '3/4', '1', '2'];
  var divIdx = 2;
  function setDiv(i) {
    divIdx = Math.max(0, Math.min(DIVS.length - 1, i));
    $('beat-value').textContent = LABELS[divIdx];
    Engine.setDivision(DIVS[divIdx]);
  }
  $('beat-down').addEventListener('click', function () { setDiv(divIdx - 1); });
  $('beat-up').addEventListener('click', function () { setDiv(divIdx + 1); });

  /* --- FX FREQUENCY band buttons (independent toggles, any combination;
         none active = full range) --- */
  var freqBtns = Array.prototype.slice.call(document.querySelectorAll('.freq-btn'));
  freqBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.classList.toggle('active');
      Engine.setBands(freqBtns.filter(function (b) {
        return b.classList.contains('active');
      }).map(function (b) { return b.dataset.band; }));
    });
  });

  /* --- knobs --- */
  var FX = ['reverb', 'echo', 'dub'];
  var fxLabels = Array.prototype.slice.call(document.querySelectorAll('.fx-labels span'));
  new Knob($('fx-knob'), {
    steps: 3, value: 0.5, range: 120,
    onInput: function (v) {
      var idx = Math.round(v * 2);
      fxLabels.forEach(function (s, i) { s.classList.toggle('lit', i === idx); });
      Engine.setEffect(FX[idx]);
    }
  });
  new Knob($('time-knob'), {
    value: 0.5, dblReset: 0.5, // double-tap snaps back to center (1x beat)
    onInput: function (v) { Engine.setTimeKnob(v); }
  });
  new Knob($('level-knob'), {
    value: 0.5,
    onInput: function (v) { Engine.setMix(v); }
  });

  /* --- skin toggle (persisted) --- */
  var rootEl = document.documentElement;
  $('skin-btn').addEventListener('click', function () {
    var on = rootEl.classList.toggle('skin-a9');
    try { localStorage.setItem('beatfx-skin', on ? 'a9' : 'flat'); } catch (e) {}
  });
  try {
    if (localStorage.getItem('beatfx-skin') === 'a9') rootEl.classList.add('skin-a9');
  } catch (e) {}

  /* --- ON/OFF --- */
  var onoff = $('onoff');
  onoff.addEventListener('click', function () {
    var on = onoff.classList.toggle('on');
    Engine.setOn(on);
  });

  /* --- X-PAD: segmented LED strip, direct param writes (no debounce) --- */
  var xpad = $('xpad'), SEGS = 24, segs = [];
  for (var i = 0; i < SEGS; i++) {
    var d = document.createElement('div');
    d.className = 'seg';
    xpad.appendChild(d);
    segs.push(d);
  }
  function padFrac(clientX) {
    var r = xpad.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }
  function padMove(clientX) {
    var x = padFrac(clientX);
    var lit = Math.floor(x * (SEGS - 1));
    for (var i = 0; i < SEGS; i++) segs[i].classList.toggle('lit', i <= lit);
    Engine.padMove(x); // direct AudioParam write in the handler
  }
  function padEnd() {
    segs.forEach(function (s) { s.classList.remove('lit'); });
    Engine.padEnd();
  }
  bindDrag(xpad, padMove, padMove, function () { padEnd(); });

  /* --- shared drag binding: pointer events, else touch + mouse --- */
  function bindDrag(el, onStart, onMove, onEnd) {
    var active = false;
    if (window.PointerEvent) {
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        active = true;
        onStart(e.clientX);
      });
      el.addEventListener('pointermove', function (e) { if (active) onMove(e.clientX); });
      ['pointerup', 'pointercancel'].forEach(function (ev) {
        el.addEventListener(ev, function (e) { if (active) { active = false; onEnd(e.clientX); } });
      });
    } else {
      el.addEventListener('touchstart', function (e) {
        e.preventDefault(); active = true; onStart(e.touches[0].clientX);
      }, { passive: false });
      el.addEventListener('touchmove', function (e) {
        e.preventDefault(); if (active) onMove(e.touches[0].clientX);
      }, { passive: false });
      el.addEventListener('touchend', function (e) {
        if (active) { active = false; onEnd(e.changedTouches[0].clientX); }
      });
      el.addEventListener('mousedown', function (e) { e.preventDefault(); active = true; onStart(e.clientX); });
      window.addEventListener('mousemove', function (e) { if (active) onMove(e.clientX); });
      window.addEventListener('mouseup', function (e) { if (active) { active = false; onEnd(e.clientX); } });
    }
  }
})();
