/**
 * 编排事件降噪（R1）·相位翻转：onFlip 与 R3 守卫快照的「编排关联性」过滤。
 *
 * 用户手工会话（无 orchestrated 标记）的 needs_you/done/error 不得入队唤醒调度——
 * 它的状态由通知系统（toast/手机/飞书）推给人，调度没有该会话的简报上下文，管不了
 * 也不该被吵醒。守卫同理：手工会话不进心跳/needs_you 超时监控。与 orchestrator-turn-end.mjs
 * 守的是同一条「别把调度吵醒」防线的另外两个口。
 *
 * 运行: node test/orchestrator-phase-flip.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-phase-flip-'));
const compile = createSharedCompiler(root, tmp);

const { OrchestratorEventPump } = await import(
  pathToFileURL(compile('main/orchestrator/events.ts')).href
);

/** 造一个只提供 sessions.get/listByWorkspace / config.get 的最小 ctx */
function makeCtx(sessions, workspaces = []) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return {
    sessions: {
      get: (id) => byId.get(id),
      listByWorkspace: (ws) => sessions.filter((s) => s.workspaceId === ws)
    },
    config: { get: () => ({ workspaces }) }
  };
}

function makePump(ctx, nowFn = () => 1_000) {
  return new OrchestratorEventPump({
    ctx,
    now: nowFn,
    // 不起真定时器：flush 调度与本用例无关，真定时器还会吊住进程
    setTimeout: () => 0,
    clearTimeout: () => {},
    enabled: () => true
  });
}

function flipOf(sessionId, sessionName, workspaceId, trigger, ts) {
  return { sessionId, sessionName, workspaceId, next: 'needs_you', source: 'board', trigger, ts };
}

// ---------- 1) onFlip：手工会话的相位翻转不入队 ----------
{
  const ctx = makeCtx([
    { id: 's-manual', name: '用户手工开的', workspaceId: 'ws1' },
    { id: 's-off', name: '已放出', workspaceId: 'ws1', orchestrated: false },
    { id: 's-hidden', name: '隐藏的', workspaceId: 'ws1', orchestrated: true, hidden: true }
  ]);
  const pump = makePump(ctx);

  pump.onFlip(flipOf('s-manual', '用户手工开的', 'ws1', 'needs_you', 1_000));
  pump.onFlip(flipOf('s-off', '已放出', 'ws1', 'done', 1_100));
  pump.onFlip(flipOf('s-hidden', '隐藏的', 'ws1', 'needs_you', 1_200));
  // 会话已删除/未知：flip 还在飞，但查无此会话——没有简报上下文可言，不报
  pump.onFlip(flipOf('s-gone', '已删除的', 'ws1', 'error', 1_300));

  assert.deepEqual(pump.peek('ws1'), [], '手工/已放出/隐藏/已删会话的相位翻转均不得入队');
  console.log('ok: onFlip 手工会话相位翻转不入队');
}

// ---------- 2) onFlip：编排会话（调度拉起/收编）照常上报 ----------
{
  const ctx = makeCtx([{ id: 's-orch', name: '调度拉起的', workspaceId: 'ws1', orchestrated: true }]);
  const pump = makePump(ctx);

  pump.onFlip(flipOf('s-orch', '调度拉起的', 'ws1', 'needs_you', 1_000));
  const q = pump.peek('ws1');
  assert.equal(q.length, 1, '编排会话必须上报相位');
  assert.equal(q[0].kind, 'phase');
  assert.equal(q[0].sessionId, 's-orch');
  assert.equal(q[0].detail, 'phase → needs_you');
  console.log('ok: onFlip 编排会话照常上报');
}

// ---------- 2b) phase→done 不入队；phase→error 仍入队 ----------
{
  const ctx = makeCtx([{ id: 's-orch', name: '调度拉起的', workspaceId: 'ws1', orchestrated: true }]);
  const pump = makePump(ctx);

  pump.onFlip(flipOf('s-orch', '调度拉起的', 'ws1', 'done', 1_000));
  assert.deepEqual(pump.peek('ws1'), [], '正常 phase→done 是回放，不实时推');

  pump.onFlip(flipOf('s-orch', '调度拉起的', 'ws1', 'error', 1_100));
  const q = pump.peek('ws1');
  assert.equal(q.length, 1);
  assert.equal(q[0].kind, 'phase');
  assert.equal(q[0].detail, 'phase → error');
  console.log('ok: onFlip done 降级 / error 仍实时');
}

// ---------- 3) 守卫集成：手工会话 working 停滞不报心跳，同区被派活的照报 ----------
{
  const wsDir = path.join(tmp, 'ws-hb');
  fs.mkdirSync(wsDir, { recursive: true });
  const ctx = makeCtx(
    [
      {
        id: 's-m',
        name: '手工开的',
        workspaceId: 'wshb',
        type: 'terminal',
        launchKind: 'agent',
        lifecycle: 'working'
      },
      {
        id: 's-w',
        name: '调度拉起的',
        workspaceId: 'wshb',
        type: 'terminal',
        launchKind: 'agent',
        lifecycle: 'working',
        orchestrated: true
      }
    ],
    [{ id: 'wshb', path: wsDir }]
  );
  const pump = makePump(ctx, () => 16 * 60_000); // 无活动超过心跳阈值 15min
  pump.tickGuards();
  const q = pump.peek('wshb');
  assert.equal(q.length, 1, '只有编排会话报心跳停滞');
  assert.equal(q[0].kind, 'heartbeat_stale');
  assert.equal(q[0].sessionId, 's-w');
  console.log('ok: 守卫心跳只盯被派活会话');
}

// ---------- 4) 守卫集成：needs_you 停滞同口径 ----------
{
  const wsDir = path.join(tmp, 'ws-ny');
  fs.mkdirSync(wsDir, { recursive: true });
  const ctx = makeCtx(
    [
      {
        id: 's-m',
        name: '手工开的',
        workspaceId: 'wsny',
        type: 'terminal',
        launchKind: 'agent',
        lifecycle: 'idle',
        phase: { value: 'needs_you' }
      },
      {
        id: 's-w',
        name: '调度拉起的',
        workspaceId: 'wsny',
        type: 'terminal',
        launchKind: 'agent',
        lifecycle: 'idle',
        phase: { value: 'needs_you' },
        orchestrated: true
      }
    ],
    [{ id: 'wsny', path: wsDir }]
  );
  let t = 1_000;
  const pump = makePump(ctx, () => t);
  pump.onFlip(flipOf('s-w', '调度拉起的', 'wsny', 'needs_you', t)); // 计时起点
  pump.onFlip(flipOf('s-m', '手工开的', 'wsny', 'needs_you', t)); // 被门禁拦下，不追计时
  t += 31 * 60_000; // 超过 needs_you 阈值 30min
  pump.tickGuards();
  const q = pump.peek('wsny');
  assert.equal(
    q.filter((e) => e.sessionId === 's-m').length,
    0,
    '手工会话不得产生任何编排事件（相位/超时都不行）'
  );
  assert.equal(
    q.filter((e) => e.kind === 'needs_you_stale').length,
    1,
    'needs_you 超时只对编排会话报'
  );
  assert.equal(q.find((e) => e.kind === 'needs_you_stale').sessionId, 's-w');
  console.log('ok: needs_you 超时只盯被派活会话');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('orchestrator-phase-flip: all ok');
