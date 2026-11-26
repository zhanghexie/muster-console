import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-app-builtins-i18n-'));
try {
  const compile = createSharedCompiler(root, temp);
  const { builtInAgentApps } = await import(pathToFileURL(compile('shared/agentAppsBuiltins.ts')));
  const { photoAlbumExample } = await import(pathToFileURL(compile('shared/agentAppsExamples.ts')));
  const { en } = await import(pathToFileURL(compile('shared/i18n/locales/en.ts')));
  const missing = new Set();
  for (const app of [...builtInAgentApps(), photoAlbumExample()]) {
    const labels = [app.name, app.description,
      ...app.collections.flatMap(collection => [collection.title, ...collection.fields.map(field => field.label)]),
      ...app.commands.map(command => command.title), ...app.views.map(view => view.title)];
    for (const label of labels) if (/\p{Script=Han}/u.test(label) && !Object.hasOwn(en, label)) missing.add(label);
  }
  assert.deepEqual([...missing].sort(), [], 'built-in and example app display labels need English translations');
  console.log('agent-app-builtins-i18n: ok');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('agent-app-builtins-i18n-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
