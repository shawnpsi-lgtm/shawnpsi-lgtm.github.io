// <rx-select>: the effect pickers, a drop-down in the RX3 screen's style in place of the browser's own <select>.
// It keeps the bits of the <select> API the page uses: `value` (get/set), a 'change' event (so `onchange` works),
// plus setOptions([name | { value, label }]). The menu opens on a click or Enter/Space/Alt+Down, drawn over
// everything (it lives on <body>, so the bars' overflow can't clip it) and flipped above the box when there is more
// room there. Arrows, Home/End and a letter move through it; Enter/Space pick, Escape/Tab or a tap outside close.

let open = null; // the one menu that is open

class RxSelect extends HTMLElement {
  constructor() {
    super();
    this.items = [];
    this.cur = -1; // the chosen item
    this.hi = -1; // the highlighted item while open
    this.list = null;
  }

  connectedCallback() {
    if (this.btn) return;
    const id = 'rxs-' + Math.random().toString(36).slice(2, 8);
    this.btn = Object.assign(document.createElement('button'), { type: 'button', className: 'rxs-btn' });
    this.btn.setAttribute('aria-haspopup', 'listbox');
    this.btn.setAttribute('aria-expanded', 'false');
    this.btn.setAttribute('aria-controls', id);
    if (this.hasAttribute('aria-label')) this.btn.setAttribute('aria-label', this.getAttribute('aria-label'));
    this.btn.innerHTML = '<span class="rxs-label"></span><i class="tri d"></i>';
    this.append(this.btn);
    this.list = document.createElement('ul');
    this.list.id = id;
    this.list.className = 'rxs-list' + (this.classList.contains('ph-select') ? ' big' : '');
    this.list.setAttribute('role', 'listbox');
    this.list.hidden = true;
    document.body.append(this.list);

    this.btn.addEventListener('click', () => (this.isOpen ? this.close() : this.show()));
    this.btn.addEventListener('keydown', (ev) => this.onKey(ev));
    this.btn.addEventListener('keyup', (ev) => {
      if (this.isOpen || ['Enter', ' ', 'Escape'].includes(ev.key)) ev.stopPropagation();
    });
    this.btn.addEventListener('blur', () => setTimeout(() => {
      if (this.isOpen && !this.list.contains(document.activeElement)) this.close();
    }));
    this.list.addEventListener('pointerdown', (ev) => ev.preventDefault()); // keep focus on the box
    this.list.addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (!li) return;
      this.pick(+li.dataset.i);
      this.close();
    });
    this.list.addEventListener('pointermove', (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (li && ev.pointerType === 'mouse') this.highlight(+li.dataset.i, false);
    });
    this.render();
  }

  disconnectedCallback() {
    this.close();
  }

  /** [name | { value, label }] */
  setOptions(items) {
    const was = this.value;
    this.items = items.map((it) => (typeof it === 'string' ? { value: it, label: it } : it));
    this.cur = Math.max(0, this.items.findIndex((it) => it.value === was));
    if (!this.items.length) this.cur = -1;
    this.render();
  }

  get value() {
    return this.items[this.cur]?.value ?? '';
  }

  set value(v) {
    const i = this.items.findIndex((it) => it.value === v);
    if (i < 0 || i === this.cur) return;
    this.cur = i;
    this.render();
  }

  get isOpen() {
    return open === this;
  }

  // ---- open / close

  show() {
    if (!this.items.length) return;
    open?.close();
    open = this;
    this.renderList();
    this.list.hidden = false;
    this.btn.setAttribute('aria-expanded', 'true');
    this.classList.add('open');
    this.place();
    this.highlight(this.cur);
    this.btn.focus({ preventScroll: true }); // a click doesn't focus a button on macOS; the keys need it
    addEventListener('pointerdown', this.outside, true);
    addEventListener('resize', this.dismiss);
    addEventListener('scroll', this.dismiss, true);
  }

  close() {
    if (!this.isOpen) return;
    open = null;
    this.list.hidden = true;
    this.btn.setAttribute('aria-expanded', 'false');
    this.btn.removeAttribute('aria-activedescendant');
    this.classList.remove('open');
    removeEventListener('pointerdown', this.outside, true);
    removeEventListener('resize', this.dismiss);
    removeEventListener('scroll', this.dismiss, true);
  }

  outside = (ev) => {
    if (!this.contains(ev.target) && !this.list.contains(ev.target)) this.close();
  };

  dismiss = (ev) => {
    if (ev.type !== 'scroll' || !this.list.contains(ev.target)) this.close();
  };

  /** Under the box, or over it if there is more room above; never off the screen. */
  place() {
    const r = this.getBoundingClientRect(), s = this.list.style, vh = innerHeight, gap = 8;
    s.minWidth = r.width + 'px';
    s.maxHeight = '';
    s.top = s.bottom = '';
    const h = this.list.scrollHeight, below = vh - r.bottom - gap, above = r.top - gap;
    if (h <= below || below >= above) {
      s.top = r.bottom + 'px';
      s.maxHeight = below + 'px';
    } else {
      s.bottom = vh - r.top + 'px';
      s.maxHeight = above + 'px';
    }
    s.left = Math.max(gap, Math.min(r.left, innerWidth - this.list.offsetWidth - gap)) + 'px';
    this.list.classList.toggle('up', !!s.bottom);
  }

  // ---- choosing

  pick(i) {
    if (i < 0 || i === this.cur) return;
    this.cur = i;
    this.render();
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }

  highlight(i, scroll = true) {
    this.hi = i;
    [...this.list.children].forEach((li, j) => li.classList.toggle('hi', j === i));
    const li = this.list.children[i];
    if (!li) return;
    this.btn.setAttribute('aria-activedescendant', li.id);
    if (scroll) li.scrollIntoView({ block: 'nearest' });
  }

  onKey(ev) {
    const k = ev.key, n = this.items.length;
    if (!this.isOpen) {
      // closed, the arrows stay the page's (browse up/down); these open it
      if (k === 'Enter' || k === ' ' || (ev.altKey && k === 'ArrowDown')) {
        ev.preventDefault();
        ev.stopPropagation();
        this.show();
      }
      return;
    }
    ev.stopPropagation(); // open, every key is the menu's
    if (k === 'Tab') return this.close();
    ev.preventDefault();
    if (k === 'Escape') this.close();
    else if (k === 'Enter' || k === ' ') {
      this.pick(this.hi);
      this.close();
    } else if (k === 'ArrowDown') this.highlight(Math.min(n - 1, this.hi + 1));
    else if (k === 'ArrowUp') this.highlight(Math.max(0, this.hi - 1));
    else if (k === 'Home' || k === 'PageUp') this.highlight(0);
    else if (k === 'End' || k === 'PageDown') this.highlight(n - 1);
    else if (k.length === 1) {
      // the next item starting with that letter
      const c = k.toLowerCase();
      for (let j = 1; j <= n; j++) {
        const at = (this.hi + j) % n;
        if (this.items[at].label.toLowerCase().startsWith(c)) return this.highlight(at);
      }
    }
  }

  // ---- state -> DOM

  render() {
    if (!this.btn) return;
    this.btn.querySelector('.rxs-label').textContent = this.items[this.cur]?.label ?? '';
    if (this.isOpen) {
      this.renderList();
      this.highlight(this.hi, false);
    }
  }

  renderList() {
    const id = this.list.id;
    this.list.innerHTML = this.items.map((it, i) =>
      `<li id="${id}-${i}" data-i="${i}" role="option" aria-selected="${i === this.cur}"` +
      `${i === this.cur ? ' class="sel"' : ''}>${it.label}</li>`).join('');
  }
}

customElements.define('rx-select', RxSelect);
