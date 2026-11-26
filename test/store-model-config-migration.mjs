import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'store-model-config-compile-'));
const compile = createSharedCompiler(root, compileRoot);
const { Store } = await import(pathToFileURL(compile('main/store.ts')).href);
const userData = path.join(compileRoot, 'electron-userData');
const sidecar = path.join(userData, 'agent-thinking.json');
const canonical = path.join(userData, 'agent-models.json');

try {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'agent-models.json'), JSON.stringify({ default: { providerId: 'zhipu', modelId: 'GLM-5.3' } }));
  fs.writeFileSync(sidecar, JSON.stringify({ default: 'high' }));
  const store = new Store();
  assert.deepEqual(store.loadAgentModels(), { default: { providerId: 'zhipu', modelId: 'GLM-5.3' } });
  assert.deepEqual(store.loadAgentThinking(), { default: 'high' });
  assert.equal(fs.existsSync(sidecar), false, 'legacy thinking sidecar is removed after canonical migration');
  assert.deepEqual(JSON.parse(fs.readFileSync(canonical, 'utf8')), {
    version: 2,
    models: { default: { providerId: 'zhipu', modelId: 'GLM-5.3' } },
    thinking: { default: 'high' }
  });
  store.flushSync();
  console.log('store-model-config-migration: ok');
} finally {
  fs.rmSync(compileRoot, { recursive: true, force: true });
}
