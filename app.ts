// app.ts — the forge's HTTP surface: routing and the shared reply helpers.
// main.ts (the entry <-> env lifecycle) imports createApp from here; the lifecycle stays as the
// starter shipped it. Handlers: src/git-http.ts, src/rest.ts, src/graphql.ts, src/mcp.ts.

import { createServer, randomUUID, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isGitRoute, handle as handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMCP } from './src/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers,
  });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    // The env's boot check calls this twice: 200 {"ok":true}. No auth required.
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    try {
      // Git smart HTTP: /{owner}/{repo}.git/info/refs, git-upload-pack, git-receive-pack.
      if (isGitRoute(path)) {
        if (await handleGit(req, res)) return;
      }
      // REST v3 under /api/v3
      if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
        await handleRest(req, res);
        return;
      }
      // GraphQL v4
      if (path === '/api/graphql') {
        await handleGraphQL(req, res);
        return;
      }
      // MCP over streamable HTTP
      if (path === '/mcp') {
        await handleMCP(req, res);
        return;
      }
    } catch (err) {
      // A handler crash must never take the server down: answer a JSON error and stay up.
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        try { res.end(); } catch { /* the socket is already gone */ }
      }
      return;
    }

    // Everything else, every method: GitHub's 404 body — JSON, never HTML.
    sendJson(res, 404, { message: 'Not Found' });
  });
}
