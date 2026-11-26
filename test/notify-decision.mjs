/**
 * 推送决策纯函数测试：翻转矩阵 / 45s 账本去重 / 免打扰 / 权限矩阵 / 配置归一化。
 * Run: node test/notify-decision.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-decision-'));
const compile = createSharedCompiler(root, tmp);
const {
  decideNotify,
  notifyTriggerOf,
  inDndWindow,
  parseHhmm,
  normalizeNotifyPrefs,
  NOTIFY_DEDUP_WINDOW_MS
} = await import(pathToFileURL(compile('shared/notifyDecision.ts')).href);

const NOW = 1_000_000_000_000;
const tr = (over = {}) => ({
  sessionId: 's1',
  prev: 'idle',
  next: 'waiting',
  source: 'model',
  ...over
});
const decide = (tOver = {}, cOver = {}) => decideNotify(tr(tOver), { now: NOW, ...cOver });

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

// ---------- 触发类映射 ----------
assert.equal(notifyTriggerOf('waiting'), 'needs_you');
assert.equal(notifyTriggerOf('blocked'), 'needs_you');
assert.equal(notifyTriggerOf('done'), 'done');
assert.equal(notifyTriggerOf('error'), 'error');
// working/idle/no_signal/exited/scheduled 不触发（no_signal 属弱推断，不推）
for (const st of ['working', 'idle', 'no_signal', 'exited', 'scheduled']) {
  assert.equal(notifyTriggerOf(st), null, `notifyTriggerOf(${st})`);
}
assert.equal(notifyTriggerOf(null), null);
ok('触发类映射：waiting/blocked→needs_you、done、error；其余与 null 不触发');

// ---------- 翻转矩阵 ----------
{
  const d = decide({ prev: 'idle', next: 'waiting' });
  assert.equal(d.send, true);
  assert.equal(d.trigger, 'needs_you');
  assert.deepEqual(d.channels, { toast: true, mobile: true });
  assert.equal(d.ledgerTs, NOW);
  ok('idle→waiting 触发 needs_you，全通道，账本记 now');
}
assert.equal(decide({ prev: 'working', next: 'blocked', source: 'hook' }).send, true);
ok('working→blocked（hook 源）触发 needs_you');
assert.equal(decide({ prev: 'waiting', next: 'done' }).send, true);
ok('waiting→done 触发 done');
assert.equal(decide({ prev: 'idle', next: 'error', source: 'system' }).send, true);
ok('idle→error 触发 error');
assert.equal(decide({ prev: null, next: 'waiting' }).send, true);
ok('prev=null（首评）允许触发');
// 退出与无关翻转
assert.equal(decide({ prev: 'waiting', next: 'working' }).reason, 'no-trigger');
assert.equal(decide({ prev: 'idle', next: 'working' }).reason, 'no-trigger');
ok('退出触发类 / 无关翻转到 working 不触发');
// 同类重入不算翻转
assert.equal(decide({ prev: 'waiting', next: 'waiting' }).reason, 'no-flip');
assert.equal(decide({ prev: 'waiting', next: 'blocked' }).reason, 'no-flip');
assert.equal(decide({ prev: 'done', next: 'done' }).reason, 'no-flip');
ok('同类重入（waiting→waiting / waiting→blocked / done→done）不重发');
// 源不可信（廉价输出等未经权威通道的值）
assert.equal(decide({ prev: 'idle', next: 'waiting', source: 'cheap' }).reason, 'no-trigger');
for (const src of ['model', 'llm', 'user', 'hook', 'system']) {
  assert.equal(decide({ prev: 'idle', next: 'waiting', source: src }).send, true, `source=${src}`);
}
ok('源可信矩阵：五可信源放行，未知源不触发');

// ---------- 调度会话 needs_you 豁免系统通知 ----------
{
  const orch = decide({ sessionId: 'orchestrator:ws-1', prev: 'idle', next: 'waiting' });
  assert.equal(orch.send, false);
  assert.equal(orch.trigger, 'needs_you');
  assert.equal(orch.reason, 'scheduler');
  assert.deepEqual(orch.channels, { toast: false, mobile: false });
  const worker = decide({ sessionId: 'aaaaaaaa-1111-4222-8333-444444444444', prev: 'idle', next: 'waiting' });
  assert.equal(worker.send, true);
  assert.equal(worker.trigger, 'needs_you');
  assert.equal(worker.channels.toast, true);
  const orchDone = decide({ sessionId: 'orchestrator:ws-1', prev: 'idle', next: 'done' });
  assert.equal(orchDone.send, true, '调度 done 不走 needs_you 豁免');
  ok('调度 orchestrator: 身份 needs_you 不通知；Worker 仍通知');
}

// ---------- 权限矩阵（needs_you 不可关） ----------
{
  const prefs = { done: false, error: false };
  const d = decide({ prev: 'idle', next: 'waiting' }, { prefs });
  assert.equal(d.send, true, 'needs_you 不受 done/error 开关影响');
  const dd = decide({ prev: 'idle', next: 'done' }, { prefs });
  assert.equal(dd.send, false);
  assert.equal(dd.reason, 'pref-off');
  const de = decide({ prev: 'idle', next: 'error' }, { prefs });
  assert.equal(de.reason, 'pref-off');
  // 默认（无偏好）开
  assert.equal(decide({ prev: 'idle', next: 'done' }).send, true);
  assert.equal(decide({ prev: 'idle', next: 'error' }).send, true);
  // 只关一个
  assert.equal(decide({ prev: 'idle', next: 'done' }, { prefs: { done: false } }).reason, 'pref-off');
  assert.equal(decide({ prev: 'idle', next: 'error' }, { prefs: { done: false } }).send, true);
  ok('权限矩阵：needs_you 恒发；done/error 可关、默认开、独立开关');
}

// ---------- 45s 账本去重 ----------
{
  const base = { prev: 'idle', next: 'waiting' };
  assert.equal(decide(base, { lastSentAt: NOW - (NOTIFY_DEDUP_WINDOW_MS - 1_000) }).reason, 'dedup');
  assert.equal(decide(base, { lastSentAt: NOW - (NOTIFY_DEDUP_WINDOW_MS + 1_000) }).send, true, '窗口外重发');
  // 窗口整点（45s）按 < 判定：恰好 45s 已出窗
  assert.equal(decide(base, { lastSentAt: NOW - NOTIFY_DEDUP_WINDOW_MS }).send, true);
  const deduped = decide(base, { lastSentAt: NOW - 1_000 });
  assert.equal(deduped.send, false);
  assert.equal(deduped.ledgerTs, undefined, '被拦截不续窗');
  assert.equal(decide(base, {}).send, true, '无账本记录直接发');
  ok('账本去重：45s 内 dedup 不续窗；≥45s 或无记录放行');
}

// ---------- 免打扰 ----------
const at = (h, min = 0) => new Date(2026, 8, 15, h, min).getTime();
{
  const dnd = { start: '22:00', end: '08:00' };
  // done/error 在免打扰内被拦；needs_you 免疫
  const dd = decide({ prev: 'idle', next: 'done' }, { prefs: { dnd }, now: at(23, 30) });
  assert.equal(dd.reason, 'dnd');
  const de = decide({ prev: 'idle', next: 'error' }, { prefs: { dnd }, now: at(23, 30) });
  assert.equal(de.reason, 'dnd');
  const dn = decide({ prev: 'idle', next: 'waiting' }, { prefs: { dnd }, now: at(23, 30) });
  assert.equal(dn.send, true, 'needs_you 免打扰照推');
  // 窗口外放行
  assert.equal(decide({ prev: 'idle', next: 'done' }, { prefs: { dnd }, now: at(12) }).send, true);
  // 边界：含 start、不含 end（跨零点两侧）
  assert.equal(inDndWindow(dnd, new Date(at(22, 0))), true);
  assert.equal(inDndWindow(dnd, new Date(at(8, 0))), false);
  assert.equal(inDndWindow(dnd, new Date(at(7, 59))), true);
  ok('免打扰（跨零点）：拦 done/error、needs_you 免疫；含头不含尾');
}
{
  // 同日窗口
  const dnd = { start: '12:00', end: '14:00' };
  assert.equal(inDndWindow(dnd, new Date(at(13))), true);
  assert.equal(inDndWindow(dnd, new Date(at(14))), false);
  assert.equal(inDndWindow(dnd, new Date(at(11, 59))), false);
  // start===end 与非法值视为无效窗口
  assert.equal(inDndWindow({ start: '09:00', end: '09:00' }, new Date(at(9, 30))), false);
  assert.equal(inDndWindow({ start: '25:00', end: '08:00' }, new Date(at(23))), false);
  assert.equal(inDndWindow(null, new Date(at(23))), false);
  ok('免打扰（同日窗口 / 无效窗口判定）');
}

// ---------- HH:mm 解析 ----------
assert.equal(parseHhmm('22:30'), 22 * 60 + 30);
assert.equal(parseHhmm('7:05'), 7 * 60 + 5);
assert.equal(parseHhmm('24:00'), null);
assert.equal(parseHhmm('12:60'), null);
assert.equal(parseHhmm('abc'), null);
assert.equal(parseHhmm(12), null);
ok('parseHhmm');

// ---------- 配置归一化 ----------
{
  assert.deepEqual(normalizeNotifyPrefs(undefined), {});
  assert.deepEqual(normalizeNotifyPrefs('x'), {});
  assert.deepEqual(normalizeNotifyPrefs([1]), {});
  const p = normalizeNotifyPrefs({ done: false, error: 'yes', dnd: { start: '22:00', end: '08:00' } });
  assert.deepEqual(p, { done: false, dnd: { start: '22:00', end: '08:00' } });
  const bad = normalizeNotifyPrefs({ done: true, dnd: { start: '22:00', end: '22:00' } });
  assert.deepEqual(bad, { done: true }, '相等窗口被丢弃');
  assert.deepEqual(normalizeNotifyPrefs({ dnd: { start: '99:00', end: '08:00' } }), {});
  ok('normalizeNotifyPrefs：未知/非法字段丢弃，合法偏好透传');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nnotify-decision: ${passed} 组断言全绿`);
