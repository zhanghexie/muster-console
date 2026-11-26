/**
 * R3 机械守卫纯函数：心跳 / needs_you 超时 / 可补位；已提醒去重；忙会话跳过心跳。
 * 运行: node test/orchestrator-guards.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-guards-'));
const compile = createSharedCompiler(root, tmp);

const {
  ORCH_GUARD_DEFAULTS,
  evaluateOrchGuards,
  guardKeysToClearOnActivity,
  guardKeysToClearOnPhase,
  isOrchestratedWorker,
  migrateOrchestratedFlag,
  slotFreeKey
} = await import(pathToFileURL(compile('shared/orchestratorGuards.ts')).href);

const { orchEventKey } = await import(pathToFileURL(compile('shared/notifyQueue.ts')).href);

assert.equal(ORCH_GUARD_DEFAULTS.heartbeatMs, 15 * 60_000);
assert.equal(ORCH_GUARD_DEFAULTS.needsYouMs, 30 * 60_000);

const worker = (over) => ({
  sessionId: 's1',
  sessionName: 'W1',
  workspaceId: 'ws',
  phase: undefined,
  lastActivityAt: 0,
  busy: false,
  orchestrated: true,
  ...over
});

const base = {
  now: 15 * 60_000,
  workers: [],
  queuedDelegateCount: 0,
  activeWorkers: 0,
  maxConcurrent: 5,
  workspaceId: 'ws',
  alreadyFired: new Set()
};

assert.deepEqual(evaluateOrchGuards({ ...base, workers: [] }), []);

// 心跳只适用 (a) lifecycle=working 或 (b) 已分配任务且未报 needs_you/done（R3 实现注意）：
// 回归——从未接任务的 idle 会话 lastActivity=0 不得误报（「工作面板 66」实战误报）。
const idleNoTask = evaluateOrchGuards({ ...base, workers: [worker({ lastActivityAt: 0 })] });
assert.equal(idleNoTask.length, 0);
assert.equal(
  evaluateOrchGuards({
    ...base,
    workers: [worker({ lastActivityAt: 0, lifecycle: 'idle' })]
  }).length,
  0
);

const hb = evaluateOrchGuards({
  ...base,
  workers: [worker({ lastActivityAt: 0, lifecycle: 'working' })]
});
assert.equal(hb.length, 1);
assert.equal(hb[0].kind, 'heartbeat_stale');
assert.match(hb[0].detail, /15 分钟/);

// A past assignment alone is not evidence of a currently running turn.
const hbAssigned = evaluateOrchGuards({
  ...base,
  workers: [worker({ lastActivityAt: 0, hasAssignedTask: true })]
});
assert.equal(hbAssigned.length, 0);
assert.equal(evaluateOrchGuards({ ...base, workers: [worker({ lifecycle: 'idle', hasAssignedTask: true })] }).length, 0);
assert.equal(evaluateOrchGuards({ ...base, workers: [worker({ lifecycle: 'working', phase: 'idle' })] }).length, 0);

// 已报 needs_you / done 的已分配会话：不触发心跳（needs_you_stale 另行处理）
const assignedReported = evaluateOrchGuards({
  ...base,
  now: 40 * 60_000,
  workers: [
    worker({ lastActivityAt: 0, hasAssignedTask: true, phase: 'needs_you', needsYouSince: 0 }),
    worker({ lastActivityAt: 0, hasAssignedTask: true, phase: 'done' })
  ]
});
assert.equal(assignedReported.some((a) => a.kind === 'heartbeat_stale'), false);

// shell / scheduled 会话不参与心跳
assert.equal(
  evaluateOrchGuards({
    ...base,
    workers: [worker({ lastActivityAt: 0, lifecycle: 'working', launchKind: 'shell' })]
  }).length,
  0
);
assert.equal(
  evaluateOrchGuards({
    ...base,
    workers: [worker({ lastActivityAt: 0, lifecycle: 'working', type: 'scheduled' })]
  }).length,
  0
);

const busySkip = evaluateOrchGuards({
  ...base,
  workers: [worker({ lastActivityAt: 0, lifecycle: 'working', busy: true })]
});
assert.equal(busySkip.length, 0);

const fresh = evaluateOrchGuards({
  ...base,
  now: 14 * 60_000,
  workers: [worker({ lastActivityAt: 0, lifecycle: 'working' })]
});
assert.equal(fresh.length, 0);

const fired = new Set([orchEventKey('heartbeat_stale', 'ws', 's1')]);
const dup = evaluateOrchGuards({
  ...base,
  workers: [worker({ lastActivityAt: 0, lifecycle: 'working' })],
  alreadyFired: fired
});
assert.equal(dup.length, 0);
console.log('ok: 心跳适用范围（working/已分配任务） / 误报排除 / 忙跳过 / 去重');

const ny = evaluateOrchGuards({
  ...base,
  now: 30 * 60_000,
  workers: [
    worker({
      phase: 'needs_you',
      needsYouSince: 0,
      lastActivityAt: 29 * 60_000
    })
  ]
});
assert.equal(ny.some((a) => a.kind === 'needs_you_stale'), true);
assert.match(ny.find((a) => a.kind === 'needs_you_stale').detail, /30 分钟/);

const nyEarly = evaluateOrchGuards({
  ...base,
  now: 10 * 60_000,
  workers: [worker({ phase: 'needs_you', needsYouSince: 0, lastActivityAt: 9 * 60_000 })]
});
assert.equal(nyEarly.some((a) => a.kind === 'needs_you_stale'), false);

const archived = evaluateOrchGuards({
  ...base,
  workers: [worker({ archived: true, lastActivityAt: 0 })]
});
assert.equal(archived.length, 0);
console.log('ok: needs_you 超时 / 归档跳过');

const slot = evaluateOrchGuards({
  ...base,
  queuedDelegateCount: 2,
  activeWorkers: 3,
  maxConcurrent: 5
});
assert.equal(slot.length, 1);
assert.equal(slot[0].kind, 'slot_free');
assert.match(slot[0].detail, /排队 2/);
assert.equal(slot[0].key, slotFreeKey('ws'));

assert.equal(
  evaluateOrchGuards({
    ...base,
    queuedDelegateCount: 2,
    activeWorkers: 5,
    maxConcurrent: 5
  }).length,
  0
);
assert.equal(
  evaluateOrchGuards({
    ...base,
    queuedDelegateCount: 2,
    activeWorkers: 0,
    maxConcurrent: 0
  }).length,
  0
);
console.log('ok: 并发位可补位');

assert.deepEqual(guardKeysToClearOnActivity('ws', 's1'), [
  orchEventKey('heartbeat_stale', 'ws', 's1')
]);
assert.deepEqual(guardKeysToClearOnPhase('ws', 's1', 'needs_you'), []);
assert.deepEqual(guardKeysToClearOnPhase('ws', 's1', 'idle'), [
  orchEventKey('needs_you_stale', 'ws', 's1')
]);

console.log('orchestrator-guards: all ok');

// isOrchestratedWorker：编排上报只认 orchestrated 元信息（调度拉起/派活自动置位，
// 可经 sessions.setOrchestrated 动态改）；旧 briefCount 计数不再是标记
assert.equal(isOrchestratedWorker({ orchestrated: true }), true);
assert.equal(isOrchestratedWorker({ orchestrated: false }), false);
assert.equal(isOrchestratedWorker({}), false);
assert.equal(isOrchestratedWorker({ briefCount: 5 }), false, '旧计数不再作为编排标记');
console.log('ok: 编排关联性（orchestrated===true 才上报）');

// 读入迁移：旧计数>0 且缺省新标记 → 回填 true；显式 false 不复活；其余保持缺省
assert.equal(migrateOrchestratedFlag({ briefCount: 2 }), true);
assert.equal(migrateOrchestratedFlag({ briefCount: 0 }), undefined);
assert.equal(migrateOrchestratedFlag({}), undefined);
assert.equal(migrateOrchestratedFlag({ orchestrated: true }), true);
assert.equal(migrateOrchestratedFlag({ orchestrated: false, briefCount: 9 }), false);
console.log('ok: briefCount→orchestrated 一次性迁移（显式值优先）');

// 编排关联性进守卫：orchestrated=false（手工会话，briefCount=0）不进心跳/needs_you
// 超时监控——停滞由人自己盯着，报给调度纯属自噪声。还原守卫门禁时以下两条转红。
assert.equal(
  evaluateOrchGuards({
    ...base,
    workers: [worker({ orchestrated: false, lastActivityAt: 0, lifecycle: 'working' })]
  }).length,
  0,
  '手工会话 working 停滞不得报心跳超时'
);
assert.equal(
  evaluateOrchGuards({
    ...base,
    now: 31 * 60_000,
    workers: [worker({ orchestrated: false, phase: 'needs_you', needsYouSince: 0 })]
  }).length,
  0,
  '手工会话 needs_you 停滞不得报超时'
);
console.log('ok: 守卫只盯被派过活的会话（orchestrated fail-closed）');
