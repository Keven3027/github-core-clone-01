// apimock-store.ts — the API-side adapter over the REAL git model.
//
// The original stand-in kept per-commit whole-tree snapshots; everything now runs on the shared
// object/ref model in src/store.ts + src/gitcore.ts (the same store git smart HTTP serves), so a
// push, a contents edit and a pull merge all see one history. Every export rest.ts / graphql.ts /
// mcp.ts import keeps its name and signature.

import { createHash } from 'node:crypto';
import { isoNow } from './http-util.ts';
import { forge as gitForge, type Forge } from './gitcore.ts';
import * as S from './store.ts';
import type { Comment, Issue, Label, Pull, RepoData } from './model.ts';

export type { Comment, Issue, Label, Pull, RepoData };
export type ForgeT = Forge;
/** The one shared store: git smart HTTP, REST, GraphQL and MCP all read and write it. */
export const forge: Forge = gitForge;

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

// ---------------------------------------------------------------------------------------------
// Identity + global ids
// ---------------------------------------------------------------------------------------------

/** The login the bearer token names (main.ts injects Forge.login from the deterministic scenario). */
export function ownerLogin(): string {
  return forge.login;
}

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

export function repoByDatabaseId(id: number): RepoData | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// git bottom layer (real objects, one store with git smart HTTP)
// ---------------------------------------------------------------------------------------------

export interface CommitInfo {
  sha: string; tree?: string; parents: string[]; message: string; when: string;
  author: { name: string; email: string; when: string };
}

export interface DiffFile {
  filename: string; status: 'added' | 'modified' | 'removed';
  additions: number; deletions: number; changes: number; sha: string;
}

export interface DirEntry { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number }

export function headRef(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The commit sha a branch points at, or null. */
export function branchTip(repo: RepoData, branch: string): string | null {
  return repo.refs.get(headRef(branch)) ?? null;
}

function tipTree(repo: RepoData, branch: string): string | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const obj = repo.objects.get(tip);
  if (obj === undefined || obj.type !== 'commit') return null;
  return S.parseCommitObj(obj.data).tree;
}

function blobData(repo: RepoData, sha: string): Buffer {
  return repo.objects.get(sha)?.data ?? Buffer.alloc(0);
}

/** One file's blob on a branch, or null. */
export function getFile(repo: RepoData, branch: string, path: string): { sha: string; data: Buffer } | null {
  const tree = tipTree(repo, branch);
  if (tree === null) return null;
  const ent = S.treeGet(repo.objects, tree, path);
  if (ent === null) return null;
  if (ent.mode === '40000' || ent.mode === '040000') return null; // a tree is not a file
  return { sha: ent.sha, data: blobData(repo, ent.sha) };
}

/** The immediate children of a directory on a branch, or null when the directory does not exist. */
export function listDir(repo: RepoData, branch: string, dir: string): DirEntry[] | null {
  const tree = tipTree(repo, branch);
  if (tree === null) return dir === '' ? [] : null;
  const flat = S.flattenTree(repo.objects, tree);
  const prefix = dir === '' ? '' : `${dir}/`;
  let found = false;
  const children = new Map<string, 'file' | 'dir'>();
  for (const key of flat.keys()) {
    if (!key.startsWith(prefix) || key === prefix) continue;
    found = true;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) children.set(rest, 'file');
    else children.set(rest.slice(0, slash), 'dir');
  }
  if (!found && dir !== '') {
    // a directory that only holds deeper paths still exists when the tree has the prefix
    for (const key of flat.keys()) {
      if (key.startsWith(prefix)) { found = true; break; }
    }
    if (!found) return null;
  }
  const entries: DirEntry[] = [];
  const names = [...children.keys()].sort();
  for (const name of names) {
    const path = `${prefix}${name}`;
    if (children.get(name) === 'file') {
      const ent = flat.get(path)!;
      entries.push({ type: 'file', name, path, sha: ent.sha, size: blobData(repo, ent.sha).length });
    } else {
      const ent = S.treeGet(repo.objects, tree, path);
      entries.push({ type: 'dir', name, path, sha: ent?.sha ?? createHash('sha1').update(`tree ${path}`).digest('hex'), size: 0 });
    }
  }
  return entries;
}

/** The commits of a branch (or of a commit sha), newest first. */
export function listCommits(repo: RepoData, branchOrSha: string, depth = 200): CommitInfo[] {
  let sha: string | null;
  if (S.isObjectId(branchOrSha) && repo.objects.get(branchOrSha.toLowerCase())?.type === 'commit') sha = branchOrSha.toLowerCase();
  else sha = branchTip(repo, branchOrSha);
  const out: CommitInfo[] = [];
  while (sha !== null && out.length < depth) {
    const obj = repo.objects.get(sha);
    if (obj === undefined || obj.type !== 'commit') break;
    const parsed = S.parseCommitObj(obj.data);
    const author = S.parseAuthorLine(parsed.author);
    out.push({
      sha, tree: parsed.tree, parents: parsed.parents, message: parsed.message, when: author.when,
      author: { name: author.name, email: author.email, when: author.when },
    });
    sha = parsed.parents[0] ?? null;
  }
  return out;
}

/** Create a branch at `sha`; false when the branch exists or the sha is not a known commit. */
export function createBranch(repo: RepoData, branch: string, sha: string): boolean {
  const ref = headRef(branch);
  if (repo.refs.has(ref)) return false;
  const oid = sha.toLowerCase();
  const commit = S.isObjectId(oid) ? S.peelToCommit(repo.objects, oid) : null;
  if (commit === null) return false;
  repo.refs.set(ref, commit);
  repo.updatedAt = isoNow();
  return true;
}

/** Commit `content` at `path` on `branch` (creating the branch's first commit when it is unborn). */
export function upsertFile(repo: RepoData, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; oldSha: string | null } {
  const tip = branchTip(repo, branch);
  const baseTree = tip === null ? null : S.parseCommitObj(repo.objects.get(tip)!.data).tree;
  const existing = S.treeGet(repo.objects, baseTree, path);
  const oldSha = existing !== null && existing.type !== 'tree' ? existing.sha : null;
  const blobSha = S.storeObj(repo.objects, 'blob', content);
  const newTree = S.upsertTreePath(repo.objects, baseTree, path.split('/').filter((s) => s.length > 0), { mode: '100644', sha: blobSha });
  const who = { name: ownerLogin(), email: `${ownerLogin()}@makefun.local` };
  const line = S.authorLine(who.name, who.email, Math.floor(Date.now() / 1000));
  const commitData = S.buildCommitObj(newTree, tip === null ? [] : [tip], line, line, message.endsWith('\n') ? message : `${message}\n`);
  const commitSha = S.storeObj(repo.objects, 'commit', commitData);
  repo.refs.set(headRef(branch), commitSha);
  repo.updatedAt = isoNow();
  repo.pushedAt = repo.updatedAt;
  return { commitSha, blobSha, oldSha };
}

/** Remove `path` on `branch` with a commit; null when the file does not exist. */
export function deleteFile(repo: RepoData, branch: string, path: string, message: string): { commitSha: string } | null {
  const tip = branchTip(repo, branch);
  if (tip === null) return null;
  const baseTree = S.parseCommitObj(repo.objects.get(tip)!.data).tree;
  if (S.treeGet(repo.objects, baseTree, path) === null) return null;
  const newTree = S.upsertTreePath(repo.objects, baseTree, path.split('/').filter((s) => s.length > 0), null);
  const who = { name: ownerLogin(), email: `${ownerLogin()}@makefun.local` };
  const line = S.authorLine(who.name, who.email, Math.floor(Date.now() / 1000));
  const commitData = S.buildCommitObj(newTree, [tip], line, line, message.endsWith('\n') ? message : `${message}\n`);
  const commitSha = S.storeObj(repo.objects, 'commit', commitData);
  repo.refs.set(headRef(branch), commitSha);
  repo.updatedAt = isoNow();
  repo.pushedAt = repo.updatedAt;
  return { commitSha };
}

/**
 * Squash-merge `head` into `base`: one commit on `base` carrying the merged tree. 'conflict' when
 * both sides changed the same path differently (the base ref is then left untouched).
 */
export function squashMerge(repo: RepoData, head: string, base: string, message: string): { sha: string } | 'conflict' {
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null || baseTip === null) return 'conflict';
  if (headTip === baseTip) return { sha: baseTip };
  return forge.squashMerge(repo, head, base, message);
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
  const baseTree = tipTree(repo, base);
  const headTree = tipTree(repo, head);
  if (baseTree === null || headTree === null) return [];
  const baseFlat = S.flattenTree(repo.objects, baseTree);
  const headFlat = S.flattenTree(repo.objects, headTree);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const files: DiffFile[] = [];
  for (const path of [...paths].sort()) {
    const onBase = baseFlat.get(path) ?? null;
    const onHead = headFlat.get(path) ?? null;
    if ((onBase?.sha ?? null) === (onHead?.sha ?? null)) continue;
    const status: DiffFile['status'] = onBase === null ? 'added' : onHead === null ? 'removed' : 'modified';
    const { additions, deletions } = lineDiff(onBase === null ? Buffer.alloc(0) : blobData(repo, onBase.sha), onHead === null ? Buffer.alloc(0) : blobData(repo, onHead.sha));
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

export function findIssue(repo: RepoData, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
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
  const treeSha = info.tree ?? info.sha;
  return {
    sha: info.sha,
    node_id: `Commit:${info.sha}`,
    commit: {
      // GitHub serves commit messages without the trailing newline git objects store.
      message: info.message.replace(/\n+$/, ''),
      author: { name: info.author.name, email: info.author.email, date: info.author.when },
      committer: { name: info.author.name, email: info.author.email, date: info.author.when },
      tree: { sha: treeSha },
      url: `/api/v3/repos/-/git/commits/${info.sha}`,
    },
    verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    parents: info.parents.map((sha) => ({ sha, url: `/api/v3/repos/-/commits/${sha}` })),
    html_url: `https://git.makefun.local/-/commit/${info.sha}`,
    url: `/api/v3/repos/-/commits/${info.sha}`,
  };
}
