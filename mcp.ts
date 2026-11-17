// Model Context Protocol over Streamable HTTP: POST /mcp, one JSON-RPC body per POST,
// answered by one JSON body. Modern 2026-07-28 (server/discover) and the legacy
// initialize handshake are both served; no session, no SSE stream.

import type { Store } from './store.ts';

export interface McpResult {
  status: number;
  /** The JSON body to send (null = empty body, e.g. a notification's 202). */
  body: unknown;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PREFERRED_REVISION = '2026-07-28';
const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Execute one tools/call against the store. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const str = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (!repoName) return toolError('create_repo needs a name');
      const { repo, exists } = store.createRepo(store.viewerLogin, repoName, {
        private: args.private === true,
        description: str('description') ?? '',
      });
      if (exists || repo === null) return toolError(`repository ${repoName} already exists`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: repo.private,
        default_branch: repo.defaultBranch,
        description: repo.description,
      });
    }
    case 'get_repo': {
      const owner = str('owner');
      const repoName = str('repo');
      if (!owner || !repoName) return toolError('get_repo needs owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult({
        id: repo.id,
        name: repo.name,
        full_name: `${repo.owner}/${repo.name}`,
        owner: { login: repo.owner },
        private: repo.private,
        default_branch: repo.defaultBranch,
        description: repo.description,
      });
    }
    case 'create_issue': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      if (!owner || !repoName || !title) return toolError('create_issue needs owner, repo and title');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const issue = store.createIssue(repo, title, str('body') ?? '', []);
      return toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const owner = str('owner');
      const repoName = str('repo');
      if (!owner || !repoName) return toolError('list_issues needs owner and repo');
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const state = str('state') ?? 'open';
      const issues = store.listIssues(repo, { state });
      return toolResult({
        issues: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        })),
      });
    }
    case 'create_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const title = str('title');
      const head = str('head');
      const base = str('base');
      if (!owner || !repoName || !title || !head || !base) {
        return toolError('create_pull_request needs owner, repo, title, head and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const { pull, reason } = store.createPull(repo, title, str('body') ?? '', head, base);
      if (!pull) return toolError(reason ?? 'cannot create the pull request');
      return toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      });
    }
    case 'merge_pull_request': {
      const owner = str('owner');
      const repoName = str('repo');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      if (!owner || !repoName || !Number.isSafeInteger(number)) {
        return toolError('merge_pull_request needs owner, repo and pull_number');
      }
      const repo = store.getRepo(owner, repoName);
      if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
      const pull = repo.pulls.get(number);
      if (!pull) return toolError(`pull request #${number} not found`);
      const { sha, conflict } = store.mergePull(repo, pull);
      if (conflict || sha === null) return toolError(`pull request #${number} cannot be merged`);
      return toolResult({ merged: true, number: pull.number, state: pull.state, sha });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

function rpcError(id: unknown, code: number, message: string): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

/** POST /mcp: one JSON-RPC request body (raw bytes, so a non-JSON body can answer -32700). */
export function handleMcp(store: Store, rawBody: Buffer): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const record = parsed as Record<string, unknown>;
  const id = record.id ?? null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (record.params ?? {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [PREFERRED_REVISION, ...LEGACY_REVISIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = [PREFERRED_REVISION, ...LEGACY_REVISIONS].includes(requested) ? requested : LEGACY_REVISIONS[0]!;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) return rpcError(id, -32602, `unknown tool ${name}`);
    const required = (tool.inputSchema.required ?? []) as string[];
    const missing = required.filter((key) => args[key] === undefined);
    if (missing.length > 0) {
      return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
    }
    return rpcResult(id, callTool(store, name, args));
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
