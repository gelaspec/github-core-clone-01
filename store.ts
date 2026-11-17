// The in-memory forge: one unified object store backing REST contents, git clone/push
// and GraphQL, exactly as the suite cross-checks. No clock reads in request paths:
// a logical clock starts at MAKEFUN_TRIAL_NOW (or the scenario epoch) and ticks 1s per
// commit/creation, so a trial replays deterministically.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './git.ts';
import {
  DEFAULT_BRANCH,
  SCENARIO_EPOCH_SEC,
  buildScenario,
  type Scenario,
} from './scenario.ts';

export const VIEWER_IDENTITY = 'adaiversen <adaiversen@example.invalid>';

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  updatedAt: string;
  cachedJson: Buffer | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  nextNumber: number;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, { name: string; color: string }>;
  createdSeq: number;
  /** Bumped on every ref change; cache keys include it. */
  version: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function b64encode(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** A line diff (LCS) for small files; falls back to whole-file counts when large. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 40000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const dp: number[][] = Array.from({ length: oldLines.length + 1 }, () => new Array<number>(newLines.length + 1).fill(0));
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lcs = dp[0]![0]!;
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

export function globalId(kind: 'R' | 'I' | 'P' | 'C', parts: readonly (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || !['R', 'I', 'P', 'C'].includes(kind)) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export class Store {
  readonly scenario: Scenario;
  readonly viewerLogin: string;
  readonly viewerId: number;
  readonly viewerEmail: string;
  readonly strangerLogin: string;
  readonly orgLogin: string;

  /** The one unified object store: oid -> object. */
  readonly objects = new Map<string, GitObject>();
  /** owner/name -> repo. */
  readonly repos = new Map<string, Repo>();
  /** Commit oid -> creation sequence (for commit listing order). */
  readonly commitSeq = new Map<string, number>();

  private clockSec: number;
  private seq = 0;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentIdValue = 1;
  private nextPullId = 1;

  /** repo key -> cached advertisements (v2 upload, v0 upload, v0 receive). */
  private advCache = new Map<string, { version: number; v2: Buffer; v0up: Buffer; v0recv: Buffer }>();
  /** fetch pack cache: `${repoKey}|${tip}|${depth ?? 'full'}|${haves}` -> pack bytes. */
  private packCache = new Map<string, Buffer>();
  /** GET /user/repos list cache (viewer repos, creation order). */
  private userReposCache: { version: number; body: Buffer } | null = null;
  private reposVersion = 0;

  constructor() {
    this.scenario = buildScenario();
    this.viewerLogin = this.scenario.viewer.login;
    this.viewerId = this.scenario.viewer.id;
    this.viewerEmail = this.scenario.viewer.email;
    this.strangerLogin = this.scenario.stranger.login;
    this.orgLogin = this.scenario.org;
    const trialNow = process.env.MAKEFUN_TRIAL_NOW ?? '';
    let base = SCENARIO_EPOCH_SEC;
    if (trialNow !== '') {
      const parsed = Date.parse(trialNow);
      if (Number.isFinite(parsed)) base = Math.floor(parsed / 1000);
      else if (/^\d+$/.test(trialNow)) base = Math.floor(Number(trialNow) / 1000);
    }
    this.clockSec = base;
  }

  /** The next logical timestamp (ISO); ticks 1s per call. */
  nowIso(): string {
    const iso = isoOf(this.clockSec);
    this.clockSec += 1;
    return iso;
  }

  /** The next comment id (a global integer, stable across reads). */
  nextCommentId(): number {
    const id = this.nextCommentIdValue;
    this.nextCommentIdValue += 1;
    return id;
  }

  /** A creation-order sequence number. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // -------------------------------------------------------------------------------------------
  // objects
  // -------------------------------------------------------------------------------------------

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    if (type === 'commit' && !this.commitSeq.has(oid)) this.commitSeq.set(oid, this.nextSeq());
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** A commit's parents, [] when the object is missing or not a commit. */
  commitParents(oid: string): string[] {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return [];
    return parseCommit(object.data).parents;
  }

  /** Whether `ancestor` is reachable from `commit` (following parents). */
  isAncestor(ancestor: string, commit: string): boolean {
    if (ancestor === commit) return true;
    const seen = new Set<string>();
    const stack = [commit];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      for (const parent of this.commitParents(oid)) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The nearest common ancestor of `a` and `b` (linear histories: the first common one). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stack = [a];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      for (const parent of this.commitParents(oid)) stack.push(parent);
    }
    const queue = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      for (const parent of this.commitParents(oid)) queue.push(parent);
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // trees
  // -------------------------------------------------------------------------------------------

  /** The tree oid of a commit, or null. */
  commitTree(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Walk a tree to `path` (segments); returns the entry or null. */
  treeEntry(treeOid: string | null, path: string): TreeEntry | null {
    if (treeOid === null) return null;
    const segments = path.split('/').filter((part) => part !== '');
    let current: string | null = treeOid;
    for (let index = 0; index < segments.length; index += 1) {
      if (current === null) return null;
      const object = this.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
      if (!entry) return null;
      if (index === segments.length - 1) return entry;
      current = entry.oid;
    }
    return null;
  }

  /** The entries of the directory at `path` ('' = root) of a tree, or null when missing. */
  listDir(treeOid: string | null, path: string): TreeEntry[] | null {
    if (treeOid === null) return null;
    if (path === '' || path === '/') {
      const object = this.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      return parseTree(object.data);
    }
    const entry = this.treeEntry(treeOid, path);
    if (!entry || entry.mode !== '40000') return null;
    const object = this.objects.get(entry.oid);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  /** A new tree with `path` set to `blobOid` (null removes it), built on `baseTreeOid`. */
  updateTree(baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((part) => part !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const object = treeOid === null ? undefined : this.objects.get(treeOid);
      const entries = new Map<string, TreeEntry>();
      if (object && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = build(child && child.mode === '40000' ? child.oid : null, depth + 1);
        const childObject = this.objects.get(childTree);
        const childEntries = childObject && childObject.type === 'tree' ? parseTree(childObject.data) : [];
        if (childEntries.length === 0 && blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: childTree });
      }
      return this.putObject('tree', buildTree([...entries.values()]));
    };
    return build(baseTreeOid, 0);
  }

  /** Flatten a tree to path -> { mode, oid } (recursive). */
  flattenTree(treeOid: string | null, prefix = ''): Map<string, TreeEntry> {
    const out = new Map<string, TreeEntry>();
    if (treeOid === null) return out;
    const object = this.objects.get(treeOid);
    if (!object || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [subPath, sub] of this.flattenTree(entry.oid, path)) out.set(subPath, sub);
      } else {
        out.set(path, entry);
      }
    }
    return out;
  }

  /** The file changes from `baseTreeOid` to `headTreeOid` (added/modified/removed + line counts). */
  diffTrees(baseTreeOid: string | null, headTreeOid: string | null): FileChange[] {
    const base = this.flattenTree(baseTreeOid);
    const head = this.flattenTree(headTreeOid);
    const changes: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const oldEntry = base.get(path);
      const newEntry = head.get(path);
      if (oldEntry && !newEntry) {
        const oldText = this.blobText(oldEntry.oid);
        const diff = lineDiff(oldText, '');
        changes.push({ path, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
      } else if (!oldEntry && newEntry) {
        const newText = this.blobText(newEntry.oid);
        const diff = lineDiff('', newText);
        changes.push({ path, status: 'added', additions: Math.max(1, diff.additions), deletions: 0, changes: Math.max(1, diff.additions) });
      } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
        const diff = lineDiff(this.blobText(oldEntry.oid), this.blobText(newEntry.oid));
        const additions = Math.max(diff.additions, 0);
        const deletions = Math.max(diff.deletions, 0);
        changes.push({
          path,
          status: 'modified',
          additions: additions === 0 && deletions === 0 ? 1 : additions,
          deletions,
          changes: (additions === 0 && deletions === 0 ? 1 : additions) + deletions,
        });
      }
    }
    return changes;
  }

  blobText(oid: string): string {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  blobBytes(oid: string): Buffer | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'blob') return null;
    return object.data;
  }

  // -------------------------------------------------------------------------------------------
  // repos and refs
  // -------------------------------------------------------------------------------------------

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { private: boolean; description: string }): { repo: Repo | null; exists: boolean } {
    const key = this.repoKey(owner, name);
    const existing = this.repos.get(key);
    if (existing) return { repo: existing, exists: true };
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: options.description,
      private: options.private,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      createdSeq: this.nextSeq(),
      version: 0,
    };
    this.repos.set(key, repo);
    this.reposVersion += 1;
    this.userReposCache = null;
    return { repo, exists: false };
  }

  deleteRepo(owner: string, name: string): boolean {
    const deleted = this.repos.delete(this.repoKey(owner, name));
    if (deleted) {
      this.reposVersion += 1;
      this.userReposCache = null;
    }
    return deleted;
  }

  /** Resolve a ref name, branch name, HEAD or oid to a commit oid (or null). */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '' || ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) {
      const object = this.objects.get(tag);
      if (object?.type === 'tag') return parseTag(object.data).object;
      return tag;
    }
    if (isObjectId(ref) && this.objects.has(ref)) return ref;
    return null;
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
    this.advCache.delete(this.repoKey(repo.owner, repo.name));
  }

  deleteRef(repo: Repo, ref: string): void {
    repo.refs.delete(ref);
    repo.version += 1;
    this.advCache.delete(this.repoKey(repo.owner, repo.name));
  }

  /** All refs sorted by name: [name, oid]. */
  sortedRefs(repo: Repo): Array<[string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** The default branch's tip commit oid, or null when unborn. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  /** Commits reachable from `tip`, newest first (by creation sequence). */
  listCommits(tip: string | null): Array<{ sha: string; message: string; author: string; committer: string }> {
    if (tip === null) return [];
    const reachable = collectReachable([tip], (oid) => this.objects.get(oid));
    const commits: Array<{ sha: string; message: string; author: string; committer: string; seq: number }> = [];
    for (const oid of reachable) {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parsed = parseCommit(object.data);
      commits.push({ sha: oid, message: parsed.message, author: parsed.author, committer: parsed.committer, seq: this.commitSeq.get(oid) ?? 0 });
    }
    commits.sort((a, b) => b.seq - a.seq);
    return commits.map(({ sha, message, author, committer }) => ({ sha, message, author, committer }));
  }

  /** Create a commit on `branch` (creating the branch when needed) with one file change. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; contentSha: string; branchCreated: boolean } {
    const refName = `refs/heads/${branch}`;
    const parent = repo.refs.get(refName) ?? null;
    const branchCreated = parent === undefined || parent === null;
    const baseTree = parent === null ? null : this.commitTree(parent);
    const blobOid = this.putObject('blob', content);
    const treeOid = this.updateTree(baseTree, path, blobOid);
    const timestamp = this.clockSec;
    this.clockSec += 1;
    const commit = buildCommit({
      tree: treeOid,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp,
    });
    const commitSha = this.putObject('commit', commit);
    this.setRef(repo, refName, commitSha);
    return { commitSha, contentSha: blobOid, branchCreated };
  }

  /** Delete a file on `branch`; null when the file is not there. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | null {
    const refName = `refs/heads/${branch}`;
    const parent = repo.refs.get(refName);
    if (!parent) return null;
    const baseTree = this.commitTree(parent);
    if (!this.treeEntry(baseTree, path)) return null;
    const treeOid = this.updateTree(baseTree, path, null);
    const timestamp = this.clockSec;
    this.clockSec += 1;
    const commit = buildCommit({
      tree: treeOid,
      parents: [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp,
    });
    const commitSha = this.putObject('commit', commit);
    this.setRef(repo, refName, commitSha);
    return commitSha;
  }

  // -------------------------------------------------------------------------------------------
  // issues
  // -------------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      updatedAt: this.nowIso(),
      cachedJson: null,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  /** The REST JSON for one issue (cached Buffer; invalidated on mutation). */
  issueJson(repo: Repo, issue: Issue): Buffer {
    if (issue.cachedJson) return issue.cachedJson;
    const body = JSON.stringify(this.issueObject(repo, issue));
    issue.cachedJson = Buffer.from(body, 'utf8');
    return issue.cachedJson;
  }

  issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      user: { login: this.viewerLogin, id: this.viewerId },
      created_at: isoOf(SCENARIO_EPOCH_SEC + issue.createdSeq),
      updated_at: issue.updatedAt,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  listIssues(repo: Repo, query: { state?: string; sort?: string; direction?: string }): Issue[] {
    const state = query.state ?? 'open';
    const direction = query.direction ?? 'desc';
    const list = [...repo.issues.values()].filter((issue) => {
      if (state === 'all') return true;
      return issue.state === state;
    });
    list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests + merges
  // -------------------------------------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): { pull: Pull | null; reason: string | null } {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return { pull: null, reason: 'head or base branch does not exist' };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        return { pull: null, reason: 'a pull request is already open for this head' };
      }
    }
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: this.nextPullId++,
      number,
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: this.nextSeq(),
    };
    repo.pulls.set(number, pull);
    return { pull, reason: null };
  }

  pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
    return {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      merged: pull.merged,
      merged_at: pull.mergedAt,
      merge_commit_sha: pull.mergeCommitSha,
      head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
      base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
      user: { login: this.viewerLogin, id: this.viewerId },
      created_at: isoOf(SCENARIO_EPOCH_SEC + pull.createdSeq),
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    };
  }

  /** The files a pull request changes (head vs merge-base), with line counts. */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const base = this.mergeBase(pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : this.commitTree(base);
    const headTree = this.commitTree(pull.headSha);
    return this.diffTrees(baseTree, headTree);
  }

  /** MERGEABLE when the head's changes apply cleanly onto the base tip, else CONFLICTING. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
    const base = this.mergeBase(pull.headSha, pull.baseSha);
    if (base === null) return 'CONFLICTING';
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return 'CONFLICTING';
    const baseTree = this.commitTree(base);
    const headChanges = this.diffTrees(baseTree, this.commitTree(pull.headSha));
    const baseChanges = this.diffTrees(baseTree, this.commitTree(baseTip));
    const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = baseChanged.get(change.path);
      if (!other) continue;
      const headEntry = this.treeEntry(this.commitTree(pull.headSha), change.path);
      const baseTipEntry = this.treeEntry(this.commitTree(baseTip), change.path);
      if ((headEntry?.oid ?? null) !== (baseTipEntry?.oid ?? null)) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }

  /** Squash-merge a pull request; returns the merge commit sha, or a conflict reason. */
  mergePull(repo: Repo, pull: Pull): { sha: string | null; conflict: boolean } {
    if (pull.state !== 'open') return { sha: null, conflict: false };
    if (this.pullMergeable(repo, pull) === 'CONFLICTING') return { sha: null, conflict: true };
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (baseTip === undefined) return { sha: null, conflict: true };
    const base = this.mergeBase(pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : this.commitTree(base);
    const headChanges = this.diffTrees(baseTree, this.commitTree(pull.headSha));
    let treeOid = this.commitTree(baseTip);
    for (const change of headChanges) {
      if (change.status === 'removed') {
        treeOid = this.updateTree(treeOid, change.path, null);
      } else {
        const entry = this.treeEntry(this.commitTree(pull.headSha), change.path);
        if (entry) treeOid = this.updateTree(treeOid, change.path, entry.oid);
      }
    }
    const timestamp = this.clockSec;
    this.clockSec += 1;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message,
      author: VIEWER_IDENTITY,
      committer: VIEWER_IDENTITY,
      timestamp,
    });
    const mergeSha = this.putObject('commit', commit);
    this.setRef(repo, `refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = isoOf(timestamp);
    pull.mergeCommitSha = mergeSha;
    return { sha: mergeSha, conflict: false };
  }

  // -------------------------------------------------------------------------------------------
  // repo listing (GET /user/repos) + caches
  // -------------------------------------------------------------------------------------------

  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === this.viewerLogin)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  repoSummary(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${repo.owner}/${repo.name}`,
      owner: { login: repo.owner, id: repo.owner === this.viewerLogin ? this.viewerId : 0 },
      private: repo.private,
      description: repo.description,
      default_branch: repo.defaultBranch,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
      url: `/api/v3/repos/${repo.owner}/${repo.name}`,
      created_at: isoOf(SCENARIO_EPOCH_SEC + repo.createdSeq),
      updated_at: isoOf(SCENARIO_EPOCH_SEC + repo.createdSeq),
    };
  }

  // -------------------------------------------------------------------------------------------
  // git fetch computation + pack cache
  // -------------------------------------------------------------------------------------------

  /** Objects to send for a fetch: closure(wants) minus closure(haves), or a depth-limited cut. */
  fetchObjects(
    wants: readonly string[],
    haves: readonly string[],
    depth: number | undefined,
    shallowBoundaries: readonly string[],
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const lookup = (oid: string): GitObject | undefined => this.objects.get(oid);
    const shallow: string[] = [];
    const unshallow: string[] = [];
    if (depth === undefined) {
      const held = new Set<string>();
      for (const have of haves) for (const oid of collectReachable([have], lookup)) held.add(oid);
      const send = new Set<string>();
      for (const want of wants) {
        for (const oid of collectReachable([want], lookup)) {
          if (!held.has(oid)) send.add(oid);
        }
      }
      const objects = new Map<string, GitObject>();
      for (const oid of send) {
        const object = this.objects.get(oid);
        if (object) objects.set(oid, object);
      }
      return { objects, shallow, unshallow };
    }

    // Depth-limited: BFS distances from the wants over commit parents only.
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = wants.map((want) => [want, 0] as [string, number]);
    while (queue.length > 0) {
      const [oid, depthNow] = queue.shift()!;
      if (dist.has(oid)) continue;
      dist.set(oid, depthNow);
      if (depthNow + 1 < depth) {
        for (const parent of this.commitParents(oid)) {
          if (!dist.has(parent)) queue.push([parent, depthNow + 1]);
        }
      }
    }
    // Held set: reachable from haves, never traversing past a shallow boundary's parents.
    const held = new Set<string>();
    const heldQueue = [...haves];
    while (heldQueue.length > 0) {
      const oid = heldQueue.pop()!;
      if (held.has(oid)) continue;
      held.add(oid);
      if (shallowBoundaries.includes(oid)) continue;
      for (const parent of this.commitParents(oid)) heldQueue.push(parent);
    }
    const sentCommits = new Set<string>();
    for (const [oid, distance] of dist) {
      if (distance <= depth - 1 && !held.has(oid)) sentCommits.add(oid);
    }
    const objects = new Map<string, GitObject>();
    const addTreeClosure = (treeOid: string | null): void => {
      if (treeOid === null) return;
      for (const oid of collectReachable([treeOid], lookup)) {
        const object = this.objects.get(oid);
        if (object && (object.type === 'tree' || object.type === 'blob')) objects.set(oid, object);
      }
    };
    for (const oid of sentCommits) {
      const object = this.objects.get(oid);
      if (!object) continue;
      objects.set(oid, object);
      if (object.type === 'commit') addTreeClosure(parseCommit(object.data).tree);
      else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        const targetObject = this.objects.get(target);
        if (targetObject) {
          objects.set(target, targetObject);
          if (targetObject.type === 'commit') addTreeClosure(parseCommit(targetObject.data).tree);
        }
      }
    }
    for (const oid of sentCommits) {
      if (dist.get(oid) === depth - 1) shallow.push(oid);
    }
    const heldOrSent = new Set([...held, ...sentCommits]);
    for (const boundary of shallowBoundaries) {
      const parents = this.commitParents(boundary);
      if (parents.length > 0 && parents.every((parent) => heldOrSent.has(parent))) unshallow.push(boundary);
    }
    return { objects, shallow, unshallow };
  }

  /** The pack bytes for a fetch (cached for the common depth-1 clone of an unchanged tip). */
  fetchPack(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth: number | undefined,
    shallowBoundaries: readonly string[],
  ): { pack: Buffer | null; shallow: string[]; unshallow: string[] } {
    const cacheable = depth === 1 && wants.length === 1 && haves.length === 0;
    const key = cacheable ? `${this.repoKey(repo.owner, repo.name)}|${wants[0]}|d1|v${repo.version}` : '';
    if (cacheable) {
      const cached = this.packCache.get(key);
      if (cached) return { pack: cached, shallow: [wants[0]!], unshallow: [] };
    }
    const { objects, shallow, unshallow } = this.fetchObjects(wants, haves, depth, shallowBoundaries);
    if (objects.size === 0) return { pack: null, shallow, unshallow };
    const ordered = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const pack = writePack(ordered.map(([, object]) => object));
    if (cacheable) this.packCache.set(key, pack);
    return { pack, shallow, unshallow };
  }

  invalidatePackCache(repo: Repo): void {
    const prefix = `${this.repoKey(repo.owner, repo.name)}|`;
    for (const key of [...this.packCache.keys()]) {
      if (key.startsWith(prefix)) this.packCache.delete(key);
    }
  }

  // -------------------------------------------------------------------------------------------
  // advertisements (cached per repo version)
  // -------------------------------------------------------------------------------------------

  /** The v2 upload-pack advertisement body (pkt-lines). */
  advertisementV2(): Buffer {
    const parts: Buffer[] = [];
    const pkt = (text: string): Buffer => {
      const payload = Buffer.from(text, 'utf8');
      const head = Buffer.alloc(4);
      head.write((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
      return Buffer.concat([head, payload]);
    };
    parts.push(pkt('# service=git-upload-pack\n'));
    parts.push(Buffer.from('0000', 'ascii'));
    parts.push(pkt('version 2\n'));
    parts.push(pkt('fetch=shallow\n'));
    parts.push(pkt('ls-refs\n'));
    parts.push(pkt('object-format=sha1\n'));
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }

  /** The v0 advertisement body for a service (upload-pack or receive-pack). */
  advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
    const parts: Buffer[] = [];
    const pkt = (text: string): Buffer => {
      const payload = Buffer.from(text, 'utf8');
      const head = Buffer.alloc(4);
      head.write((payload.length + 4).toString(16).padStart(4, '0'), 'ascii');
      return Buffer.concat([head, payload]);
    };
    const caps =
      service === 'git-receive-pack'
        ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta'
        : 'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed';
    parts.push(pkt(`# service=${service}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
    const refs = this.sortedRefs(repo);
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const peeled = (oid: string): string | null => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tag') return null;
      return parseTag(object.data).object;
    };
    if (refs.length === 0) {
      parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      let first = true;
      const line = (oid: string, name: string): void => {
        parts.push(pkt(first ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
        first = false;
      };
      line(headTip ?? ZERO_OID, 'HEAD');
      for (const [name, oid] of refs) {
        line(oid, name);
        const target = peeled(oid);
        if (target !== null) parts.push(pkt(`${target} ${name}^{}\n`));
      }
    }
    parts.push(Buffer.from('0000', 'ascii'));
    return Buffer.concat(parts);
  }

  cachedAdvertisements(repo: Repo): { v2: Buffer; v0up: Buffer; v0recv: Buffer } {
    const key = this.repoKey(repo.owner, repo.name);
    const cached = this.advCache.get(key);
    if (cached && cached.version === repo.version) return cached;
    const value = {
      version: repo.version,
      v2: this.advertisementV2(),
      v0up: this.advertisementV0(repo, 'git-upload-pack'),
      v0recv: this.advertisementV0(repo, 'git-receive-pack'),
    };
    this.advCache.set(key, value);
    return value;
  }

  // -------------------------------------------------------------------------------------------
  // ls-refs lines (v2)
  // -------------------------------------------------------------------------------------------

  /** ls-refs response lines for a repo, filtered by prefix (HEAD omitted when a prefix is given). */
  lsRefsLines(repo: Repo, prefixes: readonly string[]): string[] {
    const lines: string[] = [];
    const keep = (name: string): boolean =>
      prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const peeled = (oid: string): string | null => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tag') return null;
      return parseTag(object.data).object;
    };
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (prefixes.length === 0) {
      lines.push(`${headTip ?? ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}`);
    }
    for (const [name, oid] of this.sortedRefs(repo)) {
      if (!keep(name)) continue;
      const target = peeled(oid);
      lines.push(target !== null ? `${oid} ${name} peeled:${target}` : `${oid} ${name}`);
    }
    return lines;
  }
}
