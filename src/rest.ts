// REST v3: every route checks-rest.ts drives, under /api/v3.
//
// Wire contract (RULES.txt "The wire contract" + checks-rest.ts):
//   - every reply is application/json (never HTML) with a non-empty X-GitHub-Request-Id
//   - errors are JSON {"message": string}; a malformed JSON body is 400; an unknown route is 404 JSON
//   - Authorization: Bearer <MAKEFUN_SHOP_TOKEN>; missing/wrong -> 401; another owner's repo -> 404
//
// Contract summary (the exact statuses the checks assert):
//   GET    /                          200 JSON, X-OAuth-Scopes
//   GET    /meta                      200 {installed_version}
//   GET    /user                      200 {login}                 (checks-mcp.ts resolveOwner)
//   GET    /user/repos                200 list, Link rel="next" paging
//   POST   /user/repos                201 repository; 422 duplicate/missing name
//   GET    /repos/{o}/{r}             200 repository; 404
//   PATCH  /repos/{o}/{r}             200 description updated
//   DELETE /repos/{o}/{r}             204; a later GET is 404
//   POST   /repos/{o}/{r}/git/refs    201 {ref, object:{sha}}; 422 duplicate
//   GET    /repos/{o}/{r}/git/refs/heads/{b}   200 {ref, object:{sha}}
//   GET    /repos/{o}/{r}/branches    200 [{name, commit:{sha}}]; /branches/{b} 200 one
//   GET    /repos/{o}/{r}/commits     200 [{sha, commit:{message}}], ?sha=<ref>
//   PUT    /repos/{o}/{r}/contents/{p}   201 create / 200 update / 409 stale sha
//   GET    /repos/{o}/{r}/contents/{p}   200 file or directory listing; 404
//   DELETE /repos/{o}/{r}/contents/{p}   200 {commit:{sha}}; 404
//   POST   /repos/{o}/{r}/labels      201 {name, color}
//   POST   /repos/{o}/{r}/issues      201 issue; 422 unknown label
//   GET    /repos/{o}/{r}/issues      200 list (?state=&sort=&direction=&per_page=)
//   GET/PATCH /repos/{o}/{r}/issues/{n}   200 one / close
//   GET/POST /repos/{o}/{r}/issues/{n}/comments  200 list / 201
//   POST   /repos/{o}/{r}/pulls       201 {number, state, head{ref,sha}, base{ref,sha}}; 422 unknown branch
//   GET    /repos/{o}/{r}/pulls       200 list (?state=)
//   GET    /repos/{o}/{r}/pulls/{n}   200 one; 404
//   GET    /repos/{o}/{r}/pulls/{n}/files   200 [{filename, status, additions, ...}]
//   PUT    /repos/{o}/{r}/pulls/{n}/merge   200 {sha, merged:true, message}; 404 / 405 conflict

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addComment,
  branchTip,
  commentJson,
  commitJson,
  createBranch,
  createIssue,
  createLabel,
  createPull,
  deleteFile,
  diffFiles,
  findLabel,
  forge,
  getFile,
  issueJson,
  labelJson,
  listCommits,
  listDir,
  mergePull,
  ownerLogin,
  pullJson,
  repoJson,
  setIssueClosed,
  upsertFile,
  userJson,
  type Issue,
  type Pull,
  type RepoData,
} from './apimock-store.ts';
import { intParam, isAuthorized, isRecord, mayHaveBody, readBody, safeDecode, sendError, sendJson, sendNoContent } from './http-util.ts';

const API_PREFIX = '/api/v3';

/** Shared empty query (URLSearchParams.get on it returns null, exactly like an absent query). */
const EMPTY_QUERY = new URLSearchParams();

/** The REST entry point. Dispatches one /api/v3 request; every reply is JSON. */
export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Manual URL split (pathname + raw query) — a full `new URL` parse per request is one of the
    // hottest fixed costs under the trial's CPU budget, and every hot route here is query-less.
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const path = qIndex < 0 ? rawUrl : rawUrl.slice(0, qIndex);
    if (!isAuthorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    let raw: Buffer | null = null;
    if (mayHaveBody(req, method)) {
      try {
        raw = await readBody(req);
      } catch {
        sendError(res, 413, 'Request body too large');
        return;
      }
    }
    let body: unknown = undefined;
    if (raw !== null && raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendError(res, 400, 'Problems parsing JSON');
        return;
      }
    }
    let tail: string;
    if (path === API_PREFIX || path === `${API_PREFIX}/`) tail = '';
    else if (path.startsWith(`${API_PREFIX}/`)) tail = path.slice(API_PREFIX.length + 1);
    else {
      sendError(res, 404, 'Not Found');
      return;
    }
    const parts = tail === '' ? [] : tail.split('/').map(safeDecode);
    const query = qIndex < 0 ? EMPTY_QUERY : new URLSearchParams(rawUrl.slice(qIndex + 1));
    dispatch(req, res, parts, method, query, body);
  } catch (error) {
    sendError(res, 500, `Internal Server Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function notFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

function unprocessable(res: ServerResponse, message: string): void {
  sendError(res, 422, message);
}

function dispatch(req: IncomingMessage, res: ServerResponse, parts: string[], method: string, query: URLSearchParams, body: unknown): void {
  const [a, b, c, ...more] = parts;
  void b; void c; void more;

  // GET /api/v3[/] — the API root
  if (parts.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        authorizations_url: '/api/v3/authorizations',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        rate_limit_url: '/api/v3/rate_limit',
        repositories_url: '/api/v3/repositories',
        user_url: '/api/v3/users/{user}',
        user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      }, { 'x-oauth-scopes': 'repo, read:org, user' });
      return;
    }
    notFound(res);
    return;
  }

  if (a === 'meta' && parts.length === 1 && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0-makefun-forge', verifiable_password_authentication: false, github_services: [] });
    return;
  }

  if (a === 'user') {
    if (parts.length === 1 && method === 'GET') {
      sendJson(res, 200, { ...userJson(ownerLogin()), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
      return;
    }
    if (b === 'repos' && parts.length === 2) {
      if (method === 'GET') return listViewerRepos(req, res, query);
      if (method === 'POST') return createRepo(res, body);
    }
    notFound(res);
    return;
  }

  if (a === 'repos' && parts.length >= 3 && typeof b === 'string' && typeof c === 'string') {
    const repo = forge.getRepo(b, c);
    if (repo === undefined || repo.owner !== ownerLogin()) {
      notFound(res);
      return;
    }
    dispatchRepo(req, res, repo, parts.slice(3), method, query, body);
    return;
  }

  notFound(res);
}

// ---------------------------------------------------------------------------------------------
// /user/repos
// ---------------------------------------------------------------------------------------------

function listViewerRepos(req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void {
  const perPage = intParam(query.get('per_page'), 1, 100, 30);
  const page = intParam(query.get('page'), 1, 10_000, 1);
  const all = [...forge.repos.values()].filter((repo) => repo.owner === ownerLogin()).sort((x, y) => x.id - y.id);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + items.length < all.length) {
    const host = typeof req.headers.host === 'string' && req.headers.host !== '' ? req.headers.host : 'entry.local';
    const last = Math.max(1, Math.ceil(all.length / perPage));
    const link = (targetPage: number, rel: string) => `<http://${host}/api/v3/user/repos?per_page=${perPage}&page=${targetPage}>; rel="${rel}"`;
    const relations = [link(page + 1, 'next'), link(last, 'last')];
    if (page > 1) relations.push(link(page - 1, 'prev'), link(1, 'first'));
    headers.link = relations.join(', ');
  }
  sendJson(res, 200, items.map(repoJson), headers);
}

function createRepo(res: ServerResponse, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '') {
    unprocessable(res, 'Validation Failed: name is required');
    return;
  }
  if (forge.getRepo(ownerLogin(), name) !== undefined) {
    unprocessable(res, `Validation Failed: repository ${ownerLogin()}/${name} already exists`);
    return;
  }
  const description = typeof record.description === 'string' ? record.description : null;
  const repo = forge.createRepo(ownerLogin(), name, description);
  if (typeof record.private === 'boolean') repo.private = record.private;
  sendJson(res, 201, repoJson(repo));
}

// ---------------------------------------------------------------------------------------------
// /repos/{owner}/{repo}/...
// ---------------------------------------------------------------------------------------------

function dispatchRepo(req: IncomingMessage, res: ServerResponse, repo: RepoData, tail: string[], method: string, query: URLSearchParams, body: unknown): void {
  const [head, second, third, ...rest] = tail;

  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      const record = isRecord(body) ? body : {};
      if (typeof record.description === 'string' || record.description === null) repo.description = record.description as string | null;
      if (typeof record.name === 'string' && record.name.trim() !== '' && record.name !== repo.name) {
        // rename: keep the same database id, move the key
        forge.deleteRepo(repo.owner, repo.name);
        repo.name = record.name.trim();
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      repo.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      sendNoContent(res);
      return;
    }
    notFound(res);
    return;
  }

  switch (head) {
    case 'branches':
      dispatchBranches(res, repo, second, method);
      return;
    case 'commits':
      if (method === 'GET') return listCommitsRoute(res, repo, query);
      notFound(res);
      return;
    case 'git':
      if (second === 'refs') {
        if (third === undefined && method === 'POST') return createRef(res, repo, body);
        if (third === 'heads' && typeof rest[0] === 'string' && method === 'GET') return readRef(res, repo, rest[0]);
      }
      notFound(res);
      return;
    case 'contents': {
      const filePath = tail.slice(1).join('/');
      if (filePath === '') {
        notFound(res);
        return;
      }
      if (method === 'GET') return getContents(res, repo, filePath, query);
      if (method === 'PUT') return putContents(res, repo, filePath, body);
      if (method === 'DELETE') return deleteContents(res, repo, filePath, body);
      notFound(res);
      return;
    }
    case 'labels':
      if (second === undefined && method === 'POST') return createLabelRoute(res, repo, body);
      if (second === undefined && method === 'GET') {
        sendJson(res, 200, repo.labels.map((label, index) => labelJson(label, 1000 + repo.id * 100 + index)));
        return;
      }
      notFound(res);
      return;
    case 'issues':
      dispatchIssues(res, repo, second, third, method, query, body);
      return;
    case 'pulls':
      dispatchPulls(res, repo, second, third, method, query, body);
      return;
    default:
      notFound(res);
  }
}

// ---------------------------------------------------------------------------------------------
// branches / refs / commits
// ---------------------------------------------------------------------------------------------

function branchEntries(repo: RepoData): Array<{ name: string; sha: string }> {
  const entries: Array<{ name: string; sha: string }> = [];
  for (const [ref, sha] of repo.refs.entries()) {
    if (!ref.startsWith('refs/heads/')) continue;
    entries.push({ name: ref.slice('refs/heads/'.length), sha });
  }
  entries.sort((x, y) => {
    if (x.name === repo.defaultBranch) return -1;
    if (y.name === repo.defaultBranch) return 1;
    return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
  });
  return entries;
}

function dispatchBranches(res: ServerResponse, repo: RepoData, second: string | undefined, method: string): void {
  if (method !== 'GET') {
    notFound(res);
    return;
  }
  if (second === undefined) {
    sendJson(res, 200, branchEntries(repo).map((entry) => ({ name: entry.name, commit: { sha: entry.sha }, protected: false })));
    return;
  }
  const entry = branchEntries(repo).find((candidate) => candidate.name === second);
  if (entry === undefined) {
    sendError(res, 404, `Branch ${second} not found`);
    return;
  }
  sendJson(res, 200, { name: entry.name, commit: { sha: entry.sha }, protected: false });
}

function listCommitsRoute(res: ServerResponse, repo: RepoData, query: URLSearchParams): void {
  const ref = query.get('sha') ?? repo.defaultBranch;
  const commits = listCommits(repo, ref);
  sendJson(res, 200, commits.map((info) => ({
    ...commitJson(info),
    parents: info.parents.map((sha) => ({ sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` })),
    html_url: `https://git.makefun.local/${repo.owner}/${repo.name}/commit/${info.sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${info.sha}`,
  })));
}

function createRef(res: ServerResponse, repo: RepoData, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const ref = typeof record.ref === 'string' ? record.ref : '';
  const sha = typeof record.sha === 'string' ? record.sha : '';
  const match = /^refs\/heads\/(.+)$/.exec(ref);
  if (match === null || !/^[0-9a-f]{40}$/i.test(sha)) {
    unprocessable(res, 'Validation Failed: ref must be refs/heads/<name> and sha must be a commit id');
    return;
  }
  if (!createBranch(repo, match[1]!, sha)) {
    unprocessable(res, `Validation Failed: reference ${ref} already exists or the sha is unknown`);
    return;
  }
  sendJson(res, 201, {
    ref,
    object: { sha: sha.toLowerCase(), type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha.toLowerCase()}` },
  });
}

function readRef(res: ServerResponse, repo: RepoData, branch: string): void {
  const sha = branchTip(repo, branch);
  if (sha === null) {
    sendError(res, 404, `Git Reference refs/heads/${branch} not found`);
    return;
  }
  sendJson(res, 200, {
    ref: `refs/heads/${branch}`,
    object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${branch}`,
  });
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function getContents(res: ServerResponse, repo: RepoData, path: string, query: URLSearchParams): void {
  const ref = query.get('ref') ?? repo.defaultBranch;
  const file = getFile(repo, ref, path);
  if (file !== null) {
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: file.data.length,
      name: basename(path),
      path,
      content: file.data.toString('base64'),
      sha: file.sha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${ref}`,
      html_url: `https://git.makefun.local/${repo.owner}/${repo.name}/blob/${ref}/${path}`,
      download_url: `https://git.makefun.local/${repo.owner}/${repo.name}/raw/${ref}/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.sha}`,
    });
    return;
  }
  const entries = listDir(repo, ref, path);
  if (entries !== null) {
    sendJson(res, 200, entries.map((entry) => ({
      type: entry.type,
      size: entry.size,
      name: entry.name,
      path: entry.path,
      sha: entry.sha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${entry.path}?ref=${ref}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.type === 'file' ? 'blobs' : 'trees'}/${entry.sha}`,
      html_url: `https://git.makefun.local/${repo.owner}/${repo.name}/${entry.type === 'file' ? 'blob' : 'tree'}/${ref}/${entry.path}`,
      ...(entry.type === 'file' ? { encoding: 'base64' } : {}),
    })));
    return;
  }
  sendError(res, 404, `No file found at path: ${path} on ref ${ref}`);
}

function putContents(res: ServerResponse, repo: RepoData, path: string, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const message = typeof record.message === 'string' ? record.message : '';
  const contentBase64 = typeof record.content === 'string' ? record.content : null;
  if (message === '' || contentBase64 === null) {
    unprocessable(res, 'Validation Failed: message and content are required');
    return;
  }
  const content = Buffer.from(contentBase64, 'base64');
  const branch = typeof record.branch === 'string' && record.branch !== '' ? record.branch : repo.defaultBranch;
  const existing = getFile(repo, branch, path);
  if (typeof record.sha === 'string' && record.sha !== '') {
    if (existing === null) {
      sendError(res, 404, `${path} does not exist on branch ${branch}`);
      return;
    }
    if (record.sha.toLowerCase() !== existing.sha.toLowerCase()) {
      sendError(res, 409, `${path} does not match the provided sha on branch ${branch}`);
      return;
    }
  }
  const result = upsertFile(repo, branch, path, content, message);
  sendJson(res, existing === null ? 201 : 200, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name: basename(path),
      path,
      sha: result.blobSha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${branch}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${result.blobSha}`,
    },
    commit: {
      ...commitJson(listCommits(repo, branch, 1)[0] ?? { sha: result.commitSha, parents: [], message, when: new Date().toISOString(), author: { name: ownerLogin(), email: `${ownerLogin()}@makefun.local`, when: new Date().toISOString() } }),
      sha: result.commitSha,
    },
  });
}

function deleteContents(res: ServerResponse, repo: RepoData, path: string, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const branch = typeof record.branch === 'string' && record.branch !== '' ? record.branch : repo.defaultBranch;
  const existing = getFile(repo, branch, path);
  if (existing === null) {
    sendError(res, 404, `${path} does not exist on branch ${branch}`);
    return;
  }
  if (typeof record.sha === 'string' && record.sha !== '' && record.sha.toLowerCase() !== existing.sha.toLowerCase()) {
    sendError(res, 409, `${path} does not match the provided sha on branch ${branch}`);
    return;
  }
  const message = typeof record.message === 'string' && record.message !== '' ? record.message : `Delete ${path}`;
  const result = deleteFile(repo, branch, path, message);
  if (result === null) {
    sendError(res, 404, `${path} does not exist on branch ${branch}`);
    return;
  }
  sendJson(res, 200, {
    content: null,
    commit: {
      ...commitJson(listCommits(repo, branch, 1)[0] ?? { sha: result.commitSha, parents: [], message, when: new Date().toISOString(), author: { name: ownerLogin(), email: `${ownerLogin()}@makefun.local`, when: new Date().toISOString() } }),
      sha: result.commitSha,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// labels / issues
// ---------------------------------------------------------------------------------------------

function createLabelRoute(res: ServerResponse, repo: RepoData, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (name === '') {
    unprocessable(res, 'Validation Failed: name is required');
    return;
  }
  if (findLabel(repo, name) !== undefined) {
    unprocessable(res, `Validation Failed: label ${JSON.stringify(name)} already exists`);
    return;
  }
  const color = typeof record.color === 'string' && record.color !== '' ? record.color : 'ededed';
  const description = typeof record.description === 'string' ? record.description : null;
  const label = createLabel(repo, name, color, description);
  const index = repo.labels.indexOf(label);
  sendJson(res, 201, labelJson(label, 1000 + repo.id * 100 + index));
}

function findIssue(repo: RepoData, number: number): Issue | undefined {
  return repo.issues.find((issue) => issue.number === number);
}

function dispatchIssues(res: ServerResponse, repo: RepoData, second: string | undefined, third: string | undefined, method: string, query: URLSearchParams, body: unknown): void {
  if (second === undefined) {
    if (method === 'GET') return listIssues(res, repo, query);
    if (method === 'POST') return createIssueRoute(res, repo, body);
    notFound(res);
    return;
  }
  if (!/^\d+$/.test(second)) {
    notFound(res);
    return;
  }
  const number = Number(second);
  const issue = findIssue(repo, number);
  if (issue === undefined) {
    sendError(res, 404, `Issue #${number} not found`);
    return;
  }
  if (third === undefined) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const record = isRecord(body) ? body : {};
      if (record.state === 'closed') setIssueClosed(issue, true);
      else if (record.state === 'open') setIssueClosed(issue, false);
      if (typeof record.title === 'string') issue.title = record.title;
      if (typeof record.body === 'string') issue.body = record.body;
      issue.updatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }
  if (third === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, (repo.comments.get(number) ?? []).map((comment) => commentJson(repo, issue, comment)));
      return;
    }
    if (method === 'POST') {
      const record = isRecord(body) ? body : {};
      const text = typeof record.body === 'string' ? record.body : '';
      if (text === '') {
        unprocessable(res, 'Validation Failed: body is required');
        return;
      }
      const comment = addComment(repo, issue, text, ownerLogin());
      sendJson(res, 201, commentJson(repo, issue, comment));
      return;
    }
    notFound(res);
    return;
  }
  notFound(res);
}

function createIssueRoute(res: ServerResponse, repo: RepoData, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const title = typeof record.title === 'string' ? record.title : '';
  if (title === '') {
    unprocessable(res, 'Validation Failed: title is required');
    return;
  }
  const labelNames = Array.isArray(record.labels)
    ? record.labels
        .map((entry) => (typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : ''))
        .filter((name) => name !== '')
    : [];
  const result = createIssue(repo, {
    title,
    body: typeof record.body === 'string' ? record.body : '',
    labels: labelNames,
    user: ownerLogin(),
  });
  if (result === 'unknown-label') {
    unprocessable(res, `Validation Failed: one of the labels does not exist (${labelNames.join(', ')})`);
    return;
  }
  sendJson(res, 201, issueJson(repo, result));
}

function listIssues(res: ServerResponse, repo: RepoData, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  const perPage = intParam(query.get('per_page'), 1, 100, 30);
  const page = intParam(query.get('page'), 1, 10_000, 1);
  let items = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const byCreation = (x: Issue, y: Issue): number => (x.createdAt < y.createdAt ? -1 : x.createdAt > y.createdAt ? 1 : x.number - y.number);
  items = [...items].sort((x, y) => {
    let cmp: number;
    if (sort === 'updated') cmp = x.updatedAt < y.updatedAt ? -1 : x.updatedAt > y.updatedAt ? 1 : x.number - y.number;
    else if (sort === 'comments') cmp = (repo.comments.get(x.number)?.length ?? 0) - (repo.comments.get(y.number)?.length ?? 0) || x.number - y.number;
    else cmp = byCreation(x, y);
    return direction === 'asc' ? cmp : -cmp;
  });
  const start = (page - 1) * perPage;
  sendJson(res, 200, items.slice(start, start + perPage).map((issue) => issueJson(repo, issue)));
}

// ---------------------------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------------------------

function dispatchPulls(res: ServerResponse, repo: RepoData, second: string | undefined, third: string | undefined, method: string, query: URLSearchParams, body: unknown): void {
  if (second === undefined) {
    if (method === 'GET') return listPulls(res, repo, query);
    if (method === 'POST') return createPullRoute(res, repo, body);
    notFound(res);
    return;
  }
  if (!/^\d+$/.test(second)) {
    notFound(res);
    return;
  }
  const number = Number(second);
  const pull = repo.pulls.find((candidate) => candidate.number === number);
  if (pull === undefined) {
    sendError(res, 404, `Pull request #${number} not found`);
    return;
  }
  if (third === undefined && method === 'GET') {
    sendJson(res, 200, pullJson(repo, pull));
    return;
  }
  if (third === 'files' && method === 'GET') {
    sendJson(res, 200, diffFiles(repo, pull.base, pull.head).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      sha: file.sha,
      blob_url: `https://git.makefun.local/${repo.owner}/${repo.name}/blob/${pull.head}/${file.filename}`,
      raw_url: `https://git.makefun.local/${repo.owner}/${repo.name}/raw/${pull.head}/${file.filename}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.filename}?ref=${pull.head}`,
    })));
    return;
  }
  if (third === 'merge' && method === 'PUT') {
    mergePullRoute(res, repo, pull, body);
    return;
  }
  notFound(res);
}

function listPulls(res: ServerResponse, repo: RepoData, query: URLSearchParams): void {
  const state = query.get('state') ?? 'open';
  const perPage = intParam(query.get('per_page'), 1, 100, 30);
  const page = intParam(query.get('page'), 1, 10_000, 1);
  const items = repo.pulls
    .filter((pull) => state === 'all' || pull.state === state)
    .sort((x, y) => x.number - y.number);
  const start = (page - 1) * perPage;
  sendJson(res, 200, items.slice(start, start + perPage).map((pull) => pullJson(repo, pull)));
}

function createPullRoute(res: ServerResponse, repo: RepoData, body: unknown): void {
  const record = isRecord(body) ? body : {};
  const title = typeof record.title === 'string' ? record.title : '';
  const head = typeof record.head === 'string' ? record.head : '';
  const base = typeof record.base === 'string' ? record.base : '';
  if (title === '' || head === '' || base === '') {
    unprocessable(res, 'Validation Failed: title, head and base are required');
    return;
  }
  const result = createPull(repo, {
    title,
    body: typeof record.body === 'string' ? record.body : '',
    head, base,
    user: ownerLogin(),
  });
  if (result === 'unknown-branch') {
    unprocessable(res, `Validation Failed: head ${JSON.stringify(head)} or base ${JSON.stringify(base)} does not exist`);
    return;
  }
  if (result === 'duplicate') {
    unprocessable(res, `Validation Failed: a pull request from ${head} to ${base} already exists`);
    return;
  }
  sendJson(res, 201, pullJson(repo, result));
}

function mergePullRoute(res: ServerResponse, repo: RepoData, pull: Pull, body: unknown): void {
  void repo;
  if (pull.merged) {
    sendError(res, 405, 'Pull Request is already merged');
    return;
  }
  const record = isRecord(body) ? body : {};
  const message = typeof record.commit_title === 'string' && record.commit_title !== ''
    ? record.commit_title
    : `${pull.title} (#${pull.number})`;
  const result = mergePull(repo, pull, message);
  if (result === 'conflict') {
    sendError(res, 405, 'Pull Request is not mergeable: the merge has conflicts');
    return;
  }
  sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}
