// smoketest.ts — boots the app on an ephemeral port and probes auth + a few routes.
import { createApp } from '../app.ts';
import { forge } from '../src/gitcore.ts';

forge.token = process.env.MAKEFUN_SHOP_TOKEN ?? 'smoketest-token';
forge.login = 'adaiversen';

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
const token = forge.token;

async function probe(name: string, path: string, init: RequestInit = {}): Promise<void> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  console.log(`${name}: ${res.status} ${text.slice(0, 120).replace(/\n/g, ' ')}`);
}

await probe('healthz', '/healthz');
await probe('root(auth)', '/api/v3/', { headers: { authorization: `Bearer ${token}` } });
await probe('root(noauth)', '/api/v3/');
await probe('meta', '/api/v3/meta', { headers: { authorization: `Bearer ${token}` } });
await probe('create-repo', '/api/v3/user/repos', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'smoke-repo', description: 'test' }),
});
await probe('get-repo', '/api/v3/repos/adaiversen/smoke-repo', { headers: { authorization: `Bearer ${token}` } });
await probe('list-repos', '/api/v3/user/repos', { headers: { authorization: `Bearer ${token}` } });
await probe('git-refs', '/api/v3/repos/adaiversen/smoke-repo', { headers: { authorization: `Bearer wrong` } });

server.close();
process.exit(0);
