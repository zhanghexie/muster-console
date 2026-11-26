/**
 * 调度对话模型选择持久化（agent-models.json）回归测试。
 * Bug：switchModel 只写内存 bucket，重启后模型静默回落全局默认（用户选 GLM-5.3 重启变 deepseek）。
 * 修复：store 落盘 + Orchestrator 构造时规整恢复 + ensureBucket 带入 bucket + switchModel 落盘。
 * 本文件覆盖纯逻辑层（形状校验/落盘数据规整/跨 JSON 往返恢复）；
 * Orchestrator 三处接线为薄胶水，无 electron 环境不在 mjs 层覆盖。
 * 运行: node test/agent-model-selection.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-selection-compile-'));
const compile = createSharedCompiler(root, compileTmp);
const entry = compile('main/agent/agentModelSelection.ts');
const { normalizeAgentModelSelection, normalizeAgentModelSelections } = await import(
  pathToFileURL(entry).href
);

let tmp;
try {
  // ---------------------------------------------- 单条校验：合法值放行（含 trim）
  assert.deepEqual(normalizeAgentModelSelection({ providerId: 'zhipu', modelId: 'GLM-5.3' }), {
    providerId: 'zhipu',
    modelId: 'GLM-5.3'
  });
  assert.deepEqual(normalizeAgentModelSelection({ providerId: ' zhipu ', modelId: ' GLM-5.3 ' }), {
    providerId: 'zhipu',
    modelId: 'GLM-5.3'
  });

  // ---------------------------------------------- 单条校验：非法形状一律拒绝
  for (const bad of [
    null,
    undefined,
    'zhipu',
    42,
    {},
    { providerId: 'zhipu' },
    { modelId: 'GLM-5.3' },
    { providerId: '', modelId: 'GLM-5.3' },
    { providerId: 'zhipu', modelId: '' },
    { providerId: '   ', modelId: 'GLM-5.3' },
    { providerId: 1, modelId: 'GLM-5.3' }
  ]) {
    assert.equal(normalizeAgentModelSelection(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }

  // ---------------------------------------------- 全量规整：丢非法、留合法
  const mixed = normalizeAgentModelSelections({
    wsA: { providerId: 'zhipu', modelId: 'GLM-5.3' },
    wsB: { providerId: 'deepseek' }, // 缺 modelId，丢
    wsC: 'garbage', // 非对象，丢
    wsD: { providerId: 'xiaomi', modelId: 'mimo-v2.5' }
  });
  assert.deepEqual(mixed, {
    wsA: { providerId: 'zhipu', modelId: 'GLM-5.3' },
    wsD: { providerId: 'xiaomi', modelId: 'mimo-v2.5' }
  });

  // 非对象入参（文件损坏回空前的异常形状）不抛、返回空表
  assert.deepEqual(normalizeAgentModelSelections(null), {});
  assert.deepEqual(normalizeAgentModelSelections('x'), {});
  assert.deepEqual(normalizeAgentModelSelections([]), {}); // 数组索引键值非对象，全丢

  // ---------------------------------------------- 重启恢复回归：跨 JSON 往返后选择不丢
  // 模拟 store：switchModel 落盘 → 重启 read 出纯 JSON → 构造器规整 → bucket 恢复
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-model-selection-store-'));
  const file = path.join(tmp, 'agent-models.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ 'default': { providerId: 'zhipu', modelId: 'GLM-5.3' } })
  );
  const loaded = normalizeAgentModelSelections(JSON.parse(fs.readFileSync(file, 'utf-8')));
  assert.deepEqual(loaded['default'], { providerId: 'zhipu', modelId: 'GLM-5.3' });

  // 空文件（首启无记录）→ 空表 → bucket 不带覆盖、回落全局默认
  assert.deepEqual(normalizeAgentModelSelections({}), {});

  console.log('agent-model-selection.mjs 全部通过');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(compileTmp, { recursive: true, force: true });
}
