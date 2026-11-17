// The forge's in-memory + fs-backed store: repos, git objects, refs, issues, pulls, labels, comments.
import * as fs from 'node:fs';

import { createHash } from 'node:crypto';
import { hashObject, parseTree, parseCommit, isOid, ZERO_OID, type ObjType } from './objects.ts';
import type { GitObject } from './pack.ts';

export interface RepoRec {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface LabelRec { name: string; color: string }

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface CommentRec { id: number; body: string; createdAt: string }

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  files: PullFile[];
}
export interface PullFile { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }

const FILE_LIMIT = 2000; // per-repo cap on stored objects, enough for the suite

export class Store {
  root: string;
  login: string;
  repos = new Map<string, RepoRec>();
  objects = new Map<string, Map<string, GitObject>>();
  refs = new Map<string, Map<string, string>>();
  labels = new Map<string, Map<string, LabelRec>>();
  issues = new Map<string, IssueRec[]>();
  pulls = new Map<string, PullRec[]>();
  comments = new Map<string, Map<number, CommentRec[]>>();
  nextRepoId = 5000;
  nextIssueId = 100000;
  nextCommentId = 1;
  nextNodeId = 1;

  constructor(root: string, login: string) {
    this.root = root;
    this.login = login;
    fs.mkdirSync(root, { recursive: true });
  }

  setLogin(login: string) { this.login = login; }

  repoKey(owner: string, name: string): string { return `${owner}/${name}`; }

  createRepo(name: string, opts: { description?: string; priv?: boolean; defaultBranch?: string; id?: number }): RepoRec {
    const key = this.repoKey(this.login, name);
    const now = new Date().toISOString();
    const rec: RepoRec = {
      id: opts.id ?? this.nextRepoId++,
      name,
      owner: this.login,
      description: opts.description ?? '',
      private: opts.priv ?? false,
      defaultBranch: opts.defaultBranch ?? 'main',
      createdAt: now,
      updatedAt: now,
    };
    this.repos.set(key, rec);
    this.objects.set(key, new Map());
    this.refs.set(key, new Map());
    this.labels.set(key, new Map());
    this.issues.set(key, []);
    this.pulls.set(key, []);
    this.comments.set(key, new Map());
    return rec;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    if (owner !== this.login) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.login) return false;
    const key = this.repoKey(owner, name);
    const had = this.repos.has(key);
    this.repos.delete(key);
    this.objects.delete(key);
    this.refs.delete(key);
    this.labels.delete(key);
    this.issues.delete(key);
    this.pulls.delete(key);
    this.comments.delete(key);
    return had;
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  putObject(owner: string, name: string, type: ObjType, data: Buffer): string {
    const objs = this.objects.get(this.repoKey(owner, name));
    if (!objs) throw new Error(`no repo ${owner}/${name}`);
    const oid = hashObject(type, data);
    if (!objs.has(oid)) objs.set(oid, { type, data });
    return oid;
  }

  getObject(owner: string, name: string, oid: string): GitObject | undefined {
    return this.objects.get(this.repoKey(owner, name))?.get(oid);
  }

  getRef(owner: string, name: string, ref: string): string | undefined {
    return this.refs.get(this.repoKey(owner, name))?.get(ref);
  }

  setRef(owner: string, name: string, ref: string, oid: string): void {
    const refs = this.refs.get(this.repoKey(owner, name));
    if (refs) refs.set(ref, oid);
  }

  delRef(owner: string, name: string, ref: string): void {
    this.refs.get(this.repoKey(owner, name))?.delete(ref);
  }

  listRefs(owner: string, name: string): Array<{ ref: string; oid: string }> {
    const refs = this.refs.get(this.repoKey(owner, name));
    return refs ? [...refs.entries()].map(([ref, oid]) => ({ ref, oid })) : [];
  }

  /** Every object reachable from tips (commit->tree+parents, tree->entries, tag->target). */
  reachable(owner: string, name: string, tips: Iterable<string>): Set<string> {
    const objs = this.objects.get(this.repoKey(owner, name))!;
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const tip of tips) if (isOid(tip)) queue.push(tip);
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const obj = objs.get(oid);
      if (!obj) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) {
          if (e.mode === '160000') continue;
          queue.push(e.oid);
        }
      }
    }
    return seen;
  }

  hasObject(owner: string, name: string, oid: string): boolean {
    return this.objects.get(this.repoKey(owner, name))?.has(oid) ?? false;
  }

  isAncestor(owner: string, name: string, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const objs = this.objects.get(this.repoKey(owner, name))!;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = objs.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (oid === ancestor) return true;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return false;
  }

  nextNodeId(): string {
    // opaque Relay-style global id, stable per object
    return Buffer.from(`R_${this.nextNodeId++}`).toString('base64');
  }

  /** A stable node id for a named object (used by GraphQL and re-derived on every read). */
  nodeIdFor(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`).toString('base64');
  }

  // ---- issues -------------------------------------------------------------

  createIssue(owner: string, name: string, input: { title: string; body?: string; labels?: string[] }): IssueRec {
    const key = this.repoKey(owner, name);
    const list = this.issues.get(key)!;
    const now = new Date().toISOString();
    const rec: IssueRec = {
      id: this.nextIssueId++,
      number: list.length + 1,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: input.labels ?? [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    list.push(rec);
    return rec;
  }

  getIssue(owner: string, name: string, number: number): IssueRec | undefined {
    return this.issues.get(this.repoKey(owner, name))?.find((i) => i.number === number);
  }

  listIssues(owner: string, name: string): IssueRec[] {
    return this.issues.get(this.repoKey(owner, name)) ?? [];
  }

  addComment(owner: string, name: string, issueNumber: number, body: string): CommentRec {
    const rec: CommentRec = { id: this.nextCommentId++, body, createdAt: new Date().toISOString() };
    const map = this.comments.get(this.repoKey(owner, name))!;
    const list = map.get(issueNumber) ?? [];
    list.push(rec);
    map.set(issueNumber, list);
    return rec;
  }

  listComments(owner: string, name: string, issueNumber: number): CommentRec[] {
    return this.comments.get(this.repoKey(owner, name))?.get(issueNumber) ?? [];
  }

  // ---- pulls --------------------------------------------------------------

  createPull(owner: string, name: string, input: { title: string; body?: string; head: string; base: string }): PullRec {
    const key = this.repoKey(owner, name);
    const list = this.pulls.get(key)!;
    const now = new Date().toISOString();
    const rec: PullRec = {
      id: 300000 + this.nextRepoId++,
      number: list.length + 1,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      merged: false,
      head: input.head,
      base: input.base,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      mergedAt: null,
      files: [],
    };
    list.push(rec);
    return rec;
  }

  getPull(owner: string, name: string, number: number): PullRec | undefined {
    return this.pulls.get(this.repoKey(owner, name))?.find((p) => p.number === number);
  }

  listPulls(owner: string, name: string): PullRec[] {
    return this.pulls.get(this.repoKey(owner, name)) ?? [];
  }
}
