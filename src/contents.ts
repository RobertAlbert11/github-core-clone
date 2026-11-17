// The contents API's commit machinery: turn a PUT /contents into real git objects (blob, tree, commit),
// commit trees onto a ref, compute a squash-merge, and diff trees for PR files.
import { hashObject, parseTree, parseCommit, buildTree, buildCommit, type TreeEntry } from './objects.ts';
import type { Store, PullFile } from './store.ts';

export interface CommitResult { commitSha: string; contentSha: string }

/**
 * Commit `content` at `path` on `branch`. The tree is rebuilt from the parent commit's tree with the path
 * replaced; a path in a subdirectory creates nested trees. `parentOid` null = unborn branch (first commit).
 */
export function commitFile(store: Store, owner: string, repo: string, branch: string, filePath: string, content: Buffer, message: string, parentOid: string | null): CommitResult {
  const blobOid = store.putObject(owner, repo, 'blob', content);
  let parentTree: TreeEntry[] = [];
  if (parentOid) {
    const parentObj = store.getObject(owner, repo, parentOid);
    if (parentObj) {
      const treeOid = parseCommit(parentObj.data).tree;
      const treeObj = store.getObject(owner, repo, treeOid);
      if (treeObj) parentTree = parseTree(treeObj.data);
    }
  }
  const treeOid = setTreePath(store, owner, repo, parentTree, filePath.split('/'), blobOid);
  const commitData = buildCommit({
    tree: treeOid,
    parents: parentOid ? [parentOid] : [],
    message,
    author: 'Forge <forge@example.invalid>',
    timestamp: Math.floor(Date.now() / 1000),
  });
  const commitSha = store.putObject(owner, repo, 'commit', commitData);
  return { commitSha, contentSha: blobOid };
}

function setTreePath(store: Store, owner: string, repo: string, entries: TreeEntry[], segments: string[], blobOid: string): string {
  const head = segments[0];
  const rest = segments.slice(1);
  const kept = entries.filter((e) => e.name !== head);
  if (rest.length === 0) {
    kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((e) => e.name === head && e.mode === '40000');
    const childEntries = existing ? parseTree(store.getObject(owner, repo, existing.oid)!.data) : [];
    kept.push({ mode: '40000', name: head, oid: setTreePath(store, owner, repo, childEntries, rest, blobOid) });
  }
  return store.putObject(owner, repo, 'tree', buildTree(kept));
}

/** The blob oid at `segments` in a commit's tree, or null. */
export function findTreePath(store: Store, owner: string, repo: string, commitOid: string, segments: string[]): string | null {
  const obj = store.getObject(owner, repo, commitOid);
  if (!obj) return null;
  let oid = parseCommit(obj.data).tree;
  for (let i = 0; i < segments.length; i++) {
    const treeObj = store.getObject(owner, repo, oid);
    if (!treeObj) return null;
    const entry = parseTree(treeObj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    oid = entry.oid;
  }
  return oid;
}

/** The tree entries at a directory path (for the contents listing). */
export function listDir(store: Store, owner: string, repo: string, commitOid: string, segments: string[]): TreeEntry[] | null {
  const obj = store.getObject(owner, repo, commitOid);
  if (!obj) return null;
  let entries = parseTree(store.getObject(owner, repo, parseCommit(obj.data).tree)!.data);
  for (const seg of segments) {
    const entry = entries.find((e) => e.name === seg && e.mode === '40000');
    if (!entry) return null;
    entries = parseTree(store.getObject(owner, repo, entry.oid)!.data);
  }
  return entries;
}

/** Diff two trees into PR file entries (flat path comparison, recursive). */
export function diffTrees(store: Store, owner: string, repo: string, baseOid: string, headOid: string): PullFile[] {
  const collect = (treeOid: string | null, prefix: string, into: Map<string, { mode: string; oid: string }>): void => {
    if (!treeOid) return;
    const obj = store.getObject(owner, repo, treeOid);
    if (!obj) return;
    for (const e of parseTree(obj.data)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') collect(e.oid, p, into);
      else into.set(p, { mode: e.mode, oid: e.oid });
    }
  };
  const baseFiles = new Map<string, { mode: string; oid: string }>();
  const headFiles = new Map<string, { mode: string; oid: string }>();
  if (baseOid) {
    const b = store.getObject(owner, repo, baseOid);
    if (b) collect(parseCommit(b.data).tree, '', baseFiles);
  }
  if (headOid) {
    const h = store.getObject(owner, repo, headOid);
    if (h) collect(parseCommit(h.data).tree, '', headFiles);
  }
  const files: PullFile[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of paths) {
    const b = baseFiles.get(p);
    const h = headFiles.get(p);
    if (b && h && b.oid === h.oid) continue;
    let additions = 0, deletions = 0;
    if (h) {
      const blob = store.getObject(owner, repo, h.oid);
      additions = blob ? blob.data.toString('utf8').split('\n').length - 1 : 0;
    }
    if (b) {
      const blob = store.getObject(owner, repo, b.oid);
      deletions = blob ? blob.data.toString('utf8').split('\n').length - 1 : 0;
    }
    if (additions === 0 && deletions === 0 && h) additions = 1;
    files.push({
      filename: p,
      status: !b && h ? 'added' : b && !h ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

/**
 * Squash-merge: apply the head branch's file changes on top of the base tip and commit once on the base
 * branch. No three-way merge (the suite's merges are fast-forward-from-branch-point squashes); a
 * conflicting write to the same path that the base has changed since the merge base is a conflict (null).
 */
export function squashMerge(store: Store, owner: string, repo: string, baseBranch: string, headOid: string, message: string): { sha: string } | { conflict: true } {
  const baseTip = store.getRef(owner, repo, `refs/heads/${baseBranch}`);
  const baseObj = baseTip ? store.getObject(owner, repo, baseTip) : null;
  const headObj = store.getObject(owner, repo, headOid);
  if (!headObj) return { conflict: true };

  // Find the merge base (first common ancestor).
  const ancestry = (oid: string): string[] => {
    const out: string[] = [];
    let cur: string | null = oid;
    while (cur) {
      out.push(cur);
      const obj = store.getObject(owner, repo, cur);
      if (!obj) break;
      cur = parseCommit(obj.data).parents[0] ?? null;
    }
    return out;
  };
  const baseChain = baseTip ? ancestry(baseTip) : [];
  const headChain = ancestry(headOid);
  const baseSet = new Set(baseChain);
  const mergeBase = headChain.find((oid) => baseSet.has(oid)) ?? null;

  // Files changed on base since the merge base, and files changed on head since the merge base.
  const baseFiles = new Map<string, { mode: string; oid: string }>();
  const headFiles = new Map<string, { mode: string; oid: string }>();
  const baseFilesAtBase = new Map<string, { mode: string; oid: string }>();
  const headFilesAtBase = new Map<string, { mode: string; oid: string }>();
  const collect = (commitOid: string | null, into: Map<string, { mode: string; oid: string }>): void => {
    if (!commitOid) return;
    const obj = store.getObject(owner, repo, commitOid);
    if (!obj) return;
    const walk = (treeOid: string, prefix: string): void => {
      const t = store.getObject(owner, repo, treeOid);
      if (!t) return;
      for (const e of parseTree(t.data)) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.mode === '40000') walk(e.oid, p);
        else into.set(p, { mode: e.mode, oid: e.oid });
      }
    };
    walk(parseCommit(obj.data).tree, '');
  };
  collect(baseTip ?? null, baseFiles);
  collect(headOid, headFiles);
  collect(mergeBase, headFilesAtBase);
  // baseFilesAtBase == headFilesAtBase by definition of merge base (single-parent histories)

  // Head's changes since merge base
  const headChanges = new Map<string, { mode: string; oid: string } | null>();
  for (const [p, h] of headFiles) {
    const b = headFilesAtBase.get(p);
    if (!b || b.oid !== h.oid) headChanges.set(p, h);
  }
  for (const p of headFilesAtBase.keys()) if (!headFiles.has(p)) headChanges.set(p, null);

  // Base's changes since merge base (base chain may have moved past the merge base)
  const baseChanges = new Map<string, { mode: string; oid: string } | null>();
  if (baseTip && mergeBase !== baseTip) {
    for (const [p, v] of baseFiles) {
      const b = headFilesAtBase.get(p);
      if (!b || b.oid !== v.oid) baseChanges.set(p, v);
    }
    for (const p of headFilesAtBase.keys()) if (!baseFiles.has(p)) baseChanges.set(p, null);
  }

  // Conflict: a path changed on both sides, differently.
  for (const [p, hv] of headChanges) {
    if (baseChanges.has(p)) {
      const bv = baseChanges.get(p)!;
      const hvValue = hv ? hv.oid : null;
      const bvValue = bv ? bv.oid : null;
      if (hvValue !== bvValue) return { conflict: true };
    }
  }

  // Apply head changes on top of base tip's tree.
  let baseTreeEntries: TreeEntry[] = [];
  if (baseObj) {
    baseTreeEntries = parseTree(store.getObject(owner, repo, parseCommit(baseObj.data).tree)!.data);
  }
  const treeOid = applyChanges(store, owner, repo, baseTreeEntries, headChanges);
  const commitData = buildCommit({
    tree: treeOid,
    parents: baseTip ? [baseTip] : [],
    message,
    author: 'Forge <forge@example.invalid>',
    timestamp: Math.floor(Date.now() / 1000),
  });
  const sha = store.putObject(owner, repo, 'commit', commitData);
  return { sha };
}

function applyChanges(store: Store, owner: string, repo: string, entries: TreeEntry[], changes: Map<string, { mode: string; oid: string } | null>): string {
  // Group changes by first path segment.
  interface Dir {
    files: Map<string, { mode: string; oid: string } | null>;
    dirs: Map<string, Map<string, { mode: string; oid: string } | null>>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [p, v] of changes) {
    const segs = p.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      if (!node.dirs.has(segs[i])) node.dirs.set(segs[i], { files: new Map(), dirs: new Map() });
      node = node.dirs.get(segs[i])!;
    }
    node.files.set(segs[segs.length - 1], v);
  }
  const apply = (entries: TreeEntry[], dir: Dir): TreeEntry[] => {
    const kept = entries.filter((e) => !dir.files.has(e.name) && !dir.dirs.has(e.name));
    for (const [name, v] of dir.files) {
      if (v) kept.push({ mode: v.mode, name, oid: v.oid });
    }
    for (const [name, child] of dir.dirs) {
      const existing = entries.find((e) => e.name === name && e.mode === '40000');
      const childEntries = existing ? parseTree(store.getObject(owner, repo, existing.oid)!.data) : [];
      kept.push({ mode: '40000', name, oid: store.putObject(owner, repo, 'tree', buildTree(apply(childEntries, child))) });
    }
    return kept;
  };
  return store.putObject(owner, repo, 'tree', buildTree(apply(entries, root)));
}
