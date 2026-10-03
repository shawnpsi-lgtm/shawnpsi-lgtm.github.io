// The browse tree for one source, as the RX3 presents it: category -> (artist / album / key / ...) -> tracks.
// Lists are { title, head, items }; items are { label, meta?, track?, open?() -> list, act?() }.
import { memory } from '../lib/library.js';

const ROWS = 12;

export const CATEGORIES = ['ARTIST', 'ALBUMS', 'TRACK', 'KEY', 'PLAYLIST', 'HISTORY', 'MATCHING', 'FOLDER'];

const byTitle = (a, b) => a.title.localeCompare(b.title);

function trackItems(tracks) {
  return tracks.map((t) => ({ label: t.title, meta: t.artist, track: t }));
}

function grouped(tracks, key, none, head) {
  const groups = new Map();
  for (const t of tracks) {
    const k = t[key] || none;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  return [...groups.keys()].sort((a, b) => (a === none) - (b === none) || String(a).localeCompare(String(b)))
    .map((k) => ({ label: k, meta: groups.get(k).length, open: () => ({ title: k, head, items: trackItems(groups.get(k).sort(byTitle)) }) }));
}

/** masterBpm(): the BPM to match in MATCHING (the master deck's). */
export function categoryList(source, cat, masterBpm) {
  const tracks = source.tracks;
  switch (cat) {
    case 'ARTIST': return { title: 'ARTIST', head: 'ARTIST', items: grouped(tracks, 'artist', '(no artist)', 'TRACK') };
    case 'ALBUMS': return { title: 'ALBUMS', head: 'ALBUM', items: grouped(tracks, 'album', '(no album)', 'TRACK') };
    case 'KEY': return { title: 'KEY', head: 'KEY', items: grouped(tracks, 'key', '(no key)', 'TRACK') };
    case 'FOLDER': return { title: 'FOLDER', head: 'FOLDER', items: grouped(tracks, 'folder', source.label, 'TRACK') };
    case 'PLAYLIST': return {
      title: 'PLAYLIST', head: 'PLAYLIST',
      items: source.playlists.map((p) => ({ label: p.name, meta: p.tracks.length,
        open: () => ({ title: p.name, head: 'TRACK', items: trackItems(p.tracks) }) })),
    };
    case 'HISTORY': return { title: 'HISTORY', head: 'TRACK', items: trackItems(memory.history.filter((t) => t.source === source.id)) };
    case 'MATCHING': {
      const bpm = masterBpm();
      const near = bpm ? tracks.filter((t) => t.bpm && Math.abs(t.bpm / bpm - 1) < 0.06)
        .sort((a, b) => Math.abs(a.bpm - bpm) - Math.abs(b.bpm - bpm)) : [];
      return { title: bpm ? 'MATCHING ' + bpm.toFixed(1) + ' BPM' : 'MATCHING (play a track first)', head: 'TRACK', items: trackItems(near) };
    }
    default: return { title: 'TRACK', head: 'TRACK', items: trackItems([...tracks].sort(byTitle)) };
  }
}

export class Browser {
  constructor() {
    this.source = null;
    this.category = 'TRACK';
    this.stack = [];
  }

  get list() {
    return this.stack[this.stack.length - 1];
  }

  get selected() {
    const l = this.list;
    return l?.items[l.cursor];
  }

  open(list) {
    list.cursor = 0;
    list.top = 0;
    this.stack.push(list);
  }

  root(source, cat, masterBpm) {
    this.source = source;
    this.category = cat;
    this.stack = [];
    this.open(categoryList(source, cat, masterBpm));
  }

  special(list) { // TAG LIST, SEARCH: not tied to a category icon
    this.category = null;
    this.stack = [];
    this.open(list);
  }

  move(d) {
    const l = this.list;
    if (!l?.items.length) return;
    l.cursor = Math.max(0, Math.min(l.items.length - 1, l.cursor + d));
    if (l.cursor < l.top) l.top = l.cursor;
    if (l.cursor >= l.top + ROWS) l.top = l.cursor - ROWS + 1;
  }

  select(i) {
    this.move(i - this.list.cursor);
  }

  /** PUSH: open the highlighted folder. Returns false if there is nothing to open (a track). */
  push() {
    const it = this.selected;
    if (it?.act) {
      it.act();
      return true;
    }
    if (!it?.open) return false;
    this.open(it.open());
    return true;
  }

  back() {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    return true;
  }

  /** Re-run the root query (the library or history changed) without losing the cursor. */
  refresh(masterBpm) {
    if (!this.source || !this.category || this.stack.length !== 1) return;
    const cur = this.list.cursor, top = this.list.top;
    this.stack = [categoryList(this.source, this.category, masterBpm)];
    this.list.cursor = Math.min(cur, Math.max(0, this.list.items.length - 1));
    this.list.top = Math.min(top, this.list.cursor);
  }
}

export { ROWS };
