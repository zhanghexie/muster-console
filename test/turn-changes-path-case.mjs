/** Canonical root spelling must agree across registration, capture and revert. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-case-'));
const compile = createSharedCompiler(root, tmp);
const entry = compile('main/turnChanges/service.ts');
compile('main/turnChanges/files.ts');
// Negative control changes only disposable compiled copies, never the checkout.
if (process.argv.includes('--baseline-legacy-realpath')) {
  for (const name of ['service', 'files']) {
    const file = path.join(tmp, 'main/turnChanges', `${name}.mjs`);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('fs.realpathSync.native(', 'fs.realpathSync('));
  }
}
const { TurnChangeService } = await import(pathToFileURL(entry));
const { checkedPath } = await import(pathToFileURL(path.join(tmp, 'main/turnChanges/files.mjs')));
const work = path.join(tmp, 'MixedCaseSource'); fs.mkdirSync(work);
const file = path.join(work, 'note.txt'); fs.writeFileSync(file, 'before\n');
const original = fs.realpathSync;
const asyncOriginal = fs.promises.realpath;
const canonical = original.native(work);
const service = new TurnChangeService(path.join(tmp, 'store'));
const preparing = [];
const begin = service.begin.bind(service);
service.begin = (...args) => { const tracker = begin(...args); preparing.push(tracker.ready); return tracker; };
try {
  // Reproduce Windows legacy spelling on every CI OS without lowercasing real
  // POSIX paths or overriding platform detection. Native/async IO stays real.
  fs.realpathSync = Object.assign(function (value, ...args) {
    const result = original(value, ...args);
    return path.resolve(String(value)) === work ? result.toLowerCase() : result;
  }, { native: original.native });
  assert.notEqual(fs.realpathSync(work), await fs.promises.realpath(work));
  const tracker = service.begin('gui:case', 'm1', work, [work]); await tracker.ready;
  await tracker.toolStart('edit', 'write', { path: 'note.txt', content: 'after\n' }, undefined, true);
  fs.writeFileSync(file, 'after\n'); await tracker.toolEnd('edit', true, undefined, true);
  const summary = await tracker.finish();
  assert.equal(summary.files.length, 1);
  assert.equal(summary.files[0].revertible, true);
  assert.equal((await service.revert(summary.id, 'gui:case', 'm1', [work])).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\n');
  console.log('ok - legacy/native spelling mismatch: begin, capture and revert');

  fs.realpathSync = original;
  if (process.platform === 'win32') {
    const alias = work.toLowerCase();
    assert.equal(original.native(alias), canonical);
    const actual = service.begin('gui:case', 'windows', alias, [alias]); await actual.ready;
    assert.deepEqual(actual.summary.warnings, []);
    await actual.finish();
    console.log('ok - real Windows lowercase source alias starts successfully');
  }

  // Exact canonical comparisons remain mandatory on Linux/macOS and Windows
  // case-sensitive volumes. Even case-only canonical changes must fail closed.
  assert.equal(checkedPath([{ path: work, physical: canonical.toLowerCase() }], file), false);
  fs.promises.realpath = async function (value, ...args) {
    const result = await asyncOriginal(value, ...args);
    return result === canonical ? canonical.toLowerCase() : result;
  };
  const drifted = service.begin('gui:case', 'm2', work, [work]);
  const driftedSummary = await drifted.finish();
  assert.equal(driftedSummary.state, 'error');
  assert(driftedSummary.warnings.some(w => w.includes('源目录身份已变化')), 'identity drift is rejected for review');
  assert.equal(service.active.size, 0);
  console.log('ok - different canonical target is rejected, including case-only differences');
  fs.promises.realpath = asyncOriginal;
  const missing = service.begin('gui:case', 'm3', work, [path.join(tmp, 'missing')]);
  const missingSummary = await missing.finish();
  assert(missingSummary.warnings.some(w => w.includes('源目录不可用')), 'missing source is reported');
  console.log('ok - missing source removes review coverage without blocking');
} finally {
  await Promise.allSettled(preparing);
  fs.realpathSync = original; fs.promises.realpath = asyncOriginal;
  service.dispose();
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
