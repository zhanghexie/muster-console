/** Main-process model allowlist policy: catalog order, explicit overrides and i18n. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-admission-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { resolveHarnessModelAdmission: resolve } = await import(pathToFileURL(compile('main/agentSession/modelAdmissionPolicy.ts')));
  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
  applyLocaleSetting('zh-CN');
  const model = modelId => ({ providerId: 'codex-gui', modelId });
  const input = { runtimeId: 'codex-gui', selected: ['allowed-b', 'allowed-a'], catalog: {
    defaultModel: model('disabled'), items: [model('disabled'), model('allowed-a'), model('allowed-b')]
  } };
  const only = process.argv[2];
  if (!only || only === 'fallback') {
    assert.deepEqual(resolve(input), model('allowed-a'), 'disabled default falls back by catalog order, not selection storage order');
    assert.deepEqual(resolve({ ...input, catalog: { ...input.catalog, defaultModel: model('allowed-b') } }), model('allowed-b'), 'allowed default remains in force');
    console.log('ok disabled default falls back to first allowed catalog model');
  }
  if (!only || only === 'disabled') {
    assert.throws(() => resolve({ ...input, explicit: model('disabled') }), /该模型已在设置中禁用：disabled；允许的模型：allowed-b, allowed-a/);
    console.log('ok disabled explicit override is rejected');
  }
  if (!only) {
    assert.deepEqual(resolve({ ...input, explicit: model('allowed-b') }), model('allowed-b'));
    assert.throws(() => resolve({ ...input, selected: [] }), /至少选择一个模型/);
    assert.equal(resolve({ ...input, selected: undefined, explicit: model('disabled') }), undefined);
    assert.throws(() => resolve({ ...input, selected: ['gone'] }), /当前模型目录没有已启用的模型/);
    const pair = (providerId, modelId) => ({ providerId, modelId });
    assert.deepEqual(resolve({ runtimeId: 'pi', selected: [JSON.stringify(['p2', 'm'])], catalog: { defaultModel: pair('p1', 'm'), items: [pair('p1', 'm'), pair('p2', 'm')] } }), pair('p2', 'm'));
    applyLocaleSetting('en');
    assert.throws(() => resolve({ ...input, explicit: model('disabled') }), /disabled in Settings.*Allowed models: allowed-b, allowed-a/);
    assert.throws(() => resolve({ ...input, selected: [] }), /No models are enabled.*Settings/);
    console.log('ok allowlist empty/missing, provider identity and English errors');
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
