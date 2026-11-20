/**
 * Forge: the in-memory git forge core. Repos, refs, objects, plus the low-level
 * commit operations the REST surface calls (upsertFile, deleteFile, squashMerge,
 * listBranchCommits). Smart HTTP lives in git-http.ts; object plumbing in store.ts.
 */

import type { Commit, RepoData } from './model.ts';
import * as S from './store.ts';

const DEFAULT_BRANCH = 'main';

function nowIso(): string {
  return new Date().toISOString();
}

function identity(login: string): { name: string; email: string } {
  const name = login || 'forge';
  return { name, email: `${name}@users.noreply.github.com` };
}

export class Forge {
  /** All repositories, keyed `${owner}/${name}` (case sensitive). */
  repos: Map<string, RepoData> = new Map();

  /** The login bound to MAKEFUN_SHOP_TOKEN; injected by main.ts at integration time. */
  login: string = '';

  /** The bearer token requests must present; defaults to the MAKEFUN_SHOP_TOKEN env var. */
  token: string = '';

  private nextRepoId = 1;

  constructor() {
    this.login = process.env.MAKEFUN_SHOP_LOGIN ?? process.env.MAKEFUN_SHOP_USER ?? '';
    this.token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  }

  /** The token a request must present; empty disables auth (local/self-test convenience). */
  get authToken(): string {
    return this.token || process.env.MAKEFUN_SHOP_TOKEN || '';
  }

  createRepo(owner: string, name: string, description?: string): RepoData {
    const key = `${owner}/${name}`;
    const existing = this.repos.get(key);
    if (existing) return existing;
    const now = nowIso();
    const repo: RepoData = {
      owner,
      name,
      description: description ?? null,
      defaultBranch: DEFAULT_BRANCH,
      private: false,
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: [],
      id: this.nextRepoId++,
      nextNumber: 1,
      nextCommentId: 1,
      comments: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoData | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): void {
    this.repos.delete(`${owner}/${name}`);
  }

  // -------------------------------------------------------------------------------------------
  // low-level commit operations
  // -------------------------------------------------------------------------------------------

  /**
   * Create or update one file on `branch` (the branch is created when unborn).
   * Returns the new commit sha and, when the file replaced an existing blob, its old sha
   * (REST uses it for the 409 stale-sha comparison).
   */
  upsertFile(repo: RepoData, branch: string, path: string, content: Buffer, message: string): { commitSha: string; oldSha?: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const baseTree = tip ? S.parseCommitObj(repo.objects.get(tip)!.data).tree : null;
    const existing = S.treeGet(repo.objects, baseTree, path);
    const oldSha = existing && existing.mode !== '40000' ? existing.sha : undefined;
    const blobSha = S.storeObj(repo.objects, 'blob', content);
    const newTree = S.upsertTreePath(repo.objects, baseTree, path.split('/').filter((s) => s.length > 0), { mode: '100644', sha: blobSha });
    const commitSha = this.commitTip(repo, newTree, tip ? [tip] : [], message);
    repo.refs.set(ref, commitSha);
    repo.updatedAt = nowIso();
    repo.pushedAt = repo.updatedAt;
    return oldSha ? { commitSha, oldSha } : { commitSha };
  }

  /** Remove one file on `branch`; throws when the path does not exist. */
  deleteFile(repo: RepoData, branch: string, path: string, message: string): { commitSha: string } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const baseTree = tip ? S.parseCommitObj(repo.objects.get(tip)!.data).tree : null;
    if (!S.treeGet(repo.objects, baseTree, path)) throw new Error(`path ${path} does not exist on ${branch}`);
    const newTree = S.upsertTreePath(repo.objects, baseTree, path.split('/').filter((s) => s.length > 0), null);
    const commitSha = this.commitTip(repo, newTree, tip ? [tip] : [], message);
    repo.refs.set(ref, commitSha);
    repo.updatedAt = nowIso();
    repo.pushedAt = repo.updatedAt;
    return { commitSha };
  }

  /**
   * Squash-merge `headBranch` into `baseBranch`: one commit on the base branch holding the
   * merged tree. Same-file changes on both sides (different results) → 'conflict' and the
   * base ref does not move. Returns the new merge commit sha on success.
   */
  squashMerge(repo: RepoData, headBranch: string, baseBranch: string, message: string): { sha: string } | 'conflict' {
    const headRef = `refs/heads/${headBranch}`;
    const baseRef = `refs/heads/${baseBranch}`;
    const headTip = repo.refs.get(headRef);
    const baseTip = repo.refs.get(baseRef);
    if (!headTip || !baseTip) return 'conflict';
    const base = S.mergeBase(repo.objects, headTip, baseTip);
    if (!base) return 'conflict';
    const mergeBaseTree = S.parseCommitObj(repo.objects.get(base)!.data).tree;
    const headTree = S.parseCommitObj(repo.objects.get(headTip)!.data).tree;
    const baseTree = S.parseCommitObj(repo.objects.get(baseTip)!.data).tree;
    const baseAtMerge = S.flattenTree(repo.objects, mergeBaseTree);
    const headFiles = S.flattenTree(repo.objects, headTree);
    const baseFiles = S.flattenTree(repo.objects, baseTree);

    const paths = new Set<string>([...headFiles.keys(), ...baseFiles.keys()]);
    const merged = new Map<string, string>();
    for (const path of paths) {
      const head = headFiles.get(path)?.sha;
      const baseSide = baseFiles.get(path)?.sha;
      const origin = baseAtMerge.get(path)?.sha;
      const headChanged = head !== origin;
      const baseChanged = baseSide !== origin;
      if (headChanged && baseChanged && head !== baseSide) return 'conflict';
      if (headChanged) {
        if (head !== undefined) merged.set(path, head);
      } else if (baseSide !== undefined) {
        merged.set(path, baseSide);
      }
    }
    const treeSha = S.buildTreeFromFiles(repo.objects, merged);
    const sha = this.commitTip(repo, treeSha, [baseTip, headTip], message);
    repo.refs.set(baseRef, sha);
    repo.updatedAt = nowIso();
    repo.pushedAt = repo.updatedAt;
    return { sha };
  }

  /** The newest `depth` commits of a branch (DFS from the tip, first parent first). */
  listBranchCommits(repo: RepoData, branch: string, depth: number): Commit[] {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const commits: Commit[] = [];
    if (!tip) return commits;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && commits.length < Math.max(0, depth)) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parsed = S.parseCommitObj(obj.data);
      commits.push({
        tree: parsed.tree,
        parents: parsed.parents,
        author: S.parseAuthorLine(parsed.author),
        message: parsed.message,
      });
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]);
    }
    return commits;
  }

  /** Build and store one commit object; returns its sha. */
  private commitTip(repo: RepoData, treeSha: string, parents: readonly string[], message: string): string {
    const who = identity(this.login);
    const line = S.authorLine(who.name, who.email, Math.floor(Date.now() / 1000));
    const text = message.endsWith('\n') ? message : `${message}\n`;
    const data = S.buildCommitObj(treeSha, parents, line, line, text);
    return S.storeObj(repo.objects, 'commit', data);
  }
}

/** The global singleton every surface (REST/GraphQL/MCP/git-http) shares. */
export const forge = new Forge();
