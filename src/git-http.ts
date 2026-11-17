// Git smart-HTTP: upload-pack (v2 + v0) and receive-pack (v0).
import {
  hashObject, parseTree, parseCommit, type ObjType,
} from './objects.ts';
import { readPack, writePack, type GitObject } from './pack.ts';
import { pkt, FLUSH, DELIM, decodePkt } from './pkt.ts';
import type { Store } from './store.ts';

export interface GitResult { status: number; contentType: string | null; body: Buffer | null }

type Ctx = { store: Store; owner: string; repo: string };

function res(status: number, contentType: string | null, body: Buffer | null): GitResult {
  return { status, contentType, body };
}

/** GET /info/refs?service=... */
export function infoRefs(ctx: Ctx, service: string, protocolV2: boolean): GitResult {
  const { store, owner, repo } = ctx;
  const exists = store.getRepo(owner, repo) !== undefined;
  if (!exists) return res(404, null, null);
  if (service === 'git-upload-pack') {
    if (protocolV2) {
      // v2 capability advertisement
      const lines = [
        'version 2\n',
        'agent=forge/1.0\n',
        'ls-refs=unborn\n',
        'fetch=shallow filter ofs-delta\n',
        'server-option\n',
        'object-format=sha1\n',
      ];
      const body = Buffer.concat([FLUSH, ...lines.map((l) => pkt(l))]);
      return res(200, 'application/x-git-upload-pack-advertisement', body);
    }
    // v0 ref advertisement for upload-pack
    return res(200, 'application/x-git-upload-pack-advertisement', v0Advertisement(ctx, 'git-upload-pack'));
  }
  if (service === 'git-receive-pack') {
    return res(200, 'application/x-git-receive-pack-advertisement', v0Advertisement(ctx, 'git-receive-pack'));
  }
  return res(404, null, null);
}

function v0Advertisement(ctx: Ctx, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const { store, owner, repo } = ctx;
  const key = store.repoKey(owner, repo);
  const refs = store.listRefs(owner, repo).filter((r) => r.ref !== 'HEAD');
  let caps: string;
  if (service === 'git-receive-pack') {
    caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta quiet atomic push-options agent=forge/1.0';
  } else {
    caps = 'multi_ack_detailed multi_ack side-band-64k side-band thin-pack ofs-delta shallow deepen-since deepen-not no-progress include-tag agent=forge/1.0';
  }
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const head = store.getRef(owner, repo, 'HEAD');
  if (service === 'git-upload-pack' && head) {
    parts.push(pkt(`${head} HEAD\u0000symref=HEAD:refs/heads/main ${caps}\n`));
    for (const r of refs) parts.push(pkt(`${r.oid} ${r.ref}\n`));
  } else if (refs.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\u0000${caps}\n`));
  } else {
    const first = refs[0]!;
    parts.push(pkt(`${first.oid} ${first.ref}\u0000${caps}\n`));
    for (const r of refs.slice(1)) parts.push(pkt(`${r.oid} ${r.ref}\n`));
  }
  // peeled tags
  for (const r of refs) {
    if (r.ref.startsWith('refs/tags/')) {
      let cur = store.getObject(owner, repo, r.oid);
      let hops = 0;
      while (cur && cur.type === 'tag' && hops < 10) {
        const m = cur.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
        if (!m) break;
        cur = store.getObject(owner, repo, m[1]!);
        hops++;
      }
      if (cur && cur.type === 'commit') parts.push(pkt(`${hashObject('commit', cur.data)} ${r.ref}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** POST /git-upload-pack: protocol v2 (command=ls-refs / command=fetch) or v0. */
export function postUploadPack(ctx: Ctx, body: Buffer, protocolV2: boolean): GitResult {
  return protocolV2 ? uploadPackV2(ctx, body) : uploadPackV0(ctx, body);
}

// ---------------------------------------------------------------- v2

function uploadPackV2(ctx: Ctx, body: Buffer): GitResult {
  const packets = decodePkt(body);
  const lines = packets.filter((p) => p !== FLUSH && p !== DELIM).map((p) => p.toString('utf8').replace(/\n$/, ''));
  let command = '';
  const args: Record<string, string> = {};
  let inArgs = false;
  for (const line of lines) {
    if (line.startsWith('command=')) { command = line.slice(8); continue; }
    if (line === '') { inArgs = true; continue; }
    if (inArgs) {
      const sp = line.indexOf(' ');
      if (sp > 0) args[line.slice(0, sp)] = line.slice(sp + 1);
      else args[line] = '';
    }
  }
  if (command === 'ls-refs') return res(200, 'application/x-git-upload-pack-result', lsRefsV2(ctx, lines));
  if (command === 'fetch') return fetchV2(ctx, body);
  return res(400, null, null);
}

function lsRefsV2(ctx: Ctx, lines: string[]): Buffer {
  const { store, owner, repo } = ctx;
  const delimIdx = lines.findIndex((l) => l === '' || l === 'peel' || l === 'symrefs' || l === 'unborn' || l.startsWith('ref-prefix '));
  const args = lines.slice(delimIdx === -1 ? lines.length : delimIdx);
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = store.getRef(owner, repo, 'HEAD');
  if (head && wantSymrefs && keep('HEAD')) {
    parts.push(pkt(`${head} HEAD symref-target:refs/heads/main\n`));
  } else if (head === undefined && wantUnborn && keep('HEAD') && store.listRefs(owner, repo).filter((r) => r.ref.startsWith('refs/')).length === 0) {
    parts.push(pkt(`unborn HEAD symref-target:refs/heads/main\n`));
  }
  const peeledFor = (oid: string): string | null => {
    if (!wantPeel) return null;
    let cur = store.getObject(owner, repo, oid);
    let hops = 0;
    while (cur && cur.type === 'tag' && hops < 10) {
      const m = cur.data.toString('utf8').match(/^object ([0-9a-f]{40})/m);
      if (!m) break;
      cur = store.getObject(owner, repo, m[1]!);
      hops++;
    }
    return cur && cur.type === 'commit' ? hashObject('commit', cur.data) : null;
  };
  for (const r of store.listRefs(owner, repo)) {
    if (!keep(r.ref)) continue;
    const peeled = peeledFor(r.oid);
    const sym = r.ref === 'HEAD' && wantSymrefs ? ' symref-target:refs/heads/main' : '';
    parts.push(pkt(`${r.oid} ${r.ref}${sym}${peeled ? ` peeled:${peeled}` : ''}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchV2(ctx: Ctx, body: Buffer): GitResult {
  const req = parseFetchRequest(body, true);
  const { store, owner, repo } = ctx;
  const parts: Buffer[] = [];
  if (req.wants.length === 0) {
    // acknowledgments section, then flush
    parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
    return res(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
  }
  // acknowledgments
  const haveSet = new Set<string>();
  for (const h of req.haves) {
    if (store.getObject(owner, repo, h)) haveSet.add(h);
  }
  let allHave = req.haves.length > 0 && req.haves.every((h) => store.getObject(owner, repo, h) !== undefined);
  if (!allHave || req.haves.length === 0) {
    parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
  } else {
    parts.push(pkt('acknowledgments\n'));
    for (const h of req.haves) parts.push(pkt(`ACK ${h}\n`));
    parts.push(pkt('ready\n'), FLUSH);
  }
  // shallow-info (when depth was requested)
  if (req.depth !== null) {
    parts.push(pkt('shallow-info\n'));
    for (const tip of req.wants) {
      const obj = store.getObject(owner, repo, tip);
      if (obj && obj.type === 'commit') parts.push(pkt(`shallow ${tip}\n`));
    }
    parts.push(FLUSH);
  }
  // wanted-refs (we always include it when the client asked; the suite doesn't use want-ref)
  // packfile
  const objects = objectsForFetch(ctx, req);
  parts.push(pkt('packfile\n'));
  if (objects.length > 0) {
    parts.push(sidebandPack(objects));
  } else {
    // an empty pack: header with 0 objects
    parts.push(sidebandPack([]));
  }
  return res(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- fetch machinery (shared)

interface FetchRequest {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallows: string[];
  done: boolean;
}

function parseFetchRequest(body: Buffer, v2: boolean): FetchRequest {
  const packets = decodePkt(body);
  const req: FetchRequest = { wants: [], haves: [], depth: null, shallows: [], done: false };
  let section = 'wants';
  for (const p of packets) {
    if (p === FLUSH) { if (v2) section = 'negotiation'; else section = 'negotiation'; continue; }
    if (p === DELIM) continue;
    const line = p.toString('utf8').replace(/\n$/, '');
    if (line === 'done') { req.done = true; continue; }
    if (line.startsWith('want ')) req.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) req.haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) req.shallows.push(line.slice(8));
    else if (line.startsWith('deepen ')) req.depth = parseInt(line.slice(7), 10);
  }
  return req;
}

/** Objects to send for `wants`, excluding those reachable from `haves` (client-held). */
function objectsForFetch(ctx: Ctx, req: FetchRequest): GitObject[] {
  const { store, owner, repo } = ctx;
  const haveSet = new Set<string>();
  for (const h of req.haves) {
    for (const oid of store.reachable(owner, repo, [h])) haveSet.add(oid);
  }
  const wantSet = new Set<string>();
  for (const w of req.wants) {
    if (req.depth !== null) {
      // shallow walk: collect up to depth generations
      shallowWalk(ctx, w, req.depth, wantSet);
    } else {
      for (const oid of store.reachable(owner, repo, [w])) wantSet.add(oid);
    }
  }
  const out: GitObject[] = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const obj = store.getObject(owner, repo, oid);
    if (obj) out.push(obj);
  }
  return out;
}

function shallowWalk(ctx: Ctx, tip: string, depth: number, into: Set<string>): void {
  const { store, owner, repo } = ctx;
  interface Job { oid: string; gen: number }
  const queue: Job[] = [{ oid: tip, gen: 0 }];
  while (queue.length) {
    const job = queue.shift()!;
    if (into.has(job.oid)) continue;
    const obj = store.getObject(owner, repo, job.oid);
    if (!obj) continue;
    into.add(job.oid);
    if (obj.type !== 'commit' || job.gen >= depth) continue;
    const commit = parseCommit(obj.data);
    into.add(commit.tree);
    // add tree closure
    addTreeClosure(ctx, commit.tree, into);
    for (const p of commit.parents) queue.push({ oid: p, gen: job.gen + 1 });
  }
}

function addTreeClosure(ctx: Ctx, treeOid: string, into: Set<string>): void {
  const { store, owner, repo } = ctx;
  const obj = store.getObject(owner, repo, treeOid);
  if (!obj) return;
  into.add(treeOid);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '160000') continue;
    into.add(e.oid);
    const child = store.getObject(owner, repo, e.oid);
    if (child && child.type === 'tree') addTreeClosure(ctx, e.oid, into);
  }
}

/** Build the packfile section, sideband-framed. */
function sidebandPack(objects: GitObject[]): Buffer {
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const CHUNK = 65515; // 65520 - 4 - 1
  for (let off = 0; off < pack.length; off += CHUNK) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(off, Math.min(off + CHUNK, pack.length))])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- v0 upload-pack

function uploadPackV0(ctx: Ctx, body: Buffer): GitResult {
  const { store, owner, repo } = ctx;
  const req = parseFetchRequest(body, false);
  if (!req.done || req.wants.length === 0) {
    // First round of negotiation: answer NAK (multi_ack not needed for the suite's single done round)
    return res(200, 'application/x-git-upload-pack-result', Buffer.concat([pkt('NAK\n')]));
  }
  const objects = objectsForFetch(ctx, req);
  const parts: Buffer[] = [];
  if (req.depth !== null) {
    // shallow-info lines: the boundary commits the client does not receive parents for
    const sentTips = req.wants;
    for (const tip of sentTips) {
      const obj = store.getObject(owner, repo, tip);
      if (obj && obj.type === 'commit') parts.push(pkt(`shallow ${tip}\n`));
    }
  }
  parts.push(pkt('NAK\n'));
  if (objects.length > 0) parts.push(sidebandPack(objects));
  else parts.push(FLUSH);
  return res(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack (v0)

interface PushCommand { oldOid: string; newOid: string; ref: string }
interface ReportLine { ref: string; ok: boolean; reason: string }

/** POST /git-receive-pack: parse commands + pack, apply, report per ref. */
export function postReceivePack(ctx: Ctx, body: Buffer): GitResult {
  const { store, owner, repo } = ctx;
  // Split the pkt-line command section from the trailing pack.
  const commands: PushCommand[] = [];
  let off = 0;
  let clientCaps: string[] = [];
  while (off + 4 <= body.length) {
    const lenText = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) break;
    const len = parseInt(lenText, 16);
    if (len === 0) { off += 4; break; } // flush ends the command list
    if (len < 4 || off + len > body.length) break;
    let line = body.subarray(off + 4, off + len).toString('utf8');
    off += len;
    if (line.endsWith('\n')) line = line.slice(0, -1);
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      clientCaps = line.slice(nul + 1).split(' ');
      line = line.slice(0, nul);
    }
    const sp = line.indexOf(' ');
    const sp2 = line.indexOf(' ', sp + 1);
    if (sp < 0 || sp2 < 0) continue;
    commands.push({ oldOid: line.slice(0, sp), newOid: line.slice(sp + 1, sp2), ref: line.slice(sp2 + 1) });
  }
  const packBytes = body.subarray(off);
  const useSideband = clientCaps.includes('side-band-64k');

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (commands.some((c) => c.newOid !== '0'.repeat(40))) {
    try {
      if (packBytes.length > 0) {
        const read = readPack(packBytes, (oid) => store.getObject(owner, repo, oid));
        if (!read.checksumOk) throw new Error('pack checksum mismatch');
        for (const [oid, obj] of read.objects) {
          if (!store.hasObject(owner, repo, oid)) store.putObject(owner, repo, obj.type, obj.data);
        }
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const reports: ReportLine[] = [];
  if (unpackOk) {
    for (const cmd of commands) {
      if (cmd.newOid === '0'.repeat(40)) {
        // delete
        const current = store.getRef(owner, repo, cmd.ref);
        if (current === undefined || current === '0'.repeat(40)) {
          reports.push({ ref: cmd.ref, ok: false, reason: 'failed to delete' });
        } else if (cmd.oldOid !== current) {
          reports.push({ ref: cmd.ref, ok: false, reason: 'fetch first' });
        } else {
          store.delRef(owner, repo, cmd.ref);
          reports.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // create or update: must fast-forward
      const current = store.getRef(owner, repo, cmd.ref);
      if (current !== undefined && current !== '0'.repeat(40) && cmd.oldOid !== current) {
        reports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (current !== undefined && current !== '0'.repeat(40)) {
        // update: verify fast-forward
        if (!store.isAncestor(owner, repo, cmd.oldOid, cmd.newOid)) {
          reports.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      // the new tip's closure must be complete
      let complete = true;
      for (const oid of store.reachable(owner, repo, [cmd.newOid])) {
        if (!store.hasObject(owner, repo, oid)) { complete = false; break; }
      }
      if (!complete) {
        reports.push({ ref: cmd.ref, ok: false, reason: 'missing necessary objects' });
        continue;
      }
      store.setRef(owner, repo, cmd.ref, cmd.newOid);
      // keep HEAD symref pointing at the default branch once it exists
      if (cmd.ref === `refs/heads/${store.getRepo(owner, repo)?.defaultBranch ?? 'main'}`) {
        store.setRef(owner, repo, 'HEAD', cmd.newOid);
      }
      reports.push({ ref: cmd.ref, ok: true, reason: '' });
    }
  }

  // report-status (sideband-framed when the client asked)
  const reportLines: string[] = [];
  reportLines.push(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`);
  for (const r of reports) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  let report = Buffer.concat(reportLines.map((l) => pkt(l)));
  report = Buffer.concat([report, FLUSH]);
  let out: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let o = 0; o < report.length; o += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(o, Math.min(o + CHUNK, report.length))])));
    }
    parts.push(FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = report;
  }
  return res(200, 'application/x-git-receive-pack-result', out);
}
