import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-token-plan-models-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const load = (entry) => import(pathToFileURL(compile(entry)).href);

try {
  const { resolveLlmConfig } = await load('main/config.ts');
  const { setPiCatalogSnapshot, setPublishedModelInputSpecifications, syncPiConfigFromApp } = await load('main/agent/piConfigSync.ts');
  const { prepareAttachments } = await load('main/attachments/service.ts');
  const baseUrl = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
  const provider = {
    id: 'qwen-token-plan-cn', name: 'Token Plan', baseUrl, api: 'openai-completions', apiKey: 'fixture-key',
    models: [{ id: 'qwen4-max', name: 'Qwen4-Max' }]
  };
  function config(provider) {
    return { llm: { providers: [provider], activeProviderId: provider.id, activeModelId: provider.models[0].id } };
  }

  // The installed Pi catalog does not contain the model yet.
  const effective = resolveLlmConfig(config(provider)).model;
  assert.equal(effective.contextWindow, 1_000_000);
  assert.equal(effective.multimodal, true);
  const image = { name: 'context.png', mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZxkAAAAASUVORK5CYII=' };
  const prepared = await prepareAttachments({
    userData: path.join(temp, 'user-data'), scope: 'gui:token-plan', text: 'Review this',
    attachments: [image], model: effective, api: provider.api
  });
  assert.equal(prepared.images?.[0]?.data, image.data, 'the original image goes to the model');
  assert.equal(provider.models[0].multimodal, undefined, 'inherited capabilities stay out of user configuration');

  const caps = { providerId: provider.id, modelId: 'qwen4-max', baseUrl, protocol: provider.api,
    contextWindow: 786432, input: ['text', 'image', 'video'], verified: true,
    sources: ['https://help.aliyun.com/zh/model-studio/qwen4-max'] };
  setPublishedModelInputSpecifications([caps]);
  const legacy = { ...provider, models: [{ ...provider.models[0], multimodal: false }] };
  assert.equal(resolveLlmConfig(config(legacy)).model.contextWindow, caps.contextWindow);
  assert.equal(resolveLlmConfig(config(legacy)).model.multimodal, true, 'verified legacy defaults follow the catalog');
  assert.equal(resolveLlmConfig(config({ ...legacy, models: [{ ...legacy.models[0], multimodalExplicit: true }] })).model.multimodal, false);

  // A future stale SDK entry must not restore the old window or strip image input.
  const stale = { contextWindow: 128000, maxTokens: 8192, input: ['text'] };
  setPiCatalogSnapshot({ [provider.id]: { 'qwen4-max': stale } }, [{ ...provider, authMethods: ['apiKey'] }]);
  const sdk = path.join(temp, 'sdk');
  syncPiConfigFromApp(config(provider), sdk);
  const synced = JSON.parse(fs.readFileSync(path.join(sdk, 'models.json'), 'utf8')).providers[provider.id].modelOverrides['qwen4-max'];
  assert.equal(synced.contextWindow, caps.contextWindow);
  assert.deepEqual(synced.input, ['text', 'image']);

  const explicit = resolveLlmConfig(config({ ...provider, models: [{ ...provider.models[0],
    contextWindow: 64_000, multimodal: false
  }] })).model;
  assert.equal(explicit.contextWindow, 64_000);
  assert.equal(explicit.multimodal, false);

  const preview = resolveLlmConfig(config({ ...provider, baseUrl: 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1/',
    models: [{ id: 'qwen4-max-preview', name: 'Preview' }] })).model;
  assert.equal(preview.contextWindow, 1_000_000);
  assert.equal(preview.multimodal, true);
  assert.equal(preview.maxTokens, 393216);

  const relay = resolveLlmConfig(config({ ...provider, baseUrl: 'https://relay.example/v1' })).model;
  assert.equal(relay.contextWindow, 1_000_000);
  assert.equal(relay.multimodal, true);

  setPublishedModelInputSpecifications([{ ...caps, contextWindow: 128000, input: ['text'] }]);
  const refreshed = resolveLlmConfig(config(provider)).model;
  assert.equal(refreshed.contextWindow, 128000);
  assert.equal(refreshed.multimodal, false, 'known text-only input wins over the default');
  console.log('Token Plan model defaults: host, Pi, attachments, explicit overrides and endpoint isolation passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
