// debug-rest.ts — reproduce the two failing checks (repos.commits, repos.contents-directory)
import { createApp } from '../app.ts';
import { forge } from './gitcore.ts';

forge.token = process.env.MAKEFUN_SHOP_TOKEN ?? 'dbg-token';
forge.login = 'adaiversen';

const server = createApp();
await new Promise<void>((r) => server.listen(0, () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${forge.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

function show(label: string, r: { status: number; json: any; text: string }, slice = 300): void {
  console.log(`[${label}] ${r.status} ${r.text.slice(0, slice).replace(/\n/g, ' ')}`);
}

// ---- repos.commits ----
show('create', await call('POST', '/api/v3/user/repos', { name: 'dbg-commits', private: true }));
const put1 = await call('PUT', '/api/v3/repos/adaiversen/dbg-commits/contents/readme.md', { message: 'initial', content: Buffer.from('seed').toString('base64') });
show('put seed', put1, 400);
const commitSha = put1.json?.commit?.sha;
console.log('initial commit sha:', commitSha);
show('create branch', await call('POST', '/api/v3/repos/adaiversen/dbg-commits/git/refs', { ref: 'refs/heads/feature-x', sha: commitSha }));
const put2 = await call('PUT', '/api/v3/repos/adaiversen/dbg-commits/contents/src/app.ts', { message: 'on branch (commits)', content: Buffer.from('branch code').toString('base64'), branch: 'feature-x' });
show('put on branch', put2, 500);
show('commits?sha=feature-x', await call('GET', '/api/v3/repos/adaiversen/dbg-commits/commits?sha=feature-x'), 700);
show('commits (default)', await call('GET', '/api/v3/repos/adaiversen/dbg-commits/commits'), 500);

// ---- repos.contents-directory ----
show('create2', await call('POST', '/api/v3/user/repos', { name: 'dbg-dir', private: true }));
await call('PUT', '/api/v3/repos/adaiversen/dbg-dir/contents/docs/seed.txt', { message: 'seed', content: Buffer.from('s').toString('base64') });
await call('PUT', '/api/v3/repos/adaiversen/dbg-dir/contents/docs/one.txt', { message: 'one', content: Buffer.from('1').toString('base64') });
await call('PUT', '/api/v3/repos/adaiversen/dbg-dir/contents/docs/two.txt', { message: 'two', content: Buffer.from('2').toString('base64') });
show('contents dir', await call('GET', '/api/v3/repos/adaiversen/dbg-dir/contents/docs'), 800);

server.close();
process.exit(0);
