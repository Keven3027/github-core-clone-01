/**
 * MCP surface (POST /mcp) — Streamable HTTP, JSON-RPC 2.0.
 *
 * Serves the modern 2026-07-28 era (`server/discover` with supportedVersions, every request
 * declaring its revision in `_meta`; no session) and, for robustness, the legacy handshake
 * (`initialize` + `notifications/initialized`, revision echoed back).
 *
 * Tools (github-mcp-server argument names, matching the suite's ARGUMENT_SYNONYMS exactly):
 *   create_repo {name, description?, private?, owner?}; get_repo {owner, repo};
 *   create_issue {owner, repo, title, body?}; list_issues {owner, repo, state?};
 *   create_pull_request {owner, repo, title, head, base}; merge_pull_request {owner, repo, pull_number}.
 *
 * Error contract: an unknown tool answers JSON-RPC -32602 (never HTTP 500); a body that is not
 * JSON answers HTTP 400 with -32700; missing required arguments answer a result with isError:true;
 * an unauthenticated request answers HTTP 401. Two concurrent tools/call each answer under their own id.
 *
 * Zero dependencies; Node 22 stdlib only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { forge } from './gitcore.ts';
import {
  createIssue,
  createPull,
  findIssue,
  mergePull,
  ownerLogin,
  repoJson,
} from './apimock-store.ts';

const SERVER_NAME = 'makefun-forge-mcp';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];

// ---------------------------------------------------------------------------------------------------------
// The tool catalog (static: tools/list must be byte-identical across calls)
// ---------------------------------------------------------------------------------------------------------

interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository in the forge. Returns the repository object.',
    properties: {
      name: { type: 'string', description: 'The repository name' },
      description: { type: 'string', description: 'The repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
      owner: { type: 'string', description: 'The owner login (defaults to the authenticated user)' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository: its metadata, default branch and counters.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository. Returns the issue object with its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The issue title' },
      body: { type: 'string', description: 'The issue body' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List a repository\'s issues, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      state: { type: 'string', description: 'Filter by state: open, closed or all' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      title: { type: 'string', description: 'The pull request title' },
      head: { type: 'string', description: 'The head branch name' },
      base: { type: 'string', description: 'The base branch name' },
      body: { type: 'string', description: 'The pull request body' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge (squash) an open pull request. REST reads merged: true afterwards.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login' },
      repo: { type: 'string', description: 'The repository name' },
      pull_number: { type: 'number', description: 'The pull request number' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

function toolListJson(): Array<Record<string, unknown>> {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: [...tool.required] },
  }));
}

// ---------------------------------------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------------------------------------

interface ToolAnswer { json: unknown; error?: string }

function toolErr(message: string): ToolAnswer {
  return { json: null, error: message };
}

function textResult(answer: ToolAnswer, isError = false): Record<string, unknown> {
  if (answer.error !== undefined) {
    return { content: [{ type: 'text', text: answer.error }], isError: true };
  }
  const text = JSON.stringify(answer.json);
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text: isError ? text : `OK: ${text}` }],
  };
  if (!isError) result.structuredContent = answer.json;
  return result;
}

function argsOf(params: Record<string, unknown>): Record<string, unknown> {
  const args = params.arguments;
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function login(): string {
  return forge.login || ownerLogin();
}

function missingArgs(spec: ToolSpec, args: Record<string, unknown>): string[] {
  return spec.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function runTool(name: string, args: Record<string, unknown>): ToolAnswer {
  const spec = TOOLS.find((tool) => tool.name === name);
  if (spec === undefined) return toolErr(`unknown tool: ${name}`);
  const missing = missingArgs(spec, args);
  if (missing.length > 0) return toolErr(`missing required argument(s): ${missing.join(', ')}`);

  if (name === 'create_repo') {
    const repoName = str(args, 'name')!;
    const owner = str(args, 'owner') ?? login();
    const repo = forge.createRepo(owner, repoName, str(args, 'description') ?? undefined);
    const priv = args.private;
    if (priv !== undefined && priv !== null) repo.private = priv === true;
    return { json: repoJson(repo) };
  }
  if (name === 'get_repo') {
    const repo = forge.getRepo(str(args, 'owner')!, str(args, 'repo')!);
    if (repo === undefined) return toolErr(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
    return { json: repoJson(repo) };
  }
  if (name === 'create_issue') {
    const repo = forge.getRepo(str(args, 'owner')!, str(args, 'repo')!);
    if (repo === undefined) return toolErr(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
    const issue = createIssue(repo, {
      title: str(args, 'title')!,
      body: str(args, 'body') ?? '',
      user: login(),
    });
    if (issue === 'unknown-label') return toolErr('unknown label');
    return {
      json: {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        full_name: `${repo.owner}/${repo.name}`,
      },
    };
  }
  if (name === 'list_issues') {
    const repo = forge.getRepo(str(args, 'owner')!, str(args, 'repo')!);
    if (repo === undefined) return toolErr(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
    const state = str(args, 'state') ?? 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return {
      json: {
        issues: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        })),
      },
    };
  }
  if (name === 'create_pull_request') {
    const repo = forge.getRepo(str(args, 'owner')!, str(args, 'repo')!);
    if (repo === undefined) return toolErr(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
    const pull = createPull(repo, {
      title: str(args, 'title')!,
      body: str(args, 'body') ?? '',
      head: str(args, 'head')!,
      base: str(args, 'base')!,
      user: login(),
    });
    if (typeof pull === 'string') {
      return toolErr(pull === 'unknown-branch' ? `the head branch ${str(args, 'head')} does not exist` : 'a pull request already exists for that head branch');
    }
    return {
      json: {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        state: pull.state,
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
        merged: pull.merged,
        full_name: `${repo.owner}/${repo.name}`,
      },
    };
  }
  if (name === 'merge_pull_request') {
    const repo = forge.getRepo(str(args, 'owner')!, str(args, 'repo')!);
    if (repo === undefined) return toolErr(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
    const number = num(args, 'pull_number');
    if (number === null) return toolErr('pull_number must be a number');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return toolErr(`pull request #${number} not found`);
    const result = mergePull(repo, pull, `${pull.title} (#${pull.number})`);
    if (result === 'conflict') return toolErr(`pull request #${number} has conflicts and cannot be merged`);
    return {
      json: {
        id: pull.id,
        number: pull.number,
        merged: pull.merged,
        state: pull.state,
        merged_at: pull.mergedAt,
        full_name: `${repo.owner}/${repo.name}`,
      },
    };
  }
  return toolErr(`unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------------------------------------

type JsonRpcId = string | number | null;

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function dispatch(method: string, params: Record<string, unknown>, id: JsonRpcId): { status: number; body: Record<string, unknown> } {
  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        resultType: 'discover',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP tools.',
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : SUPPORTED_VERSIONS[0]!;
    const echo = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0]!;
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: echo,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP tools.',
      }),
    };
  }
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: toolListJson() }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    if (name === '' || !TOOLS.some((tool) => tool.name === name)) {
      return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name === '' ? '(none)' : name}`) };
    }
    const args = argsOf(params);
    const spec = TOOLS.find((tool) => tool.name === name)!;
    const missing = missingArgs(spec, args);
    if (missing.length > 0) {
      return { status: 200, body: rpcResult(id, textResult(toolErr(`missing required argument(s): ${missing.join(', ')}`))) };
    }
    let answer: ToolAnswer;
    try {
      answer = runTool(name, args);
    } catch (err) {
      answer = toolErr(err instanceof Error ? err.message : String(err));
    }
    return { status: 200, body: rpcResult(id, textResult(answer)) };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: {} };
  }
  return { status: 200, body: rpcError(id, -32601, 'Method not found') };
}

export async function handleMCP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { sendJson, isAuthorized, readBody } = await import('./http-util.ts');

  // authentication is decided before anything else (including discover)
  if (!isAuthorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  if (req.method === 'DELETE') {
    res.statusCode = 200;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  // a JSON-RPC batch is answered one response per entry, in order
  if (Array.isArray(parsed)) {
    const bodies: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        bodies.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const record = entry as Record<string, unknown>;
      const method = typeof record.method === 'string' ? record.method : '';
      const id = (record.id ?? null) as JsonRpcId;
      const params = (record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params : {}) as Record<string, unknown>;
      if (method === '') { bodies.push(rpcError(id, -32600, 'Invalid Request: no method')); continue; }
      const answer = dispatch(method, params, id);
      if (answer.status !== 200 || Object.keys(answer.body).length === 0) {
        res.statusCode = answer.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(bodies));
        return;
      }
      bodies.push(answer.body);
    }
    sendJson(res, 200, bodies);
    return;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const record = parsed as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = (record.id ?? null) as JsonRpcId;
  if (method === '') {
    sendJson(res, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: no method' } });
    return;
  }
  const params = (record.params !== null && typeof record.params === 'object' && !Array.isArray(record.params) ? record.params : {}) as Record<string, unknown>;
  const answer = dispatch(method, params, id);
  if (Object.keys(answer.body).length === 0) {
    res.statusCode = answer.status; // 202 Accepted for notifications
    res.setHeader('content-type', 'application/json');
    res.end();
    return;
  }
  sendJson(res, answer.status, answer.body);
}

// findIssue is re-exported for API surface parity tests (unused here directly).
void findIssue;
