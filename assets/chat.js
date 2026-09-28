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
  let msgs = [];   // system prompt and model are the worker's business
  let chatId = null;   // the saved chat this conversation appends to, once signed in

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

  // Optional sign-in, so chats are saved. The worker hands the session back in
  // the URL fragment after the provider's redirect; keep it and tidy the URL.
  const KEY = 'shawn-ai-session';
  const store = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
                  set: v => { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {} } };
  const fresh = location.hash.match(/^#session=([\w.-]+)$/)?.[1];
  if (fresh) {
    store.set(fresh);
    history.replaceState(null, '', location.pathname + location.search);
    const ask = document.getElementById('ask');
    if (ask) ask.open = true;   // they left from the chat, so land back in it
  }
  const authed = (opts = {}) => {
    const t = store.get();
    return t ? { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + t } } : opts;
  };
  const NAMES = { google: 'Google', linkedin: 'LinkedIn' };
  const GOOGLE_G = '<svg viewBox="0 0 48 48" width="14" height="14" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  const acct = document.createElement('div');
  acct.id = 'chat-acct';
  form.prepend(acct);
  const el = (tag, props) => Object.assign(document.createElement(tag), props);
  const reset = () => { msgs = []; chatId = null; log.textContent = ''; };

  async function account() {
    const me = await fetch(PROXY + '/me', authed()).then(r => r.json()).catch(() => null);
    acct.textContent = '';
    if (!me) return;
    if (!me.user) {
      if (store.get()) store.set(null);   // expired, or the account was deleted
      if (!me.providers?.length) return;
      acct.append('Sign in to save chats:');
      const ret = encodeURIComponent(location.href.split('#')[0]);
      for (const p of me.providers) {
        const a = el('a', { href: `${PROXY}/auth/${p}?return=${ret}`, textContent: NAMES[p] || p });
        if (p === 'google') a.insertAdjacentHTML('afterbegin', GOOGLE_G);
        acct.append(a);
      }
      return;
    }
    // Saved-chats menu: <details> gives open/close and keyboard toggling for free.
    const pick = el('details', { className: 'chat-pick' });
    const cur = el('summary', { ariaLabel: 'Saved chats', textContent: me.chats.find(c => c.id === chatId)?.title || 'New chat' });
    const list = el('div', { role: 'menu' });
    for (const c of [null, ...me.chats]) {
      const b = el('button', { type: 'button', role: 'menuitem', textContent: c ? c.title : 'New chat' });
      if ((c?.id ?? null) === chatId) b.ariaCurrent = 'true';
      b.addEventListener('click', async () => {
        pick.open = false;
        cur.textContent = b.textContent;
        list.querySelector('[aria-current]')?.removeAttribute('aria-current');
        b.ariaCurrent = 'true';
        reset();
        if (!c) return;
        const r = await fetch(PROXY + '/chats/' + c.id, authed()).then(r => r.json()).catch(() => null);
        chatId = c.id;
        msgs = r?.messages || [];
        for (const m of msgs) m.role === 'user' ? say('me', m.content) : render(say('bot', ''), m.content);
      });
      list.append(b);
    }
    pick.append(cur, list);
    const out = el('button', { type: 'button', textContent: 'Sign out' });
    out.addEventListener('click', () => { store.set(null); reset(); account(); });
    const del = el('button', { type: 'button', textContent: 'Delete my data' });
    del.addEventListener('click', async () => {
      if (!confirm('Delete your account and every saved chat? This can’t be undone.')) return;
      const r = await fetch(PROXY + '/me', authed({ method: 'DELETE' })).catch(() => null);
      if (!r?.ok) return alert('Couldn’t delete right now — try again in a minute.');
      store.set(null); reset(); account();
    });
    acct.append(el('span', { textContent: me.user.name || me.user.email || 'Signed in' }), pick, out, del);
  }
  account();
  // Close the saved-chats menu on an outside click or Escape.
  const shut = () => acct.querySelector('details[open]')?.removeAttribute('open');
  document.addEventListener('click', e => { if (!e.target.closest?.('.chat-pick')) shut(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') shut(); });

  // Model picker, in the home page's #connect bar only. The worker allowlists
  // these two and ignores anything else.
  const model = el('select', { ariaLabel: 'Model', title: 'Which Groq model answers' });
  model.append(el('option', { value: 'openai/gpt-oss-120b', textContent: 'GPT-OSS 120B' }),
               el('option', { value: 'openai/gpt-oss-20b', textContent: 'GPT-OSS 20B (faster)' }));
  document.getElementById('connect')?.prepend(model);

  for (const b of document.querySelectorAll('#connect button')) b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.url); }
    catch { prompt('Copy this URL:', b.dataset.url); return; }   // no clipboard: copy by hand
    b.dataset.label ??= b.textContent;
    b.textContent = '\u2713 ' + b.dataset.done;
    b.classList.add('done');
    clearTimeout(b.reset);
    b.reset = setTimeout(() => { b.textContent = b.dataset.label; b.classList.remove('done'); }, 2000);
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
      const r = await fetch(PROXY, authed({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: msgs, chat_id: chatId, model: model.value }),
      }));
      const raw = await r.text();
      if (!r.ok) {
        let msg = raw.slice(0, 300);
        try { msg = JSON.parse(raw).error?.message || JSON.parse(raw).error || msg; } catch {}
        throw new Error(msg);
      }
      const j = JSON.parse(raw);
      const reply = j.choices[0].message.content;
      msgs.push({ role: 'assistant', content: reply });
      render(out, reply);
      // A new saved chat: refresh the picker so it lists (and selects) this one.
      if (j.chat_id && j.chat_id !== chatId) { chatId = j.chat_id; account(); }
    } catch (err) {
      msgs.pop();   // drop the unanswered turn so a retry isn't sent twice
      out.textContent = err.message || String(err);
      out.classList.add('err');
    }
    log.scrollTop = log.scrollHeight;
  });
})();
