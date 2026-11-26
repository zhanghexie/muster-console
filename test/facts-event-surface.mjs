/**
 * 事件面收敛回归（2026-10-25 设计变更）：邮箱提醒与事件系统解耦。
 * 1) session.activity / session.lifecycle 常规翻转不再向订阅方投递（防回声窗 noticeScope 已废除）；
 * 2) session.phase（needs_you）与 pipeline.verdict（停滞）照常投递；
 * 3) 查询面（projectSessionFacts / 落盘事实）不受影响；
 * 4) 落盘订阅里显式订了已收敛 kind 的，加载时按 tasks.state 同款清理模式清掉；
 * 5) 全仓无 noticeScope 模块引用残留。
 * 运行: node test/facts-event-surface.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'facts-event-surface-'));
const compile = createSharedCompiler(root, tmp);
const load = (p) => import(pathToFileURL(compile(p)).href);
try {
  const { awarenessHost } = await load('main/capabilities/hosts/awareness.ts');
  const { dispatchRuntimeFacts } = await load('main/awareness/dispatch.ts');
  const { RuntimeAwarenessStore } = await load('main/awareness/store.ts');
  const { setAgentMessagesUserDataDir, readAgentMessageLedger } = await load('main/metaAgent/messageStore.ts');
  const { SUBSCRIBE_SUPPRESSED_KINDS, isSuppressedFactKind } = await load('shared/runtimeFactsSubscribe.ts');
  const { projectSessionFacts } = await load('shared/runtimeFactsQuery.ts');
  setAgentMessagesUserDataDir(path.join(tmp, 'user'));

  const workers = [
    { id: 'a', name: 'A', workspaceId: 'w', lifecycle: 'idle', type: 'terminal', archived: false },
    { id: 'b', name: 'B', workspaceId: 'w', lifecycle: 'working', type: 'terminal', archived: false }
  ];
  const awareness = new RuntimeAwarenessStore(path.join(tmp, 'awareness'));
  const ctx = {
    awareness,
    sessions: {
      list: () => workers,
      get: (id) => workers.find((s) => s.id === id),
      broadcastMessagesChanged() {},
      isChatRuntime: () => true
    },
    agentSessions: { isBusy: () => true },
    workspaces: { list: () => [{ id: 'w', path: tmp }] },
    resolveBubbleWorkspaceId: () => 'w'
  };
  const mails = () => readAgentMessageLedger(tmp, 'w').messages;
  const emit = (id, kind, sessionId = 'b') => ({
    id, kind, sessionId, workspaceId: 'w', ts: Date.now(),
    summary: kind === 'session.phase' ? 'phase=needs_you' : kind,
    data: kind === 'session.phase' ? { value: 'needs_you' } : kind === 'session.lifecycle' ? { lifecycle: 'idle' } : {},
    source: 'event'
  });
  const dispatch = (facts) => dispatchRuntimeFacts(ctx, facts, { debounceMs: 0, hourlyLimit: 1000 });

  // 收敛面定义本身
  assert.deepEqual([...SUBSCRIBE_SUPPRESSED_KINDS].sort(), ['session.activity', 'session.lifecycle']);
  assert.equal(isSuppressedFactKind('session.activity'), true);
  assert.equal(isSuppressedFactKind('session.lifecycle'), true);
  assert.equal(isSuppressedFactKind('session.phase'), false);
  assert.equal(isSuppressedFactKind('pipeline.verdict'), false);

  // 订阅方挂通配 + 显式 lifecycle/activity 订阅：通配代表「订一切」的旧习惯，
  // 显式代表落盘旧订阅——两类都不应再收到常规翻转事件
  awarenessHost['events.subscribe'](ctx, { __actorSessionId: 'a' });
  awarenessHost['events.subscribe'](ctx, { __actorSessionId: 'a', kinds: ['session.lifecycle'] });
  awarenessHost['events.subscribe'](ctx, { __actorSessionId: 'a', kinds: ['session.activity'] });

  assert.equal((await dispatch([emit('act-1', 'session.activity')])).delivered, 0, 'activity 翻转不投递');
  assert.equal((await dispatch([emit('act-2', 'session.activity', 'a')])).delivered, 0, '自身 activity 同样不投递');
  assert.equal((await dispatch([emit('life-1', 'session.lifecycle')])).delivered, 0, 'lifecycle 翻转不投递');
  const exitFact = emit('life-2', 'session.lifecycle');
  exitFact.data = { lifecycle: 'exited' };
  assert.equal((await dispatch([exitFact])).delivered, 0, 'exited 翻转同样不投递');
  assert.equal(mails().length, 0, '常规翻转未保存任何事件邮件');

  // 有意义事件照常投递
  const phase = await dispatch([emit('phase-1', 'session.phase')]);
  assert.equal(phase.delivered, 1, 'needs_you 照常投递');
  assert.ok(mails().some((m) => m.to === 'a'), 'phase 事件邮件已落信箱');
  const verdict = {
    id: 'verdict-1', kind: 'pipeline.verdict', sessionId: 'b', workspaceId: 'w', ts: Date.now(),
    summary: 'verdict=stalled', data: { value: 'stalled' }, source: 'event'
  };
  assert.equal((await dispatch([verdict])).delivered, 1, '停滞照常投递');
  assert.equal(mails().filter((m) => m.to === 'a').length, 2, '仅两类有意义事件入信箱');

  // 查询面不动：投影仍产出完整状态流（activity/lifecycle 事实照常生成、照常落账本）
  const projected = projectSessionFacts({
    id: 'b', name: 'B', workspaceId: 'w',
    phase: { value: 'needs_you', ts: 1 },
    activity: { kind: 'idle', event: 'turn-end', ts: 1 },
    lifecycle: 'idle'
  });
  const kinds = new Set(projected.map((f) => f.kind));
  assert.ok(kinds.has('session.activity') && kinds.has('session.lifecycle'), '查询面仍产出 activity/lifecycle 事实');
  awareness.recordFact(emit('life-recorded', 'session.lifecycle'));
  assert.ok(awareness.listFacts().some((f) => f.id === 'life-recorded'), '事实账本照常记录（按需可查）');

  // 落盘订阅清理：显式订了已收敛 kind 的订阅，重载时按 tasks.state 同款模式清掉
  {
    const dir = fs.mkdtempSync(path.join(tmp, 'store-'));
    const first = new RuntimeAwarenessStore(dir);
    first.addSubscription({ subscriberSessionId: 'a', query: { kinds: ['session.lifecycle'], workspaceId: 'w' } });
    first.addSubscription({ subscriberSessionId: 'a', query: { kinds: ['session.activity', 'session.phase'], workspaceId: 'w' } });
    first.addSubscription({ subscriberSessionId: 'a', query: { kinds: ['pipeline.verdict'], workspaceId: 'w' } });
    const again = new RuntimeAwarenessStore(dir);
    const kept = again.listSubscriptions('a');
    assert.equal(kept.length, 1, '含已收敛 kind 的落盘订阅加载时清理');
    assert.deepEqual(kept[0].query.kinds, ['pipeline.verdict']);
  }

  // noticeScope 无残留：源代码不存在该模块，也没有任何 import 指向它
  assert.equal(fs.existsSync(path.join(root, 'src/main/messages/noticeScope.ts')), false, 'noticeScope.ts 已删除');
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') scan(p); }
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        assert.ok(!/from\s+['"][^'"]*noticeScope['"]/.test(fs.readFileSync(p, 'utf8')), 'noticeScope import 残留: ' + p);
      }
    }
  };
  scan(path.join(root, 'src'));
  scan(path.join(root, 'test'));

  console.log('facts-event-surface: OK (activity/lifecycle 不投递, phase/verdict 照常, 查询面不动, 落盘订阅清理, 无 noticeScope 残留)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
