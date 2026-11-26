/**
 * 拉活缺省继承（子代理通用化 · D7/D8）：显式入参 > 父会话 > 全局缺省。
 * 运行: node test/launch-defaults.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(root, fs.mkdtempSync(path.join(os.tmpdir(), 'launch-defaults-')));
const { resolveInheritedDefaults } = await import(
  `file://${compile('shared/launchDefaults.ts').replace(/\\/g, '/')}`
);

const GLOBAL = { runtime: 'pi' };

test('切换 runtime 不继承父模型或其他 runtime 的全局模型', () => {
  const parent = { runtime: 'pi', modelOverride: { providerId: 'deepseek', modelId: 'deepseek-flash' } };
  for (const runtime of ['codex', 'codex-gui', 'claude-code']) {
    assert.equal(resolveInheritedDefaults({ runtime }, parent, parent).modelOverride, undefined);
  }
});

const PARENT = {
  runtime: 'claude',
  modelOverride: { providerId: 'anthropic', modelId: 'claude-opus' },
  thinkingLevel: 'high',
  guiMode: 'ask'
};

test('无父会话：完全回落全局缺省（改造前行为）', () => {
  const r = resolveInheritedDefaults({}, null, GLOBAL);
  assert.equal(r.runtime, 'pi');
  assert.equal(r.modelOverride, undefined);
  assert.equal(r.thinkingLevel, undefined);
  assert.equal(r.guiMode, undefined);
});

test('有父会话：harness/模型/思考/权限全部继承（D8）', () => {
  const r = resolveInheritedDefaults({}, PARENT, GLOBAL);
  assert.equal(r.runtime, 'claude');
  assert.deepEqual(r.modelOverride, { providerId: 'anthropic', modelId: 'claude-opus' });
  assert.equal(r.thinkingLevel, 'high');
  assert.equal(r.guiMode, 'ask');
});

test('显式入参覆盖继承（D3「父可覆盖」）', () => {
  const r = resolveInheritedDefaults(
    { runtime: 'codex-gui', modelOverride: { providerId: 'openai', modelId: 'gpt' }, thinkingLevel: 'low' },
    PARENT,
    GLOBAL
  );
  assert.equal(r.runtime, 'codex-gui');
  assert.deepEqual(r.modelOverride, { providerId: 'openai', modelId: 'gpt' });
  assert.equal(r.thinkingLevel, 'low');
});

test('显式 runtime 为空白串时回落继承，不产出空 runtime', () => {
  const r = resolveInheritedDefaults({ runtime: '   ' }, PARENT, GLOBAL);
  assert.equal(r.runtime, 'claude');
});

test('父该字段未设时回落全局，不阻断其他字段继承', () => {
  const r = resolveInheritedDefaults({}, { runtime: 'claude' }, {
    ...GLOBAL,
    thinkingLevel: 'medium',
    guiMode: 'default'
  });
  assert.equal(r.runtime, 'claude');
  assert.equal(r.thinkingLevel, 'medium');
  assert.equal(r.guiMode, 'default');
});

test('三处都无 runtime 时返回空串（由调用方兜底，不静默塞默认值）', () => {
  const r = resolveInheritedDefaults({}, {}, { runtime: '' });
  assert.equal(r.runtime, '');
});

test('piModeId 不在继承面内（函数签名里就没有它）', () => {
  // D8：Pi 模式含「首条消息后锁死」语义，creator 还挂 modes.* 工具，
  // 子代理不应自动套用父的创作/验收模式。类型层面已排除，运行期再确认一次。
  const parent = { ...PARENT, piModeId: 'creator' };
  const r = resolveInheritedDefaults({}, parent, GLOBAL);
  assert.equal(r.piModeId, undefined);
  assert.equal(Object.keys(r).includes('piModeId'), false);
});
