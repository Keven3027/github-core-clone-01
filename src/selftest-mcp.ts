// selftest-mcp.ts — replays the suite's MCP check flows against the real app.
import { createApp } from '../app.ts';
import { forge } from './gitcore.ts';

forge.token = process.env.MAKEFUN_SHOP_TOKEN ?? 'mcp-token';
forge.login = 'adaiversen';

const server = createApp();
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const ENDPOINT = base + '/mcp';

let nextId = 1;
async function rpc(method: string, params: Record<string, unknown> = {}, opts: { auth?: boolean; raw?: string } = {}): Promise<{ status: number; body: any; text: string }> {
  const id = nextId++;
  const body = opts.raw ?? JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', protocolVersion: '2026-07-28' } } });
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.auth === false ? {} : { authorization: `Bearer ${forge.token}` }) },
    body,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* leave null */ }
  return { status: res.status, body: json, text };
}

function expect(cond: boolean, label: string): void {
  if (!cond) {
    console.log(`FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${label}`);
  }
}

async function rest(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(base + '/api/v3' + path, {
    method,
    headers: { authorization: `Bearer ${forge.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

// ---- discover / initialize ----
{
  const r = await rpc('server/discover');
  const result = r.body?.result;
  expect(r.status === 200 && Array.isArray(result?.supportedVersions) && result.supportedVersions.length > 0, 'server/discover supportedVersions');
  expect(typeof result?.serverInfo?.name === 'string' && result.serverInfo.name !== '' && typeof result?.serverInfo?.version === 'string', 'discover serverInfo');
  expect(result?.capabilities?.tools !== undefined, 'discover capabilities.tools');
}
{
  const r = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  expect(r.status === 200 && typeof r.body?.result?.serverInfo?.name === 'string' && r.body.result.capabilities?.tools !== undefined, 'initialize handshake');
}
// ---- tools/list ----
{
  const r = await rpc('tools/list');
  const tools = r.body?.result?.tools ?? [];
  expect(tools.length >= 6, 'tools/list >= 6');
  const names = new Set(tools.map((t: any) => t.name));
  expect(['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => names.has(n)), 'all six canonical tools');
  expect(tools.every((t: any) => typeof t.description === 'string' && t.description !== '' && t.inputSchema?.type === 'object'), 'tool descriptions + object schemas');
  const r2 = await rpc('tools/list');
  expect(JSON.stringify(r.body.result) === JSON.stringify(r2.body.result), 'tools/list byte-identical');
}
// ---- auth required ----
{
  const r = await rpc('tools/call', { name: 'create_issue', arguments: { owner: 'a', repo: 'b', title: 't' } }, { auth: false });
  expect(r.status === 401, 'unauthenticated tools/call → 401');
}
// ---- parse error ----
{
  const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${forge.token}` }, body: '{"jsonrpc": "2.0", "id": 424242, "method": "tools/list"' });
  const body = await res.json();
  expect(res.status === 400 && body?.error?.code === -32700, 'parse error → 400 + -32700');
}
// ---- create_issue via MCP + REST view ----
{
  await rest('POST', '/user/repos', { name: 'mcp-issue-repo', private: true });
  const r = await rpc('tools/call', { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-issue-repo', title: 'mcp made this', body: 'body' } });
  expect(r.status === 200 && r.body?.result?.isError !== true, 'create_issue over MCP');
  const listed = await rest('GET', '/repos/adaiversen/mcp-issue-repo/issues?state=all');
  expect(listed.json.some((i: any) => i.title === 'mcp made this'), 'REST lists MCP-created issue');
}
// ---- list_issues ----
{
  await rest('POST', '/repos/adaiversen/mcp-issue-repo/issues', { title: 'seeded issue', body: 'b' });
  const r = await rpc('tools/call', { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'mcp-issue-repo', state: 'all' } });
  expect(r.body?.result?.structuredContent?.issues?.some((i: any) => i.title === 'seeded issue'), 'list_issues returns the issue');
}
// ---- create_pull_request + REST ----
{
  await rest('POST', '/user/repos', { name: 'mcp-pr-repo', private: true });
  const put = await rest('PUT', '/repos/adaiversen/mcp-pr-repo/contents/seed.txt', { message: 'seed', content: Buffer.from('s').toString('base64') });
  await rest('POST', '/repos/adaiversen/mcp-pr-repo/git/refs', { ref: 'refs/heads/mcp-head', sha: put.json.commit.sha });
  await rest('PUT', '/repos/adaiversen/mcp-pr-repo/contents/head.txt', { message: 'head commit', content: Buffer.from('h').toString('base64'), branch: 'mcp-head' });
  const r = await rpc('tools/call', { name: 'create_pull_request', arguments: { owner: 'adaiversen', repo: 'mcp-pr-repo', title: 'mcp pull', head: 'mcp-head', base: 'main' } });
  const number = r.body?.result?.structuredContent?.number;
  expect(typeof number === 'number', 'create_pull_request over MCP');
  const pull = await rest('GET', `/repos/adaiversen/mcp-pr-repo/pulls/${number}`);
  expect(pull.json.head?.ref === 'mcp-head' && pull.json.base?.ref === 'main', 'REST reads the same head/base');
  // merge via MCP
  const m = await rpc('tools/call', { name: 'merge_pull_request', arguments: { owner: 'adaiversen', repo: 'mcp-pr-repo', pull_number: number } });
  expect(m.body?.result?.structuredContent?.merged === true, 'merge_pull_request merged');
  const after = await rest('GET', `/repos/adaiversen/mcp-pr-repo/pulls/${number}`);
  expect(after.json.merged === true && after.json.state === 'closed', 'REST reads merged:true, closed');
}
// ---- unknown tool ----
{
  const r = await rpc('tools/call', { name: 'no_such_tool_xyz', arguments: {} });
  expect(r.status !== 500 && (r.body?.error?.code === -32602 || r.body?.error?.code === -32601), 'unknown tool → -32602/-32601, not 500');
}
// ---- missing arguments ----
{
  const r = await rpc('tools/call', { name: 'create_issue', arguments: {} });
  expect(r.body?.result?.isError === true || r.body?.error?.code === -32602, 'missing args → isError or -32602');
}
// ---- concurrent calls, own ids ----
{
  await rest('POST', '/user/repos', { name: 'mcp-left', private: true });
  await rest('POST', '/user/repos', { name: 'mcp-right', private: true });
  const [left, right] = await Promise.all([
    rpc('tools/call', { name: 'get_repo', arguments: { owner: 'adaiversen', repo: 'mcp-left' } }),
    rpc('tools/call', { name: 'get_repo', arguments: { owner: 'adaiversen', repo: 'mcp-right' } }),
  ]);
  expect(left.body?.result?.structuredContent?.name === 'mcp-left' && right.body?.result?.structuredContent?.name === 'mcp-right', 'concurrent calls keep their own objects');
}
// ---- rest parity ----
{
  const c = await rpc('tools/call', { name: 'create_repo', arguments: { name: 'mcp-parity', description: 'parity', private: true, owner: 'adaiversen' } });
  const fullName = c.body?.result?.structuredContent?.full_name;
  expect(fullName === 'adaiversen/mcp-parity', 'create_repo returns full_name');
  const first = await rest('GET', '/repos/adaiversen/mcp-parity');
  const second = await rest('GET', '/repos/adaiversen/mcp-parity');
  expect(first.status === 200 && String(first.json.id) === String(second.json.id), 'REST parity: repo stable id');
  const i = await rpc('tools/call', { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'mcp-parity', title: 'parity issue', body: 'b' } });
  const number = i.body?.result?.structuredContent?.number;
  const i1 = await rest('GET', `/repos/adaiversen/mcp-parity/issues/${number}`);
  const i2 = await rest('GET', `/repos/adaiversen/mcp-parity/issues/${number}`);
  expect(i1.status === 200 && i1.json.title === 'parity issue' && String(i1.json.id) === String(i2.json.id), 'REST parity: issue stable id + title');
}
// ---- notifications ----
{
  const r = await rpc('notifications/initialized');
  expect(r.status === 202 || r.status === 200, 'notifications answered without error');
}

console.log(process.exitCode === 1 ? 'SELFTEST MCP: FAILED' : 'SELFTEST MCP: ALL PASSED');
server.close();
process.exit(process.exitCode ?? 0);
