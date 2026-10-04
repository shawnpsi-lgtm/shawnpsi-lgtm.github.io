// The "USB sticks": USB1 is the signed-in user's r2music library (r2.shawnsingh.me, the same API beatfx uses),
// USB2 is a folder on this computer. Both produce the same track objects:
//   { id, title, artist, album, genre, bpm, key, duration, file(): Promise<File>, prepare?(): Promise }
// prepare() fetches the rekordbox beat grid when there is one (sets track.grid).
import { readPdb } from './pdb.js';
import { readId3, readPqtz, splitName } from './tags.js';

const R2 = 'https://r2.shawnsingh.me';
const AUDIO = /\.(mp3|wav|aiff?|m4a|aac|flac|ogg|opus)$/i;

class Source {
  constructor(id, label) {
    this.id = id; // 'USB1' / 'USB2'
    this.label = label;
    this.tracks = [];
    this.playlists = []; // [{ name, tracks }]
    this.status = 'empty'; // empty | loading | ready | signin | connect | error
    this.message = '';
  }
}

export class R2Source extends Source {
  constructor() {
    super('USB1', 'R2 MUSIC');
  }

  async api(path, body) {
    const r = await fetch(R2 + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401) throw new Error('signin');
    if (!r.ok) throw new Error('api');
    return r.json();
  }

  async sign(key) {
    return (await this.api('/api/sign', { items: [{ key, method: 'GET' }] })).urls[0];
  }

  get signInUrl() {
    return R2 + '/auth/login?next=' + encodeURIComponent(location.href);
  }

  async open() {
    if (this.status === 'ready' || this.status === 'loading') return;
    this.status = 'loading';
    try {
      const me = await this.api('/api/me');
      if (!me.connected) throw new Error('connect');
      const r = await fetch(await this.sign('lists.json'), { cache: 'no-store' });
      const lib = r.status === 404 ? { tracks: {}, lists: [] } : await r.json();
      const byId = {};
      this.tracks = Object.entries(lib.tracks).map(([sha, t]) => {
        const named = splitName(t.name);
        const track = {
          id: 'r2:' + sha, title: named.title, artist: named.artist || '', album: '', genre: '',
          bpm: t.bpm || 0, key: t.key || '', duration: t.duration || 0, addedAt: t.addedAt || 0, source: this.id,
          file: async () => {
            const res = await fetch(await this.sign('tracks/' + sha + '.' + t.ext));
            if (!res.ok) throw new Error('download');
            return new File([await res.blob()], t.name + '.' + t.ext);
          },
        };
        if (t.anlz?.files?.includes('DAT')) {
          track.prepare = async () => {
            if (track.grid) return;
            try {
              const res = await fetch(await this.sign('anlz/' + sha + '.DAT'));
              if (res.ok) track.grid = readPqtz(await res.arrayBuffer());
            } catch (e) {
              console.warn('no beat grid for', t.name, e);
            }
          };
        }
        byId[sha] = track;
        return track;
      }).sort((a, b) => b.addedAt - a.addedAt);
      this.playlists = lib.lists.map((l) => ({ name: l.name, tracks: l.trackIds.map((id) => byId[id]).filter(Boolean) }));
      this.status = 'ready';
    } catch (e) {
      this.status = ['signin', 'connect'].includes(e.message) ? e.message : 'error';
      this.message = e.message === 'signin' ? 'SIGN IN TO R2MUSIC'
        : e.message === 'connect' ? 'CONNECT YOUR BUCKET IN R2MUSIC'
          : location.hostname.endsWith('shawnsingh.me') ? 'COULD NOT LOAD LIBRARY' : 'OPENS ON shawnsingh.me';
    }
  }
}

/** The file at a drive-root path ("/Contents/…") under a picked directory, one handle per folder level. */
async function fileAt(dir, path) {
  const parts = path.split('/').filter(Boolean);
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  return dir.getFileHandle(parts.at(-1));
}

/** Runs fn over items, at most n at a time, so a big library doesn't open thousands of reads at once. */
async function pool(items, fn, n = 16) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: n }, worker));
}

export class FolderSource extends Source {
  constructor() {
    super('USB2', 'THIS COMPUTER');
  }

  /**
   * Picks a folder via the File System Access API, avoiding Chrome's "upload N files" prompt. Throws AbortError on cancel.
   * A rekordbox USB (PIONEER/rekordbox/export.pdb at the top) is read like a CDJ reads it; anything else is scanned.
   * Resolves to the number of tracks.
   */
  async pick(onProgress) {
    const dir = await showDirectoryPicker({ id: 'rx3-usb2', mode: 'read' });
    this.status = 'loading';
    const pdb = await fileAt(dir, '/PIONEER/rekordbox/export.pdb').catch(() => null);
    if (pdb) return this.openExport(dir, await (await pdb.getFile()).arrayBuffer());
    const handles = [];
    const walk = async (d, path) => { // sibling folders in parallel: a USB stick is slow per call, not per byte
      const subs = [];
      try {
        for await (const h of d.values()) {
          if (h.name.startsWith('.')) continue; // ._ AppleDouble files, .Trashes, …
          const p = path + '/' + h.name;
          if (h.kind === 'directory') subs.push(walk(h, p));
          else if (AUDIO.test(h.name)) {
            handles.push({ h, path: p });
            onProgress?.('SCANNING… ' + handles.length);
          }
        }
      } catch (e) {
        console.warn('USB2: could not list', path, e);
      }
      await Promise.all(subs);
    };
    await walk(dir, dir.name);
    const out = [];
    await pool(handles, async ({ h, path }) => {
      try {
        out.push({ file: await h.getFile(), path });
      } catch (e) { // unreadable (cloud placeholder, broken alias…): skip it rather than lose the whole folder
        console.warn('USB2: skipped', path, e);
      }
    });
    return this.add(out, onProgress);
  }

  /** A rekordbox export: its tracks (opened from the drive on load, with their beat grids) and its playlists. */
  openExport(dir, buf) {
    const db = readPdb(buf), byId = new Map();
    this.tracks = db.tracks.filter((t) => t.path).map((t) => {
      const name = t.path.split('/').pop(), named = splitName(name);
      const track = {
        id: 'usb:' + t.path, title: t.title || named.title, artist: t.artist || named.artist || '', album: t.album,
        genre: t.genre, bpm: t.bpm, key: t.key, duration: t.duration,
        folder: t.path.split('/').slice(1, -1).join('/') || 'FILES', source: this.id,
        file: async () => (await fileAt(dir, t.path)).getFile(),
        prepare: async () => {
          if (track.grid || !t.anlz) return;
          try {
            track.grid = readPqtz(await (await (await fileAt(dir, t.anlz)).getFile()).arrayBuffer());
          } catch (e) {
            console.warn('no beat grid for', t.path, e);
          }
        },
      };
      byId.set(t.id, track);
      return track;
    }).sort((a, b) => a.title.localeCompare(b.title));
    const lists = new Map(db.lists.map((l) => [l.id, l]));
    const fullName = (l) => (lists.has(l.parent) ? fullName(lists.get(l.parent)) + ' / ' : '') + l.name; // folders flattened
    this.playlists = db.lists.filter((l) => !l.folder).sort((a, b) => a.seq - b.seq).map((l) => ({
      name: fullName(l),
      tracks: db.entries.filter((e) => e.list === l.id).sort((a, b) => a.seq - b.seq).map((e) => byId.get(e.track)).filter(Boolean),
    }));
    this.status = this.tracks.length ? 'ready' : 'empty';
    return this.tracks.length;
  }

  /** files: a FileList / File[] from a folder picker or a drop, or {file, path} entries from pick(). */
  async add(files, onProgress) {
    const audio = [...files]
      .map((f) => (f instanceof File ? { file: f, path: f.webkitRelativePath || f.name } : f))
      .filter(({ file }) => AUDIO.test(file.name) && !file.name.startsWith('.'));
    if (!audio.length) {
      this.status = this.tracks.length ? 'ready' : 'empty';
      return 0;
    }
    this.status = 'loading';
    const added = [];
    await pool(audio, async ({ file: f, path }) => {
      const tags = await readId3(f).catch(() => ({}));
      const named = splitName(f.name);
      added.push({
        id: 'file:' + f.name + ':' + f.size, title: tags.title || named.title, artist: tags.artist || named.artist || '',
        album: tags.album || '', genre: tags.genre || '', bpm: tags.bpm || 0, key: tags.key || '', duration: 0,
        folder: path.split('/').slice(0, -1).join('/') || 'FILES', source: this.id, file: async () => f,
      });
      if (added.length % 100 === 0) onProgress?.('READING TAGS… ' + added.length + '/' + audio.length);
    });
    const known = new Set(this.tracks.map((t) => t.id));
    this.tracks.push(...added.filter((t) => !known.has(t.id)));
    this.tracks.sort((a, b) => a.title.localeCompare(b.title));
    this.status = 'ready';
    return added.length;
  }
}

/** Per-track memory across visits: tag list and history (ids only). */
export const memory = {
  tags: new Set(JSON.parse(localStorage.getItem('rx3.tags') || '[]')),
  history: [],
  toggleTag(track) {
    if (this.tags.has(track.id)) this.tags.delete(track.id);
    else this.tags.add(track.id);
    localStorage.setItem('rx3.tags', JSON.stringify([...this.tags]));
  },
  played(track) {
    this.history = [track, ...this.history.filter((t) => t !== track)].slice(0, 200);
  },
};
