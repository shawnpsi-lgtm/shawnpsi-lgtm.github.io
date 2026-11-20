/* Work page: regroups the Selected Work cards into three glass panes (styles in
   work-sections.css). React paints the grid and work-cards.js adds rx3 and r2 to it;
   once every card is there, they're moved — not copied, so the dot cloud, waveform,
   videos and badges keep running — into section panes inside the same .grid, which
   keeps work-cards.js's ".grid .card-wrap…" selectors matching.

   React's list of cards is static, so moving them doesn't upset its reconciling.

   Back to the old grid: add ?layout=classic to the URL. */
(() => {
  if (new URLSearchParams(location.search).get('layout') === 'classic') return;

  const SECTIONS = [
    { name: 'Products', color: '#ec4899', cards: [
      '.card-wrap--rx3', '.card-wrap--r2', '[href="/beatfx/"]', '[href="/sayclip/"]', '[href="project-djai.html"]' ] },
    { name: 'Enterprise & defense', color: '#3b82f6', pair: true, cards: [
      '[href="project-ngc2.html"]', '[href="project-cloudexa.html"]' ] },
    { name: 'Brand & film', color: '#a855f7', cards: [
      ':has([src$="igstory.mp4"])', ':has([src$="trailer.mp4"])', '[href="project-emmy.html"]',
      '.card-wrap--tv', '[href="project-visuallyrepresented.html"]' ] },
  ];

  let done = false;
  const build = () => {
    if (done) return true;
    const grid = document.querySelector('#work .grid');
    if (!grid) return false;
    const groups = SECTIONS.map(s => s.cards.map(sel => grid.querySelector(':scope > .card-wrap' + sel)));
    if (groups.some(g => g.some(c => !c))) return false;   // not all painted yet
    done = true;

    const head = document.createElement('div');
    head.className = 'ws-head';
    head.setAttribute('aria-hidden', 'true');
    grid.prepend(head);

    SECTIONS.forEach((s, i) => {
      const cards = groups[i];
      const pane = document.createElement('section');
      pane.className = 'ws-pane';
      pane.style.setProperty('--c', s.color);
      pane.style.zIndex = SECTIONS.length - i;
      pane.setAttribute('aria-label', s.name);
      const row = document.createElement('div');
      row.className = 'ws-head-row';
      const h = document.createElement('h2');
      h.textContent = s.name;
      const n = document.createElement('span');
      n.textContent = cards.length;
      row.append(h, n, document.createElement('hr'));
      const wrap = document.createElement('div');
      wrap.className = 'ws-grid';
      const full = cards.length - cards.length % 3;
      cards.forEach((c, k) => {
        if (s.pair) c.classList.add('ws-pair');
        else if (k >= full) c.classList.add('ws-half');
        if (!s.pair && cards.length % 2 && k === cards.length - 1) c.classList.add('ws-solo');
        wrap.append(c);
      });
      pane.append(row, wrap);
      grid.append(pane);
    });
    grid.classList.add('ws-on');

    // The header pane reaches from the top of the page down to the grid.
    const place = () => grid.style.setProperty('--ws-top', grid.getBoundingClientRect().top + scrollY + 'px');
    place();
    new ResizeObserver(place).observe(document.body);
    return true;
  };

  addEventListener('DOMContentLoaded', () => {
    if (build()) return;
    const mo = new MutationObserver(() => { if (build()) mo.disconnect(); });
    mo.observe(document.getElementById('root'), { childList: true, subtree: true });
  });
})();
