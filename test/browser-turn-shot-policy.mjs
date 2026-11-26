/**
 * 回合结束浏览器截图证据 · 纯逻辑（任务 D）：归属台账（记录/清除/去重/封顶/
 * 跨会话与跨回合隔离）+ 采集决策谓词（开关关闭 / 目标已关闭跳过）。
 * 运行: node test/browser-turn-shot-policy.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-turn-shot-policy-'));
const compile = createSharedCompiler(root, tmp);

const {
  TurnTabLedger,
  shouldCapture,
  TURN_SHOT_MAX_TABS
} = await import(pathToFileURL(compile('main/browser/turnShots.ts')));

// ---------- recordToolUse：记录 / 去重 / 首次使用顺序 ----------

let ledger = new TurnTabLedger();
ledger.recordToolUse('sess-1', 'tab-a', 1000);
ledger.recordToolUse('sess-1', 'tab-b', 1100);
ledger.recordToolUse('sess-1', 'tab-a', 1200); // 去重：同 tab 二次使用不重复记
const usage = ledger.collectTurnTabs('sess-1');
assert.deepEqual(usage, { tabIds: ['tab-a', 'tab-b'], firstTs: 1000, lastTs: 1200 });

// ---------- 空参忽略；无记录会话 collect 返回 null ----------

ledger = new TurnTabLedger();
ledger.recordToolUse('', 'tab-a', 1000);
ledger.recordToolUse('sess-1', '  ', 1000);
assert.equal(ledger.size(), 0);
assert.equal(ledger.collectTurnTabs('sess-1'), null);

// ---------- 取走即清：第二次 collect 为空（回合边界） ----------

ledger = new TurnTabLedger();
ledger.recordToolUse('sess-1', 'tab-a', 1000);
assert.notEqual(ledger.collectTurnTabs('sess-1'), null);
assert.equal(ledger.collectTurnTabs('sess-1'), null);

// ---------- 跨回合隔离：收口后新记录属于新回合，不带旧 tab ----------

ledger = new TurnTabLedger();
ledger.recordToolUse('sess-1', 'tab-a', 1000);
ledger.collectTurnTabs('sess-1'); // 回合 1 收口
ledger.recordToolUse('sess-1', 'tab-b', 2000); // 回合 2
const turn2 = ledger.collectTurnTabs('sess-1');
assert.deepEqual(turn2, { tabIds: ['tab-b'], firstTs: 2000, lastTs: 2000 });

// ---------- 跨会话隔离：双会话各记各的 tab，互不串 ----------

ledger = new TurnTabLedger();
ledger.recordToolUse('sess-1', 'tab-a', 1000);
ledger.recordToolUse('sess-2', 'tab-b', 1100);
assert.deepEqual(ledger.collectTurnTabs('sess-1').tabIds, ['tab-a']);
assert.deepEqual(ledger.collectTurnTabs('sess-2').tabIds, ['tab-b']);
assert.equal(ledger.size(), 0);

// ---------- 封顶：单回合 tab 数上限（先来先得） ----------

ledger = new TurnTabLedger();
for (let i = 0; i < TURN_SHOT_MAX_TABS + 4; i++) {
  ledger.recordToolUse('sess-1', `tab-${i}`, 1000 + i);
}
const capped = ledger.collectTurnTabs('sess-1');
assert.equal(capped.tabIds.length, TURN_SHOT_MAX_TABS);
assert.deepEqual(capped.tabIds, Array.from({ length: TURN_SHOT_MAX_TABS }, (_, i) => `tab-${i}`));

// ---------- clearSession：未收口就关会话的兜底清理 ----------

ledger = new TurnTabLedger();
ledger.recordToolUse('sess-1', 'tab-a', 1000);
ledger.clearSession('sess-1');
assert.equal(ledger.collectTurnTabs('sess-1'), null);
assert.equal(ledger.size(), 0);

// ---------- shouldCapture：开关关闭 / 目标已关闭 → 跳过 ----------

assert.equal(shouldCapture({ enabled: true, tabAlive: true }), true);
assert.equal(shouldCapture({ enabled: false, tabAlive: true }), false); // 证据开关关闭
assert.equal(shouldCapture({ enabled: true, tabAlive: false }), false); // 目标 tab 已关/未挂载
assert.equal(shouldCapture({ enabled: false, tabAlive: false }), false);

console.log('browser-turn-shot-policy: all assertions passed');
