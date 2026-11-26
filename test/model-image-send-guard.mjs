/**
 * 模型级发图守卫：非多模态 + 带图必须拒绝，且文案含模型名与「不支持图片输入」。
 * 复现：GLM-5.3（推断非多模态）带图 → reject；gpt-4o / 显式 multimodal → 放行。
 * 运行: node test/model-image-send-guard.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-image-guard-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('shared/modelCapabilities.ts');
const mod = await import(pathToFileURL(outFile).href);

const { inferModelSupportsImages, rejectImagesIfModelLacksSupport } = mod;

const IMG = [{ data: 'AAAA', mimeType: 'image/png' }];

assert.equal(inferModelSupportsImages('glm-5.3'), false, 'GLM-5.3 推断为非多模态');
assert.equal(inferModelSupportsImages('GLM-5.3-Flash'), false);
assert.equal(inferModelSupportsImages('deepseek-chat'), false);
assert.equal(inferModelSupportsImages('gpt-4o'), true, 'gpt-4o 推断为多模态');
assert.equal(inferModelSupportsImages('claude-3-5-sonnet'), true);
assert.equal(inferModelSupportsImages('qwen-vl-max'), true);
assert.equal(inferModelSupportsImages('mimo-v2.5'), true);
assert.equal(inferModelSupportsImages('glm-5.3', true), true, '显式 multimodal=true 压过 id');
assert.equal(inferModelSupportsImages('gpt-4o', false), false, '显式 multimodal=false 压过 id');

const noImg = rejectImagesIfModelLacksSupport({
  images: undefined,
  modelId: 'glm-5.3',
  modelName: 'GLM-5.3'
});
assert.equal(noImg.ok, true, '无图不拦');

const empty = rejectImagesIfModelLacksSupport({
  images: [],
  modelId: 'glm-5.3',
  modelName: 'GLM-5.3'
});
assert.equal(empty.ok, true, '空图数组不拦');

const denied = rejectImagesIfModelLacksSupport({
  images: IMG,
  modelId: 'glm-5.3',
  modelName: 'GLM-5.3'
});
assert.equal(denied.ok, false, '非多模态+带图必须拒绝');
assert.match(denied.error, /GLM-5\.3/);
assert.match(denied.error, /不支持图片输入/);
assert.equal(denied.error, '模型 GLM-5.3 不支持图片输入');

const allowed = rejectImagesIfModelLacksSupport({
  images: IMG,
  modelId: 'gpt-4o',
  modelName: 'GPT-4o'
});
assert.equal(allowed.ok, true, '多模态+带图放行');

const explicitOn = rejectImagesIfModelLacksSupport({
  images: IMG,
  modelId: 'glm-5.3',
  modelName: 'GLM-5.3',
  explicitMultimodal: true
});
assert.equal(explicitOn.ok, true, '设置里勾了多模态则放行');

const explicitOff = rejectImagesIfModelLacksSupport({
  images: IMG,
  modelId: 'gpt-4o',
  modelName: 'GPT-4o',
  explicitMultimodal: false
});
assert.equal(explicitOff.ok, false, '设置里关掉多模态则拒绝');
assert.match(explicitOff.error, /GPT-4o/);
assert.match(explicitOff.error, /不支持图片输入/);

console.log('✔ model-image-send-guard: infer + reject 文案');
