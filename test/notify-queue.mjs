/**
 * R1 事件队列：合并窗口去重/聚合/忙时排队不丢/无事件不唤醒。
 * 运行: node test/notify-queue.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-queue-'));
const compile = createSharedCompiler(root, tmp);

const {
  ORCH_WAKE_DEFAULTS,
  enqueueOrchEvent,
  nextOrchFlushDelay,
  aggregateOrchEvents,
  decideOrchFlush,
  orchEventKey,
  clipOrchDetail,
  isOrchEventKind,
  isGitReflogRel,
  formatReflogLine,
  shouldUplinkOrchEvent,
} = await import(pathToFileURL(compile('shared/notifyQueue.ts')).href);

assert.equal(ORCH_WAKE_DEFAULTS.enabled, true);
assert.equal(ORCH_WAKE_DEFAULTS.mergeWindowMs, 25_000);
assert.ok(ORCH_WAKE_DEFAULTS.mergeWindowMs >= 20_000);
assert.ok(ORCH_WAKE_DEFAULTS.mergeWindowMs <= 30_000);
assert.equal(isOrchEventKind('phase'), true);
assert.equal(isOrchEventKind('turn_error'), true);
assert.equal(isOrchEventKind('inject_queued'), false);
assert.equal(isOrchEventKind('inject_drained'), false);
assert.equal(isOrchEventKind('task_flip'), false);
assert.equal(isOrchEventKind('needs_review_stale'), false, 'R-04 守卫 kind 注册');
assert.equal(isOrchEventKind('settle_warn'), true, 'R-09/R-19 收口提醒 kind 注册');
assert.equal(isOrchEventKind('poll'), false);
assert.equal(clipOrchDetail('  x  '), 'x');
assert.equal(shouldUplinkOrchEvent('phase', { phaseTrigger: 'needs_you' }), true);
assert.equal(shouldUplinkOrchEvent('phase', { phaseTrigger: 'error' }), true);
assert.equal(shouldUplinkOrchEvent('phase', { phaseTrigger: 'done' }), false, 'phase→done 不实时推');
assert.equal(shouldUplinkOrchEvent('phase'), false);
assert.equal(shouldUplinkOrchEvent('merge_blocked'), true);
assert.equal(shouldUplinkOrchEvent('heartbeat_stale'), true);
assert.equal(shouldUplinkOrchEvent('needs_you_stale'), true);
assert.equal(shouldUplinkOrchEvent('settle_warn'), true, 'R-09/R-19 收口提醒实时上行');
assert.equal(shouldUplinkOrchEvent('slot_free'), true);
assert.equal(shouldUplinkOrchEvent('turn_error'), true);
assert.equal(isOrchEventKind('request_integrate'), false, '死 kind 已删，合入走即时通道');
assert.equal(shouldUplinkOrchEvent('commit'), false, '提交落树不实时推');
assert.equal(shouldUplinkOrchEvent('turn_end'), false, '回合结束不实时推');
console.log('ok: defaults / kind / 实时上行分级');

const ev = (over) => ({
  id: over.id ?? '1',
  kind: over.kind ?? 'phase',
  workspaceId: 'ws',
  ts: over.ts ?? 1000,
  key: over.key ?? orchEventKey('phase', 'ws', 's1', 'needs_you'),
  sessionId: 's1',
  sessionName: 'W',
  detail: over.detail ?? 'phase → needs_you'
});

let r = enqueueOrchEvent([], ev({ id: 'a' }));
assert.equal(r.added, true);
assert.equal(r.replaced, false);
assert.equal(r.queue.length, 1);

r = enqueueOrchEvent(r.queue, ev({ id: 'b', ts: 2000, detail: 'phase → needs_you again' }));
assert.equal(r.added, false);
assert.equal(r.replaced, true);
assert.equal(r.queue.length, 1);
assert.equal(r.queue[0].id, 'a');
assert.equal(r.queue[0].ts, 2000);
assert.match(r.queue[0].detail, /again/);
console.log('ok: 同键去重覆盖');

r = enqueueOrchEvent(r.queue, ev({
  id: 'c',
  kind: 'turn_end',
  key: orchEventKey('turn_end', 'ws', 's1'),
  ts: 2100,
  detail: '回合结束'
}));
assert.equal(r.queue.length, 2);

r = enqueueOrchEvent(r.queue, ev({
  id: 'd',
  kind: 'slot_free',
  key: orchEventKey('slot_free', 'ws'),
  ts: 2200,
  detail: '可补位'
}));
assert.equal(r.queue.length, 3);

const text = aggregateOrchEvents(r.queue);
assert.match(text, /【编排事件 · 3 条】/);
assert.match(text, /相位/);
assert.match(text, /回合结束/);
assert.match(text, /可补位/);
assert.equal(aggregateOrchEvents([]), '');
console.log('ok: 聚合文案');

const empty = nextOrchFlushDelay({ now: 0, firstAt: null, lastAt: null });
assert.equal(empty.delayMs, null);
assert.equal(empty.reason, 'empty');

const mid = nextOrchFlushDelay({ now: 10_000, firstAt: 0, lastAt: 0, windowMs: 25_000, maxWaitMs: 45_000 });
assert.equal(mid.delayMs, 15_000);
assert.equal(mid.reason, 'window');

const due = nextOrchFlushDelay({ now: 25_000, firstAt: 0, lastAt: 0, windowMs: 25_000, maxWaitMs: 45_000 });
assert.equal(due.delayMs, 0);
assert.equal(due.reason, 'due');

const cap = nextOrchFlushDelay({
  now: 40_000,
  firstAt: 0,
  lastAt: 39_000,
  windowMs: 25_000,
  maxWaitMs: 45_000
});
assert.equal(cap.delayMs, 5_000);
assert.equal(cap.reason, 'max-wait');
console.log('ok: 合并窗口 / 最长等待');

assert.deepEqual(decideOrchFlush({ enabled: false, busy: false, events: r.queue }), {
  action: 'skip',
  reason: 'disabled'
});
assert.deepEqual(decideOrchFlush({ enabled: true, busy: false, events: [] }), {
  action: 'skip',
  reason: 'empty'
});
const hold = decideOrchFlush({ enabled: true, busy: true, events: r.queue });
assert.equal(hold.action, 'hold');
assert.equal(hold.reason, 'busy');
assert.equal(hold.retryMs, 2_000);

const send = decideOrchFlush({ enabled: true, busy: false, events: r.queue });
assert.equal(send.action, 'send');
assert.match(send.text, /编排事件/);
console.log('ok: 忙时 hold / 空闲 send / 无事件 skip');

// ---------- 调度有待答提问卡时保留归并队列，稍后重试 ----------
const gateHold = decideOrchFlush({
  enabled: true,
  busy: false,
  schedulerAwaitingAnswer: true,
  events: r.queue
});
assert.equal(gateHold.action, 'hold');
assert.equal(gateHold.reason, 'scheduler-awaiting-answer');
assert.equal(gateHold.retryMs, 2_000);
// 调度不等人 → 正常 send
assert.equal(
  decideOrchFlush({ enabled: true, busy: false, schedulerAwaitingAnswer: false, events: r.queue }).action,
  'send'
);
// busy 优先级更高（reason=busy；两者同为 hold，不叠加等待）
assert.equal(
  decideOrchFlush({ enabled: true, busy: true, schedulerAwaitingAnswer: true, events: r.queue }).reason,
  'busy'
);
// 空队列和关闭唤醒仍先 skip
assert.equal(
  decideOrchFlush({ enabled: true, busy: false, schedulerAwaitingAnswer: true, events: [] }).action,
  'skip'
);
assert.equal(
  decideOrchFlush({ enabled: false, busy: false, schedulerAwaitingAnswer: true, events: r.queue }).action,
  'skip'
);
console.log('ok: 待答提问卡暂缓 flush，保留队列');

let q = [];
for (let i = 0; i < 45; i++) {
  q = enqueueOrchEvent(
    q,
    ev({
      id: `n${i}`,
      key: orchEventKey('turn_end', 'ws', `s${i}`),
      ts: i
    }),
    40
  ).queue;
}
assert.equal(q.length, 40);
assert.equal(q[0].key, orchEventKey('turn_end', 'ws', 's5'));
console.log('ok: 队列上限丢最旧');

assert.equal(isGitReflogRel('.git/logs/HEAD'), true);
assert.equal(isGitReflogRel('.git/worktrees/foo/logs/HEAD'), true);
assert.equal(isGitReflogRel('src/a.ts'), false);
console.log('ok: git reflog 路径');

// formatReflogLine：事件摘要携带 action+短 hash+subject（此前只有干巴巴的「reflog 更新」）
{
  const line =
    '0123456789abcdef0123456789abcdef01234567 fedcba9876543210fedcba9876543210fedcba98 Demo Author <author@example.invalid> 1700000000 +0000\tcommit: fix(ui): adjust workspace badge';
  const out = formatReflogLine(line);
  assert.ok(out);
  assert.ok(out.startsWith('commit: fix(ui):'));
  assert.ok(out.endsWith('(fedcba9)'));
}
assert.equal(formatReflogLine(''), null);
assert.equal(formatReflogLine('not a reflog line'), null);
assert.equal(
  formatReflogLine('0000000 fedcba9 w 1 +0800\t'),
  'ref fedcba9'
);
console.log('ok: reflog 行解析为事件摘要');

console.log('notify-queue: all ok');
