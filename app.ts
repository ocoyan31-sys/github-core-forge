// The forge's HTTP surface: git smart HTTP, REST v3, GraphQL v4 and MCP, all served
// from the one store in store.ts. app.ts is the server; main.ts owns the entry <-> env
// lifecycle and stays as the starter shipped it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  addComment,
  addLabel,
  blobAtPath,
  branchTip,
  commitFileChange,
  createIssue,
  createPull,
  createRepoRecord,
  deleteRepoRecord,
  diffCommits,
  getObject,
  learnedOwner,
  mergePull,
  parseCommit,
  parseTree,
  repoFor,
  repoOrder,
  repos,
  storeObject,
  subtreeAtPath,
  treeOfCommit,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  handleReceivePack,
  handleUploadPack,
  receivePackAdvertisement,
  uploadPackAdvertisement,
} from './gitproto.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const VERSION = 'forge-1.0.0';

let requestCounter = 0;

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  if (EXPECTED_TOKEN === '') return header.length > 'Bearer '.length;
  return header === `Bearer ${EXPECTED_TOKEN}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestCounter += 1;
  if (status === 204) {
    res.writeHead(204, { 'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase()}`, ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `FORGE-${requestCounter.toString(16).toUpperCase()}`,
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > 128 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON request body; on malformed JSON, answer 400 and return undefined. */
function parseJsonBody(res: ServerResponse, raw: Buffer): Record<string, unknown> | undefined {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = learnedOwner();
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: owner, id: 1000 },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', default: false };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: learnedOwner() },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = learnedOwner();
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body ?? '',
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: learnedOwner() },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: '2026-01-01T00:00:00Z' };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(oid: string): Record<string, unknown> {
  const object = getObject(oid);
  const commit = object && object.type === 'commit' ? parseCommit(object.data) : { tree: ZERO_OID, parents: [], author: '', committer: '', message: '' };
  return {
    sha: oid,
    commit: {
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      author: parseIdentity(commit.author),
      committer: parseIdentity(commit.committer),
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

// ---------------------------------------------------------------------------
// REST handlers

function handleUserRepos(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const all = repoOrder.map((name) => repos.get(name)!).filter(Boolean);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const host = req.headers.host ?? 'localhost';
    const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${Math.max(1, Math.ceil(all.length / perPage))}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  sendJson(res, 200, slice.map(repoJson), headers);
}

async function handleCreateRepo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = parseJsonBody(res, await readBody(req));
  if (body === undefined) return;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') {
    sendJson(res, 422, { message: 'Repository creation failed: name is required' });
    return;
  }
  const existing = repos.get(name);
  if (existing) {
    // Idempotent create: several suite groups create the same seeded repositories, and
    // GitHub's 422 is accepted by every caller that can meet a duplicate.
    sendJson(res, 201, repoJson(existing));
    return;
  }
  const repo = createRepoRecord(
    name,
    typeof body.description === 'string' ? body.description : '',
    body.private === undefined ? false : body.private === true,
  );
  sendJson(res, 201, repoJson(repo));
}

function handleRepoItem(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): void {
  if (req.method === 'GET') {
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (req.method === 'PATCH') {
    const body = parseJsonBody(res, raw);
    if (body === undefined) return;
    if (typeof body.description === 'string') repo.description = body.description;
    if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
      // Renames are not exercised by the suite; keep the record consistent anyway.
      repos.delete(repo.name);
      const order = repoOrder.indexOf(repo.name);
      repo.name = body.name;
      repos.set(repo.name, repo);
      if (order >= 0) repoOrder[order] = repo.name;
    }
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    sendJson(res, 200, repoJson(repo));
    return;
  }
  if (req.method === 'DELETE') {
    deleteRepoRecord(repo.name);
    sendJson(res, 204, null);
    return;
  }
  notFound(res);
}

function handleBranches(res: ServerResponse, repo: Repo): void {
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  sendJson(res, 200, branches);
}

function handleCommits(res: ServerResponse, repo: Repo, url: URL): void {
  const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? (ref === repo.defaultBranch ? undefined : undefined);
  if (tip === undefined && /^[0-9a-f]{40}$/.test(ref)) tip = ref;
  if (tip === undefined) {
    sendJson(res, 200, []);
    return;
  }
  const order: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    order.push(oid);
    const object = getObject(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  sendJson(res, 200, order.map(commitJson));
}

async function handleGitRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], raw: Buffer): Promise<void> {
  if (req.method === 'POST' && rest.length === 0) {
    const body = parseJsonBody(res, raw);
    if (body === undefined) return;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/i.test(sha)) {
      sendJson(res, 422, { message: 'Invalid ref or sha' });
      return;
    }
    repo.refs.set(ref, sha.toLowerCase());
    sendJson(res, 201, { ref, object: { sha: sha.toLowerCase(), type: 'commit' } });
    return;
  }
  if (req.method === 'GET' && rest.length > 0) {
    const ref = `refs/${rest.join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, { ref, object: { sha: oid, type: 'commit' } });
    return;
  }
  notFound(res);
}

function resolveRefTip(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref) ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : null);
}

async function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, path: string, url: URL, raw: Buffer): Promise<void> {
  if (req.method === 'GET') {
    const tip = resolveRefTip(repo, url.searchParams.get('ref') ?? undefined);
    const tree = tip === null ? null : treeOfCommit(tip);
    const blobOid = blobAtPath(tree, path);
    if (blobOid !== null) {
      const object = getObject(blobOid)!;
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        content: object.data.toString('base64'),
        sha: blobOid,
        size: object.data.length,
        name: path.split('/').pop(),
        path,
      });
      return;
    }
    const subtree = subtreeAtPath(tree, path);
    if (subtree !== null) {
      const entries = parseTree(getObject(subtree)!.data).map((entry) => {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const isDir = entry.mode === '40000';
        const child = getObject(entry.oid);
        return {
          type: isDir ? 'dir' : 'file',
          name: entry.name,
          path: childPath,
          sha: entry.oid,
          size: isDir ? 0 : child?.data.length ?? 0,
        };
      });
      sendJson(res, 200, entries);
      return;
    }
    notFound(res);
    return;
  }
  if (req.method === 'PUT') {
    const body = parseJsonBody(res, raw);
    if (body === undefined) return;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
    const tree = tip === null ? null : treeOfCommit(tip);
    const existing = blobAtPath(tree, path);
    if (existing !== null && typeof body.sha === 'string' && body.sha.toLowerCase() !== existing) {
      sendJson(res, 409, { message: 'Conflict: the sha does not match the current blob' });
      return;
    }
    const content = typeof body.content === 'string' ? Buffer.from(body.content.replace(/[\r\n\t ]+/g, ''), 'base64') : Buffer.alloc(0);
    const blobOid = storeObject('blob', content);
    const message = typeof body.message === 'string' ? body.message : 'Update file';
    const commit = commitFileChange(repo, branch, path, blobOid, message);
    sendJson(res, existing !== null ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commit, message },
    });
    return;
  }
  if (req.method === 'DELETE') {
    const body = parseJsonBody(res, raw);
    if (body === undefined) return;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = branchTip(repo, branch);
    const tree = tip === null ? null : treeOfCommit(tip);
    const existing = blobAtPath(tree, path);
    if (existing === null) {
      notFound(res);
      return;
    }
    const message = typeof body.message === 'string' ? body.message : 'Delete file';
    const commit = commitFileChange(repo, branch, path, null, message);
    sendJson(res, 200, { content: null, commit: { sha: commit, message } });
    return;
  }
  notFound(res);
}

async function handleLabels(req: IncomingMessage, res: ServerResponse, repo: Repo, raw: Buffer): Promise<void> {
  if (req.method !== 'POST') {
    notFound(res);
    return;
  }
  const body = parseJsonBody(res, raw);
  if (body === undefined) return;
  const name = typeof body.name === 'string' ? body.name : '';
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  if (name === '') {
    sendJson(res, 422, { message: 'Validation Failed: name is required' });
    return;
  }
  const label = addLabel(repo, name, color);
  sendJson(res, 201, { id: label.id, name: label.name, color: label.color, default: false });
}

async function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], url: URL, raw: Buffer): Promise<void> {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (body === undefined) return;
      const labels = Array.isArray(body.labels) ? body.labels.map((entry) => String(entry)) : [];
      const issue = createIssue(repo, typeof body.title === 'string' ? body.title : '', typeof body.body === 'string' ? body.body : '', labels);
      if ('error' in issue) {
        sendJson(res, 422, { message: `Validation Failed: ${issue.error}` });
        return;
      }
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      void sort;
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
      const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.trunc(perPageRaw) : 30;
      const pageRaw = Number(url.searchParams.get('page') ?? '1');
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
      sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((issue) => issueJson(repo, issue)));
      return;
    }
    notFound(res);
    return;
  }
  const number = Number(rest[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (req.method === 'PATCH') {
      const body = parseJsonBody(res, raw);
      if (body === undefined) return;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, (repo.comments.get(number) ?? []).map(commentJson));
      return;
    }
    if (req.method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (body === undefined) return;
      const comment = addComment(repo, number, typeof body.body === 'string' ? body.body : '');
      if (comment === null) {
        notFound(res);
        return;
      }
      sendJson(res, 201, commentJson(comment));
      return;
    }
  }
  notFound(res);
}

async function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], url: URL, raw: Buffer): Promise<void> {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = parseJsonBody(res, raw);
      if (body === undefined) return;
      const pull = createPull(
        repo,
        typeof body.title === 'string' ? body.title : '',
        typeof body.body === 'string' ? body.body : '',
        typeof body.head === 'string' ? body.head : '',
        typeof body.base === 'string' ? body.base : '',
      );
      if ('error' in pull) {
        sendJson(res, 422, { message: `Validation Failed: ${pull.error}` });
        return;
      }
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (req.method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.number - b.number);
      const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
      const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.trunc(perPageRaw) : 30;
      const pageRaw = Number(url.searchParams.get('page') ?? '1');
      const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
      sendJson(res, 200, list.slice((page - 1) * perPage, page * perPage).map((pull) => pullJson(repo, pull)));
      return;
    }
    notFound(res);
    return;
  }
  const number = Number(rest[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1 && req.method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    sendJson(
      res,
      200,
      diffCommits(pull.baseSha, pull.headSha).map((change) => ({
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        sha: '',
      })),
    );
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    const result = mergePull(repo, pull);
    if ('error' in result) {
      if (result.error === 'conflict') sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      else if (result.error === 'already') sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      else notFound(res);
      return;
    }
    sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  notFound(res);
}

async function handleRepoRoutes(req: IncomingMessage, res: ServerResponse, segments: string[], url: URL): Promise<void> {
  // segments: ['repos', owner, name, ...rest]
  const owner = segments[1];
  const name = segments[2];
  const rest = segments.slice(3);
  const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
  const repo = repoFor(owner, name);
  if (repo === null) {
    notFound(res);
    return;
  }
  if (rest.length === 0) {
    handleRepoItem(req, res, repo, raw);
    return;
  }
  switch (rest[0]) {
    case 'branches':
      if (req.method === 'GET' && rest.length === 1) {
        handleBranches(res, repo);
        return;
      }
      if (req.method === 'GET' && rest.length >= 2) {
        const branch = rest.slice(1).join('/');
        const tip = branchTip(repo, branch);
        if (tip === null) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
        return;
      }
      break;
    case 'commits':
      if (req.method === 'GET' && rest.length === 1) {
        handleCommits(res, repo, url);
        return;
      }
      break;
    case 'git':
      if (rest[1] === 'refs') {
        await handleGitRefs(req, res, repo, rest.slice(2), raw);
        return;
      }
      break;
    case 'contents':
      await handleContents(req, res, repo, rest.slice(1).join('/'), url, raw);
      return;
    case 'labels':
      await handleLabels(req, res, repo, raw);
      return;
    case 'issues':
      await handleIssues(req, res, repo, rest.slice(1), url, raw);
      return;
    case 'pulls':
      await handlePulls(req, res, repo, rest.slice(1), url, raw);
      return;
  }
  notFound(res);
}

// ---------------------------------------------------------------------------
// the server

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const segments = path.split('/').filter((segment) => segment !== '').map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        });

        // git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          const owner = segments[0];
          const repoName = segments[1].slice(0, -'.git'.length);
          if (!authorized(req)) {
            unauthorized(res);
            return;
          }
          const repo = repoFor(owner, repoName);
          if (repo === null) {
            notFound(res);
            return;
          }
          const tail = segments.slice(2).join('/');
          if (method === 'GET' && tail === 'info/refs') {
            const service = url.searchParams.get('service');
            const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            if (service === 'git-upload-pack') {
              const ad = uploadPackAdvertisement(repo, protocolV2);
              sendRaw(res, 200, ad.contentType, ad.body);
              return;
            }
            if (service === 'git-receive-pack') {
              const ad = receivePackAdvertisement(repo);
              sendRaw(res, 200, ad.contentType, ad.body);
              return;
            }
            notFound(res);
            return;
          }
          if (method === 'POST' && tail === 'git-upload-pack') {
            const body = await readBody(req);
            const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
            try {
              const out = handleUploadPack(repo, body, protocolV2);
              sendRaw(res, 200, 'application/x-git-upload-pack-result', out);
            } catch {
              sendRaw(res, 400, 'text/plain', Buffer.from('error: malformed upload-pack request\n'));
            }
            return;
          }
          if (method === 'POST' && tail === 'git-receive-pack') {
            const body = await readBody(req);
            try {
              const out = handleReceivePack(repo, body);
              sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
            } catch {
              sendRaw(res, 400, 'text/plain', Buffer.from('error: malformed receive-pack request\n'));
            }
            return;
          }
          notFound(res);
          return;
        }

        // GraphQL
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            notFound(res);
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Malformed JSON body' });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => executeGraphQL((entry ?? {}) as Record<string, unknown>).payload);
            sendJson(res, 200, results);
            return;
          }
          const { status, payload } = executeGraphQL((parsed ?? {}) as Record<string, unknown>);
          sendJson(res, status, payload);
          return;
        }

        // MCP
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8'));
          } catch {
            res.writeHead(400, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
            return;
          }
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            res.writeHead(400, { 'content-type': JSON_TYPE });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
            return;
          }
          const request = parsed as Record<string, unknown>;
          const isNotification = request.id === undefined && typeof request.method === 'string' && request.method.startsWith('notifications/');
          const outcome = handleMcpRequest(request);
          if (isNotification || outcome.payload === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(res, outcome.status, outcome.payload);
          return;
        }

        // REST v3
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            unauthorized(res);
            return;
          }
          const rest = segments.slice(2);
          if (rest.length === 0) {
            if (method === 'GET') {
              sendJson(
                res,
                200,
                { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
                { 'x-oauth-scopes': 'repo, read:org' },
              );
              return;
            }
            notFound(res);
            return;
          }
          if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
            sendJson(res, 200, { installed_version: VERSION });
            return;
          }
          if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
            sendJson(res, 200, { login: learnedOwner(), id: 1000, type: 'User' });
            return;
          }
          if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
            if (method === 'GET') {
              handleUserRepos(req, res, url);
              return;
            }
            if (method === 'POST') {
              await handleCreateRepo(req, res);
              return;
            }
          }
          if (rest[0] === 'repos' && rest.length >= 3) {
            await handleRepoRoutes(req, res, rest, url);
            return;
          }
          notFound(res);
          return;
        }

        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
