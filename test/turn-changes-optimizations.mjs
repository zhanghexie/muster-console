/** Empty capture and compact snapshot records must not revive a global baseline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'review-compact-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const work = path.join(tmp, 'work'), store = path.join(tmp, 'store'); fs.mkdirSync(work);
const service = new TurnChangeService(store); const trackers = [];
const begin = id => { const t = service.begin('gui:a', id, work, [work]); trackers.push(t); return t; };
try {
  const empty = begin('empty'); await empty.ready;
  assert.equal((await empty.finish()).files.length, 0);
  assert.equal(fs.existsSync(store), false, 'an empty turn writes no snapshot or baseline cache');
  fs.writeFileSync(path.join(work, 'a'), 'old'); const native = begin('native');
  await native.toolStart('write', 'write', { path: 'a', content: 'new content' }, undefined, true);
  fs.writeFileSync(path.join(work, 'a'), 'new content'); await native.toolEnd('write', true, undefined, true);
  const summary = await native.finish();
  const record = JSON.parse(fs.readFileSync(path.join(store, `${summary.id}.json`), 'utf8'));
  assert.equal(record.files[0].before.text, 'old');
  assert.equal(record.files[0].after.text, undefined, 'after body is not duplicated in the record');
  assert.equal(typeof record.files[0].after.hash, 'string');
  assert.equal(fs.existsSync(path.join(store, 'baseline-cache')), false);
  const explicit = begin('explicit'); const id = await explicit.beginFiles(['a']);
  fs.writeFileSync(path.join(work, 'a'), 'shell'); await explicit.completeFiles(id, ['a']);
  const reviewOnly = await explicit.finish();
  const saved = JSON.parse(fs.readFileSync(path.join(store, `${reviewOnly.id}.json`), 'utf8'));
  assert.equal(saved.files[0].before, undefined, 'review-only evidence cannot become an undo body');
  assert.equal(reviewOnly.files[0].revertible, false);
  console.log('turn-changes-optimizations: empty turns and compact safe snapshots passed');
} finally {
  await Promise.allSettled(trackers.map(t => t.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
