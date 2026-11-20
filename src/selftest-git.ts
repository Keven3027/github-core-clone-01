/**
 * Self-test for the git core (store/gitcore/git-http): starts a local http server wired to the
 * same handle() app.ts will use, then drives it with the kit's own GitClient — the exact client
 * the conformance suite speaks. Covers v2 ls-refs, v2 fetch (full/incremental/shallow/deepen),
 * v0 clone, push (create/update/delete ref, non-fast-forward, mixed batches, sideband report),
 * error handling (401/404/malformed) and the Forge low-level ops, plus the two perf workloads.
 *
 * Run: /root/makefun/node-v22.22.0-linux-x64/bin/node src/selftest-git.ts
 */

process.env.MAKEFUN_SHOP_TOKEN = 'tok-selftest';
process.env.MAKEFUN_SHOP_LOGIN = 'octo';

const { forge } = await import('./gitcore.ts');
const { handle, isGitRoute } = await import('./git-http.ts');
const S = await import('./store.ts');
const kit = await import('/root/makefun/github-core-clone-01-kit/program/env/src/git-client.ts');
import { createServer } from 'node:http';
import type { Buffer } from 'node:buffer';

const {
  ZERO_OID,
  GitClient,
  buildCommit,
  buildTag,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTree,
  readPack,
  verifyPackChecksum,
} = kit;
type GitObject = { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer };

let passed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string): void {
  if (cond) passed += 1;
  else failures.push(label);
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(Object.is(a, b) || String(a) === String(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ---------------------------------------------------------------------------------------------
// a local repository model, mirroring what the suite's checks build client-side
// ---------------------------------------------------------------------------------------------

class Local {
  objects = new Map<string, GitObject>();
  refs = new Map<string, string>();

  put(type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  blob(data: Buffer | string): string {
    return this.put('blob', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  treeFromFiles(files: readonly { path: string; data: Buffer }[]): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const file of files) {
      const segments = file.path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
        node = node.dirs.get(segments[i])!;
      }
      node.files.set(segments[segments.length - 1], file.data);
    }
    const build = (node: Node): string => {
      const entries: { mode: string; name: string; oid: string }[] = [];
      for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
        entries.push({ mode: '100644', name, oid: this.blob(data) });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : 1))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  commit(files: readonly { path: string; data: Buffer }[], meta: { message: string; timestamp: number; author: string }, parents: readonly string[] = []): string {
    const tree = this.treeFromFiles(files);
    const data = buildCommit({
      tree,
      parents,
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      author: meta.author,
      committer: meta.author,
      timestamp: meta.timestamp,
    });
    return this.put('commit', data);
  }

  tag(name: string, target: string, meta: { message: string; timestamp: number; author: string }): string {
    const data = buildTag({
      object: target,
      type: 'commit',
      tag: name,
      message: `${meta.message}\n`,
      tagger: meta.author,
      timestamp: meta.timestamp,
    });
    return this.put('tag', data);
  }

  reachable(tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => this.objects.get(oid));
  }
}

const AUTHOR = 'Octo Cat <octo@example.com>';
function meta(i: number, rev = 0): { message: string; timestamp: number; author: string } {
  return { message: `commit ${i} rev ${rev}`, timestamp: 1700000000 + i * 10 + rev, author: AUTHOR };
}

/** Push commands, sending only the objects the advertised tips do not reach (as the suite does). */
async function pushRefs(
  client: InstanceType<typeof GitClient>,
  owner: string,
  repo: string,
  local: Local,
  commands: readonly { oldOid: string; newOid: string; ref: string }[],
  objectsOverride?: readonly GitObject[],
) {
  let objects = objectsOverride;
  if (objects === undefined) {
    const adv = await client.advertisement(owner, repo, 'git-receive-pack');
    if (adv.protocol !== 0) throw new Error(`receive-pack advertisement is v${adv.protocol}`);
    const onServer = new Set<string>();
    let complete = true;
    for (const ref of adv.refs) {
      if (!ref.oid || ref.oid === ZERO_OID) continue;
      try {
        for (const oid of collectReachable([ref.oid], (o) => local.objects.get(o))) onServer.add(oid);
      } catch {
        complete = false;
        break;
      }
    }
    if (!complete) onServer.clear();
    const send: GitObject[] = [];
    const newTips = commands.filter((c) => c.newOid !== ZERO_OID).map((c) => c.newOid);
    for (const oid of collectReachable(newTips, (o) => local.objects.get(o))) {
      if (onServer.has(oid)) continue;
      const obj = local.objects.get(oid);
      if (obj) send.push(obj);
    }
    objects = send;
  }
  const result = await client.push(owner, repo, commands, { objects });
  if (result.report) {
    for (const report of result.report.refs) {
      if (!report.ok) continue;
      const command = commands.find((c) => c.ref === report.ref);
      if (!command) continue;
      if (command.newOid === ZERO_OID) local.refs.delete(report.ref);
      else local.refs.set(report.ref, command.newOid);
    }
  }
  return result;
}

function reportFor(result: { report: { refs: { ref: string; ok: boolean; reason: string }[] } | null }, ref: string) {
  return result.report?.refs.find((entry) => entry.ref === ref);
}

function pushFailure(result: ReturnType<typeof Object>): string {
  const report = (result as { report: { unpackOk: boolean; unpackDetail: string; refs: { ref: string; ok: boolean; reason: string }[] } | null }).report;
  if (!report) return 'no report';
  if (!report.unpackOk) return `unpack failed: ${report.unpackDetail}`;
  const bad = report.refs.filter((e) => !e.ok);
  return bad.length ? bad.map((e) => `${e.ref}: ${e.reason}`).join('; ') : 'unknown';
}

// ---------------------------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://x').pathname;
  } catch {
    path = '/';
  }
  if (req.method === 'GET' && path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (await handle(req, res)) return;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"message":"Not Found"}\n');
});
await new Promise<void>((resolve) => server.listen(0, () => resolve()));
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;
const client = new GitClient({ baseUrl, token: 'tok-selftest', timeoutMs: 30000 });
const client0 = new GitClient({ baseUrl, token: 'tok-selftest', timeoutMs: 30000, gitProtocol: 0 });

try {
  // ------------------------------------------------------------------
  // advertisements: v2, v0, receive-pack, content types, preambles
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'adv', 'advertisements');
  const adv2 = await client.advertisement('octo', 'adv', 'git-upload-pack');
  eq(adv2.protocol, 2, 'advertise-v2: protocol is 2');
  ok(adv2.capabilities.has('fetch') && adv2.capabilities.has('ls-refs'), 'advertise-v2: fetch+ls-refs advertised');
  eq(adv2.capabilities.get('object-format'), 'sha1', 'advertise-v2: object-format=sha1');

  const adv0 = await client0.advertisement('octo', 'adv', 'git-upload-pack');
  eq(adv0.protocol, 0, 'advertise-v0: protocol is 0');
  ok(adv0.capabilities.has('side-band-64k'), 'advertise-v0: side-band-64k advertised');
  ok(adv0.hadServiceHeader, 'advertise-v0: preamble present');
  ok(adv0.refs.every((r) => !r.name.startsWith('refs/')), 'advertise-v0: empty repo advertises no refs');

  const advR = await client.advertisement('octo', 'adv', 'git-receive-pack');
  eq(advR.protocol, 0, 'advertise-receive: protocol is 0');
  ok(
    ['report-status', 'side-band-64k', 'delete-refs'].every((c) => advR.capabilities.has(c)),
    'advertise-receive: report-status, side-band-64k, delete-refs advertised',
  );
  ok(advR.hadServiceHeader, 'advertise-receive: preamble present');

  const v0raw = await client0.infoRefs('octo', 'adv', 'git-upload-pack');
  const v2raw = await client.infoRefs('octo', 'adv', 'git-upload-pack');
  const rraw = await client.infoRefs('octo', 'adv', 'git-receive-pack');
  ok((v0raw.contentType ?? '').includes('application/x-git-upload-pack-advertisement'), 'headers: v0 upload content-type');
  ok((v2raw.contentType ?? '').includes('application/x-git-upload-pack-advertisement'), 'headers: v2 upload content-type');
  ok((rraw.contentType ?? '').includes('application/x-git-receive-pack-advertisement'), 'headers: receive content-type');
  const firstData = (raw: { packets: { kind: string; payload?: Buffer }[] }): string => {
    const p = raw.packets.find((x) => x.kind === 'data');
    return p && p.payload ? p.payload.toString('utf8').replace(/\n$/, '') : '';
  };
  eq(firstData(v0raw), '# service=git-upload-pack', 'headers: v0 preamble line');
  eq(firstData(v2raw), 'version 2', 'headers: v2 version line');
  eq(firstData(rraw), '# service=git-receive-pack', 'headers: receive preamble line');

  // ------------------------------------------------------------------
  // auth + 404s, server stays alive
  // ------------------------------------------------------------------
  const noAuth = await fetch(`${baseUrl}/octo/adv.git/info/refs?service=git-upload-pack`);
  eq(noAuth.status, 401, 'auth: missing token → 401');
  const badAuth = await fetch(`${baseUrl}/octo/adv.git/info/refs?service=git-upload-pack`, { headers: { authorization: 'Bearer wrong' } });
  eq(badAuth.status, 401, 'auth: wrong token → 401');
  const missingU = await client.infoRefs('octo', 'nope-missing', 'git-upload-pack');
  const missingR = await client.infoRefs('octo', 'nope-missing', 'git-receive-pack');
  eq(missingU.status, 404, '404: upload-pack info/refs of missing repo');
  eq(missingR.status, 404, '404: receive-pack info/refs of missing repo');
  const otherOwner = await client.infoRefs('someone-else', 'adv', 'git-upload-pack');
  eq(otherOwner.status, 404, '404: owner does not match Forge.login');
  const still = await client.infoRefs('octo', 'adv', 'git-upload-pack');
  eq(still.status, 200, 'alive: known repo still answers 200 after errors');

  // ------------------------------------------------------------------
  // push first commit on an unborn branch
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'first', 'first commit');
  const L1 = new Local();
  const tip1 = L1.commit([{ path: 'a.txt', data: Buffer.from('hello world\n') }], meta(0));
  const pushed1 = await pushRefs(client, 'octo', 'first', L1, [{ oldOid: ZERO_OID, newOid: tip1, ref: 'refs/heads/main' }]);
  ok(pushed1.report?.unpackOk === true, 'push-first: unpack ok');
  ok(reportFor(pushed1, 'refs/heads/main')?.ok === true, 'push-first: report ok');
  ok(pushed1.sideband, 'push-first: side-band-64k used');
  const listed1 = await client.lsRefs('octo', 'first');
  eq(listed1.refs.find((r) => r.name === 'refs/heads/main')?.oid, tip1, 'push-first: main advertised at tip');
  eq(listed1.refs.find((r) => r.name === 'HEAD')?.symrefTarget, 'refs/heads/main', 'push-first: HEAD symref');

  // ------------------------------------------------------------------
  // clone-empty
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'empty', 'empty repo');
  const emptyClone = await client.clone('octo', 'empty');
  eq(emptyClone.objects.size, 0, 'clone-empty: no objects');
  eq(emptyClone.refs.filter((r) => r.name.startsWith('refs/')).length, 0, 'clone-empty: no refs');
  eq(emptyClone.head, 'refs/heads/main', 'clone-empty: unborn HEAD symref target');

  // ------------------------------------------------------------------
  // full clone (v2), byte-exact object comparison incl. nested trees
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'full', 'full clone');
  const L2 = new Local();
  const t1 = L2.commit(
    [
      { path: 'src/deep/nested/one.txt', data: Buffer.from('one\n') },
      { path: 'src/two.txt', data: Buffer.from('two\n') },
      { path: 'top.txt', data: Buffer.from('top\n'.repeat(100)) },
    ],
    meta(0),
  );
  const t2 = L2.commit([{ path: 'src/deep/nested/one.txt', data: Buffer.from('one rev1\n') }, { path: 'src/two.txt', data: Buffer.from('two\n') }], meta(1), [t1]);
  const t3 = L2.commit([{ path: 'src/deep/nested/one.txt', data: Buffer.from('one rev1\n') }, { path: 'src/two.txt', data: Buffer.from('two rev2\n') }], meta(2), [t2]);
  const pushed2 = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: ZERO_OID, newOid: t3, ref: 'refs/heads/main' }]);
  ok(reportFor(pushed2, 'refs/heads/main')?.ok === true, `push-full setup ok: ${pushFailure(pushed2)}`);
  const full = await client.clone('octo', 'full');
  eq(full.head, 'refs/heads/main', 'clone-full: head symref');
  const expected = L2.reachable([t3]);
  let fullOk = expected.size === full.objects.size;
  for (const oid of expected) {
    const want = L2.objects.get(oid)!;
    const got = full.objects.get(oid);
    if (!got || got.type !== want.type || !got.data.equals(want.data)) fullOk = false;
  }
  ok(fullOk, `clone-full: ${expected.size} objects byte-identical (got ${full.objects.size})`);
  const parsedTip = parseCommit(full.objects.get(t3)!.data);
  eq(parsedTip.parents[0], t2, 'clone-full: tip parent chain');
  ok(parsedTip.message.endsWith('commit 2 rev 0\n'), 'clone-full: tip message round-trips');

  // ------------------------------------------------------------------
  // v0 clone full
  // ------------------------------------------------------------------
  const full0 = await client0.clone('octo', 'full');
  let v0Ok = full0.objects.size === expected.size;
  for (const oid of expected) {
    const want = L2.objects.get(oid)!;
    const got = full0.objects.get(oid);
    if (!got || got.type !== want.type || !got.data.equals(want.data)) v0Ok = false;
  }
  ok(v0Ok, `clone-v0: byte-identical (${full0.objects.size} objects)`);
  eq(full0.protocol, 0, 'clone-v0: served v0');

  // ------------------------------------------------------------------
  // annotated tag: push, ls-refs peel, clone round-trip
  // ------------------------------------------------------------------
  const tagObj = L2.tag('v1', t3, meta(3));
  const pushedTag = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: ZERO_OID, newOid: tagObj, ref: 'refs/tags/v1' }]);
  ok(reportFor(pushedTag, 'refs/tags/v1')?.ok === true, 'push-tag: ok');
  const lsTag = await client.lsRefs('octo', 'full', { peel: true, symrefs: true });
  const tagRef = lsTag.refs.find((r) => r.name === 'refs/tags/v1');
  eq(tagRef?.oid, tagObj, 'ls-refs: tag object advertised');
  eq(tagRef?.peeled, t3, 'ls-refs: tag peels to its commit');
  const tagClone = await client.clone('octo', 'full');
  ok(tagClone.objects.get(tagObj)!.data.equals(L2.objects.get(tagObj)!.data), 'clone: tag object byte-identical');

  // ------------------------------------------------------------------
  // incremental fetch (haves)
  // ------------------------------------------------------------------
  const t4 = L2.commit([{ path: 'src/two.txt', data: Buffer.from('two rev3\n') }], meta(4), [t3]);
  const pushed4 = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: t3, newOid: t4, ref: 'refs/heads/main' }]);
  ok(reportFor(pushed4, 'refs/heads/main')?.ok === true, 'fetch-inc: setup push ok');
  const fetched = await client.fetch('octo', 'full', { wants: [t4], haves: [t3], haveObjects: tagClone.objects });
  ok(fetched.objects.has(t4), 'fetch-inc: new tip delivered');
  ok(!fetched.objects.has(t3), 'fetch-inc: old tip not re-sent');
  const oldSet = L2.reachable([t3]);
  const expectedNew = [...L2.reachable([t4])].filter((o) => !oldSet.has(o));
  ok(expectedNew.every((o) => fetched.objects.has(o)), 'fetch-inc: all new objects delivered');
  ok(![...fetched.objects.keys()].some((o) => oldSet.has(o)), 'fetch-inc: no held object re-sent');

  // ------------------------------------------------------------------
  // fetch nothing new
  // ------------------------------------------------------------------
  const fetchedNothing = await client.fetch('octo', 'full', { wants: [t4], haves: [t4], haveObjects: fetched.objects });
  eq(fetchedNothing.objects.size, 0, 'fetch-nothing-new: zero objects');

  // ------------------------------------------------------------------
  // pack integrity: fetch raw pack, verify checksum and structure
  // ------------------------------------------------------------------
  const rawFetch = await client.fetch('octo', 'full', { wants: [t4], parse: false });
  ok(rawFetch.pack !== null, 'pack-integrity: pack delivered');
  if (rawFetch.pack) {
    ok(verifyPackChecksum(rawFetch.pack).ok, 'pack-integrity: trailer checksum');
    const parsed = readPack(rawFetch.pack);
    eq(parsed.declaredCount, parsed.entries.length, 'pack-integrity: declared count matches entries');
    ok(parsed.version === 2 || parsed.version === 3, 'pack-integrity: pack version');
    let allHash = true;
    for (const [oid, obj] of parsed.objects) if (hashObject(obj.type, obj.data) !== oid) allHash = false;
    ok(allHash, 'pack-integrity: every object recomputes to its id');
  }

  // ------------------------------------------------------------------
  // shallow: depth-1 clone, deepen 2, shallow fetch of a new tip
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'shallow', 'shallow');
  const L3 = new Local();
  const s1 = L3.commit([{ path: 'f.txt', data: Buffer.from('gen1\n') }], meta(0));
  const s2 = L3.commit([{ path: 'f.txt', data: Buffer.from('gen2\n') }], meta(1), [s1]);
  const s3 = L3.commit([{ path: 'f.txt', data: Buffer.from('gen3\n') }], meta(2), [s2]);
  await pushRefs(client, 'octo', 'shallow', L3, [{ oldOid: ZERO_OID, newOid: s3, ref: 'refs/heads/main' }]);

  const shallow1 = await client.clone('octo', 'shallow', { depth: 1 });
  ok(shallow1.objects.has(s3), 'shallow-1: tip present');
  ok(!shallow1.objects.has(s2) && !shallow1.objects.has(s1), 'shallow-1: no history beyond depth 1');
  const tipTree = parseCommit(shallow1.objects.get(s3)!.data).tree;
  ok(shallow1.objects.has(tipTree), 'shallow-1: tip tree present');
  ok(parseTree(shallow1.objects.get(tipTree)!.data).every((e) => shallow1.objects.has(e.oid)), 'shallow-1: tip blobs present');
  ok(shallow1.shallow.includes(s3), 'shallow-1: shallow-info names the tip');

  const deepened = await client.fetch('octo', 'shallow', { wants: [s3], haves: [s3], shallow: shallow1.shallow, depth: 2, haveObjects: shallow1.objects });
  ok(deepened.objects.has(s2), 'deepen-2: parent delivered');
  ok(!deepened.objects.has(s1), 'deepen-2: grandparent still absent');
  ok(deepened.shallow.includes(s2) || deepened.unshallow.includes(s3), 'deepen-2: boundary moved');
  ok(deepened.objects.has(parseCommit(deepened.objects.get(s2)!.data).tree), 'deepen-2: parent tree delivered');

  const s4 = L3.commit([{ path: 'f.txt', data: Buffer.from('gen4\n') }], meta(3), [s2]);
  await pushRefs(client, 'octo', 'shallow', L3, [{ oldOid: s2, newOid: s4, ref: 'refs/heads/main' }]);
  const newTipFetch = await client.fetch('octo', 'shallow', { wants: [s4], haves: [s2], shallow: [s2], depth: 1, haveObjects: deepened.objects });
  ok(newTipFetch.objects.has(s4), 'shallow-new-tip: new tip delivered');
  ok(!newTipFetch.objects.has(s1), 'shallow-new-tip: old history absent');
  ok(!newTipFetch.objects.has(s2), 'shallow-new-tip: held parent not re-sent');

  // ------------------------------------------------------------------
  // push: update ref (FF), create branch, delete branch, delete tag
  // ------------------------------------------------------------------
  const u2 = L2.commit([{ path: 'src/two.txt', data: Buffer.from('two rev4\n') }], meta(5), [t4]);
  const pushedU = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: t4, newOid: u2, ref: 'refs/heads/main' }]);
  ok(reportFor(pushedU, 'refs/heads/main')?.ok === true, 'push-update: fast-forward accepted');
  const lsU = await client.lsRefs('octo', 'full');
  eq(lsU.refs.find((r) => r.name === 'refs/heads/main')?.oid, u2, 'push-update: ref moved');
  const cloneU = await client.clone('octo', 'full');
  ok(cloneU.objects.has(u2), 'push-update: clone sees new tip');

  const created = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: ZERO_OID, newOid: u2, ref: 'refs/heads/feature' }]);
  ok(reportFor(created, 'refs/heads/feature')?.ok === true, 'push-create: branch created');
  const lsC = await client.lsRefs('octo', 'full');
  eq(lsC.refs.find((r) => r.name === 'refs/heads/feature')?.oid, u2, 'push-create: advertised');
  const cloneC = await client.clone('octo', 'full');
  ok(cloneC.refs.some((r) => r.name === 'refs/heads/feature' && r.oid === u2), 'push-create: clone sees branch');

  const deleted = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: u2, newOid: ZERO_OID, ref: 'refs/heads/feature' }]);
  ok(deleted.report?.unpackOk === true, 'push-delete: unpack ok (no pack)');
  ok(reportFor(deleted, 'refs/heads/feature')?.ok === true, 'push-delete: branch deleted');
  const lsD = await client.lsRefs('octo', 'full');
  ok(!lsD.refs.some((r) => r.name === 'refs/heads/feature'), 'push-delete: ref gone');
  eq(lsD.refs.find((r) => r.name === 'refs/heads/main')?.oid, u2, 'push-delete: main intact');

  const tagDeleted = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: tagObj, newOid: ZERO_OID, ref: 'refs/tags/v1' }]);
  ok(reportFor(tagDeleted, 'refs/tags/v1')?.ok === true, 'push-delete-tag: ok');
  ok(!(await client.lsRefs('octo', 'full')).refs.some((r) => r.name === 'refs/tags/v1'), 'push-delete-tag: tag ref gone');

  // ------------------------------------------------------------------
  // non-fast-forward refused per ref; mixed batch applies only the ok ref
  // ------------------------------------------------------------------
  // sibling branches off t4 (an ancestor of u2): pushing it with oldOid=u2 is a non-fast-forward
  const sibling = L2.commit([{ path: 'sib.txt', data: Buffer.from('sibling\n') }], meta(6), [t4]);
  const refused = await client.push(
    'octo',
    'full',
    [{ oldOid: u2, newOid: sibling, ref: 'refs/heads/main' }],
    { objects: [...L2.reachable([sibling])].map((o) => L2.objects.get(o)!) },
  );
  ok(refused.report?.unpackOk === true, 'non-ff: still unpacks');
  const refusedReport = reportFor(refused, 'refs/heads/main');
  ok(refusedReport && !refusedReport.ok, 'non-ff: refused');
  eq(refusedReport?.reason, 'non-fast-forward', 'non-ff: reason string');
  eq((await client.lsRefs('octo', 'full')).refs.find((r) => r.name === 'refs/heads/main')?.oid, u2, 'non-ff: ref unmoved');
  eq((await client.infoRefs('octo', 'full', 'git-upload-pack')).status, 200, 'non-ff: server healthy');

  const forward = L2.commit([{ path: 'fwd.txt', data: Buffer.from('forward\n') }], meta(7), [u2]);
  // refs/heads/side must exist at u2 first, so the mixed batch has one FF update and one refused update
  const sideCreate = await pushRefs(client, 'octo', 'full', L2, [{ oldOid: ZERO_OID, newOid: u2, ref: 'refs/heads/side' }]);
  ok(reportFor(sideCreate, 'refs/heads/side')?.ok === true, 'mixed setup: side created at u2');
  const mixed = await client.push(
    'octo',
    'full',
    [
      { oldOid: u2, newOid: forward, ref: 'refs/heads/main' },
      { oldOid: u2, newOid: sibling, ref: 'refs/heads/side' },
    ],
    { objects: [...new Set([...L2.reachable([forward]), ...L2.reachable([sibling])])].map((o) => L2.objects.get(o)!) },
  );
  ok(mixed.report?.unpackOk === true, 'mixed: unpack ok');
  eq(mixed.report?.refs.length, 2, 'mixed: two report lines');
  ok(reportFor(mixed, 'refs/heads/main')?.ok === true, 'mixed: main ok');
  ok(reportFor(mixed, 'refs/heads/side')?.ok === false && reportFor(mixed, 'refs/heads/side')?.reason === 'non-fast-forward', 'mixed: side ng non-fast-forward');
  const lsM = await client.lsRefs('octo', 'full');
  eq(lsM.refs.find((r) => r.name === 'refs/heads/main')?.oid, forward, 'mixed: main advanced');
  eq(lsM.refs.find((r) => r.name === 'refs/heads/side')?.oid, u2, 'mixed: side unmoved (still u2)');

  // ------------------------------------------------------------------
  // 100-file push and clone, nested paths
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'many', '100 files');
  const L4 = new Local();
  const manyFiles = [];
  for (let i = 0; i < 100; i += 1) {
    manyFiles.push({ path: i % 3 === 0 ? `dir${Math.floor(i / 30)}/file${i}.txt` : `file${i}.txt`, data: Buffer.from(`content ${i}\n${'pad'.repeat(i % 7)}\n`) });
  }
  const manyTip = L4.commit(manyFiles, meta(10));
  const pushedMany = await pushRefs(client, 'octo', 'many', L4, [{ oldOid: ZERO_OID, newOid: manyTip, ref: 'refs/heads/main' }]);
  ok(reportFor(pushedMany, 'refs/heads/main')?.ok === true, 'push-100: accepted');
  const manyClone = await client.clone('octo', 'many');
  let manyOk = true;
  for (const oid of L4.reachable([manyTip])) {
    const want = L4.objects.get(oid)!;
    const got = manyClone.objects.get(oid);
    if (!got || got.type !== want.type || !got.data.equals(want.data)) manyOk = false;
  }
  ok(manyOk, 'push-100: clone byte-identical');
  const manyCommit = parseCommit(manyClone.objects.get(manyTip)!.data);
  let pathOk = true;
  for (const file of manyFiles) {
    let oid = manyCommit.tree;
    for (const segment of file.path.split('/')) {
      const entry = parseTree(manyClone.objects.get(oid)!.data).find((e) => e.name === segment);
      if (!entry) {
        pathOk = false;
        break;
      }
      oid = entry.oid;
    }
    if (!manyClone.objects.get(oid)!.data.equals(file.data)) pathOk = false;
  }
  ok(pathOk, 'push-100: every path resolves to the pushed bytes');

  // ------------------------------------------------------------------
  // ls-refs ref-prefix filtering
  // ------------------------------------------------------------------
  const heads = await client.lsRefs('octo', 'full', { prefixes: ['refs/heads/'] });
  ok(heads.rawRefs.every((r) => r.name.startsWith('refs/heads/')), 'ref-prefix: heads only');
  ok(heads.rawRefs.some((r) => r.name === 'refs/heads/main'), 'ref-prefix: main present');
  const none = await client.lsRefs('octo', 'full', { prefixes: ['refs/does-not-exist/'] });
  eq(none.rawRefs.length, 0, 'ref-prefix: unmatched prefix → no refs');

  // ------------------------------------------------------------------
  // malformed POST does not kill the server
  // ------------------------------------------------------------------
  const malformed = await fetch(`${baseUrl}/octo/full.git/git-upload-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', authorization: 'Bearer tok-selftest' },
    body: 'zzzznot-a-pkt-line',
  });
  ok(malformed.status >= 400 && malformed.status < 500, `malformed POST → ${malformed.status} (4xx)`);
  eq((await client.infoRefs('octo', 'full', 'git-upload-pack')).status, 200, 'malformed: server healthy');
  const cloneAfter = await client.clone('octo', 'full');
  ok(cloneAfter.objects.has(forward), 'malformed: clone intact');

  // ------------------------------------------------------------------
  // Forge low-level ops: upsertFile / deleteFile / squashMerge / listBranchCommits
  // ------------------------------------------------------------------
  const repoOps = forge.createRepo('octo', 'ops', 'forge ops');
  const up1 = forge.upsertFile(repoOps, 'main', 'docs/readme.md', Buffer.from('# hi\n'), 'add readme');
  ok(up1.commitSha && repoOps.refs.get('refs/heads/main') === up1.commitSha, 'upsertFile: creates branch+commit');
  ok(up1.oldSha === undefined, 'upsertFile: no oldSha on create');
  const up2 = forge.upsertFile(repoOps, 'main', 'docs/readme.md', Buffer.from('# hi v2\n'), 'update readme');
  eq(up2.oldSha, hashObject('blob', Buffer.from('# hi\n')), 'upsertFile: old blob sha returned');
  const commits = forge.listBranchCommits(repoOps, 'main', 10);
  eq(commits.length, 2, 'listBranchCommits: depth covers both');
  eq(commits[0].parents[0], up1.commitSha, 'listBranchCommits: parent chain');
  ok(typeof commits[0].author.name === 'string' && typeof commits[0].author.when === 'string', 'listBranchCommits: author parsed');

  // branching feature off main tip via git push, then squashMerge
  const featureTip0 = repoOps.refs.get('refs/heads/main')!;
  const cF = new GitClient({ baseUrl, token: 'tok-selftest', timeoutMs: 30000 });
  const featureObj = repoOps.objects.get(featureTip0)!;
  const pushedF = await cF.push(
    'octo',
    'ops',
    [{ oldOid: ZERO_OID, newOid: featureTip0, ref: 'refs/heads/feature' }],
    { objects: [featureObj] },
  );
  ok(reportFor(pushedF, 'refs/heads/feature')?.ok === true, 'ops: feature branch pushed at main tip');
  forge.upsertFile(repoOps, 'main', 'main-only.txt', Buffer.from('main change\n'), 'main side');
  forge.upsertFile(repoOps, 'feature', 'feature-only.txt', Buffer.from('feature change\n'), 'feature side');
  const merged = forge.squashMerge(repoOps, 'feature', 'main', 'merge feature');
  ok(typeof merged === 'object' && 'sha' in merged, 'squashMerge: clean merge');
  if (typeof merged === 'object' && 'sha' in merged) {
    eq(repoOps.refs.get('refs/heads/main'), merged.sha, 'squashMerge: base ref moved');
    const mergeCommit = forge.listBranchCommits(repoOps, 'main', 1)[0];
    eq(mergeCommit.parents.length, 2, 'squashMerge: two parents (base, head)');
    const tree = S.flattenTree(repoOps.objects, mergeCommit.tree);
    ok(tree.has('main-only.txt') && tree.has('feature-only.txt') && tree.has('docs/readme.md'), 'squashMerge: merged tree holds both sides');
  }

  // conflict: same file changed on both sides
  const repoCf = forge.createRepo('octo', 'conflict', 'conflict');
  forge.upsertFile(repoCf, 'main', 'shared.txt', Buffer.from('base\n'), 'base');
  const baseTip = repoCf.refs.get('refs/heads/main')!;
  const cF2 = new GitClient({ baseUrl, token: 'tok-selftest', timeoutMs: 30000 });
  await cF2.push('octo', 'conflict', [{ oldOid: ZERO_OID, newOid: baseTip, ref: 'refs/heads/feature' }], { objects: [repoCf.objects.get(baseTip)!] });
  forge.upsertFile(repoCf, 'main', 'shared.txt', Buffer.from('main version\n'), 'main edit');
  forge.upsertFile(repoCf, 'feature', 'shared.txt', Buffer.from('feature version\n'), 'feature edit');
  const mainTipBeforeConflict = repoCf.refs.get('refs/heads/main');
  const conflicted = forge.squashMerge(repoCf, 'feature', 'main', 'merge conflict');
  eq(conflicted, 'conflict', 'squashMerge: same-file conflict detected');
  eq(repoCf.refs.get('refs/heads/main'), mainTipBeforeConflict, 'squashMerge: conflict did not move base ref');

  // one-sided change merges fine even with a diverged sibling file
  const repoOk = forge.createRepo('octo', 'oneside', 'one side');
  forge.upsertFile(repoOk, 'main', 'a.txt', Buffer.from('a0\n'), 'a0');
  const tipA = repoOk.refs.get('refs/heads/main')!;
  await cF2.push('octo', 'oneside', [{ oldOid: ZERO_OID, newOid: tipA, ref: 'refs/heads/feature' }], { objects: [repoOk.objects.get(tipA)!] });
  forge.upsertFile(repoOk, 'main', 'a.txt', Buffer.from('a1\n'), 'main edit');
  forge.upsertFile(repoOk, 'feature', 'b.txt', Buffer.from('b1\n'), 'feature edit');
  const mergedOne = forge.squashMerge(repoOk, 'feature', 'main', 'one-sided');
  ok(typeof mergedOne === 'object' && 'sha' in mergedOne, 'squashMerge: one-sided change merges');
  const treeOne = S.flattenTree(repoOk.objects, forge.listBranchCommits(repoOk, 'main', 1)[0].tree);
  eq(treeOne.get('a.txt')!.sha, hashObject('blob', Buffer.from('a1\n')), 'squashMerge: main-side edit kept');
  eq(treeOne.get('b.txt')!.sha, hashObject('blob', Buffer.from('b1\n')), 'squashMerge: feature-side file added');

  forge.deleteFile(repoOps, 'main', 'main-only.txt', 'drop file');
  ok(!S.flattenTree(repoOps.objects, forge.listBranchCommits(repoOps, 'main', 1)[0].tree).has('main-only.txt'), 'deleteFile: path removed');

  // ------------------------------------------------------------------
  // perf workload 1: 200 sequential pushes of a 1 KiB change
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'perf-push', 'perf push');
  const LP = new Local();
  const base1KiB = 'x'.repeat(1000);
  let prev: string | null = null;
  const perfClient = new GitClient({ baseUrl, token: 'tok-selftest', timeoutMs: 60000 });
  const pushStart = Date.now();
  for (let i = 1; i <= 200; i += 1) {
    const tip = LP.commit([{ path: 'work.txt', data: Buffer.from(`${base1KiB}\nrev ${i}\n`) }], meta(i), prev ? [prev] : []);
    const commands = [{ oldOid: prev ?? ZERO_OID, newOid: tip, ref: 'refs/heads/main' }];
    const result = await pushRefs(perfClient, 'octo', 'perf-push', LP, commands);
    if (reportFor(result, 'refs/heads/main')?.ok !== true) throw new Error(`perf push ${i} failed: ${pushFailure(result)}`);
    prev = tip;
  }
  const pushMs = Date.now() - pushStart;
  ok(pushMs < 15000, `perf-push: 200 pushes in ${pushMs}ms (< 15s)`);
  console.log(`[perf] 200 sequential pushes: ${pushMs}ms`);

  // ------------------------------------------------------------------
  // perf workload 2: 50 concurrent shallow clones (depth 1) of a 200-commit repo
  // ------------------------------------------------------------------
  forge.createRepo('octo', 'perf-clone', 'perf clone');
  const LC = new Local();
  let chainPrev: string | null = null;
  for (let i = 1; i <= 200; i += 1) {
    chainPrev = LC.commit([{ path: 'hist.txt', data: Buffer.from(`${base1KiB}\nrev ${i}\n`) }], meta(i), chainPrev ? [chainPrev] : []);
  }
  await pushRefs(perfClient, 'octo', 'perf-clone', LC, [{ oldOid: ZERO_OID, newOid: chainPrev!, ref: 'refs/heads/main' }]);
  const cloneStart = Date.now();
  const clones = await Promise.all(Array.from({ length: 50 }, () => perfClient.clone('octo', 'perf-clone', { depth: 1, parse: false })));
  const cloneMs = Date.now() - cloneStart;
  ok(clones.every((c) => c.shallow.includes(chainPrev!) || c.objects.has(chainPrev!)), 'perf-clone: every shallow clone got the tip');
  ok(clones.every((c) => c.pack !== null && verifyPackChecksum(c.pack!).ok), 'perf-clone: every pack checksums');
  ok(cloneMs < 15000, `perf-clone: 50 concurrent shallow clones in ${cloneMs}ms (< 15s)`);
  console.log(`[perf] 50 concurrent shallow clones (200-commit repo): ${cloneMs}ms`);

  // parse sanity on one shallow clone
  const shallowParsed = await perfClient.clone('octo', 'perf-clone', { depth: 1 });
  ok(shallowParsed.objects.has(chainPrev!), 'perf-clone: parsed shallow clone has tip');
  ok(!shallowParsed.objects.has(LC.objects.get(chainPrev!) ? (parseCommit(LC.objects.get(chainPrev!)!.data).parents[0] ?? '') : ''), 'perf-clone: parent absent');
  ok(shallowParsed.objects.has(parseCommit(shallowParsed.objects.get(chainPrev!)!.data).tree), 'perf-clone: tip tree present');
} finally {
  server.close();
}

console.log(`\nselftest-git: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log(`  FAIL: ${failure}`);
  process.exit(1);
}
process.exit(0);
