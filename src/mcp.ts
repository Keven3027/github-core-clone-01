// TEMP STUB — replaced by api-dev2's real MCP implementation.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized, readBody, sendError, sendJson } from './http-util.ts';

export async function handleMCP(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let body: { id?: unknown; method?: string };
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  sendJson(res, 200, {
    jsonrpc: '2.0',
    id: body.id ?? null,
    error: { code: -32601, message: 'Method not found' },
  });
}
