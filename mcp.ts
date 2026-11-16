// The MCP endpoint at POST /mcp: JSON-RPC over streamable HTTP, modern era —
// `server/discover` answers identity, capabilities and supported versions in one call,
// and every later request is stateless (no session). The six tools github-mcp-server
// names, backed by the same store the REST and GraphQL surfaces use.

import {
  createIssue,
  createPull,
  createRepoRecord,
  learnedOwner,
  mergePull,
  repoFor,
  repos,
  type Repo,
} from './store.ts';

export const MCP_SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Record<string, unknown>) => unknown;
}

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = learnedOwner();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: owner },
  };
}

function issueJson(repo: Repo, issue: { number: number; title: string; body: string; state: string }): Record<string, unknown> {
  void repo;
  return { number: issue.number, title: issue.title, body: issue.body, state: issue.state };
}

function needRepo(args: Record<string, unknown>): Repo {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  const repo = repoFor(owner, name);
  if (repo === null) throw new Error(`repository not found: ${owner}/${name}`);
  return repo;
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (args) => {
      const name = String(args.name ?? '');
      const existing = repos.get(name);
      if (existing) return repoJson(existing);
      const repo = createRepoRecord(name, String(args.description ?? ''), args.private !== false);
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (args) => repoJson(needRepo(args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (args) => {
      const repo = needRepo(args);
      const issue = createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
      if ('error' in issue) throw new Error(issue.error);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = needRepo(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      return [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (args) => {
      const repo = needRepo(args);
      const pull = createPull(repo, String(args.title ?? ''), String(args.body ?? ''), String(args.head ?? ''), String(args.base ?? ''));
      if ('error' in pull) throw new Error(pull.error);
      return {
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
      };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const repo = needRepo(args);
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) throw new Error(`pull request not found: ${String(args.pull_number)}`);
      const result = mergePull(repo, pull);
      if ('error' in result) throw new Error(`merge failed: ${result.error}`);
      return { number: pull.number, merged: true, state: pull.state, sha: result.sha };
    },
  },
];

const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
}));

export interface McpOutcome {
  status: number;
  payload: unknown;
}

/** Handle one JSON-RPC request object. `id` is echoed verbatim. */
export function handleMcpRequest(request: Record<string, unknown>): McpOutcome {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const result = (value: unknown): McpOutcome => ({ status: 200, payload: { jsonrpc: '2.0', id, result: value } });
  const error = (code: number, message: string): McpOutcome => ({
    status: 200,
    payload: { jsonrpc: '2.0', id, error: { code, message } },
  });

  switch (method) {
    case 'server/discover':
      return result({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    case 'initialize':
      return result({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOL_LIST });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return error(-32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return error(-32602, `missing required arguments: ${missing.join(', ')}`);
      try {
        const value = tool.run(args);
        return result({
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (err) {
        return result({
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      if (method.startsWith('notifications/')) return { status: 202, payload: null };
      return error(-32601, `method not found: ${method}`);
  }
}
