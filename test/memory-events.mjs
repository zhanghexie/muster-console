/**
 * 记忆事件账本（记忆面板 M1 条目 1A，schema v4）：v1→v4 老库升级（memory_events 建
 * 表 / staging CHECK 扩 user_discarded / consolidation_log payload 列）+ 幂等、各写点
 * 「恰好一行事件」（staged / promoted / approval_queued / approval_decided /
 * direct_write / profile_write / intent_fired / intent_cancelled；主写失败不落账、
 * 事件失败不阻塞主写入）、聚合查询（列表过滤/按 kind 计数/召回 30 天窗口聚合）、
 * 滚动清理（deleteEventsBefore + sweep piggyback）。
 * 还原即红口径：去掉任一写点的 appendEvent，对应「恰好一行」断言转红；去掉
 * appendEvent 内 try/catch，「失败不阻塞主写入」节转红。
 * Run: node test/memory-events.mjs（本机 node 缺 fts5 时按仓内惯例退出 0 跳过；
 * 或 set ELECTRON_RUN_AS_NODE=1&& electron.exe test/memory-events.mjs 真跑）
 * 全部落系统临时目录（mkdtemp），LLM 调用不触达（无门内候选的 sweep 用 mock）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-events-'));
const compile = createSharedCompiler(root, tmp);

const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const eventsMod = await import(pathToFileURL(compile('main/memory/events.ts')).href);
const stagingMod = await import(pathToFileURL(compile('main/memory/staging.ts')).href);
const gatesMod = await import(pathToFileURL(compile('main/memory/consolidation/gates.ts')).href);
const approvalMod = await import(pathToFileURL(compile('main/memory/consolidation/approval.ts')).href);
const sweepMod = await import(pathToFileURL(compile('main/memory/consolidation/sweep.ts')).href);
const intentsMod = await import(pathToFileURL(compile('main/memory/intents.ts')).href);
const userProfileMod = await import(pathToFileURL(compile('main/memory/userProfile.ts')).href);
const svcRefMod = await import(pathToFileURL(compile('main/memory/serviceRef.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);

const { openMemoryDb, createV1Schema, listTableNames, insertChunk, recordRecallStat, aggregateRecallStats, listConsolidationLog } = dbMod;
const { appendEvent, listMemoryEvents, countEventsByKind, deleteEventsBefore } = eventsMod;
const { noteStaging, transitionStaging, discardStaging, undiscardStaging, sweepDiscardedStaging } = stagingMod;
const { listStagingCandidates } = gatesMod;
const { enqueueConsolidationApproval, decideConsolidationApproval } = approvalMod;
const { runConsolidationSweep } = sweepMod;
const { insertIntent, tryFireIntent, cancelIntent } = intentsMod;
const { appendProfileDirective, setUserProfileFilePath } = userProfileMod;
const { setMemoryService } = svcRefMod;
const { MemoryService } = svcMod;

const DAY = 86_400_000;

function eventsOf(db, kind) {
  return listMemoryEvents(db, { limit: 200, kinds: kind ? [kind] : undefined });
}

function countKind(db, kind) {
  return eventsOf(db, kind).length;
}

/* ---------------- 1. v1→v4 迁移（真 v1 老库升级 + 幂等） ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-migrate');
  const dbFile = path.join(wsRoot, '.muster', 'memory', 'runtime', 'state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  // 手工造真 v1 老库：meta v1 + v1 八表 + 一条 staging + 一条 log（无 payload 列）
  const raw = new DatabaseSync(dbFile);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  createV1Schema(raw);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  raw.prepare(
    "INSERT INTO staging (text, origin, session_kind, state, created_at) VALUES ('老库候选：迁移保数据', 'worker', 'worker', 'pending', 1710000000000)"
  ).run();
  raw.prepare(
    "INSERT INTO consolidation_log (trigger_source, added_count, merged_count, superseded_count, diff_summary, rejected_counts, started_at, finished_at) VALUES ('consolidation:task_close:worker', 1, 0, 0, '旧行无明细', '{}', 1710000000000, 1710000000001)"
  ).run();
  raw.close();

  const db = openMemoryDb(wsRoot);
  assert.equal(db.schemaVersion(), 5, '老 v1 库打开即迁当前版本（→v5 审批执行日志）');
  const tables = listTableNames(db);
  assert.ok(tables.includes('memory_events'), 'memory_events 表已建');
  assert.equal(countKind(db), 0, '迁移不回填历史事件（旧记录兼容，不做回填）');
  // v4 新面可用：staging user_discarded 域 + log payload 列
  db.write((tx) =>
    tx.prepare(
      "INSERT INTO staging (text, origin, session_kind, state, created_at) VALUES ('v4 丢弃域', 'worker', 'worker', 'user_discarded', 1710000000000)"
    ).run()
  );
  db.write((tx) =>
    tx.prepare(
      "INSERT INTO consolidation_log (trigger_source, added_count, merged_count, superseded_count, diff_summary, rejected_counts, payload, started_at, finished_at) VALUES ('t', 0, 0, 0, '', '{}', '{\"applied\":[],\"supersededPairs\":[],\"rejected\":[]}', 1710000000000, 1710000000001)"
    ).run()
  );
  const oldStaging = db.handle.prepare('SELECT count(*) n FROM staging').get();
  assert.equal(Number(oldStaging.n), 2, 'staging 搬数据不丢行');
  const logRow = db.handle.prepare('SELECT payload FROM consolidation_log ORDER BY id DESC LIMIT 1').get();
  assert.ok(String(logRow.payload).includes('applied'), 'log payload 列可写可读');
  // 幂等：重开仍 v4、数据原样
  db.close();
  const db2 = openMemoryDb(wsRoot);
  assert.equal(db2.schemaVersion(), 5, '重开不重复迁移');
  assert.equal(Number(db2.handle.prepare('SELECT count(*) n FROM staging').get().n), 2, '重开数据原样');
  db2.close();
  console.log('ok: 1 v1→v4 迁移（memory_events 建表/staging user_discarded 域/log payload 列/幂等）');
}

/* ---------------- 2. staged 写点恰好一行（memory.note / 摄入 / flush 共用落点） ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-staged'));
  const r1 = noteStaging(db, {
    text: '候选甲：部署脚本统一用 pnpm，npm 会踩 workspace 坑',
    origin: 'worker',
    sessionKind: 'worker',
    evidencePath: 'agent-session:s1'
  });
  assert.equal(r1.ok, true);
  const evs = eventsOf(db, 'staged');
  assert.equal(evs.length, 1, '一次成功入池恰好一行 staged 事件');
  assert.equal(evs[0].stagingId, r1.stagingId);
  assert.equal(evs[0].namespace, 'worker');
  assert.equal(evs[0].entryRef, `staging:${r1.stagingId}`);
  assert.ok(evs[0].summary.includes('{{text}}'), 'summary 存 i18n key（不存翻译后文案）');
  assert.ok(evs[0].summaryArgs && evs[0].summaryArgs.text.includes('pnpm'), '参数携带正文摘要');

  // 画像路由（origin=user → namespace=profile）
  const r2 = noteStaging(db, { text: '候选乙：用户偏好深色主题。', origin: 'user', sessionKind: 'worker' });
  assert.equal(r2.ok, true);
  const evs2 = eventsOf(db, 'staged');
  assert.equal(evs2.length, 2, '两次入池两行事件');
  const ev2 = evs2.find((e) => e.stagingId === r2.stagingId);
  assert.equal(ev2.namespace, 'profile', 'origin=user 候选投影为 profile 命名空间');

  // 拒收不落账（判重命中）
  const r3 = noteStaging(db, { text: '候选甲：部署脚本统一用 pnpm，npm 会踩 workspace 坑', origin: 'worker', sessionKind: 'worker' });
  assert.equal(r3.ok, false, '重复候选被拒');
  assert.equal(countKind(db, 'staged'), 2, '拒收路径零事件（还原即红：写点挪到拒绝分支外会多行）');

  // 调度来源 → scheduler 命名空间
  const r4 = noteStaging(db, { text: '候选丙：调度简报要带任务看板状态。', origin: 'scheduler', sessionKind: 'scheduler' });
  assert.equal(r4.ok, true);
  const schedEv = eventsOf(db, 'staged').find((e) => e.stagingId === r4.stagingId);
  assert.equal(schedEv.namespace, 'scheduler');
  db.close();
  console.log('ok: 2 staged 恰好一行（命名空间投影/拒收零事件）');
}

/* ---------------- 3. promoted 写点恰好一行（sweep/审批/画像晋升共用状态翻转收口） ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-promoted'));
  const r = noteStaging(db, { text: '晋升候选：测试走 ELECTRON_RUN_AS_NODE。', origin: 'worker', sessionKind: 'worker' });
  assert.equal(countKind(db, 'promoted'), 0, '入池不落 promoted');
  assert.equal(transitionStaging(db, r.stagingId, 'promoted'), true);
  const evs = eventsOf(db, 'promoted');
  assert.equal(evs.length, 1, '晋升恰好一行 promoted 事件');
  assert.equal(evs[0].stagingId, r.stagingId);
  assert.equal(evs[0].namespace, 'worker');
  // 幂等：重复迁移 no-op 不重复落账
  assert.equal(transitionStaging(db, r.stagingId, 'promoted'), false);
  assert.equal(countKind(db, 'promoted'), 1, '重复迁移零新事件');
  db.close();
  console.log('ok: 3 promoted 恰好一行（幂等迁移不重复落账）');
}

/* ---------------- 4. approval_queued / approval_decided 恰好一行 ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-approval'));
  const target = path.join(tmp, 'ws-approval', 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '<!-- 2026-01-01 00:00:00 [s1] -->\n#seed 审批基线条目。\n', 'utf8');

  const c1 = noteStaging(db, { text: '审批候选甲：面板事件流要能点实体跳转。', origin: 'worker', sessionKind: 'worker' });
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'docs/memory/MEMORY.md',
    baseHash: '',
    baseContentChars: 0,
    operations: [
      { op: 'add', text: '审批候选甲：面板事件流要能点实体跳转。', confidence: 0.5, stagingId: c1.stagingId, citation: `Source: staging#${c1.stagingId}` }
    ],
    reason: 'test',
    now: Date.now()
  });
  const queued = eventsOf(db, 'approval_queued');
  assert.equal(queued.length, 1, '入队恰好一行 approval_queued');
  assert.equal(queued[0].approvalId, approvalId);
  assert.ok(queued[0].summaryArgs.count === 1, '事件参数带操作笔数');

  // reject：恰好一行 approval_decided，无 promoted
  const d1 = decideConsolidationApproval(db, approvalId, 'reject', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: c1.stagingId, evidencePath: 'agent-session:s1' }]
  });
  assert.equal(d1.ok, true);
  const decided = eventsOf(db, 'approval_decided');
  assert.equal(decided.length, 1, '裁决恰好一行 approval_decided');
  assert.equal(decided[0].approvalId, approvalId);
  assert.equal(decided[0].summaryArgs.decision, 'rejected', '参数带裁决方向（边流量 e-approve/e-delrestore 依赖）');
  assert.equal(countKind(db, 'promoted'), 0, '驳回不产生 promoted');

  // approve：一行 approval_decided + 一行 promoted（transitionStaging 收口）
  const c2 = noteStaging(db, { text: '审批候选乙：批准后真实入库。', origin: 'worker', sessionKind: 'worker' });
  const approvalId2 = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'docs/memory/MEMORY.md',
    baseHash: createHash('sha256').update(fs.readFileSync(target, 'utf8')).digest('hex'),
    baseContentChars: 0,
    operations: [
      { op: 'add', text: '审批候选乙：批准后真实入库。', confidence: 0.5, stagingId: c2.stagingId, citation: `Source: staging#${c2.stagingId}` }
    ],
    reason: 'test',
    now: Date.now()
  });
  const before = countKind(db, 'approval_decided');
  const d2 = decideConsolidationApproval(db, approvalId2, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: c2.stagingId, evidencePath: 'agent-session:s2' }]
  });
  assert.equal(d2.ok, true, d2.error ?? '');
  assert.equal(countKind(db, 'approval_decided'), before + 1, '批准恰好一行 approval_decided');
  const approveEv = eventsOf(db, 'approval_decided')[0];
  assert.equal(approveEv.summaryArgs.decision, 'approved');
  assert.equal(countKind(db, 'promoted'), 1, '批准路径经 transitionStaging 收口落 promoted');
  db.close();
  console.log('ok: 4 approval_queued/approval_decided 恰好一行（reject/approve 两向）');
}

/* ---------------- 5. direct_write（写点已随直写通道退役；账本 kind 保留只读兼容） ----------------
 * 2026-10-26 F-01：memory.remember 改走类型化知识库候选（knowledgeTools.rememberKnowledge
 * → 后台记忆会话），MEMORY.md 直写门 directWriteCuratedCore 删除，本节"写点恰好一行"
 * 合同随之退役；历史账本中的 direct_write 行渲染面继续兼容（events.ts 头注）。 */

/* ---------------- 6. profile_write 写点恰好一行（观察点收口） ---------------- */
{
  const userDataDir = path.join(tmp, 'user-data');
  fs.mkdirSync(userDataDir, { recursive: true });
  setUserProfileFilePath(userDataDir);
  const wsRoot = path.join(tmp, 'ws-profile');
  const svc = new MemoryService();
  setMemoryService(svc);
  svc.init(wsRoot); // init 接线画像写观察点 → 事件落该工作区派生库
  const db = svc.db(wsRoot);
  const r = appendProfileDirective('Always 先跑 typecheck 再提交。');
  assert.equal(r.ok, true, r.message ?? '');
  const evs = eventsOf(db, 'profile_write');
  assert.equal(evs.length, 1, '一次画像写恰好一行 profile_write');
  assert.equal(evs[0].namespace, 'profile');
  assert.equal(evs[0].entryRef, 'USER.md');
  assert.ok(evs[0].summaryArgs.totalChars > 0, '参数带字数');
  // 面板直改（writeUserProfile 全文通道）同收口再落一行
  const { writeUserProfile } = userProfileMod;
  const r2 = writeUserProfile('<!-- observed: 2026-09-27 | status: active -->\n\n- Never 跳过测试直接提交。\n');
  assert.equal(r2.ok, true, r2.message ?? '');
  assert.equal(countKind(db, 'profile_write'), 2, '面板直改同样恰好一行');
  svc.closeAll();
  setMemoryService(null);
  setUserProfileFilePath(null);
  console.log('ok: 6 profile_write 恰好一行（remember 画像路由/面板直改共用收口）');
}

/* ---------------- 7. intent_fired / intent_cancelled 恰好一行 ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-intents'));
  const intent = insertIntent(db, {
    description: '合入受阻时提醒我',
    triggerKeywords: ['合入'],
    now: Date.now()
  });
  assert.equal(countKind(db, 'intent_fired'), 0, '创建不落触发事件');
  const fired = tryFireIntent(db, intent.id, Date.now());
  assert.equal(fired?.fired, true);
  const evs = eventsOf(db, 'intent_fired');
  assert.equal(evs.length, 1, '发射恰好一行 intent_fired');
  assert.equal(evs[0].entryRef, `intent:${intent.id}`);
  assert.equal(evs[0].summaryArgs.fireCount, 1);
  // 冷却期内不发射 → 不重复落账
  const again = tryFireIntent(db, intent.id, Date.now());
  assert.equal(again?.fired, false);
  assert.equal(countKind(db, 'intent_fired'), 1, '冷却拒绝零事件');
  // 取消
  assert.equal(cancelIntent(db, intent.id, Date.now()), true);
  const cancels = eventsOf(db, 'intent_cancelled');
  assert.equal(cancels.length, 1, '取消恰好一行 intent_cancelled');
  assert.equal(cancelIntent(db, intent.id, Date.now()), false, '重复取消幂等 no-op');
  assert.equal(countKind(db, 'intent_cancelled'), 1, '重复取消零新事件');
  db.close();
  console.log('ok: 7 intent_fired/intent_cancelled 恰好一行（冷却/幂等不重复落账）');
}

/* ---------------- 8. 聚合查询：列表过滤 / 按 kind 时间窗计数 ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-agg'));
  const now = Date.now();
  // 按时间升序插入（id desc ⟺ ts desc，事件流「新→旧」即插入序倒排）
  appendEvent(db, { kind: 'intent_fired', ts: now - 2 * DAY, namespace: null, summary: 'i' });
  appendEvent(db, { kind: 'staged', ts: now - 3_000, namespace: 'worker', summary: 's' });
  appendEvent(db, { kind: 'staged', ts: now - 2_000, namespace: 'worker', summary: 's' });
  appendEvent(db, { kind: 'staged', ts: now - 1_000, namespace: 'worker', summary: 's' });
  appendEvent(db, { kind: 'promoted', ts: now - 500, namespace: 'worker', summary: 'p' });
  assert.equal(listMemoryEvents(db, { limit: 2 }).length, 2, 'limit 生效');
  const desc = listMemoryEvents(db, {});
  assert.equal(desc.length, 5, '全量条数');
  assert.ok(desc[0].ts >= desc[desc.length - 1].ts, '新→旧排序');
  assert.equal(listMemoryEvents(db, { kinds: ['staged'] }).length, 3, 'kind 过滤');
  assert.equal(listMemoryEvents(db, { sinceTs: now - 2_000 }).length, 2, '时间窗过滤');
  const counts = countEventsByKind(db, now - 24 * 3_600_000);
  assert.deepEqual(counts, { staged: 3, promoted: 1 }, '24h 窗口只计近期事件');
  const counts3d = countEventsByKind(db, now - 3 * DAY);
  assert.equal(counts3d.intent_fired, 1, '窗口放宽后计入');
  db.close();
  console.log('ok: 8 事件聚合（limit/kind 过滤/时间窗计数）');
}

/* ---------------- 9. 失败不阻塞主写入（appendEvent 吞错，主写照常提交） ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-noabort'));
  // 事件 kind 越界（CHECK 拒）→ appendEvent 内部捕获只打日志；同事务的主写入照常提交
  let stagingId = 0;
  db.write((tx) => {
    const info = tx
      .prepare(
        "INSERT INTO staging (text, origin, session_kind, state, created_at) VALUES ('主写入不受事件失败拖累', 'worker', 'worker', 'pending', ?)"
      )
      .run(Date.now());
    stagingId = Number(info.lastInsertRowid);
    appendEvent(db, { kind: 'bogus_kind', ts: Date.now(), summary: '必然被 CHECK 拒' });
    appendEvent(db, { kind: 'staged', ts: Date.now(), summary: '正常事件照落' });
  });
  assert.ok(stagingId > 0, '主写入已提交');
  const row = db.handle.prepare('SELECT id FROM staging WHERE id = ?').get(stagingId);
  assert.ok(row, '同事务主写入不受坏事件影响（还原即红：去掉 try/catch 此处转红）');
  assert.equal(countKind(db, 'staged'), 1, '同批正常事件仍落账');
  db.close();
  console.log('ok: 9 事件失败不阻塞主写入（CHECK 越界吞错/主写提交/正常事件照落）');
}

/* ---------------- 10. 滚动清理：deleteEventsBefore + sweep piggyback（同源保留窗） ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-cleanup');
  const db = openMemoryDb(wsRoot);
  const now = Date.now();
  appendEvent(db, { kind: 'staged', ts: now - 200 * DAY, namespace: 'worker', summary: '很旧的事件' });
  appendEvent(db, { kind: 'staged', ts: now - 1 * DAY, namespace: 'worker', summary: '新事件' });
  assert.equal(deleteEventsBefore(db, now - 90 * DAY), 1, '保留窗外清理一条');
  const left = listMemoryEvents(db, {});
  assert.equal(left.length, 1);
  assert.ok(left[0].summaryArgs === null || left[0].summary, '剩余为新事件');

  // sweep piggyback：retentionDays 与 transcript 滚动淘汰同源传参
  appendEvent(db, { kind: 'promoted', ts: now - 120 * DAY, namespace: 'worker', summary: '窗外的晋升' });
  const summary = await runConsolidationSweep({
    db,
    namespace: 'worker',
    targetFileAbs: path.join(wsRoot, 'docs', 'memory', 'MEMORY.md'),
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async () => {
      throw new Error('无门内候选时不应调用模型');
    },
    thresholds: { minScore: 0.55, minRecallCount: 2, minUniqueQueries: 2 },
    now,
    reason: 'task_close',
    timeoutMs: 1_000
  });
  assert.equal(summary.eventsEvicted, 1, 'sweep 首步顺带清 events（还原即红：去掉 sweep 内 deleteEventsBefore 转红）');
  assert.equal(listMemoryEvents(db, {}).some((e) => e.ts < now - 90 * DAY), false, '窗外事件已被清');
  db.close();
  console.log('ok: 10 滚动清理（deleteEventsBefore + sweep piggyback 同源保留窗）');
}

/* ---------------- 11. 丢弃标记：user_discarded 状态机 + sweep 物理出池 ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-discard'));
  const r = noteStaging(db, { text: '丢弃候选：面板丢弃后随 sweep 出池。', origin: 'worker', sessionKind: 'worker' });
  assert.ok(listStagingCandidates(db).some((c) => c.stagingId === r.stagingId), 'pending 候选在巩固装载面');
  assert.equal(discardStaging(db, r.stagingId), true, '丢弃标记成功');
  assert.equal(listStagingCandidates(db).some((c) => c.stagingId === r.stagingId), false, '丢弃后不进巩固装载面（WHERE pending）');
  // 撤销：无损恢复
  assert.equal(undiscardStaging(db, r.stagingId), true, '撤销清标记');
  assert.ok(listStagingCandidates(db).some((c) => c.stagingId === r.stagingId), '撤销后回巩固装载面');
  // 再丢弃 → sweep 物理出池（整行删除 + 镜像 chunk 清理）
  assert.equal(discardStaging(db, r.stagingId), true);
  assert.equal(sweepDiscardedStaging(db), 1, '物理出池一条');
  const row = db.handle.prepare('SELECT id FROM staging WHERE id = ?').get(r.stagingId);
  assert.equal(row, undefined, 'staging 行已删除（出池后不可恢复）');
  const chunk = db.handle.prepare('SELECT id FROM chunks WHERE staging_id = ?').get(r.stagingId);
  assert.equal(chunk, undefined, '镜像 chunk 随删');
  assert.equal(sweepDiscardedStaging(db), 0, '重复 sweep 零清理（幂等）');
  db.close();
  console.log('ok: 11 user_discarded 状态机（丢弃/撤销/物理出池幂等）');
}

/* ---------------- 12. 召回 30 天窗口聚合（GROUP BY chunk_id,kind） ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-recall-agg'));
  const now = Date.now();
  const c1 = insertChunk(db, { sourceType: 'memory', sourcePath: 'docs/memory/MEMORY.md', text: '条目甲', origin: 'worker' });
  const c2 = insertChunk(db, { sourceType: 'memory', sourcePath: 'docs/memory/MEMORY.md', text: '条目乙', origin: 'worker' });
  recordRecallStat(db, c1, 'bootstrap', 'bootstrap:worker', now - DAY, null);
  recordRecallStat(db, c1, 'bootstrap', 'bootstrap:worker', now - 2 * DAY, null);
  recordRecallStat(db, c1, 'search_hit', '测试', now - DAY, 0.8);
  recordRecallStat(db, c2, 'search_hit', '测试', now - 40 * DAY, 0.5); // 窗外
  const rows = aggregateRecallStats(db, now - 30 * DAY);
  const c1Boot = rows.find((r) => r.chunkId === c1 && r.kind === 'bootstrap');
  const c1Hit = rows.find((r) => r.chunkId === c1 && r.kind === 'search_hit');
  const c2Hit = rows.find((r) => r.chunkId === c2 && r.kind === 'search_hit');
  assert.ok(c1Boot && c1Boot.count === 2, '同 chunk 同 kind 聚合计数');
  assert.ok(c1Hit && c1Hit.count === 1, 'kind 分行聚合');
  assert.equal(c2Hit, undefined, '窗外行不入聚合（只扫 30 天窗口）');
  const injectedOnly = aggregateRecallStats(db, now - 30 * DAY, ['bootstrap', 'brief_injected', 'trigger_injected']);
  assert.ok(injectedOnly.every((r) => r.kind === 'bootstrap'), 'kind 白名单过滤生效');
  db.close();
  console.log('ok: 12 召回 30 天窗口聚合（chunk×kind 计数/窗外剔除/kind 白名单）');
}

console.log(`memory-events(M1): ok (tmp=${tmp})`);
