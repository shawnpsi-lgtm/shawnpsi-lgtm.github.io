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
          cols: 300, rows: 230, point: 2, dist: 4.6,
          speed: reduce ? 0 : .6, spin: .08, tilt: .45, wobble: .07,
          color: [.86, .88, .9], background: null,
          // flying-wing UAV over scrolling contour terrain, with a sensor footprint
          place: `float terr(vec2 p){
            return 0.9*(0.32*sin(p.x*1.1+0.6)*cos(p.y*0.9-0.4)+0.16*sin(p.x*2.3-p.y*1.7+1.3)
                       +0.08*sin(p.x*4.7+p.y*3.9)+0.04*cos(p.x*8.1-p.y*7.3));
          }
          vec4 place(vec2 uv,float i,float t){
            float fly=t*0.5, ground=-0.45;
            vec3 W=vec3(0.0,0.9+0.04*sin(t*1.1),0.0);
            vec2 F=vec2(0.0,0.35);
            if(uv.y<0.62){
              vec2 p=(vec2(uv.x,uv.y/0.62)-0.5)*5.0;
              float y=terr(p+vec2(0.0,fly));
              float line=smoothstep(0.8,1.0,abs(fract(y*7.0)-0.5)*2.0);
              float edge=smoothstep(2.3,1.6,length(p));
              float fd=length(p-F), foot=smoothstep(0.75,0.6,fd), ring=smoothstep(0.05,0.0,abs(fd-0.7));
              return vec4(vec3(p.x,y+ground,p.y),(0.16+line*(0.6+0.6*foot)+foot*0.15+ring)*edge);
            }
            if(uv.y<0.95){
              float f=(uv.y-0.62)/0.33, sx=uv.x*2.0-1.0, ax=abs(sx);
              float zle=1.25-ax*1.7;
              float zte=ax<0.25?mix(-0.75,-0.35,ax/0.25):ax<0.55?mix(-0.35,-0.75,(ax-0.25)/0.3):mix(-0.75,-0.62,(ax-0.55)/0.45);
              float c=zle-zte, th=c*0.07*sin(3.14159*pow(f,1.9));
              float top=mod(floor(uv.y*229.0+0.5),2.0);
              float y=top>0.5?th+0.13*exp(-ax*ax*60.0)*sin(3.14159*pow(f,1.5)):-th*0.6;
              float edge=max(smoothstep(0.04,0.0,f),smoothstep(0.96,1.0,f));
              vec3 p=vec3(sx*2.1,y,mix(zte,zle,f)-0.2)*0.6;
              p.xy=rot(0.12*sin(t*0.6))*p.xy;
              return vec4(p+W,(top>0.5?0.55:0.15)*(0.5+0.8*f)+edge*0.8);
            }
            float k=(uv.y-0.95)/0.05, a=uv.x*6.2831853;
            vec2 rp=F+vec2(cos(a),sin(a))*0.7;
            vec3 R=vec3(rp.x,terr(rp+vec2(0.0,fly))+ground,rp.y);
            return vec4(mix(W-vec3(0.0,0.05,0.0),R,k),0.14+0.4*smoothstep(0.9,1.0,k));
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

    // The rx3 hero (rx3/hero.html: the Neon Ripple under a glass word) in a card's image box. The hero lays itself out
    // for the window it's in, so at card size the ripple and glass would come out coarser and the word would fill the
    // card. It's drawn 1000px wide in the box's shape instead, with the word at the share of the width it takes on a
    // desktop window (?fill), and scaled down: the project page's opening view, small.
    const heroFrame = (box, query) => {
      Object.assign(box.style, { position: 'relative', overflow: 'hidden', background: 'rgb(3,3,5)' });
      box.insertAdjacentHTML('beforeend', `<iframe src="/rx3/hero.html?${query}" title="" aria-hidden="true" tabindex="-1" loading="lazy" ` +
        'style="position:absolute;left:0;top:0;width:1000px;height:900px;border:0;pointer-events:none;transform-origin:0 0;transform:scale(.3)"></iframe>');
      const frame = box.lastElementChild;
      new ResizeObserver(() => {
        const k = box.clientWidth / 1000;
        if (!k) return;
        frame.style.height = Math.round(box.clientHeight / k) + 'px';
        frame.style.transform = `scale(${k})`;
      }).observe(box);
    };

    // Visually Represented and Emmy trade React's blurred colour blobs for the same glass-word hero, each over its own
    // Wayglim look (hero.html's ?bg=): Hyperdrive and Spotlight. React's layers stay in the box, hidden, so it still
    // finds its nodes if it re-renders.
    const fillBrandHeroes = () => {
      for (const [href, query] of [
        ['project-visuallyrepresented.html', 'word=vr&bg=hyperdrive&fill=.6'],
        ['project-emmy.html', 'word=Emmy&bg=spotlight&fill=.8'],
      ]) {
        const box = document.querySelector(`.grid .card-wrap[href="${href}"] .card__img`);
        if (!box || box.querySelector('iframe')) continue;
        for (const el of box.children) el.style.display = 'none';
        heroFrame(box, query);
      }
    };

    // rx3 isn't one of React's cards, so it's added here, first in the grid, built like the others: the image is the rx3
    // landing page's hero (rx3/hero.html: the Neon Ripple with the glass "rx3"), with the caption over it, and it fades
    // in on scroll as React's cards do.
    const fillRx3 = () => {
      const grid = document.querySelector('.grid');
      if (!grid?.querySelector('.card-wrap[href="project-ngc2.html"]') || grid.querySelector('.card-wrap--rx3')) return;
      grid.insertAdjacentHTML('afterbegin',
        '<a href="project-rx3.html" class="card-wrap card-wrap--rx3" aria-label="View rx3 project">' +
          '<div class="card">' +
            '<div class="card__img"></div>' +
            '<div class="card__overlay"><p class="card__overlay-title">rx3</p>' +
              '<p class="card__overlay-tagline">A pro DJ unit, in a browser tab.</p><span class="btn btn--white">View Project</span></div>' +
            '<div class="card-copy"><b>A pro DJ unit, in a browser tab</b></div>' +
          '</div>' +
          '<div class="card__info"><h3 class="card__title">rx3</h3>' +
            '<p class="card__tagline">The Pioneer XDJ-RX3, rebuilt in the browser from its own firmware</p></div>' +
        '</a>');
      const card = grid.querySelector('.card-wrap--rx3');
      heroFrame(card.querySelector('.card__img'), 'fill=.7');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      Object.assign(card.style, { opacity: 0, transform: 'translateY(24px)', transition: 'opacity .6s, transform .6s' });
      new IntersectionObserver(([e], io) => {
        if (!e.isIntersecting) return;
        Object.assign(card.style, { opacity: 1, transform: 'none' });
        io.disconnect();
      }, { threshold: .15 }).observe(card);
    };

    // r2 sits beside rx3 at the top, in place of React's r2music card (hidden above), built the same way as rx3's: the hero is rx3/hero.html with the word
    // swapped (?word=r2) and turned purple (?hue=-45), the same as project-r2.html's opening view.
    const fillR2 = () => {
      const grid = document.querySelector('.grid');
      const rx3 = grid?.querySelector('.card-wrap--rx3');
      if (!rx3 || grid.querySelector('.card-wrap--r2')) return;
      rx3.insertAdjacentHTML('afterend',
        '<a href="project-r2.html" class="card-wrap card-wrap--r2" aria-label="View r2 project">' +
          '<div class="card">' +
            '<div class="card__img"></div>' +
            '<div class="card__overlay"><p class="card__overlay-title">r2</p>' +
              '<p class="card__overlay-tagline">Personalize your music streaming.</p><span class="btn btn--white">View Project</span></div>' +
            '<div class="card-copy"><b>Personalize your music streaming</b></div>' +
          '</div>' +
          '<div class="card__info"><h3 class="card__title">r2</h3>' +
            '<p class="card__tagline">Personalize your music streaming</p></div>' +
        '</a>');
      const card = grid.querySelector('.card-wrap--r2');
      heroFrame(card.querySelector('.card__img'), 'word=r2&hue=-45&fill=.5');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      Object.assign(card.style, { opacity: 0, transform: 'translateY(24px)', transition: 'opacity .6s, transform .6s' });
      new IntersectionObserver(([e], io) => {
        if (!e.isIntersecting) return;
        Object.assign(card.style, { opacity: 1, transform: 'none' });
        io.disconnect();
      }, { threshold: .15 }).observe(card);
    };

    // Splits the work into Products / Enterprise / Defense / Brand / Film. React's grid keeps the products (rx3 and r2
    // stay put: moving an iframe reloads it) and the other two groups move into grids of their own below it. Each group
    // is its own bento (2 wide, then 3 narrow), so styles.css's position rules size it; work.html fixes one corner.
    // Above them, .work-tabs links to each heading; glass.js turns it into a Glisse tab bar.
    const fillGroups = () => {
      const grid = document.querySelector('.grid');
      if (!grid?.querySelector('.card-wrap--r2') || document.querySelector('.work-group')) return;
      // React's old r2music card, replaced by fillR2's r2.
      grid.querySelector('.card-wrap[href="project-r2.html"]:not(.card-wrap--r2)')?.remove();
      const slug = name => name.toLowerCase().replace(/[^a-z]+/g, '-');   // "Brand / Film" -> brand-film
      const heading = name => Object.assign(document.createElement('h2'), { className: 'work-group', id: slug(name), textContent: name });
      const groups = [
        ['Enterprise / Defense', ['[href="project-ngc2.html"]', '[href="project-cloudexa.html"]']],
        ['Brand / Film', [':has([src$="igstory.mp4"])', ':has([src$="trailer.mp4"])',
          '[href="project-visuallyrepresented.html"]', '.card-wrap--tv', '[href="project-emmy.html"]']],
      ];
      const tabs = document.createElement('div');
      tabs.className = 'work-tabs';
      tabs.innerHTML = ['Products', ...groups.map(([name]) => name)].map(n => `<a href="#${slug(n)}">${n}</a>`).join('');
      grid.before(tabs, heading('Products'));
      let last = grid;
      for (const [name, sels] of groups) {
        const h = heading(name);
        const g = document.createElement('div');
        g.className = 'grid';
        g.append(...sels.map(s => grid.querySelector('.card-wrap' + s)).filter(Boolean));
        last.after(h, g);
        last = g;
      }
    };

    // React's client video cards are plain (aria-hidden) divs; this stretches a link over each one to its coverage.
    const fillClientLinks = () => {
      const links = [
        [':has([src$="igstory.mp4"])', 'https://www.hennessy.com/en-us/hennessy-very-special-cocktails', 'Hennessy Very Special cocktails'],
        [':has([src$="trailer.mp4"])', 'https://djmag.com/news/ministry-of-sound-break-and-illegal-rave-confirmed-stunt-homage-uk-rave-culture', 'LAB 54 x Ministry of Sound on DJ Mag'],
      ];
      for (const [sel, href, label] of links) {
        const wrap = document.querySelector('.grid .card-wrap' + sel);
        if (!wrap || wrap.querySelector('.card-link')) continue;
        wrap.removeAttribute('aria-hidden');
        Object.assign(wrap.style, { position: 'relative', cursor: 'pointer' });
        const a = Object.assign(document.createElement('a'), { className: 'card-link', href, target: '_blank', rel: 'noopener' });
        a.setAttribute('aria-label', label + ' (opens in a new tab)');
        Object.assign(a.style, { position: 'absolute', inset: '0', zIndex: '20' });
        wrap.append(a);
      }
    };

  const fillAll = () => {
    fillEmpty(); fillNgc2(); fillDjai(); fillCardCopy(); fillClientLinks(); fillSayclipLogo(); fillSayclipBadge(); fillRx3(); fillR2(); fillBrandHeroes(); fillGroups();
  };
  addEventListener('DOMContentLoaded', () => {
    fillAll();
    wireNgc2Launch();
    // React mounts after this fires, so keep filling as the grid appears.
    new MutationObserver(fillAll).observe(document.getElementById('root'), { childList: true, subtree: true });
  });
})();
