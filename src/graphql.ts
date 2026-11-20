/**
 * GraphQL v4 surface (POST /api/graphql) — a small spec-compliant executor.
 *
 * Covers the documents the suite sends (see program/env/src/checks-graphql.ts):
 *   - viewer.login; repository(owner:, name:) with issue(s)/pullRequest(s); node(id:);
 *     __type introspection (Issue / PullRequest / Repository / SearchType)
 *   - mutations createIssue / closeIssue / createPullRequest / mergePullRequest / addComment
 *   - batching: a JSON array body answers one envelope per operation, in order
 *   - an unknown field is HTTP 200 + an errors array naming the field
 *   - an unknown repository reads data.repository = null with no errors
 *   - an unauthenticated request is a 401
 *
 * Zero dependencies; Node 22 stdlib only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, RepoData } from './model.ts';
import { forge } from './gitcore.ts';
import {
  addComment,
  createIssue,
  createPull,
  decodeGid,
  diffFiles,
  findIssue,
  gidOf,
  headRef,
  mergePull,
  ownerLogin,
  setIssueClosed,
} from './apimock-store.ts';

// ---------------------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------------------

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct';

interface Token {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '"' && src.slice(i, i + 3) === '"""') {
      const end = src.indexOf('"""', i + 3);
      tokens.push({ kind: 'string', value: end === -1 ? src.slice(i + 3) : src.slice(i + 3, end) });
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : (esc ?? '');
          j += 2;
        } else {
          text += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      const text = src.slice(i, j);
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === ',') { i += 1; continue; } // commas are insignificant separators in GraphQL
    // punctuation: one of ! $ ( ) ... : = @ [ ] { } |
    if (src.startsWith('...', i)) { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    tokens.push({ kind: 'punct', value: ch });
    i += 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'str'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'obj'; fields: Array<{ name: string; value: Value }> };

interface Argument { name: string; value: Value }

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Argument[];
  selections: Selection[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: Selection[];
}

type Selection = FieldNode | InlineFragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; value: Value | null }>;
  selections: Selection[];
}

interface Document { operations: Operation[] }

class ParseError extends Error {}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new ParseError(`expected ${value}, got ${token.value}`);
    return token;
  }

  private optional(value: string): boolean {
    if (this.peek()?.value === value) { this.pos += 1; return true; }
    return false;
  }

  parse(): Document {
    const operations: Operation[] = [];
    while (this.peek() !== undefined) {
      const token = this.next();
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, varDefs: [], selections: this.selectionSet() });
        continue;
      }
      if (token.kind !== 'name' || (token.value !== 'query' && token.value !== 'mutation' && token.value !== 'subscription')) {
        throw new ParseError(`expected an operation, got ${token.value}`);
      }
      const type = token.value === 'mutation' ? 'mutation' : 'query';
      let name: string | null = null;
      const after = this.peek();
      if (after !== undefined && after.kind === 'name' && after.value !== '(') name = this.next().value;
      const varDefs: Array<{ name: string; value: Value | null }> = [];
      if (this.optional('(')) {
        while (!this.optional(')')) {
          this.expect('$');
          const varName = this.next().value;
          this.expect(':');
          this.parseTypeRef();
          const defaultValue = this.optional('=') ? this.value() : null;
          varDefs.push({ name: varName, value: defaultValue });
        }
      }
      while (this.peek()?.value === '@') { this.next(); this.next(); }
      if (this.peek()?.value === '{') operations.push({ type, name, varDefs, selections: this.selectionSet() });
      else throw new ParseError(`operation ${name ?? type} has no selection set`);
    }
    return { operations };
  }

  /** Consume a type reference like `String!`, `[IssueState!]` or `Int`. */
  private parseTypeRef(): void {
    const token = this.next();
    if (token.value === '[') {
      if (this.peek()?.kind === 'name') this.next();
      this.optional('!');
      this.expect(']');
      this.optional('!');
      return;
    }
    if (token.kind !== 'name') throw new ParseError(`expected a type name, got ${token.value}`);
    this.optional('!');
  }

  private selectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!this.optional('}')) selections.push(this.selection());
    return selections;
  }

  private selection(): Selection {
    if (this.peek()?.value === '...') {
      this.next();
      const on = this.peek();
      if (on !== undefined && on.kind === 'name' && on.value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        return { kind: 'inline', typeCondition, selections: this.selectionSet() };
      }
      this.next(); // named fragment spread — not used by the suite
      return { kind: 'inline', typeCondition: null, selections: [] };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new ParseError(`expected a field name, got ${first.value}`);
    let name = first.value;
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Argument[] = [];
    if (this.optional('(')) {
      while (!this.optional(')')) {
        const argName = this.next().value;
        this.expect(':');
        args.push({ name: argName, value: this.value() });
      }
    }
    while (this.peek()?.value === '@') { this.next(); if (this.peek()?.kind === 'name') this.next(); if (this.peek()?.value === '(') { this.next(); while (!this.optional(')')) this.value(); } }
    const selections = this.peek()?.value === '{' ? this.selectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private value(): Value {
    const token = this.next();
    if (token.value === '$') return { kind: 'var', name: this.next().value };
    if (token.kind === 'string') return { kind: 'str', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.value === '[') {
      const items: Value[] = [];
      while (!this.optional(']')) items.push(this.value());
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.optional('}')) {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.value() });
      }
      return { kind: 'obj', fields };
    }
    throw new ParseError(`unexpected value token ${token.value}`);
  }
}

function parseDocument(query: string): Document {
  return new Parser(tokenize(query)).parse();
}

// ---------------------------------------------------------------------------------------------------------
// The schema (what the introspection probes report)
// ---------------------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'labels', 'createdAt', 'updatedAt', 'closedAt', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'isPrivate', 'url'],
  User: ['login', 'url'],
  Comment: ['id', 'body', 'author', 'createdAt'],
};

const SCHEMA_ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------------------------------------

interface GraphQLErrorEntry { message: string }

interface Envelope { data: Record<string, unknown> | null; errors?: GraphQLErrorEntry[] }

interface ExecContext {
  vars: Record<string, unknown>;
  errors: GraphQLErrorEntry[];
}

function resolveValue(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'var': {
      if (!(value.name in ctx.vars)) {
        ctx.errors.push({ message: `Variable $${value.name} is not defined or not provided` });
        return null;
      }
      return ctx.vars[value.name];
    }
    case 'list': return value.items.map((item) => resolveValue(item, ctx));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
    default: return value.value;
  }
}

function intOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function strOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function argValue(args: Argument[], name: string, ctx: ExecContext): unknown {
  const value = args.find((entry) => entry.name === name)?.value;
  return value === undefined ? undefined : resolveValue(value, ctx);
}

// The global ids: base64 of `kind:...` — opaque (never the plain number) and stable across reads.
function issueGid(repo: RepoData, issue: Issue): string { return gidOf('Issue', repo.owner, repo.name, issue.number); }
function pullGid(repo: RepoData, pull: Pull): string { return gidOf('PullRequest', repo.owner, repo.name, pull.number); }
function repoGid(repo: RepoData): string { return gidOf('Repository', repo.id); }

function repoByGid(id: string): RepoData | null {
  const parts = decodeGid(id);
  if (parts === null || parts[0] !== 'Repository') return null;
  const dbId = Number(parts[1]);
  if (!Number.isInteger(dbId)) return null;
  for (const repo of forge.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

interface PagedIssues { nodes: Array<Record<string, unknown>>; hasNextPage: boolean; endCursor: string }

function issuesSorted(repo: RepoData, orderByField: string, direction: string): Issue[] {
  const factor = direction === 'ASC' ? 1 : -1;
  return [...repo.issues].sort((a, b) => {
    let cmp = 0;
    if (orderByField === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (orderByField === 'COMMENTS') cmp = (repo.comments.get(a.number)?.length ?? 0) - (repo.comments.get(b.number)?.length ?? 0);
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number; // stable tie-break
    return cmp * factor;
  });
}

function issueNode(repo: RepoData, issue: Issue): Record<string, unknown> {
  return {
    id: issueGid(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function issuesConnection(repo: RepoData, args: Argument[], ctx: ExecContext): PagedIssues {
  const first = intOf(argValue(args, 'first', ctx), 30);
  const after = argValue(args, 'after', ctx);
  const statesRaw = argValue(args, 'states', ctx);
  const states = Array.isArray(statesRaw) ? statesRaw : null;
  const orderByRaw = argValue(args, 'orderBy', ctx);
  const orderBy = (orderByRaw !== null && typeof orderByRaw === 'object' ? orderByRaw : {}) as Record<string, unknown>;
  const field = typeof orderBy.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction : 'ASC';

  let list = issuesSorted(repo, field, direction);
  if (states !== null) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : '')));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const afterCursor = typeof after === 'string' && after !== '' ? after : null;
  let startIndex = 0;
  if (afterCursor !== null) {
    const anchorIndex = list.findIndex((issue) => issueGid(repo, issue) === afterCursor);
    startIndex = anchorIndex === -1 ? 0 : anchorIndex + 1;
  }
  const page = list.slice(startIndex, startIndex + Math.max(0, first));
  const endExclusive = startIndex + page.length;
  return {
    nodes: page.map((issue) => issueNode(repo, issue)),
    hasNextPage: endExclusive < list.length,
    endCursor: page.length > 0 ? issueGid(repo, page[page.length - 1]!) : 'cursor:empty',
  };
}

function pullNode(repo: RepoData, pull: Pull): Record<string, unknown> {
  return {
    id: pullGid(repo, pull),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.merged || pull.state !== 'open' ? 'UNKNOWN' : 'MERGEABLE',
  };
}

function pullFiles(repo: RepoData, pull: Pull, first: number): Array<{ path: string }> {
  const diff = diffFiles(repo, pull.base, pull.head);
  return diff.slice(0, Math.max(0, first)).map((file) => ({ path: file.filename }));
}

/** The fields each parent type may resolve; anything else records an unknown-field error. */
function resolveField(type: string, node: { kind: 'field'; alias: string | null; name: string; args: Argument[]; selections: Selection[] }, parent: unknown, ctx: ExecContext): { key: string; value: unknown } | null {
  const name = node.name;
  const key = node.alias ?? name;

  if (name === '__typename') return { key, value: type };
  if (type === 'Query' && name === '__type') {
    const typeName = strOf(argValue(node.args, 'name', ctx));
    return { key, value: typeInfo(typeName) };
  }
  if (name === '__schema') return { key, value: null };
  if (type === '__Type') {
    const parent0 = parent as { fields?: string[]; enumValues?: string[]; name?: string };
    if (name === 'name') return { key, value: parent0.name ?? null };
    if (name === 'fields') {
      const includeDeprecated = argValue(node.args, 'includeDeprecated', ctx) === true;
      const list = (parent0.fields ?? []).map((fieldName) => ({ __type__: '__Field', name: fieldName }));
      return { key, value: list };
    }
    if (name === 'enumValues') {
      const list = (parent0.enumValues ?? []).map((value) => ({ __type__: '__EnumValue', name: value }));
      return { key, value: list };
    }
    if (name === 'kind') return { key, value: (parent0.enumValues !== undefined ? 'ENUM' : 'OBJECT') };
    return { key, value: null };
  }
  if (type === '__Field' || type === '__EnumValue') {
    const parent0 = parent as { name?: string };
    if (name === 'name') return { key, value: parent0.name ?? null };
    return { key, value: null };
  }

  const allowed = SCHEMA_FIELDS[type];
  if (allowed !== undefined && !allowed.includes(name)) {
    ctx.errors.push({ message: `The field '${name}' does not exist on type '${type}' (field '${name}' is invalid)` });
    return null;
  }

  switch (type) {
    case 'Query': {
      if (name === 'viewer') return { key, value: { __type__: 'Viewer', login: forge.login || ownerLogin() } };
      if (name === 'repository') {
        const owner = strOf(argValue(node.args, 'owner', ctx));
        const repoName = strOf(argValue(node.args, 'name', ctx));
        if (owner === null || repoName === null) return { key, value: null };
        const repo = forge.getRepo(owner, repoName);
        if (repo === undefined) return { key, value: null };
        return { key, value: { __type__: 'Repository', repo } };
      }
      if (name === 'node') {
        const id = strOf(argValue(node.args, 'id', ctx));
        const repo = id === null ? null : repoByGid(id);
        if (repo === null) return { key, value: null };
        return { key, value: { __type__: 'Repository', repo, nodeId: repoGid(repo) } };
      }
      break;
    }
    case 'Mutation': {
      return { key, value: runMutation(name, node.args, ctx) };
    }
    case 'Viewer': {
      if (name === 'login') return { key, value: (parent as { login: string }).login };
      break;
    }
    case 'Repository': {
      const repo = (parent as { repo: RepoData }).repo;
      switch (name) {
        case 'id': return { key, value: (parent as { nodeId?: string }).nodeId ?? repoGid(repo) };
        case 'databaseId': return { key, value: repo.id };
        case 'name': return { key, value: repo.name };
        case 'nameWithOwner': return { key, value: `${repo.owner}/${repo.name}` };
        case 'owner': return { key, value: { __type__: 'User', login: repo.owner } };
        case 'description': return { key, value: repo.description };
        case 'isPrivate': return { key, value: repo.private };
        case 'createdAt': return { key, value: repo.createdAt };
        case 'updatedAt': return { key, value: repo.updatedAt };
        case 'url': return { key, value: `https://git.makefun.local/${repo.owner}/${repo.name}` };
        case 'viewerPermission': return { key, value: 'ADMIN' };
        case 'hasIssuesEnabled': return { key, value: true };
        case 'defaultBranchRef': {
          const exists = repo.refs.has(headRef(repo.defaultBranch));
          return { key, value: exists ? { __type__: 'Ref', name: repo.defaultBranch } : null };
        }
        case 'issue': {
          const number = intOf(argValue(node.args, 'number', ctx), 0);
          const issue = findIssue(repo, number);
          return { key, value: issue === undefined ? null : { __type__: 'Issue', repo, issue } };
        }
        case 'issues': {
          const conn = issuesConnection(repo, node.args, ctx);
          return { key, value: { __type__: 'IssueConnection', conn } };
        }
        case 'pullRequest': {
          const number = intOf(argValue(node.args, 'number', ctx), 0);
          const pull = repo.pulls.find((entry) => entry.number === number);
          return { key, value: pull === undefined ? null : { __type__: 'PullRequest', repo, pull } };
        }
        case 'pullRequests': {
          const first = Math.max(0, intOf(argValue(node.args, 'first', ctx), 30));
          const list = [...repo.pulls].sort((a, b) => b.number - a.number).slice(0, first);
          return { key, value: { __type__: 'PullRequestConnection', repo, pulls: list, hasNextPage: repo.pulls.length > first } };
        }
      }
      break;
    }
    case 'User': {
      if (name === 'login') return { key, value: (parent as { login: string }).login };
      if (name === 'url') return { key, value: `https://git.makefun.local/${(parent as { login: string }).login}` };
      break;
    }
    case 'Ref': {
      if (name === 'name') return { key, value: (parent as { name: string }).name };
      break;
    }
    case 'Issue': {
      const { repo, issue } = parent as { repo: RepoData; issue: Issue };
      switch (name) {
        case 'id': return { key, value: issueGid(repo, issue) };
        case 'number': return { key, value: issue.number };
        case 'title': return { key, value: issue.title };
        case 'state': return { key, value: issue.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'body': return { key, value: issue.body };
        case 'author': return { key, value: { __type__: 'User', login: issue.user } };
        case 'createdAt': return { key, value: issue.createdAt };
        case 'updatedAt': return { key, value: issue.updatedAt };
        case 'closedAt': return { key, value: issue.closedAt };
        case 'comments': {
          const list = repo.comments.get(issue.number) ?? [];
          return { key, value: { __type__: 'IssueComments', comments: list } };
        }
        case 'labels': return { key, value: { __type__: 'IssueLabels', labels: issue.labels } };
      }
      break;
    }
    case 'IssueConnection': {
      const { conn } = parent as { conn: PagedIssues };
      if (name === 'nodes') return { key, value: conn.nodes.map((node) => ({ __type__: 'IssueNode', node })) };
      if (name === 'pageInfo') return { key, value: { __type__: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } };
      if (name === 'edges') return { key, value: [] };
      if (name === 'totalCount') return { key, value: conn.nodes.length };
      break;
    }
    case 'IssueNode': {
      const { node } = parent as { node: Record<string, unknown> };
      if (name in node) return { key, value: node[name] };
      break;
    }
    case 'PageInfo': {
      const p = parent as { hasNextPage: boolean; endCursor: string };
      if (name === 'hasNextPage') return { key, value: p.hasNextPage };
      if (name === 'endCursor') return { key, value: p.endCursor };
      if (name === 'hasPreviousPage') return { key, value: false };
      if (name === 'startCursor') return { key, value: p.endCursor };
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = parent as { repo: RepoData; pull: Pull };
      switch (name) {
        case 'id': return { key, value: pullGid(repo, pull) };
        case 'number': return { key, value: pull.number };
        case 'title': return { key, value: pull.title };
        case 'body': return { key, value: pull.body };
        case 'state': return { key, value: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' };
        case 'merged': return { key, value: pull.merged };
        case 'headRefName': return { key, value: pull.head };
        case 'baseRefName': return { key, value: pull.base };
        case 'mergeable': return { key, value: pull.merged || pull.state !== 'open' ? 'UNKNOWN' : 'MERGEABLE' };
        case 'author': return { key, value: { __type__: 'User', login: pull.user } };
        case 'createdAt': return { key, value: pull.createdAt };
        case 'updatedAt': return { key, value: pull.updatedAt };
        case 'mergedAt': return { key, value: pull.mergedAt };
        case 'files': {
          const first = Math.max(0, intOf(argValue(node.args, 'first', ctx), 50));
          return { key, value: { __type__: 'PullRequestFiles', files: pullFiles(repo, pull, first) } };
        }
      }
      break;
    }
    case 'PullRequestConnection': {
      const p = parent as { repo: RepoData; pulls: Pull[]; hasNextPage: boolean };
      if (name === 'nodes') return { key, value: p.pulls.map((pull) => ({ __type__: 'PullRequestNode', repo: p.repo, pull })) };
      if (name === 'pageInfo') return { key, value: { __type__: 'PageInfo', hasNextPage: p.hasNextPage, endCursor: 'cursor:pulls' } };
      if (name === 'edges') return { key, value: [] };
      break;
    }
    case 'PullRequestNode': {
      const p = parent as { repo: RepoData; pull: Pull };
      const node = pullNode(p.repo, p.pull);
      if (name in node) return { key, value: node[name] };
      break;
    }
    case 'PullRequestFiles': {
      const { files } = parent as { files: Array<{ path: string }> };
      if (name === 'nodes') return { key, value: files.map((file) => ({ __type__: 'PullRequestFile', path: file.path })) };
      if (name === 'pageInfo') return { key, value: { __type__: 'PageInfo', hasNextPage: false, endCursor: 'cursor:files' } };
      if (name === 'edges') return { key, value: [] };
      break;
    }
    case 'PullRequestFile': {
      if (name === 'path') return { key, value: (parent as { path: string }).path };
      break;
    }
    case 'IssueComments': {
      const { comments } = parent as { comments: Array<{ id: number; body: string; user: string; createdAt: string }> };
      if (name === 'nodes') return { key, value: comments.map((c) => ({ __type__: 'Comment', id: gidOf('IssueComment', c.id), body: c.body, author: { __type__: 'User', login: c.user }, createdAt: c.createdAt })) };
      if (name === 'edges') return { key, value: [] };
      break;
    }
    case 'Comment': {
      const c = parent as { id: string; body: string; author: unknown; createdAt: string };
      if (name === 'id') return { key, value: c.id };
      if (name === 'body') return { key, value: c.body };
      if (name === 'author') return { key, value: c.author };
      if (name === 'createdAt') return { key, value: c.createdAt };
      break;
    }
    case 'IssueLabels': {
      const { labels } = parent as { labels: string[] };
      if (name === 'nodes') return { key, value: labels.map((label) => ({ __type__: 'Label', name: label })) };
      if (name === 'edges') return { key, value: [] };
      break;
    }
    case 'Label': {
      if (name === 'name') return { key, value: (parent as { name: string }).name };
      break;
    }
  }
  // payload/connection wrapper types: fall back to plain property reads (issue, pullRequest, commentEdge, …)
  if (parent !== null && typeof parent === 'object' && name in (parent as Record<string, unknown>)) {
    return { key, value: (parent as Record<string, unknown>)[name] };
  }
  ctx.errors.push({ message: `The field '${name}' does not exist on type '${type}'` });
  return null;
}

/** __type(name:) → the introspection shape the probes read (fields / enumValues). */
function typeInfo(name: string | null): Record<string, unknown> | null {
  if (name === null) return null;
  const fields = SCHEMA_FIELDS[name];
  const enums = SCHEMA_ENUMS[name];
  if (fields === undefined && enums === undefined) return null;
  return { __type__: '__Type', name, fields, enumValues: enums };
}

function runMutation(name: string, args: Argument[], ctx: ExecContext): { __type__: string } | null {
  const inputRaw = argValue(args, 'input', ctx);
  const input = (inputRaw !== null && typeof inputRaw === 'object' ? inputRaw : {}) as Record<string, unknown>;
  if (name === 'createIssue') {
    const repo = repoByGid(String(input.repositoryId ?? ''));
    if (repo === null) {
      ctx.errors.push({ message: `createIssue: repositoryId ${JSON.stringify(input.repositoryId)} does not name a repository` });
      return null;
    }
    const title = typeof input.title === 'string' ? input.title : '';
    if (title === '') {
      ctx.errors.push({ message: 'createIssue: title is required' });
      return null;
    }
    const issue = createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '', user: forge.login || ownerLogin() });
    if (issue === 'unknown-label') {
      ctx.errors.push({ message: 'createIssue: unknown label' });
      return null;
    }
    return { __type__: 'CreateIssuePayload', issue: { __type__: 'Issue', repo, issue } };
  }
  if (name === 'closeIssue') {
    const parts = decodeGid(String(input.issueId ?? ''));
    if (parts === null || parts[0] !== 'Issue') {
      ctx.errors.push({ message: 'closeIssue: issueId does not name an issue' });
      return null;
    }
    const repo = forge.getRepo(parts[1]!, parts[2]!);
    const issue = repo === undefined ? undefined : findIssue(repo, Number(parts[3]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'closeIssue: the issue does not exist' });
      return null;
    }
    setIssueClosed(issue, true);
    return { __type__: 'CloseIssuePayload', issue: { __type__: 'Issue', repo, issue } };
  }
  if (name === 'createPullRequest') {
    const repo = repoByGid(String(input.repositoryId ?? ''));
    if (repo === null) {
      ctx.errors.push({ message: 'createPullRequest: repositoryId does not name a repository' });
      return null;
    }
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const title = typeof input.title === 'string' ? input.title : '';
    const pull = createPull(repo, { title, body: '', head, base, user: forge.login || ownerLogin() });
    if (typeof pull === 'string') {
      ctx.errors.push({ message: `createPullRequest: ${pull === 'unknown-branch' ? `head branch ${head} does not exist` : 'a pull request already exists for that branch'}` });
      return null;
    }
    return { __type__: 'CreatePullRequestPayload', pullRequest: { __type__: 'PullRequest', repo, pull } };
  }
  if (name === 'mergePullRequest') {
    const parts = decodeGid(String(input.pullRequestId ?? ''));
    if (parts === null || parts[0] !== 'PullRequest') {
      ctx.errors.push({ message: 'mergePullRequest: pullRequestId does not name a pull request' });
      return null;
    }
    const repo = forge.getRepo(parts[1]!, parts[2]!);
    const pull = repo === undefined ? undefined : repo.pulls.find((entry) => entry.number === Number(parts[3]));
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'mergePullRequest: the pull request does not exist' });
      return null;
    }
    const result = mergePull(repo, pull, `${pull.title} (#${pull.number})`);
    if (result === 'conflict') {
      ctx.errors.push({ message: 'mergePullRequest: the pull request has conflicts' });
      return null;
    }
    return { __type__: 'MergePullRequestPayload', pullRequest: { __type__: 'PullRequest', repo, pull } };
  }
  if (name === 'addComment') {
    const parts = decodeGid(String(input.subjectId ?? ''));
    if (parts === null || parts[0] !== 'Issue') {
      ctx.errors.push({ message: 'addComment: subjectId does not name an issue' });
      return null;
    }
    const repo = forge.getRepo(parts[1]!, parts[2]!);
    const issue = repo === undefined ? undefined : findIssue(repo, Number(parts[3]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'addComment: the issue does not exist' });
      return null;
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = addComment(repo, issue, body, forge.login || ownerLogin());
    return {
      __type__: 'AddCommentPayload',
      commentEdge: { __type__: 'CommentEdge', node: { __type__: 'Comment', id: gidOf('IssueComment', comment.id), body: comment.body } },
    };
  }
  ctx.errors.push({ message: `The mutation '${name}' does not exist on type 'Mutation'` });
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------------------------------------

function executeSelections(selections: Selection[], type: string, parent: unknown, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === type) {
        Object.assign(out, executeSelections(selection.selections, selection.typeCondition ?? type, parent, ctx));
      }
      continue;
    }
    const resolved = resolveField(type, selection, parent, ctx);
    if (resolved === null) continue;
    const { key, value } = resolved;
    if (selection.selections.length > 0) {
      if (value === null || value === undefined) { out[key] = null; continue; }
      if (Array.isArray(value)) {
        out[key] = value.map((entry) => childValue(selection, entry, ctx));
        continue;
      }
      out[key] = childValue(selection, value, ctx);
      continue;
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

function childValue(node: { kind: 'field'; selections: Selection[] }, value: unknown, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => childValue(node, entry, ctx));
  if (typeof value !== 'object') return value;
  const record = value as { __type__?: string };
  const typeName = record.__type__ ?? 'Object';
  return executeSelections(node.selections, typeName, value, ctx);
}

function executeOperation(operation: Operation, variables: Record<string, unknown>): Envelope {
  const ctx: ExecContext = { vars: { ...variables }, errors: [] };
  for (const def of operation.varDefs) {
    if (!(def.name in ctx.vars) && def.value !== null) ctx.vars[def.name] = resolveValue(def.value, ctx);
  }
  let data: Record<string, unknown>;
  try {
    data = executeSelections(operation.selections, operation.type === 'mutation' ? 'Mutation' : 'Query', null, ctx);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { sendJson, isAuthorized, readBody } = await import('./http-util.ts');

  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }

  let parsedBody: unknown;
  try {
    const text = raw.toString('utf8');
    parsedBody = JSON.parse(text === '' ? 'null' : text);
  } catch {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }

  const answerOne = (entry: unknown): Envelope => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'each operation must be a JSON object with a query' }] };
    }
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : null;
    if (query === null) return { data: null, errors: [{ message: 'the operation has no query string' }] };
    let document: Document;
    try {
      document = parseDocument(query);
    } catch (err) {
      return { data: null, errors: [{ message: `Syntax error in the query: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    let operation = document.operations[0];
    if (operationName !== null) {
      const found = document.operations.find((op) => op.name === operationName);
      if (found === undefined) return { data: null, errors: [{ message: `no operation named ${operationName}` }] };
      operation = found;
    }
    if (operation === undefined) return { data: null, errors: [{ message: 'the document holds no operation' }] };
    const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables)
      ? record.variables
      : {}) as Record<string, unknown>;
    return executeOperation(operation, variables);
  };

  if (Array.isArray(parsedBody)) {
    sendJson(res, 200, parsedBody.map((entry) => answerOne(entry)));
    return;
  }

  const envelope = answerOne(parsedBody);
  sendJson(res, 200, envelope);
}
