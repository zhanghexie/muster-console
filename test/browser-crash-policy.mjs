/**
 * 崩溃恢复策略纯逻辑（任务 A）：退避序列、次数上限、稳定窗口重置。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-crash-policy-'));
const compile = createSharedCompiler(root, tmp);

const {
  nextCrashRecovery,
  CRASH_BACKOFF_DELAYS_MS,
  CRASH_MAX_ATTEMPTS,
  CRASH_RESET_WINDOW_MS
} = await import(pathToFileURL(compile('main/browser/crashPolicy.ts')));

// 首次崩溃：立即 reload，计数 1
let r = nextCrashRecovery(null, 1000);
assert.deepEqual(r.decision, { action: 'reload', delayMs: 0 });
assert.deepEqual(r.state, { attempts: 1, lastCrashAt: 1000, gaveUp: false });

// 退避序列：1s → 3s → 8s
r = nextCrashRecovery(r.state, 1600);
assert.deepEqual(r.decision, { action: 'reload', delayMs: CRASH_BACKOFF_DELAYS_MS[1] });
assert.equal(r.state.attempts, 2);
r = nextCrashRecovery(r.state, 5000);
assert.deepEqual(r.decision, { action: 'reload', delayMs: 3000 });
r = nextCrashRecovery(r.state, 14000);
assert.deepEqual(r.decision, { action: 'reload', delayMs: 8000 });
assert.equal(r.state.attempts, 4);
assert.equal(r.state.gaveUp, false);

// 上限：第 5 次连续崩溃 → give-up（停止自动恢复）
r = nextCrashRecovery(r.state, 30000);
assert.deepEqual(r.decision, { action: 'give-up', delayMs: 0 });
assert.equal(r.state.gaveUp, true);
assert.equal(r.state.attempts, 5);
assert.equal(CRASH_MAX_ATTEMPTS, 5);

// 稳定窗口：距上次崩溃超过窗口 → 重新计数为第 1 次（偶发崩溃不累积惩罚）
const stale = { attempts: 4, lastCrashAt: 1000, gaveUp: false };
r = nextCrashRecovery(stale, 1000 + CRASH_RESET_WINDOW_MS + 1);
assert.equal(r.state.attempts, 1);
assert.deepEqual(r.decision, { action: 'reload', delayMs: 0 });

// 窗口内：继续累积
r = nextCrashRecovery(stale, 1000 + CRASH_RESET_WINDOW_MS - 1);
assert.equal(r.state.attempts, 5);
assert.equal(r.decision.action, 'give-up');

// 恰好达到窗口：必须严格超过才能清零
r = nextCrashRecovery(stale, 1000 + CRASH_RESET_WINDOW_MS);
assert.equal(r.state.attempts, 5);
assert.equal(r.decision.action, 'give-up');

// gaveUp 状态下再次崩溃：保持错误态（显式导航/手动重试才清零）
const given = { attempts: 5, lastCrashAt: 1000, gaveUp: true };
r = nextCrashRecovery(given, 999_999);
assert.equal(r.decision.action, 'give-up');
assert.equal(r.state.gaveUp, true);

console.log('browser-crash-policy: all assertions passed');
