/**
 * 运行时状态流：内置字段可查询 + 状态共享（写入上限 / 只写自己 / 关闭即删）。
 * 运行: node test/runtime-awareness.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-awareness-'));
const compile = createSharedCompiler(root, tmp);

const {
  SHARE_TEXT_MAX,
  normalizeShareText,
  resolveShareWriter,
  resolveAwarenessActorId,
  orchestratorSessionId,
  isOrchestratorSessionId,
  parseOrchestratorWorkspaceId,
  listAliveAwarenessSessionIds,
  normalizeFactQuery,
  queryFacts,
  matchFact,
  evictFactEvents,
  FACT_EVENT_MAX_COUNT,
  FACT_EVENT_MAX_BYTES,
  isRuntimeFactKind,
  RUNTIME_FACT_KINDS
} = await import(pathToFileURL(compile('shared/runtimeFacts.ts')).href);

const { projectSessionFacts, projectIntegrateFact } = await import(
  pathToFileURL(compile('shared/runtimeFactsQuery.ts')).href
);

const { RuntimeAwarenessStore } = await import(pathToFileURL(compile('main/awareness/store.ts')).href);

// ---------------------------------------------------------------------------
// 写入上限
// ---------------------------------------------------------------------------
{
  assert.equal(SHARE_TEXT_MAX, 500);
  assert.equal(normalizeShareText('ok').ok, true);
  assert.equal(normalizeShareText('').ok, true);
  assert.equal(normalizeShareText('x'.repeat(500)).ok, true);
  const over = normalizeShareText('x'.repeat(501));
  assert.equal(over.ok, false);
  assert.equal(over.code, 'too_long');
  assert.equal(normalizeShareText(1).ok, false);
  console.log('ok: share 写入上限 500');
}

// ---------------------------------------------------------------------------
// 只写自己
// ---------------------------------------------------------------------------
{
  assert.deepEqual(resolveShareWriter('se-a'), { ok: true, sessionId: 'se-a' });
  assert.deepEqual(resolveShareWriter('se-a', 'se-a'), { ok: true, sessionId: 'se-a' });
  assert.deepEqual(resolveShareWriter('se-a', 'se-b'), { ok: false, code: 'not_own' });
  assert.deepEqual(resolveShareWriter('', 'se-a'), { ok: false, code: 'not_actor' });
  assert.deepEqual(resolveShareWriter(undefined, 'se-a'), { ok: false, code: 'not_actor' });
  assert.deepEqual(resolveShareWriter('orchestrator:ws-1'), { ok: true, sessionId: 'orchestrator:ws-1' });
  assert.deepEqual(resolveShareWriter('orchestrator:ws-1', 'se-a'), { ok: false, code: 'not_own' });
  assert.deepEqual(resolveShareWriter('se-a', 'orchestrator:ws-1'), { ok: false, code: 'not_own' });
  console.log('ok: share 只写自己');
}

// ---------------------------------------------------------------------------
// 调度合成身份
// ---------------------------------------------------------------------------
{
  assert.equal(orchestratorSessionId('ws-1'), 'orchestrator:ws-1');
  assert.equal(orchestratorSessionId('  '), '');
  assert.equal(isOrchestratorSessionId('orchestrator:ws-1'), true);
  assert.equal(isOrchestratorSessionId('se-a'), false);
  assert.equal(parseOrchestratorWorkspaceId('orchestrator:ws-1'), 'ws-1');
  assert.equal(parseOrchestratorWorkspaceId('se-a'), '');
  assert.equal(resolveAwarenessActorId({ injectedSessionId: 'se-a', isScheduler: true, workspaceId: 'ws-1' }), 'se-a');
  assert.equal(resolveAwarenessActorId({ isScheduler: true, workspaceId: 'ws-1' }), 'orchestrator:ws-1');
  assert.equal(resolveAwarenessActorId({ isScheduler: true, workspaceId: '' }), '');
  assert.equal(resolveAwarenessActorId({ isScheduler: false, workspaceId: 'ws-1' }), '');
  assert.deepEqual(listAliveAwarenessSessionIds(['se-a'], ['ws-1']), ['se-a', 'orchestrator:ws-1']);
  console.log('ok: 调度合成身份');
}

// ---------------------------------------------------------------------------
// 关闭即删 + 落盘
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'store-'));
  const store = new RuntimeAwarenessStore(dir);
  store.setShare({
    sessionId: 'se-a',
    workspaceId: 'ws-1',
    sessionName: '改码',
    text: '正在改 src/foo.ts',
    updatedAt: 10
  });
  store.setShare({
    sessionId: 'se-b',
    workspaceId: 'ws-1',
    sessionName: '验收',
    text: '等 A 交验',
    updatedAt: 20
  });
  assert.equal(store.listShare().length, 2);
  assert.equal(store.clearShare('se-a'), true);
  assert.equal(store.getShare('se-a'), undefined);
  assert.equal(store.listShare().length, 1);
  assert.equal(store.listShare()[0].sessionId, 'se-b');

  const again = new RuntimeAwarenessStore(dir);
  assert.equal(again.getShare('se-a'), undefined);
  assert.equal(again.getShare('se-b')?.text, '等 A 交验');
  again.pruneShares(['se-x']);
  assert.equal(again.listShare().length, 0);
  console.log('ok: share 关闭即删');
}

// ---------------------------------------------------------------------------
// 内置字段可查询
// ---------------------------------------------------------------------------
{
  const now = 1_700_000_000_000;
  const sessionFacts = projectSessionFacts(
    {
      id: 'se-a',
      name: '改码 Worker',
      workspaceId: 'ws-1',
      phase: { value: 'needs_you', ts: now },
      note: { label: '已完成，等验收', ts: now },
      activity: { kind: 'idle', event: 'turn-end', ts: now },
      lifecycle: 'idle'
    },
    {
      git: {
        dirtyPaths: ['src/foo.ts', 'docs/a.md'],
        uncommittedCount: 2,
        aheadCount: 1,
        canFastForward: true,
        dirtyOverlap: false,
        lastCommit: { hash: 'abcdef12deadbeef', subject: 'feat: foo' }
      },
      verdict: { kind: 'mergeBlocked', mergeBlocked: 'uncommitted' },
      now
    }
  );
  const kinds = new Set(sessionFacts.map((f) => f.kind));
  assert.ok(kinds.has('session.phase'));
  assert.ok(kinds.has('session.note'));
  assert.ok(kinds.has('session.activity'));
  assert.ok(kinds.has('session.lifecycle'));
  assert.ok(kinds.has('git.dirty'));
  assert.ok(kinds.has('git.commit'));
  assert.ok(kinds.has('pipeline.verdict'));

  const q = normalizeFactQuery({ kinds: 'session.phase', sessionId: 'se-a' });
  const phase = queryFacts(sessionFacts, q);
  assert.equal(phase.length, 1);
  assert.equal(phase[0].data.value, 'needs_you');

  const byPath = queryFacts(sessionFacts, normalizeFactQuery({ path: 'src/foo.ts' }));
  assert.ok(byPath.some((f) => f.kind === 'git.dirty'));

  const byKw = queryFacts(sessionFacts, normalizeFactQuery({ q: '等验收' }));
  assert.ok(byKw.some((f) => f.kind === 'session.note'));

  const integrate = projectIntegrateFact({
    ts: now + 1,
    sessionId: 'se-a',
    workspaceId: 'ws-1',
    ok: true,
    message: 'merged',
    target: 'main',
    branch: 'ao/se-a'
  });
  assert.equal(integrate.kind, 'git.integrate');
  assert.equal(integrate.source, 'event');
  assert.equal(integrate.data.ok, true);

  assert.equal(RUNTIME_FACT_KINDS.includes('tasks.state'), false, '共享任务表事实已下线');
  assert.equal(isRuntimeFactKind('tasks.state'), false);

  const dir = fs.mkdtempSync(path.join(tmp, 'facts-'));
  const store = new RuntimeAwarenessStore(dir);
  store.recordIntegrate({
    ts: now + 2,
    sessionId: 'se-a',
    workspaceId: 'ws-1',
    ok: false,
    message: 'conflict',
    target: 'main',
    branch: 'ao/se-a'
  });
  const stored = store.listFacts();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'git.integrate');
  assert.equal(stored[0].data.ok, false);
  const hit = queryFacts([...sessionFacts, ...stored], normalizeFactQuery({ kinds: ['git.integrate'] }));
  assert.equal(hit.length, 1);
  assert.equal(hit[0].data.message, 'conflict');
  console.log('ok: 内置字段可查询');
}

{
  assert.equal(isRuntimeFactKind('session.phase'), true);
  assert.equal(isRuntimeFactKind('share.set'), false);
  const big = [];
  for (let i = 0; i < FACT_EVENT_MAX_COUNT + 20; i++) {
    big.push({
      id: `e${i}`,
      kind: 'git.integrate',
      ts: i,
      summary: 'x',
      data: {},
      source: 'event'
    });
  }
  const kept = evictFactEvents(big);
  assert.ok(kept.length <= FACT_EVENT_MAX_COUNT);
  assert.ok(kept[0].ts > 0);
  assert.ok(matchFact(kept[0], { kinds: ['git.integrate'] }));
  console.log('ok: 事件账本淘汰');
}

// ---------------------------------------------------------------------------
// 超大事实保底：单条超字节预算也必须留下最新 1 条；旧的超大事实照旧淘汰
// ---------------------------------------------------------------------------
{
  const huge = {
    id: 'e-huge-newest',
    kind: 'git.integrate',
    ts: 1_000_000,
    summary: 'x'.repeat(FACT_EVENT_MAX_BYTES + 1),
    data: {},
    source: 'event'
  };
  const smalls = [1, 2, 3].map((ts) => ({
    id: `e-small-${ts}`,
    kind: 'git.integrate',
    ts,
    summary: 's',
    data: {},
    source: 'event'
  }));
  const kept = evictFactEvents([...smalls, huge]);
  assert.equal(kept.length, 1, '最新一条超大事实保底保留（其余超预算被淘汰）');
  assert.equal(kept[0].id, 'e-huge-newest');
  assert.equal(kept[0].ts, 1_000_000);

  // 超大但不是最新：仍按预算淘汰（保底只护最新一条，其余淘汰逻辑不变）
  const hugeOld = { ...huge, id: 'e-huge-old', ts: 0 };
  const kept2 = evictFactEvents([...smalls, hugeOld, { ...smalls[2], id: 'e-newest', ts: 10 }]);
  assert.ok(!kept2.some((f) => f.id === 'e-huge-old'), '旧的超大事实照旧淘汰');
  assert.equal(kept2.some((f) => f.id === 'e-newest'), true, '最新事实保留');
  assert.ok(kept2.every((f) => f.id !== 'e-huge-old'));
  console.log('ok: 超大事实保底保留最新一条');
}

// ---------------------------------------------------------------------------
// F-04：停滞段去重状态持久 map（与滚动账本解耦）——跨实例持久 / 清段 / 按在册清理
// 还原（store 去掉 stallEpochs）→ 本块转红
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'stall-epoch-'));
  const store = new RuntimeAwarenessStore(dir);
  assert.equal(store.getStallEpoch('se-a'), undefined);
  store.setStallEpoch('se-a', { lastActivityAt: 100, runtimeStartedAt: 7 });
  store.setStallEpoch('se-b', { lastActivityAt: 200, runtimeStartedAt: null });
  store.setStallEpoch('se-a', { lastActivityAt: 100, runtimeStartedAt: 7 }); // 同值幂等

  const again = new RuntimeAwarenessStore(dir);
  assert.deepEqual(again.getStallEpoch('se-a'), { lastActivityAt: 100, runtimeStartedAt: 7 });
  assert.deepEqual(again.getStallEpoch('se-b'), { lastActivityAt: 200, runtimeStartedAt: null });
  assert.deepEqual(again.pruneStallEpochs(['se-b']), ['se-a'], '不在册的清、在册的留');
  assert.equal(again.getStallEpoch('se-a'), undefined);
  assert.equal(again.getStallEpoch('se-b')?.lastActivityAt, 200);
  again.setStallEpoch('se-b', undefined);
  assert.equal(again.getStallEpoch('se-b'), undefined);

  // 旧落盘没有 stallEpochs 字段：兼容读为空，不抛错
  const legacy = fs.mkdtempSync(path.join(tmp, 'stall-legacy-'));
  fs.writeFileSync(
    path.join(legacy, 'runtime-awareness.json'),
    JSON.stringify({ shares: {}, facts: [], subscriptions: {}, defaultSeeded: {} })
  );
  assert.equal(new RuntimeAwarenessStore(legacy).getStallEpoch('se-a'), undefined);
  console.log('ok: 停滞段持久 map（跨实例/清段/按在册清理/旧文件兼容）');
}

// ---------------------------------------------------------------------------
// F-07：runtime-awareness.json 损坏——原文件改名保留 .bad + console.error，按空启动；
// 还原（静默回空、不留现场）→ 「.bad 存在/原文件让位」断言转红
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'corrupt-'));
  const file = path.join(dir, 'runtime-awareness.json');
  fs.writeFileSync(file, '{"shares":'); // 截断损坏
  const errors = [];
  const origError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let store;
  try {
    store = new RuntimeAwarenessStore(dir);
  } finally {
    console.error = origError;
  }
  assert.equal(store.listShare().length, 0, '损坏按空数据启动');
  assert.equal(errors.length >= 1, true, 'console.error 留诊断线索');
  assert.match(errors[0], /解析失败/);
  const bads = fs.readdirSync(dir).filter((n) => n.endsWith('.bad'));
  assert.equal(bads.length, 1, '原文件改名保留 .bad 现场');
  assert.equal(fs.existsSync(file), false, '原文件已让位，不会被空数据覆盖');
  store.setShare({ sessionId: 'se-a', text: '恢复后照常写', updatedAt: 1 });
  assert.equal(fs.existsSync(file), true, '新数据落干净文件');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.bad')).length, 1, '.bad 现场仍在');
  assert.equal(new RuntimeAwarenessStore(dir).getShare('se-a')?.text, '恢复后照常写');
  console.log('ok: 损坏文件保留 .bad 现场并留诊断，不静默覆盖');
}
{
  // 正常首启（无文件）不是损坏：不报错、不产生 .bad
  const dir = fs.mkdtempSync(path.join(tmp, 'fresh-'));
  new RuntimeAwarenessStore(dir);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.bad')).length, 0);
  console.log('ok: 正常首启不产生 .bad');
}

// ---------------------------------------------------------------------------
// F-01：启动清理点接线——index.ts 的 emitters 悬空清理同处必须按 alive 集清感知摘要
// ---------------------------------------------------------------------------
{
  const indexSrc = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(
    indexSrc,
    /pruneShares\(aliveEventIds\)/,
    '启动清理点（pruneStaleEmitters 同处）必须接线 pruneShares（F-01）'
  );
  console.log('ok: 启动清理点接线 pruneShares');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[ok] runtime-awareness');
