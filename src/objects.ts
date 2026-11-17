// Git object model: hashing, parsing and building (no git binary).
import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);
export const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(v: string): boolean { return HEX40.test(v); }

export function hashObject(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export function objData(type: ObjType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\u0000`, 'utf8'), data]);
}

export interface TreeEntry { mode: string; name: string; oid: string }

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return Buffer.compare(Buffer.from(an), Buffer.from(bn));
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'tree') tree = val;
    else if (key === 'parent') parents.push(val);
    else if (key === 'author') author = val;
    else if (key === 'committer') committer = val;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(f: { tree: string; parents?: string[]; message: string; author: string; committer?: string; timestamp?: number; tz?: string }): Buffer {
  const ts = f.timestamp ?? 1700000000;
  const tz = f.tz ?? '+0000';
  const who = `${f.author} ${ts} ${tz}`;
  const lines = [`tree ${f.tree}`];
  for (const p of f.parents ?? []) lines.push(`parent ${p}`);
  lines.push(`author ${who}`, `committer ${f.committer ?? f.author} ${ts} ${tz}`, '');
  return Buffer.from(`${lines.join('\n')}\n${f.message}`, 'utf8');
}
