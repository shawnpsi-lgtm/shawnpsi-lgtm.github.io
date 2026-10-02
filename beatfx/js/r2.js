/* Load tracks from the user's r2music library (r2.shawnsingh.me).
   r2music signs short-lived R2 URLs for the signed-in GitHub user; its login
   cookie flows here because both hosts are on shawnsingh.me. Read-only. */
(function () {
  'use strict';
  var API = 'https://r2.shawnsingh.me';
  var $ = function (id) { return document.getElementById(id); };
  var dlg = $('r2-dialog'), status = $('r2-status'), filter = $('r2-filter'),
      listSel = $('r2-list'), ul = $('r2-tracks');
  var lib = null;

  function api(path, body) {
    return fetch(API + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      if (r.status === 401) throw new Error('signin');
      if (!r.ok) throw new Error('api');
      return r.json();
    });
  }
  function signedUrl(key) {
    return api('/api/sign', { items: [{ key: key, method: 'GET' }] })
      .then(function (r) { return r.urls[0]; });
  }
  function fail(e) {
    var m = e && e.message;
    status.innerHTML = m === 'signin'
      ? '<a href="' + API + '/auth/login?next=' + encodeURIComponent(location.href) + '">SIGN IN TO R2MUSIC</a>'
      : m === 'connect'
        ? '<a href="' + API + '" target="_blank" rel="noopener">CONNECT YOUR BUCKET IN R2MUSIC</a>'
        : 'COULD NOT LOAD LIBRARY';
  }

  function render() {
    var q = filter.value.trim().toLowerCase();
    var list = lib.lists.filter(function (l) { return l.id === listSel.value; })[0];
    var ids = list ? list.trackIds : Object.keys(lib.tracks).sort(function (a, b) {
      return lib.tracks[b].addedAt - lib.tracks[a].addedAt;
    });
    ids = ids.filter(function (id) {
      return lib.tracks[id] && lib.tracks[id].name.toLowerCase().indexOf(q) !== -1;
    });
    ul.innerHTML = '';
    ids.forEach(function (id) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.textContent = lib.tracks[id].name;
      b.onclick = function () { pick(id); };
      li.appendChild(b);
      ul.appendChild(li);
    });
    status.textContent = ids.length ? '' : 'NO TRACKS';
  }

  function pick(id) {
    var t = lib.tracks[id], key = 'tracks/' + id + '.' + t.ext;
    dlg.close();
    window.BeatFX.loadFile(signedUrl(key)
      .then(function (url) { return fetch(url); })
      .then(function (r) {
        if (!r.ok) throw new Error('download');
        return r.blob();
      })
      .then(function (blob) { return new File([blob], t.name + '.' + t.ext, { type: blob.type }); }));
  }

  $('r2-btn').addEventListener('click', function () {
    dlg.showModal();
    if (lib) return render(); // cached for this page load; reopen is instant
    status.textContent = 'LOADING…';
    api('/api/me').then(function (me) {
      if (!me.connected) throw new Error('connect');
      return signedUrl('lists.json');
    }).then(function (url) {
      return fetch(url, { cache: 'no-store' });
    }).then(function (r) {
      if (r.status === 404) return { tracks: {}, lists: [] }; // empty bucket
      if (!r.ok) throw new Error('api');
      return r.json();
    }).then(function (data) {
      lib = data;
      listSel.innerHTML = '<option value="">ALL TRACKS</option>' + lib.lists.map(function (l) {
        var o = document.createElement('option');
        o.value = l.id; o.textContent = l.name.toUpperCase();
        return o.outerHTML;
      }).join('');
      render();
    }).catch(fail);
  });
  filter.addEventListener('input', function () { if (lib) render(); });
  listSel.addEventListener('change', function () { if (lib) render(); });
  $('r2-close').addEventListener('click', function () { dlg.close(); });
})();
