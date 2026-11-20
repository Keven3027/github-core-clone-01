/**
 * Git object store: loose-object hashing, tree/commit construction and parsing,
 * packfile read/write, reachability walks, shallow (depth) negotiation helpers,
 * and pkt-line codec. Node 22 standard library only.
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'blob' | 'tree' | 'commit' | 'tag';
export interface GitObj {
  type: ObjType;
  data: Buffer;
}
export type ObjectStore = Map<string, GitObj>;

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

// ---------------------------------------------------------------------------------------------
// object hashing / storage
// ---------------------------------------------------------------------------------------------

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObj(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Insert an object (content-addressed); returns its sha. */
export function storeObj(objects: ObjectStore, type: ObjType, data: Buffer): string {
  const sha = hashObj(type, data);
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/** Decode a buffer that must be entirely pkt-lines. Throws on malformed framing. */
export function decodePktStream(body: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let off = 0;
  while (off + 4 <= body.length) {
    const hex = body.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`invalid pkt-line length ${JSON.stringify(hex)}`);
    const len = Number.parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (len === 3 || len > 65520) throw new Error(`bad pkt-line length ${len}`);
    if (off + len > body.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: body.subarray(off + 4, off + len) });
    off += len;
  }
  if (off !== body.length) throw new Error('trailing bytes after pkt-line stream');
  return out;
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEnt {
  mode: string;
  name: string;
  sha: string;
}

export function parseTreeEntries(data: Buffer): TreeEnt[] {
  const entries: TreeEnt[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      sha: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: TreeEnt, b: TreeEnt): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function encodeTreeEntries(entries: Iterable<TreeEnt>): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.sha)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Resolve a slash path inside a tree; returns the entry or null. */
export function treeGet(objects: ObjectStore, treeSha: string | null, path: string): TreeEnt | null {
  if (!treeSha) return null;
  const segments = path.split('/').filter((s) => s.length > 0);
  let oid = treeSha;
  for (let i = 0; i < segments.length; i += 1) {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTreeEntries(obj.data).find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    oid = entry.sha;
  }
  return null;
}

/** Flatten a tree into path -> {mode, sha} for every blob (gitlinks skipped). */
export function flattenTree(objects: ObjectStore, treeSha: string, prefix = '', into = new Map<string, TreeEnt>()): Map<string, TreeEnt> {
  const obj = objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return into;
  for (const entry of parseTreeEntries(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(objects, entry.sha, path, into);
    else if (entry.mode !== '160000') into.set(path, entry);
  }
  return into;
}

/**
 * Insert (or with entry=null remove) a path inside a tree, rebuilding the affected
 * subtrees and storing them. Returns the new root tree sha.
 */
export function upsertTreePath(
  objects: ObjectStore,
  baseTreeSha: string | null,
  segments: string[],
  entry: { mode: string; sha: string } | null,
): string {
  const entries = new Map<string, TreeEnt>();
  if (baseTreeSha) {
    const obj = objects.get(baseTreeSha);
    if (obj && obj.type === 'tree') {
      for (const e of parseTreeEntries(obj.data)) entries.set(e.name, { mode: e.mode, name: e.name, sha: e.sha });
    }
  }
  const name = segments[0];
  if (segments.length === 1) {
    if (entry) entries.set(name, { mode: entry.mode, name, sha: entry.sha });
    else entries.delete(name);
  } else {
    const child = entries.get(name);
    const childBase = child && child.mode === '40000' ? child.sha : null;
    const newChild = upsertTreePath(objects, childBase, segments.slice(1), entry);
    entries.set(name, { mode: '40000', name, sha: newChild });
  }
  const data = encodeTreeEntries(entries.values());
  return storeObj(objects, 'tree', data);
}

/** Build (and store) a whole tree from flat file paths -> blob sha. */
export function buildTreeFromFiles(objects: ObjectStore, files: ReadonlyMap<string, string>, mode = '100644'): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, sha] of files) {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (!segments.length) continue;
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
      node = node.dirs.get(segments[i])!;
    }
    node.files.set(segments[segments.length - 1], sha);
  }
  const build = (node: Node): string => {
    const entries: TreeEnt[] = [];
    for (const [name, sha] of node.files) entries.push({ mode, name, sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return storeObj(objects, 'tree', encodeTreeEntries(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitObj {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommitObj(data: Buffer): CommitObj {
  const blank = data.indexOf('\n\n');
  const headerText = (blank < 0 ? data : data.subarray(0, blank)).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function buildCommitObj(tree: string, parents: readonly string[], authorLine: string, committerLine: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${authorLine}`, `committer ${committerLine}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagObj {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTagObj(data: Buffer): TagObj {
  const blank = data.indexOf('\n\n');
  const headers = new Map<string, string>();
  for (const line of (blank < 0 ? data : data.subarray(0, blank)).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

export interface AuthorView {
  name: string;
  email: string;
  when: string;
}

/** Parse `Name <email> 1700000000 +0000`. */
export function parseAuthorLine(line: string): AuthorView {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line.trim(), email: '', when: '' };
  return {
    name: match[1],
    email: match[2],
    when: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

export function authorLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

/** Follow tag objects until a commit; returns null when the object is missing or is not a tag/commit chain. */
export function peelToCommit(objects: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return null;
    current = parseTagObj(obj.data).object;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// reachability walks
// ---------------------------------------------------------------------------------------------

/** Every object reachable from `roots` (missing objects are skipped, not fatal). */
export function reachClosure(objects: ObjectStore, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (isObjectId(root)) stack.push(root);
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommitObj(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      stack.push(parseTagObj(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const entry of parseTreeEntries(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.sha);
      }
    }
  }
  return seen;
}

/**
 * Minimum generation depth of every ancestor commit of `roots` (root commits at depth 1).
 * Tags in `roots` peel to their commits first.
 */
export function commitDepths(objects: ObjectStore, roots: Iterable<string>): Map<string, number> {
  const depths = new Map<string, number>();
  let frontier: string[] = [];
  for (const root of roots) {
    const commit = peelToCommit(objects, root);
    if (commit && !depths.has(commit)) {
      depths.set(commit, 1);
      frontier.push(commit);
    }
  }
  let depth = 1;
  while (frontier.length) {
    const next: string[] = [];
    for (const sha of frontier) {
      const obj = objects.get(sha);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommitObj(obj.data).parents) {
        if (!depths.has(parent)) {
          depths.set(parent, depth + 1);
          next.push(parent);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  return depths;
}

/**
 * What a client that reports `haves` with `shallow` boundaries already holds:
 * full tree/blob closure of every held commit, but no parents past a boundary.
 */
export function possessionSet(objects: ObjectStore, haves: readonly string[], shallow: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const visitCommit = (oid: string): void => {
    if (seen.has(oid)) return;
    const obj = objects.get(oid);
    if (!obj) return;
    if (obj.type === 'tag') {
      seen.add(oid);
      visitCommit(parseTagObj(obj.data).object);
      return;
    }
    if (obj.type !== 'commit') return;
    seen.add(oid);
    const commit = parseCommitObj(obj.data);
    for (const oid2 of reachClosure(objects, [commit.tree])) seen.add(oid2);
    if (!shallow.has(oid)) for (const parent of commit.parents) visitCommit(parent);
  };
  for (const have of haves) visitCommit(have);
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`, both commit ids. */
export function isAncestor(objects: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommitObj(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** First common ancestor commit of `a` and `b`, or null. */
export function mergeBase(objects: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') for (const parent of parseCommitObj(obj.data).parents) stack.push(parent);
  }
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') for (const parent of parseCommitObj(obj.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<ObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, ObjType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a v2 packfile from plain objects (no deltas); SHA-1 trailer over all preceding bytes. */
export function buildPack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) parts.push(packObjectHeader(object.type, object.data.length), deflateSync(object.data));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function inflateAt(buffer: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} inflated to nothing`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

export interface PackReadResult {
  version: number;
  declaredCount: number;
  objects: Map<string, GitObj>;
}

/** Read a packfile (v2/3), resolving OFS_DELTA and REF_DELTA (bases from the pack or `resolveBase`). */
export function readPackBytes(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: ObjType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    if (byte === undefined) throw new Error('pack entry header truncated');
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset];
      let value = b & 0x7f;
      offset += 1;
      while (b & 0x80) {
        b = pack[offset++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      const baseOffset = entryOffset - value;
      if (baseOffset <= 0 || baseOffset > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== size) throw new Error(`pack entry at ${entryOffset} inflated to the wrong size`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is missing`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObj(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { version, declaredCount, objects };
}

// ---------------------------------------------------------------------------------------------
// sideband framing
// ---------------------------------------------------------------------------------------------

/** The largest sideband payload per pkt-line: 65520 - 4 (header) - 1 (band byte). */
const SIDEBAND_CHUNK = 65515;

/** Frame `data` as band-`band` sideband pkt-lines. */
export function sidebandWrap(data: Buffer, band = 1): Buffer[] {
  const frames: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + SIDEBAND_CHUNK, data.length));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    frames.push(pktLine(payload));
  }
  if (data.length === 0) frames.push(pktLine(Buffer.from([band])));
  return frames;
}
