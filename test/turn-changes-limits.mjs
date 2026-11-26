/** Bounded capture must reject oversized batches without publishing partial originals. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-limits-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { PathCapture, CAPTURE_MAX_BATCHES } = await import(pathToFileURL(compile('main/turnChanges/pathCapture.ts')));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const warnings = [], roots = [{ path: work, physical: fs.realpathSync.native(work) }];
try {
  const bytes = Buffer.alloc(512 * 1024, 120), names = [];
  for (let i = 0; i < 129; i++) { const name = `f-${i}`; names.push(name); fs.writeFileSync(path.join(work, name), bytes); }
  const capture = new PathCapture(work, roots, warning => warnings.push(warning), () => {});
  await assert.rejects(capture.begin(names), /正文已达到上限/);
  assert.equal(capture.files.size, 0, 'a failed begin must not publish partial before-images');
  const retry = await capture.begin(['f-0']);
  await capture.complete(retry, ['f-0']); capture.finish();
  assert.equal(capture.files.size, 1, 'the rejected batch does not exhaust the budget');

  const bulk = new PathCapture(work, roots, warning => warnings.push(warning), () => {});
  const beforeBulk = performance.now();
  let ticked = false, ticks = 0, previousTick = beforeBulk, maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previousTick); previousTick = now; ticks++; }, 5);
  setImmediate(() => { ticked = true; });
  await bulk.toolStart('bulk', 'file_change', { changes: names.slice(0, 128).map(name => ({ path: name })) }, 'edit', true);
  clearInterval(timer);
  const bulkMs = performance.now() - beforeBulk;
  assert(ticked && ticks > 0, 'bulk capture must yield to the event loop while reading file bodies');
  bulk.finish();

  const bounded = new PathCapture(work, roots, warning => warnings.push(warning), () => {});
  fs.writeFileSync(path.join(work, 'tiny'), 'x');
  for (let i = 0; i <= CAPTURE_MAX_BATCHES; i++) {
    await bounded.toolStart(String(i), 'write', { path: 'tiny', content: 'x' }, undefined, true);
    await bounded.toolEnd(String(i), true, true);
  }
  bounded.finish(); assert(warnings.some(warning => warning.includes('批次已达到上限')));
  console.log(`turn-changes-limits: byte and batch limits fail safely; 128 x 512 KiB elapsed ${bulkMs.toFixed(1)}ms, largest sampled event-loop gap ${maxGap.toFixed(1)}ms`);
} finally {
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
