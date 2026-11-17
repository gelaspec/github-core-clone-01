// REST v3 handlers. Each returns { status, body?, headers? }; app.ts does auth,
// the request-id header and the JSON write. Bodies are plain objects (or Buffers
// for the hot cached paths) and always JSON.

import { decodeGlobalId, globalId, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (what: string): RestResult => ({ status: 404, body: { message: `${what} not found` } });
const badRequest = (message: string): RestResult => ({ status: 400, body: { message } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });

function repoObject(store: Store, repo: Repo): Record<string, unknown> {
  return {
    ...store.repoSummary(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === store.viewerLogin ? store.viewerId : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

/** GET /api/v3/ — the API root. */
export function apiRoot(): RestResult {
  return {
    status: 200,
    body: { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
    headers: { 'x-oauth-scopes': 'repo, read:org' },
  };
}

/** GET /api/v3/meta. */
export function apiMeta(): RestResult {
  return { status: 200, body: { installed_version: '1.0.0' } };
}

/** GET /api/v3/user — the token owner. */
export function getUser(store: Store): RestResult {
  return {
    status: 200,
    body: {
      login: store.viewerLogin,
      id: store.viewerId,
      email: store.viewerEmail,
      name: store.viewerLogin,
      type: 'User',
      html_url: `https://example.invalid/${store.viewerLogin}`,
      url: '/api/v3/user',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------------------------

/** POST /api/v3/user/repos — create (201) or 422 when the name already exists. */
export function createUserRepo(store: Store, body: Record<string, unknown>): RestResult {
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || /[/\s]/.test(name)) return unprocessable('a repository name is required');
  const { repo, exists } = store.createRepo(store.viewerLogin, name, {
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : '',
  });
  if (exists || repo === null) return unprocessable(`repository ${name} already exists`);
  return { status: 201, body: repoObject(store, repo) };
}

/** GET /api/v3/user/repos — paginated, creation order, Link rel="next" while pages remain. */
export function listUserRepos(
  store: Store,
  query: URLSearchParams,
  origin: string,
): RestResult {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const repos = store.viewerRepos();
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  const slice = repos.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const pageUrl = (target: number): string =>
    `${origin}/api/v3/user/repos?per_page=${perPage}&page=${target}`;
  if (page < totalPages) links.push(`<${pageUrl(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${pageUrl(page - 1)}>; rel="prev"`);
  links.push(`<${pageUrl(1)}>; rel="first"`);
  links.push(`<${pageUrl(totalPages)}>; rel="last"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { status: 200, body: slice.map((repo) => repoObject(store, repo)), headers };
}

/** GET /api/v3/repos/{owner}/{repo}. */
export function getRepo(store: Store, owner: string, name: string): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  return { status: 200, body: repoObject(store, repo) };
}

/** PATCH /api/v3/repos/{owner}/{repo} — description (and name/private when sent). */
export function patchRepo(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  return { status: 200, body: repoObject(store, repo) };
}

/** DELETE /api/v3/repos/{owner}/{repo} — 204, then GET is 404. */
export function deleteRepo(store: Store, owner: string, name: string): RestResult {
  if (!store.deleteRepo(owner, name)) return notFound('Not Found');
  return { status: 204 };
}

// ---------------------------------------------------------------------------------------------
// branches, commits, refs
// ---------------------------------------------------------------------------------------------

/** GET /api/v3/repos/{owner}/{repo}/branches. */
export function listBranches(store: Store, owner: string, name: string): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { status: 200, body: branches };
}

/** GET /api/v3/repos/{owner}/{repo}/branches/{branch}. */
export function getBranch(store: Store, owner: string, name: string, branch: string): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return notFound('Branch not found');
  return { status: 200, body: { name: branch, commit: { sha } } };
}

/** GET /api/v3/repos/{owner}/{repo}/commits[?sha=<ref>]. */
export function listCommits(store: Store, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const ref = query.get('sha') ?? undefined;
  const tip = store.resolveRef(repo, ref);
  const commits = store.listCommits(tip);
  return {
    status: 200,
    body: commits.map((commit) => ({
      sha: commit.sha,
      commit: {
        // The git object stores the message with a trailing newline; the REST
        // view answers it without one, as GitHub does.
        message: commit.message.replace(/\n$/, ''),
        author: { name: commit.author.split(' <')[0], email: commit.author.split('<')[1]?.replace('>', '') ?? '', date: '' },
        committer: { name: commit.committer.split(' <')[0], email: commit.committer.split('<')[1]?.replace('>', '') ?? '', date: '' },
      },
      author: { login: store.viewerLogin },
      committer: { login: store.viewerLogin },
    })),
  };
}

/** POST /api/v3/repos/{owner}/{repo}/git/refs — create a branch at a sha. */
export function createRef(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return unprocessable('ref and sha are required');
  if (!store.getObject(sha)) return unprocessable('the sha does not exist');
  if (repo.refs.has(ref)) return unprocessable(`reference ${ref} already exists`);
  store.setRef(repo, ref, sha);
  return { status: 201, body: { ref, object: { sha } } };
}

/** GET /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}. */
export function getRef(store: Store, owner: string, name: string, ref: string): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const sha = repo.refs.get(ref);
  if (!sha) return notFound('Reference not found');
  return { status: 200, body: { ref, object: { sha } } };
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentsFileObject(store: Store, repo: Repo, path: string, blobOid: string, size: number): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name: path.split('/').pop() ?? path,
    path,
    sha: blobOid,
    content: Buffer.from(store.blobBytes(blobOid) ?? Buffer.alloc(0)).toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
  };
}

/** GET /api/v3/repos/{owner}/{repo}/contents/{path}[?ref=] — file or directory listing. */
export function getContents(store: Store, owner: string, name: string, path: string, query: URLSearchParams): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const tip = store.resolveRef(repo, query.get('ref') ?? undefined);
  if (tip === null) return notFound('Not Found');
  const treeOid = store.commitTree(tip);
  if (treeOid === null) return notFound('Not Found');
  const decodedPath = decodeURIComponent(path);
  const entry = store.treeEntry(treeOid, decodedPath);
  if (entry) {
    if (entry.mode === '40000') {
      const entries = store.listDir(treeOid, decodedPath) ?? [];
      return {
        status: 200,
        body: entries.map((child) => ({
          type: child.mode === '40000' ? 'dir' : 'file',
          name: child.name,
          path: `${decodedPath}/${child.name}`,
          sha: child.oid,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${decodedPath}/${child.name}`,
        })),
      };
    }
    const bytes = store.blobBytes(entry.oid);
    if (bytes === null) return notFound('Not Found');
    return { status: 200, body: contentsFileObject(store, repo, decodedPath, entry.oid, bytes.length) };
  }
  const dirEntries = store.listDir(treeOid, decodedPath);
  if (dirEntries !== null) {
    return {
      status: 200,
      body: dirEntries.map((child) => ({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: `${decodedPath}/${child.name}`,
        sha: child.oid,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${decodedPath}/${child.name}`,
      })),
    };
  }
  return notFound('Not Found');
}

/** PUT /api/v3/repos/{owner}/{repo}/contents/{path} — create (201) or update (200). */
export function putContents(store: Store, owner: string, name: string, path: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const decodedPath = decodeURIComponent(path);
  const message = typeof body.message === 'string' ? body.message : `Update ${decodedPath}`;
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  if (contentB64 === '') return badRequest('content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return badRequest('content is not valid base64');
  }
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (tip !== undefined) {
    const treeOid = store.commitTree(tip);
    const current = treeOid === null ? null : store.treeEntry(treeOid, decodedPath);
    if (sha !== undefined) {
      if (!current || current.oid !== sha) return { status: 409, body: { message: 'the sha does not match the current file' } };
    }
  } else if (sha !== undefined) {
    return { status: 409, body: { message: 'the sha does not match the current file' } };
  }
  const isUpdate = sha !== undefined;
  const { commitSha, contentSha } = store.commitFile(repo, branch, decodedPath, content, message);
  return {
    status: isUpdate ? 200 : 201,
    body: {
      content: { ...contentsFileObject(store, repo, decodedPath, contentSha, content.length), sha: contentSha },
      commit: { sha: commitSha, message },
    },
  };
}

/** DELETE /api/v3/repos/{owner}/{repo}/contents/{path} — 200 with a commit, then GET is 404. */
export function deleteContents(store: Store, owner: string, name: string, path: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const decodedPath = decodeURIComponent(path);
  const message = typeof body.message === 'string' ? body.message : `Delete ${decodedPath}`;
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const commitSha = store.deleteFile(repo, branch, decodedPath, message);
  if (commitSha === null) return notFound('Not Found');
  return { status: 200, body: { commit: { sha: commitSha, message } } };
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

/** POST /api/v3/repos/{owner}/{repo}/labels. */
export function createLabel(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const labelName = typeof body.name === 'string' ? body.name : '';
  if (labelName === '') return unprocessable('a label name is required');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  repo.labels.set(labelName, { name: labelName, color });
  return { status: 201, body: { name: labelName, color } };
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

/** POST /api/v3/repos/{owner}/{repo}/issues — 201, or 422 on an unknown label. */
export function createIssue(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return unprocessable('a title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return unprocessable(`label ${label} does not exist`);
  }
  const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
  return { status: 201, body: store.issueObject(repo, issue) };
}

/** GET /api/v3/repos/{owner}/{repo}/issues — state/sort/direction, per_page/page. */
export function listIssues(store: Store, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const list = store.listIssues(repo, {
    state: query.get('state') ?? undefined,
    sort: query.get('sort') ?? undefined,
    direction: query.get('direction') ?? undefined,
  });
  const slice = list.slice((page - 1) * perPage, page * perPage);
  return { status: 200, body: slice.map((issue) => store.issueObject(repo, issue)) };
}

/** GET /api/v3/repos/{owner}/{repo}/issues/{number} — the cached JSON Buffer fast path. */
export function getIssue(store: Store, owner: string, name: string, number: number): { status: number; body?: unknown; buffer?: Buffer } {
  const repo = store.getRepo(owner, name);
  if (!repo) return { status: 404, body: { message: 'Not Found' } };
  const issue = repo.issues.get(number);
  if (!issue) return { status: 404, body: { message: 'Not Found' } };
  return { status: 200, buffer: store.issueJson(repo, issue) };
}

/** PATCH /api/v3/repos/{owner}/{repo}/issues/{number}. */
export function patchIssue(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.cachedJson = null;
  issue.updatedAt = store.nowIso();
  return { status: 200, body: store.issueObject(repo, issue) };
}

/** POST /api/v3/repos/{owner}/{repo}/issues/{number}/comments. */
export function createComment(store: Store, owner: string, name: string, number: number, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  const commentBody = typeof body.body === 'string' ? body.body : '';
  const comment = { id: store.nextCommentId(), body: commentBody, createdAt: store.nowIso() };
  issue.comments.push(comment);
  return {
    status: 201,
    body: { id: comment.id, body: commentBody, user: { login: store.viewerLogin, id: store.viewerId }, created_at: comment.createdAt },
  };
}

/** GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments. */
export function listComments(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return notFound('Not Found');
  return {
    status: 200,
    body: issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: store.viewerLogin, id: store.viewerId },
      created_at: comment.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

/** POST /api/v3/repos/{owner}/{repo}/pulls. */
export function createPull(store: Store, owner: string, name: string, body: Record<string, unknown>): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
  if (title === '' || head === '') return unprocessable('title and head are required');
  const { pull, reason } = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
  if (!pull) return unprocessable(reason ?? 'cannot create the pull request');
  return { status: 201, body: store.pullObject(repo, pull) };
}

/** GET /api/v3/repos/{owner}/{repo}/pulls[?state=]. */
export function listPulls(store: Store, owner: string, name: string, query: URLSearchParams): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const state = query.get('state') ?? 'open';
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? 30) || 30));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const list = [...repo.pulls.values()]
    .filter((pull) => (state === 'all' ? true : pull.state === state))
    .sort((a, b) => b.createdSeq - a.createdSeq);
  const slice = list.slice((page - 1) * perPage, page * perPage);
  return { status: 200, body: slice.map((pull) => store.pullObject(repo, pull)) };
}

/** GET /api/v3/repos/{owner}/{repo}/pulls/{number}. */
export function getPull(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  return { status: 200, body: store.pullObject(repo, pull) };
}

/** GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files. */
export function listPullFiles(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  const files = store.pullFiles(repo, pull);
  return {
    status: 200,
    body: files.map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })),
  };
}

/** PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge — squash; 404 unknown, 405 conflicted. */
export function mergePull(store: Store, owner: string, name: string, number: number): RestResult {
  const repo = store.getRepo(owner, name);
  if (!repo) return notFound('Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return notFound('Not Found');
  if (pull.state !== 'open') {
    return { status: 405, body: { message: 'the pull request is not open' } };
  }
  const { sha, conflict } = store.mergePull(repo, pull);
  if (conflict || sha === null) return { status: 405, body: { message: 'the pull request cannot be merged: conflicts' } };
  return {
    status: 200,
    body: { merged: true, sha, message: `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}` },
  };
}

// ---------------------------------------------------------------------------------------------
// GraphQL helpers shared with graphql.ts
// ---------------------------------------------------------------------------------------------

export function repoGlobalId(repo: Repo): string {
  return globalId('R', [repo.id]);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('I', [repo.id, issue.number]);
}

export function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('P', [repo.id, pull.number]);
}

/** Resolve a global id to its repo + kind + number. */
export function resolveGlobalId(
  store: Store,
  id: string,
): { kind: string; repo: Repo | null; number: number | null } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const dbId = Number(decoded.parts[0]);
  if (!Number.isSafeInteger(dbId)) return null;
  const repo = [...store.repos.values()].find((candidate) => candidate.id === dbId) ?? null;
  if (decoded.kind === 'R') return { kind: 'R', repo, number: null };
  const number = Number(decoded.parts[1]);
  return { kind: decoded.kind, repo, number: Number.isSafeInteger(number) ? number : null };
}
