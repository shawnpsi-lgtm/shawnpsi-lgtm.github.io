// Site footer effects, shared by every page (styles in footer.css):
// - the giant "Shawn Singh" is added and fitted to the exact content width
// - the glow takes this page's colour (GLOW below)
// - the curve deepens and the glow brightens as the footer scrolls in (--pull),
//   and its contents hold still while the edge uncovers them (--lift)
// - the colour of the page just above is carried on under the curved corners
// - link labels are split into letters for the hover roll
// Works on footers rendered later by React (work.html) too.
(() => {
  // Each page's glow, matched to what's on it. Anything not listed gets the site blue.
  const GLOW = {
    status: '#2fbf71',                        // "All systems operational"
    'press-r2music': '#b05cff',               // r2 + rx3 hero glow
    'project-r2': '#8f5cff',                  // r2 violet
    'project-rx3': '#ff3dbb',                 // rx3 hot pink
    'project-cloudexa': '#3ecf8e',            // dashboard greens
    'project-djai': '#3d6bff',                // the app's blue pads
    'project-emmy': '#c9a227',                // gold
    'project-ngc2': '#e0b52a',                // gold wave
    'project-visuallyrepresented': '#d8d8d8', // black-and-white photography
  };
  const page = location.pathname.replace(/\/+$/, '').split('/').pop().replace(/\.html$/, '') || 'index';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isColor = c => c && c !== 'transparent' && !/rgba?\([^)]*,\s*0\)$/.test(c) && !/\/\s*0\)$/.test(c);

  const setup = foot => {
    if (foot.dataset.fx) return;
    foot.dataset.fx = '1';
    if (GLOW[page]) foot.style.setProperty('--glow', GLOW[page]);
    const box = foot.querySelector('.container') || foot;

    // Giant name (skipped if the page already has one).
    let mark = foot.querySelector('.footer__mark');
    if (!mark) {
      mark = document.createElement('div');
      mark.className = 'footer__mark'; mark.setAttribute('aria-hidden', 'true');
      mark.innerHTML = '<span>Shawn Singh</span>';
      box.append(mark);
    }
    const word = mark.firstElementChild;
    const fit = () => {
      word.style.fontSize = '';
      const w = word.getBoundingClientRect().width;
      if (!w || !mark.clientWidth) return;
      word.style.fontSize = (parseFloat(getComputedStyle(word).fontSize) * mark.clientWidth / w).toFixed(2) + 'px';
    };

    // Letter roll on hover. Not on footers React owns: rewriting its text nodes
    // would trip up its next render. The grow-in underline still works there.
    if (!foot.closest('#root')) {
      foot.querySelectorAll('.footer__link, .footer__careers').forEach(a => {
        const t = [...a.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
        if (!t) return;
        const label = t.textContent.trim(), sr = document.createElement('span'), roll = document.createElement('span');
        sr.className = 'sr-text'; sr.textContent = label;
        roll.className = 'roll'; roll.setAttribute('aria-hidden', 'true');
        [...label].forEach((c, i) => {
          const s = document.createElement('span');
          s.textContent = c; s.dataset.c = c; s.style.setProperty('--i', i);
          roll.append(s);
        });
        t.replaceWith(sr, roll);
      });
    }

    // The colour of whatever sits just above the footer, for under the corners.
    const paper = () => {
      let el = foot.previousElementSibling;
      while (el && (!el.offsetHeight || /^(SCRIPT|LINK|STYLE)$/.test(el.tagName))) el = el.previousElementSibling;
      for (let e = el; e; e = e.parentElement) {
        const c = getComputedStyle(e).backgroundColor;
        if (isColor(c)) return foot.style.setProperty('--paper-auto', c);
      }
      for (const e of [foot.parentElement, document.body, document.documentElement]) {
        const c = e && getComputedStyle(e).backgroundColor;
        if (isColor(c)) return foot.style.setProperty('--paper-auto', c);
      }
    };

    let raf = 0;
    const pull = () => {
      raf = 0;
      const r = foot.getBoundingClientRect();
      const p = calm ? 1 : Math.min(1, Math.max(0, (innerHeight - r.top) / r.height));
      foot.style.setProperty('--pull', p.toFixed(3));
      foot.style.setProperty('--lift', ((1 - p) * r.height).toFixed(1) + 'px');
    };
    fit(); paper(); pull();
    document.fonts?.ready.then(() => { fit(); pull(); });
    addEventListener('scroll', () => raf ||= requestAnimationFrame(pull), { passive: true });
    addEventListener('resize', () => { fit(); pull(); });
    // The theme toggle changes the page colour (with a .3s fade): re-read it after.
    new MutationObserver(() => setTimeout(paper, 350))
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  };

  const find = () => document.querySelectorAll('footer.footer').forEach(setup);
  find();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', find);
  // React pages render their footer later.
  const mo = new MutationObserver(find);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('load', () => { find(); setTimeout(() => mo.disconnect(), 4000); });
})();
