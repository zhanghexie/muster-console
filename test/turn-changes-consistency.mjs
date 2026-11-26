/** Persistence and per-path failure regressions for path-scoped review. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'review-consistency-'));
const compile = createSharedCompiler(root, tmp);
const entry = compile('main/turnChanges/service.ts');
if (process.argv.includes('--baseline-no-path-recheck')) {
  const target = path.join(tmp, 'main/turnChanges/files.mjs');
  const source = fs.readFileSync(target, 'utf8');
  assert(source.includes('stamp(pathStat) !== stamp(st)'));
  fs.writeFileSync(target, source.replace('stamp(pathStat) !== stamp(st)', 'false'));
}
if (process.argv.includes('--baseline-early-ready')) {
  const target = path.join(tmp, 'main/turnChanges/tracker.mjs');
  const source = fs.readFileSync(target, 'utf8');
  assert(source.includes('await this.service.save('));
  fs.writeFileSync(target, source.replace('await this.service.save(', "this.summary.state = 'ready'; await this.service.save("));
}
const { TurnChangeService } = await import(pathToFileURL(entry));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const file = path.join(work, 'a.txt'); fs.writeFileSync(file, 'before');
const service = new TurnChangeService(path.join(tmp, 'store'));
const trackers = [];
const begin = id => { const t = service.begin('gui:a', id, work, [work]); trackers.push(t); return t; };
const edit = async (t, value) => { await t.toolStart('write', 'write', { path: 'a.txt', content: value }, undefined, true); fs.writeFileSync(file, value); await t.toolEnd('write', true, undefined, true); };
try {
  const tracker = begin('save'); await tracker.ready; await edit(tracker, 'after');
  const save = service.save.bind(service); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  service.save = async record => { assert.equal(record.summary.state, 'ready'); entered(); await gate; await save(record); };
  const first = tracker.finish(); await started;
  let returned = false; const second = tracker.finish().then(result => { returned = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, false, 'duplicate finish waits for durable persistence');
  assert.equal(tracker.summary.state, 'collecting', 'ready is not published before save');
  release(); assert.equal((await first).state, 'ready'); assert.equal(await second, await first);
  service.save = async () => { throw new Error('disk full'); };
  const failed = begin('failure'); await edit(failed, 'again');
  assert.equal((await failed.finish()).state, 'error'); assert.match(failed.summary.warnings.join(' '), /disk full/);
  assert.equal(service.active.size, 0); service.save = save;

  const later = begin('later'); await edit(later, 'tool');
  const open = fs.promises.open;
  fs.promises.open = async function(name, ...args) {
    if (String(name) === file) throw Object.assign(new Error('denied final read'), { code: 'EACCES' });
    return open.call(this, name, ...args);
  };
  try {
    const summary = await later.finish();
    assert.equal(summary.state, 'ready');
    assert.equal(summary.files[0].revertible, false, 'a failed final check cannot authorize undo');
    assert.match(summary.warnings.join(' '), /denied final read/);
  } finally { fs.promises.open = open; }

  const explicit = begin('explicit');
  fs.promises.open = async function(name, ...args) {
    if (String(name) === file) throw Object.assign(new Error('denied before read'), { code: 'EACCES' });
    return open.call(this, name, ...args);
  };
  try { await assert.rejects(explicit.beginFiles(['a.txt']), /denied before read/); }
  finally { fs.promises.open = open; }
  assert.equal(explicit.capture.files.size, 0, 'read failure must not be mistaken for a missing file');
  const id = await explicit.beginFiles(['absent.txt']);
  fs.writeFileSync(path.join(work, 'absent.txt'), 'new'); await explicit.completeFiles(id, ['absent.txt']);
  assert.equal((await explicit.finish()).files[0].kind, 'added');

  // A file that disappears after realpath must not be recorded as originally absent.
  fs.writeFileSync(file, 'original-before-disappearance');
  const disappeared = begin('disappeared');
  fs.promises.open = async function(name, ...args) {
    if (String(name) === file) { fs.unlinkSync(file); throw Object.assign(new Error('removed during open'), { code: 'ENOENT' }); }
    return open.call(this, name, ...args);
  };
  try { await disappeared.toolStart('write', 'write', { path: 'a.txt', content: 'model' }, undefined, true); }
  finally { fs.promises.open = open; }
  fs.writeFileSync(file, 'model'); await disappeared.toolEnd('write', true, undefined, true);
  const vanished = await disappeared.finish();
  assert.equal(vanished.files.length, 0, 'a raced disappearance must not authorize deletion on undo');
  assert.match(vanished.warnings.join(' '), /读取期间发生变化/);

  // Replacing the path while a file handle is open must invalidate the old body.
  fs.writeFileSync(file, 'original-before-replacement');
  const replaced = begin('replaced'); let swapped = false;
  fs.promises.open = async function(name, ...args) {
    const fd = await open.call(this, name, ...args);
    if (String(name) !== file) return fd;
    let initialStat;
    return { async stat(...a) { return initialStat ??= await fd.stat(...a); }, close: () => fd.close(), async readFile(...a) {
      const data = await fd.readFile(...a);
      fs.renameSync(file, path.join(work, 'displaced-original'));
      fs.writeFileSync(file, 'external replacement'); swapped = true;
      return data;
    } };
  };
  try { await replaced.toolStart('write', 'write', { path: 'a.txt', content: 'model after replacement' }, undefined, true); }
  finally { fs.promises.open = open; }
  assert.equal(swapped, true, 'fixture must actually replace the path while its old handle is open');
  fs.writeFileSync(file, 'model after replacement'); await replaced.toolEnd('write', true, undefined, true);
  const changed = await replaced.finish();
  assert.equal(changed.files.length, 0, 'a replaced path must not inherit the old handle as its before-image');
  assert.match(changed.warnings.join(' '), /读取期间发生变化/);
  console.log('turn-changes-consistency: save ordering, failures and ENOENT/EACCES separation passed');
} finally {
  await Promise.allSettled(trackers.map(tracker => tracker.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
