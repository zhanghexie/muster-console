/**
 * R2：pipeline 机械判定纯函数。
 * 运行: node test/pipeline-status.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-status-'));
const compile = createSharedCompiler(root, tmp);

const { judgePipelineWorker, lastActivityAt, normalizePipelineStallMs, DEFAULT_PIPELINE_STALL_MS, activeTurnMetrics, normalizePipelineSlowTurnMs, DEFAULT_PIPELINE_SLOW_TURN_MS } =
  await import(pathToFileURL(compile('shared/pipelineStatus.ts')).href);

assert.equal(normalizePipelineStallMs(undefined), DEFAULT_PIPELINE_STALL_MS);
assert.equal(normalizePipelineStallMs(1000), 60_000);
assert.ok(lastActivityAt([1, 5, undefined, 3]) === 5);

const now = 1_000_000;
const th = { stallMs: 15 * 60 * 1000 };
const base = {
  uncommittedCount: 0,
  aheadCount: 2,
  canFastForward: true,
  dirtyOverlap: false,
  hasWorktree: true,
  lastActivityAt: now
};

assert.equal(judgePipelineWorker({ ...base, phase: 'needs_you' }, now, th).kind, 'readyToMerge');
assert.equal(
  judgePipelineWorker({ ...base, phase: 'needs_you', dirtyOverlap: true }, now, th).mergeBlocked,
  'dirty_overlap'
);
assert.equal(
  judgePipelineWorker({ ...base, phase: 'needs_you', uncommittedCount: 3 }, now, th).mergeBlocked,
  'uncommitted'
);
assert.equal(
  judgePipelineWorker({ ...base, phase: 'needs_you', aheadCount: 0 }, now, th).mergeBlocked,
  'no_ahead'
);
assert.equal(
  judgePipelineWorker({ ...base, phase: 'needs_you', canFastForward: false }, now, th).mergeBlocked,
  'not_fast_forward'
);
assert.equal(
  judgePipelineWorker({ ...base, phase: 'needs_you', hasWorktree: false }, now, th).mergeBlocked,
  'no_worktree'
);
assert.equal(
  judgePipelineWorker({ ...base, lifecycle: 'working', phase: undefined, lastActivityAt: now - th.stallMs - 1 }, now, th).kind,
  'stalled'
);
assert.equal(judgePipelineWorker({ ...base, phase: 'working' }, now, th).kind, 'working');
assert.equal(judgePipelineWorker({ ...base, phase: 'idle' }, now, th).kind, 'idle');
assert.equal(judgePipelineWorker({ ...base, archived: true, phase: 'needs_you' }, now, th).kind, 'idle');

// ---------- O6 慢回合感知：activeTurnMs / slowTurn ----------
const T0 = 1_000_000;
// 未开回合（无 startedAt）→ null / 不 slow
assert.deepEqual(activeTurnMetrics({ now: T0, turnStartedAt: undefined }), {
  activeTurnMs: null,
  slowTurn: false
});
assert.deepEqual(activeTurnMetrics({ now: T0, turnStartedAt: null }), {
  activeTurnMs: null,
  slowTurn: false
});
// 时钟回拨（startedAt 晚于 now）按不在回合处理（fail-open）
assert.deepEqual(activeTurnMetrics({ now: T0, turnStartedAt: T0 + 5 }), {
  activeTurnMs: null,
  slowTurn: false
});
// 刚开回合：有值、不 slow
const fresh = activeTurnMetrics({ now: T0, turnStartedAt: T0 - 5_000 });
assert.equal(fresh.activeTurnMs, 5_000);
assert.equal(fresh.slowTurn, false);
// 超缺省阈值（10 分钟）：slow
const slow = activeTurnMetrics({ now: T0, turnStartedAt: T0 - DEFAULT_PIPELINE_SLOW_TURN_MS });
assert.equal(slow.activeTurnMs, DEFAULT_PIPELINE_SLOW_TURN_MS);
assert.equal(slow.slowTurn, true);
// 阈值前一毫秒仍不 slow（边界：>= 判 slow）
const justUnder = activeTurnMetrics({
  now: T0,
  turnStartedAt: T0 - (DEFAULT_PIPELINE_SLOW_TURN_MS - 1)
});
assert.equal(justUnder.slowTurn, false);
// config 覆盖阈值（pipeline.slowTurnMs）：2 分钟
const custom = activeTurnMetrics({ now: T0, turnStartedAt: T0 - 90_000, slowTurnMs: 120_000 });
assert.equal(custom.activeTurnMs, 90_000);
assert.equal(custom.slowTurn, false);
assert.equal(
  activeTurnMetrics({ now: T0, turnStartedAt: T0 - 120_000, slowTurnMs: 120_000 }).slowTurn,
  true
);
// normalize：缺省 10 分钟；非法回落；越界钳制
assert.equal(normalizePipelineSlowTurnMs(undefined), DEFAULT_PIPELINE_SLOW_TURN_MS);
assert.equal(normalizePipelineSlowTurnMs('x'), DEFAULT_PIPELINE_SLOW_TURN_MS);
assert.equal(normalizePipelineSlowTurnMs(1_000), 60_000);
assert.equal(normalizePipelineSlowTurnMs(25 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
assert.equal(normalizePipelineSlowTurnMs(5 * 60 * 1000), 5 * 60 * 1000);
console.log('ok: O6 activeTurnMetrics / normalizePipelineSlowTurnMs 矩阵');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] pipeline-status');
