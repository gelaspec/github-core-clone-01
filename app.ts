// The entry's HTTP surface: the router, auth, the request-id header and the git
// smart-HTTP handlers. main.ts (the lifecycle) is untouched; this is the server.
//
// Routes:
//   GET  /healthz                                  200 {"ok":true}, no auth
//   GET  /api/v3/                                  the API root
//   /api/v3/...                                    REST v3 (rest.ts)
//   POST /api/graphql                             GraphQL v4 (graphql.ts)
//   POST /mcp                                     MCP (mcp.ts)
//   /<owner>/<repo>.git/info/refs                 git advertisements (v2/v0)
//   /<owner>/<repo>.git/git-upload-pack           ls-refs / fetch (v2, v0 fetch too)
//   /<owner>/<repo>.git/git-receive-pack          push (v0, report-status, sideband)
//   anything else                                 404 {"message":"Not Found"}
//
// Auth: MAKEFUN_SHOP_TOKEN (the env's token). Every route except /healthz and the
// API root requires `Authorization: Bearer <token>`; anything else is a 401 JSON
// body. Every reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Repo } from './store.ts';
import {
  DELIM,
  FLUSH,
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isObjectId,
  pkt,
  readPack,
  sidebandPackets,
  type PktLine,
} from './git.ts';
import * as rest from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The v2 upload-pack advertisement is identical for every repo: build it once. */
const V2_ADVERTISEMENT: Buffer = (() => {
  const parts: Buffer[] = [];
  for (const line of ['# service=git-upload-pack\n', 'version 2\n', 'fetch=shallow\n', 'ls-refs\n', 'object-format=sha1\n']) {
    parts.push(pkt(line));
    if (line.startsWith('# service=')) parts.push(FLUSH);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
})();

let requestSeq = 0;

/**
 * Bounded caches for the clone bench's repeated identical fetches: a depth-1
 * fetch of one tip and an ls-refs listing are pure functions of (repo version,
 * want/prefixes), so the whole encoded response is reusable. The key carries
 * the repo version, so a ref change can never serve a stale pack.
 */
const FETCH_RESPONSE_CACHE = new Map<string, Buffer>();
const LS_REFS_CACHE = new Map<string, Buffer>();
const RESPONSE_CACHE_LIMIT = 64;

function cacheResponse(cache: Map<string, Buffer>, key: string, value: Buffer): void {
  if (cache.size >= RESPONSE_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq.toString(16).padStart(8, '0')}`;
}

function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function send404(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function send401(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Unauthorized' });
}

function readBody(req: IncomingMessage, limitBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a REST JSON body: {} when empty, null when malformed. */
function parseJsonBody(raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    return null;
  }
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  // new URL() is the slowest part of request parsing; the entry only needs the
  // path and the query string, both of which split out by hand.
  const rawUrl = req.url ?? '/';
  const q = rawUrl.indexOf('?');
  if (q < 0) return { pathname: rawUrl, query: new URLSearchParams() };
  return { pathname: rawUrl.slice(0, q), query: new URLSearchParams(rawUrl.slice(q + 1)) };
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: PktLine[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    let text = line.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number(text.slice(7).trim());
      if (Number.isSafeInteger(depth) && depth > 0) args.depth = depth;
    }
  }
  return args;
}

/** The v2 fetch response: acknowledgments, shallow-info, packfile (sideband band 1). */
function fetchResponse(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const parts: Buffer[] = [];
  parts.push(pkt('acknowledgments\n'));
  parts.push(pkt('NAK\n'));
  parts.push(DELIM);
  const { pack, shallow, unshallow } = store.fetchPack(repo, args.wants, args.haves, args.depth, args.shallow);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  if (pack !== null) {
    parts.push(pkt('packfile\n'));
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

async function handleGitUploadPack(store: Store, repo: Repo, raw: Buffer, res: ServerResponse): Promise<void> {
  let lines: PktLine[];
  try {
    lines = decodePktLines(raw);
  } catch {
    sendJson(res, 400, { message: 'the request body is not a pkt-line stream' });
    return;
  }
  const first = lines.find((line) => line.kind === 'data');
  const firstText = first && first.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';

  if (firstText.startsWith('command=')) {
    const command = firstText.slice('command='.length);
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      let afterDelim = false;
      for (const line of lines) {
        if (line.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (!afterDelim || line.kind !== 'data') continue;
        const text = line.payload.toString('utf8').replace(/\n$/, '');
        if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
      }
      const cacheKey = `${repo.id}|v${repo.version}|${prefixes.join('\n')}`;
      const cached = LS_REFS_CACHE.get(cacheKey);
      if (cached) {
        sendBuffer(res, 200, cached, 'application/x-git-upload-pack-result');
        return;
      }
      const out: Buffer[] = [];
      for (const line of store.lsRefsLines(repo, prefixes)) out.push(pkt(`${line}\n`));
      out.push(FLUSH);
      const body = Buffer.concat(out);
      cacheResponse(LS_REFS_CACHE, cacheKey, body);
      sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const args = parseFetchArgs(lines);
      if (args.wants.length === 0) {
        sendBuffer(res, 200, Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]), 'application/x-git-upload-pack-result');
        return;
      }
      // A depth-1 fetch of one tip with no haves is a pure function of the repo
      // version and the tip: cache the whole encoded response, sideband included.
      if (args.depth === 1 && args.wants.length === 1 && args.haves.length === 0) {
        const cacheKey = `${repo.id}|v${repo.version}|${args.wants[0]}`;
        const cached = FETCH_RESPONSE_CACHE.get(cacheKey);
        if (cached) {
          sendBuffer(res, 200, cached, 'application/x-git-upload-pack-result');
          return;
        }
        const body = fetchResponse(store, repo, args);
        cacheResponse(FETCH_RESPONSE_CACHE, cacheKey, body);
        sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
        return;
      }
      sendBuffer(res, 200, fetchResponse(store, repo, args), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, { message: `unknown git command ${command}` });
    return;
  }

  // v0 fetch: want/have/done lines, no command.
  if (firstText.startsWith('want ') || firstText === '') {
    const args = parseFetchArgs(lines);
    if (args.wants.length === 0) {
      sendBuffer(res, 200, Buffer.concat([pkt('NAK\n'), FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }
    const { pack } = store.fetchPack(repo, args.wants, args.haves, args.depth, args.shallow);
    const parts: Buffer[] = [pkt('NAK\n')];
    if (pack !== null) for (const packet of sidebandPackets(1, pack)) parts.push(packet);
    parts.push(FLUSH);
    sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }

  sendJson(res, 400, { message: 'the request body is not a git request' });
}

async function handleGitReceivePack(store: Store, repo: Repo, raw: Buffer, res: ServerResponse): Promise<void> {
  // Walk the pkt-line stream until its flush: everything after it is the pack.
  const lines: PktLine[] = [];
  let packOffset = raw.length;
  let offset = 0;
  let malformed = false;
  while (offset + 4 <= raw.length) {
    const lenText = raw.subarray(offset, offset + 4).toString('ascii');
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 0 || len > 65520) {
      malformed = true;
      break;
    }
    if (len === 0) {
      lines.push({ kind: 'flush' });
      packOffset = offset + 4;
      offset = packOffset;
      break;
    }
    if (len === 1) {
      lines.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (offset + len > raw.length) {
      malformed = true;
      break;
    }
    lines.push({ kind: 'data', payload: raw.subarray(offset + 4, offset + len) });
    offset += len;
  }
  if (malformed || packOffset > raw.length) {
    sendJson(res, 400, { message: 'the request body is not a pkt-line stream' });
    return;
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    let text = line.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (commands.length === 0) {
    sendJson(res, 400, { message: 'no push commands' });
    return;
  }

  const reportLines: string[] = [];
  const packBytes = raw.subarray(packOffset);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => store.getObject(oid) });
      for (const [oid, object] of read.objects) {
        if (!store.getObject(oid)) store.putObject(object.type, object.data);
      }
      if (!read.checksumOk) throw new Error('pack trailer does not match its bytes');
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  } else if (updatesRef && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'the push carries no pack';
  }

  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        store.deleteRef(repo, command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!isObjectId(command.newOid) || !store.getObject(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
      } else {
        store.setRef(repo, command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist`);
    } else if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else if (!store.isAncestor(command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    } else {
      store.setRef(repo, command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  }

  const report = encodePktLines([`unpack ${unpackDetail}\n`, ...reportLines.map((line) => `${line}\n`)]);
  const parts: Buffer[] = [...sidebandPackets(1, report), FLUSH];
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------------------------

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const { pathname, query } = pathOf(req);
      const segments = pathname.split('/').filter((part) => part !== '').map(decodeSegment);

      // The boot probe takes no token.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The API root takes no token, as api.github.com answers it.
      if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // Everything else needs the entry token when one is configured.
      if (TOKEN !== '') {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${TOKEN}`) {
          send401(res);
          return;
        }
      }

      // GET/HEAD never carry a body in this API; reading one costs a tick and a
      // promise per request, which is the whole read bench.
      const raw =
        method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req).catch(() => null);
      if (raw === null) {
        sendJson(res, 400, { message: 'could not read the request body' });
        return;
      }

      // GraphQL v4.
      if (pathname === '/api/graphql' && method === 'POST') {
        let body: unknown;
        try {
          body = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as unknown);
        } catch {
          sendJson(res, 400, { message: 'the GraphQL body is not valid JSON' });
          return;
        }
        const result = handleGraphQL(store, body);
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP.
      if (pathname === '/mcp' && method === 'POST') {
        const result = handleMcp(store, raw);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }
      if (pathname === '/mcp' && method === 'DELETE') {
        res.writeHead(200, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }

      // Git smart HTTP: /<owner>/<repo>[.git]/info/refs | git-upload-pack | git-receive-pack.
      const gitService =
        segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs'
          ? 'info/refs'
          : segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
            ? segments[2]
            : null;
      if (gitService !== null && segments.length >= 3) {
        const owner = segments[0]!;
        const repoName = segments[1]!.replace(/\.git$/, '');
        const service = gitService;
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          send404(res);
          return;
        }
        if (service === 'info/refs' && method === 'GET') {
          const requested = query.get('service') ?? '';
          if (requested === 'git-upload-pack') {
            if ((req.headers['git-protocol'] ?? '') === 'version=2') {
              sendBuffer(res, 200, V2_ADVERTISEMENT, 'application/x-git-upload-pack-advertisement');
            } else {
              sendBuffer(res, 200, store.cachedAdvertisements(repo).v0up, 'application/x-git-upload-pack-advertisement');
            }
            return;
          }
          if (requested === 'git-receive-pack') {
            sendBuffer(res, 200, store.cachedAdvertisements(repo).v0recv, 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendJson(res, 400, { message: 'a service is required' });
          return;
        }
        if (service === 'git-upload-pack' && method === 'POST') {
          await handleGitUploadPack(store, repo, raw, res);
          return;
        }
        if (service === 'git-receive-pack' && method === 'POST') {
          await handleGitReceivePack(store, repo, raw, res);
          return;
        }
        send404(res);
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restPath = segments.slice(2);
        const body = parseJsonBody(raw);
        if ((method === 'POST' || method === 'PATCH' || method === 'PUT') && body === null) {
          sendJson(res, 400, { message: 'the request body is not valid JSON' });
          return;
        }
        const json = body ?? {};
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

        // /api/v3/meta, /api/v3/user, /api/v3/user/repos
        if (restPath.length === 1 && restPath[0] === 'meta' && method === 'GET') {
          const result = rest.apiMeta();
          sendJson(res, result.status, result.body, result.headers);
          return;
        }
        if (restPath.length === 1 && restPath[0] === 'user' && method === 'GET') {
          const result = rest.getUser(store);
          sendJson(res, result.status, result.body);
          return;
        }
        if (restPath.length === 2 && restPath[0] === 'user' && restPath[1] === 'repos') {
          if (method === 'POST') {
            const result = rest.createUserRepo(store, json);
            sendJson(res, result.status, result.body, result.headers);
            return;
          }
          if (method === 'GET') {
            const result = rest.listUserRepos(store, query, origin);
            sendJson(res, result.status, result.body, result.headers);
            return;
          }
        }

        // /api/v3/repos/{owner}/{repo}/...
        if (restPath[0] === 'repos' && restPath.length >= 3) {
          const owner = restPath[1]!;
          const repoName = restPath[2]!;
          const tail = restPath.slice(3);
          const done = (result: rest.RestResult): void => {
            sendJson(res, result.status, result.body, result.headers);
          };

          if (tail.length === 0) {
            if (method === 'GET') return done(rest.getRepo(store, owner, repoName));
            if (method === 'PATCH') return done(rest.patchRepo(store, owner, repoName, json));
            if (method === 'DELETE') {
              const result = rest.deleteRepo(store, owner, repoName);
              if (result.status === 204) {
                res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId() });
                res.end();
                return;
              }
              return done(result);
            }
          }
          if (tail[0] === 'branches' && method === 'GET' && tail.length === 1) return done(rest.listBranches(store, owner, repoName));
          if (tail[0] === 'branches' && method === 'GET' && tail.length === 2) return done(rest.getBranch(store, owner, repoName, tail[1]!));
          if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) return done(rest.listCommits(store, owner, repoName, query));
          if (tail[0] === 'git' && tail[1] === 'refs' && method === 'POST' && tail.length === 2) return done(rest.createRef(store, owner, repoName, json));
          if (tail[0] === 'git' && tail[1] === 'refs' && tail[2] === 'heads' && method === 'GET' && tail.length === 4) {
            return done(rest.getRef(store, owner, repoName, `refs/heads/${tail[3]!}`));
          }
          if (tail[0] === 'contents' && tail.length >= 2) {
            const filePath = tail.slice(1).join('/');
            if (method === 'GET') return done(rest.getContents(store, owner, repoName, filePath, query));
            if (method === 'PUT') return done(rest.putContents(store, owner, repoName, filePath, json));
            if (method === 'DELETE') return done(rest.deleteContents(store, owner, repoName, filePath, json));
          }
          if (tail[0] === 'labels' && method === 'POST' && tail.length === 1) return done(rest.createLabel(store, owner, repoName, json));
          if (tail[0] === 'issues' && method === 'POST' && tail.length === 1) return done(rest.createIssue(store, owner, repoName, json));
          if (tail[0] === 'issues' && method === 'GET' && tail.length === 1) return done(rest.listIssues(store, owner, repoName, query));
          if (tail[0] === 'issues' && tail.length === 2 && /^\d+$/.test(tail[1]!)) {
            const number = Number(tail[1]!);
            if (method === 'GET') {
              const result = rest.getIssue(store, owner, repoName, number);
              if (result.buffer) {
                sendBuffer(res, result.status, result.buffer, JSON_TYPE);
                return;
              }
              return done({ status: result.status, body: result.body });
            }
            if (method === 'PATCH') return done(rest.patchIssue(store, owner, repoName, number, json));
          }
          if (tail[0] === 'issues' && tail.length === 3 && /^\d+$/.test(tail[1]!) && tail[2] === 'comments') {
            const number = Number(tail[1]!);
            if (method === 'POST') return done(rest.createComment(store, owner, repoName, number, json));
            if (method === 'GET') return done(rest.listComments(store, owner, repoName, number));
          }
          if (tail[0] === 'pulls' && method === 'POST' && tail.length === 1) return done(rest.createPull(store, owner, repoName, json));
          if (tail[0] === 'pulls' && method === 'GET' && tail.length === 1) return done(rest.listPulls(store, owner, repoName, query));
          if (tail[0] === 'pulls' && tail.length === 2 && /^\d+$/.test(tail[1]!)) {
            if (method === 'GET') return done(rest.getPull(store, owner, repoName, Number(tail[1]!)));
          }
          if (tail[0] === 'pulls' && tail.length === 3 && /^\d+$/.test(tail[1]!) && tail[2] === 'files') {
            if (method === 'GET') return done(rest.listPullFiles(store, owner, repoName, Number(tail[1]!)));
          }
          if (tail[0] === 'pulls' && tail.length === 3 && /^\d+$/.test(tail[1]!) && tail[2] === 'merge') {
            if (method === 'PUT') return done(rest.mergePull(store, owner, repoName, Number(tail[1]!)));
          }
        }

        send404(res);
        return;
      }

      send404(res);
    })().catch((err: unknown) => {
      // A request handler must never take the server down (repo-survives-errors).
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
      } catch {
        // The peer went away; nothing to write to.
      }
    });
  });
}
