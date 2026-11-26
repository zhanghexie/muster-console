import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const { parseDiff } = createRequire(import.meta.url)('react-diff-view');

const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-path-service-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')).href);
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const service = new TurnChangeService(path.join(tmp, 'store'));
const trackers = [];
const begin = (...args) => { const tracker = service.begin(...args); trackers.push(tracker); return tracker; };
const write = (name, text) => fs.writeFileSync(path.join(work, name), text);
try {
  write('a', 'user dirty\r\nold\r\n');
  const turn = begin('gui:a', 'm1', work, [work]);
  await turn.toolStart('1', 'edit', { path: 'a', oldText: 'old', newText: 'new' }, undefined, true);
  write('a', 'user dirty\r\nnew\r\n'); await turn.toolEnd('1', true, undefined, true);
  const summary = await turn.finish();
  assert.equal(summary.state, 'ready', summary.warnings.join('; '));
  assert.equal(summary.files[0].revertible, true);
  assert.match(service.diff(summary.id, 'gui:a', 'm1', 'a'), /\+new/);
  assert.deepEqual((await service.revert(summary.id, 'gui:a', 'm1', [work])).restored, ['a']);
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'user dirty\r\nold\r\n');

  const shell = begin('gui:a', 'm2', work, [work]);
  const batch = await shell.beginFiles(['a']); write('a', 'shell output'); await shell.completeFiles(batch, ['a']);
  const shellSummary = await shell.finish();
  assert.equal(shellSummary.files[0].revertible, false);
  assert.match(service.diff(shellSummary.id, 'gui:a', 'm2', 'a'), /\+shell output/);
  assert.equal((await service.revert(shellSummary.id, 'gui:a', 'm2', [work])).restored.length, 0);

  const turn2 = begin('gui:a', 'm3', work, [work]);
  await turn2.toolStart('write', 'write', { path: 'a', content: 'tool output' }, undefined, true);
  write('a', 'tool output'); await turn2.toolEnd('write', true, undefined, true);
  write('a', 'personal later edit');
  const later = await turn2.finish();
  assert.equal(later.files[0].revertible, false);
  assert.match(service.diff(later.id, 'gui:a', 'm3', 'a'), /\+tool output/);
  assert.doesNotMatch(service.diff(later.id, 'gui:a', 'm3', 'a'), /personal later edit/);
  write('文件 name.txt', 'before\n');
  const named = begin('gui:a', 'm4', work, [work]);
  await named.toolStart('named', 'write', { path: '文件 name.txt', content: 'after\n' }, undefined, true);
  write('文件 name.txt', 'after\n'); await named.toolEnd('named', true, undefined, true);
  const namedSummary = await named.finish();
  assert.equal(parseDiff(service.diff(namedSummary.id, 'gui:a', 'm4', '文件 name.txt')).length, 1, 'the production diff viewer parses Unicode and spaces');
  assert.deepEqual((await service.revert(namedSummary.id, 'gui:a', 'm4', [work])).restored, ['文件 name.txt']);
  const limit = 1024 * 1024, text = 'x'.repeat(limit);
  write('shrink', text + 'x');
  write('remove', text + 'x');
  write('untouched', text + 'x');
  write('same-size', text + 'x');
  const large = begin('gui:a', 'size', work, [work]);
  const paths = ['at-limit', 'above-limit', 'shrink', 'remove', 'untouched', 'same-size'];
  const capture = await large.beginFiles(paths);
  write('at-limit', text);
  write('above-limit', text + 'x');
  write('shrink', 'small');
  fs.unlinkSync(path.join(work, 'remove'));
  write('same-size', text + 'y');
  fs.utimesSync(path.join(work, 'same-size'), new Date(0), new Date(0));
  await large.completeFiles(capture, paths);
  const largeSummary = await large.finish();
  const changes = Object.fromEntries(largeSummary.files.map(file => [file.path, file]));
  assert.equal(changes['at-limit'].kind, 'added');
  assert(service.diff(largeSummary.id, 'gui:a', 'size', 'at-limit').includes(text));
  assert.equal(changes.untouched, undefined);
  for (const [name, kind] of [['above-limit', 'added'], ['remove', 'deleted'], ['shrink', 'modified'], ['same-size', 'modified']]) {
    assert.equal(changes[name].kind, kind);
    assert.equal(changes[name].diffOmitted, true);
    assert.equal(changes[name].added, null);
    assert.equal(changes[name].removed, null);
    assert.equal(changes[name].revertible, false);
    assert.throws(() => service.diff(largeSummary.id, 'gui:a', 'size', name), /大小上限/);
  }
  console.log('turn-changes-path-service: passed');
} finally {
  await Promise.allSettled(trackers.map(tracker => tracker.ready));
  service.dispose();
  assert(tmp.startsWith(path.join(root, '.tmp') + path.sep));
  fs.rmSync(tmp, { recursive: true, force: true });
}
