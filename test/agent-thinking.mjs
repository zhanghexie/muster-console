/**
 * 调度思考档：持久化规整 + available 判定 + 热读缺省。
 * 覆盖「未设置跟随默认 / 显式档热读 / 服务商无映射则 chip 不可用」。
 * 运行: node test/agent-thinking.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const compileTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-thinking-compile-'));
const compile = createSharedCompiler(root, compileTmp);
const persistEntry = compile('main/agent/agentThinking.ts');
const levelsEntry = compile('shared/thinkingLevels.ts');
const { normalizeAgentThinking, normalizeAgentThinkings } = await import(
  pathToFileURL(persistEntry).href
);
const { providerThinkingConfigured, resolveThinkingLevel, GUI_THINKING_LEVELS } = await import(
  pathToFileURL(levelsEntry).href
);

let tmp;
try {
  // ---------------------------------------------- 单条校验
  assert.equal(normalizeAgentThinking('high'), 'high');
  assert.equal(normalizeAgentThinking(' medium '), 'medium');
  assert.equal(normalizeAgentThinking(' xhigh '), 'xhigh', 'a declared native value can survive restarts');
  for (const bad of [null, undefined, '', '  ', 'not an effort', '__proto__', 1, {}, []]) {
    assert.equal(normalizeAgentThinking(bad), null, `应拒绝: ${JSON.stringify(bad)}`);
  }
  for (const lv of GUI_THINKING_LEVELS) {
    assert.equal(normalizeAgentThinking(lv), lv);
  }

  // ---------------------------------------------- 全量规整：丢非法、留合法
  const mixed = normalizeAgentThinkings({
    wsA: 'high',
    wsB: 'xhigh',
    wsC: null,
    wsD: 'off',
    wsE: ' medium '
  });
  assert.deepEqual(mixed, { wsA: 'high', wsB: 'xhigh', wsD: 'off', wsE: 'medium' });
  assert.deepEqual(normalizeAgentThinkings(null), {});
  assert.deepEqual(normalizeAgentThinkings('x'), {});
  assert.deepEqual(normalizeAgentThinkings([]), {});

  // ---------------------------------------------- 重启往返：显式档不丢；空表=跟随默认
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-thinking-store-'));
  const file = path.join(tmp, 'agent-thinking.json');
  fs.writeFileSync(file, JSON.stringify({ default: 'high' }));
  const loaded = normalizeAgentThinkings(JSON.parse(fs.readFileSync(file, 'utf-8')));
  assert.equal(loaded.default, 'high');
  assert.deepEqual(normalizeAgentThinkings({}), {});

  // ---------------------------------------------- available：生效服务商有映射才真
  const providers = [
    {
      id: 'deepseek',
      enabled: true,
      thinking: { levels: { off: 'disabled', low: 'low', medium: 'medium', high: 'high', max: 'max' } }
    },
    { id: 'plain', enabled: true },
    {
      id: 'empty-map',
      enabled: true,
      thinking: { levels: { low: '  ', medium: '' } }
    },
    {
      id: 'disabled-dup',
      enabled: false,
      thinking: { levels: { medium: 'medium' } }
    },
    {
      id: 'disabled-dup',
      enabled: true,
      thinking: { levels: { medium: 'medium' } }
    }
  ];
  assert.equal(providerThinkingConfigured(providers, 'deepseek'), true);
  assert.equal(providerThinkingConfigured(providers, 'plain'), false);
  assert.equal(providerThinkingConfigured(providers, 'empty-map'), false);
  assert.equal(providerThinkingConfigured(providers, ''), false);
  assert.equal(providerThinkingConfigured(providers, 'missing'), false);
  // enabled!==false 优先：同 id 先命中启用副本
  assert.equal(providerThinkingConfigured(providers, 'disabled-dup'), true);

  // ---------------------------------------------- 热读：未设跟随默认；显式档盖过缺省
  assert.equal(resolveThinkingLevel(null, true), 'medium');
  assert.equal(resolveThinkingLevel(undefined, true), 'medium');
  assert.equal(resolveThinkingLevel(null, false), 'off');
  assert.equal(resolveThinkingLevel('high', true), 'high');
  assert.equal(resolveThinkingLevel('off', true), 'off');
  assert.equal(resolveThinkingLevel('low', false), 'low');
  // 切档后再读：同一回调换返回值即换档（无需重连）
  let pinned = /** @type {string | null} */ ('high');
  const hotRead = () => pinned;
  assert.equal(resolveThinkingLevel(hotRead(), true), 'high');
  pinned = null;
  assert.equal(resolveThinkingLevel(hotRead(), true), 'medium');
  pinned = 'max';
  assert.equal(resolveThinkingLevel(hotRead(), true), 'max');

  console.log('agent-thinking.mjs 全部通过');
} finally {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(compileTmp, { recursive: true, force: true });
}
