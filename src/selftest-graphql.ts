// selftest-graphql.ts — replays the suite's GraphQL check flows against the real app.
import { createApp } from '../app.ts';
import { forge } from './gitcore.ts';

forge.token = process.env.MAKEFUN_SHOP_TOKEN ?? 'gql-token';
forge.login = 'adaiversen';

const server = createApp();
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const TOKEN = forge.token;

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

async function gql<T = any>(query: string, variables: Record<string, unknown> = {}, withToken = true): Promise<{ status: number; json: any }> {
  const res = await fetch(base + '/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withToken ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return { status: res.status, json: await res.json() };
}

function expect(cond: boolean, label: string): void {
  if (!cond) {
    console.log(`FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${label}`);
  }
}

const VIEWER_LOGIN = `query ViewerLogin { viewer { login } }`;
const REPOSITORY_FIELDS = `query RepositoryFields($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled }
}`;
const ISSUE_FIELDS = `query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }`;
const TYPE_FIELDS = `query PullRequestAndRepositoryFields {
  PullRequest: __type(name: "PullRequest") { fields(includeDeprecated: true) { name } }
  Repository: __type(name: "Repository") { fields(includeDeprecated: true) { name } }
}`;
const SEARCH_ENUM = `query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }`;
const OPEN_ISSUES = `query OpenIssues($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) { issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } } }
}`;
const ISSUE_BY_NUMBER = `query IssueByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { number title state id body } }
}`;
const CREATE_ISSUE = `mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }`;
const CLOSE_ISSUE = `mutation IssueClose($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number id state } } }`;
const PULL_REQUESTS = `query PullRequests($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) { pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } } }
}`;
const PULL_REQUEST_FILES = `query PullRequestFiles($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { number files(first: 10) { nodes { path } } } }
}`;
const CREATE_PULL = `mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { number id state headRefName baseRefName } } }`;
const MERGE_PULL = `mutation MergePullRequest($input: MergePullRequestInput!) { mergePullRequest(input: $input) { pullRequest { number merged state } } }`;
const ADD_COMMENT = `mutation AddComment($input: AddCommentInput!) { addComment(input: $input) { commentEdge { node { id body } } } }`;
const INVALID_FIELD = `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }`;
const NODE_REPOSITORY = `query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }`;
const ISSUES_PAGE = `query IssuesPage($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) { issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } } }
}`;

// ---- fixtures via REST (like the suite does) ----
await rest('POST', '/api/v3/user/repos', { name: 'hello-gql', private: false, description: 'gql fixture' });
// base branch commit via git push equivalent: PUT contents (unborn repo accepts it)
await rest('PUT', '/api/v3/repos/adaiversen/hello-gql/contents/README.md', { message: 'seed', content: Buffer.from('# hello').toString('base64') });
// head branch with a changed file
const repoGet = await rest('GET', '/api/v3/repos/adaiversen/hello-gql');
const sha = repoGet.json.default_branch && (await rest('GET', '/api/v3/repos/adaiversen/hello-gql/branches')).json[0].commit.sha;
await rest('POST', '/api/v3/repos/adaiversen/hello-gql/git/refs', { ref: 'refs/heads/feature-one', sha });
await rest('PUT', '/api/v3/repos/adaiversen/hello-gql/contents/src/feature.ts', { message: 'add feature', content: Buffer.from('export const x = 1;\n').toString('base64'), branch: 'feature-one' });
await rest('POST', '/api/v3/repos/adaiversen/hello-gql/git/refs', { ref: 'refs/heads/feature-merge', sha });
await rest('PUT', '/api/v3/repos/adaiversen/hello-gql/contents/src/merge.ts', { message: 'merge me', content: Buffer.from('export const y = 2;\n').toString('base64'), branch: 'feature-merge' });
// issues
for (let i = 1; i <= 3; i += 1) await rest('POST', '/api/v3/repos/adaiversen/hello-gql/issues', { title: `seed open ${i}`, body: 'body text' });
const closed = await rest('POST', '/api/v3/repos/adaiversen/hello-gql/issues', { title: 'seed closed', body: 'body text' });
await rest('PATCH', `/api/v3/repos/adaiversen/hello-gql/issues/${closed.json.number}`, { state: 'closed' });
// pagination repository
await rest('POST', '/api/v3/user/repos', { name: 'pages-gql', private: false });
for (let i = 1; i <= 7; i += 1) await rest('POST', '/api/v3/repos/adaiversen/pages-gql/issues', { title: `page ${i}`, body: 'body text' });

// ---- 1. viewer login ----
{
  const r = await gql(VIEWER_LOGIN);
  expect(r.status === 200 && r.json.data?.viewer?.login === 'adaiversen', 'viewer.login');
}
// ---- 2. repository fields ----
let repoId = '';
{
  const r = await gql(REPOSITORY_FIELDS, { owner: 'adaiversen', name: 'hello-gql' });
  const d = r.json.data?.repository;
  repoId = d?.id ?? '';
  expect(!!d && typeof d.databaseId === 'number' && d.name === 'hello-gql' && d.owner.login === 'adaiversen', 'repository fields');
  expect(d.defaultBranchRef?.name === 'main', 'defaultBranchRef.name');
  expect(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'].includes(d.viewerPermission), 'viewerPermission enum');
  expect(d.hasIssuesEnabled === true, 'hasIssuesEnabled');
}
// ---- 3/4. introspection ----
{
  const r = await gql(ISSUE_FIELDS);
  const names = r.json.data?.Issue?.fields?.map((f: any) => f.name) ?? [];
  expect(['id', 'number', 'title', 'state', 'body'].every((n) => names.includes(n)), 'Issue introspection fields');
}
{
  const r = await gql(TYPE_FIELDS);
  const pr = r.json.data?.PullRequest?.fields?.map((f: any) => f.name) ?? [];
  const rep = r.json.data?.Repository?.fields?.map((f: any) => f.name) ?? [];
  expect(['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'].every((n) => pr.includes(n)), 'PullRequest fields');
  expect(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'].every((n) => rep.includes(n)), 'Repository fields');
}
{
  const r = await gql(SEARCH_ENUM);
  const names = r.json.data?.SearchType?.enumValues?.map((f: any) => f.name) ?? [];
  expect(names.includes('ISSUE'), 'SearchType enum has ISSUE');
}
// ---- 5. open issues order ----
{
  const r = await gql(OPEN_ISSUES, { owner: 'adaiversen', name: 'hello-gql', first: 10 });
  const nodes = r.json.data?.repository?.issues?.nodes ?? [];
  expect(nodes.length === 3 && nodes.every((n: any) => n.state === 'OPEN'), 'OPEN filter');
  expect(nodes[0].number > nodes[1].number && nodes[1].number > nodes[2].number, 'CREATED_AT DESC order');
}
// ---- 6. issue by number ----
{
  const r = await gql(ISSUE_BY_NUMBER, { owner: 'adaiversen', name: 'hello-gql', number: 1 });
  const issue = r.json.data?.repository?.issue;
  expect(issue?.title === 'seed open 1' && issue?.state === 'OPEN' && issue?.body === 'body text' && typeof issue?.id === 'string' && issue.id !== '1', 'issue by number');
}
// ---- 7. createIssue + REST view ----
{
  const r = await gql(CREATE_ISSUE, { input: { repositoryId: repoId, title: 'created over graphql', body: 'body text' } });
  const issue = r.json.data?.createIssue?.issue;
  expect(typeof issue?.number === 'number' && typeof issue?.id === 'string', 'createIssue payload');
  const restView = await rest('GET', `/api/v3/repos/adaiversen/hello-gql/issues/${issue.number}`);
  expect(restView.status === 200 && restView.json.title === 'created over graphql' && restView.json.state === 'open', 'REST view of GraphQL-created issue');
}
// ---- 8. closeIssue + REST view ----
{
  const created = await rest('POST', '/api/v3/repos/adaiversen/hello-gql/issues', { title: 'to close', body: 'body text' });
  const read = await gql(ISSUE_BY_NUMBER, { owner: 'adaiversen', name: 'hello-gql', number: created.json.number });
  const id = read.json.data?.repository?.issue?.id;
  const r = await gql(CLOSE_ISSUE, { input: { issueId: id } });
  const done = r.json.data?.closeIssue?.issue;
  expect(done?.state === 'CLOSED' && done?.number === created.json.number, 'closeIssue payload');
  const restView = await rest('GET', `/api/v3/repos/adaiversen/hello-gql/issues/${created.json.number}`);
  expect(restView.json.state === 'closed', 'REST view closed');
}
// ---- 9/10. pull requests ----
await rest('POST', '/api/v3/repos/adaiversen/hello-gql/pulls', { title: 'fixture pull request', body: 'body text', head: 'feature-one', base: 'main' });
{
  const r = await gql(PULL_REQUESTS, { owner: 'adaiversen', name: 'hello-gql', first: 5 });
  const nodes = r.json.data?.repository?.pullRequests?.nodes ?? [];
  const node = nodes.find((n: any) => n.headRefName === 'feature-one');
  expect(!!node && node.baseRefName === 'main' && node.state === 'OPEN' && typeof node.mergeable === 'string', 'pullRequests list');
  const fr = await gql(PULL_REQUEST_FILES, { owner: 'adaiversen', name: 'hello-gql', number: node.number });
  const paths = fr.json.data?.repository?.pullRequest?.files?.nodes?.map((f: any) => f.path) ?? [];
  expect(paths.includes('src/feature.ts'), 'pullRequest files include the changed path');
}
// ---- 11. createPullRequest + REST view ----
{
  const r = await gql(CREATE_PULL, { input: { repositoryId: repoId, baseRefName: 'main', headRefName: 'feature-merge', title: 'created over graphql' } });
  const pr = r.json.data?.createPullRequest?.pullRequest;
  expect(pr?.state === 'OPEN' && pr?.headRefName === 'feature-merge' && pr?.baseRefName === 'main' && typeof pr?.number === 'number', 'createPullRequest payload');
  const restView = await rest('GET', `/api/v3/repos/adaiversen/hello-gql/pulls/${pr.number}`);
  expect(restView.json.head?.ref === 'feature-merge' && restView.json.base?.ref === 'main', 'REST view of GraphQL-created pull');
}
// ---- 12. mergePullRequest + REST view ----
{
  const list = await rest('GET', '/api/v3/repos/adaiversen/hello-gql/pulls');
  const pr = list.json.find((p: any) => p.head?.ref === 'feature-merge');
  const idRead = await gql(`query Q($o: String!, $n: String!, $num: Int!) { repository(owner: $o, name: $n) { pullRequest(number: $num) { id number } } }`, { o: 'adaiversen', n: 'hello-gql', num: pr.number });
  const id = idRead.json.data?.repository?.pullRequest?.id;
  const r = await gql(MERGE_PULL, { input: { pullRequestId: id, mergeMethod: 'SQUASH' } });
  const merged = r.json.data?.mergePullRequest?.pullRequest;
  expect(merged?.merged === true, 'mergePullRequest merged');
  const restView = await rest('GET', `/api/v3/repos/adaiversen/hello-gql/pulls/${pr.number}`);
  expect(restView.json.merged === true && restView.json.state === 'closed', 'REST view merged + closed');
}
// ---- 13. addComment + REST view ----
{
  const created = await rest('POST', '/api/v3/repos/adaiversen/hello-gql/issues', { title: 'to comment', body: 'body text' });
  const read = await gql(ISSUE_BY_NUMBER, { owner: 'adaiversen', name: 'hello-gql', number: created.json.number });
  const id = read.json.data?.repository?.issue?.id;
  const r = await gql(ADD_COMMENT, { input: { subjectId: id, body: 'a graphql comment' } });
  const comment = r.json.data?.addComment?.commentEdge?.node;
  expect(comment?.body === 'a graphql comment' && typeof comment?.id === 'string', 'addComment payload');
  const comments = await rest('GET', `/api/v3/repos/adaiversen/hello-gql/issues/${created.json.number}/comments`);
  expect(comments.json.some((c: any) => c.body === 'a graphql comment'), 'REST view lists the comment');
}
// ---- 14. invalid field ----
{
  const r = await gql(INVALID_FIELD);
  expect(r.status === 200 && Array.isArray(r.json.errors) && r.json.errors.some((e: any) => String(e.message).includes('noSuchFieldOnViewer')), 'invalid field → 200 + errors naming it');
}
// ---- 15. unauthenticated ----
{
  const r = await gql(VIEWER_LOGIN, {}, false);
  expect(r.status === 401, 'unauthenticated → 401');
}
// ---- 16. node(id:) ----
{
  const r = await gql(NODE_REPOSITORY, { id: repoId });
  const node = r.json.data?.node;
  expect(node?.name === 'hello-gql' && node?.nameWithOwner === 'adaiversen/hello-gql' && node?.id === repoId, 'node(id:) round-trips');
}
// ---- 17. unknown repository ----
{
  const r = await gql(REPOSITORY_FIELDS, { owner: 'adaiversen', name: 'hello-gql-missing' });
  expect(r.status === 200 && r.json.data?.repository === null && !Array.isArray(r.json.errors), 'unknown repository → null, no errors');
}
// ---- 18. batched operations ----
{
  const res = await fetch(base + '/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify([{ query: VIEWER_LOGIN, variables: {} }, { query: ISSUE_FIELDS, variables: {} }]),
  });
  const body = await res.json();
  expect(Array.isArray(body) && body.length === 2 && body[0]?.data?.viewer?.login === 'adaiversen' && (body[1]?.data?.Issue?.fields ?? []).length > 0, 'batching answers in order');
}
// ---- 19. global id stability ----
{
  const a = await gql(REPOSITORY_FIELDS, { owner: 'adaiversen', name: 'hello-gql' });
  const b = await gql(REPOSITORY_FIELDS, { owner: 'adaiversen', name: 'hello-gql' });
  const idA = a.json.data?.repository?.id;
  const idB = b.json.data?.repository?.id;
  expect(idA === idB && idA !== String(a.json.data?.repository?.databaseId), 'repository gid stable + opaque');
  const ia = await gql(ISSUE_BY_NUMBER, { owner: 'adaiversen', name: 'hello-gql', number: 1 });
  const ib = await gql(ISSUE_BY_NUMBER, { owner: 'adaiversen', name: 'hello-gql', number: 1 });
  expect(ia.json.data?.repository?.issue?.id === ib.json.data?.repository?.issue?.id && ia.json.data?.repository?.issue?.id !== '1', 'issue gid stable + opaque');
}
// ---- 20. pagination ----
{
  const first = await gql(ISSUES_PAGE, { owner: 'adaiversen', name: 'pages-gql', first: 5, after: null });
  const conn = first.json.data?.repository?.issues;
  expect(conn?.nodes?.length === 5 && conn?.pageInfo?.hasNextPage === true && typeof conn?.pageInfo?.endCursor === 'string', 'first page');
  const second = await gql(ISSUES_PAGE, { owner: 'adaiversen', name: 'pages-gql', first: 5, after: conn.pageInfo.endCursor });
  const conn2 = second.json.data?.repository?.issues;
  const all = [...(conn.nodes ?? []), ...(conn2?.nodes ?? [])].map((n: any) => n.number);
  expect(conn2?.nodes?.length === 2 && conn2?.pageInfo?.hasNextPage === false, 'second page');
  expect(new Set(all).size === 7, 'no duplicate or missing issues across pages');
}

console.log(process.exitCode === 1 ? 'SELFTEST GRAPHQL: FAILED' : 'SELFTEST GRAPHQL: ALL PASSED');
server.close();
process.exit(process.exitCode ?? 0);
