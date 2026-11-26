/** Review regressions: metadata replacement, aliases, subroots and explicit deletions. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-review-'));
const compile = createSharedCompiler(root, tmp);
const entry = compile('main/turnChanges/service.ts');
const mutate = (file, from, to) => { const source = fs.readFileSync(file, 'utf8'); assert(source.includes(from)); fs.writeFileSync(file, source.replace(from, to)); };
if (process.argv.includes('--baseline-no-record-retry')) mutate(path.join(tmp, 'main/turnChanges/storage.mjs'), 'attempt >= 5', 'attempt >= 0');
const { TurnChangeService } = await import(pathToFileURL(entry));
const services = [];
const service = name => { const s = new TurnChangeService(path.join(tmp, name)); services.push(s); return s; };
const make = name => { const dir = path.join(tmp, name); fs.mkdirSync(dir); return dir; };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');
const edit = async (t, dir, file, text) => { await t.toolStart(file, 'write', { path: file, content: text }, undefined, true); write(dir, file, text); await t.toolEnd(file, true, undefined, true); };
const begin = async (s, dir, id = 'm', owner = 'gui:a') => { const t = s.begin(owner, id, dir, [dir]); await t.ready; return t; };
const commit = dir => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@local.invalid', '-c', 'commit.gpgSign=false', 'commit', '--quiet', '-m', 'fixture'); };
const originalRename = fs.promises.rename;
try {
  const work = make('work'), s = service('store'); write(work, 'a', 'personal original');
  const t = await begin(s, work); await edit(t, work, 'a', 'model'); const summary = await t.finish();
  const target = path.join(tmp, 'store', `${summary.id}.json`);
  let attempts = 0, yielded = false;
  fs.promises.rename = async (from, to) => {
    if (String(to) === target && ++attempts <= 2) throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' });
    return originalRename(from, to);
  };
  const resultPromise = s.revert(summary.id, 'gui:a', 'm', [work]);
  assert.equal(read(work, 'a'), 'personal original', 'all file checks/restores finish before metadata awaits');
  write(work, 'a', 'human during metadata retry');
  setImmediate(() => { yielded = true; });
  const duplicate = await s.revert(summary.id, 'gui:a', 'm', [work]);
  assert.equal(duplicate.ok, false); assert.match(duplicate.error, /正在保存/);
  const result = await resultPromise;
  assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(attempts, 3); assert(yielded, 'metadata retries must yield the event loop');
  assert.equal(read(work, 'a'), 'human during metadata retry');
  assert.equal(JSON.parse(fs.readFileSync(target)).summary.files[0].reverted, true);
  assert.deepEqual((await s.revert(summary.id, 'gui:a', 'm', [work])).restored, []);
  fs.promises.rename = originalRename;

  const permanent = await begin(s, work, 'permanent'); await edit(permanent, work, 'a', 'another model');
  const permanentSummary = await permanent.finish();
  const permanentTarget = path.join(tmp, 'store', `${permanentSummary.id}.json`), oldRecord = fs.readFileSync(permanentTarget);
  attempts = 0;
  fs.promises.rename = async (from, to) => {
    if (String(to) === permanentTarget) { attempts++; throw Object.assign(new Error('fixture permanent denial'), { code: 'EACCES' }); }
    return originalRename(from, to);
  };
  const denied = await s.revert(permanentSummary.id, 'gui:a', 'permanent', [work]);
  assert.equal(denied.ok, false); assert.deepEqual(denied.restored, ['a']); assert.equal(attempts, 6);
  assert.match(denied.error, /状态保存失败/); assert.deepEqual(fs.readFileSync(permanentTarget), oldRecord);
  assert.equal(read(work, 'a'), 'human during metadata retry');
  assert(!fs.readdirSync(path.join(tmp, 'store')).some(name => name.endsWith('.tmp')));
  fs.promises.rename = originalRename;

  const alias = path.join(tmp, 'alias'); fs.symlinkSync(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliases = service('aliases');
  const a = await begin(aliases, alias, 'alias'); await edit(a, alias, 'a', 'through alias'); const sa = await a.finish();
  assert.equal(sa.files[0].kind, 'modified'); assert.equal(sa.files[0].revertible, true);
  assert.equal((await aliases.revert(sa.id, 'gui:a', 'alias', [alias])).ok, true);
  assert.equal(read(work, 'a'), 'human during metadata retry');
  const first = await begin(aliases, work, 'first'), second = await begin(aliases, alias, 'second', 'gui:b');
  const collisions = []; aliases.setCollisionHandler(c => collisions.push(c));
  await edit(first, work, 'a', 'A'); await edit(second, alias, 'a', 'B');
  assert.equal(collisions.length, 1); assert.equal(first.summary.concurrentEdits[0].path, 'a'); assert.equal(second.summary.concurrentEdits[0].path, 'a');
  assert(!(await first.finish()).files[0].revertible); assert(!(await second.finish()).files[0].revertible);
  const own = await begin(aliases, work, 'busy'); await edit(own, work, 'a', 'owned'); const owned = await own.finish();
  const busy = await begin(aliases, alias, 'busy-peer', 'gui:b');
  assert.deepEqual((await aliases.revert(owned.id, 'gui:a', 'busy', [work])).restored, []);
  await busy.finish(); assert.equal((await aliases.revert(owned.id, 'gui:a', 'busy', [work])).ok, true);

  const repo = make('repo'), sub = path.join(repo, 'sub'); fs.mkdirSync(sub); git(repo, 'init', '--quiet'); git(repo, 'config', 'core.autocrlf', 'false');
  write(sub, 'a', 'committed'); write(sub, 'clean', 'clean tracked'); write(repo, 'outside', 'outside'); commit(repo);
  write(sub, 'a', 'personal dirty'); write(repo, 'outside', 'outside personal');
  const scoped = service('sub-store'), st = await begin(scoped, sub); await edit(st, sub, 'a', 'model sub'); const ss = await st.finish();
  assert.equal(ss.files[0].kind, 'modified'); assert.equal(ss.files[0].revertible, true, 'Git subroot must preserve dirty original');
  assert.equal((await scoped.revert(ss.id, 'gui:a', 'm', [sub])).ok, true); assert.equal(read(sub, 'a'), 'personal dirty');
  assert.equal(read(repo, 'outside'), 'outside personal');
  const subAlias = path.join(tmp, 'sub-alias'); fs.symlinkSync(sub, subAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const tracked = await begin(scoped, subAlias, 'tracked'); await edit(tracked, subAlias, 'clean', 'changed clean'); const ts = await tracked.finish();
  assert.equal(ts.files[0].revertible, true); assert.equal((await scoped.revert(ts.id, 'gui:a', 'tracked', [subAlias])).ok, true);
  assert.equal(read(sub, 'clean'), 'clean tracked');

  const filtered = make('filtered'); git(filtered, 'init', '--quiet'); write(filtered, 'a', 'committed');
  write(filtered, '.gitattributes', 'a filter=spy\n'); commit(filtered);
  const marker = path.join(filtered, '.git', 'objects', 'filter-ran'), script = path.join(tmp, 'spy.sh');
  const quote = value => "'" + value.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
  fs.writeFileSync(script, `#!/bin/sh\nprintf ran > ${quote(marker)}\ncat\n`);
  git(filtered, 'config', 'filter.spy.clean', `sh ${quote(script)}`); git(filtered, 'config', 'filter.spy.required', 'true');
  // A changed size lets status skip content hashing. Same-sized dirty bytes
  // force ce_compare_data through the configured clean program.
  write(filtered, 'a', 'personal!');
  git(filtered, 'status', '--porcelain=v1'); assert(fs.existsSync(marker), 'positive control: unguarded status must execute this filter'); fs.unlinkSync(marker);
  const filterService = service('filter-store'), ft = await begin(filterService, filtered);
  assert(!fs.existsSync(marker), 'read-only status must not execute configured clean/process programs');
  await edit(ft, filtered, 'a', 'modelXXXX'); const fsnap = await ft.finish();
  assert.equal((await filterService.revert(fsnap.id, 'gui:a', 'm', [filtered])).ok, true);
  assert.equal(read(filtered, 'a'), 'personal!'); assert(!fs.existsSync(marker));

  for (const periodic of [false, true]) {
    const ordinary = make('deleted-' + periodic), dir = path.join(ordinary, 'd'); fs.mkdirSync(path.join(dir, 'nested'), { recursive: true });
    write(dir, 'a', 'old a'); write(path.join(dir, 'nested'), 'b', 'old b');
    const ds = service('deleted-store-' + periodic), dt = await begin(ds, ordinary);
    const batch = await dt.beginFiles(['d/a', 'd/nested/b']);
    await dt.toolStart('shell', 'bash', {});
    assert.equal(path.dirname(dir), ordinary); fs.rmSync(dir, { recursive: true });
    await dt.toolEnd('shell', true); await dt.completeFiles(batch, ['d/a', 'd/nested/b']); const deleted = await dt.finish();
    assert.deepEqual(deleted.files.map(f => [f.path, f.kind, f.revertible]).sort(), [['d/a', 'deleted', false], ['d/nested/b', 'deleted', false]]);
  }

  const aggregate = make('aggregate'), child = path.join(aggregate, 'child'); fs.mkdirSync(child); git(child, 'init', '--quiet');
  write(child, 'a', 'child old'); write(aggregate, 'other', 'personal other');
  const aggregateService = service('aggregate-store');
  const moved = path.join(tmp, 'moved-child');
  assert.equal(path.dirname(child), aggregate); assert.equal(path.dirname(moved), tmp); fs.renameSync(child, moved);
  const remaining = await begin(aggregateService, aggregate);
  // The offline child only degrades discovery coverage; the healthy parent
  // root keeps full review and the stale child scope is retired after refresh.
  assert(remaining.summary.files.every(f => !f.revertible || f.path !== 'child/a'));
  await edit(remaining, aggregate, 'other', 'model other'); const remainingSummary = await remaining.finish();
  assert.equal((await aggregateService.revert(remainingSummary.id, 'gui:a', 'm', [aggregate])).ok, true);
  assert.equal(read(aggregate, 'other'), 'personal other'); assert.equal(read(moved, 'a'), 'child old');
  const rediscovered = await begin(aggregateService, aggregate, 'rediscovered');
  assert(!rediscovered.summary.warnings.some(w => w.includes('子仓目录已离线'))); await rediscovered.finish();

  // A local promisor remote makes lazy fetch observable without network access.
  const remote = make('promisor-remote'); git(remote, 'init', '--quiet'); write(remote, 'a', 'remote blob'); commit(remote);
  const clone = path.join(tmp, 'promisor'); git(tmp, 'clone', '--quiet', '--no-hardlinks', remote, clone);
  git(clone, 'config', 'remote.origin.promisor', 'true'); git(clone, 'config', 'extensions.partialClone', 'origin');
  const ps = service('promisor-store'), pt = await begin(ps, clone);
  const oid = git(clone, 'rev-parse', 'HEAD:a'), object = path.join(clone, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
  assert(fs.existsSync(object)); fs.unlinkSync(object);
  const objects = path.join(clone, '.git', 'objects');
  const inventory = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() ? inventory(path.join(dir, item.name)) : [path.relative(objects, path.join(dir, item.name))]).sort();
  const beforeObjects = inventory(objects);
  await pt.toolStart('shell', 'bash', {}); write(clone, 'a', 'external script'); await pt.toolEnd('shell', true);
  const partial = await pt.finish();
  assert(!fs.existsSync(object), 'read-only blob lookup must not lazy-fetch into the source object database');
  assert.deepEqual(inventory(objects), beforeObjects, 'promisor fallback must not write new source packs or loose objects');
  assert(partial.warnings.some(w => w.includes('命令改动'))); assert.equal(partial.files.length, 0);
  assert.equal(read(clone, 'a'), 'external script');
  const moduleParent = make('module-parent'); git(moduleParent, 'init', '--quiet');
  git(moduleParent, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', remote, 'module'); commit(moduleParent);
  const moduleDir = path.join(moduleParent, 'module');
  write(moduleDir, '.gitattributes', 'a filter=spy\n'); write(moduleDir, 'a', 'module mine');
  git(moduleDir, 'config', 'filter.spy.clean', `sh ${quote(script)}`);
  const moduleService = service('module-store'), mt = await begin(moduleService, moduleParent);
  assert(!fs.existsSync(marker), 'parent status and child scope must both suppress external filters');
  await edit(mt, moduleParent, 'module/a', 'module edit'); const ms = await mt.finish();
  assert.equal(ms.files[0].revertible, true); assert.equal((await moduleService.revert(ms.id, 'gui:a', 'm', [moduleParent])).ok, true);
  assert.equal(read(moduleDir, 'a'), 'module mine'); assert(!fs.existsSync(marker));
  console.log('turn-changes-review: metadata failures, synchronous restore, aliases/collisions, Git subroots, explicit deletions and promisor read-only passed');
} finally {
  fs.promises.rename = originalRename;
  for (const s of services) s.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp')); fs.rmSync(tmp, { recursive: true, force: true });
}
