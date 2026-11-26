/**
 * trigger 模型（T3.1）：类型校验 / 读时迁移 / path 模式匹配 / 事件评估纯函数（防抖窗口）
 * 运行: node test/prompt-tasks-trigger.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrig-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('shared/promptTasks.ts');
const { TIMER_EARLY_FIRE_TOLERANCE_MS, KEEP_AWAKE_LEAD_MS, evaluateMissedWindow, resolveMissedPolicy, shouldKeepAwake } = await import(pathToFileURL(outFile).href);

// ---------- T3.4 错过窗口 / keep-awake 纯函数 ----------
assert.equal(resolveMissedPolicy(undefined), 'skip');
assert.equal(resolveMissedPolicy('catch-up'), 'catch-up');
assert.equal(resolveMissedPolicy('confirm'), 'confirm');
assert.equal(resolveMissedPolicy('skip'), 'skip');

const now = 1_000_000;
assert.equal(evaluateMissedWindow({ now, nextRunAt: now + 1 }).action, 'none', '未到期');
assert.equal(evaluateMissedWindow({ now }).action, 'none', '无 nextRunAt');
assert.deepEqual(
  evaluateMissedWindow({ now, nextRunAt: now - 60_000 }),
  { action: 'skip', missedAt: now - 60_000 },
  '缺省 skip'
);
assert.equal(
  evaluateMissedWindow({ now, nextRunAt: now - 60_000, policy: 'catch-up' }).action,
  'catch-up'
);
assert.equal(
  evaluateMissedWindow({ now, nextRunAt: now - 60_000, policy: 'confirm' }).action,
  'confirm'
);
assert.equal(
  evaluateMissedWindow({
    now,
    nextRunAt: now - 2,
    lastRunAt: now - 4
  }).action,
  'none',
  '早触发容差内不算错过'
);
assert.equal(
  evaluateMissedWindow({
    now,
    nextRunAt: now - 60_000,
    lastRunAt: now - 70_000
  }).action,
  'skip',
  '容差外仍错过'
);
assert.equal(
  evaluateMissedWindow({ now, nextRunAt: now - 60_000, inFlight: true }).action,
  'none',
  '在途不算错过'
);
console.log('ok: evaluateMissedWindow（缺省 skip / 三策略 / 容差 / 在途）');

assert.equal(shouldKeepAwake({ enabled: false, inFlightCount: 1, nextRunAts: [], now }), false);
assert.equal(shouldKeepAwake({ enabled: true, inFlightCount: 1, nextRunAts: [], now }), true);
assert.equal(
  shouldKeepAwake({ enabled: true, inFlightCount: 0, nextRunAts: [now + KEEP_AWAKE_LEAD_MS], now }),
  true,
  '临近触发'
);
assert.equal(
  shouldKeepAwake({
    enabled: true,
    inFlightCount: 0,
    nextRunAts: [now + KEEP_AWAKE_LEAD_MS + 1],
    now
  }),
  false,
  '超出提前量'
);
assert.equal(
  shouldKeepAwake({
    enabled: true,
    inFlightCount: 0,
    nextRunAts: [now - TIMER_EARLY_FIRE_TOLERANCE_MS],
    now
  }),
  true,
  '刚过点仍保活'
);
assert.equal(
  shouldKeepAwake({
    enabled: true,
    inFlightCount: 0,
    nextRunAts: [now - TIMER_EARLY_FIRE_TOLERANCE_MS - 1],
    now
  }),
  false
);
console.log('ok: shouldKeepAwake');

console.log('prompt-tasks-trigger: ok');
