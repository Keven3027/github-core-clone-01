// TEMPORARY shared store + git bottom-layer stand-in.
//
// TODO(integration): the git agent owns `src/model.ts` + `src/gitcore.ts`. Once model.ts lands, the
// orchestrator swaps this file out (rest.ts / graphql.ts / mcp.ts / selftest-api.ts import their shared
// symbols only from here, so a re-export shim or an import-path change is enough). The interfaces used by
// the API layers are:
//   - `forge` (the Forge singleton, SPEC.md's shared data model)
//   - the gitOps-style functions below: branchTip/getFile/listDir/listCommits/createBranch/upsertFile/
//     deleteFile/squashMerge/diffFiles
//   - the record helpers and the JSON serializers (repoJson/issueJson/pullJson/labelJson/commentJson)
//     that give every surface the same object shapes.
//
// The mock git model keeps, per commit, a whole-tree snapshot (path -> blob). Copy-on-write per commit:
// cheap at trial scale (hundreds of small commits), and it makes contents reads, directory listings,
// squash merges and pull diffs trivial. TODO(integration): replace with the real object/ref model.

import { createHash } from 'node:crypto';
import { isoNow } from './http-util.ts';

// ---------------------------------------------------------------------------------------------
// The shared data model (SPEC.md's skeleton, with mock-only extras clearly marked).
// ---------------------------------------------------------------------------------------------

export interface Blob { data: Buffer }
export interface TreeEntry { mode: string; name: string; sha: string }

export interface Issue {
  id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null; user: string;
}

export interface Pull {
  id: string; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; head: string; base: string; createdAt: string; user: string; mergeCommitSha: string | null;
  // mock-only extras
  headSha: string; baseSha: string; mergedAt: string | null; updatedAt: string;
}

export interface Label { name: string; color: string; description: string | null }

export interface Comment { id: number; body: string; user: string; createdAt: string; updatedAt: string }

/** One mock commit: a whole-tree snapshot plus the commit metadata REST reads back. */
export interface MockCommit {
  sha: string; parents: string[]; message: string; when: string;
  snapshot: Map<string, { sha: string; data: Buffer }>;
}

export interface RepoData {
  owner: string; name: string; description: string | null;
  defaultBranch: string; private: boolean;
  createdAt: string; updatedAt: string; pushedAt: string;
  refs: Map<string, string>;                                        // 'refs/heads/main' -> commit sha
  objects: Map<string, { type: 'blob' | 'tree' | 'commit'; data: Buffer }>;
  issues: Issue[]; pulls: Pull[]; labels: Label[];
  // ---- mock-only extras (TODO(integration): the real model/gitcore provides these) ----
  id: number;                                                       // the numeric database id
  nextNumber: number;                                               // issues and pulls share GitHub's numbering
  nextCommentId: number;
  comments: Map<number, Comment[]>;                                 // issue number -> comments
  commits: Map<string, MockCommit>;                                 // mock commit store
}

export class Forge {
  repos: Map<string, RepoData> = new Map();
  login = '';

  private nextRepoId = 1;

  createRepo(owner: string, name: string, description: string | null = null): RepoData {
    const now = isoNow();
    const repo: RepoData = {
      owner, name, description,
      defaultBranch: 'main', private: true,
      createdAt: now, updatedAt: now, pushedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: [], pulls: [], labels: [],
      id: this.nextRepoId++,
      nextNumber: 1, nextCommentId: 1,
      comments: new Map(),
      commits: new Map(),
    };
    this.repos.set(`${owner}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoData | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): void {
    this.repos.delete(`${owner}/${name}`);
  }

  repoByDatabaseId(id: number): RepoData | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}

/** The global singleton every surface shares. */
export const forge = new Forge();

/** The login the bearer token names (main.ts injects Forge.login; a fallback keeps selftests simple). */
export function ownerLogin(): string {
  return forge.login !== '' ? forge.login : (process.env.MAKEFUN_SHOP_TOKEN ?? 'MAKEFUN_SHOP_TOKEN');
}

// ---------------------------------------------------------------------------------------------
// Global ids (the REST node_id and the GraphQL id are the same opaque string).
// ---------------------------------------------------------------------------------------------

export function gidOf(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].map(String).join(':'), 'utf8').toString('base64');
}

export function decodeGid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    return parts.length > 0 && parts[0] !== '' ? parts : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// gitOps-style bottom layer (TODO(integration): backed by the real gitcore).
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  sha: string; parents: string[]; message: string; when: string;
  author: { name: string; email: string; when: string };
}

export interface DiffFile {
  filename: string; status: 'added' | 'modified' | 'removed';
  additions: number; deletions: number; changes: number; sha: string;
}

export interface DirEntry { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }

function headRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The commit sha a branch points at, or null. */
export function branchTip(repo: RepoData, branch: string): string | null {
  return repo.refs.get(headRef(branch)) ?? null;
}

function snapshotOf(repo: RepoData, branch: string): Map<string, { sha: string; data: Buffer }> | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  return repo.commits.get(tip)?.snapshot ?? null;
}

function gitBlobSha(data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`blob ${data.length}\u0000`);
  hash.update(data);
  return hash.digest('hex');
}

function createCommit(repo: RepoData, snapshot: Map<string, { sha: string; data: Buffer }>, parents: string[], message: string): string {
  const when = isoNow();
  const key = [...snapshot.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, blob]) => `${path}\u0000${blob.sha}`).join('\n');
  const sha = createHash('sha1').update(`commit\u0000${key}\u0000${parents.join(',')}\u0000${message}\u0000${when}\u0000${repo.commits.size}`).digest('hex');
  repo.commits.set(sha, { sha, parents, message, when, snapshot });
  repo.objects.set(sha, { type: 'commit', data: Buffer.from(`${key}\n${message}`) });
  repo.updatedAt = when;
  repo.pushedAt = when;
  return sha;
}

/** One file's blob on a branch, or null. */
export function getFile(repo: RepoData, branch: string, path: string): { sha: string; data: Buffer } | null {
  return snapshotOf(repo, branch)?.get(path) ?? null;
}

/** The immediate children of a directory on a branch, or null when the directory does not exist. */
export function listDir(repo: RepoData, branch: string, dir: string): DirEntry[] | null {
  const snapshot = snapshotOf(repo, branch);
  if (snapshot === null) return dir === '' ? [] : null;
  const prefix = dir === '' ? '' : `${dir}/`;
  let found = false;
  const children = new Map<string, 'file' | 'dir'>();
  for (const key of snapshot.keys()) {
    if (!key.startsWith(prefix) || key === prefix) continue;
    found = true;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, 'file');
    else children.set(rest.slice(0, slash), 'dir');
  }
  if (!found && dir !== '') return null;
  const entries: DirEntry[] = [];
  const names = [...children.keys()].sort();
  for (const name of names) {
    const path = `${prefix}${name}`;
    if (children.get(name) === 'file') {
      const blob = snapshot.get(path)!;
      entries.push({ type: 'file', name, path, sha: blob.sha, size: blob.data.length });
    } else {
      entries.push({ type: 'dir', name, path, sha: createHash('sha1').update(`tree ${path}`).digest('hex'), size: 0 });
    }
  }
  return entries;
}

/** The commits of a branch (or of a commit sha), newest first. */
export function listCommits(repo: RepoData, branchOrSha: string, depth = 200): CommitInfo[] {
  let sha: string | null;
  if (/^[0-9a-f]{40}$/i.test(branchOrSha) && repo.commits.has(branchOrSha)) sha = branchOrSha;
  else sha = branchTip(repo, branchOrSha);
  const out: CommitInfo[] = [];
  while (sha !== null && out.length < depth) {
    const commit = repo.commits.get(sha);
    if (commit === undefined) break;
    out.push({
      sha: commit.sha, parents: commit.parents, message: commit.message, when: commit.when,
      author: { name: ownerLogin(), email: `${ownerLogin()}@makefun.local`, when: commit.when },
    });
    sha = commit.parents[0] ?? null;
  }
  return out;
}

/** Create a branch at `sha`; false when the branch exists or the sha is unknown. */
export function createBranch(repo: RepoData, branch: string, sha: string): boolean {
  const ref = headRef(branch);
  if (repo.refs.has(ref)) return false;
  if (!/^[0-9a-f]{40}$/i.test(sha) || !repo.commits.has(sha)) return false;
  repo.refs.set(ref, sha.toLowerCase());
  return true;
}

/** Commit `content` at `path` on `branch` (creating the branch's first commit when it is unborn). */
export function upsertFile(repo: RepoData, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; oldSha: string | null } {
  const tip = branchTip(repo, branch);
  const snapshot = tip === null ? new Map() : new Map(repo.commits.get(tip)!.snapshot);
  const blobSha = gitBlobSha(content);
  const existing = snapshot.get(path);
  const oldSha = existing ? existing.sha : null;
  snapshot.set(path, { sha: blobSha, data: content });
  repo.objects.set(blobSha, { type: 'blob', data: content });
  const commitSha = createCommit(repo, snapshot, tip === null ? [] : [tip], message);
  repo.refs.set(headRef(branch), commitSha);
  return { commitSha, blobSha, oldSha };
}

/** Remove `path` on `branch` with a commit; null when the file does not exist. */
export function deleteFile(repo: RepoData, branch: string, path: string, message: string): { commitSha: string } | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const snapshot = new Map(repo.commits.get(tip)!.snapshot);
  const existing = snapshot.get(path);
  if (existing === undefined) return null;
  snapshot.delete(path);
  const commitSha = createCommit(repo, snapshot, [tip], message);
  repo.refs.set(headRef(branch), commitSha);
  return { commitSha };
}

function mergeBaseOf(repo: RepoData, a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const queue = [a];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (ancestors.has(sha)) continue;
    ancestors.add(sha);
    for (const parent of repo.commits.get(sha)?.parents ?? []) queue.push(parent);
  }
  const seen = new Set<string>();
  const second = [b];
  while (second.length > 0) {
    const sha = second.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    if (ancestors.has(sha)) return sha;
    for (const parent of repo.commits.get(sha)?.parents ?? []) second.push(parent);
  }
  return null;
}

/**
 * Squash-merge `head` into `base`: one commit on `base` carrying head's tree. 'conflict' when both
 * sides changed the same path differently (the base ref is then left untouched).
 */
export function squashMerge(repo: RepoData, head: string, base: string, message: string): { sha: string } | 'conflict' {
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null || baseTip === null) return 'conflict';
  if (headTip === baseTip) return { sha: baseTip };
  const mergeBaseSha = mergeBaseOf(repo, baseTip, headTip);
  const headCommit = repo.commits.get(headTip)!;
  if (mergeBaseSha === baseTip) {
    // the base branch has not moved since the branch point: head's tree merges cleanly
    const sha = createCommit(repo, new Map(headCommit.snapshot), [baseTip], message);
    repo.refs.set(headRef(base), sha);
    return { sha };
  }
  if (mergeBaseSha === null) return 'conflict';
  const baseCommit = repo.commits.get(baseTip)!;
  const mergeSnapshot = repo.commits.get(mergeBaseSha)!.snapshot;
  const baseSnapshot = baseCommit.snapshot;
  const headSnapshot = headCommit.snapshot;
  const paths = new Set<string>([...mergeSnapshot.keys(), ...baseSnapshot.keys(), ...headSnapshot.keys()]);
  const merged = new Map(baseSnapshot);
  let conflict = false;
  for (const path of paths) {
    const original = mergeSnapshot.get(path) ?? null;
    const onBase = baseSnapshot.get(path) ?? null;
    const onHead = headSnapshot.get(path) ?? null;
    const headChanged = (original?.sha ?? null) !== (onHead?.sha ?? null);
    const baseChanged = (original?.sha ?? null) !== (onBase?.sha ?? null);
    if (!headChanged) continue;                    // base keeps its version
    if (!baseChanged) {                            // head's change applies cleanly
      if (onHead === null) merged.delete(path);
      else merged.set(path, onHead);
      continue;
    }
    if ((onBase?.sha ?? null) === (onHead?.sha ?? null)) continue; // both made the same change
    conflict = true;
  }
  if (conflict) return 'conflict';
  const sha = createCommit(repo, merged, [baseTip], message);
  repo.refs.set(headRef(base), sha);
  return { sha };
}

function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const count = (data: Buffer): Map<string, number> => {
    const map = new Map<string, number>();
    const text = data.toString('utf8');
    const lines = text === '' ? [] : text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const before = count(oldData);
  const after = count(newData);
  let additions = 0;
  let deletions = 0;
  for (const line of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(line) ?? 0;
    const now = after.get(line) ?? 0;
    if (now > was) additions += now - was;
    else if (was > now) deletions += was - now;
  }
  return { additions, deletions };
}

/** The two-dot diff between two branches (what GET /pulls/{n}/files answers). */
export function diffFiles(repo: RepoData, base: string, head: string): DiffFile[] {
  const baseSnapshot = snapshotOf(repo, base);
  const headSnapshot = snapshotOf(repo, head);
  if (baseSnapshot === null || headSnapshot === null) return [];
  const paths = new Set<string>([...baseSnapshot.keys(), ...headSnapshot.keys()]);
  const files: DiffFile[] = [];
  for (const path of [...paths].sort()) {
    const onBase = baseSnapshot.get(path) ?? null;
    const onHead = headSnapshot.get(path) ?? null;
    if ((onBase?.sha ?? null) === (onHead?.sha ?? null)) continue;
    const status: DiffFile['status'] = onBase === null ? 'added' : onHead === null ? 'removed' : 'modified';
    const { additions, deletions } = lineDiff(onBase?.data ?? Buffer.alloc(0), onHead?.data ?? Buffer.alloc(0));
    const add = additions + deletions === 0 && status !== 'removed' ? 1 : additions;
    files.push({ filename: path, status, additions: add, deletions, changes: add + deletions, sha: (onHead ?? onBase)!.sha });
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// Record helpers (the domain operations every surface performs on the same store).
// ---------------------------------------------------------------------------------------------

export function findLabel(repo: RepoData, name: string): Label | undefined {
  return repo.labels.find((label) => label.name === name);
}

export function createLabel(repo: RepoData, name: string, color: string, description: string | null): Label {
  const label: Label = { name, color, description };
  repo.labels.push(label);
  repo.updatedAt = isoNow();
  return label;
}

export function createIssue(repo: RepoData, input: { title: string; body?: string; labels?: string[]; user: string }): Issue | 'unknown-label' {
  for (const name of input.labels ?? []) if (findLabel(repo, name) === undefined) return 'unknown-label';
  const now = isoNow();
  const issue: Issue = {
    id: gidOf('Issue', repo.id, repo.nextNumber),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...(input.labels ?? [])],
    createdAt: now, updatedAt: now, closedAt: null,
    user: input.user,
  };
  repo.issues.push(issue);
  repo.updatedAt = now;
  return issue;
}

export function setIssueClosed(issue: Issue, closed: boolean): void {
  issue.state = closed ? 'closed' : 'open';
  issue.closedAt = closed ? isoNow() : null;
  issue.updatedAt = isoNow();
}

export function addComment(repo: RepoData, issue: Issue, body: string, user: string): Comment {
  const now = isoNow();
  const comment: Comment = { id: repo.nextCommentId++, body, user, createdAt: now, updatedAt: now };
  const list = repo.comments.get(issue.number) ?? [];
  list.push(comment);
  repo.comments.set(issue.number, list);
  issue.updatedAt = now;
  repo.updatedAt = now;
  return comment;
}

export function commentCount(repo: RepoData, issue: Issue): number {
  return repo.comments.get(issue.number)?.length ?? 0;
}

export function createPull(repo: RepoData, input: { title: string; body?: string; head: string; base: string; user: string }): Pull | 'unknown-branch' | 'duplicate' {
  const headSha = branchTip(repo, input.head);
  const baseSha = branchTip(repo, input.base);
  if (headSha === null || baseSha === null) return 'unknown-branch';
  if (repo.pulls.some((pull) => pull.head === input.head && pull.base === input.base && pull.state === 'open' && !pull.merged)) return 'duplicate';
  const now = isoNow();
  const pull: Pull = {
    id: gidOf('PullRequest', repo.id, repo.nextNumber),
    number: repo.nextNumber++,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    head: input.head, base: input.base,
    createdAt: now, updatedAt: now,
    user: input.user,
    mergeCommitSha: null, mergedAt: null,
    headSha, baseSha,
  };
  repo.pulls.push(pull);
  repo.updatedAt = now;
  return pull;
}

export function mergePull(repo: RepoData, pull: Pull, message: string): { sha: string } | 'conflict' {
  const result = squashMerge(repo, pull.head, pull.base, message);
  if (result === 'conflict') return 'conflict';
  pull.merged = true;
  pull.state = 'closed';
  pull.mergeCommitSha = result.sha;
  pull.mergedAt = isoNow();
  pull.updatedAt = pull.mergedAt;
  repo.updatedAt = pull.mergedAt;
  return result;
}

// ---------------------------------------------------------------------------------------------
// JSON serializers (the GitHub object shapes REST, GraphQL and MCP all answer).
// ---------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

export function userJson(login: string): Json {
  return { login, id: 1, node_id: gidOf('User', login), type: 'User', site_admin: false, html_url: `https://git.makefun.local/${login}`, url: `/api/v3/users/${login}` };
}

export function repoJson(repo: RepoData): Json {
  return {
    id: repo.id,
    node_id: gidOf('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    language: null,
    default_branch: repo.defaultBranch,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_wiki: false,
    has_pages: false,
    has_projects: false,
    has_downloads: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `https://git.makefun.local/${repo.owner}/${repo.name}`,
    clone_url: `https://git.makefun.local/${repo.owner}/${repo.name}.git`,
    is_template: false,
    topics: [],
  };
}

export function labelJson(label: Label, id: number): Json {
  return { id, node_id: gidOf('Label', id, label.name), name: label.name, color: label.color, description: label.description, default: false, url: '' };
}

export function issueJson(repo: RepoData, issue: Issue): Json {
  return {
    id: issue.id,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = findLabel(repo, name);
      return label === undefined ? { name } : labelJson(label, 1000 + repo.id * 100 + issue.number);
    }),
    user: userJson(issue.user),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: commentCount(repo, issue),
    author_association: 'OWNER',
    locked: false,
    active_lock_reason: null,
    html_url: `https://git.makefun.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function pullJson(repo: RepoData, pull: Pull): Json {
  const repoView = repoJson(repo);
  return {
    id: pull.id,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    closed_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, repo: repoView, user: userJson(repo.owner) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, repo: repoView, user: userJson(repo.owner) },
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    author_association: 'OWNER',
    html_url: `https://git.makefun.local/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    commits_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/commits`,
    files_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}/files`,
    mergeable: pull.merged ? null : true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    merged_by: pull.merged ? userJson(repo.owner) : null,
  };
}

export function commentJson(repo: RepoData, issue: Issue, comment: Comment): Json {
  return {
    id: comment.id,
    node_id: gidOf('Comment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `https://git.makefun.local/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://git.makefun.local/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    author_association: 'OWNER',
  };
}

export function commitJson(info: CommitInfo): Json {
  return {
    sha: info.sha,
    message: info.message,
    author: { name: info.author.name, email: info.author.email, date: info.author.when },
    committer: { name: info.author.name, email: info.author.email, date: info.author.when },
    tree: { sha: info.sha },
    parents: info.parents.map((sha) => ({ sha, url: `/api/v3/repos/-/commits/${sha}` })),
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    html_url: `https://git.makefun.local/-/commit/${info.sha}`,
    url: `/api/v3/repos/-/commits/${info.sha}`,
  };
}
