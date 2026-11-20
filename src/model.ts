/**
 * Shared data model for the forge (SPEC.md contract).
 *
 * Owned by the git agent; the REST/GraphQL/MCP agents import these types and the
 * `forge` singleton but must not modify this file. Runtime code (the Forge class and
 * its singleton) lives in gitcore.ts; it is re-exported here so every consumer can
 * import everything from './model.ts' as the SPEC skeleton shows.
 */

/** A raw blob as REST may need it (bytes, not decoded). */
export interface Blob {
  data: Buffer;
}

/** One entry of a git tree, in the shared model's shape. */
export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** A parsed commit, in the shared model's shape. `message` keeps the object's raw message (usually trailing "\n"). */
export interface Commit {
  tree: string;
  parents: string[];
  author: { name: string; email: string; when: string };
  message: string;
}

export interface RepoData {
  owner: string;
  name: string;
  description: string | null;
  defaultBranch: string; // 'main'
  private: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  refs: Map<string, string>; // 'refs/heads/main' -> commit sha
  objects: Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>;
  issues: Issue[];
  pulls: Pull[];
  labels: Label[];
}

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  user: string;
}

export interface Pull {
  id: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  base: string;
  createdAt: string;
  user: string;
  mergeCommitSha: string | null;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

// The Forge class and the global singleton live in gitcore.ts (git agent's file);
// re-exported so the SPEC's `import { forge } from './model.ts'` works.
export { Forge, forge } from './gitcore.ts';
