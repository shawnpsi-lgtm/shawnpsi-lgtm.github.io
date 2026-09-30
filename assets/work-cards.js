/* Card enhancers for the Selected Work grid (work.html). React paints the
   cards, these decorate them: the NGC2 dot cloud, the DJai field, the TV
   card's clip queue, the copy overlays and the Sayclip download badge.
   Needs dotcloud.js loaded first for fillNgc2. */
(() => {
    const fillEmpty = () => {
      const v = document.querySelector('.grid .card-wrap--tv .card--mock video');
      if (!v || v.dataset.queue) return;
      const clips = ['/videos/chicago.mp4', '/videos/go.mp4'];
      let i = Math.max(0, clips.findIndex(c => (v.currentSrc || v.src).includes(c)));
      v.dataset.queue = '1';
      v.loop = false;
      v.addEventListener('ended', () => { i = (i + 1) % clips.length; v.src = clips[i]; v.play(); });
    };
    const fillDjai = () => {
      const card = document.querySelector('.card-wrap[href="project-djai.html"] .card');
      if (!card || card.querySelector('.djai-field')) return;
      const canvas = document.createElement('canvas');
      canvas.className = 'djai-field';
      canvas.setAttribute('aria-hidden', 'true');
      card.prepend(canvas);
      const ctx = canvas.getContext('2d');
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
      const band = (p, k, seed) => {
        const beat = p + seed;
        const frac = beat - Math.floor(beat);
        const bar = beat | 0;
        const down = bar % 4 === 0 ? 1 : .55;
        const phrase = .28 + hash(bar + seed * 13) * .5 + hash((bar >> 3) + seed) * .3;
        const kick = Math.exp(-frac * 9) * down;
        const snare = bar % 2 === 1 ? Math.exp(-frac * 13) : 0;
        const hat = Math.exp(-((beat * 4) % 1) * 14) * (.25 + hash(bar * 3 + seed) * .4);
        const sub = .2 + hash(bar + seed * 7) * .35;
        const g = hash(bar * 11 + k * 9 + seed);
        if (k === 0) return Math.min(1, (sub + kick * .95) * phrase);
        if (k === 1) return Math.min(1, (.08 + snare * .85 + sub * .15 + g * .18) * phrase);
        return Math.min(1, (hat + kick * .08 + g * .42) * phrase);
      };
      const resize = () => {
        const r = card.getBoundingClientRect();
        const d = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, r.width * d);
        canvas.height = Math.max(1, r.height * d);
      };
      const draw = t => {
        const w = canvas.width, h = canvas.height, d = Math.min(devicePixelRatio || 1, 2);
        ctx.clearRect(0, 0, w, h);
        const mid = h * (w / d < 520 ? .32 : .38);
        const maxH = h * .34;
        const scroll = reduce ? 0 : t * .00115;
        const n = Math.max(90, Math.floor(w / (2.1 * d)));
        const bw = w / n;
        const decks = [[0, -1], [4.3, 1]];
        for (const [seed, dir] of decks) {
          for (let k = 0; k < 3; k++) {
            const thick = k === 0 ? .76 : k === 1 ? .4 : .15;
            const alpha = k === 0 ? .28 : k === 1 ? .52 : .95;
            const scale = k === 0 ? 1 : k === 1 ? .7 : .44;
            ctx.globalAlpha = 1;
            ctx.fillStyle = 'rgba(255,255,255,' + alpha + ')';
            for (let i = 0; i < n; i++) {
              const a = band(i / n * 16 + scroll, k, seed) * scale;
              const bh = Math.max(d, a * maxH);
              ctx.fillRect(i * bw + bw * (1 - thick) / 2, mid, bw * thick, dir * bh);
            }
          }
        }
        ctx.globalAlpha = .28;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, mid, w, d * .55);
        const gx = w * .5, gw = 24 * d;
        const g = ctx.createLinearGradient(gx - gw, 0, gx + gw, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(.5, 'rgba(255,255,255,.14)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.fillRect(gx - gw, mid - maxH * 1.35, gw * 2, maxH * 2.7);
      };
      resize();
      new ResizeObserver(resize).observe(card);
      if (reduce) { draw(0); return; }
      const loop = t => { draw(t); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    };
    const fillNgc2 = () => {
      const card = document.querySelector('.card-wrap--lines .card');
      if (!card) return;
      if (card.querySelector('.ngc2-field')) return;
      const field = document.createElement('div');
      field.className = 'ngc2-field';
      field.setAttribute('aria-hidden', 'true');
      card.prepend(field);
      const copy = document.createElement('div');
      copy.className = 'ngc2-copy';
      copy.innerHTML = '<span>U.S. ARMY NGC2</span><b>Next-Gen Command & Control</b>';
      card.append(copy);
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      try {
        DotCloud.mount(field, {
          cols: 300, rows: 230, point: 2, dist: 4.8,
          speed: reduce ? 0 : .6, spin: .15, tilt: .14, wobble: .07,
          color: [.86, .88, .9], background: null,
          place: `vec4 place(vec2 uv,float i,float t){
            vec3 d=fib(i,uN);
            float th=acos(clamp(d.y,-1.0,1.0)), ph=atan(d.z,d.x);
            float y=sin(6.0*th)*0.5+sin(4.0*ph+t*0.5)*0.25*sin(3.0*th);
            return vec4(d*(1.5+y*0.24),0.22+abs(y)*0.95);
          }`
        });
      } catch {}
    };
    const wireNgc2Launch = () => {
      if (document.getElementById('ngc2-launch')) return;
      const launch = document.createElement('div');
      launch.id = 'ngc2-launch';
      launch.hidden = true;
      launch.setAttribute('aria-hidden', 'true');
      launch.innerHTML = '<img src="/images/ngc2-logo.svg" alt=""><span>SECURE LINK // NGC2</span>';
      document.body.append(launch);
      const resetLaunch = () => { launch.hidden = true; launch.classList.remove('is-launching'); };
      addEventListener('pagehide', resetLaunch);
      addEventListener('pageshow', resetLaunch);
      addEventListener('click', e => {
        const link = e.target.closest('a[href$="project-ngc2.html"]');
        if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
          location.assign(link.href);
          return;
        }
        const r = link.querySelector('.card')?.getBoundingClientRect() || link.getBoundingClientRect();
        launch.style.setProperty('--launch-clip', `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round 8px)`);
        launch.hidden = false;
        try { sessionStorage.setItem('ngc2-entry', 'home'); } catch {}
        requestAnimationFrame(() => launch.classList.add('is-launching'));
        setTimeout(() => location.assign(link.href), 850);
      }, true);
    };
    const fillSayclipLogo = () => {
      const mark = document.querySelector('.sayclip-mark');
      if (!mark || mark.querySelector('img')) return;
      mark.replaceChildren();
      mark.insertAdjacentHTML('beforeend',
        '<img src="/images/sayclip-wordmark.svg" alt="Sayclip">'
      );
    };
    const fillSayclipBadge = () => {
      const card = document.querySelector('.grid .card-wrap[href="/sayclip/"] .card');
      if (!card || card.querySelector('.sayclip-dl')) return;
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'sayclip-dl';
      a.setAttribute('aria-label', 'Download Sayclip for Mac');
      // Inside the card link, so the card's own navigation has to be called off by hand.
      a.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        location.href = 'https://github.com/shawnpsi-lgtm/sayclip/releases/latest/download/Sayclip-arm64.dmg';
      });
      a.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/></svg>Download for Mac';
      card.append(a);
    };
    const fillCardCopy = () => {
      const items = [
        ['[href="project-djai.html"]', 'DJai', 'AI DJ in your pocket'],
        ['[href="project-emmy.html"]', '', 'Award-winning animation and visual effects'],
        ['[href="project-cloudexa.html"]', '', 'Banking-grade ATM operations dashboard'],
        ['[href="/beatfx/"]', 'BEAT FX', 'a powerful notepad for on the go DJs'],
        [':has([src$="igstory.mp4"])', 'MARTINIQUE, FRANCE', 'Hennessy', 'Select Client'],
        [':has([src$="trailer.mp4"])', 'LONDON, UK', 'LAB 54', 'Select Client'],
        ['[href="project-visuallyrepresented.html"]', '', 'A Visual System for brands'],
        ['.card-wrap--tv', 'SHAWN TV', ''],
        ['[href="/sayclip/"]', '', 'Crate-dig for Audio Samples by Query'],
      ];
      for (const [sel, kicker, line, tag] of items) {
        const card = document.querySelector('.grid .card-wrap' + sel + ' .card');
        if (!card || card.querySelector('.card-copy')) continue;
        const el = document.createElement('div');
        el.className = 'card-copy';
        el.innerHTML = (kicker ? '<span>' + kicker + '</span>' : '') + '<b>' + line + '</b>';
        card.append(el);
        if (tag) card.insertAdjacentHTML('beforeend', '<span class="card-tag">' + tag + '</span>');
      }
    };

  const fillAll = () => {
    fillEmpty(); fillNgc2(); fillDjai(); fillCardCopy(); fillSayclipLogo(); fillSayclipBadge();
  };
  addEventListener('DOMContentLoaded', () => {
    fillAll();
    wireNgc2Launch();
    // React mounts after this fires, so keep filling as the grid appears.
    new MutationObserver(fillAll).observe(document.getElementById('root'), { childList: true, subtree: true });
  });
})();
