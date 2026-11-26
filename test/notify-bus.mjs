/**
 * 通知总线自测：决策→账本→桌面 toast 分发→订阅者事件 的装配行为。
 * NotifyStore 用假实现（只录 push 调用），UiBridge/electron 不参与。
 * Run: node test/notify-bus.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-bus-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/notify/bus.ts');
const { NotifyBus } = await import(pathToFileURL(outFile).href);

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

const NOW = 1_000_000_000_000;

/** 假 NotifyStore：只录 push 入参 */
function fakeStore() {
  const pushes = [];
  return { pushes, push: (input) => (pushes.push({ ...input }), { id: 'n' + pushes.length }) };
}

const session = { id: 's1', name: '推送总线自测', hidden: false };
const report = (bus, over = {}) =>
  bus.report({ session, workspaceId: 'ws1', prev: 'idle', next: 'waiting', source: 'model', ...over });

{
  // 翻转 → 决策通过：toast push（phase:<id> 同键）+ 订阅者事件
  const store = fakeStore();
  let prefs = {};
  const bus = new NotifyBus(store, () => prefs);
  const events = [];
  bus.on((e) => events.push(e));

  const d = report(bus, { now: NOW });
  assert.equal(d.send, true);
  assert.equal(d.trigger, 'needs_you');
  assert.equal(store.pushes.length, 1);
  assert.equal(store.pushes[0].updateKey, 'phase:s1');
  assert.equal(store.pushes[0].toast, true);
  assert.ok(store.pushes[0].text.includes('推送总线自测'));
  assert.equal(events.length, 1);
  assert.equal(events[0].trigger, 'needs_you');
  assert.equal(events[0].sessionId, 's1');
  ok('翻转通过：桌面 toast 入队（同键原地更新）+ 订阅者收到事件');

  // 45s 内同类再翻转（如 working→waiting 抖动回来）：账本去重，不重弹不发事件
  const d2 = report(bus, { now: NOW + 10_000, prev: 'working' });
  assert.equal(d2.reason, 'dedup');
  assert.equal(store.pushes.length, 1, '不重复 push');
  assert.equal(events.length, 1, '不重复发事件');
  ok('45s 账本去重：不重复 toast、不重复发事件');

  // 窗口过后同类翻转：放行
  const d3 = report(bus, { now: NOW + 46_000, prev: 'working' });
  assert.equal(d3.send, true);
  assert.equal(store.pushes.length, 2);
  assert.equal(events.length, 2);
  ok('窗口外同类翻转重新放行');

  // clearSession 清账本后立即放行
  bus.clearSession('s1');
  const d4 = report(bus, { now: NOW + 47_000, prev: 'working' });
  assert.equal(d4.send, true);
  ok('clearSession 清账本');
}

{
  // 偏好：done 被关 → 不 push 不发事件
  const store = fakeStore();
  const bus = new NotifyBus(store, () => ({ done: false }));
  const events = [];
  bus.on((e) => events.push(e));
  const d = report(bus, { next: 'done', now: NOW });
  assert.equal(d.reason, 'pref-off');
  assert.equal(store.pushes.length, 0);
  assert.equal(events.length, 0);
  ok('偏好拦截：不 push、不发事件');
}

{
  // 隐藏会话（模板/临时会话）不推
  const store = fakeStore();
  const bus = new NotifyBus(store, () => ({}));
  const d = bus.report({
    session: { id: 's2', name: 'hidden', hidden: true },
    workspaceId: 'ws1',
    prev: 'idle',
    next: 'waiting',
    source: 'model',
    now: NOW
  });
  assert.equal(d.reason, 'hidden');
  assert.equal(store.pushes.length, 0);
  ok('隐藏会话不推');
}

{
  // 调度会话 needs_you：不弹桌面 toast、不发订阅事件；Worker 对照仍通知
  const store = fakeStore();
  const bus = new NotifyBus(store, () => ({}));
  const events = [];
  const flips = [];
  bus.on((e) => events.push(e));
  bus.onFlip((e) => flips.push(e));
  const d = bus.report({
    session: { id: 'orchestrator:ws-1', name: '调度', hidden: false },
    workspaceId: 'ws-1',
    prev: 'idle',
    next: 'waiting',
    source: 'model',
    now: NOW
  });
  assert.equal(d.send, false);
  assert.equal(d.reason, 'scheduler');
  assert.equal(store.pushes.length, 0, '调度 needs_you 不入桌面 toast');
  assert.equal(events.length, 0);
  assert.equal(flips.length, 0, '调度 needs_you 不进 phase 触发流');

  const worker = bus.report({
    session: { id: 's-worker', name: '改码', hidden: false },
    workspaceId: 'ws-1',
    prev: 'idle',
    next: 'waiting',
    source: 'model',
    now: NOW
  });
  assert.equal(worker.send, true);
  assert.equal(store.pushes.length, 1);
  assert.equal(store.pushes[0].toast, true);
  assert.equal(store.pushes[0].updateKey, 'phase:s-worker');
  assert.equal(events.length, 1);
  ok('调度 needs_you 不通知；Worker needs_you 仍桌面 toast');
}

{
  // 非触发翻转（working↔idle）不进任何通道
  const store = fakeStore();
  const bus = new NotifyBus(store, () => ({}));
  const d = report(bus, { prev: 'idle', next: 'working', now: NOW });
  assert.equal(d.reason, 'no-trigger');
  assert.equal(store.pushes.length, 0);
  ok('非触发翻转静默');
}

{
  // 订阅者抛错不炸总线（best-effort），toast 已照常发出
  const store = fakeStore();
  const bus = new NotifyBus(store, () => ({}));
  bus.on(() => {
    throw new Error('listener boom');
  });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a);
  try {
    const d = report(bus, { now: NOW });
    console.error = origErr;
    assert.equal(d.send, true);
    assert.equal(store.pushes.length, 1);
    assert.ok(errs.length >= 1, 'listener 异常被捕获并记日志');
  } finally {
    console.error = origErr;
  }
  ok('订阅者异常隔离');
}

console.log(`\nnotify-bus: ${passed} 组断言全绿`);
