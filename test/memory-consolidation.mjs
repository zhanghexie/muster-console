/**
 * 记忆重构 P3 巩固引擎（memory-refactor B4）：schema v1→v2 迁移（真 v1 老库升级+
 * 幂等）、pending staging 可检索性与生命周期联动（staging↔chunks 镜像/过期清扫）、
 * 信号门六信号加权与三硬门槛矩阵、污点门前置剔除、巩固模型回合（操作 JSON 与解析
 * 失败回退）、验证组装四失败路径+哈希冲突→append 回退（还原即红抽查）、前镜像与
 * consolidation_log、置信分档路由、审批执行（approve/reject）、触发锁与去抖与空闲兜底；
 * B4 评审修复回归：混批审批基线重抓（sweep(add+supersede)→approve 生效·还原即红）、
 * replacement $ 替换序列按字面落盘、手动巩固入口豁免最小间隔+如实受理返回。
 * Run: node test/memory-consolidation.mjs
 * 全部落系统临时目录（mkdtemp），LLM 调用全注入 mock。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

// 本机 Node 构建缺 fts5（如 22.x 官方 win-x64）时 db 层建库即报 no such module: fts5，
// 属环境能力缺失而非回归——按仓库惯例打印原因后退出 0 跳过（详见 helpers/sqlite-fts5.mjs）。
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-consolidation-'));
const compile = createSharedCompiler(root, tmp);

const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const stagingMod = await import(pathToFileURL(compile('main/memory/staging.ts')).href);
const gatesMod = await import(pathToFileURL(compile('main/memory/consolidation/gates.ts')).href);
const modelMod = await import(pathToFileURL(compile('main/memory/consolidation/model.ts')).href);
const applyMod = await import(pathToFileURL(compile('main/memory/consolidation/apply.ts')).href);
const approvalMod = await import(pathToFileURL(compile('main/memory/consolidation/approval.ts')).href);
const sweepMod = await import(pathToFileURL(compile('main/memory/consolidation/sweep.ts')).href);
const triggerMod = await import(pathToFileURL(compile('main/memory/consolidation/trigger.ts')).href);
const cfgMod = await import(pathToFileURL(compile('shared/memoryConsolidation.ts')).href);

const {
  openMemoryDb,
  createV1Schema,
  insertChunk,
  recordRecallStat,
  searchChunksByFts,
  countChunks,
  listApprovals,
  getApproval,
  listConsolidationLog
} = dbMod;
const { noteStaging, transitionStaging, sweepExpiredStaging } = stagingMod;
const {
  listStagingCandidates,
  computeGateSignals,
  evaluateCandidateGate,
  siftCandidates,
  GATE_WEIGHTS,
  isTaintedOrigin,
  namespaceOfOrigin
} = gatesMod;
const {
  buildConsolidationUserPrompt,
  parseConsolidationOperations,
  runConsolidationModelTurn,
  CONSOLIDATION_MODEL_CONSTANTS
} = modelMod;
const {
  buildSourceCitation,
  sha256Content,
  planConsolidationWrite,
  applyConsolidationOperations,
  writeConsolidationLog,
  APPLY_CONSTANTS
} = applyMod;
const { enqueueConsolidationApproval, decideConsolidationApproval } = approvalMod;
const { runConsolidationSweep } = sweepMod;
const { MemoryConsolidationTrigger } = triggerMod;
const { normalizeMemoryConsolidationConfig, resolveConsolidationTarget } = cfgMod;

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mirrorChunkId(db, stagingId) {
  const row = db.handle.prepare('SELECT id FROM chunks WHERE staging_id = ?').get(stagingId);
  return row ? Number(row.id) : null;
}

/** 造一个带召回统计的 pending 候选；返回 {stagingId, chunkId} */
function seedCandidate(db, opts = {}) {
  const r = noteStaging(db, {
    text: opts.text ?? '用户偏好：测试一律用临时目录，禁止写仓库根 #lesson',
    origin: opts.origin ?? 'worker',
    sessionKind: opts.sessionKind ?? 'worker',
    evidencePath: opts.evidencePath ?? 'agent-session:test',
    observedAt: opts.observedAt ?? null
  });
  assert.ok(r.ok, `noteStaging 应成功：${JSON.stringify(r)}`);
  const chunkId = mirrorChunkId(db, r.stagingId);
  assert.ok(chunkId, '镜像 chunk 应随 staging 落库');
  const recalls = opts.recalls ?? [
    { q: '临时目录', ts: Date.now(), rel: 0.8, kind: 'brief_injected' },
    { q: '测试目录', ts: Date.now() - DAY, rel: 0.6 },
    { q: '临时目录', ts: Date.now() - 2 * DAY, rel: 0.9 }
  ];
  for (const rc of recalls) {
    recordRecallStat(db, chunkId, rc.kind ?? 'search_hit', rc.q, rc.ts, rc.rel);
  }
  return { stagingId: r.stagingId, chunkId };
}

/* ---------------- 1. schema v1→v2 迁移（真 v1 老库升级 + 幂等） ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-migrate');
  const dbFile = path.join(wsRoot, '.muster', 'memory', 'runtime', 'state.sqlite');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  // 手工造真 v1 老库：meta v1 + v1 八表 + 一条 chunk（含 FTS 行）+ 一笔 recall
  const raw = new DatabaseSync(dbFile);
  raw.exec('CREATE TABLE meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
  createV1Schema(raw);
  raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  raw.prepare(
    `INSERT INTO chunks (source_type, source_path, line_start, line_end, text, fts, origin)
     VALUES ('memory', 'docs/memory/MEMORY.md', 1, 2, '旧库记忆条目：嵌套仓要写主仓 exclude', '旧库 记忆 条目 嵌套 仓要 写主 仓 exclude', 'user')`
  ).run();
  raw.prepare('INSERT INTO chunks_fts(rowid, fts) VALUES (1, ?)').run(
    '旧库 记忆 条目 嵌套 仓要 写主 仓 exclude'
  );
  raw.prepare(
    "INSERT INTO recall_stats (chunk_id, kind, query_text, ts) VALUES (1, 'search_hit', '旧库', 1710000000000)"
  ).run();
  raw.close();

  const db = openMemoryDb(wsRoot);
  assert.equal(db.schemaVersion(), 5, '老 v1 库打开即迁当前版本（v2 镜像 → v3 bootstrap → v4 事件账本 → v5 审批执行日志）');
  assert.equal(countChunks(db), 1, '迁移保数据：chunk 不丢');
  const hits = searchChunksByFts(db, '旧库');
  assert.ok(hits.length === 1 && hits[0].text.includes('嵌套仓'), 'FTS 外部内容表随迁移重建且可命中');
  // v2 新面可用：staging 镜像 chunk（source_type='staging' 原本被 v1 CHECK 拒）
  const seeded = seedCandidate(db);
  assert.ok(seeded.chunkId, 'v2 允许 staging 镜像 chunk');
  // relevance 列：老行为 NULL=未记录，新写入可带分
  recordRecallStat(db, seeded.chunkId, 'search_hit', '新查询', Date.now(), 0.7);
  const rel = db.handle
    .prepare('SELECT relevance FROM recall_stats WHERE chunk_id = ? AND query_text = ?')
    .get(seeded.chunkId, '新查询');
  assert.ok(Math.abs(Number(rel.relevance) - 0.7) < 1e-9, 'recall_stats.relevance 落库');
  const oldRel = db.handle
    .prepare('SELECT relevance FROM recall_stats WHERE chunk_id = 1')
    .get();
  assert.equal(oldRel.relevance, null, '老 recall 行 relevance 保持 NULL（门按中性 0.5 处理）');
  // 幂等：重开仍是 v2、数据原样
  db.close();
  const db2 = openMemoryDb(wsRoot);
  assert.equal(db2.schemaVersion(), 5, '重开不重复迁移');
  assert.equal(countChunks(db2), 2, '重开数据原样');
  db2.close();
  // 全新库直接 v2
  const fresh = openMemoryDb(path.join(tmp, 'ws-fresh'));
  assert.equal(fresh.schemaVersion(), 5, '全新库直接当前版本');
  fresh.close();
  console.log('ok: 1 迁移 v1→v2（老库升级/幂等/全新库）');
}

/* ---------------- 2. pending staging 可检索性 + 生命周期三态 ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-lifecycle'));
  const { stagingId, chunkId } = seedCandidate(db);
  const hits = searchChunksByFts(db, '临时目录');
  assert.ok(hits.some((h) => h.id === chunkId), 'pending staging 镜像 chunk 可检索');
  assert.ok(
    hits.some((h) => h.sourceType === 'staging'),
    '命中行 source_type=staging'
  );
  // promoted：状态迁移 + 镜像 chunk（含 recall 账目）删除
  assert.equal(transitionStaging(db, stagingId, 'promoted'), true);
  assert.equal(mirrorChunkId(db, stagingId), null, 'promoted 后镜像 chunk 删除');
  assert.equal(transitionStaging(db, stagingId, 'promoted'), false, '迁移幂等（已迁移 no-op）');
  const cnt = db.handle.prepare('SELECT count(*) n FROM recall_stats WHERE chunk_id = ?').get(chunkId);
  assert.equal(Number(cnt.n), 0, '镜像 chunk 的 recall 账目随删');
  // rejected：同路径
  const s2 = seedCandidate(db, { text: '另一条候选：Windows 下丢弃输出用 /dev/null' });
  assert.equal(transitionStaging(db, s2.stagingId, 'rejected'), true);
  assert.equal(mirrorChunkId(db, s2.stagingId), null, 'rejected 后镜像 chunk 删除');
  // expired：TTL 可配的过期清扫（基准=created_at——入暂存时刻；SQL 回填造真旧行）
  const now = Date.now();
  const s3 = seedCandidate(db, { text: '过期候选：很老的观察', observedAt: now - 20 * DAY });
  db.handle
    .prepare('UPDATE staging SET created_at = ? WHERE id = ?')
    .run(now - 20 * DAY, s3.stagingId);
  const s4 = seedCandidate(db, { text: '新鲜候选：近期观察' });
  const expired = sweepExpiredStaging(db, now, 14);
  assert.equal(expired, 1, '超 TTL 的 pending 过期清扫条数');
  assert.equal(mirrorChunkId(db, s3.stagingId), null, 'expired 后镜像 chunk 删除');
  assert.ok(mirrorChunkId(db, s4.stagingId), 'TTL 内候选保留');
  db.close();
  console.log('ok: 2 staging 可检索性+生命周期三态+过期清扫可配');
}

/* ---------------- 3. 信号门：六信号加权 + 三硬门槛矩阵 + 污点门 ---------------- */
{
  const db = openMemoryDb(path.join(tmp, 'ws-gates'));
  // 权重和=1（§6.3 字面）
  const wSum = Object.values(GATE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(wSum - 1) < 1e-9, `六信号权重和=1（实际 ${wSum}）`);
  assert.ok(isTaintedOrigin('untrusted') && isTaintedOrigin('system'), '污点门覆盖 untrusted/system');
  assert.ok(!isTaintedOrigin('user') && !isTaintedOrigin('worker') && !isTaintedOrigin('scheduler'), '非污点面不误伤');
  assert.equal(namespaceOfOrigin('scheduler'), 'scheduler', 'scheduler 候选归调度命名空间');
  assert.equal(namespaceOfOrigin('user'), 'profile', 'user（用户亲述）候选归画像命名空间（B7 §10 路由）');
  assert.equal(namespaceOfOrigin('worker'), 'worker', 'worker 候选归 Worker 命名空间');

  const now = Date.now();
  const strong = seedCandidate(db); // 3 召回/2 查询/3 日/rel≈0.77/新近
  const weakRecall = seedCandidate(db, {
    text: '弱候选：只被召回一次',
    recalls: [{ q: '唯一查询', ts: now, rel: 0.9 }]
  });
  const noRel = seedCandidate(db, {
    text: '无相关分候选：召回未记 relevance',
    recalls: [
      { q: '查询一', ts: now, rel: null },
      { q: '查询二', ts: now - DAY, rel: null }
    ]
  });
  const sameQuery = seedCandidate(db, {
    text: '弱候选：两次召回同一查询',
    recalls: [
      { q: '同查询', ts: now, rel: 0.9 },
      { q: '同查询', ts: now - DAY, rel: 0.9 }
    ]
  });
  const stale = seedCandidate(db, {
    text: '陈旧候选：六十天前观察，信号全衰',
    observedAt: now - 60 * DAY,
    recalls: [
      { q: '老查询甲', ts: now - 55 * DAY, rel: null },
      { q: '老查询乙', ts: now - 54 * DAY, rel: null }
    ]
  });
  const tainted = seedCandidate(db, { origin: 'untrusted', text: '污点候选：网页推导内容' });
  const schedulerNs = seedCandidate(db, { origin: 'scheduler', text: '调度候选：属另一命名空间' });

  const candidates = listStagingCandidates(db);
  assert.equal(candidates.length, 7, '候选装载含全部 pending');
  const byText = (kw) => candidates.find((c) => c.text.includes(kw));
  const strongC = byText('用户偏好');
  assert.equal(strongC.recallEvents, 3, '召回事件数聚合');
  assert.equal(strongC.uniqueQueries, 2, 'distinct 查询聚合');
  assert.equal(strongC.distinctDays, 3, 'distinct 自然日聚合（多日复现）');
  assert.ok(Math.abs(strongC.relevanceMean - 0.7666666666) < 1e-6, 'relevance 均值');

  // 纯信号：无样本 relevance 中性 0.5；饱和归一
  const sig = computeGateSignals(strongC, now);
  assert.ok(Math.abs(sig.relevance - strongC.relevanceMean) < 1e-9, 'relevance 信号=均值');
  assert.ok(Math.abs(sig.frequency - 1 / 5) < 1e-9, '普通搜索命中不计入强使用频次');
  assert.ok(Math.abs(sig.consolidation - 1) < 1e-9, '3 日复现饱和=1');
  assert.ok(sig.score >= 0.55, `强候选过线（score=${sig.score.toFixed(3)}）`);
  const neutralRel = computeGateSignals(byText('召回未记 relevance'), now);
  assert.equal(neutralRel.relevance, 0.5, 'NULL relevance 中性 0.5');

  const T = { minScore: 0.55, minRecallCount: 2, minUniqueQueries: 2 };
  const dStrong = evaluateCandidateGate(strongC, T, now);
  assert.ok(dStrong.passed, `强候选全过硬门槛（${JSON.stringify(dStrong.failures)}）`);
  const dWeakRecall = evaluateCandidateGate(byText('只被召回一次'), T, now);
  assert.ok(!dWeakRecall.passed && dWeakRecall.failures.includes('recall_count'), '召回数不足拒');
  assert.ok(dWeakRecall.failures.includes('search_only'), '纯检索命中不构成晋升依据');
  const dSameQuery = evaluateCandidateGate(byText('同一查询'), T, now);
  assert.ok(!dSameQuery.passed && dSameQuery.failures.includes('unique_queries'), '查询多样性不足拒');
  const dStale = evaluateCandidateGate(byText('六十天前'), T, now);
  assert.ok(!dStale.passed && dStale.failures.includes('score'), '总分不足拒（陈旧衰减）');

  // sift：污点门前置剔除 + 命名空间分拣 + 门槛（按分数降序）
  const sift = siftCandidates(candidates, 'worker', T, now);
  assert.equal(sift.tainted, 1, '污点候选结构性剔除');
  assert.equal(sift.otherNamespace, 1, '调度候选分去 scheduler 命名空间');
  assert.equal(sift.gateFailed, 4, '四个弱候选门未过');
  assert.equal(sift.passed.length, 1, '仅强候选进门');
  assert.equal(sift.passed[0].stagingId, strong.stagingId);
  const siftS = siftCandidates(candidates, 'scheduler', T, now);
  assert.equal(siftS.passed.length, 1, 'scheduler 命名空间收到调度候选');
  void tainted;
  void weakRecall;
  void sameQuery;
  void stale;
  void schedulerNs;
  db.close();
  console.log('ok: 3 信号门矩阵+污点门前置剔除+命名空间分拣');
}

/* ---------------- 4. 巩固模型回合：提示词/操作 JSON 解析/失败回退 ---------------- */
{
  const candidates = [
    {
      candidate: {
        stagingId: 7,
        text: '候选正文：CI 里 pnpm 会被 packageManager 字段挡下 #lesson',
        origin: 'worker',
        sessionKind: 'worker',
        taskId: null,
        repoKey: null,
        observedAt: Date.now(),
        evidencePath: 'agent-session:s1',
        createdAt: Date.now(),
        chunkId: 11,
        recallEvents: 3,
        uniqueQueries: 2,
        relevanceMean: 0.8,
        distinctDays: 3,
        signals: computeGateSignals(
          {
            stagingId: 7,
            text: '候选正文：CI 里 pnpm 会被 packageManager 字段挡下 #lesson',
            origin: 'worker',
            sessionKind: 'worker',
            taskId: null,
            repoKey: null,
            observedAt: Date.now(),
            evidencePath: 'agent-session:s1',
            createdAt: Date.now(),
            chunkId: 11,
            recallEvents: 3,
            uniqueQueries: 2,
            relevanceMean: 0.8,
            distinctDays: 3
          },
          Date.now()
        )
      },
      citation: 'Source: agent-session:s1'
    }
  ];
  const prompt = buildConsolidationUserPrompt('<!-- 2026-01-01 00:00:00 [s0] -->\n#seed 旧条目', candidates);
  assert.ok(prompt.includes('候选 7'), '提示词含候选编号');
  assert.ok(prompt.includes('Source: agent-session:s1'), '提示词含证据引用');
  assert.ok(prompt.includes('packageManager'), '提示词含候选正文');
  assert.ok(prompt.includes('旧条目'), '提示词含策展文件全文');

  const opsJson = JSON.stringify({
    operations: [
      { op: 'add', candidateId: 7, text: '#lesson CI 用 npm run，pnpm 被 packageManager 挡', reason: '高频坑', confidence: 1.4 },
      { op: 'supersede', candidateId: 7, text: '新正文', oldSnippet: '旧条目', reason: '取代', confidence: 0.4 }
    ]
  });
  const parsed = parseConsolidationOperations(opsJson);
  assert.equal(parsed.length, 2, '操作 JSON 解析');
  assert.equal(parsed[0].confidence, 1, 'confidence 钳位 0–1');
  assert.equal(parsed[1].oldSnippet, '旧条目', 'oldSnippet 保留');
  assert.equal(parseConsolidationOperations('```json\n' + opsJson + '\n```').length, 2, '剥代码围栏');
  assert.equal(parseConsolidationOperations('不是 JSON'), null, '非 JSON → null');
  assert.equal(parseConsolidationOperations('{"operations":"nope"}'), null, 'operations 非数组 → null');
  assert.equal(parseConsolidationOperations('{"operations":[{"op":"delete"}]}').length, 0, '未知 op 类型丢弃');

  // 模型回合：mock 成功 / 解析失败回退
  const okTurn = await runConsolidationModelTurn({
    curatedContent: '文件内容',
    candidates,
    callModel: async () => opsJson,
    timeoutMs: 2_000
  });
  assert.ok(okTurn.ok && okTurn.operations.length === 2, 'mock 模型回合成功');
  const badTurn = await runConsolidationModelTurn({
    curatedContent: '文件内容',
    candidates,
    callModel: async () => '模型散文输出，没有 JSON',
    timeoutMs: 2_000
  });
  assert.ok(!badTurn.ok && badTurn.error.includes('解析失败'), '解析失败 → ok:false 带 error（回退路径）');
  const emptyTurn = await runConsolidationModelTurn({
    curatedContent: '文件内容',
    candidates: [],
    callModel: async () => {
      throw new Error('不应调用');
    }
  });
  assert.ok(emptyTurn.ok && emptyTurn.operations.length === 0, '零候选不调模型直接空操作');
  // MAX_CANDIDATES 上限在 sweep 侧生效（常量面断言）
  assert.ok(CONSOLIDATION_MODEL_CONSTANTS.MAX_CANDIDATES >= 1, '候选上限常量在册');
  console.log('ok: 4 模型回合（提示词/解析/失败回退）');
}

/* ---------------- 5. 验证组装：四失败路径 + happy rewrite（纯函数） ---------------- */
{
  const now = new Date('2026-09-21T10:00:00Z');
  const content = [
    '<!-- 2026-01-01 00:00:00 [s1] -->',
    '#seed 第一条旧条目，内容甲。',
    '',
    '<!-- 2026-02-02 00:00:00 [s2] -->',
    '#seed 第二条旧条目，内容乙。'
  ].join('\n');
  const evidence = [
    { stagingId: 31, evidencePath: 'agent-session:s1', lineStart: 3, lineEnd: 9 },
    { stagingId: 32, evidencePath: 'agent-session:s1', lineStart: 3, lineEnd: 9 }
  ];
  const base = { currentContent: content, evidence, budgetChars: 16_000, surface: 'worker', now };

  // happy：add + supersede（唯一匹配）→ rewrite 模式
  const happy = planConsolidationWrite({
    ...base,
    ops: [
      { op: 'add', candidateId: 31, text: '#lesson 新条目：原子写', confidence: 0.9 },
      { op: 'supersede', candidateId: 31, text: '合并后的新正文', oldSnippet: '第一条旧条目，内容甲。', confidence: 0.5 }
    ]
  });
  assert.equal(happy.mode, 'rewrite', '唯一匹配改写走 rewrite');
  assert.equal(happy.applied.length, 2, 'add+supersede 都应用');
  assert.ok(happy.content.includes('Source: agent-session:s1#L3-L9'), '晋升条目带 Source 引用行');
  assert.ok(happy.content.includes('合并后的新正文'), '替换正文生效');
  assert.ok(happy.content.includes('第二条旧条目'), '无关条目不动');

  // 歧义：oldSnippet 双出现 → 只拒该操作
  const dupContent = `${content}\n<!-- 2026-03-03 00:00:00 [s3] -->\n#seed 第三条，内容甲。`;
  const amb = planConsolidationWrite({
    ...base,
    currentContent: dupContent,
    ops: [{ op: 'merge', candidateId: 31, text: 'x', oldSnippet: '内容甲。', confidence: 0.9 }]
  });
  assert.ok(amb.rejected.some((r) => r.category === 'ambiguous'), '双匹配 → ambiguous 拒');
  assert.equal(amb.applied.length, 0, '歧义操作不应用');
  const zero = planConsolidationWrite({
    ...base,
    ops: [{ op: 'merge', candidateId: 31, text: 'x', oldSnippet: '不存在的片段', confidence: 0.9 }]
  });
  assert.ok(zero.rejected.some((r) => r.category === 'ambiguous'), '零匹配 → ambiguous 拒');

  // $ 替换序列污染（B4 评审 MINOR-1·还原即红）：replacement 正文含 $&/$`/$'/$$ 须按字面落盘
  const dContent = '前文锚点，用于垫高原文体量。\n目标片段\n后文锚点，同样用于垫高。';
  const dollar = planConsolidationWrite({
    ...base,
    currentContent: dContent,
    ops: [
      { op: 'supersede', candidateId: 31, text: "正文含 $& $$ $` $' 替换序列", oldSnippet: '目标片段', confidence: 0.5 }
    ]
  });
  assert.equal(dollar.mode, 'rewrite', '$ 序列用例走改写');
  assert.ok(
    dollar.content.includes("正文含 $& $$ $` $' 替换序列"),
    'replacement 的 $ 序列按字面写入（字符串形态会被 JS 当替换序列展开）'
  );
  assert.equal(
    dollar.content.split('前文锚点，用于垫高原文体量。').length - 1,
    1,
    "$` 不把匹配前文插进 replacement"
  );
  assert.equal(
    dollar.content.split('后文锚点，同样用于垫高。').length - 1,
    1,
    "$' 不把匹配后文插进 replacement"
  );

  // ①超损失：oldSnippet > 25% 原文 → sweep 级回退 append
  const bigSnippet = content.slice(0, Math.ceil(content.length * 0.5));
  const loss = planConsolidationWrite({
    ...base,
    ops: [
      { op: 'supersede', candidateId: 31, text: 'x', oldSnippet: bigSnippet, confidence: 0.9 },
      { op: 'add', candidateId: 31, text: '追加不受影响', confidence: 0.9 }
    ]
  });
  assert.equal(loss.mode, 'append', '超损失界 → 回退 append-only');
  assert.ok(loss.rejected.some((r) => r.category === 'over_loss'), '改写操作按 over_loss 拒');
  assert.ok(loss.applied.some((a) => a.op === 'add'), '回退后 add 仍追加');
  assert.ok(loss.content.includes(bigSnippet), '回退后旧内容原样保留');

  // ①超损失 × lossGuard:'none'（审批路径）：同输入不再被损失界拦，改写正常生效
  //   ——2026-10-06 生产事故回归：小文件单条占比高，按全文比例的损失界让人工批准的
  //   merge/supersede 必被拒成零应用；还原 apply.ts 的 lossGuard 分支即红。
  const lossOff = planConsolidationWrite({
    ...base,
    ops: [
      { op: 'supersede', candidateId: 31, text: 'x', oldSnippet: bigSnippet, confidence: 0.9 }
    ],
    lossGuard: 'none'
  });
  assert.equal(lossOff.mode, 'rewrite', 'lossGuard:none 时损失界不拦（走改写）');
  assert.ok(!lossOff.rejected.some((r) => r.category === 'over_loss'), '不再出 over_loss 拒绝');
  assert.ok(lossOff.applied.some((a) => a.op === 'supersede'), '改写生效');
  assert.ok(!lossOff.content.includes(bigSnippet), '旧片段已被替换');
  // 缺省仍是 'file'：自动应用面的保护不变
  const lossDefault = planConsolidationWrite({
    ...base,
    ops: [{ op: 'supersede', candidateId: 31, text: 'x', oldSnippet: bigSnippet, confidence: 0.9 }]
  });
  assert.ok(
    lossDefault.rejected.some((r) => r.category === 'over_loss'),
    '缺省 lossGuard=file 保持损失界（自动面保护不变）'
  );

  // ③超预算（改写形态）：小预算让试组装超限 → 回退 append
  const budget = planConsolidationWrite({
    ...base,
    budgetChars: 10,
    ops: [{ op: 'supersede', candidateId: 31, text: 'x', oldSnippet: '内容甲。', confidence: 0.9 }]
  });
  assert.equal(budget.mode, 'append', '改写后超预算 → 回退 append');
  assert.ok(budget.rejected.some((r) => r.category === 'over_budget'), '按 over_budget 拒');

  // ③超预算（trial 必须计入新正文净增；还原即红：trial 只删 oldSnippet 不拼新正文时本用例转红）
  {
    const seedBody = '短。';
    const padLine = 'x'.repeat(200);
    const content2 = [
      '<!-- 2026-01-01 00:00:00 [s1] -->',
      `#seed ${padLine}`,
      '',
      '<!-- 2026-02-02 00:00:00 [s2] -->',
      `#seed ${seedBody}`
    ].join('\n');
    const longBody = '新正文。' + 'N'.repeat(400);
    // 删掉 seedBody 后仍在预算内；替换为 longBody+citation 后超预算
    const afterDelete = content2.replace(seedBody, '');
    const budgetChars = afterDelete.trim().length + 20;
    const net = planConsolidationWrite({
      currentContent: content2,
      evidence: [{ stagingId: 31, evidencePath: 'journal/x.md' }],
      budgetChars,
      surface: 'worker',
      now,
      ops: [{ op: 'supersede', candidateId: 31, text: longBody, oldSnippet: seedBody, confidence: 0.9 }]
    });
    assert.equal(net.mode, 'append', '净增后超预算 → 回退 append（trial 不得漏算新正文）');
    assert.ok(net.rejected.some((r) => r.category === 'over_budget'), '净增超限按 over_budget 拒');
    assert.ok(!net.content.includes('新正文。'), '改写正文不落盘');
    assert.ok(net.content.includes(seedBody), '旧正文原样保留');
  }

  // ③超预算（append 形态）：单条 add 超限拒、不拖垮其他（不同 stagingId）
  const addBudget = planConsolidationWrite({
    ...base,
    budgetChars: content.length + 90,
    ops: [
      { op: 'add', candidateId: 31, text: '第一条：能装下', confidence: 0.9 },
      { op: 'add', candidateId: 32, text: '第二条：装不下了，会被预算拒收', confidence: 0.9 }
    ]
  });
  const addApplied = addBudget.applied.filter((a) => a.op === 'add');
  assert.equal(addApplied.length, 1, '装得下的 add 应用');
  assert.ok(addBudget.rejected.some((r) => r.category === 'over_budget' && r.op === 'add'), '装不下的 add 拒');

  // 同一 stagingId 重复 add 只消费一条（还原即红：去掉 seenAddStaging 即两条都进）
  {
    const dupAdd = planConsolidationWrite({
      ...base,
      ops: [
        { op: 'add', candidateId: 31, text: '重复候选甲', confidence: 0.9 },
        { op: 'add', candidateId: 31, text: '重复候选乙', confidence: 0.9 }
      ]
    });
    assert.equal(dupAdd.applied.filter((a) => a.op === 'add').length, 1, '同 stagingId 只落一条 add');
    assert.ok(dupAdd.rejected.some((r) => r.op === 'add' && r.stagingId === 31), '重复 add 拒');
    // add+supersede 同源仍合法
    const mix = planConsolidationWrite({
      ...base,
      ops: [
        { op: 'add', candidateId: 31, text: '同源新增', confidence: 0.9 },
        { op: 'supersede', candidateId: 31, text: '同源改写', oldSnippet: '第一条旧条目，内容甲。', confidence: 0.5 }
      ]
    });
    assert.equal(mix.applied.length, 2, 'add+supersede 同 stagingId 合法');
  }

  // ②缺 Source：证据面完全缺失 → 晋升条目拒 + sweep 级回退
  const noEv = planConsolidationWrite({
    ...base,
    evidence: [],
    ops: [
      { op: 'add', candidateId: 99, text: '无证据候选', confidence: 0.9 },
      { op: 'merge', candidateId: 99, text: 'y', oldSnippet: '内容甲。', confidence: 0.9 }
    ]
  });
  assert.ok(noEv.rejected.some((r) => r.category === 'missing_source'), '无证据 → missing_source 拒');
  assert.equal(noEv.applied.length, 0, '无证据不晋升');
  assert.ok(!noEv.content.includes('无证据候选'), '无证据条目不落盘');

  // citation 构造：无路径回 staging#id；带行号 #Lx-Ly；完全无证据 null
  assert.equal(buildSourceCitation({ stagingId: 5 }), 'Source: staging#5', '无路径回退引用');
  assert.equal(buildSourceCitation(undefined), null, '完全无证据 → null');

  // 多 rewrite 按原文 span 重组（还原即红：String.replace 连环替换会命中刚写入正文）
  {
    const TARGET = 'TARGET_B_UNIQUE';
    const OLD_A = 'OLD_A_SNIPPET';
    const content3u = [
      '前文垫高甲，内容各不相同以保证损失界可通过。再补一句垫高。',
      `待改写A片段是${OLD_A}这里。`,
      '中段无关内容，仅作间隔。',
      `待改写B片段是${TARGET}这里。`,
      '后文垫高乙，内容各不相同以保证损失界可通过。再补一句垫高。'
    ].join('\n');
    const multi = planConsolidationWrite({
      ...base,
      currentContent: content3u,
      ops: [
        {
          op: 'supersede',
          candidateId: 31,
          // A 的新正文**包含** B 的 oldSnippet——串环 String.replace 会误伤
          text: `A新正文内嵌 ${TARGET} 作为诱饵。`,
          oldSnippet: OLD_A,
          confidence: 0.5
        },
        {
          op: 'supersede',
          candidateId: 31,
          text: 'B替换完成。',
          oldSnippet: TARGET,
          confidence: 0.5
        }
      ]
    });
    assert.equal(multi.mode, 'rewrite', '两段唯一定位改写生效');
    assert.equal(multi.applied.length, 2, '两条 rewrite 都应用');
    assert.ok(multi.content.includes('B替换完成。'), 'B 替换生效');
    assert.ok(!multi.content.includes(TARGET + '这里'), 'B 的原文 span 被替换');
    // 关键：A 新正文里的 TARGET 诱饵不得被 B 的 replace 误伤
    assert.ok(multi.content.includes(`A新正文内嵌 ${TARGET} 作为诱饵。`), 'B 不误伤 A 新正文中的同名子串');
  }
  console.log('ok: 5 验证组装四失败路径+happy rewrite（纯函数）');
}

/* ---------------- 6. 写安全：前镜像 + 哈希冲突→append 回退（还原即红抽查） ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-apply');
  const target = path.join(wsRoot, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = '<!-- 2026-01-01 00:00:00 [s1] -->\n#seed 旧条目正文。';
  fs.writeFileSync(target, original, 'utf8');
  const db = openMemoryDb(wsRoot);
  const evidence = [{ stagingId: 41, evidencePath: 'agent-session:apply' }];

  // happy rewrite：前镜像 + 原子写
  const baseHash = sha256Content(original);
  const plan1 = applyConsolidationOperations(db, {
    ops: [
      { op: 'supersede', candidateId: 41, text: '替换后的正文', oldSnippet: '旧条目正文。', confidence: 0.5 }
    ],
    evidence,
    targetFile: target,
    budgetChars: 16_000,
    surface: 'worker',
    baseHash,
    now: Date.now(),
    cause: 'test'
  });
  assert.equal(plan1.mode, 'rewrite', '哈希一致走改写');
  assert.equal(plan1.hashConflict, false, '无冲突');
  const written = fs.readFileSync(target, 'utf8');
  assert.ok(written.includes('替换后的正文') && written.includes('Source: agent-session:apply'), '改写落盘带 Source');
  const preimages = db.handle.prepare('SELECT * FROM preimages ORDER BY id').all();
  assert.equal(preimages.length, 1, '改写前全文前镜像入 preimages');
  assert.equal(String(preimages[0].content), original, '前镜像=改写前全文');
  assert.equal(String(preimages[0].content_hash), baseHash, '前镜像带内容哈希');

  // superseded 事件 entryRef 指向**新**条目（2026-09-27 复审回归）：旧条目已退出策展
  // 文件、不在条目总览列表——指旧 id 会让事件流点击恒落「要定位的条目不在列表里」。
  const supEv = db.handle
    .prepare("SELECT entry_ref FROM memory_events WHERE kind='superseded' ORDER BY id DESC LIMIT 1")
    .get();
  assert.ok(supEv, 'supersede 生效落一行 superseded 事件');
  const supApplied = plan1.applied.find((a) => a.op === 'supersede');
  assert.ok(supApplied?.entryId, '改写生效带新条目 id');
  assert.equal(String(supEv.entry_ref), supApplied.entryId, '事件 entryRef=新条目 id（还原即红：指旧条目则定位恒失败）');
  assert.notEqual(String(supEv.entry_ref), supApplied.oldEntryId ?? '', '事件 entryRef 不得指向已退役旧条目');

  // ④哈希冲突（还原即红抽查处）：构建输入后外部编辑过 → 放弃改写走 append 回退
  const beforeExternal = fs.readFileSync(target, 'utf8');
  const hashBefore = sha256Content(beforeExternal);
  const externallyEdited = `${beforeExternal}\n<!-- 2026-09-21 00:00:00 [human] -->\n人手编辑的条目，不许被覆盖`;
  fs.writeFileSync(target, externallyEdited, 'utf8');
  const plan2 = applyConsolidationOperations(db, {
    ops: [
      { op: 'merge', candidateId: 41, text: '外部编辑后的合并正文', oldSnippet: '替换后的正文', confidence: 0.5 },
      { op: 'add', candidateId: 41, text: '追加条目照常', confidence: 0.9 }
    ],
    evidence,
    targetFile: target,
    budgetChars: 16_000,
    surface: 'worker',
    baseHash: hashBefore, // 模型输入构建时抓的哈希（外部编辑前）
    now: Date.now(),
    cause: 'test-conflict'
  });
  assert.equal(plan2.hashConflict, true, '外部编辑过 → 哈希冲突检出');
  assert.equal(plan2.mode, 'append', '冲突 → 放弃改写走 append 回退');
  assert.ok(plan2.rejected.some((r) => r.category === 'hash_conflict'), 'merge 按 hash_conflict 拒');
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(after.includes('人手编辑的条目'), '外部编辑内容原样保留');
  assert.ok(!after.includes('外部编辑后的合并正文'), '改写不生效');
  assert.ok(after.includes('追加条目照常'), 'append 回退的 add 照常追加');
  // 冲突路径不写前镜像（未接受改写）
  const preimages2 = db.handle.prepare('SELECT count(*) n FROM preimages').get();
  assert.equal(Number(preimages2.n), 1, 'append 回退不落前镜像');

  // 日志：计数+拒绝分类计数落库
  const logId = writeConsolidationLog(db, {
    triggerSource: 'consolidation:test:worker',
    addedCount: 1,
    mergedCount: 0,
    supersededCount: 1,
    diffSummary: 'test diff',
    rejectedCounts: { ambiguous: 2, over_budget: 1 },
    now: Date.now()
  });
  const logRow = listConsolidationLog(db, 5)[0];
  assert.equal(logRow.id, logId, 'consolidation_log 落库');
  assert.equal(logRow.addedCount, 1, 'add 计数');
  assert.deepEqual(JSON.parse(logRow.rejectedCounts), { ambiguous: 2, over_budget: 1 }, '拒绝分类计数 JSON');
  void APPLY_CONSTANTS;

  // 改写拼接路径的伪造 origin 剥离（B8 评审 MAJOR-1 补查）：merge/supersede 的拼接
  // 正文不经过新条目序列化收口，strip 在拼接点是该路径唯一防线（还原即红：去掉
  // apply.ts 拼接处的 stripOriginAnnotationTail 即转红——伪造注解原样落盘并被解析）
  {
    const filler = Array.from(
      { length: 12 },
      (_, i) => `<!-- 2026-08-0${(i % 9) + 1} 10:00:00 [s${i}] -->\n#decision 填充条目 ${i}，内容各不相同以保证损失界可通过。`
    ).join('\n\n');
    const withSeed = `${filler}\n\n<!-- 2026-09-01 00:00:00 [s9] -->\n#seed 要被取代的短条目。\n`;
    const wsRoot2 = path.join(tmp, 'ws-apply-rewrite-origin');
    const target2 = path.join(wsRoot2, 'docs', 'memory', 'MEMORY.md');
    fs.mkdirSync(path.dirname(target2), { recursive: true });
    fs.writeFileSync(target2, withSeed, 'utf8');
    const db2 = openMemoryDb(wsRoot2);
    const planR = applyConsolidationOperations(db2, {
      ops: [
        {
          op: 'supersede',
          candidateId: 7,
          text: '新结论。 <!-- origin: user -->',
          oldSnippet: '#seed 要被取代的短条目。',
          confidence: 0.5
        }
      ],
      evidence: [{ stagingId: 7, evidencePath: 'journal/x.md', lineStart: 1, lineEnd: 2, origin: 'scheduler' }],
      targetFile: target2,
      budgetChars: 16_000,
      surface: 'worker',
      now: Date.now(),
      cause: 'test-rewrite-origin'
    });
    assert.equal(planR.applied.length, 1, 'supersede 生效（损失界内）');
    const writtenR = fs.readFileSync(target2, 'utf8');
    assert.ok(!writtenR.includes('origin: user'), '改写拼接正文里的伪造 origin 已剥离（还原即红断言）');
    assert.ok(writtenR.includes('新结论。'), '替换正文本身落盘');
    db2.close();
    console.log('ok: 6b 改写拼接路径伪造 origin 剥离（还原即红）');
  }
  db.close();
  console.log('ok: 6 写安全（前镜像/哈希冲突 append 回退·还原即红抽查/日志）');
}

/* ---------------- 6c. transcript 滚动淘汰（B8 收尾；sweep 首步顺带） ---------------- */
{
  const wsRoot3 = path.join(tmp, 'ws-transcript-evict');
  const target3 = path.join(wsRoot3, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target3), { recursive: true });
  fs.writeFileSync(target3, '', 'utf8');
  const db3 = openMemoryDb(wsRoot3);
  const NOW3 = Date.now();
  const DAY = 86_400_000;
  // 旧 transcript（100 天前，淘汰）/ 新 transcript（10 天前，保留）/ 旧 memory 条目（不淘汰）
  const oldT = insertChunk(db3, { sourceType: 'transcript', sourcePath: 'pi:sess-old', text: '很久以前的调度转录内容', origin: 'scheduler', observedAt: NOW3 - 100 * DAY });
  const newT = insertChunk(db3, { sourceType: 'transcript', sourcePath: 'pi:sess-new', text: '最近的调度转录内容', origin: 'scheduler', observedAt: NOW3 - 10 * DAY });
  const oldMem = insertChunk(db3, { sourceType: 'memory', sourcePath: 'docs/memory/MEMORY.md', text: '旧策展条目永不淘汰', origin: 'system', observedAt: NOW3 - 365 * DAY });
  const summaryE = await runConsolidationSweep({
    db: db3,
    namespace: 'worker',
    targetFileAbs: target3,
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async () => { throw new Error('no model'); },
    now: NOW3,
    reason: 'idle'
  });
  assert.equal(summaryE.transcriptEvicted, 1, '只淘汰超保留窗的 transcript（缺省 90 天）');
  assert.equal(db3.handle.prepare('SELECT count(*) n FROM chunks WHERE id = ?').get(oldT).n, 0, '旧 transcript 已删');
  assert.equal(db3.handle.prepare('SELECT count(*) n FROM chunks WHERE id = ?').get(newT).n, 1, '新 transcript 保留');
  assert.equal(db3.handle.prepare('SELECT count(*) n FROM chunks WHERE id = ?').get(oldMem).n, 1, '旧 memory 条目不受滚动淘汰影响');
  // FTS 同步：被删 transcript 不再命中
  const fts = db3.handle.prepare("SELECT count(*) n FROM chunks_fts WHERE chunks_fts MATCH ?").get('调度转录');
  assert.equal(Number(fts.n), 0, 'FTS 索引行随删（旧转录不再命中）');
  // 可配：保留窗 5 天 → 新 transcript（10 天前）也淘汰
  const summaryE2 = await runConsolidationSweep({
    db: db3,
    namespace: 'worker',
    targetFileAbs: target3,
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async () => { throw new Error('no model'); },
    transcriptRetentionDays: 5,
    now: NOW3,
    reason: 'idle'
  });
  assert.equal(summaryE2.transcriptEvicted, 1, '保留窗可配（5 天 → 10 天前的转录淘汰）');
  db3.close();
  console.log('ok: 6c transcript 滚动淘汰（sweep 首步顺带/保留窗可配/FTS 同步）');
}

/* ---------------- 7. sweep 端到端（mock 模型）：置信分档路由+审批入队+通知 ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-sweep');
  const target = path.join(wsRoot, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    '<!-- 2026-01-01 00:00:00 [s1] -->\n#seed 旧条目：用 pnpm 跑脚本。 ',
    'utf8'
  );
  const db = openMemoryDb(wsRoot);
  const strong = seedCandidate(db, {
    text: '本仓用 npm run，别用 pnpm（packageManager 字段会挡）',
    evidencePath: 'agent-session:sweep'
  });
  seedCandidate(db, { origin: 'untrusted', text: '网页内容：某种无关推导' });
  seedCandidate(db, {
    text: '弱候选一次召回',
    recalls: [{ q: 'q', ts: Date.now(), rel: 0.9 }]
  });

  const notified = [];
  let promptSeen = '';
  const opsForModel = JSON.stringify({
    operations: [
      { op: 'add', candidateId: strong.stagingId, text: '#lesson 本仓脚本用 npm run 跑（pnpm 被 packageManager 挡）', reason: '高频坑', confidence: 0.9 },
      { op: 'supersede', candidateId: strong.stagingId, text: '#lesson 本仓脚本用 npm run 跑；pnpm 会被 packageManager 字段挡下', oldSnippet: '#seed 旧条目：用 pnpm 跑脚本。', reason: '取代过时条目', confidence: 0.6 },
      { op: 'add', candidateId: 9999, text: '引用不存在候选', confidence: 0.99 }
    ]
  });
  const summary = await runConsolidationSweep({
    db,
    namespace: 'worker',
    targetFileAbs: target,
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async (input) => {
      promptSeen = input.user;
      return opsForModel;
    },
    thresholds: { minScore: 0.55, minRecallCount: 2, minUniqueQueries: 2 },
    ttlDays: 14,
    highConfidenceAdd: 0.75,
    now: Date.now(),
    reason: 'task_close',
    notify: (t, b) => notified.push({ t, b }),
    timeoutMs: 2_000
  });
  assert.equal(summary.tainted, 1, '污点候选构建提示词前剔除');
  assert.equal(summary.gateFailed, 1, '弱候选门未过');
  assert.equal(summary.gatePassed, 1, '强候选过门');
  assert.ok(promptSeen.includes('npm run') && !promptSeen.includes('网页内容'), '提示词只含门内候选（污点/未过门不见）');
  assert.equal(summary.unknownCandidateOps, 1, '未知候选引用按 model_failed 计');
  assert.equal(summary.autoApplied.add, 1, '高置信 add 自动应用');
  assert.equal(summary.autoApplied.supersede, 0, 'supersede 不自动应用');
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(after.includes('npm run 跑'), '自动 add 落盘');
  assert.ok(after.includes('Source: agent-session:sweep'), '落盘条目带 Source');
  assert.equal(
    db.handle.prepare("SELECT state FROM staging WHERE id = ?").get(strong.stagingId).state,
    'promoted',
    '自动应用的候选晋升（镜像 chunk 随删）'
  );
  // 审批入队 + 通知一条
  assert.ok(summary.deferredApprovalId, '低置信/改写操作入审批队列');
  const pend = listApprovals(db, 'pending');
  assert.equal(pend.length, 1, 'approvals pending 一条');
  assert.equal(pend[0].action, 'supersede', '含 supersede 操作 → action=supersede');
  const payload = JSON.parse(pend[0].payload);
  assert.equal(payload.operations.length, 1, '待审操作=supersede 一条');
  assert.equal(payload.operations[0].op, 'supersede');
  assert.ok(payload.previewDiff.length === 1 && payload.previewDiff[0].includes('取代'), 'payload 带预览 diff');
  assert.equal(notified.length, 1, '通知通道发一条');
  assert.ok(notified[0].t.includes('审批'), '通知标题指向审批');
  // 日志行
  const logRow = listConsolidationLog(db, 3)[0];
  assert.equal(logRow.addedCount, 1, '日志 add 计数');
  assert.ok(JSON.parse(logRow.rejectedCounts).model_failed >= 1, '日志拒绝分类含 model_failed');

  // 模型失败路径：输出散文 → 文件不动、model_failed 落日志、无审批
  const before2 = fs.readFileSync(target, 'utf8');
  const s2 = seedCandidate(db, { text: '第二条强候选：另一次高频观察', evidencePath: 'agent-session:s2' });
  void s2;
  const summary2 = await runConsolidationSweep({
    db,
    namespace: 'worker',
    targetFileAbs: target,
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async () => '模型这次输出了散文，没有 JSON',
    thresholds: { minScore: 0.55, minRecallCount: 2, minUniqueQueries: 2 },
    now: Date.now(),
    reason: 'session_end',
    timeoutMs: 2_000
  });
  assert.ok(!summary2.modelOk && summary2.modelError.includes('解析失败'), '模型回合失败上报');
  assert.equal(fs.readFileSync(target, 'utf8'), before2, '模型失败不动策展文件');
  assert.equal(listApprovals(db, 'pending').length, 1, '模型失败不产生新审批');
  db.close();
  console.log('ok: 7 sweep 端到端（置信分档/审批入队/通知/模型失败回退）');
}

/* ---------------- 8. 审批执行：approve 走验证写 / reject 退场 ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-approval');
  const target = path.join(wsRoot, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = [
    '<!-- 2026-01-01 00:00:00 [s1] -->',
    '#seed 旧口径：pnpm 可用。',
    '',
    '<!-- 2026-02-02 00:00:00 [s2] -->',
    '#seed 第二条旧条目，内容乙：垫高原文使取代片段占比远低于损失界。',
    '',
    '<!-- 2026-03-03 00:00:00 [s3] -->',
    '#seed 第三条旧条目，内容丙：继续垫高原文体量。'
  ].join('\n');
  fs.writeFileSync(target, original, 'utf8');
  const db = openMemoryDb(wsRoot);
  const cand = seedCandidate(db, { text: '新口径：npm run', evidencePath: 'agent-session:appr' });
  const baseHash = sha256Content(original);
  const approvalId = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'docs/memory/MEMORY.md',
    baseHash,
    baseContentChars: original.length,
    operations: [
      {
        op: 'supersede',
        candidateId: cand.stagingId,
        stagingId: cand.stagingId,
        text: '#lesson 新口径：npm run',
        oldSnippet: '#seed 旧口径：pnpm 可用。',
        reason: '取代',
        confidence: 0.6,
        citation: 'Source: agent-session:appr'
      }
    ],
    reason: 'task_close',
    now: Date.now()
  });
  assert.ok(approvalId > 0, '审批入队');

  // approve：同第 4 步验证组装与写安全
  const evidence = [{ stagingId: cand.stagingId, evidencePath: 'agent-session:appr' }];
  const appr = decideConsolidationApproval(db, approvalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence
  });
  assert.ok(appr.ok, `approve 应成功：${appr.error}`);
  assert.equal(appr.plan.applied.length, 1, 'supersede 应用');
  assert.equal(appr.plan.mode, 'rewrite', '哈希未变走改写');
  const after = fs.readFileSync(target, 'utf8');
  assert.ok(after.includes('新口径') && !after.includes('旧口径'), '取代生效');
  assert.equal(getApproval(db, approvalId).state, 'approved', '审批状态翻转');
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(cand.stagingId).state,
    'promoted',
    'approve 后候选晋升'
  );
  // 幂等：已裁决审批再操作 → 拒绝
  const again = decideConsolidationApproval(db, approvalId, 'reject', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence
  });
  assert.ok(!again.ok && again.error.includes('已裁决'), '已裁决审批幂等拒绝');

  // reject：staging rejected + 镜像 chunk 删除 + 日志
  const cand2 = seedCandidate(db, { text: '待拒候选：低置信新增', evidencePath: 'agent-session:rej' });
  const approval2 = enqueueConsolidationApproval(db, {
    namespace: 'worker',
    targetFileRel: 'docs/memory/MEMORY.md',
    baseHash: sha256Content(after),
    baseContentChars: after.length,
    operations: [
      {
        op: 'add',
        candidateId: cand2.stagingId,
        stagingId: cand2.stagingId,
        text: '低置信新增条目',
        reason: '低置信',
        confidence: 0.3,
        citation: 'Source: agent-session:rej'
      }
    ],
    reason: 'manual',
    now: Date.now()
  });
  const beforeReject = fs.readFileSync(target, 'utf8');
  const rej = decideConsolidationApproval(db, approval2, 'reject', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence: [{ stagingId: cand2.stagingId, evidencePath: 'agent-session:rej' }]
  });
  assert.ok(rej.ok, 'reject 应成功');
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(cand2.stagingId).state,
    'rejected',
    'reject 后候选 rejected'
  );
  assert.equal(mirrorChunkId(db, cand2.stagingId), null, 'reject 后镜像 chunk 删除');
  assert.equal(fs.readFileSync(target, 'utf8'), beforeReject, 'reject 不动文件');
  const logs = listConsolidationLog(db, 10);
  assert.ok(logs.some((l) => (l.triggerSource ?? '').startsWith(`approval:${approval2}:rejected`)), 'reject 落日志');
  const cand3 = seedCandidate(db, { text: '容量不足时不应假装批准成功', evidencePath: 'agent-session:over-budget' });
  const approval3 = enqueueConsolidationApproval(db, {
    namespace: 'worker', targetFileRel: 'docs/memory/MEMORY.md', baseHash: sha256Content(beforeReject),
    baseContentChars: beforeReject.length,
    operations: [{ op: 'add', candidateId: cand3.stagingId, stagingId: cand3.stagingId, text: '容量不足时不应假装批准成功', reason: 'test', confidence: 0.5, citation: 'Source: agent-session:over-budget' }],
    reason: 'test', now: Date.now()
  });
  const noWrite = decideConsolidationApproval(db, approval3, 'approve', {
    targetFileAbs: target, budgetChars: 1, surface: 'worker', now: Date.now(),
    evidence: [{ stagingId: cand3.stagingId, evidencePath: 'agent-session:over-budget' }]
  });
  assert.equal(noWrite.ok, false, '0 项写入不能算批准成功');
  assert.equal(getApproval(db, approval3).state, 'pending', '未写入时保留待审以供驳回或重试');
  assert.equal(fs.readFileSync(target, 'utf8'), beforeReject, '未写入时策展文件不变');
  db.close();
  console.log('ok: 8 审批执行（approve 验证写/reject 退场/幂等）');
}

/* ---------------- 9. 触发器：运行锁+排队合并 / 去抖 / 最小间隔 / 空闲兜底 ---------------- */
{
  // 运行锁 + 运行中排队（合并跑第二次）
  const runs = [];
  let release;
  const gate = new Promise((r) => (release = r));
  let first = true;
  const trig = new MemoryConsolidationTrigger({
    run: async (rootArg, reason) => {
      runs.push({ root: rootArg, reason });
      if (first) {
        first = false;
        await gate; // 第一跑挂起，制造运行中窗口
      }
    },
    debounceMs: 15,
    minIntervalMs: 0
  });
  trig.request('/ws/a', 'task_close');
  await sleep(40); // 去抖触发，第一跑开始并挂起
  assert.ok(trig.isRunning('/ws/a'), '去抖后 sweep 开始（运行锁持有）');
  trig.request('/ws/a', 'session_end'); // 运行中 → 排队
  trig.request('/ws/a', 'needs_you'); // 再排队（合并 reason 保语义更强者）
  trig.request('/ws/b', 'task_close'); // 另一工作区不受该锁影响（各自独立状态）
  await sleep(60);
  release();
  await sleep(80);
  assert.equal(runs.length, 3, `运行中排队接跑+另一根独立（实际 ${runs.length}）`);
  const aRuns = runs.filter((x) => x.root === '/ws/a');
  const bRuns = runs.filter((x) => x.root === '/ws/b');
  assert.equal(aRuns.length, 2, 'a 根：首跑+排队接跑');
  assert.equal(aRuns[0].reason, 'task_close', '首跑 reason');
  assert.equal(aRuns[1].reason, 'session_end', '排队合并后接跑（同级保先到）');
  assert.equal(bRuns.length, 1, 'b 根独立执行（不受 a 运行锁影响）');
  assert.ok(!trig.isRunning('/ws/a'), '跑完释放锁');
  trig.stop();

  // 最小间隔：窗口内的请求静默跳过 + request 如实返回结果（B4 评审 MINOR-5）
  const runs2 = [];
  const trig2 = new MemoryConsolidationTrigger({
    run: async (r2) => {
      runs2.push(r2);
    },
    debounceMs: 5,
    minIntervalMs: 60_000
  });
  trig2.request('/ws/c', 'task_close');
  await sleep(25);
  assert.equal(
    trig2.request('/ws/c', 'needs_you'),
    'skipped_min_interval',
    '间隔内事件请求：如实返回跳过（不再静默吞）'
  );
  await sleep(40);
  assert.equal(runs2.length, 1, '最小间隔内的重复请求被跳过');
  // 手动入口豁免最小间隔（B4 评审 MINOR-5·还原即红）：间隔内仍受理且真的执行
  assert.equal(
    trig2.request('/ws/c', 'manual', { bypassMinInterval: true }),
    'queued',
    '手动请求豁免最小间隔 → 受理'
  );
  await sleep(40);
  assert.equal(runs2.length, 2, '豁免后手动 sweep 执行');
  trig2.stop();

  // 空闲兜底：距上次 ≥ idleIntervalMs 触发 reason='idle'
  const runs3 = [];
  const trig3 = new MemoryConsolidationTrigger({
    run: async (_r, reason) => {
      runs3.push(reason);
    },
    debounceMs: 5,
    minIntervalMs: 0,
    idleIntervalMs: 45,
    idleCheckIntervalMs: 15
  });
  trig3.request('/ws/d', 'manual');
  await sleep(30); // 第一跑完成（lastRunAt 更新）
  trig3.startIdleWatch(() => ['/ws/d']);
  await sleep(140);
  trig3.stop();
  assert.ok(runs3.length >= 2, `空闲兜底触发（${runs3.length} 次）`);
  assert.equal(runs3[0], 'manual');
  assert.ok(runs3.slice(1).every((r3) => r3 === 'idle'), '兜底触发 reason=idle');

  // stop 后不再受理
  const runs4 = [];
  const trig4 = new MemoryConsolidationTrigger({ run: async () => runs4.push(1), debounceMs: 5 });
  trig4.stop();
  assert.equal(trig4.request('/ws/e', 'manual'), 'skipped_stopped', 'stop 后请求如实返回不受理');
  trig4.request('/ws/e', 'manual');
  await sleep(30);
  assert.equal(runs4.length, 0, 'stop 后请求不受理');
  console.log('ok: 9 触发器（运行锁/排队合并/去抖/最小间隔/空闲兜底/停止）');
}

/* ---------------- 10. 配置归一与目标解析 ---------------- */
{
  const d = normalizeMemoryConsolidationConfig(undefined);
  assert.equal(d.enabled, true, '缺省启用');
  assert.equal(d.minScore, 0.55, 'minScore 缺省 0.55');
  assert.equal(d.minRecallCount, 2, 'minRecallCount 缺省 2');
  assert.equal(d.minUniqueQueries, 2, 'minUniqueQueries 缺省 2');
  assert.equal(d.highConfidenceAdd, 0.75, 'highConfidenceAdd 缺省 0.75');
  assert.equal(d.stagingPendingTtlDays, 14, 'TTL 缺省 14 天');
  assert.equal(d.idleMinIntervalHours, 6, '空闲兜底缺省 6h');
  const bad = normalizeMemoryConsolidationConfig({ minScore: 5, stagingPendingTtlDays: -3, enabled: 'x' });
  assert.equal(bad.minScore, 1, 'minScore 钳位 0–1');
  assert.equal(bad.stagingPendingTtlDays, 1, 'TTL 下限 1 天');
  assert.equal(bad.enabled, false, '非布尔 enabled 保守关');
  const t1 = resolveConsolidationTarget({ providerId: 'p1', modelId: 'm1' }, { providerId: 'p0', modelId: 'm0' });
  assert.deepEqual(t1, { providerId: 'p1', modelId: 'm1' }, '专用配置优先');
  const t2 = resolveConsolidationTarget(undefined, { providerId: 'p0', modelId: 'm0' });
  assert.deepEqual(t2, { providerId: 'p0', modelId: 'm0' }, '未配置回落调度快照');
  const t3 = resolveConsolidationTarget(undefined, undefined);
  assert.ok(!t3.providerId && !t3.modelId, '无任何配置=运行时全局 active 兜底');
  console.log('ok: 10 memoryConsolidation 配置归一/目标解析');
}

/* ---------------- 11. 混批审批基线重抓（B4 评审 MAJOR-1·还原即红）：sweep(add+supersede)→approve 应生效 ---------------- */
{
  const wsRoot = path.join(tmp, 'ws-mixed');
  const target = path.join(wsRoot, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = [
    '<!-- 2026-01-01 00:00:00 [s1] -->',
    '#seed 旧条目：pnpm 跑脚本。',
    '',
    '<!-- 2026-02-02 00:00:00 [s2] -->',
    '#seed 第二条旧条目，内容乙：垫高原文体量，使取代片段占比远低于损失界。'
  ].join('\n');
  fs.writeFileSync(target, original, 'utf8');
  const db = openMemoryDb(wsRoot);
  // 两个独立强候选：add 走自动应用（其 staging 随即 promoted），supersede 走审批
  // （其 staging 保持 pending——审批执行的 evidence 从仍 pending 的行重建，与生产口径一致）
  const addCand = seedCandidate(db, {
    text: '强候选甲：本仓脚本一律用 npm run 跑',
    evidencePath: 'agent-session:mixed-add'
  });
  const supCand = seedCandidate(db, {
    text: '强候选乙：pnpm 会被 packageManager 字段挡下',
    evidencePath: 'agent-session:mixed-sup'
  });

  const summary = await runConsolidationSweep({
    db,
    namespace: 'worker',
    targetFileAbs: target,
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async () =>
      JSON.stringify({
        operations: [
          { op: 'add', candidateId: addCand.stagingId, text: '#lesson 本仓脚本用 npm run 跑', reason: '高频', confidence: 0.9 },
          {
            op: 'supersede',
            candidateId: supCand.stagingId,
            text: '#lesson 本仓用 npm run；pnpm 会被 packageManager 字段挡下',
            oldSnippet: '#seed 旧条目：pnpm 跑脚本。',
            reason: '取代过时条目',
            confidence: 0.6
          }
        ]
      }),
    thresholds: { minScore: 0.55, minRecallCount: 2, minUniqueQueries: 2 },
    now: Date.now(),
    reason: 'task_close',
    timeoutMs: 2_000
  });
  assert.equal(summary.autoApplied.add, 1, '高置信 add 自动应用（已改写目标文件）');
  assert.ok(summary.deferredApprovalId, 'supersede 入审批队列');

  // 审批基线=auto-apply 写入后的现状（还原即红：改回旧基线传递时此断言转红）
  const afterAuto = fs.readFileSync(target, 'utf8');
  assert.ok(afterAuto.includes('npm run 跑'), 'auto-apply 的 add 已落盘（文件已变化）');
  assert.notEqual(sha256Content(afterAuto), sha256Content(original), '文件哈希已不同于 sweep 前快照');
  const payload = JSON.parse(getApproval(db, summary.deferredApprovalId).payload);
  assert.equal(payload.baseHash, sha256Content(afterAuto), '审批基线重抓=auto-apply 写入后的哈希');

  // approve：生产口径重建 evidence（仍 pending 的 staging 行）→ 应真实生效
  const evidence = listStagingCandidates(db).map((c) => ({
    stagingId: c.stagingId,
    evidencePath: c.evidencePath
  }));
  assert.ok(
    evidence.some((e) => e.stagingId === supCand.stagingId),
    'supersede 候选仍 pending（evidence 重建含它）'
  );
  const appr = decideConsolidationApproval(db, summary.deferredApprovalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence
  });
  assert.ok(appr.ok, `approve 应成功：${appr.error}`);
  assert.equal(appr.plan.hashConflict, false, '不得与自己刚写入的内容哈希冲突（MAJOR-1）');
  assert.equal(appr.plan.mode, 'rewrite', '基线新鲜 → 走改写');
  assert.equal(appr.plan.applied.length, 1, 'supersede 应用（0/N 即红）');
  assert.equal(appr.plan.applied[0].op, 'supersede');
  const afterApprove = fs.readFileSync(target, 'utf8');
  assert.ok(afterApprove.includes('pnpm 会被 packageManager 字段挡下'), '取代正文落盘');
  assert.ok(!afterApprove.includes('#seed 旧条目：pnpm 跑脚本。'), '被取代旧条目退役');
  assert.ok(afterApprove.includes('npm run 跑'), 'auto-apply 的 add 原样保留');
  assert.equal(
    db.handle.prepare('SELECT state FROM staging WHERE id = ?').get(supCand.stagingId).state,
    'promoted',
    'approve 后 supersede 候选晋升'
  );
  db.close();
  console.log('ok: 11 混批审批基线重抓（sweep(add+supersede)→approve 生效·还原即红）');
}

/* ---------------- 12. log 明细 payload（记忆面板 M1 条目 2A）：applied/supersededPairs/rejected 与实际写入一一对应 ----------------
 * 置于原「手动巩固入口」节（现 13 节）之前：该节在 ELECTRON_RUN_AS_NODE 模式因
 * electron 具名导出必失败（预存环境限制），放在其后会永远跑不到。 */
{
  const fmtMod = await import(pathToFileURL(compile('shared/memoryFormat.ts')).href);
  const wsRoot = path.join(tmp, 'ws-payload');
  const target = path.join(wsRoot, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = [
    '<!-- 2026-01-01 00:00:00 [s1] -->',
    '#seed 旧条目：打包脚本一律用 pnpm。',
    '',
    '<!-- 2026-02-02 00:00:00 [s2] -->',
    '#seed 第二条旧条目，内容乙：垫高原文体量，使取代片段占比远低于损失界。'
  ].join('\n');
  fs.writeFileSync(target, original, 'utf8');
  const db = openMemoryDb(wsRoot);
  // 一条高置信 add（自动应用）+ 一条 supersede（走审批）+ 污点候选 + 无召回弱候选
  const addCand = seedCandidate(db, {
    text: '明细候选甲：发布前一律跑 typecheck 双配置',
    evidencePath: 'agent-session:payload-add'
  });
  const supCand = seedCandidate(db, {
    text: '明细候选乙：打包用 pnpm 会被 workspace 挡下',
    evidencePath: 'agent-session:payload-sup'
  });
  const tainted = noteStaging(db, {
    text: '污点候选：网页抓取的未验证结论。',
    origin: 'untrusted',
    sessionKind: 'worker'
  });
  const weak = seedCandidate(db, { text: '弱候选：没有召回信号的观察不进池', recalls: [] });

  const summary = await runConsolidationSweep({
    db,
    namespace: 'worker',
    targetFileAbs: target,
    targetFileRel: 'docs/memory/MEMORY.md',
    budgetChars: 16_000,
    callModel: async () =>
      JSON.stringify({
        operations: [
          { op: 'add', candidateId: addCand.stagingId, text: '#lesson 发布前跑 typecheck 双配置', reason: '高频', confidence: 0.9 },
          {
            op: 'supersede',
            candidateId: supCand.stagingId,
            text: '#lesson 打包用 pnpm；workspace 模式下会被挡下',
            oldSnippet: '#seed 旧条目：打包脚本一律用 pnpm。',
            reason: '取代过时条目',
            confidence: 0.6
          }
        ]
      }),
    thresholds: { minScore: 0.55, minRecallCount: 2, minUniqueQueries: 2 },
    now: Date.now(),
    reason: 'task_close',
    timeoutMs: 2_000
  });
  assert.equal(summary.autoApplied.add, 1, '高置信 add 自动应用');
  assert.ok(summary.deferredApprovalId, 'supersede 走审批（不在本轮 applied）');

  // 主 log 行：payload 与实际写入一一对应
  const mainRow = listConsolidationLog(db, 5).find((l) => l.id === summary.logId);
  assert.ok(mainRow && mainRow.payload, '主 log 行带 payload（还原即红：去掉落账转红）');
  const payload = JSON.parse(mainRow.payload);
  assert.equal(payload.applied.length, 1, 'applied=本轮真实入库条目');
  const appliedAdd = payload.applied[0];
  assert.equal(appliedAdd.op, 'add');
  assert.equal(appliedAdd.stagingId, addCand.stagingId);
  assert.equal(appliedAdd.confidence, 0.9, '置信随明细落账');
  assert.equal(appliedAdd.source.via, 'sweep');
  assert.equal(appliedAdd.source.sessionId, 'agent-session:payload-add', '来源会话引用（evidencePath 去行号）');
  assert.equal(appliedAdd.signals.recallCount, 3, '信号摘要来自候选装载');
  const fileEntries = fmtMod.parseMemoryEntries(fs.readFileSync(target, 'utf8'));
  const fileEntry = fileEntries.find((e) => e.text.includes('发布前跑 typecheck'));
  assert.ok(fileEntry, '新条目已落盘');
  assert.equal(appliedAdd.entryId, fileEntry.id, 'applied entryId 与盘上解析 id 一致（还原即红：去掉 attachAppliedEntryIds 转红）');

  // rejected：污点 + 门未过逐条带人话拒因 key+args
  const rejByStaging = new Map(payload.rejected.map((r) => [r.stagingId, r]));
  assert.equal(rejByStaging.get(tainted.stagingId)?.reasonKey, 'taint', '污点候选拒因');
  assert.equal(rejByStaging.get(weak.stagingId)?.reasonKey, 'low_signal', '门未过候选拒因');
  const weakItem = rejByStaging.get(weak.stagingId);
  assert.equal(weakItem.reasonArgs.minRecallCount, 2, '拒因参数带阈值');
  assert.equal(weakItem.originSessionId, 'agent-session:test', '拒绝明细带来源会话');
  assert.equal(rejByStaging.get(weak.stagingId).text.includes('弱候选'), true, '拒绝明细带候选原文');
  assert.ok(!payload.applied.some((a) => a.stagingId === supCand.stagingId), '审批中的 supersede 不算 applied');
  assert.equal(payload.supersededPairs.length, 0, '本轮无自动 supersede');

  // approve 后的 log 行：supersededPairs 带新旧条目 id + 前镜像 id
  const evidence = listStagingCandidates(db).map((c) => ({ stagingId: c.stagingId, evidencePath: c.evidencePath }));
  const appr = decideConsolidationApproval(db, summary.deferredApprovalId, 'approve', {
    targetFileAbs: target,
    budgetChars: 16_000,
    surface: 'worker',
    now: Date.now(),
    evidence
  });
  assert.ok(appr.ok, `approve 应成功：${appr.error}`);
  const apprRow = listConsolidationLog(db, 5).find((l) =>
    (l.triggerSource ?? '').startsWith(`approval:${summary.deferredApprovalId}:`)
  );
  assert.ok(apprRow && apprRow.payload, '审批 log 行带 payload');
  const apprPayload = JSON.parse(apprRow.payload);
  assert.equal(apprPayload.applied.length, 1);
  assert.equal(apprPayload.applied[0].source.via, 'approval', '审批途径标记');
  assert.equal(apprPayload.supersededPairs.length, 1, '取代对随明细落账');
  const pair = apprPayload.supersededPairs[0];
  const beforeEntries = fmtMod.parseMemoryEntries(original);
  const oldEntry = beforeEntries.find((e) => e.text.includes('打包脚本一律用 pnpm'));
  assert.equal(pair.oldEntryId, oldEntry.id, '旧条目 id 与改写前全文解析一致');
  assert.equal(pair.oldText, '#seed 旧条目：打包脚本一律用 pnpm。', '旧文随对落账（回收站/血缘展示面）');
  assert.ok(Number.isInteger(pair.preimageId) && pair.preimageId > 0, '前镜像 id 在（可回滚标注）');
  const afterEntries = fmtMod.parseMemoryEntries(fs.readFileSync(target, 'utf8'));
  const newEntry = afterEntries.find((e) => e.text.includes('workspace 模式下会被挡下'));
  assert.ok(newEntry, '取代新条目已落盘');
  assert.equal(pair.newEntryId, newEntry.id, '新条目 id 与改写后全文解析一致');
  assert.equal(apprPayload.applied[0].entryId, newEntry.id, '审批 applied entryId 一致');

  // 兼容：无 payload 写入（旧式调用）→ payload=null
  writeConsolidationLog(db, {
    triggerSource: 'consolidation:legacy:worker',
    addedCount: 0,
    mergedCount: 0,
    supersededCount: 0,
    now: Date.now()
  });
  const legacyRow = listConsolidationLog(db, 5).find((l) => l.triggerSource === 'consolidation:legacy:worker');
  assert.equal(legacyRow.payload, null, '旧式写入无 payload（读取端宽容形状）');
  db.close();
  console.log('ok: 12 log 明细 payload（applied/supersededPairs/rejected 一一对应/兼容旧行）');
}

/* ---------------- 13. Production cutover retires the automatic/manual sweep adapter ---------------- */
{
  const runtimeMod = await import(pathToFileURL(compile('main/memory/runtime.ts')).href);
  for (const retired of ['runMemoryConsolidationNow','requestMemoryConsolidation','ingestGuiSessionOnRelease','startMemoryConsolidationIdleWatch']) {
    assert.equal(runtimeMod[retired], undefined, `${retired} is no longer a production entrypoint`);
  }
  assert.equal(typeof runtimeMod.bindMemoryIntentEvents, 'function', 'independent reminder lifecycle remains live');
  console.log('ok: 13 retired sweep adapters stay disconnected; reminder lifecycle remains');
}
console.log(`memory-consolidation(B4): ok (tmp=${tmp})`);
