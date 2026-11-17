// GraphQL v4: POST /api/graphql, {query, variables} or a batch array, answered with
// {data, errors}. No GraphQL library: the suite sends a fixed set of documents, matched
// by their normalized text and executed against the same store as REST and git.

import {
  globalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { issueGlobalId, pullGlobalId, repoGlobalId, resolveGlobalId } from './rest.ts';

export interface GraphQLResult {
  status: number;
  body: unknown;
}

type Variables = Record<string, unknown>;

function gqlState(state: string): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closedAt', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author', 'mergedAt', 'mergeCommit', 'headRefOid', 'baseRefOid'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'];

function fieldsObject(names: readonly string[]): { fields: Array<{ name: string }> } {
  return { fields: names.map((name) => ({ name })) };
}

function issueNode(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: gqlState(issue.state),
    body: issue.body,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: store.pullMergeable(repo, pull),
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function repositoryNode(store: Store, repo: Repo): Record<string, unknown> {
  const tip = store.defaultTip(repo);
  return {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: tip === null ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number(text.slice('cursor:'.length));
    return Number.isSafeInteger(number) ? number : null;
  } catch {
    return null;
  }
}

/** Execute one operation document. Returns the {data, errors?} envelope. */
function execute(store: Store, query: string, variables: Variables): Record<string, unknown> {
  const flat = query.replace(/\s+/g, '');
  const str = (name: string): string | undefined => {
    const value = variables[name];
    return typeof value === 'string' ? value : undefined;
  };
  const num = (name: string): number | undefined => {
    const value = variables[name];
    return typeof value === 'number' ? value : undefined;
  };
  const input = (variables.input ?? {}) as Variables;

  // An unknown field is a 200 with an errors array naming it, never an HTTP error.
  if (flat.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: null },
      errors: [{ message: 'Field "noSuchFieldOnViewer" doesn\'t exist on type "Viewer"' }],
    };
  }

  if (flat.includes('__type(name:"Issue")')) {
    return { data: { Issue: fieldsObject(ISSUE_FIELDS) } };
  }
  if (flat.includes('__type(name:"PullRequest")') || flat.includes('__type(name:"Repository")')) {
    return {
      data: {
        PullRequest: fieldsObject(PULL_REQUEST_FIELDS),
        Repository: fieldsObject(REPOSITORY_FIELDS),
      },
    };
  }
  if (flat.includes('__type(name:"SearchType")')) {
    return { data: { SearchType: { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) } } };
  }
  if (flat.includes('viewer{login}')) {
    return { data: { viewer: { login: store.viewerLogin } } };
  }

  if (flat.includes('node(id:$id)')) {
    const id = str('id') ?? '';
    const resolved = resolveGlobalId(store, id);
    if (!resolved || !resolved.repo) return { data: { node: null } };
    if (resolved.kind === 'R') {
      return { data: { node: { id, name: resolved.repo.name, nameWithOwner: `${resolved.repo.owner}/${resolved.repo.name}` } } };
    }
    if (resolved.kind === 'I' && resolved.number !== null) {
      const issue = resolved.repo.issues.get(resolved.number);
      if (!issue) return { data: { node: null } };
      return { data: { node: { id, number: issue.number, title: issue.title } } };
    }
    if (resolved.kind === 'P' && resolved.number !== null) {
      const pull = resolved.repo.pulls.get(resolved.number);
      if (!pull) return { data: { node: null } };
      return { data: { node: { id, number: pull.number, title: pull.title } } };
    }
    return { data: { node: null } };
  }

  if (flat.includes('createIssue(input:')) {
    const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const resolved = resolveGlobalId(store, repositoryId);
    if (!resolved || !resolved.repo) {
      return { data: { createIssue: null }, errors: [{ message: 'repository not found' }] };
    }
    const issue = store.createIssue(resolved.repo, title, body, []);
    return { data: { createIssue: { issue: { number: issue.number, id: issueGlobalId(resolved.repo, issue) } } } };
  }

  if (flat.includes('closeIssue(input:')) {
    const issueId = typeof input.issueId === 'string' ? input.issueId : '';
    const resolved = resolveGlobalId(store, issueId);
    if (!resolved || !resolved.repo || resolved.number === null) {
      return { data: { closeIssue: null }, errors: [{ message: 'issue not found' }] };
    }
    const issue = resolved.repo.issues.get(resolved.number);
    if (!issue) return { data: { closeIssue: null }, errors: [{ message: 'issue not found' }] };
    issue.state = 'closed';
    issue.cachedJson = null;
    issue.updatedAt = store.nowIso();
    return {
      data: { closeIssue: { issue: { number: issue.number, id: issueGlobalId(resolved.repo, issue), state: 'CLOSED' } } },
    };
  }

  if (flat.includes('createPullRequest(input:')) {
    const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
    const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
    const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
    const title = typeof input.title === 'string' ? input.title : '';
    const resolved = resolveGlobalId(store, repositoryId);
    if (!resolved || !resolved.repo) {
      return { data: { createPullRequest: null }, errors: [{ message: 'repository not found' }] };
    }
    const { pull, reason } = store.createPull(resolved.repo, title, '', headRefName, baseRefName);
    if (!pull) {
      return { data: { createPullRequest: null }, errors: [{ message: reason ?? 'cannot create the pull request' }] };
    }
    return {
      data: {
        createPullRequest: {
          pullRequest: {
            number: pull.number,
            id: pullGlobalId(resolved.repo, pull),
            state: 'OPEN',
            headRefName: pull.headRef,
            baseRefName: pull.baseRef,
          },
        },
      },
    };
  }

  if (flat.includes('mergePullRequest(input:')) {
    const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
    const resolved = resolveGlobalId(store, pullRequestId);
    if (!resolved || !resolved.repo || resolved.number === null) {
      return { data: { mergePullRequest: null }, errors: [{ message: 'pull request not found' }] };
    }
    const pull = resolved.repo.pulls.get(resolved.number);
    if (!pull) return { data: { mergePullRequest: null }, errors: [{ message: 'pull request not found' }] };
    const { sha } = store.mergePull(resolved.repo, pull);
    return {
      data: {
        mergePullRequest: {
          pullRequest: { number: pull.number, merged: sha !== null, state: sha !== null ? 'MERGED' : 'OPEN' },
        },
      },
    };
  }

  if (flat.includes('addComment(input:')) {
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const body = typeof input.body === 'string' ? input.body : '';
    const resolved = resolveGlobalId(store, subjectId);
    if (!resolved || !resolved.repo || resolved.number === null) {
      return { data: { addComment: null }, errors: [{ message: 'subject not found' }] };
    }
    const issue = resolved.repo.issues.get(resolved.number);
    if (!issue) return { data: { addComment: null }, errors: [{ message: 'subject not found' }] };
    const comment = { id: store.nextCommentId(), body, createdAt: store.nowIso() };
    issue.comments.push(comment);
    return {
      data: {
        addComment: {
          commentEdge: {
            node: { id: globalId('C', [resolved.repo.id, issue.number, comment.id]), body },
          },
        },
      },
    };
  }

  // Repository-scoped queries.
  const owner = str('owner');
  const name = str('name');
  const repo = owner !== undefined && name !== undefined ? store.getRepo(owner, name) : undefined;

  if (flat.includes('databaseId')) {
    if (!repo) return { data: { repository: null } };
    return { data: { repository: repositoryNode(store, repo) } };
  }

  if (flat.includes('issues(first:$first,states:[OPEN]')) {
    if (!repo) return { data: { repository: null } };
    const first = num('first') ?? 10;
    const open = [...repo.issues.values()]
      .filter((issue) => issue.state === 'open')
      .sort((a, b) => b.number - a.number)
      .slice(0, first);
    return {
      data: { repository: { issues: { nodes: open.map((issue) => issueNode(store, repo, issue)) } } },
    };
  }

  if (flat.includes('issue(number:$number)')) {
    if (!repo) return { data: { repository: null } };
    const number = num('number');
    const issue = number !== undefined ? repo.issues.get(number) : undefined;
    return { data: { repository: { issue: issue ? issueNode(store, repo, issue) : null } } };
  }

  if (flat.includes('pullRequests(first:$first)')) {
    if (!repo) return { data: { repository: null } };
    const first = num('first') ?? 5;
    const open = [...repo.pulls.values()]
      .filter((pull) => pull.state === 'open')
      .sort((a, b) => b.number - a.number)
      .slice(0, first);
    return {
      data: { repository: { pullRequests: { nodes: open.map((pull) => pullNode(store, repo, pull)) } } },
    };
  }

  if (flat.includes('files(first:10)')) {
    if (!repo) return { data: { repository: null } };
    const number = num('number');
    const pull = number !== undefined ? repo.pulls.get(number) : undefined;
    if (!pull) return { data: { repository: { pullRequest: null } } };
    const files = store.pullFiles(repo, pull).slice(0, 10);
    return {
      data: {
        repository: {
          pullRequest: { number: pull.number, files: { nodes: files.map((file) => ({ path: file.path })) } },
        },
      },
    };
  }

  // A bare pull request read (the id a mutation input needs). This comes after
  // the files branch above: that document also contains pullRequest(number:).
  if (flat.includes('pullRequest(number:$number)')) {
    if (!repo) return { data: { repository: null } };
    const number = num('number');
    const pull = number !== undefined ? repo.pulls.get(number) : undefined;
    if (!pull) return { data: { repository: { pullRequest: null } } };
    return { data: { repository: { pullRequest: pullNode(store, repo, pull) } } };
  }

  if (flat.includes('issues(first:$first,after:$after)')) {
    if (!repo) return { data: { repository: null } };
    const first = num('first') ?? 5;
    const after = decodeCursor(variables.after);
    const ordered = [...repo.issues.values()].sort((a, b) => a.number - b.number);
    let start = 0;
    if (after !== null) {
      const index = ordered.findIndex((issue) => issue.number === after);
      start = index < 0 ? ordered.length : index + 1;
    }
    const page = ordered.slice(start, start + first);
    const hasNextPage = start + first < ordered.length;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]!.number) : null;
    return {
      data: {
        repository: {
          issues: {
            nodes: page.map((issue) => ({ number: issue.number })),
            pageInfo: { hasNextPage, endCursor },
          },
        },
      },
    };
  }

  return { data: {}, errors: [{ message: 'cannot execute query: unknown operation' }] };
}

/** POST /api/graphql: one operation, or a JSON array of operations answered in order. */
export function handleGraphQL(store: Store, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const responses = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return { data: null, errors: [{ message: 'a batched operation must be an object' }] };
      }
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = (record.variables ?? {}) as Variables;
      return execute(store, query, variables);
    });
    return { status: 200, body: responses };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { message: 'the GraphQL body must be a JSON object' } };
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  if (query === '') return { status: 400, body: { message: 'a query is required' } };
  const variables = (record.variables ?? {}) as Variables;
  return { status: 200, body: execute(store, query, variables) };
}
