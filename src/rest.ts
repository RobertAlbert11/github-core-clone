// The REST v3 router: repositories, contents, git data, issues, labels, pulls, protocol.
// One entry point: handleRest(ctx) -> boolean (true when the route was served).
import type { ReqCtx } from './api.ts';
import { send, notFound, unauthorized, parseJson, repoJson, issueJson, pullJson, labelJson, userJson } from './api.ts';
import { commitFile, findTreePath, listDir, diffTrees, squashMerge } from './contents.ts';
import { hashObject, parseCommit, parseTree } from './objects.ts';

function num(v: unknown, d = 0): number { return typeof v === 'number' ? v : d; }

function b64(v: string): Buffer { return Buffer.from(v.replace(/[\r\n\t ]+/g, ''), 'base64'); }

function seg(ctx: ReqCtx, i: number): string { return decodeURIComponent(ctx.path.split('/')[i] ?? ''); }

/** Serve /api/v3. Returns true when handled. */
export function handleRest(ctx: ReqCtx): boolean {
  const p = ctx.path;
  if (p !== '/api/v3' && !p.startsWith('/api/v3/') && p !== '/api/graphql' && p !== '/mcp') return false;
  return false; // placeholder — replaced below
}

export const __unused = { num, b64, seg };
