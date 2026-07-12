/* UI wiring + state. Talks to Engine (audio.js) and Knob (knob.js). */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* iOS: create/resume AudioContext inside the first user gesture */
  ['pointerdown', 'touchstart', 'mousedown'].forEach(function (ev) {
    document.addEventListener(ev, function () { Engine.ensure(); },
      { once: true, capture: true, passive: true });
  });

  /* --- lock zoom: the panel is a fixed 100dvh layout, so any zoom breaks it.
     The viewport's user-scalable=no covers Android; iOS Safari ignores it, so
     block the pinch gesture + double-tap + desktop ctrl/trackpad zoom here. --- */
  ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); });
  });
  document.addEventListener('touchmove', function (e) {
    if (e.touches.length > 1) e.preventDefault(); // multi-finger pinch
  }, { passive: false });
  document.addEventListener('wheel', function (e) {
    if (e.ctrlKey) e.preventDefault(); // desktop trackpad pinch / ctrl+scroll
  }, { passive: false });
  document.addEventListener('dblclick', function (e) { e.preventDefault(); });

  /* --- file load --- */
  var fileInput = $('file-input'), fileName = $('file-name'), playBtn = $('play-btn');
  fileInput.addEventListener('change', function () {
    var f = fileInput.files[0];
    if (!f) return;
    var loadDeck = curDeck; // a deck switch mid-analysis must not misfile UI
    fileName.textContent = 'DECODING…';
    playBtn.disabled = true;
    Engine.loadTrack(f).then(function (buf) {
      // rekordbox-style: analyze (BPM, beat grid, waveform) before playing
      if (curDeck === loadDeck) {
        fileName.textContent = 'ANALYZING…';
        bpmValue.textContent = '…';
      }
      return Engine.analyze(buf).then(function (res) {
        var name = f.name.toUpperCase();
        if (curDeck !== loadDeck) { // finished behind the scenes: stash it
          deckUI[loadDeck] = { name: name, loaded: true, waveform: res.waveform,
            detectedBpm: res.bpm, auto: true };
          refreshSync(); // the other deck now has a track: sync may be available
          return;
        }
        detectedBpm = res.bpm; taps = [];
        autoTapBtn.classList.add('active'); // switch into AUTO
        setBpm(res.bpm);
        waveform = res.waveform;
        seekBar.classList.add('has-wave');
        fileName.textContent = name;
        fileName.parentElement.classList.add('loaded');
        playBtn.disabled = false;
        setPlayUI(false);
        refreshSync();
        refreshTransport();
      });
    }).catch(function () {
      if (curDeck === loadDeck) fileName.textContent = 'COULD NOT DECODE FILE';
    });
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
  Engine.onEnded = function (deckIndex) {
    if (deckIndex !== curDeck) return; // a background deck ended silently
    setPlayUI(false); updateProgress(0);
  };

  /* --- CUE / HOT CUE / NUDGE (bottom transport) --- */
  var cueBtn = $('cue-btn'), hotBtns = [$('hotcue-a'), $('hotcue-b')];
  var nudgeBack = $('nudge-back'), nudgeFwd = $('nudge-fwd');
  function refreshTransport() { // enable + reflect the focused deck's cue state
    var has = !!Engine.buffer;
    cueBtn.disabled = nudgeBack.disabled = nudgeFwd.disabled = !has;
    hotBtns.forEach(function (b, i) {
      b.disabled = !has;
      b.classList.toggle('set', has && Engine.hotCueSet(i));
    });
  }
  function syncTransportUI() { // after a cue/hotcue jump: refresh play + progress
    setPlayUI(Engine.playing);
    if (Engine.buffer) updateProgress(Engine.pos() / Engine.buffer.duration);
  }
  // generic press-and-hold binding (paired down/up even if extra events fire)
  function bindHold(btn, onDown, onUp) {
    var held = false;
    var down = function (e) { e.preventDefault(); if (held) return; held = true; onDown(); };
    var up = function () { if (!held) return; held = false; onUp(); };
    if (window.PointerEvent) {
      btn.addEventListener('pointerdown', down);
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { btn.addEventListener(ev, up); });
    } else {
      btn.addEventListener('touchstart', down, { passive: false });
      ['touchend', 'touchcancel'].forEach(function (ev) { btn.addEventListener(ev, up); });
      btn.addEventListener('mousedown', down);
      ['mouseup', 'mouseleave'].forEach(function (ev) { btn.addEventListener(ev, up); });
    }
  }

  // CUE: momentary preview — plays while held, snaps back and stops on release
  bindHold(cueBtn,
    function () { cueBtn.classList.add('hit'); Engine.cuePress(); syncTransportUI(); },
    function () { cueBtn.classList.remove('hit'); Engine.cueRelease(); syncTransportUI(); });

  // HOT CUE: tap sets/recalls; long-press (500ms) clears the cue
  hotBtns.forEach(function (b, i) {
    var timer = null, longPressed = false, held = false;
    var down = function (e) {
      e.preventDefault(); if (held) return; held = true; longPressed = false;
      timer = setTimeout(function () {
        longPressed = true; Engine.clearHotCue(i); b.classList.remove('set');
      }, 500);
    };
    var up = function () {
      if (!held) return; held = false;
      if (timer) { clearTimeout(timer); timer = null; }
      if (longPressed) return; // already cleared by the long-press
      if (Engine.hotCue(i) === 'set') b.classList.add('set');
      syncTransportUI();
    };
    if (window.PointerEvent) {
      b.addEventListener('pointerdown', down);
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) { b.addEventListener(ev, up); });
    } else {
      b.addEventListener('touchstart', down, { passive: false });
      ['touchend', 'touchcancel'].forEach(function (ev) { b.addEventListener(ev, up); });
      b.addEventListener('mousedown', down);
      ['mouseup', 'mouseleave'].forEach(function (ev) { b.addEventListener(ev, up); });
    }
  });

  // NUDGE: press-and-hold to bend the phase
  bindHold(nudgeBack, function () { Engine.nudgeStart(-1); }, function () { Engine.nudgeEnd(); });
  bindHold(nudgeFwd, function () { Engine.nudgeStart(1); }, function () { Engine.nudgeEnd(); });

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
  function releaseSyncForManualTempo() { // touching the tempo drops sync (CDJ-like)
    if (Engine.isSynced()) {
      Engine.sync(); // toggle off -> restore base buffer + native bpm
      refreshSync();
      setPlayUI(Engine.playing);
    }
  }
  $('tap-btn').addEventListener('click', function () {
    releaseSyncForManualTempo();
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
    releaseSyncForManualTempo();
    var auto = autoTapBtn.classList.toggle('active');
    if (auto) { taps = []; setBpm(detectedBpm); } // AUTO = detected tempo
  });
  $('quantize').addEventListener('click', function () {
    Engine.setQuantize(this.classList.toggle('q-on'));
  });

  /* --- SYNC: keylock beat-match the focused deck to the other deck --- */
  var syncBtn = $('sync-btn');
  function refreshSync() { // enabled only when both decks hold a track
    var d = Engine.decks;
    syncBtn.disabled = !(d[0].baseBuffer && d[1].baseBuffer);
    syncBtn.classList.toggle('synced', Engine.isSynced());
  }
  syncBtn.addEventListener('click', function () {
    if (syncBtn.disabled) return;
    syncBtn.classList.add('pending'); // paint the pending state before the
    setTimeout(function () {           // stretch (synchronous) blocks the thread
      Engine.sync();
      syncBtn.classList.remove('pending');
      bpmValue.textContent = Engine.bpm;
      autoTapBtn.classList.remove('active'); // synced tempo isn't the detected one
      refreshSync();
      setPlayUI(Engine.playing);
    }, 0);
  });

  /* --- DECK 1/2: two exact-copy decks, each with its own track AND FX;
         the panel shows the focused one, both keep playing + effecting --- */
  var curDeck = 0;
  var deckUI = [null, // slot 0 lives in the visible controls until stashed
    { name: 'LOAD TRACK…', loaded: false, waveform: null, detectedBpm: 120, auto: true }];
  // FX controls are per-deck too: stash the panel state on switch and restore
  // the other deck's, so each deck keeps its own effect / knobs / bands / X-PAD
  var deckFxUI = [null, defaultFxUI()];
  $('deck-btn').addEventListener('click', function () {
    deckUI[curDeck] = { // stash the visible deck's UI state
      name: fileName.textContent,
      loaded: fileName.parentElement.classList.contains('loaded'),
      waveform: waveform,
      detectedBpm: detectedBpm,
      auto: autoTapBtn.classList.contains('active')
    };
    deckFxUI[curDeck] = grabFxUI();
    curDeck = 1 - curDeck;
    Engine.setDeck(curDeck);
    applyFxUI(deckFxUI[curDeck]); // the engine chain already holds this state
    var u = deckUI[curDeck];
    this.textContent = 'DECK ' + (curDeck + 1);
    fileName.textContent = u.name;
    fileName.parentElement.classList.toggle('loaded', u.loaded);
    waveform = u.waveform;
    detectedBpm = u.detectedBpm;
    taps = [];
    autoTapBtn.classList.toggle('active', u.auto);
    seekBar.classList.toggle('has-wave', !!waveform);
    if (!waveform) { // wipe the other deck's waveform off the canvas
      seekWave.getContext('2d').clearRect(0, 0, seekWave.width, seekWave.height);
    }
    bpmValue.textContent = Engine.bpm;
    playBtn.disabled = !Engine.buffer;
    setPlayUI(Engine.playing);
    updateProgress(Engine.buffer ? Engine.pos() / Engine.buffer.duration : 0);
    refreshSync(); // lit/disabled state follows the focused deck
    refreshTransport(); // cue/hotcue/nudge enable + hot-cue LEDs per deck
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
  function litEffect(v) { // reflect the fx-knob position in the REVERB/ECHO/DUB row
    var idx = Math.round(v * 2);
    fxLabels.forEach(function (s, i) { s.classList.toggle('lit', i === idx); });
  }
  var fxKnob = new Knob($('fx-knob'), {
    steps: 3, value: 0.5, range: 120,
    onInput: function (v) { litEffect(v); Engine.setEffect(FX[Math.round(v * 2)]); }
  });
  var timeKnob = new Knob($('time-knob'), {
    value: 0.5, dblReset: 0.5, // double-tap snaps back to center (1x beat)
    onInput: function (v) { Engine.setTimeKnob(v); }
  });
  var levelKnob = new Knob($('level-knob'), {
    value: 0.5,
    onInput: function (v) { Engine.setMix(v); }
  });

  /* --- ON/OFF --- */
  var onoff = $('onoff');
  onoff.addEventListener('click', function () {
    var on = onoff.classList.toggle('on');
    Engine.setOn(on);
  });

  /* --- X-PAD mode dropdown (custom menu so the open list is skinnable) --- */
  var padBtn = $('xpad-mode'), padMenu = $('xpad-menu');
  var padItems = Array.prototype.slice.call(padMenu.querySelectorAll('.dd-item'));
  function openPadMenu(open) {
    padMenu.hidden = !open;
    padBtn.setAttribute('aria-expanded', open);
  }
  padBtn.addEventListener('click', function (e) {
    e.stopPropagation(); // keep the document close-listener from re-closing it
    openPadMenu(padMenu.hidden);
  });
  padItems.forEach(function (item) {
    item.addEventListener('click', function () {
      padItems.forEach(function (b) {
        var sel = b === item;
        b.classList.toggle('selected', sel);
        b.setAttribute('aria-selected', sel);
      });
      padBtn.textContent = 'X-PAD · ' + item.textContent;
      Engine.setPadMode(item.dataset.value);
      clearSegs(); // switching modes drops any parked-filter lights
      openPadMenu(false);
    });
  });
  document.addEventListener('click', function () { openPadMenu(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') openPadMenu(false);
  });
  function setPadUI(value) { // reflect a deck's X-PAD mode in the chip + list
    padItems.forEach(function (b) {
      var sel = b.dataset.value === value;
      b.classList.toggle('selected', sel);
      b.setAttribute('aria-selected', sel);
      if (sel) padBtn.textContent = 'X-PAD · ' + b.textContent;
    });
  }

  /* --- per-deck FX panel state (see the DECK toggle above) --- */
  function defaultFxUI() {
    return { fx: 0.5, time: 0.5, level: 0.5, divIdx: 2,
             bands: [], padValue: 'fx', on: false, q: false };
  }
  function grabFxUI() { // snapshot the visible panel for the deck we're leaving
    return {
      fx: fxKnob.value, time: timeKnob.value, level: levelKnob.value,
      divIdx: divIdx,
      bands: freqBtns.filter(function (b) { return b.classList.contains('active'); })
                     .map(function (b) { return b.dataset.band; }),
      padValue: padMenu.querySelector('.dd-item.selected').dataset.value,
      on: onoff.classList.contains('on'),
      q: $('quantize').classList.contains('q-on')
    };
  }
  function applyFxUI(u) { // restore panel to a deck's state (display only —
    fxKnob.set(u.fx, true); litEffect(u.fx);   // the engine chain already holds it)
    timeKnob.set(u.time, true);
    levelKnob.set(u.level, true);
    divIdx = u.divIdx; $('beat-value').textContent = LABELS[divIdx];
    freqBtns.forEach(function (b) {
      b.classList.toggle('active', u.bands.indexOf(b.dataset.band) !== -1);
    });
    setPadUI(u.padValue);
    redrawPadHold(); // show this deck's parked filter (or clear the strip)
    onoff.classList.toggle('on', u.on);
    $('quantize').classList.toggle('q-on', u.q);
  }

  var xpad = $('xpad'), SEGS = 24, segs = [];
  for (var i = 0; i < SEGS; i++) {
    var seg = document.createElement('div');
    seg.className = 'seg';
    xpad.appendChild(seg);
    segs.push(seg);
  }
  function padFrac(clientX) {
    var r = xpad.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  }
  function isFilterMode() { return Engine.decks[curDeck].padMode === 'filter'; }
  function drawSegs(x) { // FILTER lights centre-out (shows deviation); else left-fill
    if (isFilterMode()) {
      var c = (SEGS - 1) / 2, pos = x * (SEGS - 1);
      var lo = Math.min(c, pos), hi = Math.max(c, pos);
      for (var i = 0; i < SEGS; i++) segs[i].classList.toggle('lit', i + 0.5 >= lo && i - 0.5 <= hi);
    } else {
      var lit = Math.floor(x * (SEGS - 1));
      for (var j = 0; j < SEGS; j++) segs[j].classList.toggle('lit', j <= lit);
    }
  }
  function clearSegs() { segs.forEach(function (s) { s.classList.remove('lit'); }); }
  function redrawPadHold() { // reflect the focused deck's parked filter (or clear)
    var fh = Engine.decks[curDeck].filterHold;
    if (isFilterMode() && fh != null) drawSegs(fh); else clearSegs();
  }

  var padLastTap = 0, padHold = false, padLastX = 0.5;
  function padStart(clientX) {
    var now = Date.now();
    padHold = isFilterMode() && (now - padLastTap < 300); // double-tap => latch
    padLastTap = now;
    padMove(clientX);
  }
  function padMove(clientX) {
    padLastX = padFrac(clientX);
    drawSegs(padLastX);
    Engine.padMove(padLastX); // direct AudioParam write in the handler
  }
  function padEnd() {
    if (isFilterMode()) {
      if (padHold) { Engine.setFilterHold(padLastX); drawSegs(padLastX); } // park it
      else { Engine.releaseFilterHold(); clearSegs(); }                    // snap to centre
    } else {
      clearSegs();
    }
    Engine.padEnd();
    padHold = false;
  }
  bindDrag(xpad, padStart, padMove, function () { padEnd(); });

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
