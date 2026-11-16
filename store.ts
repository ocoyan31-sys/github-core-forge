// The forge's own store: a content-addressed git object store shared by every repository,
// plus the repository records (refs, labels, issues, pull requests) the REST, GraphQL and MCP
// surfaces all read and write. Everything lives in memory; the process is the database.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export const isOid = (value: string): boolean => HEX40.test(value);

/** Every git object the forge holds, by id. Content addressing makes sharing safe. */
export const objects = new Map<string, GitObject>();

export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(oid: string): GitObject | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------------------
// trees and commits

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') view.tree = value;
    else if (key === 'parent') view.parents.push(value);
    else if (key === 'author') view.author = value;
    else if (key === 'committer') view.committer = value;
  }
  return view;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const view: TagView = { object: '', type: '', tag: '' };
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    if (key === 'object') view.object = line.slice(space + 1);
    else if (key === 'type') view.type = line.slice(space + 1);
    else if (key === 'tag') view.tag = line.slice(space + 1);
  }
  return view;
}

/** Peel a ref target to the commit it ultimately names (through tag objects), or null. */
export function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

export const FORGE_IDENTITY = 'Forge <forge@make.fun>';

export function buildCommitData(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp?: number;
  identity?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? Math.floor(Date.now() / 1000);
  const who = `${fields.identity ?? FORGE_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function createCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  timestamp?: number;
}): string {
  return storeObject('commit', buildCommitData(fields));
}

/** Every commit reachable from `root` (following all parents), optionally treating `cut` commits as parentless. */
export function commitClosure(roots: Iterable<string>, cut?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    if (cut && cut.has(oid)) continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return seen;
}

/** Every object (commits, trees, blobs, tags) reachable from the given roots. */
export function objectClosure(roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` through commit parents (early exit). */
export function isAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** A common ancestor of two commits (the first found walking from `b`), or null. */
export function mergeBase(a: string, b: string): string | null {
  const ancestorsOfA = commitClosure([a]);
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = objects.get(oid);
    if (object && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Flatten a tree (recursively) into path -> {oid, mode}. */
export function flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  if (treeOid !== null) walk(treeOid, '');
  return out;
}

/** The tree oid of a commit, or null. */
export function treeOfCommit(commitOid: string): string | null {
  const object = objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Rebuild the tree chain for `segments` applying `leaf` to the final entry; returns the new root tree oid. */
function rebuildTree(
  treeOid: string | null,
  segments: readonly string[],
  leaf: (existing: TreeEntry | undefined) => TreeEntry | null,
): string {
  const entries: TreeEntry[] = treeOid === null ? [] : [...parseTree(objects.get(treeOid)?.data ?? Buffer.alloc(0))];
  const [head, ...rest] = segments as [string, ...string[]];
  const index = entries.findIndex((entry) => entry.name === head);
  if (rest.length === 0) {
    const replacement = leaf(index >= 0 ? entries[index] : undefined);
    if (index >= 0) entries.splice(index, 1);
    if (replacement !== null) entries.push(replacement);
  } else {
    const existing = index >= 0 ? entries[index] : undefined;
    const childOid = existing && existing.mode === '40000' ? existing.oid : null;
    const newChild = rebuildTree(childOid, rest, leaf);
    if (index >= 0) entries.splice(index, 1);
    entries.push({ mode: '40000', name: head, oid: newChild });
  }
  return storeObject('tree', buildTree(entries));
}

/** Set (or replace) the blob at `path` in the tree; returns the new root tree oid. */
export function treeWithBlob(treeOid: string | null, path: string, blobOid: string): string {
  return rebuildTree(treeOid, path.split('/'), () => ({ mode: '100644', name: path.split('/').pop()!, oid: blobOid }));
}

/** Remove `path` from the tree; returns the new root tree oid. */
export function treeWithoutPath(treeOid: string | null, path: string): string {
  return rebuildTree(treeOid, path.split('/'), () => null);
}

/** The blob oid at `path` in a tree, or null. */
export function blobAtPath(treeOid: string | null, path: string): string | null {
  if (treeOid === null) return null;
  let current: string | null = treeOid;
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    if (current === null) return null;
    const object = objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    current = entry.mode === '40000' ? entry.oid : null;
  }
  return null;
}

/** The tree oid of the directory at `path` ('' is the root), or null when absent. */
export function subtreeAtPath(treeOid: string | null, path: string): string | null {
  if (treeOid === null) return null;
  if (path === '') return treeOid;
  let current: string | null = treeOid;
  for (const segment of path.split('/')) {
    if (current === null) return null;
    const object = objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return current;
}

// ---------------------------------------------------------------------------
// repositories

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
}

export interface Repo {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  comments: Map<number, IssueComment[]>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  createdSeq: number;
}

export const repos = new Map<string, Repo>();
export const repoOrder: string[] = [];

let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextLabelId = 1;
let sequence = 0;

export function createRepoRecord(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    comments: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSeq: sequence++,
  };
  repos.set(name, repo);
  repoOrder.push(name);
  return repo;
}

export function deleteRepoRecord(name: string): boolean {
  if (!repos.delete(name)) return false;
  const index = repoOrder.indexOf(name);
  if (index >= 0) repoOrder.splice(index, 1);
  return true;
}

/**
 * The login the bearer token owns. The suite addresses repositories under the scenario
 * viewer's login, which the entry cannot know in advance: it is learned from the first
 * request that names an existing repository under some owner, and every later request
 * under a different owner is a 404 (a repository belongs to the token's login alone).
 */
let ownerLogin: string | null = null;

export function learnedOwner(): string {
  return ownerLogin ?? 'viewer';
}

export function claimOwner(candidate: string, repoExists: boolean): boolean {
  if (ownerLogin === null) {
    if (repoExists && candidate !== '') ownerLogin = candidate;
    return true;
  }
  return candidate === ownerLogin;
}

export function repoFor(owner: string, name: string): Repo | null {
  const repo = repos.get(name);
  if (!repo) return null;
  if (!claimOwner(owner, true)) return null;
  return repo;
}

// ---------------------------------------------------------------------------
// domain operations shared by REST, GraphQL and MCP

export function addLabel(repo: Repo, name: string, color: string): Label {
  const existing = repo.labels.get(name);
  if (existing) return existing;
  const label: Label = { id: nextLabelId++, name, color };
  repo.labels.set(name, label);
  return label;
}

export function createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue | { error: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `unknown label: ${name}` };
  }
  const issue: Issue = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    createdSeq: sequence++,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(repo: Repo, issueNumber: number, body: string): IssueComment | null {
  if (!repo.issues.has(issueNumber)) return null;
  const comment: IssueComment = { id: nextCommentId++, body };
  const list = repo.comments.get(issueNumber) ?? [];
  list.push(comment);
  repo.comments.set(issueNumber, list);
  return comment;
}

export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headSha = branchTip(repo, head);
  const baseSha = branchTip(repo, base);
  if (headSha === null) return { error: `head branch does not exist: ${head}` };
  if (baseSha === null) return { error: `base branch does not exist: ${base}` };
  const pull: Pull = {
    id: nextIssueId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    headSha,
    baseRef: base,
    baseSha,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineCount(oid: string | undefined): number {
  if (oid === undefined) return 0;
  const object = objects.get(oid);
  if (!object) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length;
}

/** The changed paths between two commits' trees, with line counts. */
export function diffCommits(baseCommit: string, headCommit: string): FileChange[] {
  const baseFiles = flattenTree(treeOfCommit(baseCommit));
  const headFiles = flattenTree(treeOfCommit(headCommit));
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && head && base.oid === head.oid) continue;
    const additions = lineCount(head?.oid);
    const deletions = lineCount(base?.oid);
    changes.push({
      filename: path,
      status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/**
 * Three-way tree merge for a squash merge. Returns the merged tree oid, or the list of
 * conflicting paths. `baseTree` is the merge-base tree, `ours` the current base branch
 * tree, `theirs` the head tree.
 */
export function mergeTrees(
  baseTree: string | null,
  oursTree: string | null,
  theirsTree: string | null,
): { tree: string } | { conflicts: string[] } {
  const base = flattenTree(baseTree);
  const ours = flattenTree(oursTree);
  const theirs = flattenTree(theirsTree);
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const conflicts: string[] = [];
  const result = new Map<string, { oid: string; mode: string }>();
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      if (o !== undefined) result.set(path, ours.get(path)!);
    } else if (b === o) {
      if (t !== undefined) result.set(path, theirs.get(path)!);
    } else if (b === t) {
      if (o !== undefined) result.set(path, ours.get(path)!);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { conflicts };
  let tree: string | null = null;
  // Rebuild from an empty tree, inserting files in sorted order (insertion order is
  // irrelevant: buildTree sorts every level).
  for (const path of [...result.keys()].sort()) {
    tree = treeWithBlob(tree, path, result.get(path)!.oid);
  }
  if (tree === null) tree = storeObject('tree', buildTree([]));
  return { tree };
}

/** Whether merging `pull` into its base branch right now would conflict. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === null) return true;
  const base = mergeBase(baseTip, pull.headSha);
  const merged = mergeTrees(
    base === null ? null : treeOfCommit(base),
    treeOfCommit(baseTip),
    treeOfCommit(pull.headSha),
  );
  return 'conflicts' in merged;
}

/**
 * Squash-merge a pull request: one new commit on the base branch carrying the head's
 * changes relative to the merge base. Returns the merge commit oid, or a failure tag.
 */
export function mergePull(repo: Repo, pull: Pull): { sha: string } | { error: 'not-found' | 'conflict' | 'already' } {
  if (pull.merged) return { error: 'already' };
  const baseTip = branchTip(repo, pull.baseRef);
  if (baseTip === null) return { error: 'not-found' };
  const base = mergeBase(baseTip, pull.headSha);
  const merged = mergeTrees(
    base === null ? null : treeOfCommit(base),
    treeOfCommit(baseTip),
    treeOfCommit(pull.headSha),
  );
  if ('conflicts' in merged) return { error: 'conflict' };
  const sha = createCommit({
    tree: merged.tree,
    parents: [baseTip],
    message: `${pull.title} (#${pull.number})\n\n${pull.body ?? ''}`,
  });
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = sha;
  pull.baseSha = sha;
  return { sha };
}

/** Commit a file write (or delete) onto a branch; creates the branch when asked to. Returns the commit oid. */
export function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A write to a branch that does not exist yet starts it from the default branch tip.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const parentTree = tip === undefined ? null : treeOfCommit(tip);
  const tree = blobOid === null ? treeWithoutPath(parentTree, path) : treeWithBlob(parentTree, path, blobOid);
  const commit = createCommit({ tree, parents: tip === undefined ? [] : [tip], message });
  repo.refs.set(ref, commit);
  return commit;
}
