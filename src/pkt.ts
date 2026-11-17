// pkt-line codec and smart-HTTP framing helpers.
export const PKT_MAX = 65520;
export const PKT_MAX_PAYLOAD = PKT_MAX - 4;

export function pkt(payload: string | Buffer): Buffer {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

/** Decode all pkt-lines from a buffer; returns data payloads (raw bytes). */
export function decodePkt(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenText = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break; // raw trailing bytes (e.g. v0 pack without sideband)
    const len = parseInt(lenText, 16);
    if (len === 0) { out.push(FLUSH); off += 4; continue; }
    if (len === 1) { out.push(DELIM); off += 4; continue; }
    if (len === 2) { off += 4; continue; } // response-end
    if (len > PKT_MAX || off + len > buf.length) break;
    out.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return out;
}
