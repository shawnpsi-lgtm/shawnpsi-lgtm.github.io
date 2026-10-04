// export.pdb: the rekordbox USB export a real XDJ-RX3 browses (Pioneer's DeviceSQL format, documented by Deep Symmetry's
// crate-digger: https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html). Fixed-size pages, each
// table a linked list of pages, rows found through an index at each page's end. Ported from r2music's djusb.js.
const T = { tracks: 0, genres: 1, artists: 2, albums: 3, keys: 5, playlists: 7, entries: 8 };
const latin1 = new TextDecoder('latin1'), utf16 = new TextDecoder('utf-16le');

/** buf: export.pdb's bytes → { tracks, lists, entries }; paths are from the drive's root ("/Contents/…"). */
export function readPdb(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  const u16 = (o) => v.getUint16(o, true), u32 = (o) => v.getUint32(o, true);
  const pageLen = u32(4), tables = u32(8);
  const rows = (type) => {
    const out = [];
    for (let i = 0; i < tables; i++) {
      const t = 28 + i * 16;
      if (u32(t) !== type) continue;
      const last = u32(t + 12), seen = new Set();
      for (let page = u32(t + 8); !seen.has(page) && (page + 1) * pageLen <= buf.byteLength; page = u32(page * pageLen + 12)) {
        seen.add(page);
        const p = page * pageLen;
        if (u32(p + 8) === type && !(u8[p + 0x1b] & 0x40)) { // a data page of this table
          const small = u8[p + 0x18], large = u16(p + 0x22);
          const n = large > small && large !== 0x1fff ? large : small;
          for (let r = 0; r < n; r++) {
            const group = p + pageLen - Math.floor(r / 16) * 0x24, bit = r % 16;
            if ((u16(group - 4) >> bit) & 1) out.push(p + 0x28 + u16(group - 6 - bit * 2));
          }
        }
        if (page === last) break;
      }
    }
    return out;
  };
  // DeviceSQL strings: short ASCII (odd first byte holds the length), or long ASCII / UTF-16LE with a 4-byte header.
  const str = (at) => {
    const k = u8[at];
    if (k & 1) return latin1.decode(u8.subarray(at + 1, at + (k >> 1)));
    return (k === 0x90 ? utf16 : latin1).decode(u8.subarray(at + 4, at + u16(at + 1)));
  };
  const named = (type, idAt, nameAt) => new Map(rows(type).map((r) => [u32(r + idAt), str(r + nameAt)]));
  const artists = new Map(rows(T.artists).map((r) => [u32(r + 4), str(r + (u16(r) === 0x64 ? u16(r + 0x0a) : u8[r + 9]))]));
  const albums = new Map(rows(T.albums).map((r) => [u32(r + 12), str(r + (u16(r) === 0x84 ? u16(r + 0x16) : u8[r + 0x15]))]));
  const genres = named(T.genres, 0, 4), keys = named(T.keys, 0, 8);
  const s = (r, i) => str(r + u16(r + 0x5e + i * 2)); // the track row's i-th string
  return {
    tracks: rows(T.tracks).map((r) => ({
      id: u32(r + 0x48), title: s(r, 17), artist: artists.get(u32(r + 0x44)) || '', album: albums.get(u32(r + 0x40)) || '',
      genre: genres.get(u32(r + 0x3c)) || '', key: keys.get(u32(r + 0x20)) || '', bpm: u32(r + 0x38) / 100,
      duration: u16(r + 0x54), path: s(r, 20), anlz: s(r, 14),
    })),
    lists: rows(T.playlists).map((r) => ({
      parent: u32(r), seq: u32(r + 8), id: u32(r + 0x0c), folder: u32(r + 0x10) !== 0, name: str(r + 0x14),
    })),
    entries: rows(T.entries).map((r) => ({ seq: u32(r), track: u32(r + 4), list: u32(r + 8) })),
  };
}
