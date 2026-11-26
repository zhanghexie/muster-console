/**
 * 记忆中心 hub 服务面（memory-refactor B6 §11）：双策展文件条目列表（注解/溯源/年龄/
 * 重复矛盾/注入装箱）、行内注解编辑（stale 拒绝 + 原位改写 roundtrip）、审批队列
 * （列表/角标/approve 真实生效/reject 退场/回执文本）、晋升审阅时间线映射、前镜像
 * 回收站与一键回滚（现状另存/幂等 no-op/非策展文件拒绝）、索引状态读数。
 * Run: node test/memory-center.mjs
 * 全部落系统临时目录（mkdtemp）；db 走真 node:sqlite，服务实例为真 MemoryService（无模型）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

// 本机 Node 构建缺 fts5（如 22.x 官方 win-x64）时 db 层建库即报 no such module: fts5，
// 属环境能力缺失而非回归——按仓库惯例打印原因后退出 0 跳过（详见 helpers/sqlite-fts5.mjs）。
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-center-'));
const compile = createSharedCompiler(root, tmp);

const centerMod = await import(pathToFileURL(compile('main/memory/center.ts')).href);
const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const stagingMod = await import(pathToFileURL(compile('main/memory/staging.ts')).href);
const gatesMod = await import(pathToFileURL(compile('main/memory/consolidation/gates.ts')).href);
const approvalMod = await import(pathToFileURL(compile('main/memory/consolidation/approval.ts')).href);
const svcRefMod = await import(pathToFileURL(compile('main/memory/serviceRef.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);
const storeMod = await import(pathToFileURL(compile('main/memory/panelStore.ts')).href);
const ipcDtoMod = await import(pathToFileURL(compile('shared/memoryCenterIpc.ts')).href);

const {
  memoryCenterEntries,
  memoryCenterUpdateEntry,
  memoryCenterApprovals,
  memoryCenterBadge,
  memoryCenterDecideApproval,
  memoryCenterLog,
  memoryCenterRecycle,
  memoryCenterRollback,
  memoryCenterIndexStatus,
  memoryCenterEvents,
  memoryCenterStagingList,
  memoryCenterStagingDiscard,
  memoryCenterStagingUndiscard,
  memoryCenterSuperseded
} = centerMod;
const { insertChunk, listConsolidationLog, recordRecallStat } = dbMod;
const { indexSchedulerTranscript } = await import(
  pathToFileURL(compile('main/memory/transcriptIndex.ts')).href
);
const { noteStaging, sweepDiscardedStaging } = stagingMod;
const { listStagingCandidates } = gatesMod;
const { enqueueConsolidationApproval } = approvalMod;
const { setMemoryService } = svcRefMod;
const { MemoryService } = svcMod;
const { memorySaveEntry } = storeMod;
const { normalizeMemoryCenterUpdateEntryInput } = ipcDtoMod;

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-center-ws-'));
const svc = new MemoryService();
setMemoryService(svc);
svc.init(ws);

const WORKER_REL = path.join(ws, 'docs', 'memory', 'MEMORY.md');
const SCHED_REL = path.join(ws, '.muster', 'scheduler', 'MEMORY.md');

function writeWorker(content) {
  fs.mkdirSync(path.dirname(WORKER_REL), { recursive: true });
  fs.writeFileSync(WORKER_REL, content, 'utf8');
}

const NOW = new Date('2026-09-21T12:00:00');

/* ---------------- 1. 条目总览：双文件 / 注解 / 溯源列 / 派生数据 ---------------- */
{
  writeWorker(
    [
      '<!-- 2026-09-01 10:00:00 [s1] -->',
      '#lesson [[ws]] 嵌套仓容器必须写主仓 info/exclude。 <!-- trigger: 嵌套仓, 容器恒脏 --> <!-- importance: 8 --> <!-- project: github.com/foo/bar -->',
      '',
      '<!-- 2026-09-02 11:00:00 [s2] -->',
      '#decision 数据库统一 PostgreSQL，弃 MySQL。',
      '',
      '<!-- 2026-09-02 11:00:00 [s2] -->',
      '#decision 数据库统一 PostgreSQL，弃 MySQL。'
    ].join('\n') + '\n'
  );
  fs.mkdirSync(path.dirname(SCHED_REL), { recursive: true });
  fs.writeFileSync(
    SCHED_REL,
    ['<!-- 2026-09-20 09:00:00 [sched] -->', '#preference 调度简报默认精简。'].join('\n') + '\n',
    'utf8'
  );

  const r = memoryCenterEntries(ws, NOW);
  assert.equal(r.entries.length, 4);
  const annotated = r.entries.find((e) => e.trigger.length > 0);
  assert.ok(annotated, '注解条目在列');
  assert.equal(annotated.namespace, 'worker');
  assert.deepEqual(annotated.trigger, ['嵌套仓', '容器恒脏']);
  assert.equal(annotated.importance, 8);
  assert.equal(annotated.repoKey, 'github.com/foo/bar');
  assert.equal(annotated.ageDays, 20);
  assert.ok(annotated.origin === null, 'markdown canonical 无 origin 数据源，恒 null');
  const sched = r.entries.find((e) => e.namespace === 'scheduler');
  assert.ok(sched, '调度策展条目在列');
  assert.equal(r.files.worker.exists, true);
  assert.equal(r.files.worker.chars, fs.readFileSync(WORKER_REL, 'utf8').length, '容量提示取实际文件字符数');
  assert.ok(r.files.worker.maxChars > 0 && r.files.scheduler.maxChars > 0, '两份策展文件显示真实上限');
  assert.equal(r.files.scheduler.relPath, '.muster/scheduler/MEMORY.md');
  // 重复/矛盾按文件检测：两同文条目 → 1 对疑似重复
  assert.equal(r.duplicates.length, 1);
  // 注入装箱信息（共享文件）
  assert.ok(r.injection.budgetChars > 0);
  assert.ok(r.injection.includedIds.length > 0);
}

/* ---------------- 2. 行内注解编辑：改写 / 清除 / 非法值 / stale ---------------- */
{
  const before = memoryCenterEntries(ws, NOW);
  const target = before.entries.find((e) => e.trigger.length > 0);
  const otherRaw = before.entries.find((e) => e.id !== target.id && e.namespace === 'worker').raw;

  // 2a 正常改写：trigger 换词 + importance 提升 + repoKey 改值；其余条目字节不动
  // （id 含内容指纹：正文不变仅注解变 → id 仍变，与现有 saveEntry 行为一致，按文本定位）
  const r = memoryCenterUpdateEntry(ws, {
    namespace: 'worker',
    id: target.id,
    hash: before.files.worker.hash,
    trigger: ['隔离 worktree'],
    importance: 9,
    repoKey: 'github.com/bar/baz'
  }, NOW);
  assert.equal(r.stale, false);
  const after = r.entries.find((e) => e.text.includes('嵌套仓'));
  assert.ok(after, '改写后条目在列（id 随内容指纹更新）');
  assert.deepEqual(after.trigger, ['隔离 worktree']);
  assert.equal(after.importance, 9);
  assert.equal(after.repoKey, 'github.com/bar/baz');
  const unchanged = r.entries.find((e) => e.id !== after.id && e.namespace === 'worker');
  assert.equal(unchanged.raw, otherRaw, '未编辑条目原样保留');
  const roundtrip = fs.readFileSync(WORKER_REL, 'utf8');
  assert.ok(roundtrip.includes('<!-- trigger: 隔离 worktree -->'));
  assert.ok(roundtrip.includes('<!-- importance: 9 -->'));
  assert.ok(roundtrip.includes('<!-- project: github.com/bar/baz -->'));

  // 2b 清除注解（空 trigger 数组 / importance null / repoKey null）
  const cleared = memoryCenterUpdateEntry(ws, {
    namespace: 'worker',
    id: after.id,
    hash: r.hash,
    trigger: [],
    importance: null,
    repoKey: null
  }, NOW);
  const clearedEntry = cleared.entries.find((e) => e.text.includes('嵌套仓'));
  assert.deepEqual(clearedEntry.trigger, []);
  assert.equal(clearedEntry.importance, null);
  assert.equal(clearedEntry.repoKey, null);
  assert.ok(!fs.readFileSync(WORKER_REL, 'utf8').includes('<!-- importance'), '注解注释已从盘上移除');

  // 2c 非法 importance 拒绝
  assert.throws(
    () => memoryCenterUpdateEntry(ws, { namespace: 'worker', id: clearedEntry.id, hash: cleared.hash, importance: 11 }, NOW),
    /importance/
  );

  // 2d stale：hash 不符 → 拒绝写入并返回最新内容；盘上内容未被并发改写
  const fresh = memoryCenterEntries(ws, NOW);
  const sentinel = fs.readFileSync(WORKER_REL, 'utf8');
  const staleRes = memoryCenterUpdateEntry(ws, {
    namespace: 'worker',
    id: clearedEntry.id,
    hash: 'deadbeefdeadbeef',
    importance: 3
  }, NOW);
  assert.equal(staleRes.stale, true);
  assert.equal(staleRes.hash, fresh.files.worker.hash);
  assert.equal(fs.readFileSync(WORKER_REL, 'utf8'), sentinel, 'stale 时不落盘');

  // 2e 调度命名空间：只动调度文件
  const schedBefore = memoryCenterEntries(ws, NOW);
  const schedEntry = schedBefore.entries.find((e) => e.namespace === 'scheduler');
  const workerSentinel = fs.readFileSync(WORKER_REL, 'utf8');
  const r2 = memoryCenterUpdateEntry(ws, {
    namespace: 'scheduler',
    id: schedEntry.id,
    hash: schedBefore.files.scheduler.hash,
    importance: 4
  }, NOW);
  assert.equal(r2.stale, false);
  const schedAfter = r2.entries.find((e) => e.text.includes('调度简报'));
  assert.equal(schedAfter.importance, 4);
  assert.equal(fs.readFileSync(WORKER_REL, 'utf8'), workerSentinel, 'worker 文件不被拖动');
  assert.ok(fs.readFileSync(SCHED_REL, 'utf8').includes('<!-- importance: 4 -->'));

  // 2f 不存在的条目报错（hash 取当前 worker 文件，走「条目不存在」而非 stale 分支）
  const forThrow = memoryCenterEntries(ws, NOW);
  assert.throws(
    () => memoryCenterUpdateEntry(ws, { namespace: 'worker', id: 'nope', hash: forThrow.files.worker.hash, importance: 2 }, NOW),
    /nope/
  );
}

/* ---------------- 3. 审批队列：approve 真实生效 + 回执 + 角标 ---------------- */
{
  writeWorker('<!-- 2026-09-01 10:00:00 [s1] -->\n#decision 基线条目。\n');
  const note = noteStaging(svc.init(ws), {
    text: '巩固新增：审批链路真实生效验证。',
    origin: 'worker',
    sessionKind: 'worker',
    taskId: null,
    observedAt: Date.now(),
    signals: { source: 'test' }
  });
  assert.equal(note.ok, true);

  // 低置信 add → 入审批队列（走 B4 enqueue 真链）
  const ops = [{ op: 'add', text: '巩固新增：审批链路真实生效验证。', confidence: 0.5, stagingId: note.stagingId }];
  const approvalId = enqueueConsolidationApproval(svc.init(ws), {
    namespace: 'worker',
    targetFileRel: 'docs/memory/MEMORY.md',
    baseHash: createHash('sha256').update(fs.readFileSync(WORKER_REL, 'utf8')).digest('hex'),
    baseContentChars: 0,
    operations: ops.map((o, i) => ({
      ...o,
      citation: `Source: staging#${note.stagingId}${i >= 0 ? '' : ''}`
    })),
    reason: 'test',
    now: Date.now()
  });
  assert.equal(memoryCenterBadge(ws).pending, 1);

  const list = memoryCenterApprovals(ws);
  const row = list.items.find((a) => a.id === approvalId);
  assert.ok(row, '审批在列');
  assert.equal(row.state, 'pending');
  assert.equal(row.namespace, 'worker');
  assert.equal(row.operations, 1);
  assert.deepEqual(row.operationDetails.map((op) => ({ kind: op.kind, proposedText: op.proposedText, stagingId: op.stagingId })), [
    { kind: 'add', proposedText: '巩固新增：审批链路真实生效验证。', stagingId: note.stagingId }
  ], '审批读面提供真实操作正文，供用户批准前核对');
  assert.ok(row.previewDiff.length === 1 && row.previewDiff[0].startsWith('+'), '预览 diff 在列');

  const decided = memoryCenterDecideApproval(ws, approvalId, 'approve');
  assert.equal(decided.ok, true, `approve 应成功：${decided.error ?? ''}`);
  assert.deepEqual(
    { applied: decided.execution.applied, total: decided.execution.total, mode: decided.execution.mode },
    { applied: 1, total: 1, mode: 'rewrite' }
  );
  // 真实生效：条目已写入策展文件
  const workerNow = fs.readFileSync(WORKER_REL, 'utf8');
  assert.ok(workerNow.includes('基线条目'), '批准新增不会丢失原有记忆');
  assert.ok(workerNow.includes('巩固新增：审批链路真实生效验证。'), '批准后真实写入');
  // consolidation_log 有 approve 回执行；审批列表带回执文本
  const log = listConsolidationLog(svc.init(ws), 20);
  assert.ok(log.some((l) => (l.triggerSource ?? '').startsWith(`approval:${approvalId}:approved`)));
  const list2 = memoryCenterApprovals(ws);
  assert.equal(list2.items.find((a) => a.id === approvalId).receiptText.includes('审批通过'), true);
  assert.equal(memoryCenterBadge(ws).pending, 0);
}

/* ---------------- 4. 审批队列：reject 退场 ---------------- */
{
  const note = noteStaging(svc.init(ws), {
    text: '巩固候选：将被驳回退场。',
    origin: 'worker',
    sessionKind: 'worker',
    taskId: null,
    observedAt: Date.now(),
    signals: { source: 'test' }
  });
  const approvalId = enqueueConsolidationApproval(svc.init(ws), {
    namespace: 'worker',
    targetFileRel: 'docs/memory/MEMORY.md',
    baseHash: '',
    baseContentChars: 0,
    operations: [{ op: 'add', text: '巩固候选：将被驳回退场。', confidence: 0.5, stagingId: note.stagingId, citation: `Source: staging#${note.stagingId}` }],
    reason: 'test',
    now: Date.now()
  });
  const workerBefore = fs.readFileSync(WORKER_REL, 'utf8');
  const decided = memoryCenterDecideApproval(ws, approvalId, 'reject');
  assert.equal(decided.ok, true);
  assert.equal(decided.decision, 'rejected');
  assert.equal(fs.readFileSync(WORKER_REL, 'utf8'), workerBefore, '驳回不改策展文件');
  const list = memoryCenterApprovals(ws);
  assert.equal(list.items.find((a) => a.id === approvalId).state, 'rejected');
  // 重复裁决幂等拒绝
  const again = memoryCenterDecideApproval(ws, approvalId, 'approve');
  assert.equal(again.ok, false);
  assert.match(again.error, /已裁决/);
}

/* ---------------- 5. 晋升审阅时间线映射 ---------------- */
{
  const r = memoryCenterLog(ws, 50);
  // §3 approve 与 §4 reject 各写一条 consolidation_log
  assert.ok(r.items.length >= 2, 'approve/reject 回执在时间线');
  const sources = r.items.map((i) => i.triggerSource ?? '');
  assert.ok(sources.some((s) => /approval:\d+:approved$/.test(s)), 'approve 回执行在列');
  assert.ok(sources.some((s) => /approval:\d+:rejected$/.test(s)), 'reject 回执行在列');
  const first = r.items[0];
  assert.equal(typeof first.id, 'number');
  assert.equal(typeof first.addedCount, 'number');
  assert.ok(first.rejectedCounts !== undefined && typeof first.rejectedCounts === 'object');
}

/* ---------------- 6. 回收站：preimages 列表与一键回滚 ---------------- */
{
  // 直接造一条前镜像：当前 worker 文件 → 改写 → 回滚
  const db = svc.init(ws);
  const before = fs.readFileSync(WORKER_REL, 'utf8');
  db.write((tx) =>
    tx.prepare('INSERT INTO preimages (file_path, content, content_hash, cause, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(WORKER_REL, before, 'x'.repeat(16), 'consolidation:test', Date.now())
  );
  const row = db.handle.prepare('SELECT id FROM preimages ORDER BY id DESC LIMIT 1').get();

  const recycle = memoryCenterRecycle(ws);
  assert.equal(recycle.preimages[0].id, Number(row.id));
  assert.equal(recycle.preimages[0].fileRel, 'docs/memory/MEMORY.md');
  assert.equal(recycle.preimages[0].namespace, 'worker');
  assert.ok(recycle.preimages[0].preview.length > 0);

  // 外部改写文件后回滚
  fs.writeFileSync(WORKER_REL, before + '\n<!-- 2026-09-21 13:00:00 [x9] -->\n#lesson 外部追加。\n', 'utf8');
  const rb = memoryCenterRollback(ws, Number(row.id));
  assert.equal(rb.ok, true, rb.error ?? '');
  assert.equal(rb.fileRel, 'docs/memory/MEMORY.md');
  assert.ok(rb.safetyPreimageId != null, '回滚前现状另存为新镜像（可撤销）');
  assert.equal(fs.readFileSync(WORKER_REL, 'utf8'), before, '文件已恢复到镜像内容');
  // 安全镜像入列，cause=rollback:<id>
  const recycle2 = memoryCenterRecycle(ws);
  const safety = recycle2.preimages.find((p) => p.id === rb.safetyPreimageId);
  assert.ok(safety, '安全镜像在列');
  assert.equal(safety.cause, `rollback:${Number(row.id)}`);

  // 幂等 no-op：内容一致 → ok 且不再造镜像
  const rb2 = memoryCenterRollback(ws, Number(row.id));
  assert.equal(rb2.ok, true);
  assert.equal(rb2.safetyPreimageId, null);

  // 非策展文件的前镜像拒绝回滚
  const foreign = path.join(ws, 'docs', 'other.md');
  fs.writeFileSync(foreign, 'x', 'utf8');
  db.write((tx) =>
    tx.prepare('INSERT INTO preimages (file_path, content, content_hash, cause, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(foreign, 'y', 'y'.repeat(16), 'test', Date.now())
  );
  const foreignId = Number(db.handle.prepare('SELECT id FROM preimages ORDER BY id DESC LIMIT 1').get().id);
  const rb3 = memoryCenterRollback(ws, foreignId);
  assert.equal(rb3.ok, false);
  assert.match(rb3.error, /策展核心/);

  // 不存在的前镜像
  const rb4 = memoryCenterRollback(ws, 999999);
  assert.equal(rb4.ok, false);
}

/* ---------------- 7. 索引状态读数 ---------------- */
{
  const db = svc.init(ws);
  // 先跑一次索引同步（BM25；无 provider）——策展文件进 chunks
  await svc.ensureIndex(ws);
  // 造几种 source_type + 转录会话去重
  insertChunk(db, { sourceType: 'transcript', sourcePath: 'agent-session:t1', text: '转录一', fts: '转录一', origin: 'worker', ingestedSessionId: 't1' });
  insertChunk(db, { sourceType: 'transcript', sourcePath: 'agent-session:t1', text: '转录二', fts: '转录二', origin: 'worker', ingestedSessionId: 't1' });
  insertChunk(db, { sourceType: 'transcript', sourcePath: 'agent-session:t2', text: '转录三', fts: '转录三', origin: 'scheduler', ingestedSessionId: 't2' });
  const st = memoryCenterIndexStatus(ws);
  assert.ok(st.totalChunks >= 3, '全库 chunk 计数（转录 3 块在库）');
  const byType = Object.fromEntries(st.sources.map((s) => [s.sourceType, s.chunks]));
  assert.ok(byType.memory >= 1, '策展 chunk 在列');
  assert.equal(byType.transcript, 3);
  assert.equal(st.transcriptSessions, 2, '转录会话按 ingested_session_id 去重');
}

/* ---------------- 7b. 调度转录索引落 ingestedSessionId（A2-4-2）---------------- */
{
  // 独立工作区：只允许「跑一次 index」产生的 transcript chunk 在库，
  // 这样 transcriptSessions>=1 ⟺ insertChunk 带上了 ingestedSessionId（还原即红）
  const wsT = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-center-ws-tidx-'));
  const dbT = svc.init(wsT);
  const r = indexSchedulerTranscript(dbT, {
    sessionKey: 'pi-sess-a242',
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: '调度转录索引回归第一段：足够长的正文用于越过最短字符门槛并完成一次真实落库。'
      },
      {
        id: 'm2',
        role: 'assistant',
        content: '调度转录索引回归第二段：同样越过门槛，验证多消息窗口逐块携带会话键。'
      }
    ],
    now: Date.now()
  });
  assert.equal(r.ok, true, '索引入口 ok');
  assert.ok(r.added >= 1, '索引至少落一块');
  const stT = memoryCenterIndexStatus(wsT);
  assert.ok(stT.transcriptSessions >= 1, '转录会话计数（indexSchedulerTranscript 落 ingested_session_id）');
}

/* ---------------- 7c. 关库→rm 必须完成（A2-3-1 守卫）---------------- */
{
  // 复刻 sandbox:reset 的痛点：打开中的 sqlite 句柄在 Windows 上锁住库文件与
  // -wal/-shm，目录 rm 直接 EPERM。契约：closeAll() 释放句柄后目录必须可删
  // （还原即红：去掉 closeAll，rm 对着打开中的库文件抛 EPERM/EBUSY）。
  const wsRoot = path.join(tmp, 'memory-center-ws-rm');
  const wsSub = path.join(wsRoot, 'sub');
  fs.mkdirSync(wsSub, { recursive: true });
  svc.init(wsSub);
  await svc.closeAll();
  await assert.doesNotReject(() =>
    fs.promises.rm(wsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  );
  // 修复历史遗留：此处原调用未定义的 ok() 助手（HEAD 上 7c 节即崩），改回与其他
  // 节一致的 console.log 进度行
  console.log('ok: 7c 关库→rm 必须完成：closeAll 释放句柄后目录可删（A2-3-1）');
}

/* ---------------- 8. 两段保存组合链（B6 评审 MAJOR-1）：saveEntry 重写 → updateEntry 挂注解 ---------------- */
{
  // 盘上造已注解条目（结构化 + 行尾注解）
  writeWorker(
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision 旧结论。 <!-- trigger: 词A --> <!-- importance: 6 --> <!-- project: github.com/foo/bar -->\n'
  );
  const before = memoryCenterEntries(ws, NOW);
  const target = before.entries[0];
  assert.equal(target.importance, 6);
  assert.deepEqual(target.trigger, ['词A']);

  // 前提守卫：第一段（legacy memory:saveEntry 原位替换）确实抹掉注解、id 随内容指纹变化
  // （serializeMemoryEntry 不渲染行尾注解——这正是两段保存必须衔接好的原因）
  const saved = memorySaveEntry(ws, before.files.worker.hash, {
    id: target.id,
    tags: ['decision'],
    links: [],
    text: '改写后的新结论。'
  });
  assert.equal(saved.stale, false);
  assert.ok(!fs.readFileSync(WORKER_REL, 'utf8').includes('<!-- importance'), '第一段抹注解（bug 前提成立）');
  const savedEntry = saved.entries.find((e) => e.id !== target.id && e.text.includes('改写后的新结论。'));
  assert.ok(savedEntry, '重写后 id 已变（内容指纹），旧 id 不在返回列表');

  // 第二段（renderer 修复后的调用形态）：以新 id + matchText 挂回注解 → 盘上新文本与注解俱在
  const patched = memoryCenterUpdateEntry(
    ws,
    {
      namespace: 'worker',
      id: savedEntry.id,
      hash: saved.hash,
      trigger: ['词B', '新词'],
      importance: 9,
      repoKey: 'github.com/x/y',
      matchText: '改写后的新结论。'
    },
    NOW
  );
  assert.equal(patched.stale, false);
  const onDisk = fs.readFileSync(WORKER_REL, 'utf8');
  assert.ok(onDisk.includes('改写后的新结论。'), '新文本在盘');
  assert.ok(onDisk.includes('<!-- trigger: 词B, 新词 -->'), 'trigger 注解挂回');
  assert.ok(onDisk.includes('<!-- importance: 9 -->'), 'importance 注解挂回');
  assert.ok(onDisk.includes('<!-- project: github.com/x/y -->'), 'project 注解挂回');

  // 方案 B（服务侧回退）：调用方仍持旧 id（定位失手形态）→ 按 matchText 唯一匹配兜底
  const before2 = memoryCenterEntries(ws, NOW);
  const e2 = before2.entries.find((e) => e.text.includes('改写后的新结论。'));
  const saved2 = memorySaveEntry(ws, before2.files.worker.hash, {
    id: e2.id,
    tags: ['decision'],
    links: [],
    text: '第三次改写。'
  });
  assert.equal(saved2.stale, false);
  const rescued = memoryCenterUpdateEntry(
    ws,
    { namespace: 'worker', id: e2.id /* 故意传重写前的旧 id */, hash: saved2.hash, importance: 5, matchText: '第三次改写。' },
    NOW
  );
  assert.equal(rescued.stale, false, '旧 id 经 matchText 回退定位成功');
  const onDisk2 = fs.readFileSync(WORKER_REL, 'utf8');
  assert.ok(onDisk2.includes('第三次改写。') && onDisk2.includes('<!-- importance: 5 -->'), '回退后注解照常落盘');

  // 回退不越权：matchText 无命中/多命中（同文重复）→ 保持「条目不存在」，不猜
  writeWorker(
    [
      '<!-- 2026-09-02 10:00:00 [s2] -->',
      '#lesson 同文甲。',
      '',
      '<!-- 2026-09-02 10:00:00 [s2] -->',
      '#lesson 同文甲。'
    ].join('\n') + '\n'
  );
  const amb = memoryCenterEntries(ws, NOW);
  assert.throws(
    () =>
      memoryCenterUpdateEntry(
        ws,
        { namespace: 'worker', id: 'nope', hash: amb.files.worker.hash, importance: 3, matchText: '同文甲。' },
        NOW
      ),
    /nope/,
    'matchText 多命中不回退'
  );
  assert.throws(
    () =>
      memoryCenterUpdateEntry(
        ws,
        { namespace: 'worker', id: 'nope', hash: amb.files.worker.hash, importance: 3, matchText: '查无此文的正文。' },
        NOW
      ),
    /nope/,
    'matchText 无命中不回退'
  );
}

/* ---------------- 9. updateEntry 字段 no-op 语义（MINOR-1）+ IPC 入参归一 ---------------- */
{
  // normalize 层：undefined 直通（=不改该字段），不再强转 null（null 语义是「清除」）
  const norm = normalizeMemoryCenterUpdateEntryInput({ namespace: 'worker', id: 'x', hash: 'h' });
  assert.equal(norm.importance, undefined, 'importance undefined 直通');
  assert.equal(norm.trigger, undefined);
  assert.equal(norm.repoKey, undefined);
  assert.equal(norm.matchText, undefined);
  const norm2 = normalizeMemoryCenterUpdateEntryInput({ importance: null, trigger: [], repoKey: '  k  ', matchText: '  t  ' });
  assert.equal(norm2.importance, null, 'null=清除 语义保留');
  assert.deepEqual(norm2.trigger, []);
  assert.equal(norm2.repoKey, '  k  ', 'repoKey 原样透传（trim 归服务层，同旧行为）');
  assert.equal(norm2.matchText, '  t  ', 'matchText 原样透传（服务侧 trim）');

  // 端到端：只改 trigger（importance 不传）→ 既有 importance 不被误清
  writeWorker('<!-- 2026-09-03 10:00:00 [s3] -->\n#decision 无操作语义。 <!-- importance: 7 -->\n');
  const st = memoryCenterEntries(ws, NOW);
  const ent = st.entries[0];
  const r = memoryCenterUpdateEntry(ws, { namespace: 'worker', id: ent.id, hash: st.files.worker.hash, trigger: ['新词'] }, NOW);
  assert.equal(r.stale, false);
  const after = r.entries[0];
  assert.deepEqual(after.trigger, ['新词']);
  assert.equal(after.importance, 7, 'importance 未传 = 保持原值（no-op）');
}

/* ---------------- 10. 审批目标文件白名单（MINOR-4 防御纵深） ---------------- */
{
  writeWorker('<!-- 2026-09-01 10:00:00 [s1] -->\n#decision 白名单基线。\n');
  const note = noteStaging(svc.init(ws), {
    text: '白名单验证晋升条目。',
    origin: 'worker',
    sessionKind: 'worker',
    taskId: null,
    observedAt: Date.now(),
    signals: { source: 'test' }
  });
  assert.equal(note.ok, true);
  // payload 携带越权目标（非 canonical 策展核心路径——白名单只认两份 MEMORY.md）
  const rogueRel = 'docs/memory/evil.md';
  const approvalId = enqueueConsolidationApproval(svc.init(ws), {
    namespace: 'worker',
    targetFileRel: rogueRel,
    baseHash: createHash('sha256').update(fs.readFileSync(WORKER_REL, 'utf8')).digest('hex'),
    baseContentChars: 0,
    operations: [
      { op: 'add', text: '白名单验证晋升条目。', confidence: 0.5, stagingId: note.stagingId, citation: `Source: staging#${note.stagingId}` }
    ],
    reason: 'test',
    now: Date.now()
  });
  const decided = memoryCenterDecideApproval(ws, approvalId, 'approve');
  assert.equal(decided.ok, true, decided.error ?? '');
  // 写入落在 canonical worker 策展文件，越权路径未被创建
  assert.ok(fs.readFileSync(WORKER_REL, 'utf8').includes('白名单验证晋升条目。'), 'canonical 文件收到写入');
  assert.ok(!fs.existsSync(path.join(ws, 'docs', 'memory', 'evil.md')), '越权目标未被写');
}

/* ---------------- 12. 暂存池（条目 6A）：列表 / 丢弃 / 撤销 / 物理出池 ---------------- */
{
  // 独立工作区保证状态干净
  const wsS = path.join(tmp, 'memory-center-ws-pool');
  const dbS = svc.init(wsS);
  const note = noteStaging(dbS, {
    text: '暂存池候选：丢弃后随下次 sweep 物理出池。',
    origin: 'worker',
    sessionKind: 'worker',
    evidencePath: 'agent-session:pool'
  });
  const ttlDays = 14;
  const list1 = memoryCenterStagingList(wsS, { ttlDays });
  const item = list1.items.find((i) => i.stagingId === note.stagingId);
  assert.ok(item, '候选在暂存池列表');
  assert.equal(item.state, 'pending');
  assert.equal(item.namespace, 'worker');
  assert.ok(item.expireAt === item.createdAt + ttlDays * 86_400_000, 'expireAt=createdAt+TTL（倒计时口径与巩固配置同源）');
  assert.deepEqual(item.signals, { recallEvents: 0, uniqueQueries: 0, relevanceMean: null }, '无召回信号原样暴露');
  assert.equal(list1.pendingCount, 1, '积压数=未过期 pending（脑图 n-staging 徽标同源）');

  // 丢弃：状态 user_discarded、退出巩固装载面、仍灰显在列表
  assert.equal(memoryCenterStagingDiscard(wsS, note.stagingId).ok, true);
  const list2 = memoryCenterStagingList(wsS, { ttlDays });
  assert.equal(list2.items.find((i) => i.stagingId === note.stagingId).state, 'user_discarded', '丢弃行灰显保留');
  assert.equal(list2.pendingCount, 0, '丢弃行不计积压');
  assert.equal(
    listStagingCandidates(dbS).some((c) => c.stagingId === note.stagingId),
    false,
    'user_discarded 不进巩固装载面（sweep 只吃 pending）'
  );

  // 撤销：清标记无损恢复
  assert.equal(memoryCenterStagingUndiscard(wsS, note.stagingId).ok, true);
  assert.equal(
    memoryCenterStagingList(wsS, { ttlDays }).items.find((i) => i.stagingId === note.stagingId).state,
    'pending',
    '撤销后回 pending'
  );

  // 再丢弃 → sweep 物理出池（整行 + 镜像 chunk 删除，出池后不可恢复）
  assert.equal(memoryCenterStagingDiscard(wsS, note.stagingId).ok, true);
  assert.equal(sweepDiscardedStaging(dbS), 1, '物理出池一条');
  assert.equal(
    memoryCenterStagingList(wsS, { ttlDays }).items.some((i) => i.stagingId === note.stagingId),
    false,
    '出池后从暂存池消失'
  );
  assert.equal(dbS.handle.prepare('SELECT count(*) n FROM chunks WHERE staging_id = ?').get(note.stagingId).n, 0, '镜像 chunk 随删');

  const older = noteStaging(dbS, { text: '较早候选：发布前确认数据库迁移脚本。', origin: 'worker', sessionKind: 'worker' });
  const newer = noteStaging(dbS, { text: '较新候选：发布前确认回滚脚本。', origin: 'worker', sessionKind: 'worker' });
  const discarded = noteStaging(dbS, { text: '已丢弃候选：保留用于撤销验证。', origin: 'worker', sessionKind: 'worker' });
  assert.ok(older.ok && newer.ok && discarded.ok);
  assert.equal(memoryCenterStagingDiscard(wsS, discarded.stagingId).ok, true);
  assert.deepEqual(memoryCenterStagingList(wsS, { ttlDays }).items.map((i) => i.stagingId),
    [newer.stagingId, older.stagingId, discarded.stagingId], '面板先显示最新待处理候选，已丢弃的靠后');

  // 非法入参 / 不存在候选
  assert.equal(memoryCenterStagingDiscard(wsS, 0).ok, false);
  assert.equal(memoryCenterStagingDiscard(wsS, 999999).ok, false, '不存在的候选如实拒绝');
  assert.equal(memoryCenterStagingUndiscard(wsS, 999999).ok, false);
  console.log('ok: 12 暂存池读面（列表/丢弃/撤销/物理出池/积压数同源）');
}

/* ---------------- 13. M1 数据面：log payload 兼容 + 事件流读面 + entries 召回字段 ---------------- */
{
  const db = svc.init(ws);
  // 13a 旧格式 log 行（v4 前无 payload）兼容：payload=null 只显示计数，不炸
  db.write((tx) =>
    tx
      .prepare(
        "INSERT INTO consolidation_log (trigger_source, added_count, merged_count, superseded_count, diff_summary, rejected_counts, started_at, finished_at) VALUES ('consolidation:legacy:worker', 2, 0, 0, '旧行无明细', '{}', ?, ?)"
      )
      .run(Date.now(), Date.now())
  );
  const log = memoryCenterLog(ws, 50);
  const legacy = log.items.find((l) => l.triggerSource === 'consolidation:legacy:worker');
  assert.ok(legacy, '旧行在列');
  assert.equal(legacy.payload, null, '旧格式行 payload=null（读取端宽容）');
  // 新格式行（§3 approve 回执）payload 解析为 DTO 形状
  const withPayload = log.items.find((l) => (l.triggerSource ?? '').startsWith('approval:'));
  assert.ok(withPayload, 'approve 回执行在列');
  assert.ok(withPayload.payload && Array.isArray(withPayload.payload.applied), '新行 payload 解析为 applied/supersededPairs/rejected 形状');

  // 13b 事件流读面（§3/§4/§10 的写点已落账）
  const ev = memoryCenterEvents(ws, { limit: 50 });
  assert.ok(ev.items.length >= 3, `事件流有数（实际 ${ev.items.length}）`);
  assert.ok(ev.items.every((i) => typeof i.kind === 'string' && typeof i.ts === 'number' && typeof i.summary === 'string'), '事件 DTO 字段齐全');
  assert.ok(ev.items.some((i) => i.kind === 'staged'), 'staged 事件在流');
  assert.ok(ev.items.some((i) => i.kind === 'approval_queued'), 'approval_queued 事件在流');
  assert.ok(ev.items.some((i) => i.kind === 'approval_decided'), 'approval_decided 事件在流');
  assert.ok(ev.kindCounts24h && typeof ev.kindCounts24h === 'object', '24h kind 计数面在');
  // 条目 1B 复审补：边流量芯片 hover「近 7 日」取数面（同源聚合、窗口更大）
  assert.ok(ev.kindCounts7d && typeof ev.kindCounts7d === 'object', '7d kind 计数面在');
  assert.ok(
    Object.entries(ev.kindCounts24h).every(([k, n]) => (ev.kindCounts7d[k] ?? 0) >= n),
    '7d 计数 ⊇ 24h 计数（同一聚合函数不同窗口）'
  );

  // 13c entries 召回字段（条目 4A）：落一笔 bootstrap 召回 → 挂条目卡
  await svc.ensureIndex(ws);
  const before = memoryCenterEntries(ws, NOW);
  assert.ok(before.entries.length > 0, '条目在列');
  assert.ok(before.entries.every((e) => 'recall' in e), 'recall 字段在 DTO');
  const target = before.entries.find((e) => e.namespace === 'worker' && !e.unparsed);
  assert.ok(target, '结构化 worker 条目在列');
  const chunkRow = db.handle
    .prepare("SELECT id FROM chunks WHERE source_type = 'memory' AND text = ?")
    .get(target.text);
  assert.ok(chunkRow, '条目正文在索引中（chunkMemorySource 与解析同源）');
  recordRecallStat(db, Number(chunkRow.id), 'bootstrap', 'bootstrap:worker', Date.now(), null);
  recordRecallStat(db, Number(chunkRow.id), 'search_hit', '查询甲', Date.now(), 0.8);
  const after = memoryCenterEntries(ws, NOW);
  const afterEntry = after.entries.find((e) => e.text === target.text);
  assert.ok(afterEntry.recall, '召回聚合挂条目卡');
  assert.equal(afterEntry.recall.injected30d >= 1, true, '注入计数（bootstrap 归注入）');
  assert.equal(afterEntry.recall.hits30d >= 1, true, '命中计数（search_hit 归命中）');
  assert.ok(afterEntry.recall.lastRecalledAt != null, '窗口内最近召回时间在');
  console.log('ok: 13 M1 数据面（log payload 兼容/事件流读面/entries 召回字段）');
}

/* ---------------- 14. 条目 3：来历/血缘派生 + 已取代档（读取端从 log payload 聚合） ---------------- */
{
  // 14a. 基础判定：现役条目 provenance/supersedes 字段恒在；无 log 明细时按注解/会话短 id 派生
  const base = memoryCenterEntries(ws, NOW);
  assert.ok(base.entries.every((e) => 'provenance' in e && 'supersedes' in e), '条目 3 字段在 DTO（兼容读端）');
  const plain = base.entries.find((e) => e.namespace === 'worker' && !e.unparsed && e.sessionId === 's1');
  assert.ok(plain, 's1 条目在列');
  assert.equal(plain.provenance?.kind, 'session', '会话短 id → session 来历');
  assert.equal(plain.provenance.sessionId, 's1');
  assert.equal(plain.supersedes, null, '无取代对 → 血缘 null');

  // 14b. log 明细驱动：写入一行带 payload 的巩固日志（sweep add + supersede 对），
  //      命中条目 → sweep 来历（带轮次）；被取代旧条目进「已取代」档；继任条目挂血缘
  const dbL = svc.init(ws);
  const survivor = base.entries.find((e) => e.namespace === 'worker' && !e.unparsed);
  const logPayload = {
    applied: [
      {
        op: 'supersede',
        stagingId: 1,
        entryId: survivor.id,
        mergedInto: null,
        text: survivor.text,
        confidence: 0.8,
        source: { stagingId: 1, sessionId: 's9', via: 'sweep' },
        signals: { recallCount: 2, relevance: 0.5 }
      }
    ],
    supersededPairs: [
      {
        newEntryId: survivor.id,
        newText: survivor.text,
        oldEntryId: '2026-08-01 09:00:00 [s0]-old-abc',
        oldText: '派活默认 DeepSeek。',
        preimageId: 29
      }
    ],
    rejected: []
  };
  dbL.handle
    .prepare(
      `INSERT INTO consolidation_log (trigger_source, added_count, merged_count, superseded_count, diff_summary, rejected_counts, payload, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('consolidation:task_close:worker', 0, 0, 1, '测试明细', '{}', JSON.stringify(logPayload), 1, Date.now());

  const withLog = memoryCenterEntries(ws, NOW);
  const newEntry = withLog.entries.find((e) => e.id === survivor.id);
  assert.equal(newEntry.provenance?.kind, 'sweep', 'applied[] 命中 → sweep 来历');
  assert.ok(typeof newEntry.provenance.logId === 'number' && newEntry.provenance.logId > 0, '轮次 id 引用在');
  assert.ok(newEntry.supersedes, '继任条目挂血缘');
  assert.equal(newEntry.supersedes.oldEntryId, '2026-08-01 09:00:00 [s0]-old-abc');
  assert.equal(newEntry.supersedes.preimageId, 29);

  // 14c. 已取代档：取代对进列表（retiredAt 倒序）；direct（origin=user）优先于 log 命中
  const retired = memoryCenterSuperseded(ws);
  assert.equal(retired.total >= 1, true, '已取代档非空');
  const hit = retired.items.find((i) => i.oldEntryId === '2026-08-01 09:00:00 [s0]-old-abc');
  assert.ok(hit, '取代对在已取代档');
  assert.equal(hit.newEntryId, survivor.id, '回指继任条目');
  assert.equal(hit.preimageId, 29, '前镜像 id 透传');

  // 14d. 直写 vs 巩固晋升重叠（返修 P1）：origin=user 条目若 id 命中 log applied[]，
  //      真实来历是「巩固轮 #n·你批准的」——不得被 origin=user 误标为直写（判定序回归）
  writeWorker(
    '<!-- 2026-09-03 10:00:00 [memory] -->\n#preference 深色优先。 <!-- origin: user -->\n'
  );
  const dbD = svc.init(ws);
  const directCandidate = memoryCenterEntries(ws, NOW).entries.find((e) => e.text.includes('深色优先'));
  assert.ok(directCandidate, 'origin=user 条目在列');
  assert.equal(directCandidate.provenance?.kind, 'direct', 'log 未命中 + origin=user → 直写');
  const overlapPayload = {
    applied: [
      {
        op: 'add',
        stagingId: 9,
        entryId: directCandidate.id,
        mergedInto: null,
        text: directCandidate.text,
        confidence: 0.7,
        source: { stagingId: 9, sessionId: 's8', via: 'approval' },
        signals: { recallCount: null, relevance: null }
      }
    ],
    supersededPairs: [],
    rejected: []
  };
  dbD.handle
    .prepare(
      `INSERT INTO consolidation_log (trigger_source, added_count, merged_count, superseded_count, diff_summary, rejected_counts, payload, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('consolidation:task_close:worker', 1, 0, 0, '重叠测试', '{}', JSON.stringify(overlapPayload), 1, Date.now());
  const afterOverlap = memoryCenterEntries(ws, NOW).entries.find((e) => e.text.includes('深色优先'));
  assert.equal(afterOverlap.provenance?.kind, 'approval', 'origin=user + log 命中 → 巩固轮（还原判定序即红）');
  assert.ok(typeof afterOverlap.provenance.logId === 'number', '轮次引用在');

  // 14e. manual 短 id → 手工添加；unknown 短 id → session
  writeWorker(
    '<!-- 2026-09-03 10:01:00 [manual] -->\n#lesson 手工条。\n\n<!-- 2026-09-03 10:02:00 [zz9] -->\n#decision 会话条。\n'
  );
  const mixed = memoryCenterEntries(ws, NOW);
  assert.equal(mixed.entries.find((e) => e.text.includes('手工条')).provenance?.kind, 'manual', 'manual → 手工添加');
  assert.equal(mixed.entries.find((e) => e.text.includes('会话条')).provenance?.kind, 'session', '未知短 id → 会话来历');

  console.log('ok: 14 条目 3（来历五态判定/血缘反查/已取代档/直写优先）');
}

console.log('test/memory-center.mjs: all sections passed');
