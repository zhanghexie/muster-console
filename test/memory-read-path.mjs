/**
 * 记忆重构 P4 读路径（memory-refactor B5）：inject 兑现（bootstrap 装箱/逐回合刷新
 * 字节稳定/预算画像/零注入面/bootstrap 落账）、trigger 注入（阈值/上限/策展层限定/
 * 落账）、回忆意图矩阵、Lane2 条件两分支+净化摘录+超时降级、调度转录增量索引（防重放/
 * 脱敏/判重/召回回路）、简报定向召回（brief_injected 落账 + searchMemory recordStats）、
 * Worker 工具注册（PTY 白名单/catalog）、调度模型访问器解析。
 * B5 评审修复回归：面级 versionToken 互不拖动（§1）/ features 语料可检索不进注入不晋升
 * （§2/§9）/ memory.list 死路教学移除（§7）/ Lane2 意图形态约束负例矩阵 + 阈值上调 +
 * timeout/error 区分（§3/§4）/ injectionCache LRU（§1）。
 * Run: node test/memory-read-path.mjs
 * 全部落系统临时目录（mkdtemp），零模型调用（向量/LLM 全 mock 或不触达）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { sqliteFts5Supported } from './helpers/sqlite-fts5.mjs';

// 本机 Node 构建缺 fts5（如 22.x 官方 win-x64）时 db 层建库即报 no such module: fts5，
// 属环境能力缺失而非回归——按仓库惯例打印原因后退出 0 跳过（详见 helpers/sqlite-fts5.mjs）。
// 注意：本测试的 svc.inject 会吞掉 fts5 建索引异常、以「注入缺核心条目」的断言失败暴露，
// 根因同上，同样以环境探测跳过。
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-read-path-'));
const compile = createSharedCompiler(root, tmp);

const injMod = await import(pathToFileURL(compile('main/memory/injection.ts')).href);
const trigMod = await import(pathToFileURL(compile('main/memory/trigger.ts')).href);
const riMod = await import(pathToFileURL(compile('main/memory/recallIntent.ts')).href);
const lane2Mod = await import(pathToFileURL(compile('main/memory/lane2.ts')).href);
const tiMod = await import(pathToFileURL(compile('main/memory/transcriptIndex.ts')).href);
const briefMod = await import(pathToFileURL(compile('main/memory/brief.ts')).href);
const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);
const searchMod = await import(pathToFileURL(compile('main/memory/search.ts')).href);
const hostToolsMod = await import(pathToFileURL(compile('shared/hostTools/meta.ts')).href);
const catalogMod = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
const modelSelMod = await import(pathToFileURL(compile('main/agent/agentModelSelection.ts')).href);

const { openMemoryDb, insertChunk, recordRecallStat } = dbMod;
const { MemoryService, MEMORY_BUDGET_PROFILES, INJECTION_CACHE_MAX_KEYS } = svcMod;
const { detectRecallIntent } = riMod;
const idxMod = await import(pathToFileURL(compile('main/memory/indexer.ts')).href);
const { syncMemoryIndex, chunkMemorySource } = idxMod;
const { isEvergreenSource } = await import(pathToFileURL(compile('main/memory/ranking.ts')).href);
const { listStagingCandidates } = await import(
  pathToFileURL(compile('main/memory/consolidation/gates.ts')).href
);
const {
  TRIGGER_CONSTANTS,
  scoreTriggerChunk,
  selectTriggerHits,
  runTriggerInjection
} = trigMod;
const {
  expandRecallQueries,
  runLane2DeepRecall,
  runLane2WithTimeout,
  LANE2_CONSTANTS
} = lane2Mod;
const { indexSchedulerTranscript, readTranscriptCheckpoint } = tiMod;
const { buildBriefRecallSection, BRIEF_RECALL_CONSTANTS } = briefMod;
const { searchMemory } = searchMod;
const { pickSchedulerModelTarget } = modelSelMod;

const today = (() => {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
})();

function recallRows(db, kind) {
  return db.handle
    .prepare('SELECT chunk_id, kind, query_text FROM recall_stats WHERE kind = ? ORDER BY id')
    .all(kind ?? '%', ...(kind ? [] : []));
}

function mkdirWs(name) {
  const ws = path.join(tmp, name);
  fs.mkdirSync(path.join(ws, 'docs', 'memory'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.muster', 'memory', 'journal'), { recursive: true });
  fs.mkdirSync(path.join(ws, '.muster', 'scheduler'), { recursive: true });
  return ws;
}

// ===========================================================================
// §1 MemoryService.inject：bootstrap 装箱 / 逐回合字节稳定 / 预算画像 / 零注入面 / 落账
// ===========================================================================
{
  const ws = mkdirWs('ws-inject');
  fs.writeFileSync(
    path.join(ws, 'docs', 'memory', 'MEMORY.md'),
    [
      '<!-- 2026-09-01 10:00:00 [s1] -->',
      '#decision [[db]] 数据库统一 PostgreSQL，弃 MySQL',
      '',
      '<!-- 2026-09-02 11:00:00 [s2] -->',
      '#lesson [[worktree]] 嵌套仓容器必须写主仓 info/exclude',
      '',
      '<!-- 2026-09-03 12:00:00 [s3] -->',
      '#note [[misc]] 三号条目填充内容占位'
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(ws, '.muster', 'scheduler', 'MEMORY.md'),
    '# 调度私有记忆\n<!-- 2026-09-04 09:00:00 -->\n调度记忆条目：派活前先看板。',
    'utf8'
  );
  fs.writeFileSync(
    path.join(ws, '.muster', 'memory', 'journal', `${today}.md`),
    '## [topic] 已完成\n- 问题：无\n- 要点：今天干了活',
    'utf8'
  );

  const svc = new MemoryService();
  // worker 面：共享核心（decision 优先装箱）+ 今日 journal
  const w1 = svc.inject(ws, 'worker', undefined, { sessionId: 'sess-a' });
  assert.ok(w1.text.includes('PostgreSQL'), 'worker 注入含共享核心条目');
  assert.ok(w1.text.includes("Today's journal"), 'worker 注入含今日 journal 尾部');
  assert.ok(!w1.text.includes('调度记忆条目'), 'worker 面不注入调度私有记忆（按面选择）');
  assert.ok(
    w1.sections.some((s) => s.kind === 'core' && s.entryCount === 3),
    'worker core 装箱 3 条'
  );
  assert.ok(w1.injectedChunkIds.length >= 3, 'injectedChunkIds 覆盖共享核心 chunk');

  // 逐回合刷新：同 sessionKey 重复调用 → 字节不变（同一结果对象复用）
  const w2 = svc.inject(ws, 'worker', undefined, { sessionId: 'sess-a' });
  assert.strictEqual(w2.text, w1.text, '文件未变：注入文本逐字节一致');
  assert.strictEqual(w2.versionToken, w1.versionToken, 'versionToken 稳定');

  // bootstrap 落账：首次记 kind=bootstrap；字节稳定复用不重复落账
  const db = svc.db(ws);
  const boot1 = recallRows(db, 'bootstrap');
  assert.ok(boot1.length >= 3, `bootstrap 落账覆盖注入 chunk（实际 ${boot1.length}）`);
  assert.ok(boot1.every((r) => r.query_text === 'bootstrap:worker'), 'bootstrap query_text 带面标识');
  const bootCount1 = boot1.length;
  svc.inject(ws, 'worker', undefined, { sessionId: 'sess-a' });
  assert.equal(
    recallRows(db, 'bootstrap').length,
    bootCount1,
    '字节稳定复用不重复落 bootstrap 账'
  );

  // 不同 sessionKey 各自首次落账
  svc.inject(ws, 'worker', undefined, { sessionId: 'sess-b' });
  assert.ok(
    recallRows(db, 'bootstrap').length > bootCount1,
    '新会话键首次注入落自己的 bootstrap 账'
  );

  // 文件变化 → token 变化 → 刷新重注入 + 新一轮落账
  fs.writeFileSync(
    path.join(ws, 'docs', 'memory', 'MEMORY.md'),
    [
      '<!-- 2026-09-01 10:00:00 [s1] -->',
      '#decision [[db]] 数据库统一 PostgreSQL，弃 MySQL',
      '',
      '<!-- 2026-09-05 08:00:00 [s5] -->',
      '#decision [[new]] 刷新后的新条目'
    ].join('\n'),
    'utf8'
  );
  const w3 = svc.inject(ws, 'worker', undefined, { sessionId: 'sess-a' });
  assert.notStrictEqual(w3.versionToken, w1.versionToken, '文件变化 → token 变化');
  assert.ok(w3.text.includes('刷新后的新条目'), '刷新后注入新内容');
  assert.ok(recallRows(db, 'bootstrap').length > bootCount1 + 1, '刷新重落 bootstrap 账');

  // scheduler 面：调度核心（尾部截断）无共享核心/journal
  const s1 = svc.inject(ws, 'scheduler', undefined, { sessionId: 'orch:x' });
  assert.ok(s1.text.includes('调度记忆条目'), 'scheduler 注入调度私有记忆');
  assert.ok(!s1.text.includes('PostgreSQL'), 'scheduler 面不注入共享核心');
  assert.ok(!s1.text.includes("Today's journal"), 'scheduler 面 journal 预算 0（R-12 现行口径）');
  assert.ok(s1.text.includes('[scheduler memory]'), '调度核心带 R-12 标记口径');

  // 零注入面：headless/heartbeat/auto
  for (const kind of ['headless', 'heartbeat', 'auto']) {
    const z = svc.inject(ws, kind, undefined, { sessionId: 'z' });
    assert.equal(z.text, '', `${kind} 零注入`);
    assert.equal(z.sections.length, 0, `${kind} 无分节`);
    assert.equal(z.injectedChunkIds.length, 0, `${kind} 无涉及 chunk`);
  }

  // 预算画像缺省值（接线批按现行注入量级校准）
  assert.equal(MEMORY_BUDGET_PROFILES.scheduler.coreChars, 6_000, 'scheduler 核心预算 6000');
  assert.equal(MEMORY_BUDGET_PROFILES.worker.coreChars, 16_000, 'worker 核心预算 16000');
  assert.equal(MEMORY_BUDGET_PROFILES.worker.journalChars, 2_000, 'worker journal 预算 2000');

  // ---- MAJOR-1 回归：面级注入源——不同面的 versionToken 互不拖动 ----
  // scheduler 注入后仅写 journal 文件 → 调度面 token 不变（orchestrator 不重拼调度前缀：
  // 旧前缀仍在 pi 会话上下文里，token 被拖动=同一会话前缀重复）
  const sBase = svc.inject(ws, 'scheduler', undefined, { sessionId: 'orch:ma1' });
  fs.writeFileSync(
    path.join(ws, '.muster', 'memory', 'journal', `${today}.md`),
    '## [topic] 已完成\n- 问题：MAJOR-1\n- 要点：仅写 journal 的刷新',
    'utf8'
  );
  const sAfter = svc.inject(ws, 'scheduler', undefined, { sessionId: 'orch:ma1' });
  assert.equal(sAfter.versionToken, sBase.versionToken, '仅写 journal 不拖动调度面 token');
  assert.strictEqual(sAfter.text, sBase.text, '调度前缀不重拼（前缀缓存语义）');
  // 反方向：worker 注入后仅写调度私有 MEMORY.md → worker 面 token 不变
  const wBase = svc.inject(ws, 'worker', undefined, { sessionId: 'sess-ma1' });
  fs.writeFileSync(
    path.join(ws, '.muster', 'scheduler', 'MEMORY.md'),
    '# 调度私有记忆\n<!-- 2026-09-06 09:00:00 -->\n调度记忆条目：MAJOR-1 后的新内容。',
    'utf8'
  );
  const wAfter = svc.inject(ws, 'worker', undefined, { sessionId: 'sess-ma1' });
  assert.equal(wAfter.versionToken, wBase.versionToken, '调度私有记忆写入不拖动 worker 面 token');
  // 对照：worker 面自身的源（共享核心）变化仍要刷新
  fs.writeFileSync(
    path.join(ws, 'docs', 'memory', 'MEMORY.md'),
    [
      '<!-- 2026-09-01 10:00:00 [s1] -->',
      '#decision [[db]] 数据库统一 PostgreSQL，弃 MySQL',
      '',
      '<!-- 2026-09-07 08:00:00 [s7] -->',
      '#decision [[ma1]] 面级刷新对照条目'
    ].join('\n'),
    'utf8'
  );
  const wRefresh = svc.inject(ws, 'worker', undefined, { sessionId: 'sess-ma1' });
  assert.notEqual(wRefresh.versionToken, wAfter.versionToken, 'worker 面自身源变化仍刷新 token');

  // ---- MINOR-① 回归：bootstrap 落账只记实际装箱面 ----
  // scheduler 会话的新落账行必须全部指向调度 MEMORY.md 的 chunk（不再把共享核心 chunk
  // 拖进对照集）
  const mark = db.handle.prepare('SELECT COALESCE(MAX(id), 0) m FROM recall_stats').get().m;
  const sZ = svc.inject(ws, 'scheduler', undefined, { sessionId: 'orch:z-minor1' });
  assert.ok(sZ.text.includes('MAJOR-1 后的新内容'), '调度面读到最新私有记忆');
  const newRows = db.handle
    .prepare(
      `SELECT c.source_path FROM recall_stats r JOIN chunks c ON c.id = r.chunk_id
       WHERE r.kind = 'bootstrap' AND r.id > ?`
    )
    .all(mark);
  assert.ok(newRows.length > 0, 'scheduler 会话注入有 bootstrap 落账');
  assert.ok(
    newRows.every((r) => r.source_path === '.muster/scheduler/MEMORY.md'),
    'bootstrap 落账只记调度面实际装箱源（MINOR-①）'
  );

  svc.closeAll();

  // ---- MINOR-③ 回归：injectionCache LRU 上限（淘汰键重注入走重组装+重落账） ----
  {
    const wsLru = mkdirWs('ws-lru');
    fs.writeFileSync(
      path.join(wsLru, 'docs', 'memory', 'MEMORY.md'),
      '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[lru]] LRU 探针条目',
      'utf8'
    );
    const svc2 = new MemoryService();
    svc2.inject(wsLru, 'worker', undefined, { sessionId: 'warm' });
    const db2 = svc2.db(wsLru);
    const bootCount = () => recallRows(db2, 'bootstrap').length;
    const afterWarm = bootCount();
    svc2.inject(wsLru, 'worker', undefined, { sessionId: 'warm' });
    assert.equal(bootCount(), afterWarm, '缓存命中不重落账');
    for (let i = 0; i < INJECTION_CACHE_MAX_KEYS; i += 1) {
      svc2.inject(wsLru, 'worker', undefined, { sessionId: `flood-${i}` });
    }
    const afterFlood = bootCount();
    svc2.inject(wsLru, 'worker', undefined, { sessionId: 'flood-199' });
    assert.equal(bootCount(), afterFlood, '最新键仍在缓存（命中不重落账）');
    svc2.inject(wsLru, 'worker', undefined, { sessionId: 'warm' });
    assert.ok(bootCount() > afterFlood, `超 ${INJECTION_CACHE_MAX_KEYS} 键后最久未用键被 LRU 淘汰（重注入重落账）`);
    svc2.closeAll();
  }
}

// ===========================================================================
// §2 trigger 注入：阈值 / 上限 / 策展层限定（还原即红守卫）/ 落账
// ===========================================================================
{
  const ws = mkdirWs('ws-trigger');
  const db = openMemoryDb(ws);
  const now = Date.now();

  // 打分口径：单词组全词现=1；多关键词部分命中按占比
  assert.equal(scoreTriggerChunk(['嵌套仓'], '我们遇到了嵌套仓的问题'), 1, '单关键词全命中=1');
  assert.equal(scoreTriggerChunk(['容器 恒脏'], '容器有点脏'), 0.5, '双关键词中一=0.5');
  assert.equal(scoreTriggerChunk(['postgres'], '数据库换 MySQL 了'), 0, '未命中=0');
  assert.equal(scoreTriggerChunk(null, '任意内容'), 0, '无 triggers=不合格');
  assert.equal(scoreTriggerChunk([], '任意内容'), 0, '空 triggers=不合格');

  // 策展层限定（还原即红）：staging/transcript 带 triggers 也不合格
  const memId = insertChunk(db, {
    sourceType: 'memory',
    sourcePath: 'docs/memory/MEMORY.md',
    text: '嵌套仓容器必须写主仓 info/exclude',
    origin: 'system',
    triggers: ['嵌套仓']
  });
  const stagingId = insertChunk(db, {
    sourceType: 'staging',
    text: '嵌套仓的暂存候选内容',
    origin: 'worker',
    triggers: ['嵌套仓']
  });
  const transcriptId = insertChunk(db, {
    sourceType: 'transcript',
    sourcePath: 'scheduler-session:x',
    text: '嵌套仓的调度转录消息',
    origin: 'scheduler',
    triggers: ['嵌套仓']
  });
  const r0 = runTriggerInjection(db, '嵌套仓又出现了', now);
  assert.equal(r0.hits.length, 1, '仅策展层 1 条命中');
  assert.equal(r0.hits[0].chunkId, memId, '命中是 memory 策展层 chunk');
  assert.notEqual(r0.hits[0].chunkId, stagingId, 'staging chunk 不参与 trigger 注入');
  assert.notEqual(r0.hits[0].chunkId, transcriptId, 'transcript chunk 不参与 trigger 注入');
  assert.ok(r0.block.includes('相关记忆提醒'), '强匹配组装紧凑隐藏块');

  // 落账：kind=trigger_injected + relevance=得分
  const trig = recallRows(db, 'trigger_injected');
  assert.equal(trig.length, 1, 'trigger_injected 落账 1 条');
  assert.ok(trig[0].query_text.includes('嵌套仓'), 'query_text 记消息原文截断');

  // features 语料带 triggers 也不参与 trigger 注入（MAJOR-2 策展层限定；还原即红：
  // 把 listTriggerEligibleChunks 的 WHERE 扩回 features 即转红）
  insertChunk(db, {
    sourceType: 'features',
    sourcePath: 'docs/features/virtual-screen.md',
    text: '虚拟屏幕的 IPC 通道与坐标换算',
    origin: 'system',
    triggers: ['虚拟屏幕']
  });
  const rFeat = runTriggerInjection(db, '虚拟屏幕又出现了', now + 2);
  assert.equal(rFeat.hits.length, 0, 'features chunk 不参与 trigger 注入');
  assert.equal(rFeat.block, '', '无强匹配=空块');

  // 阈值：0.5 部分命中（< 0.72）不注入
  const rHalf = runTriggerInjection(db, '容器相关的另一个话题', now + 1);
  assert.equal(rHalf.hits.length, 0, '部分命中 0.5 < 0.72 阈值：不注入');
  assert.equal(rHalf.block, '', '无强匹配=空块');

  // 上限：4 条强命中只注入 ≤3（分降序）
  const db2 = openMemoryDb(mkdirWs('ws-trigger-cap'));
  for (let i = 0; i < 4; i += 1) {
    insertChunk(db2, {
      sourceType: 'memory',
      text: `上限测试条目 ${i}`,
      origin: 'system',
      triggers: ['上限测试'],
      importance: i + 1
    });
  }
  const rc = runTriggerInjection(db2, '上限测试', now);
  assert.equal(rc.hits.length, TRIGGER_CONSTANTS.MAX_PER_TURN, `每回合 ≤${TRIGGER_CONSTANTS.MAX_PER_TURN} 条`);
  assert.equal(TRIGGER_CONSTANTS.STRONG_MATCH_THRESHOLD, 0.72, '阈值常量=0.72（§7）');
  // 排序兜底：importance 高者优先（同分）
  assert.equal(rc.hits[0].text, '上限测试条目 3', '同分按 importance 降序');

  // selectTriggerHits 纯函数直查（上限截断在 select 层）
  const fakeChunks = Array.from({ length: 5 }, (_, i) => ({
    chunkId: i + 1,
    sourceType: 'memory',
    sourcePath: null,
    text: `t${i}`,
    triggers: ['kw'],
    importance: null,
    observedAt: null
  }));
  assert.equal(selectTriggerHits(fakeChunks, 'kw 内容').length, 3, 'select 层上限 3');
  db.close();
  db2.close();
}

// ===========================================================================
// §3 回忆意图矩阵（确定性词法启发；MAJOR-4 形态约束）
// ===========================================================================
{
  const positive = [
    '上周我们做了什么决定？',
    '上次那个任务是怎么收尾的',
    '昨天你提过的方案再讲讲',
    '之前那个决定是什么来着',
    '当时为什么选了 PostgreSQL',
    '为什么这么排期',
    '那个排查后来怎么样了',
    'what did we decide last week',
    'why did you choose bge-small',
    'previously we discussed the release plan, right?',
    // 名词锚定新形态（修复不得丢的召回）
    '上一次的结论是什么，帮我找一下',
    '更早的时候我们是怎么解决这个问题的',
    'what did we say earlier today',
    'did we agree on this earlier today?',
    '之前提过的结论整理一下',
    '上次的会话结论还在吗'
  ];
  for (const p of positive) {
    const r = detectRecallIntent(p);
    assert.ok(r.intent, `应判回忆意图：${p}`);
    assert.ok(r.matched.length > 0, `证据非空：${p}`);
  }
  // 裸子串形态约束（MAJOR-4）：「之前那/先前的/更早/上次」类后接操作对象（分支/版本/
  // 配置/提交/参数…）的普通任务指令不再误报；英文裸 earlier / 纯时间状语执行指令不误报
  const negative = [
    '帮我创建一个新的任务',
    '先跑 npm install 再跑测试',
    '把这个文件改成 TypeScript',
    '你好',
    '以后再说吧',
    'before you commit, run the tests',
    '把容器重启一下',
    // —— 评审负例矩阵（B5 评审 MAJOR-4；还原形态约束即红）——
    '切回之前那个分支',
    '恢复到之前那个版本',
    '用先前的配置再跑一次',
    '回退到更早的提交',
    '按上次的参数重新构建',
    '按上一次的配置重新部署',
    '切回上次的分支继续开发',
    '沿用之前的配置跑测试',
    '更早的提交里就有这个 bug，帮我验证',
    '先前的容器名还继续用，不用改',
    '沿用上次的构建产物直接发布',
    '像上次一样直接跑 npm test',
    '恢复到之前那个稳定版本再试',
    '把配置改回先前那样',
    'check the logs from earlier today',
    'run the tests again like earlier',
    'revert to the earlier commit',
    'restore the config from earlier and rerun',
    '用上次的部署流水线重新发版',
    '把主题切回之前的暗色设置',
    '把依赖版本固定到上一次锁定的那组'
  ];
  for (const n of negative) {
    const r = detectRecallIntent(n);
    assert.ok(!r.intent, `不应判回忆意图：${n}（证据=${JSON.stringify(r.matched)}）`);
  }
  assert.equal(detectRecallIntent('').intent, false, '空串=false');
  // 查询扩展：原句 + 时间词剥离变体 + 关键词重组
  const qs = expandRecallQueries('上周 为什么 选了 PostgreSQL 而不是 MySQL？');
  assert.equal(qs[0], '上周 为什么 选了 PostgreSQL 而不是 MySQL？', '首变体=原句');
  assert.ok(qs.length >= 2, '至少产出剥离变体');
  assert.ok(qs.every((q) => q.trim().length > 0), '变体非空');
}

// ===========================================================================
// §4 Lane2：条件两分支 + 净化摘录 + 超时降级
// ===========================================================================
{
  const mkHit = (id, score, text, sourceType = 'transcript') => ({
    chunkId: id,
    sourceType,
    sourcePath: `scheduler-session:s${id}`,
    text,
    finalScore: score
  });
  // 条件分支①：无回忆意图 → 不跑
  const rNoIntent = await runLane2DeepRecall(
    { search: async () => [mkHit(1, 9, 'x')] },
    '帮我新建一个任务'
  );
  assert.equal(rNoIntent.skipped, 'no_intent', '无回忆意图 → skipped:no_intent');
  assert.equal(rNoIntent.ran, false, '不执行深检索');

  // 条件分支②：Lane1 强命中 → 不跑
  const rStrong = await runLane2DeepRecall(
    { search: async () => [mkHit(1, 9, 'x')] },
    '上次为什么选了 PostgreSQL',
    { lane1StrongHit: true }
  );
  assert.equal(rStrong.skipped, 'lane1_strong_hit', 'Lane1 强命中 → 不升级');

  // 强命中分支：净化摘录（压平换行 + 截断）+ 有界
  const longText = Array.from({ length: 40 }, (_, i) => `第${i}行内容`).join('\n');
  const rFound = await runLane2DeepRecall(
    { search: async () => [mkHit(7, 0.42, longText), mkHit(8, 0.2, '短命中')] },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rFound.ran && rFound.found, '意图+无强命中 → 深检索执行且找到');
  assert.ok(!rFound.block.includes('\n第'), '摘录压平换行');
  assert.ok(rFound.block.includes('…'), '超长摘录截断带省略号');
  assert.deepEqual(rFound.injectedChunkIds.sort(), [7, 8], '注入块涉及 chunk 落账面');
  assert.ok(rFound.block.length <= LANE2_CONSTANTS.BLOCK_MAX_CHARS + 600, '注入块有界');

  // 弱关联分支：全部低于阈值 → 有界「未找到相关记录」说明
  const rWeak = await runLane2DeepRecall(
    { search: async () => [mkHit(1, 0.001, '微弱命中')] },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rWeak.ran && !rWeak.found, '弱关联 → found=false');
  assert.ok(rWeak.block.includes('未找到'), '注入有界未找到说明');
  assert.equal(rWeak.injectedChunkIds.length, 0, '未找到不落 escalation 账');

  // 阈值边界（MIN_RELEVANT_SCORE 连动上调 0.05→0.15；探针依据见 lane2.ts 注释）
  assert.equal(LANE2_CONSTANTS.MIN_RELEVANT_SCORE, 0.15, 'MIN_RELEVANT_SCORE=0.15');
  const rBelow = await runLane2DeepRecall(
    { search: async () => [mkHit(1, LANE2_CONSTANTS.MIN_RELEVANT_SCORE - 0.01, '边界下命中')] },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rBelow.ran && !rBelow.found, '阈值下 0.14 → 未找到（不注入噪声摘录）');
  const rAbove = await runLane2DeepRecall(
    { search: async () => [mkHit(1, LANE2_CONSTANTS.MIN_RELEVANT_SCORE + 0.01, '边界上命中')] },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rAbove.ran && rAbove.found, '阈值上 0.16 → 找到');

  // 超时降级：search 挂起（比超时窗长，但最终 settle——不留 unsettled top-level await）
  const rTimeout = await runLane2WithTimeout(
    {
      search: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([]), 400);
        })
    },
    '上次为什么选了 PostgreSQL',
    { timeoutMs: 50 }
  );
  assert.equal(rTimeout.skipped, 'timeout', '超时 → skipped:timeout');
  assert.equal(rTimeout.ran, false, '超时静默降级为不注入');
  assert.equal(rTimeout.block, '', '超时不注入任何内容');

  // 异常降级标签区分（MINOR-④）：编排层异常 ≠ 超时（单查询失败已被 per-query catch
  // 吞成「未找到」，能到这里的 error 是编排级异常——如检索依赖同步抛错）
  const rError = await runLane2WithTimeout(
    {
      search: () => {
        throw new Error('db locked');
      }
    },
    '上次为什么选了 PostgreSQL',
    { timeoutMs: 500 }
  );
  assert.equal(rError.skipped, 'error', '检索异常 → skipped:error（区别于 timeout）');
  assert.equal(rError.ran, false, '异常静默降级为不注入');

  // 全查询失败：degraded 信号 + 文案 ≠「未找到」（MAJOR：empty vs degraded）
  const rErr = await runLane2DeepRecall(
    { search: async () => Promise.reject(new Error('boom')) },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rErr.ran, '检索异常不中断编排');
  assert.equal(rErr.found, false, '全查询失败 found=false');
  assert.equal(rErr.degraded, true, '全查询失败 → degraded=true（还原即红：旧实现伪装未找到）');
  assert.ok(rErr.failedQueries >= 1, 'failedQueries 记失败数');
  assert.ok(rErr.block.includes('检索通道异常'), 'degraded 文案≠未找到说明');
  assert.ok(!rErr.block.includes('未找到与本次提问强相关'), '不得把失败伪装「未找到」');

  // 阈值比 bm25Norm（绝对相关性），不掺 recency/importance/repo 衰减（MAJOR）
  // 旧 journal 命中：bm25Norm 高、finalScore 被 recency 压扁——修前判未找到
  const rOldJournal = await runLane2DeepRecall(
    {
      search: async () => [
        {
          chunkId: 21,
          sourceType: 'journal',
          sourcePath: 'docs/journal/2024-01-01.md',
          text: '当年决定用 PostgreSQL 是因为运维只维护 PG 镜像，弃 MySQL',
          finalScore: 0.04,
          bm25Norm: 0.82
        }
      ]
    },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rOldJournal.ran && rOldJournal.found, 'bm25Norm 过阈值应保留（还原即红：旧实现比 finalScore 误杀旧命中）');
  assert.ok(rOldJournal.injectedChunkIds.includes(21), '旧命中进注入/落账面');
  // 反例：bm25Norm 低、final 被其它因子抬高 → 仍应判未找到
  const rWeakHybrid = await runLane2DeepRecall(
    {
      search: async () => [
        {
          chunkId: 22,
          sourceType: 'memory',
          sourcePath: 'docs/memory/MEMORY.md',
          text: '弱相关噪声',
          finalScore: 0.5,
          bm25Norm: 0.05
        }
      ]
    },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rWeakHybrid.ran && !rWeakHybrid.found, 'bm25Norm 低于阈值 → 未找到（不得被 finalScore 抬过线）');
}

// ===========================================================================
// §4b Lane2 阈值端到端：旧日期 journal 强词法命中（recency 压 finalScore）
// ===========================================================================
{
  const wsL2 = mkdirWs('ws-lane2-recency');
  const dbL2 = openMemoryDb(wsL2);
  const now = Date.now();
  const oldAt = now - 180 * 86_400_000; // recency ≈ 0.5^6 ≈ 0.016
  insertChunk(dbL2, {
    sourceType: 'journal',
    sourcePath: 'docs/journal/2024-01-15.md',
    text: '为什么选了 PostgreSQL 而不是 MySQL：运维只维护 PG 镜像，统一了备份链路',
    origin: 'system',
    observedAt: oldAt
  });
  const hits = await searchMemory(dbL2, '为什么选了 PostgreSQL', { now, recordStats: false, topK: 5 });
  assert.ok(hits.length >= 1, '旧 journal 词法命中');
  assert.ok(hits[0].bm25Norm >= LANE2_CONSTANTS.MIN_RELEVANT_SCORE, `bm25Norm=${hits[0].bm25Norm} 应过阈值`);
  assert.ok(hits[0].finalScore < LANE2_CONSTANTS.MIN_RELEVANT_SCORE, `finalScore=${hits[0].finalScore} 被 recency 压低`);
  const rE2e = await runLane2DeepRecall(
    {
      search: (q, topK) => searchMemory(dbL2, q, { now, recordStats: false, topK })
    },
    '上次为什么选了 PostgreSQL'
  );
  assert.ok(rE2e.ran && rE2e.found, '旧但相关：bm25Norm 过阈值不得被 recency 误判未找到');
  assert.ok(rE2e.block.includes('PostgreSQL'), '命中摘录进注入块');
  dbL2.close();
}

// ===========================================================================
// §4c injection：首条也受 core 预算约束 + 装饰计入预算（还原即红）
// ===========================================================================
{
  const huge = `#decision [[db]] ${'超长决策正文'.repeat(400)}`;
  const md = `<!-- 2026-09-01 10:00:00 [s1] -->\n${huge}\n\n<!-- 2026-09-02 10:00:00 [s2] -->\n#lesson 短条目也应被挤出或装箱`;
  const budget = 800;
  const assembled = injMod.assembleSharedCore(md, budget);
  assert.ok(assembled.text.length > 0, '超长单条仍注入（硬切保底）');
  assert.ok(
    assembled.text.length <= budget + 80,
    `单条 raw 远超 coreChars 时不得原样注入（len=${assembled.text.length} budget=${budget}；还原即红：旧实现无条件装箱）`
  );
  assert.ok(assembled.text.includes('…') || assembled.text.includes('前文省略'), '超长条目硬切带省略标记');
  // 多条正常装箱不受影响：短条目在预算内全进
  const small = injMod.assembleSharedCore(
    [
      '<!-- 2026-09-01 10:00:00 [s1] -->',
      '#decision [[db]] 短决策',
      '',
      '<!-- 2026-09-02 10:00:00 [s2] -->',
      '#lesson 短教训'
    ].join('\n'),
    2000
  );
  assert.ok(small.entryCount === 2, `预算充足时两条都装（实际 ${small.entryCount}）`);
  assert.ok(small.text.length <= 2000 + 80, '正常装箱也计入装饰预算');
}

// ===========================================================================
// §5 调度转录增量索引：增量/防重放/脱敏/判重/召回回路/origin 分类
// ===========================================================================
{
  const ws = mkdirWs('ws-transcript');
  const db = openMemoryDb(ws);
  const now = Date.now();
  const mkMsg = (id, role, content, extra = {}) => ({
    id,
    role,
    content,
    toolNames: [],
    ...extra
  });
  const batch1 = [
    mkMsg('m1', 'user', '请记住：部署脚本必须先跑 npm install，pnpm 会被 packageManager 挡下'),
    mkMsg('m2', 'assistant', '结论：数据库统一 PostgreSQL，弃 MySQL，原因是运维只维护 PG 镜像。'),
    mkMsg('m3', 'assistant', '带密钥的回复 sk-1234567890abcdef1234567890abcdef 请入库'),
    mkMsg('m4', 'host-user', 'host 自治消息', { host: true }),
    mkMsg('m5', 'user', '排队未发', { queued: true }),
    mkMsg('m6', 'user', '短', ),
  ];
  const r1 = indexSchedulerTranscript(db, { sessionKey: 'sess.jsonl', messages: batch1, now });
  assert.ok(r1.ok, '索引入口 ok');
  // m1（明示记住→origin=user）、m2（scheduler）、m3（scheduler）入库；m4 host→scheduler；
  // m5 queued 跳过；m6 太短跳过 —— 但 m4/m6：host 消息也入库（scheduler 定性）
  const rows = db.handle
    .prepare("SELECT text, origin, session_kind, source_type FROM chunks WHERE source_type = 'transcript' ORDER BY id")
    .all();
  const texts = rows.map((r) => r.text);
  assert.ok(texts.some((t) => t.includes('npm install')), '用户消息入库');
  assert.ok(texts.some((t) => t.includes('PostgreSQL')), 'assistant 结论入库');
  assert.ok(
    texts.some((t) => t.includes('REDACTED')),
    '凭证形态脱敏后入库（redact.ts）'
  );
  assert.ok(!texts.some((t) => t.includes('sk-1234567890abcdef')), '原密钥不入库');
  assert.ok(!texts.some((t) => t.includes('排队未发')), 'queued 消息跳过');
  assert.ok(!texts.some((t) => t.length < 12), '长度门生效');
  assert.ok(rows.every((r) => r.session_kind === 'scheduler'), 'session_kind=scheduler');
  assert.ok(
    rows.some((r) => r.origin === 'user' && r.text.includes('npm install')),
    '明示记住的用户消息 origin=user'
  );
  assert.ok(rows.some((r) => r.origin === 'scheduler'), 'assistant/host 消息 origin=scheduler');

  // 污点：网络来源工具消息 → untrusted
  indexSchedulerTranscript(db, {
    sessionKey: 'sess2.jsonl',
    messages: [mkMsg('n1', 'assistant', '网络工具后的结论内容足够长了，应该会被索引到', { toolNames: ['web.fetch'] })],
    now
  });
  const untrusted = db.handle
    .prepare("SELECT origin FROM chunks WHERE source_type = 'transcript' AND text LIKE '%网络工具后%'")
    .all();
  assert.equal(untrusted[0]?.origin, 'untrusted', '网络来源工具消息 → untrusted');

  // 防重放：同消息再触发 → checkpoint_replay 零新增
  const r2 = indexSchedulerTranscript(db, { sessionKey: 'sess.jsonl', messages: batch1, now: now + 1000 });
  assert.equal(r2.skipped, 'checkpoint_replay', '消息数未增 → 重放跳过');
  assert.equal(r2.added, 0, '重放零新增');
  const cp = readTranscriptCheckpoint(db, 'sess.jsonl');
  assert.ok(cp && cp.lastMessageId, '检查点带末条消息 id 锚点');

  // 增量：新消息只索引新增窗口
  const batch2 = [...batch1, mkMsg('m7', 'user', '增量窗口的新用户消息，长度足够被索引')];
  const r3 = indexSchedulerTranscript(db, { sessionKey: 'sess.jsonl', messages: batch2, now: now + 2000 });
  assert.ok(r3.examined >= 1 && r3.added >= 1, '增量窗口索引新消息');
  const m7 = db.handle
    .prepare("SELECT id FROM chunks WHERE source_type = 'transcript' AND text LIKE '%增量窗口%'")
    .all();
  assert.equal(m7.length, 1, '新增消息恰好一条（无重复）');

  // 判重：与既有 chunk 高重叠的消息跳过
  const r4 = indexSchedulerTranscript(db, {
    sessionKey: 'sess3.jsonl',
    messages: [mkMsg('d1', 'assistant', '结论：数据库统一 PostgreSQL，弃 MySQL，原因是运维只维护 PG 镜像。')],
    now: now + 3000
  });
  assert.equal(r4.added, 0, '与既有 transcript chunk 高重叠 → 判重跳过');
  assert.ok((r4.rejected.duplicate ?? 0) >= 1, 'duplicate 计数');

  // 召回回路防护：与「被注入过」的 chunk 高重叠 → recall_loop 拒收
  const recalledId = insertChunk(db, {
    sourceType: 'memory',
    text: '被注入过的旧条目：构建产物必须走 dist 目录而不是 build 目录，避免缓存串台',
    origin: 'system'
  });
  recordRecallStat(db, recalledId, 'bootstrap', 'bootstrap:scheduler', now, null);
  const r5 = indexSchedulerTranscript(db, {
    sessionKey: 'sess4.jsonl',
    messages: [mkMsg('e1', 'assistant', '被注入过的旧条目：构建产物必须走 dist 目录而不是 build 目录，避免缓存串台')],
    now: now + 4000
  });
  assert.equal(r5.added, 0, '被注入内容不再回炉（召回回路防护）');
  assert.ok((r5.rejected.recall_loop ?? 0) >= 1, 'recall_loop 计数');
  db.close();
}

// ===========================================================================
// §6 简报定向召回：brief_injected 落账 + searchMemory recordStats 开关
// ===========================================================================
{
  const ws = mkdirWs('ws-brief');
  const db = openMemoryDb(ws);
  const id1 = insertChunk(db, {
    sourceType: 'memory',
    sourcePath: 'docs/memory/MEMORY.md',
    text: '部署脚本必须先跑 npm install',
    origin: 'system'
  });
  const id2 = insertChunk(db, {
    sourceType: 'journal',
    sourcePath: `docs/journal/${today}.md`,
    text: '今日要点：修了构建缓存串台问题',
    origin: 'system'
  });

  // searchMemory recordStats:false → 不落 search_hit（调用方自带注入 kind）
  await searchMemory(db, 'npm install', { topK: 2, recordStats: false });
  assert.equal(recallRows(db, 'search_hit').length, 0, 'recordStats=false 不落 search_hit');
  // 缺省 true → 落 search_hit
  await searchMemory(db, 'npm install', { topK: 2 });
  assert.ok(recallRows(db, 'search_hit').length > 0, '缺省落 search_hit');

  // buildBriefRecallSection：排序断言（引擎序透传）+ brief_injected 落账
  const calls = [];
  const section = await buildBriefRecallSection(
    db,
    async (query, topK) => {
      calls.push({ query, topK });
      return [
        { chunkId: id1, sourceType: 'memory', sourcePath: 'docs/memory/MEMORY.md', lineStart: 1, text: '部署脚本必须先跑 npm install', finalScore: 0.9 },
        { chunkId: id2, sourceType: 'journal', sourcePath: `docs/journal/${today}.md`, lineStart: 3, text: '今日要点：修了构建缓存串台问题', finalScore: 0.4 }
      ].slice(0, topK);
    },
    '部署脚本怎么跑'
  );
  assert.equal(calls.length, 1, '单查询检索');
  assert.equal(calls[0].topK, BRIEF_RECALL_CONSTANTS.TOP_K, '按简报预算取 K');
  assert.ok(section.text.includes('### 相关历史（检索命中）'), '检索段形态与旧简报兼容');
  assert.ok(section.text.indexOf('npm install') < section.text.indexOf('缓存串台'), '命中按引擎排序（高分在前）');
  const briefRows = recallRows(db, 'brief_injected');
  assert.equal(briefRows.length, 2, 'brief_injected 每命中一条落账');
  assert.ok(briefRows.some((r) => r.chunk_id === id1), '落账覆盖命中 chunk');
  assert.deepEqual(section.accountedChunkIds.sort(), [id1, id2].sort(), '落账面与命中一致');

  // 空任务 → 空段
  const empty = await buildBriefRecallSection(db, async () => [], '  ');
  assert.equal(empty.text, '', '空查询空段');
  db.close();
}

// ===========================================================================
// §7 Worker 工具面注册：PTY 白名单 + hostTools 元数据 + catalog
// ===========================================================================
{
  assert.ok(
    hostToolsMod.PTY_HOST_TOOL_ALLOWLIST.includes('memory.search'),
    'PTY/Shell API 白名单含 memory.search'
  );
  // 当前记忆入口包含日志和纠错；remember 投影至 GUI/ACP，PTY 不投影。
  assert.deepEqual(
    hostToolsMod.HOST_MEMORY_TOOL_IDS,
    ['memory.journal', 'memory.journalGet', 'memory.search', 'memory.list', 'memory.get',
      'memory.confirm', 'memory.note', 'memory.correct', 'memory.correctionStatus', 'memory.remember'],
    'memory 组工具清单'
  );
  const meta = hostToolsMod.getHostToolMeta('memory.search');
  assert.equal(meta.permissionClass, 'read', 'memory.search=read 权限档');
  assert.ok(meta.presets.includes('gui-full'), 'GUI Worker 面可用');
  assert.ok(meta.presets.includes('pty-allowlist'), 'PTY 白名单面可用');
  assert.ok(meta.presets.includes('acp-subset'), 'ACP Worker 面可用');
  assert.ok(!hostToolsMod.getHostToolMeta('memory.remember').presets.includes('pty-allowlist'), 'remember 不进入 PTY');
  // catalog：TOOL_DEFS 在册 + 版本 bump
  const def = catalogMod.getToolDef('memory.search');
  assert.ok(def, 'TOOL_DEFS 含 memory.search');
  // R0 英文化后描述以 history 模式表述语料面（task/history 双模式在 schema 枚举）
  assert.ok(def.summary.includes('history'), '工具描述覆盖新语料面（history 模式）');
  assert.ok(def.parameters.properties.mode.enum.includes('history'), 'mode 枚举含 history');
  assert.ok(Number(catalogMod.CATALOG_VERSION.split('.')[1]) >= 50, `catalog 公共工具面版本（当前 ${catalogMod.CATALOG_VERSION}）`);
  // MAJOR-3：memory.list 死路教学改真实路径（与 memory.search 描述一致；R0 英文化后措辞为 memory center）
  const listDef = catalogMod.getToolDef('memory.list');
  assert.ok(listDef, 'TOOL_DEFS 含 memory.list');
  assert.ok(!listDef.description.includes('命中带条目 id'), 'memory.list 死路教学已移除');
  assert.match(listDef.description, /nextOffset/, 'memory.list explains how to continue the result');
  assert.ok(def.summary.includes('history'), 'memory.search 支持显式历史查询（与 list 一致的真实路径）');
  assert.ok(def.parameters.properties.mode.enum.includes('task'), 'memory.search 语料面 task/history 双模式');
}

// ===========================================================================
// §8 调度模型访问器解析（pickSchedulerModelTarget：会话覆盖 → 工作区持久 → 空）
// ===========================================================================
{
  assert.deepEqual(
    pickSchedulerModelTarget({ providerId: 'p1', modelId: 'm1' }, { providerId: 'p2', modelId: 'm2' }),
    { providerId: 'p1', modelId: 'm1' },
    '会话级覆盖优先'
  );
  assert.deepEqual(
    pickSchedulerModelTarget(undefined, { providerId: 'p2', modelId: 'm2' }),
    { providerId: 'p2', modelId: 'm2' },
    '无会话覆盖用工作区持久选择'
  );
  assert.deepEqual(pickSchedulerModelTarget(undefined, undefined), {}, '两层皆无 → 空对象（调用方回落全局 active）');
  assert.deepEqual(
    pickSchedulerModelTarget({ providerId: '', modelId: 'm1' }, { providerId: 'p2', modelId: 'm2' }),
    { providerId: 'p2', modelId: 'm2' },
    '残缺会话覆盖（缺 provider）不采信，回落持久选择'
  );
}

// ===========================================================================
// §9 features 功能文档语料（B5 评审 MAJOR-2）：可检索 / 不进注入 / 常青 / 不可晋升
// ===========================================================================
{
  const ws = mkdirWs('ws-features');
  fs.mkdirSync(path.join(ws, 'docs', 'features'), { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'docs', 'memory', 'MEMORY.md'),
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[db]] 数据库统一 PostgreSQL，弃 MySQL',
    'utf8'
  );
  fs.writeFileSync(
    path.join(ws, 'docs', 'features', 'virtual-screen.md'),
    [
      '# 虚拟屏幕',
      '',
      '功能职责：把宿主窗口投射到虚拟显示。',
      '',
      '## 数据流',
      '',
      'IPC 通道 screen:attach 由主进程转发。',
      '',
      '## 已知边界',
      '',
      '多显示器 DPI 不一致时坐标偏移。'
    ].join('\n'),
    'utf8'
  );

  const svc = new MemoryService();
  const db = svc.init(ws);

  // 可检索：显式同步索引（svc.search 的惰性同步在真实链路里做同样的事）后命中
  // features（含按文件名/关键词两种形态）
  syncMemoryIndex(db, ws);
  const hits = await searchMemory(db, '虚拟屏幕 screen:attach 数据流', { topK: 5, recordStats: false });
  const featHit = hits.find((h) => h.sourceType === 'features');
  assert.ok(featHit, 'features 文档可被 searchMemory 命中');
  assert.equal(featHit.sourcePath, 'docs/features/virtual-screen.md', '命中带 features 源路径');
  assert.equal(featHit.recency, 1, 'features 常青（新近度不衰减）');
  assert.ok(isEvergreenSource('features'), 'isEvergreenSource 认 features');

  // 小节切块：导语 + 两个 `## ` 节；文件名拼进正文（按名命中）；行号随段
  const featChunks = db.handle
    .prepare("SELECT id, text, line_start FROM chunks WHERE source_type = 'features' ORDER BY id")
    .all();
  assert.ok(featChunks.length >= 3, '`## ` 小节切块（导语+两节）');
  assert.ok(featChunks.every((c) => c.text.includes('virtual-screen.md')), '文件名拼进 chunk 正文');
  assert.ok(featChunks.every((c) => Number.isInteger(c.line_start)), '小节行号落账');
  const featIds = featChunks.map((c) => Number(c.id));

  // 不进任何注入面：worker / scheduler 注入文本与 injectedChunkIds 都不含 features
  const w = svc.inject(ws, 'worker', undefined, { sessionId: 'f1' });
  assert.ok(!w.text.includes('虚拟屏幕'), 'worker 注入不含 features 内容');
  assert.ok(!w.injectedChunkIds.some((id) => featIds.includes(id)), 'worker injectedChunkIds 不含 features');
  const s = svc.inject(ws, 'scheduler', undefined, { sessionId: 'f2' });
  assert.ok(!s.text.includes('虚拟屏幕'), 'scheduler 注入不含 features 内容');
  assert.ok(!s.injectedChunkIds.some((id) => featIds.includes(id)), 'scheduler injectedChunkIds 不含 features');

  // 结构性不可晋升：晋升候选只来自 staging 表——features 语料不产生任何候选
  assert.equal(listStagingCandidates(db).length, 0, 'features 语料不产生晋升候选');

  // 超长小节硬切续块（正文不静默丢弃）
  const longBody = Array.from({ length: 1200 }, (_, i) => `长文档第${i}行内容占位`).join('\n');
  const drafts = chunkMemorySource(`# 长文档\n\n## 大节\n\n${longBody}`, 'features', null, 'long-doc.md');
  assert.ok(drafts.length >= 3, `超长小节切成多块（实际 ${drafts.length}）`);
  assert.ok(drafts.every((d) => d.text.length <= 4000), '单块有界');
  assert.ok(drafts.map((d) => d.text).join('').includes('长文档第1199行'), '续块内容不丢');
  svc.closeAll();
}

console.log(`memory-read-path(B5): ok (tmp=${tmp})`);
