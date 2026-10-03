// Just enough tag and analysis parsing for the browser: ID3v2 text frames, and the beat grid (PQTZ) from a
// rekordbox ANLZ0000.DAT.

const TEXT = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre', TBPM: 'bpm', TKEY: 'key' };

function text(bytes) {
  const enc = bytes[0], body = bytes.subarray(1);
  let s;
  if (enc === 0) s = new TextDecoder('latin1').decode(body);
  else if (enc === 1) s = new TextDecoder(body[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(body.subarray(2));
  else if (enc === 2) s = new TextDecoder('utf-16be').decode(body);
  else s = new TextDecoder('utf-8').decode(body);
  return s.replace(/\0.*$/s, '').trim();
}

const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

/** ID3v2.3/2.4 tags from the start of an MP3 (or any file starting with an ID3 header). {} if there are none. */
export async function readId3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return {};
  const ver = head[3], size = synchsafe(head, 6);
  const b = new Uint8Array(await file.slice(10, 10 + Math.min(size, 1 << 20)).arrayBuffer());
  const tags = {};
  let o = head[5] & 0x40 ? 4 + (ver === 4 ? synchsafe(b, 0) - 4 : (b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3])) : 0;
  while (o + 10 <= b.length) {
    const id = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = ver === 4 ? synchsafe(b, o + 4) : (b[o + 4] << 24 | b[o + 5] << 16 | b[o + 6] << 8 | b[o + 7]);
    if (TEXT[id] && len > 1) tags[TEXT[id]] = text(b.subarray(o + 10, o + 10 + len));
    o += 10 + len;
  }
  if (tags.bpm) tags.bpm = parseFloat(tags.bpm) || undefined;
  return tags;
}

/** Beat grid from an ANLZ0000.DAT: [{ beat (1-4 in the bar), bpm, time (s) }]. */
export function readPqtz(buf) {
  const v = new DataView(buf);
  if (v.getUint32(0) !== 0x504d4149) return []; // 'PMAI'
  let o = v.getUint32(4);
  while (o + 12 <= buf.byteLength) {
    const tag = v.getUint32(o), lenHeader = v.getUint32(o + 4), lenTag = v.getUint32(o + 8);
    if (tag === 0x5051545a) { // 'PQTZ'
      const n = v.getUint32(o + 20), grid = [];
      for (let i = 0, p = o + lenHeader; i < n && p + 8 <= o + lenTag; i++, p += 8) {
        grid.push({ beat: v.getUint16(p), bpm: v.getUint16(p + 2) / 100, time: v.getUint32(p + 4) / 1000 });
      }
      return grid;
    }
    if (!lenTag) break;
    o += lenTag;
  }
  return [];
}

/** "Artist - Title" file names, the common case when there are no tags. */
export function splitName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base };
}
