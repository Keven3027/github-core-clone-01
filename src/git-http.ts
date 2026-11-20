/**
 * Smart HTTP surface for the forge:
 *   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
 *   POST /{owner}/{repo}.git/git-upload-pack     (protocol v2 and v0)
 *   POST /{owner}/{repo}.git/git-receive-pack    (v0 only)
 *
 * Auth: Bearer MAKEFUN_SHOP_TOKEN (missing/wrong → 401 JSON); an owner that does not
 * match Forge.login (when set) or an unknown repository → 404 JSON. Nothing here can
 * crash the server: every handler catches and answers JSON.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { forge } from './gitcore.ts';
import type { RepoData } from './model.ts';
import * as S from './store.ts';

const AGENT = 'agent=makefun-forge/1.0';
const JSON_TYPE = 'application/json; charset=utf-8';

const GIT_ROUTE = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const GIT_ROUTE_LOOSE = /^\/[^/]+\/[^/]+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

export function isGitRoute(pathname: string): boolean {
  return GIT_ROUTE_LOOSE.test(pathname);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    'cache-control': 'no-cache',
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

interface ParsedRoute {
  owner: string;
  name: string;
  endpoint: 'info/refs' | 'git-upload-pack' | 'git-receive-pack';
}

function parseRoute(pathname: string): ParsedRoute | null {
  const match = GIT_ROUTE.exec(pathname);
  if (!match) return null;
  return { owner: match[1], name: match[2], endpoint: match[3] as ParsedRoute['endpoint'] };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

interface RefLine {
  name: string;
  oid: string;
  peeled?: string;
}

function listRefs(repo: RepoData): RefLine[] {
  return [...repo.refs.entries()]
    .filter(([name]) => name.startsWith('refs/'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, oid]) => {
      const peeled = S.peelToCommit(repo.objects, oid);
      return peeled && peeled !== oid ? { name, oid, peeled } : { name, oid };
    });
}

function headInfo(repo: RepoData): { target: string; oid?: string } {
  const target = `refs/heads/${repo.defaultBranch}`;
  return { target, oid: repo.refs.get(target) };
}

/** v0 ref advertisement with the smart-HTTP preamble. */
function v0Advertisement(repo: RepoData, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? ['side-band-64k', 'ofs-delta', 'shallow', AGENT]
      : ['report-status', 'report-status-v2', 'delete-refs', 'side-band-64k', 'ofs-delta', AGENT];
  const head = headInfo(repo);
  if (head.oid) caps.push(`symref=HEAD:${head.target}`);
  const refs = listRefs(repo);
  const parts: Buffer[] = [S.pktLine(`# service=${service}\n`), S.FLUSH];
  if (refs.length === 0) {
    parts.push(S.pktLine(`${S.ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    let first = true;
    if (head.oid) {
      parts.push(S.pktLine(`${head.oid} HEAD\0${caps.join(' ')}\n`));
      first = false;
    }
    for (const ref of refs) {
      const line = `${ref.oid} ${ref.name}`;
      if (first) {
        parts.push(S.pktLine(`${line}\0${caps.join(' ')}\n`));
        first = false;
      } else {
        parts.push(S.pktLine(`${line}\n`));
      }
      if (ref.peeled) parts.push(S.pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(S.FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement (upload-pack only). */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    S.pktLine('version 2\n'),
    S.pktLine(`${AGENT}\n`),
    S.pktLine('ls-refs=unborn\n'),
    S.pktLine('fetch=shallow filter\n'),
    S.pktLine('object-format=sha1\n'),
    S.FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2 commands
// ---------------------------------------------------------------------------------------------

interface V2Command {
  command: string;
  args: string[];
}

function parseV2Command(packets: S.PktPacket[]): V2Command {
  let command = '';
  const args: string[] = [];
  let phase = 0;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      phase = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (phase === 0) {
      if (!command && text.startsWith('command=')) command = text.slice('command='.length);
    } else if (text) {
      args.push(text);
    }
  }
  return { command, args };
}

function handleV2LsRefs(repo: RepoData, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const head = headInfo(repo);
  const parts: Buffer[] = [];
  if (matches('HEAD')) {
    if (head.oid) {
      const line = `${head.oid} HEAD${symrefs ? ` symref-target:${head.target}` : ''}`;
      parts.push(S.pktLine(`${line}\n`));
    } else if (unborn) {
      const line = `unborn HEAD${symrefs ? ` symref-target:${head.target}` : ''}`;
      parts.push(S.pktLine(`${line}\n`));
    }
  }
  for (const ref of listRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(S.pktLine(`${line}\n`));
  }
  parts.push(S.FLUSH);
  return Buffer.concat(parts);
}

/** The objects a fetch should receive, plus the shallow/unshallow boundary reports. */
function computeFetchObjects(
  repo: RepoData,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): { send: Set<string>; shallow: string[]; unshallow: string[] } {
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const send = new Set<string>();
  if (!wants.length) return { send, shallow, unshallow };
  const closure = S.reachClosure(repo.objects, wants);
  const haveSet = S.possessionSet(repo.objects, haves, new Set(clientShallow));
  if (depth != null) {
    const depths = S.commitDepths(repo.objects, wants);
    for (const [oid, d] of depths) if (d > depth) closure.delete(oid);
    for (const oid of closure) if (!haveSet.has(oid)) send.add(oid);
    for (const oid of send) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of S.parseCommitObj(obj.data).parents) {
        if (repo.objects.has(parent) && !send.has(parent) && !haveSet.has(parent)) {
          shallow.push(oid);
          break;
        }
      }
    }
    for (const boundary of clientShallow) {
      const obj = repo.objects.get(boundary);
      if (!obj || obj.type !== 'commit') continue;
      const parents = S.parseCommitObj(obj.data).parents;
      const allKnown = parents.every((p) => !repo.objects.has(p) || send.has(p) || haveSet.has(p));
      if (allKnown) unshallow.push(boundary);
    }
  } else {
    for (const oid of closure) if (!haveSet.has(oid)) send.add(oid);
  }
  return { send, shallow, unshallow };
}

function packfileSection(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [S.pktLine('packfile\n')];
  for (const frame of S.sidebandWrap(pack, 1)) parts.push(frame);
  parts.push(S.FLUSH);
  return parts;
}

function shallowInfoSection(shallow: readonly string[], unshallow: readonly string[]): Buffer[] {
  const parts: Buffer[] = [S.pktLine('shallow-info\n')];
  for (const oid of shallow) parts.push(S.pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(S.pktLine(`unshallow ${oid}\n`));
  parts.push(S.DELIM);
  return parts;
}

function handleV2Fetch(repo: RepoData, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5));
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) clientShallow.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7), 10);
  }
  const parts: Buffer[] = [];
  if (haves.length) {
    parts.push(S.pktLine('acknowledgments\n'));
    let common = false;
    for (const have of haves) {
      if (repo.objects.has(have)) {
        parts.push(S.pktLine(`ACK ${have}\n`));
        common = true;
      }
    }
    parts.push(S.pktLine(common ? 'ready\n' : 'NAK\n'));
    parts.push(S.DELIM);
  }
  const cacheable = haves.length === 0;
  const key = cacheable ? fetchCacheKey(repo, wants, clientShallow, depth) : null;
  if (key !== null) {
    const cached = fetchCache.get(key);
    if (cached !== undefined) {
      parts.push(cached);
      return Buffer.concat(parts);
    }
  }
  const { send, shallow, unshallow } = computeFetchObjects(repo, wants, haves, clientShallow, Number.isFinite(depth as number) ? depth : null);
  if (shallow.length || unshallow.length) parts.push(...shallowInfoSection(shallow, unshallow));
  const pack = S.buildPack([...send].map((oid) => repo.objects.get(oid)!).filter(Boolean));
  parts.push(...packfileSection(pack));
  if (key !== null) fetchCachePut(key, Buffer.concat(parts));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------
// The fetch pack cache. Objects are content-addressed and never rewritten, so the pack
// payload for a given (repo, wants, client shallow state, depth) is immutable once built.
// 50 concurrent clones of the same tip reuse one build. Bounded to keep memory sane.
// ---------------------------------------------------------------------------------------

const FETCH_CACHE_LIMIT = 64;
const fetchCache = new Map<string, Buffer>();

function fetchCachePut(key: string, value: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_LIMIT) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, value);
}

function fetchCacheKey(repo: RepoData, wants: readonly string[], clientShallow: readonly string[], depth: number | null): string {
  return `${repo.owner}/${repo.name}|d${depth ?? 'all'}|w${[...wants].sort().join(',')}|s${[...clientShallow].sort().join(',')}`;
}

function handleUploadV2(repo: RepoData, packets: S.PktPacket[]): Buffer {
  const { command, args } = parseV2Command(packets);
  if (command === 'ls-refs') return handleV2LsRefs(repo, args);
  if (command === 'fetch') return handleV2Fetch(repo, args);
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------------------------

function handleUploadV0(repo: RepoData, packets: S.PktPacket[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!text) continue;
    if (section === 0) {
      if (text.startsWith('want ')) {
        const rest = text.slice(5);
        const space = rest.indexOf(' ');
        wants.push(space < 0 ? rest : rest.slice(0, space));
      } else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8));
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
    } else if (text.startsWith('have ')) haves.push(text.slice(5));
    // 'done' needs no server-side state: with one round we always answer with a pack.
  }
  const parts: Buffer[] = [];
  if (haves.length) {
    const lastCommon = [...haves].reverse().find((oid) => repo.objects.has(oid));
    parts.push(S.pktLine(lastCommon ? `ACK ${lastCommon}\n` : 'NAK\n'));
  } else {
    parts.push(S.pktLine('NAK\n'));
  }
  if (depth != null) {
    const cacheable = haves.length === 0;
    const key = cacheable ? fetchCacheKey(repo, wants, clientShallow, depth) : null;
    if (key !== null) {
      const cached = fetchCache.get(key);
      if (cached !== undefined) {
        parts.push(cached);
        return Buffer.concat(parts);
      }
    }
    const { send, shallow, unshallow } = computeFetchObjects(repo, wants, haves, clientShallow, depth);
    for (const oid of shallow) parts.push(S.pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(S.pktLine(`unshallow ${oid}\n`));
    const pack = S.buildPack([...send].map((oid) => repo.objects.get(oid)!).filter(Boolean));
    for (const frame of S.sidebandWrap(pack, 1)) parts.push(frame);
    parts.push(S.FLUSH);
    if (key !== null) fetchCachePut(key, Buffer.concat(parts.slice(1))); // the NAK line is the preamble
  } else {
    const haveSet = S.possessionSet(repo.objects, haves, new Set(clientShallow));
    const closure = S.reachClosure(repo.objects, wants);
    const send = [...closure].filter((oid) => !haveSet.has(oid));
    const pack = S.buildPack(send.map((oid) => repo.objects.get(oid)!).filter(Boolean));
    for (const frame of S.sidebandWrap(pack, 1)) parts.push(frame);
    parts.push(S.FLUSH);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface Verdict {
  ok: boolean;
  reason: string;
}

function handleReceivePack(repo: RepoData, body: Buffer, sideband: boolean): Buffer {
  // Parse the command list pkt-lines by hand: raw pack bytes follow the terminating flush.
  const commands: PushCommand[] = [];
  let caps = '';
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('receive-pack body truncated before flush');
    const hex = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length in command list');
    const length = Number.parseInt(hex, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('bad pkt-line in command list');
    const text = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0 && !caps) caps = text.slice(nul + 1);
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    // other lines (shallow, push-options) are ignored
  }
  const packBytes = body.subarray(offset);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    if (packBytes.length < 32) {
      unpackOk = false;
      unpackDetail = 'pack is too short';
    } else {
      try {
        const parsed = S.readPackBytes(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of parsed.objects) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpacker error';
      }
    }
  }

  const verdicts: Verdict[] = commands.map((command): Verdict => {
    if (!unpackOk) return { ok: false, reason: 'n/a (unpacker error)' };
    const current = repo.refs.get(command.ref);
    if (command.newOid === S.ZERO_OID) {
      // delete
      if (current === undefined) return { ok: false, reason: 'already deleted' };
      if (current !== command.oldOid) return { ok: false, reason: 'fetch first' };
      return { ok: true, reason: '' };
    }
    if (!repo.objects.has(command.newOid)) return { ok: false, reason: 'missing necessary objects' };
    if (command.oldOid === S.ZERO_OID) {
      if (current !== undefined) return { ok: false, reason: 'fetch first' };
      return { ok: true, reason: '' };
    }
    if (current !== command.oldOid) return { ok: false, reason: 'fetch first' };
    if (!S.isAncestor(repo.objects, command.oldOid, command.newOid)) return { ok: false, reason: 'non-fast-forward' };
    return { ok: true, reason: '' };
  });

  for (let i = 0; i < commands.length; i += 1) {
    if (!verdicts[i].ok) continue;
    const command = commands[i];
    if (command.newOid === S.ZERO_OID) repo.refs.delete(command.ref);
    else repo.refs.set(command.ref, command.newOid);
  }
  if (commands.length) {
    const now = new Date().toISOString();
    repo.pushedAt = now;
    repo.updatedAt = now;
  }

  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
  for (let i = 0; i < commands.length; i += 1) {
    const verdict = verdicts[i];
    lines.push(verdict.ok ? `ok ${commands[i].ref}` : `ng ${commands[i].ref} ${verdict.reason}`);
  }
  const reportPkt = Buffer.concat(lines.map((line) => S.pktLine(`${line}\n`)));
  if (sideband) {
    const frames = S.sidebandWrap(reportPkt, 1);
    return Buffer.concat([...frames, S.FLUSH]);
  }
  return Buffer.concat([reportPkt, S.FLUSH]);
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

function gitProtocolVersion(req: IncomingMessage): number {
  const header = (req.headers['git-protocol'] ?? '').toString();
  if (/version\s*=\s*2/i.test(header)) return 2;
  return 0;
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const parsed = parseRoute(url.pathname);
  if (!parsed) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // auth first: 401 before anything else
  const expected = forge.authToken;
  if (expected) {
    const header = (req.headers.authorization ?? '').toString();
    if (header !== `Bearer ${expected}`) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
  }
  if (forge.login && parsed.owner !== forge.login) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const repo = forge.getRepo(parsed.owner, parsed.name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const method = req.method ?? 'GET';

  if (parsed.endpoint === 'info/refs') {
    if (method !== 'GET') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const v2 = service === 'git-upload-pack' && gitProtocolVersion(req) === 2;
    const body = v2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendRaw(res, 200, `application/x-${service}-advertisement`, body);
    return;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  const body = await readBody(req);
  const contentType = `application/x-${parsed.endpoint}-result`;
  try {
    if (parsed.endpoint === 'git-upload-pack') {
      const packets = S.decodePktStream(body);
      const out = gitProtocolVersion(req) === 2 ? handleUploadV2(repo, packets) : handleUploadV0(repo, packets);
      sendRaw(res, 200, contentType, out);
      return;
    }
    // git-receive-pack: v0 only
    const capsLine = body.subarray(0, Math.min(body.length, 8192)).toString('latin1');
    const sideband = /side-band-64k/.test(capsLine);
    const out = handleReceivePack(repo, body, sideband);
    sendRaw(res, 200, contentType, out);
    return;
  } catch (err) {
    // malformed request bodies (bad pkt-line framing and friends) are client errors
    sendJson(res, 400, { message: err instanceof Error ? `${err.message} || STACK: ${err.stack?.split('\n').slice(1,4).join(' | ')}` : 'Bad Request' });
  }
}

/**
 * Entry point for app.ts routing. Returns false when the path is not a git route so the
 * caller can fall through; answers the request itself otherwise (never throws).
 */
export async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let pathname = '/';
  try {
    pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    pathname = '/';
  }
  if (!isGitRoute(pathname)) return false;
  try {
    await route(req, res, new URL(req.url ?? '/', 'http://localhost'));
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
    else res.end();
    void err;
  }
  return true;
}
