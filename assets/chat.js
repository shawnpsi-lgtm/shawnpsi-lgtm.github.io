/* Shared by index.html (#scene2) and every other page, where it adds the
   chat as the #ask pill in the nav (styles in ask.css). */
// Groq chat. The key lives in the Cloudflare Worker (worker/groq-proxy.js),
// never here — this page is public, so a baked-in key would be a public key.
(() => {
  const PROXY = 'https://groq-chat.shawnpsi.workers.dev';
  if (!document.getElementById('chat')) document.body.insertAdjacentHTML('beforeend', `
    <details id="ask">
      <summary>Ask Shawn AI</summary>
      <form id="chat" autocomplete="off">
        <div id="chat-log" aria-live="polite"></div>
        <input id="chat-input" placeholder="Ask about any project\u2026" aria-label="Message" />
        <button type="submit" aria-label="Send">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 19V5"/><path d="M5.5 11.5 12 5l6.5 6.5"/>
          </svg>
        </button>
      </form>
    </details>`);
  const form = document.getElementById('chat');
  const log = document.getElementById('chat-log');
  const input = document.getElementById('chat-input');
  const msgs = [];   // system prompt and model are the worker's business

  const say = (who, text) => {
    const p = document.createElement('p');
    p.className = who;
    p.textContent = text;
    log.append(p);
    log.scrollTop = log.scrollHeight;
    return p;
  };

  // Replies are plain text, but the model likes to cite pages and URLs,
  // sometimes as [text](url) or wrapped in **bold**. Turn those into links,
  // built as DOM nodes (never innerHTML) and only for http(s) or site paths.
  const LINK = /\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s)*<>]*[^\s)*<>.,;:!?'"]|\/[\w./-]+\.html\b)/g;
  const TITLES = {
    '/about.html': 'About', '/work.html': 'Work', '/project-cloudexa.html': 'Cloudexa',
    '/project-emmy.html': 'Emmy Award', '/project-djai.html': 'DJai', '/project-ngc2.html': 'NGC2',
    '/project-visuallyrepresented.html': 'Visually Represented',
  };
  const linkify = (el, text) => {
    let i = 0;
    for (const m of text.matchAll(LINK)) {
      const href = m[2] || m[3];
      if (!/^(https?:\/\/|\/)/.test(href)) continue;
      el.append(text.slice(i, m.index));
      const a = document.createElement('a');
      a.href = href;
      a.textContent = (TITLES[href] ? TITLES[href] + ' \u2192' : m[1]) || (href[0] === '/' ? href : new URL(href).hostname);
      if (href[0] !== '/') { a.target = '_blank'; a.rel = 'noopener'; }
      el.append(a);
      i = m.index + m[0].length;
    }
    el.append(text.slice(i));
  };
  // Runs of "- item" lines become a <ul>; everything else stays pre-wrap text.
  const render = (el, text) => {
    // The model often writes paths with U+2010/2011 hyphens, which the regex misses.
    text = text.replace(/\*\*/g, '').replace(/[\u2010\u2011]/g, '-');
    el.textContent = '';
    let ul = null, buf = '';
    const flush = () => { if (buf.trim()) { linkify(el, buf.trim()); ul = null; } buf = ''; };
    for (const line of text.split('\n')) {
      const item = line.match(/^\s*[-*\u2022]\s+(.*)/);
      if (!item) { buf += line + '\n'; continue; }
      flush();   // blank lines between items keep the same list
      if (!ul) el.append(ul = document.createElement('ul'));
      const li = document.createElement('li');
      linkify(li, item[1].trim());
      ul.append(li);
    }
    flush();
  };

  for (const b of document.querySelectorAll('#connect button')) b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.url); b.textContent = b.dataset.done; }
    catch { b.textContent = b.dataset.url; }   // no clipboard: show it to copy by hand
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    say('me', text);
    msgs.push({ role: 'user', content: text });
    const out = say('bot', '\u2026');
    try {
      const r = await fetch(PROXY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs }),
      });
      const raw = await r.text();
      if (!r.ok) {
        let msg = raw.slice(0, 300);
        try { msg = JSON.parse(raw).error?.message || JSON.parse(raw).error || msg; } catch {}
        throw new Error(msg);
      }
      const reply = JSON.parse(raw).choices[0].message.content;
      msgs.push({ role: 'assistant', content: reply });
      render(out, reply);
    } catch (err) {
      msgs.pop();   // drop the unanswered turn so a retry isn't sent twice
      out.textContent = err.message || String(err);
      out.classList.add('err');
    }
    log.scrollTop = log.scrollHeight;
  });
})();
