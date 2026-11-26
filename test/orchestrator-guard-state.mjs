/**
 * 守卫状态持久化（O3 + R-04）：store 往返/损坏容错 + 纯函数（parse/prune/max 合并/key 归属）
 * + 泵集成（重启不重报 / 损坏宁可重报 / lastActivity 落盘 / prune 无主 key）
 * + 会话守卫的重启去重与活动清键。
 * 还原持久化读写、max 合并或 会话活动 的清键接线时以下用例转红。
 * 运行: node test/orchestrator-guard-state.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-guard-state-'));
const compile = createSharedCompiler(root, tmp);

const {
  emptyGuardPersistState,
  parseGuardPersistState,
  pruneGuardPersistState,
  mergeLastActivityOnLoad,
  guardKeyScope
} = await import(pathToFileURL(compile('shared/orchestratorGuards.ts')).href);

// ---------- 纯函数：解析容错 / key 归属 / prune / max 合并 ----------
{
  assert.deepEqual(emptyGuardPersistState(), { fired: {}, lastActivity: {} });

  // 损坏/异形 → 空对象（宁可重报不漏报）
  assert.deepEqual(parseGuardPersistState('corrupt{{{'), emptyGuardPersistState());
  assert.deepEqual(parseGuardPersistState(null), emptyGuardPersistState());
  assert.deepEqual(parseGuardPersistState({ fired: 'nope' }), emptyGuardPersistState());
  assert.deepEqual(parseGuardPersistState({ fired: [], lastActivity: {} }), emptyGuardPersistState());

  // 合法输入：坏条目丢弃、好条目保留
  const parsed = parseGuardPersistState({
    fired: { 'heartbeat_stale:ws:s1': 123, bad: 456 },
    lastActivity: { s1: 100, s2: 'x', s3: -5, s4: 200 }
  });
  assert.deepEqual(parsed, { fired: { 'heartbeat_stale:ws:s1': 123, bad: 456 }, lastActivity: { s1: 100, s4: 200 } });

  // key 归属
  assert.deepEqual(guardKeyScope('heartbeat_stale:ws1:s1'), { workspaceId: 'ws1', sessionId: 's1' });
  assert.deepEqual(guardKeyScope('needs_you_stale:ws1:s1'), { workspaceId: 'ws1', sessionId: 's1' });
  assert.deepEqual(guardKeyScope('slot_free:ws1:-'), { workspaceId: 'ws1', sessionId: undefined });
  assert.deepEqual(guardKeyScope('weird'), {});

  // prune：工作区已删/会话已删的 fired 键、已删会话的 lastActivity 移除
  const pruned = pruneGuardPersistState(
    {
      fired: {
        'heartbeat_stale:ws-dead:s1': 1, // 工作区没了
        'heartbeat_stale:ws1:s-dead': 2, // 会话没了
        'needs_you_stale:ws1:s1': 3, // 健在
        'slot_free:ws1:-': 4 // 工作区级（无会话）：工作区健在即留
      },
      lastActivity: { 's-dead': 5, s1: 6 }
    },
    new Set(['ws1']),
    new Set(['s1'])
  );
  assert.deepEqual(pruned, {
    fired: { 'needs_you_stale:ws1:s1': 3, 'slot_free:ws1:-': 4 },
    lastActivity: { s1: 6 }
  });

  // max 合并：盘上与内存同 key 取大（防回退）
  assert.deepEqual(
    mergeLastActivityOnLoad({ s1: 500, s2: 700 }, new Map([['s1', 900], ['s3', 10]])),
    { s1: 900, s2: 700, s3: 10 }
  );
  console.log('ok: 解析容错 / key 归属 / prune / max 合并');
}

// ---------- store：往返 / 损坏容错 ----------
{
  const { OrchestratorGuardStateStore, ORCHESTRATOR_GUARD_STATE_FILE } = await import(
    pathToFileURL(compile('main/orchestrator/guardStateStore.ts')).href
  );
  const dir = path.join(tmp, 'store');
  fs.mkdirSync(dir, { recursive: true });
  const store = new OrchestratorGuardStateStore(dir);

  // 缺失 → 空对象起步
  assert.deepEqual(store.read(), emptyGuardPersistState());
  assert.equal(fs.existsSync(store.filePath), false);

  // 写 → 读往返
  const state = { fired: { 'heartbeat_stale:ws1:s1': 42 }, lastActivity: { s1: 7 } };
  store.write(state);
  assert.equal(path.basename(store.filePath), ORCHESTRATOR_GUARD_STATE_FILE);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.filePath, 'utf8')), state);
  assert.deepEqual(store.read(), state);

  // 损坏 → 空对象（不抛）
  fs.writeFileSync(store.filePath, 'not json{{{', 'utf8');
  assert.deepEqual(store.read(), emptyGuardPersistState());
  console.log('ok: store 往返 / 损坏容错');
}

// ---------- 泵集成：重启不重报 / 损坏宁可重报 / activity 落盘 / prune ----------
{
  const { OrchestratorEventPump } = await import(
    pathToFileURL(compile('main/orchestrator/events.ts')).href
  );

  const sessions = [
    {
      id: 's-stale',
      name: '停滞 Worker',
      workspaceId: 'ws1',
      type: 'terminal',
      launchKind: 'agent',
      lifecycle: 'working',
      orchestrated: true
    },
    {
      id: 's-fresh',
      name: '活跃 Worker',
      workspaceId: 'ws1',
      type: 'terminal',
      launchKind: 'agent',
      lifecycle: 'working',
      orchestrated: true
    },
    {
      id: 's-ny',
      name: '等人处理的 Worker',
      workspaceId: 'ws1',
      type: 'terminal',
      launchKind: 'agent',
      lifecycle: 'idle',
      orchestrated: true,
      hasAssignedTask: true,
      phase: { value: 'needs_you', ts: 0 }
    }
  ];
  const makeCtx = (list = sessions) => ({
    sessions: {
      get: (id) => list.find((s) => s.id === id),
      list: () => list,
      listByWorkspace: (ws) => list.filter((s) => s.workspaceId === ws)
    },
    config: { get: () => ({ workspaces: [{ id: 'ws1', path: path.join(tmp, 'ws') }] }) }
  });
  const makePump = (ctx, dir) =>
    new OrchestratorEventPump({
      ctx,
      now: () => 31 * 60_000, // 超过心跳 15min 与 needs_you 30min 阈值
      setTimeout: () => 0,
      clearTimeout: () => {},
      enabled: () => true,
      ...(dir ? { guardStateDir: dir } : {})
    });
  const kindOf = (pump, kind) => pump.peek('ws1').filter((e) => e.kind === kind);

  // 心跳告警不得刷新活动；持久化 fired 键直到真实活动恢复。
  {
    const dir = path.join(tmp, 'pump-hb');
    fs.mkdirSync(dir, { recursive: true });
    const p1 = makePump(makeCtx(), dir);
    p1.enqueue({ kind: 'turn_end', workspaceId: 'ws1', sessionId: 's-fresh', ts: 31 * 60_000 });
    p1.tickGuards();
    const hb1 = kindOf(p1, 'heartbeat_stale');
    assert.equal(hb1.length, 1, '停滞 Worker 报一次心跳超时');
    assert.equal(hb1[0].sessionId, 's-stale');
    const saved = parseGuardPersistState(
      fs.readFileSync(path.join(dir, 'orchestrator-guard-state.json'), 'utf8')
    );
    assert.equal(saved.lastActivity['s-stale'], undefined, '告警不能伪造 Worker 活动');
    assert.ok(saved.fired['heartbeat_stale:ws1:s-stale'], '心跳告警保留去重键');
    assert.equal(saved.lastActivity['s-fresh'], 31 * 60_000, '活跃会话活动已落盘');

    // 同进程再 tick：fired 键保留，不重复
    p1.tickGuards();
    assert.equal(kindOf(p1, 'heartbeat_stale').length, 1, '同进程去重');

    // 重启：告警不伪造活动，靠持久 fired 键避免重复
    const p2 = makePump(makeCtx(), dir);
    p2.tickGuards();
    assert.equal(kindOf(p2, 'heartbeat_stale').length, 0, '重启后 fired 读回，不重报');
  }

  // 场景 B（needs_you_stale）：fired 键持久化 → 重启不重报
  {
    const dir = path.join(tmp, 'pump-ny');
    fs.mkdirSync(dir, { recursive: true });
    const p1 = makePump(makeCtx(), dir);
    p1.tickGuards();
    const ny1 = kindOf(p1, 'needs_you_stale');
    assert.equal(ny1.length, 1, 'needs_you 超时报一次');
    const saved = parseGuardPersistState(
      fs.readFileSync(path.join(dir, 'orchestrator-guard-state.json'), 'utf8')
    );
    assert.ok(saved.fired['needs_you_stale:ws1:s-ny'] > 0, 'fired 键已落盘');

    // 同进程再 tick 不重复
    p1.tickGuards();
    assert.equal(kindOf(p1, 'needs_you_stale').length, 1, '同进程去重');

    // 重启（还原 O3 时：fired 清零 → 必重报，此处转红）
    const p2 = makePump(makeCtx(), dir);
    p2.tickGuards();
    assert.equal(kindOf(p2, 'needs_you_stale').length, 0, '重启后 fired 读回，不重报');

    // 损坏状态文件 → 空对象起步，宁可重报
    fs.writeFileSync(path.join(dir, 'orchestrator-guard-state.json'), 'corrupt{', 'utf8');
    const p3 = makePump(makeCtx(), dir);
    p3.tickGuards();
    assert.equal(kindOf(p3, 'needs_you_stale').length, 1, '损坏文件按空状态起步（宁可重报不漏报）');
  }

  // 场景 C（prune）：盘上塞死会话/死工作区的键，重启加载后触发一次落盘即被清
  {
    const dir = path.join(tmp, 'pump-prune');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'orchestrator-guard-state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        fired: { 'heartbeat_stale:ws1:s-dead': 1, 'heartbeat_stale:ws-gone:s1': 2, 'slot_free:ws1:-': 3 },
        lastActivity: { 's-dead': 5, 's-stale': 6 }
      }),
      'utf8'
    );
    const p4 = makePump(makeCtx(), dir);
    p4.tickGuards(); // 触发 ensureGuardStateLoaded + persist
    const saved4 = parseGuardPersistState(fs.readFileSync(file, 'utf8'));
    assert.ok(!saved4.fired['heartbeat_stale:ws1:s-dead'], '死会话的 fired 键被 prune');
    assert.ok(!saved4.fired['heartbeat_stale:ws-gone:s1'], '死工作区的 fired 键被 prune');
    assert.ok(saved4.fired['slot_free:ws1:-'], '工作区级键保留');
    assert.ok(!saved4.lastActivity['s-dead'], '死会话的 lastActivity 被 prune');
    assert.ok(saved4.lastActivity['s-stale'] !== undefined, '活会话的 lastActivity 保留');
  }
  console.log('ok: 泵集成（重启不重报 / 损坏重报 / activity 落盘 / prune）+ R-04 持久化与清键');
}

// ---------- X1-F02 / orchestrator-events F-02：flush 等人门（C2 ask 卡）与失败还原裁剪 ----------
{
  const { OrchestratorEventPump } = await import(
    pathToFileURL(compile('main/orchestrator/events.ts')).href
  );
  const { ORCH_WAKE_DEFAULTS } = await import(
    pathToFileURL(compile('shared/notifyQueue.ts')).href
  );
  const store = await import(pathToFileURL(compile('main/metaAgent/messageStore.ts')).href);
  store.setAgentMessagesUserDataDir(path.join(tmp, 'ud'));
  const ask = { workspaceId: 'ws-f', reason: 'askQuestion', questionId: 'q1', since: 1 };

  // --- X1-F02：C2 内存 ask 卡挂起（C1 持久账无 needs_you）→ 例行 flush hold，不存信 ---
  {
    const sends = [];
    const ctx = {
      sessions: { get: () => undefined, list: () => [], listByWorkspace: () => [], broadcastMessagesChanged() {} },
      config: { get: () => ({ workspaces: [{ id: 'ws-f', path: path.join(tmp, 'ws-f') }] }) },
      workspaces: { list: () => [{ id: 'ws-f', path: path.join(tmp, 'ws-f') }] },
      orchestrator: {
        isBusy: () => false,
        getHumanWait: (id) => (id === 'ws-f' ? ask : null)
      }
    };
    const pump = new OrchestratorEventPump({
      ctx, enabled: () => true, guardsEnabled: () => false,
      setTimeout: () => 0, clearTimeout: () => {}, mergeWindowMs: 0, maxWaitMs: 0
    });
    pump.enqueue({ kind: 'merge_blocked', workspaceId: 'ws-f', extraKey: 'k1', detail: 'x' });
    const result = await pump.flush('ws-f');
    assert.equal(result, 'hold', 'C2 ask 卡挂起（无 C1 needs_you）时例行 flush hold');
    assert.equal(pump.peek('ws-f').length, 1, '队列保留待重试');
    assert.equal(
      store.readAgentMessageLedger(path.join(tmp, 'ws-f'), 'ws-f').messages.length,
      0,
      '等人期间不存事件信'
    );
    void sends;
  }

  // --- F-02：deliver 失败还原队列须过 enqueue 同款裁剪（上限 ORCH_WAKE_DEFAULTS.maxEvents）---
  {
    const ctx = {
      sessions: { get: () => undefined, list: () => [], listByWorkspace: () => [], broadcastMessagesChanged() {} },
      config: { get: () => ({ workspaces: [] }) },
      // workspaces.list() 为空 → deliverAgentMessage 对 orchestrator:ws-f 抛「收信工作区不存在」
      workspaces: { list: () => [] },
      orchestrator: { isBusy: () => false }
    };
    const pump = new OrchestratorEventPump({
      ctx, enabled: () => true, guardsEnabled: () => false,
      setTimeout: () => 0, clearTimeout: () => {}, mergeWindowMs: 0, maxWaitMs: 0
    });
    for (let i = 0; i < ORCH_WAKE_DEFAULTS.maxEvents; i++) {
      pump.enqueue({ kind: 'merge_blocked', workspaceId: 'ws-f', extraKey: `e${i}`, detail: 'x' });
    }
    assert.equal(pump.peek('ws-f').length, ORCH_WAKE_DEFAULTS.maxEvents, 'enqueue 侧本就有上限');
    const flushing = pump.flush('ws-f'); // 不 await：deliver 同步段拒绝后 microtask 才进 catch
    for (let i = 0; i < 5; i++) {
      pump.enqueue({ kind: 'merge_blocked', workspaceId: 'ws-f', extraKey: `late${i}`, detail: 'x' });
    }
    assert.equal(await flushing, 'hold', 'deliver 失败还原后 hold');
    assert.ok(
      pump.peek('ws-f').length <= ORCH_WAKE_DEFAULTS.maxEvents,
      `还原队列不得超上限（现 ${pump.peek('ws-f').length} / 上限 ${ORCH_WAKE_DEFAULTS.maxEvents}）`
    );
    assert.equal(pump.peek('ws-f').length, ORCH_WAKE_DEFAULTS.maxEvents, '还原裁剪保满额最新事件');
    const keys = pump.peek('ws-f').map((e) => e.key);
    assert.ok(keys.includes('merge_blocked:ws-f:-:late4'), '还原后保留 flush 期间新入队事件');
  }
  console.log('ok: flush 等人门（C2）与失败还原裁剪');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] orchestrator-guard-state');
