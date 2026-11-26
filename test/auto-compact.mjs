/**
 * 上下文阈值自动压缩回归：
 * 1) 能力位 autoCompact 只对 pi 开；
 * 2) 配置归一（缺省/夹紧/关闭）；
 * 3) decideAutoCompact：超阈触发、低于阈不触发、用量未知不触发；
 * 4) 进行中（busy）不重复触发；
 * 5) 手动/自动互斥口径——busy 时 skip（与 Host/Orchestrator compactSession 置 busy 同源）。
 * 运行: node test/auto-compact.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-compact-'));
const compile = createSharedCompiler(root, tmp);

const { CHAT_RUNTIME_CAPABILITIES } = await import(
  pathToFileURL(compile('shared/agentRuntimeCapabilities.ts')).href
);
const {
  DEFAULT_AUTO_COMPACT_RATIO,
  AUTO_COMPACT_RATIO_MIN,
  AUTO_COMPACT_RATIO_MAX,
  normalizeAutoCompactRatio,
  normalizeAutoCompactConfig,
  decideAutoCompact
} = await import(pathToFileURL(compile('shared/autoCompact.ts')).href);

// ── 1) 能力位：pi 独有 ──
for (const [id, caps] of Object.entries(CHAT_RUNTIME_CAPABILITIES)) {
  assert.equal(
    caps.autoCompact,
    id === 'pi',
    `${id} 的 autoCompact 应为 ${id === 'pi'}`
  );
  assert.equal(
    caps.manualCompact,
    id === 'pi',
    `${id} 的 manualCompact 应与 autoCompact 同为 pi 独有`
  );
}

// ── 2) 配置归一 ──
assert.equal(normalizeAutoCompactRatio(undefined), DEFAULT_AUTO_COMPACT_RATIO);
assert.equal(normalizeAutoCompactRatio(NaN), DEFAULT_AUTO_COMPACT_RATIO);
assert.equal(normalizeAutoCompactRatio(0.1), AUTO_COMPACT_RATIO_MIN, '过低夹到 MIN');
assert.equal(normalizeAutoCompactRatio(1.5), AUTO_COMPACT_RATIO_MAX, '过高夹到 MAX');
assert.equal(normalizeAutoCompactRatio(0.85), 0.85);

assert.deepEqual(normalizeAutoCompactConfig(undefined), {
  enabled: true,
  ratio: DEFAULT_AUTO_COMPACT_RATIO
});
assert.deepEqual(normalizeAutoCompactConfig({ enabled: false, ratio: 0.9 }), {
  enabled: false,
  ratio: 0.9
});
assert.equal(normalizeAutoCompactConfig({ enabled: true }).enabled, true);

// ── 3) 阈值触发 ──
{
  const base = {
    autoCompactCapable: true,
    configEnabled: true,
    ratioThreshold: 0.8,
    busy: false
  };
  assert.deepEqual(
    decideAutoCompact({ ...base, tokens: 80_000, contextWindow: 100_000 }),
    { action: 'compact' },
    '正好 80% 触发'
  );
  assert.deepEqual(
    decideAutoCompact({ ...base, tokens: 80_001, contextWindow: 100_000 }),
    { action: 'compact' },
    '超过阈值触发'
  );
  assert.deepEqual(
    decideAutoCompact({ ...base, tokens: 79_999, contextWindow: 100_000 }),
    { action: 'skip', reason: 'below-threshold' },
    '低于阈值不触发'
  );
  assert.deepEqual(
    decideAutoCompact({ ...base, tokens: null, contextWindow: 100_000 }),
    { action: 'skip', reason: 'unknown-usage' },
    '刚 compaction tokens=null 不触发（防紧循环）'
  );
  assert.deepEqual(
    decideAutoCompact({ ...base, tokens: 90_000, contextWindow: 0 }),
    { action: 'skip', reason: 'unknown-usage' },
    '无窗口不触发'
  );
  assert.deepEqual(
    decideAutoCompact({ ...base, tokens: 90_000, contextWindow: 100_000, configEnabled: false }),
    { action: 'skip', reason: 'disabled' }
  );
  assert.deepEqual(
    decideAutoCompact({
      ...base,
      tokens: 90_000,
      contextWindow: 100_000,
      autoCompactCapable: false
    }),
    { action: 'skip', reason: 'no-capability' },
    '非 pi runtime 不触发'
  );
}

// ── 4) 进行中不重复触发（busy=true，模拟 compact 已在飞 / 回合未收口）──
{
  const r = decideAutoCompact({
    autoCompactCapable: true,
    configEnabled: true,
    ratioThreshold: 0.5,
    tokens: 99_000,
    contextWindow: 100_000,
    busy: true
  });
  assert.deepEqual(r, { action: 'skip', reason: 'busy' }, 'busy 时即使远超阈值也不再触发');
}

// ── 5) 手动/自动互斥：手动 compactSession 置 busy 后，自动判定必 skip ──
{
  // 模拟：用户敲 /compact → Host 置 busy → 同刻回合收口想自动压
  const afterManualStarted = decideAutoCompact({
    autoCompactCapable: true,
    configEnabled: true,
    ratioThreshold: 0.8,
    tokens: 95_000,
    contextWindow: 100_000,
    busy: true // compactSession 入口已置
  });
  assert.equal(afterManualStarted.action, 'skip');
  assert.equal(afterManualStarted.reason, 'busy');

  // 反过来：自动已开跑 busy=true，手动路径同样被 compactSession 入口拒绝
  // （此处只断言自动侧判定；手动侧 busy 拒绝见 compact-command / Host 文案）
  const duringAuto = decideAutoCompact({
    autoCompactCapable: true,
    configEnabled: true,
    ratioThreshold: 0.8,
    tokens: 95_000,
    contextWindow: 100_000,
    busy: true
  });
  assert.equal(duringAuto.action, 'skip');
}

console.log('auto-compact: ok');
