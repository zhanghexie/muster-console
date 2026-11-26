/** Path-scoped capture never needs a warmed workspace and never invents an undo. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-path-capture-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { PathCapture } = await import(pathToFileURL(compile('main/turnChanges/pathCapture.ts')).href);
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const warnings = [], touched = [];
const make = () => new PathCapture(work, [{ path: work, physical: fs.realpathSync.native(work) }], x => warnings.push(x), x => touched.push(x));
const file = name => path.join(work, name);
const write = (name, text) => fs.writeFileSync(file(name), text);
try {
  const empty = make();
  const originalRead = fs.readFileSync, originalList = fs.readdirSync;
  let reads = 0, lists = 0;
  fs.readFileSync = (...args) => { reads++; return originalRead(...args); };
  fs.readdirSync = (...args) => { lists++; return originalList(...args); };
  try { empty.finish(); assert.equal(reads, 0); assert.equal(lists, 0); }
  finally { fs.readFileSync = originalRead; fs.readdirSync = originalList; }

  write('a', 'dirty before\n');
  const capture = make();
  await capture.toolStart('1', 'write', { path: 'a', content: 'first\n' }, undefined, true);
  write('a', 'first\n'); await capture.toolEnd('1', true, true);
  await capture.toolStart('2', 'edit', { path: 'a', oldText: 'first', newText: 'second' }, undefined, true);
  write('a', 'second\n'); await capture.toolEnd('2', true, true);
  capture.finish();
  const a = capture.files.get(file('a'));
  assert.equal(a.before.text, 'dirty before\n');
  assert.equal(a.after.text, 'second\n');
  assert.equal(a.safe, true);

  write('encoded', 'one two');
  const encoded = make();
  await encoded.toolStart('encoded', 'edit', { path: 'encoded', edits: JSON.stringify({ oldText: 'one', newText: 'ONE' }) }, undefined, true);
  write('encoded', 'ONE two'); await encoded.toolEnd('encoded', true, true); encoded.finish();
  assert.equal(encoded.files.get(file('encoded')).safe, true, 'scheduler events may precede Pi argument preparation');

  // Ambiguous or overlapping edit requests cannot certify a file even if the
  // reported tool result claims success and the on-disk content changed.
  for (const [name, original, edits, result] of [
    ['ambiguous', 'same same', [{ oldText: 'same', newText: 'changed' }], 'changed same'],
    ['overlapping', 'abcdef', [{ oldText: 'abc', newText: 'x' }, { oldText: 'bcd', newText: 'y' }], 'xdef'],
    ['mismatch', 'one two', [{ oldText: 'one', newText: 'ONE' }], 'ONE unrelated']
  ]) {
    write(name, original);
    const uncertain = make();
    await uncertain.toolStart(name, 'edit', { path: name, edits }, undefined, true);
    write(name, result); await uncertain.toolEnd(name, true, true);
    uncertain.finish();
    assert.equal(uncertain.files.get(file(name)).safe, false, `${name} must not authorize undo`);
  }

  const late = make();
  await late.toolEnd('only-end', true, true);
  await late.toolStart('late', 'write', { path: 'a', content: 'late' });
  write('a', 'late'); await late.toolEnd('late', true);
  late.finish();
  assert.equal(late.files.get(file('a')).after.text, 'late');
  assert.equal(late.files.get(file('a')).safe, false, 'observation alone cannot authorize a revert');

  write('upgrade', 'original');
  const upgrade = make();
  await upgrade.toolStart('same', 'write', { path:'upgrade', content:'edited' });
  await upgrade.toolStart('same', 'write', { path:'upgrade', content:'edited' }, undefined, true);
  write('upgrade', 'edited'); await upgrade.toolEnd('same', true, true); upgrade.finish();
  assert.equal(upgrade.files.get(file('upgrade')).safe, true, 'an awaited hook supersedes its own earlier stream observation');
  assert.equal(upgrade.files.get(file('upgrade')).origin, 'native-tool');

  write('b', 'original');
  const external = make();
  await external.toolStart('one', 'write', { path: 'b', content: 'one' }, undefined, true);
  write('b', 'one'); await external.toolEnd('one', true, true);
  write('b', 'user intervened');
  await external.toolStart('two', 'write', { path: 'b', content: 'two' }, undefined, true);
  write('b', 'two'); await external.toolEnd('two', true, true);
  external.finish(); assert.equal(external.files.get(file('b')).safe, false);

  write('shell', 'before');
  const explicit = make();
  await assert.rejects(explicit.begin(['../outside']), /路径无效/);
  await assert.rejects(explicit.begin(['C:relative.txt']), /路径无效/);
  await assert.rejects(explicit.begin(Array(201).fill('shell')), /超过本轮上限/);
  const id = await explicit.begin(['shell']);
  write('shell', 'shell result');
  await assert.rejects(explicit.complete(id, ['a']), /属于原登记/);
  await explicit.complete(id, ['shell']);
  await explicit.complete(id, ['shell']);
  await assert.rejects(explicit.complete(id, []), /不能以不同路径重放/);
  explicit.finish();
  const shell = explicit.files.get(file('shell'));
  assert.equal(shell.before.text, 'before'); assert.equal(shell.after.text, 'shell result'); assert.equal(shell.safe, false);

  write('mixed', 'start');
  const mixed = make(); const batch = await mixed.begin(['mixed']);
  await mixed.toolStart('write', 'write', { path: 'mixed', content: 'done' }, undefined, true);
  write('mixed', 'done'); await mixed.toolEnd('write', true, true);
  await mixed.complete(batch, ['mixed']); mixed.finish();
  assert.equal(mixed.files.get(file('mixed')).safe, true);
  assert.equal(mixed.files.get(file('mixed')).origin, 'mixed');

  write('overlap', 'before');
  const overlap = make();
  const firstStart = overlap.toolStart('first', 'write', { path: 'overlap', content: 'first' }, undefined, true);
  const secondStart = overlap.toolStart('second', 'write', { path: 'overlap', content: 'second' }, undefined, true);
  await Promise.all([firstStart, secondStart]);
  write('overlap', 'first'); await overlap.toolEnd('first', true, true);
  write('overlap', 'second'); await overlap.toolEnd('second', true, true);
  overlap.finish();
  assert.equal(overlap.files.get(file('overlap')).safe, false, 'overlap during asynchronous pre-write reads must never authorize undo');

  const failed = make(); write('failure', 'before');
  await failed.toolStart('failed', 'write', { path: 'failure', content: 'after' }, undefined, true);
  write('failure', 'after'); await failed.toolEnd('failed', false, true); failed.finish();
  assert.equal(failed.files.get(file('failure')).after, undefined);
  assert.equal(failed.files.get(file('failure')).safe, false);
  assert(warnings.length > 0); assert(touched.length > 0);
  console.log('turn-changes-path-capture: passed');
} finally {
  assert(tmp.startsWith(path.join(root, '.tmp') + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
