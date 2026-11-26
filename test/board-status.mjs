/**
 * 看板状态推导：hook 卡住态 > model done > hook active；kind 不改列；done 不被 hook idle/shell active 覆盖。
 * Run: node test/board-status.mjs
 */
import assert from 'node:assert/strict';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-status-'));

const out = createSharedCompiler(root, tmp)('shared/boardStatus.ts');
const {
  deriveBoardStatus,
  boardZoneOf,
  activityClearsDonePhase,
  phaseWriteBlocked,
  sessionDisplayStatus,
  sessionBoardColumn,
  BOARD_ZONE_ORDER,
  NO_SIGNAL_GRACE_MS,
  ACTIVITY_ACTIVE_FRESH_MS
} = await import(pathToFileURL(out).href);

const NOW = 1_000_000_000_000;
const facts = (over = {}) => ({
  type: 'terminal',
  now: NOW,
  ...over
});
const derive = (over = {}) => deriveBoardStatus(facts(over));
const phase = (value, source = 'model', ts = NOW) => ({ value, source, ts });

assert.equal(NO_SIGNAL_GRACE_MS, 90_000, 'no_signal 宽限 90s');
assert.deepEqual(BOARD_ZONE_ORDER, ['working', 'needsYou', 'done', 'archived']);

// 1) 未完成的 exited 一锤定音；phase=done 盖过进程退出（合入后 GUI/pty 闲置退出不灰化）
assert.equal(derive({ lifecycle: 'exited' }), 'error');
assert.equal(derive({ ptyStatus: 'exited' }), 'error');
assert.equal(
  derive({ lifecycle: 'exited', phase: phase('done'), liveStatus: { label: 'x', kind: 'done', ts: NOW } }),
  'done',
  'phase=done 盖过 lifecycle=exited'
);
assert.equal(
  derive({ ptyStatus: 'exited', phase: phase('done') }),
  'done',
  'phase=done 盖过 ptyStatus=exited'
);
assert.equal(boardZoneOf('exited'), 'archived');
assert.equal(boardZoneOf('done'), 'done');

// 2) scheduled
assert.equal(derive({ type: 'scheduled' }), 'scheduled');

// 3) liveStatus.kind 不再驱动列
assert.equal(
  derive({ lifecycle: 'idle', liveStatus: { label: '已完成', kind: 'done', ts: NOW } }),
  'idle',
  'kind=done 只是胶囊'
);
assert.equal(
  derive({ lifecycle: 'idle', liveStatus: { label: '失败', kind: 'error', ts: NOW } }),
  'idle',
  'kind=error 不改列'
);
assert.equal(
  derive({ lifecycle: 'idle', liveStatus: { label: '等待中', kind: 'waiting', ts: NOW } }),
  'idle'
);

// 4) hook blocked / waiting_input 粘性，盖过 phase
assert.equal(derive({ lifecycle: 'idle', activity: { kind: 'blocked', ts: NOW - 600_000 } }), 'blocked');
assert.equal(
  derive({
    lifecycle: 'idle',
    activity: { kind: 'waiting_input', ts: NOW - 600_000 },
    phase: phase('done')
  }),
  'waiting',
  'hook needs_you 盖过 model done'
);
assert.equal(boardZoneOf('blocked'), 'needsYou');
assert.equal(boardZoneOf('waiting'), 'needsYou');

// 5) 新鲜 hook active → working；但不得盖过 / 冲掉 model done（Cursor shell hook 噪声）
assert.equal(
  derive({ lifecycle: 'idle', activity: { kind: 'active', ts: NOW - 1_000 }, phase: phase('done') }),
  'done',
  'shell/tool 的 hook active 不得盖过 model done'
);
assert.equal(
  derive({ lifecycle: 'idle', activity: { kind: 'active', ts: NOW - 1_000 } }),
  'working',
  '无 done 时新鲜 active 仍是 working'
);
assert.equal(
  derive({ lifecycle: 'idle', activity: { kind: 'active', ts: NOW - ACTIVITY_ACTIVE_FRESH_MS - 1 } }),
  'idle',
  '过期 active 回落'
);
assert.equal(
  derive({
    lifecycle: 'working',
    activity: { kind: 'active', ts: NOW - ACTIVITY_ACTIVE_FRESH_MS - 1 }
  }),
  'working'
);
assert.equal(derive({ lifecycle: 'idle', activity: { kind: 'active' } }), 'idle', '缺 ts 视为过期');
assert.equal(activityClearsDonePhase('active', 'user-prompt-submit'), true);
assert.equal(activityClearsDonePhase('active', 'opencode-turn'), true, 'OpenCode 监控观测到新回合开始等同用户提交');
assert.equal(activityClearsDonePhase('active', 'codex-turn'), true, 'Codex turn 通知观测到新回合开始等同用户提交');
assert.equal(activityClearsDonePhase('active', 'codex-turn-heartbeat'), false, 'Codex heartbeat is not a new turn');
assert.equal(activityClearsDonePhase('idle', 'opencode-turn'), false, '回合结束上报不清 done');
assert.equal(activityClearsDonePhase('idle', 'codex-turn'), false, 'Codex 回合结束上报不清 done');
assert.equal(activityClearsDonePhase('active', 'shell-end'), false);
assert.equal(activityClearsDonePhase('active', 'shell-start'), false);
assert.equal(activityClearsDonePhase('active', 'pre-tool-use'), false);
assert.equal(activityClearsDonePhase('active', 'session-start'), false);
assert.equal(activityClearsDonePhase('idle', 'stop'), false);

// 6) model/llm phase：done 不被 hook idle 覆盖
assert.equal(
  derive({
    lifecycle: 'idle',
    activity: { kind: 'idle', ts: NOW },
    phase: phase('done', 'model')
  }),
  'done',
  'hook idle 不覆盖 done'
);
assert.equal(
  derive({ lifecycle: 'working', phase: phase('done', 'llm') }),
  'done'
);
assert.equal(boardZoneOf('done'), 'done');
assert.equal(derive({ lifecycle: 'idle', phase: phase('needs_you') }), 'waiting');
assert.equal(
  derive({ lifecycle: 'working', phase: phase('needs_you') }),
  'waiting',
  'needs_you 盖过廉价 working（须由 touchUsed / 新 inject 清除）'
);
assert.equal(derive({ lifecycle: 'working', phase: phase('idle') }), 'idle');

// 7) 廉价输出 working / lifecycle blocked
assert.equal(derive({ lifecycle: 'working' }), 'working');
assert.equal(derive({ ptyStatus: 'running' }), 'working');
assert.equal(derive({ lifecycle: 'blocked' }), 'blocked');
assert.equal(boardZoneOf('working'), 'working');

// 8) starting 超 90s 无权威信号 → no_signal
const started = NOW - 91_000;
assert.equal(derive({ lifecycle: 'starting', startedAt: started }), 'no_signal');
assert.equal(derive({ ptyStatus: 'starting', startedAt: started }), 'no_signal');
assert.equal(boardZoneOf('no_signal'), 'needsYou');
assert.equal(derive({ lifecycle: 'starting', startedAt: NOW - 30_000 }), 'idle');
assert.equal(derive({ lifecycle: 'starting', startedAt: started, firstSignalAt: NOW }), 'idle');
assert.equal(derive({ lifecycle: 'starting' }), 'idle');

// 9) 默认 idle
assert.equal(derive({ lifecycle: 'idle', ptyStatus: 'running' }), 'idle');
assert.equal(derive({}), 'idle');
assert.equal(boardZoneOf('idle'), 'working');

// 10) phase 写入粘性：user 最高权威；llm 不得回退 model
assert.equal(phaseWriteBlocked(undefined, { source: 'model' }), false, '无旧值不拦');
assert.equal(phaseWriteBlocked(phase('done', 'user'), { source: 'model' }), true, 'model 不得回退 user done');
assert.equal(phaseWriteBlocked(phase('done', 'user'), { source: 'llm' }), true, 'llm 不得回退 user done');
assert.equal(phaseWriteBlocked(phase('needs_you', 'user'), { source: 'model' }), true, 'user needs_you 同样粘');
assert.equal(phaseWriteBlocked(phase('done', 'user'), { source: 'user' }), false, 'user 写入永不被挡（可自行取消）');
assert.equal(phaseWriteBlocked(phase('done', 'model'), { source: 'llm' }), true, 'llm 不得回退 model done（既有）');
assert.equal(phaseWriteBlocked(phase('done', 'model'), { source: 'model' }), false, 'model 可更新自己的 done');
assert.equal(phaseWriteBlocked(phase('needs_you', 'model'), { source: 'model' }), false, 'model 可推进 needs_you → done');
assert.equal(phaseWriteBlocked(phase('idle', 'user'), { source: 'model' }), false, 'user idle 不粘');
assert.equal(phaseWriteBlocked(phase('done', 'llm'), { source: 'model' }), false, 'model 可回退 llm done');

// 11) 列/图标：归档才灰化；done+exited 与 done+idle 同列完成态
const sess = (over) => ({
  id: 's',
  type: 'terminal',
  name: 'x',
  createdAt: NOW,
  launchKind: 'agent',
  ...over
});
assert.equal(
  sessionDisplayStatus(sess({ lifecycle: 'exited', phase: phase('done') })),
  'done'
);
assert.equal(
  sessionDisplayStatus(sess({ lifecycle: 'idle', phase: phase('done') })),
  'done'
);
assert.equal(
  sessionDisplayStatus(sess({ archived: true, lifecycle: 'exited', phase: phase('done') })),
  'exited',
  '归档态仍灰'
);
assert.equal(sessionBoardColumn(sess({ lifecycle: 'exited', phase: phase('done') })), 'done');
assert.equal(sessionBoardColumn(sess({ lifecycle: 'idle', phase: phase('done') })), 'done');
assert.equal(sessionBoardColumn(sess({ archived: true, phase: phase('done') })), 'archived');
assert.equal(
  sessionBoardColumn(sess({ lifecycle: 'exited', status: 'exited' })),
  'needsYou',
  '未完成的进程退出需要处理，归档必须显式发生'
);

for (const st of [
  'working',
  'idle',
  'blocked',
  'waiting',
  'error',
  'no_signal',
  'done',
  'exited',
  'scheduled'
]) {
  assert.ok(boardZoneOf(st), `boardZoneOf(${st}) 应有值`);
}

console.log('[ok] board-status');
