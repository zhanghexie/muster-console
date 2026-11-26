/** Cold path capture keeps byte-exact originals and rejects uncertain writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'review-before-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { TURN_FILE_LIMIT } = await import(pathToFileURL(compile('shared/turnChanges.ts')));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const service = new TurnChangeService(path.join(tmp, 'store')); const trackers = [];
const begin = id => { const t = service.begin('gui:a', id, work, [work]); trackers.push(t); return t; };
const file = name => path.join(work, name);
try {
  const original = 'personal original\r\nold\r\n'; fs.writeFileSync(file('crlf'), original);
  const t = begin('crlf');
  await t.toolStart('edit', 'edit', { path: 'crlf', oldText: 'old', newText: 'new' }, undefined, true);
  fs.writeFileSync(file('crlf'), original.replace('old', 'new')); await t.toolEnd('edit', true, undefined, true);
  const s = await t.finish(); assert.equal(s.files[0].revertible, true);
  assert.deepEqual((await service.revert(s.id, 'gui:a', 'crlf', [work])).restored, ['crlf']);
  assert.equal(fs.readFileSync(file('crlf'), 'utf8'), original);

  fs.writeFileSync(file('existing'), 'personal');
  const late = begin('late'); fs.unlinkSync(file('existing'));
  await late.toolStart('delete', 'delete_file', { path: 'existing' }); await late.toolEnd('delete', true);
  const lateSummary = await late.finish(); assert.equal(lateSummary.files.length, 0);
  assert(lateSummary.warnings.some(w => w.includes('写前时机无法确认')));

  const created = begin('created');
  await created.toolStart('write', 'write', { path: 'new', content: 'new' }, undefined, true);
  fs.writeFileSync(file('new'), 'new'); await created.toolEnd('write', true, undefined, true);
  const newSummary = await created.finish(); assert.equal(newSummary.files[0].revertible, true);
  assert.deepEqual((await service.revert(newSummary.id, 'gui:a', 'created', [work])).restored, ['new']);
  assert.equal(fs.existsSync(file('new')), false);

  for (const [name, bytes] of [['binary', Buffer.from([0, 1])], ['invalid', Buffer.from([0xff])]]) {
    fs.writeFileSync(file(name), bytes); const x = begin(name);
    await x.toolStart('write', 'write', { path: name, content: 'replacement' }, undefined, true);
    fs.writeFileSync(file(name), 'replacement'); await x.toolEnd('write', true, undefined, true);
    const summary = await x.finish(); assert.equal(summary.files.length, 0, name); assert(summary.warnings.length);
  }
  fs.writeFileSync(file('big'), Buffer.alloc(TURN_FILE_LIMIT + 1, 120));
  const big = begin('big');
  await big.toolStart('write', 'write', { path: 'big', content: 'replacement' }, undefined, true);
  fs.writeFileSync(file('big'), 'replacement'); await big.toolEnd('write', true, undefined, true);
  const [oversized] = (await big.finish()).files;
  assert.equal(oversized.path, 'big');
  assert.equal(oversized.diffOmitted, true);
  assert.equal(oversized.revertible, false);

  fs.writeFileSync(file('hard'), 'shared'); fs.linkSync(file('hard'), file('hard-link'));
  const hard = begin('hard'); await hard.toolStart('write', 'write', { path: 'hard', content: 'model' }, undefined, true);
  fs.writeFileSync(file('hard'), 'model'); await hard.toolEnd('write', true, undefined, true);
  assert.equal((await hard.finish()).files.length, 0, 'hardlinked originals are never captured or restored');
  assert.equal(fs.readFileSync(file('hard-link'), 'utf8'), 'model');
  console.log('turn-changes-before-images: cold CRLF, late events, added files, binary and hardlink boundaries passed');
} finally {
  await Promise.allSettled(trackers.map(t => t.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
