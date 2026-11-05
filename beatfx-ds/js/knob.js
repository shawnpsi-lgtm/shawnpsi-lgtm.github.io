/* Reusable rotary knob. Vertical drag (up = increase) -> rotation over a
   -135..+135 degree arc. Pointer events with touch/mouse fallback.
   Emits a normalized 0..1 value. Optional detents via opts.steps. */
(function () {
  'use strict';
  var ARC = 270; // degrees of travel

  function Knob(el, opts) {
    opts = opts || {};
    this.el = el;
    this.steps = opts.steps || 0;          // 0 = continuous
    this.onInput = opts.onInput || function () {};
    this.range = opts.range || 180;        // drag pixels for full sweep
    this.dblReset = opts.dblReset;         // double-tap resets to this (null = off)
    this.value = -1;
    this._drag = null;
    this._lastTap = 0;
    this._bind();
    this.set(opts.value != null ? opts.value : 0.5, true);
  }

  Knob.prototype.set = function (v, silent) {
    v = Math.min(1, Math.max(0, v));
    if (this.steps > 1) v = Math.round(v * (this.steps - 1)) / (this.steps - 1);
    var changed = v !== this.value;
    this.value = v;
    // expose the angle as a CSS var on the knob element; the indicator and
    // any skin body layers (e.g. the RMX gear) rotate with it in CSS
    var deg = -ARC / 2 + v * ARC;
    this.el.style.setProperty('--knob-rot', deg + 'deg');
    if (changed && !silent) this.onInput(v);
  };

  Knob.prototype._start = function (y) {
    var now = Date.now(); // double-tap (works for touch too, unlike dblclick)
    if (this.dblReset != null && now - this._lastTap < 300) {
      this.set(this.dblReset);
      now = 0; // a third tap shouldn't re-trigger
    }
    this._lastTap = now;
    this._drag = { y: y, v: this.value };
  };
  Knob.prototype._move = function (y) {
    if (this._drag) this.set(this._drag.v + (this._drag.y - y) / this.range);
  };
  Knob.prototype._end = function () { this._drag = null; };

  Knob.prototype._bind = function () {
    var self = this, el = this.el;
    if (window.PointerEvent) {
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        self._start(e.clientY);
      });
      el.addEventListener('pointermove', function (e) { self._move(e.clientY); });
      el.addEventListener('pointerup', function () { self._end(); });
      el.addEventListener('pointercancel', function () { self._end(); });
    } else {
      el.addEventListener('touchstart', function (e) {
        e.preventDefault();
        self._start(e.touches[0].clientY);
      }, { passive: false });
      el.addEventListener('touchmove', function (e) {
        e.preventDefault();
        self._move(e.touches[0].clientY);
      }, { passive: false });
      el.addEventListener('touchend', function () { self._end(); });
      el.addEventListener('mousedown', function (e) { e.preventDefault(); self._start(e.clientY); });
      window.addEventListener('mousemove', function (e) { self._move(e.clientY); });
      window.addEventListener('mouseup', function () { self._end(); });
    }
  };

  window.Knob = Knob;
})();
