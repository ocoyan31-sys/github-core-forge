// GraphQL v4 at POST /api/graphql: a small parser and executor covering exactly the
// documents gh and github-mcp-server send — viewer, repository fields, __type probes,
// issue/pull reads, the create/close/merge/comment mutations, node(id:), batched
// operations and cursor pagination. No library; the grammar subset is: operations with
// names and variable definitions, fields with aliases and arguments, inline fragments,
// fragment definitions and spreads, and string/int/boolean/null/enum/list/object values.

import {
  addComment as addCommentViaStore,
  branchTip,
  createIssue,
  createPull,
  diffCommits,
  learnedOwner,
  mergePull,
  pullConflicts,
  repoFor,
  repos,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// global ids: opaque, stable, and never the plain database id

function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export const repoGlobalId = (repo: Repo): string => globalId('Repository', String(repo.id));
export const issueGlobalId = (repo: Repo, issue: Issue): string => globalId('Issue', `${repo.id}:${issue.number}`);
export const pullGlobalId = (repo: Repo, pull: Pull): string => globalId('PullRequest', `${repo.id}:${pull.number}`);
export const commentGlobalId = (id: number): string => globalId('IssueComment', String(id));
export const userGlobalId = (login: string): string => globalId('User', login);

function repoByGlobalId(id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  for (const repo of repos.values()) if (repo.id === Number(parsed.key)) return repo;
  return null;
}

function issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':');
  for (const repo of repos.values()) {
    if (repo.id === Number(repoId)) {
      const issue = repo.issues.get(Number(number));
      return issue ? { repo, issue } : null;
    }
  }
  return null;
}

function pullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':');
  for (const repo of repos.values()) {
    if (repo.id === Number(repoId)) {
      const pull = repo.pulls.get(Number(number));
      return pull ? { repo, pull } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!$=@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let text = '';
      while (i < source.length && /[0-9.eE+-]/.test(source[i])) {
        text += source[i];
        i += 1;
      }
      if (text.includes('.') || text.includes('e') || text.includes('E')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: Number.parseInt(text, 10) });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let name = '';
      while (i < source.length && /[_0-9A-Za-z]/.test(source[i])) {
        name += source[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value: name });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: { name: string; value: Value }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.expectName();
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipBalancedParens();
        // directives
        while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
          this.next();
          this.expectName();
          if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipBalancedParens();
        }
        operations.push({ type: keyword === 'mutation' ? 'mutation' : 'query', name, selection: this.parseSelectionSet() });
        continue;
      }
      if (keyword === 'fragment') {
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('fragment without on');
        const typeCondition = this.expectName();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${keyword}`);
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next !== undefined && next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      return { kind: 'spread', name: this.expectName() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      for (;;) {
        if (this.skipPunct(')')) break;
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    // directives on fields are not used by the suite's documents; skip if present
    while (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipBalancedParens();
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      for (;;) {
        if (this.skipPunct(']')) break;
        items.push(this.parseValue());
      }
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: Value }[] = [];
      for (;;) {
        if (this.skipPunct('}')) break;
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function evaluate(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evaluate(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evaluate(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema tables for introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'labels', 'comments', 'repository', 'assignees', 'milestone'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'mergeCommit', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url', 'labels', 'refs', 'ref', 'object', 'collaborators'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'],
  Organization: ['id', 'login', 'name', 'url'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
};

// ---------------------------------------------------------------------------
// typed values the executor walks

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

const gql = (type: string, fields: Record<string, unknown>): GqlObject => ({ __type: type, ...fields });

function userObject(login: string): GqlObject {
  return gql('User', { id: userGlobalId(login), login, name: login });
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return gql('Issue', {
    id: issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    __repo: repo,
    __issue: issue,
  });
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return gql('PullRequest', {
    id: pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pull.merged ? 'UNKNOWN' : pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    __repo: repo,
    __pull: pull,
  });
}

function repoObject(repo: Repo): GqlObject {
  const owner = learnedOwner();
  const defaultTip = branchTip(repo, repo.defaultBranch);
  return gql('Repository', {
    id: repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    __repo: repo,
    __defaultBranchRef: defaultTip === null ? null : gql('Ref', { id: globalId('Ref', `${repo.id}:${repo.defaultBranch}`), name: repo.defaultBranch, prefix: 'refs/heads/' }),
  });
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const descending = orderBy?.direction === 'DESC';
  list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const total = list.length;
  let startIndex = 0;
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after !== '') {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) {
        const afterNumber = Number(match[1]);
        const index = list.findIndex((issue) => issue.number === afterNumber);
        if (index >= 0) startIndex = index + 1;
      }
    } catch {
      // an opaque cursor we do not recognise starts from the beginning
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : total;
  const page = list.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < total;
  const endCursor = page.length > 0 ? Buffer.from(`cursor:${page[page.length - 1].number}`, 'utf8').toString('base64') : null;
  return gql('IssueConnection', {
    nodes: page.map((issue) => issueObject(repo, issue)),
    totalCount: total,
    pageInfo: gql('PageInfo', { hasNextPage, hasPreviousPage: startIndex > 0, endCursor, startCursor: endCursor }),
  });
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
  return gql('PullRequestConnection', {
    nodes: list.slice(0, first).map((pull) => pullObject(repo, pull)),
    totalCount: list.length,
    pageInfo: gql('PageInfo', { hasNextPage: list.length > first, hasPreviousPage: false, endCursor: null, startCursor: null }),
  });
}

// ---------------------------------------------------------------------------
// executor

interface ExecContext {
  document: Document;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

const KNOWN_FIELDS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    Query: ['viewer', 'repository', 'node', '__type', '__schema', '__typename'],
    Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
    Repository: [...(TYPE_FIELDS.Repository ?? []), 'owner'],
    Issue: TYPE_FIELDS.Issue ?? [],
    PullRequest: TYPE_FIELDS.PullRequest ?? [],
    User: TYPE_FIELDS.User ?? [],
    Organization: TYPE_FIELDS.Organization ?? [],
    Ref: TYPE_FIELDS.Ref ?? [],
    PageInfo: TYPE_FIELDS.PageInfo ?? [],
    IssueComment: TYPE_FIELDS.IssueComment ?? [],
    PullRequestChangedFile: TYPE_FIELDS.PullRequestChangedFile ?? [],
    IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
    __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'specifiedByURL'],
    __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
    __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
    __InputValue: ['name', 'description', 'type', 'defaultValue'],
    CreateIssuePayload: ['issue', 'clientMutationId'],
    CloseIssuePayload: ['issue', 'clientMutationId'],
    CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
    MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
    AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
    CommentEdge: ['node', 'cursor'],
  }).map(([type, fields]) => [type, new Set(fields)]),
);

function resolveField(
  ctx: ExecContext,
  type: string,
  source: GqlObject | null,
  field: FieldNode,
): unknown {
  const name = field.name;
  if (name === '__typename') return type;
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = evaluate(arg.value, ctx.variables);

  switch (type) {
    case 'Query': {
      if (name === 'viewer') return userObject(learnedOwner());
      if (name === 'repository') {
        const repo = repoFor(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : repoObject(repo);
      }
      if (name === 'node') return resolveNode(String(args.id ?? ''));
      if (name === '__type') return typeObject(String(args.name ?? ''));
      return undefined;
    }
    case 'Mutation': {
      return resolveMutation(ctx, name, args);
    }
    case 'Repository': {
      const repo = source!.__repo as Repo;
      if (name === 'owner') return userObject(learnedOwner());
      if (name === 'defaultBranchRef') return source!.__defaultBranchRef ?? null;
      if (name === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObject(repo, issue) : null;
      }
      if (name === 'issues') return issueConnection(repo, args);
      if (name === 'pullRequest') {
        const pull = repo.pulls.get(Number(args.number));
        return pull ? pullObject(repo, pull) : null;
      }
      if (name === 'pullRequests') return pullConnection(repo, args);
      return source![name];
    }
    case 'PullRequest': {
      if (name === 'files') {
        const repo = source!.__repo as Repo;
        const pull = source!.__pull as Pull;
        const changes = diffCommits(pull.baseSha, pull.headSha);
        const first = typeof args.first === 'number' ? args.first : changes.length;
        return gql('PullRequestChangedFileConnection', {
          nodes: changes.slice(0, first).map((change) =>
            gql('PullRequestChangedFile', { path: change.filename, additions: change.additions, deletions: change.deletions, changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED' }),
          ),
          totalCount: changes.length,
        });
      }
      return source![name];
    }
    case '__Type': {
      if (name === 'fields') {
        const typeName = source!.__typeName as string;
        return (TYPE_FIELDS[typeName] ?? []).map((fieldName) => gql('__Field', { name: fieldName, description: null, isDeprecated: false, deprecationReason: null }));
      }
      if (name === 'enumValues') {
        const typeName = source!.__typeName as string;
        return (TYPE_ENUMS[typeName] ?? []).map((value) => gql('__EnumValue', { name: value, description: null, isDeprecated: false, deprecationReason: null }));
      }
      return source![name];
    }
    default:
      return source === null ? undefined : source[name];
  }
}

function typeObject(name: string): GqlObject | null {
  const known = name in TYPE_FIELDS || name in TYPE_ENUMS || name === 'Query' || name === 'Mutation';
  if (!known) return null;
  return gql('__Type', {
    name,
    kind: TYPE_KIND[name] ?? 'OBJECT',
    description: null,
    __typeName: name,
  });
}

function resolveNode(id: string): GqlObject | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoByGlobalId(id);
    return repo === null ? null : repoObject(repo);
  }
  if (parsed.kind === 'Issue') {
    const found = issueByGlobalId(id);
    return found === null ? null : issueObject(found.repo, found.issue);
  }
  if (parsed.kind === 'PullRequest') {
    const found = pullByGlobalId(id);
    return found === null ? null : pullObject(found.repo, found.pull);
  }
  if (parsed.kind === 'User') return userObject(parsed.key);
  return null;
}

function resolveMutation(ctx: ExecContext, name: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const repo = repoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found for createIssue' });
        return null;
      }
      const issue = createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if ('error' in issue) {
        ctx.errors.push({ message: issue.error });
        return null;
      }
      return gql('CreateIssuePayload', { issue: issueObject(repo, issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'closeIssue': {
      const found = issueByGlobalId(String(input.issueId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'issue not found for closeIssue' });
        return null;
      }
      found.issue.state = 'closed';
      return gql('CloseIssuePayload', { issue: issueObject(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null });
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(String(input.repositoryId ?? ''));
      if (repo === null) {
        ctx.errors.push({ message: 'repository not found for createPullRequest' });
        return null;
      }
      const pull = createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
      if ('error' in pull) {
        ctx.errors.push({ message: pull.error });
        return null;
      }
      return gql('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'mergePullRequest': {
      const found = pullByGlobalId(String(input.pullRequestId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'pull request not found for mergePullRequest' });
        return null;
      }
      const result = mergePull(found.repo, found.pull);
      if ('error' in result) {
        ctx.errors.push({ message: `merge failed: ${result.error}` });
        return gql('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
      }
      return gql('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null });
    }
    case 'addComment': {
      const found = issueByGlobalId(String(input.subjectId ?? ''));
      if (found === null) {
        ctx.errors.push({ message: 'subject not found for addComment' });
        return null;
      }
      const body = String(input.body ?? '');
      const created = addCommentViaStore(found.repo, found.issue.number, body);
      if (created === null) {
        ctx.errors.push({ message: 'could not add comment' });
        return null;
      }
      return gql('AddCommentPayload', {
        commentEdge: gql('CommentEdge', {
          node: gql('IssueComment', { id: commentGlobalId(created.id), body: created.body }),
          cursor: '',
        }),
        clientMutationId: input.clientMutationId ?? null,
      });
    }
    default:
      return undefined;
  }
}

function executeSelection(
  ctx: ExecContext,
  type: string,
  source: GqlObject | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === type) {
        Object.assign(out, executeSelection(ctx, type, source, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment && fragment.typeCondition === type) {
        Object.assign(out, executeSelection(ctx, type, source, fragment.selection));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const known = KNOWN_FIELDS[type];
    if (known !== undefined && !known.has(selection.name) && selection.name !== '__typename') {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${type}'` });
      out[key] = null;
      continue;
    }
    const value = resolveField(ctx, type, source, selection);
    out[key] = completeValue(ctx, value, selection);
  }
  return out;
}

function completeValue(ctx: ExecContext, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
    const object = value as GqlObject;
    if (field.selection === null) return object;
    return executeSelection(ctx, object.__type, object, field.selection);
  }
  return value;
}

/** Execute one operation document; returns the GraphQL response body. */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): {
  status: number;
  payload: unknown;
} {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { status: 200, payload: { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] } };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation =
    document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) {
    return { status: 200, payload: { errors: [{ message: 'no operation in document' }] } };
  }
  const ctx: ExecContext = { document, variables, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selection);
  const payload: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) payload.errors = ctx.errors;
  return { status: 200, payload };
}
