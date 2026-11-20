// TEMP STUB — replaced by api-dev2's real GraphQL implementation.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized, readBody, sendError, sendJson } from './http-util.ts';

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isAuthorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return;
  }
  const operations = Array.isArray((body as { query?: unknown })?.query)
    ? []
    : [body as { query?: string; variables?: Record<string, unknown> }];
  void operations;
  sendJson(res, 200, { data: null, errors: [{ message: 'GraphQL not implemented yet' }] });
}
