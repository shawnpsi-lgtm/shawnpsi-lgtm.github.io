// Just enough tag and analysis parsing for the browser: ID3v2 text frames, and from rekordbox's ANLZ0000 files the
// beat grid (PQTZ, in the .DAT) and the hot cues (PCOB in the .DAT, PCO2 with colours and comments in the .EXT).
// Layouts: https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html

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

/** The tagged sections of an ANLZ file: [{ tag, o, lenHeader, lenTag }] ('PMAI' header, big-endian). */
function sections(buf) {
  const v = new DataView(buf), out = [];
  if (buf.byteLength < 8 || v.getUint32(0) !== 0x504d4149) return out; // 'PMAI'
  let o = v.getUint32(4);
  while (o + 12 <= buf.byteLength) {
    const lenTag = v.getUint32(o + 8);
    out.push({ tag: v.getUint32(o), o, lenHeader: v.getUint32(o + 4), lenTag });
    if (!lenTag) break;
    o += lenTag;
  }
  return out;
}

/** Beat grid from an ANLZ0000.DAT: [{ beat (1-4 in the bar), bpm, time (s) }]. */
export function readPqtz(buf) {
  const v = new DataView(buf);
  const s = sections(buf).find((x) => x.tag === 0x5051545a); // 'PQTZ'
  if (!s) return [];
  const { o, lenHeader, lenTag } = s, n = v.getUint32(o + 20), grid = [];
  for (let i = 0, p = o + lenHeader; i < n && p + 8 <= o + lenTag; i++, p += 8) {
    grid.push({ beat: v.getUint16(p), bpm: v.getUint16(p + 2) / 100, time: v.getUint32(p + 4) / 1000 });
  }
  return grid;
}

const utf16be = new TextDecoder('utf-16be');

/**
 * Hot cues from an ANLZ0000.DAT (PCOB/PCPT) or .EXT (PCO2/PCP2, which adds the colour and comment):
 * [{ pad (0-7 = A-H), time (s), loop, color ('rgb(…)' or null for the default), comment }]. Memory cues are skipped.
 * Newer .EXT files carry a copy of the PCOB too: their PCO2 is used when there is one.
 */
export function readCues(buf) {
  const v = new DataView(buf), found = { pcob: [], pco2: [] };
  for (const { tag, o, lenHeader, lenTag } of sections(buf)) {
    const ext = tag === 0x50434f32; // 'PCO2'
    if (!ext && tag !== 0x50434f42) continue; // 'PCOB'
    if (v.getUint32(o + 12) !== 1) continue; // 0 = memory cues, 1 = hot cues
    const cues = ext ? found.pco2 : found.pcob;
    for (let p = o + lenHeader; p + 12 <= o + lenTag;) {
      const len = v.getUint32(p + 8);
      if (len < 12 || p + len > o + lenTag) break;
      const hot = v.getUint32(p + 12);
      if (hot >= 1 && hot <= 8 && len >= (ext ? 44 : 40) && !cues.some((c) => c.pad === hot - 1)) {
        const cue = { pad: hot - 1, loop: false, time: 0, color: null, comment: '' };
        if (ext) { // PCP2
          cue.loop = v.getUint8(p + 16) === 2;
          cue.time = v.getUint32(p + 20) / 1000;
          const colorId = v.getUint8(p + 28), lenComment = v.getUint32(p + 40), c = p + 44 + lenComment;
          if (lenComment >= 2 && c <= p + len) {
            cue.comment = utf16be.decode(new Uint8Array(buf, p + 44, lenComment)).replace(/\0.*$/s, '').trim();
          }
          if (colorId && c + 4 <= p + len) { // after the comment: colour code, then red, green, blue
            cue.color = `rgb(${v.getUint8(c + 1)}, ${v.getUint8(c + 2)}, ${v.getUint8(c + 3)})`;
          }
        } else { // PCPT
          cue.loop = v.getUint8(p + 28) === 2;
          cue.time = v.getUint32(p + 32) / 1000;
        }
        cues.push(cue);
      }
      p += len;
    }
  }
  return found.pco2.length ? found.pco2 : found.pcob;
}

/** "Artist - Title" file names, the common case when there are no tags. */
export function splitName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^(.+?)\s+[-–]\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base };
}
