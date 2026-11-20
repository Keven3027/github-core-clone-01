// Shared HTTP plumbing for the three API surfaces (REST v3, GraphQL v4, MCP).
// Node 22 standard library only.

import type { IncomingMessage, ServerResponse } from 'node:http';

// Counter-based ids: unique per process, and — unlike randomBytes/randomUUID — no getrandom
// syscall per response (that syscall is the dominant fixed cost of a reply under gVisor).
let requestSeq = 0;
const requestPid = process.pid.toString(36);

/** A unique X-GitHub-Request-Id value (unique per call). */
export function requestId(): string {
  requestSeq += 1;
  return `${requestPid}${requestSeq.toString(36)}`;
}

/** Whether the request can carry a body (methods that always may, or framing that says so). */
export function mayHaveBody(req: IncomingMessage, method: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return true;
  const length = req.headers['content-length'];
  if (length !== undefined && length !== '0') return true;
  return req.headers['transfer-encoding'] !== undefined;
}

/** The suite's bearer token, injected by main.ts through the environment. */
export function apiToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? 'MAKEFUN_SHOP_TOKEN';
}

/** The Authorization bearer of a request, or null when absent/malformed. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1]!.trim();
}

/** Whether the request carries the suite's own token. */
export function isAuthorized(req: IncomingMessage): boolean {
  const bearer = bearerOf(req);
  return bearer !== null && bearer === apiToken();
}

/** Whether `value` is a plain record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Answer one request with a JSON body; a request id header is always present. */
export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestIdHeader = headers['x-github-request-id'] ?? requestId();
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestIdHeader,
    ...headers,
  });
  res.end(text);
}

/** Answer one request with a JSON error body `{"message": string}`. */
export function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { message, ...(status === 401 ? { documentation_url: 'https://docs.github.com/rest' } : {}) }, headers);
}

/** Answer 204 with no body at all. */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': requestId() });
  res.end();
}

/** Read the whole request body (bounded). */
export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** GitHub's ISO-8601 timestamp spelling (no milliseconds). */
export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Decode one URL path segment, keeping the raw text when it does not decode. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A bounded integer query parameter with a default. */
export function intParam(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null || value.trim() === '' || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
