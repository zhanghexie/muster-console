import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-permission-i18n-'));
try {
  const compile = createSharedCompiler(root, temp);
  const { guiPermissionOptions } = await import(pathToFileURL(compile('shared/guiPermissionOptions.ts')));
  const { HARNESS_CATALOG } = await import(pathToFileURL(compile('shared/harnessCatalog.ts')));
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')));
  const contexts = [[undefined, undefined], ['pi', undefined], ['pi-external', undefined], ['omp', undefined],
    ...HARNESS_CATALOG.map(item => [item.runtimeId, item.acpPresetId])];
  const labels = new Set();
  for (const [runtime, agent] of contexts) {
    for (const current of [undefined, 'standard', 'accept-edits', 'auto-review', 'default', 'ask', 'plan', 'auto']) {
      for (const option of guiPermissionOptions(runtime, current, agent)) { labels.add(option.label); labels.add(option.description); }
    }
    if (runtime !== 'pi') assert.deepEqual(guiPermissionOptions(runtime), []);
  }
  const missing = [...labels].filter(label => /\p{Script=Han}/u.test(label) && !Object.hasOwn(en, label)).sort();
  assert.deepEqual(missing, [], 'all built-in permission labels and descriptions need English translations');
  console.log('gui-permission-i18n: ok');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('gui-permission-i18n-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
