// The REST v3 API surface: repositories, contents, issues, labels, pulls, protocol.
// Serves the suite's /api/v3 checks from the in-memory store.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, IssueRec, PullRec, RepoRec } from './store.ts';
import { commitFile, findTreePath, listDir, diffTrees, squashMerge } from './contents.ts';
import { parseCommit } from './objects.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

export interface ReqCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
  path: string;
  store: Store;
  token: string;
  query: URLSearchParams;
  bodyText: string;
}

let reqCounter = 0;
function reqId(): string {
  reqCounter += 1;
  return `${Date.now().toString(16)}${(reqCounter % 0xffff).toString(16).padStart(4, '0')}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')}`;
}

function send(ctx: ReqCtx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': reqId(),
    ...headers,
  });
  ctx.res.end(text);
}

function notFound(ctx: ReqCtx): void { send(ctx, 404, { message: 'Not Found' }); }
function unauthorized(ctx: ReqCtx): void { send(ctx, 401, { message: 'Requires authentication' }); }

function parseJson(ctx: ReqCtx): Record<string, unknown> | null {
  const t = ctx.bodyText.trim();
  if (t === '') return {};
  try {
    const v = JSON.parse(t);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    return v as Record<string, unknown>;
  } catch {
    return null;
  }
}

function str(v: unknown, d = ''): string { return typeof v === 'string' ? v : d; }

// ---- JSON views -------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return {
    login, id: 1000, type: 'User', site_admin: false,
    avatar_url: '', html_url: '', url: '', name: login,
  };
}

function repoJson(store: Store, rec: RepoRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: store.nodeIdFor('repo', `${rec.owner}/${rec.name}`),
    name: rec.name,
    full_name: `${rec.owner}/${rec.name}`,
    private: rec.private,
    owner: userJson(rec.owner),
    html_url: '',
    description: rec.description,
    fork: false,
    url: '',
    default_branch: rec.defaultBranch,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    pushed_at: rec.updatedAt,
    size: 0,
    has_issues: true,
    archived: false,
    disabled: false,
    visibility: rec.private ? 'private' : 'public',
  };
}

function labelJson(name: string): Record<string, unknown> {
  return { id: name.length * 7 + 1, node_id: name, name, color: 'ededed', default: false };
}

function issueJson(store: Store, rec: IssueRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: store.nodeIdFor('issue', `${rec.number}`),
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: rec.labels.map((l) => labelJson(l)),
    user: userJson(store.login),
    comments: 0,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    closed_at: rec.closedAt,
    html_url: '',
    url: '',
  };
}

function refTip(store: Store, owner: string, name: string, branch: string): string {
  return store.getRef(owner, name, `refs/heads/${branch}`) ?? '';
}

function pullJson(store: Store, owner: string, name: string, rec: PullRec): Record<string, unknown> {
  return {
    id: rec.id,
    node_id: store.nodeIdFor('pull', `${rec.number}`),
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    merged: rec.merged,
    merged_at: rec.mergedAt,
    closed_at: rec.state === 'closed' ? (rec.mergedAt ?? rec.updatedAt) : null,
    merge_commit_sha: rec.mergeCommitSha,
    head: { ref: rec.head, sha: refTip(store, owner, name, rec.head), label: rec.head },
    base: { ref: rec.base, sha: refTip(store, owner, name, rec.base), label: rec.base },
    user: userJson(store.login),
    draft: false,
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    html_url: '',
    url: '',
  };
}

export { repoJson, issueJson, pullJson, userJson, send, notFound, unauthorized, parseJson, str };
