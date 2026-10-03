// The "USB sticks": USB1 is the signed-in user's r2music library (r2.shawnsingh.me, the same API beatfx uses),
// USB2 is a folder on this computer. Both produce the same track objects:
//   { id, title, artist, album, genre, bpm, key, duration, file(): Promise<File>, prepare?(): Promise }
// prepare() fetches the rekordbox beat grid when there is one (sets track.grid).
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

export class FolderSource extends Source {
  constructor() {
    super('USB2', 'THIS COMPUTER');
  }

  /** files: a FileList / File[] from a folder picker or a drop. */
  async add(files) {
    const audio = [...files].filter((f) => AUDIO.test(f.name));
    if (!audio.length) return 0;
    this.status = 'loading';
    const folders = new Map();
    const added = await Promise.all(audio.map(async (f) => {
      const tags = await readId3(f).catch(() => ({}));
      const named = splitName(f.name);
      const folder = (f.webkitRelativePath || f.name).split('/').slice(0, -1).join('/') || 'FILES';
      const t = {
        id: 'file:' + f.name + ':' + f.size, title: tags.title || named.title, artist: tags.artist || named.artist || '',
        album: tags.album || '', genre: tags.genre || '', bpm: tags.bpm || 0, key: tags.key || '', duration: 0,
        folder, source: this.id, file: async () => f,
      };
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push(t);
      return t;
    }));
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
