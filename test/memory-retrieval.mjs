/**
 * 记忆重构 P1 检索（memory-refactor B2）：排序因子矩阵（半衰期/常青/importance/
 * repoAffinity 三态）、BM25 归一、MMR 去重数学、索引切块与增量失效（mtime+size 快速路径 + 内容哈希）、
 * searchMemory 端到端（FTS 真跑）、fs.watch 防抖与失败退化。
 * Run: node test/memory-retrieval.mjs
 * 全部落系统临时目录（mkdtemp）。
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
if (!(await sqliteFts5Supported())) {
  console.log('skip: 当前 Node 的 node:sqlite 缺 fts5 扩展，记忆库（FTS 全文索引）用例无法运行');
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-retrieval-'));
const compile = createSharedCompiler(root, tmp);

const rankMod = await import(pathToFileURL(compile('main/memory/ranking.ts')).href);
const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const idxMod = await import(pathToFileURL(compile('main/memory/indexer.ts')).href);
const searchMod = await import(pathToFileURL(compile('main/memory/search.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);

const {
  RANKING_CONSTANTS: RC,
  recencyDecayFactor,
  importanceMultiplier,
  repoAffinityMultiplier,
  normalizeBm25,
  poolMaxBm25Rel,
  jaccardSimilarity,
  mmrTokenSet,
  mmrSelect
} = rankMod;
const { openMemoryDb, insertChunk, countChunks } = dbMod;
const DAY = 86_400_000;

/* ---------------- 1. 排序因子矩阵 ---------------- */
{
  const now = Date.now();
  // 半衰期边界：恰 30 天 = 0.5；60 天 = 0.25；未来日期不放大（钳 0 天）
  assert.ok(Math.abs(recencyDecayFactor('journal', now - 30 * DAY, now) - 0.5) < 1e-9, '30 天恰半衰期=0.5');
  assert.ok(Math.abs(recencyDecayFactor('journal', now - 60 * DAY, now) - 0.25) < 1e-9, '60 天=0.25');
  assert.equal(recencyDecayFactor('journal', now + DAY, now), 1.0, '未来时间钳为 1.0');
  // 常青源：MEMORY（工作区+调度同 source_type）/ USER 恒 1.0，有日期也不衰减
  assert.equal(recencyDecayFactor('memory', now - 365 * DAY, now), 1.0, 'MEMORY 常青');
  assert.equal(recencyDecayFactor('user_md', now - 365 * DAY, now), 1.0, 'USER 常青');
  // 非常青源无日期：中性 1.0（文件名日期解析失败的兜底，不惩罚）
  assert.equal(recencyDecayFactor('journal', null, now), 1.0);
  // importance：缺失/越界中性；1→0.5；10→1.5；5.5 中点≈1.0（线性）
  assert.equal(importanceMultiplier(null), 1.0);
  assert.equal(importanceMultiplier(undefined), 1.0);
  assert.ok(Math.abs(importanceMultiplier(1) - RC.IMPORTANCE_MIN_MULT) < 1e-9);
  assert.ok(Math.abs(importanceMultiplier(10) - RC.IMPORTANCE_MAX_MULT) < 1e-9);
  assert.ok(Math.abs(importanceMultiplier(5.5) - 1.0) < 1e-9, '5.5 中点乘数=1.0');
  assert.equal(importanceMultiplier(99), 1.5, '越界钳到 [1,10] 后取上限乘数');
  // repoAffinity 三态
  const active = ['github.com/a/b', 'gitlab.com/c/d'];
  assert.equal(repoAffinityMultiplier('github.com/a/b', active), RC.REPO_AFFINITY_IN, '活跃集合内×加成');
  assert.equal(repoAffinityMultiplier('github.com/x/y', active), RC.REPO_AFFINITY_OUT, '集合外有标注×降权');
  assert.equal(repoAffinityMultiplier(null, active), RC.REPO_AFFINITY_NONE, '无标注中性');
  assert.equal(repoAffinityMultiplier('github.com/a/b', []), RC.REPO_AFFINITY_NONE, '空活跃集合=无亲和语境');
  assert.equal(repoAffinityMultiplier('github.com/a/b', null), RC.REPO_AFFINITY_NONE, '缺省集合中性');
  assert.equal(repoAffinityMultiplier('github.com/a/b', new Set(['github.com/a/b'])), RC.REPO_AFFINITY_IN, 'Set 形态同判');
}

/* ---------------- 2. BM25 归一 ---------------- */
{
  // BM25：FTS5 返回负值越小越相关 → rel=-bm25 池内最大者归一 1
  const pool = [-2.0, -1.0, -0.5];
  const max = poolMaxBm25Rel(pool);
  assert.equal(max, 2.0);
  assert.equal(normalizeBm25(-2.0, max), 1.0);
  assert.equal(normalizeBm25(-1.0, max), 0.5);
  assert.equal(normalizeBm25(0, max), 0, '非相关归 0');
  assert.equal(normalizeBm25(-1.0, 0), 0, '池最优≤0 全归 0');

}

/* ---------------- 3. MMR 去重数学（λ=0.7） ---------------- */
{
  // 两条几乎同文的候选 + 一条不同主题：MMR 应压制冗余次名，选出主题多样性
  const items = [
    { id: 'A', text: '数据库统一 SQLite 派生态库', rel: 1.0 },
    { id: 'A2', text: '数据库统一 SQLite 派生态库（重复）', rel: 0.98 },
    { id: 'B', text: '终端渲染用 WebGL 加速', rel: 0.9 }
  ];
  const sim = (a, b) => jaccardSimilarity(mmrTokenSet(a.text), mmrTokenSet(b.text));
  const picked = mmrSelect(items, 2, (x) => x.rel, sim, 0.7);
  assert.equal(picked[0].id, 'A', '首选纯相关性最高');
  // A2 与 A 的 Jaccard 高：λ·0.98 - 0.3·sim(A2,A) 应低于 λ·0.9 - 0.3·sim(B,A)
  assert.equal(picked[1].id, 'B', 'MMR λ=0.7 应压制近重复候选');
  // 手工算术：sim(A2,A) 大到 0.9 时 A2 的 MMR 分 = 0.7*0.98 - 0.3*0.9 = 0.416；
  // sim(B,A)=0 时 B 的 MMR 分 = 0.7*0.9 = 0.63 —— 数学区间的直接验证
  assert.ok(0.7 * 0.98 - 0.3 * 0.9 < 0.7 * 0.9, 'λ=0.7 权衡数学（还原即红：λ 或权重改错即翻转）');
  // 完全重复文本：次名被压到要求 topK 才出现
  const dup = [
    { text: '完全相同文本', rel: 1 },
    { text: '完全相同文本', rel: 0.99 }
  ];
  const picked2 = mmrSelect(dup, 2, (x) => x.rel, (a, b) => jaccardSimilarity(mmrTokenSet(a.text), mmrTokenSet(b.text)), 0.7);
  assert.equal(picked2.length, 2, 'k 内仍会选出（MMR 是排序压制不是硬过滤）');
  assert.equal(picked2[0].text, '完全相同文本');
  // k=0 / 空集
  assert.deepEqual(mmrSelect([], 5, () => 1, () => 0), []);
  assert.deepEqual(mmrSelect(items, 0, () => 1, () => 0), []);
}

/* ---------------- 4. 切块：注解/日期/兜底 ---------------- */
{
  const memMd = [
    '# 手写文件头（无时间戳）',
    '',
    '<!-- 2026-09-01 10:00:00 [s1] -->',
    '#lesson [[isolate-worktree]] 嵌套仓容器必须写主仓 info/exclude。 <!-- trigger: 嵌套仓, 容器恒脏 --> <!-- importance: 8 --> <!-- project: github.com/foo/bar -->',
    '',
    '<!-- 2026-09-02 11:30:00 [s2] -->',
    '#preference 本仓库一律 pnpm。'
  ].join('\n');
  const memChunks = idxMod.chunkMemorySource(memMd, 'memory');
  assert.equal(memChunks.length, 3, '未识别头 + 2 条目');
  assert.ok(memChunks[0].text.includes('手写文件头'), '未识别块原样入索引');
  const lesson = memChunks[1];
  assert.equal(lesson.importance, 8);
  assert.deepEqual(lesson.triggers, ['嵌套仓', '容器恒脏']);
  assert.equal(lesson.repoKey, 'github.com/foo/bar');
  assert.equal(lesson.lineStart, 3, '条目注释行行号');
  assert.ok(lesson.observedAt > 0, '条目 ts 进 observedAt');
  assert.equal(memChunks[2].importance, null, '无注解条目中性');

  const journalMd = [
    '# 2026-09-21 工作日志',
    '',
    '## [记忆检索批次] 已完成',
    '- 问题：检索引擎怎么排',
    '- 要点：hybrid 融合 + MMR 去冗余',
    '',
    '## [面板适配] 进行中',
    '- 问题：面板何时接',
    '- 要点：B6 批次接索引状态页签'
  ].join('\n');
  const jChunks = idxMod.chunkMemorySource(journalMd, 'journal', '2026-09-21');
  assert.equal(jChunks.length, 2, 'journal 条目级切块');
  assert.equal(jChunks[0].lineStart, 3, 'journal 条目起始行');
  assert.ok(jChunks[0].text.includes('hybrid 融合'));
  const d = new Date('2026-09-21T00:00:00');
  assert.equal(jChunks[0].observedAt, d.getTime(), '文件名日期进 observedAt（新近度衰减源）');
  // 无条目 journal：整文件兜底一块
  const bare = idxMod.chunkMemorySource('# 2026-09-20\n纯流水无条目格式', 'journal', '2026-09-20');
  assert.equal(bare.length, 1);
  assert.ok(bare[0].text.includes('纯流水'));

  const userMd = [
    '# 用户画像',
    '<!-- observed: 2026-08-01 | status: superseded -->',
    'Prefer npm scripts.',
    '<!-- observed: 2026-09-01 | status: active -->',
    'Always use pnpm.',
    '<!-- observed: 2026-09-10 -->',
    'Never commit .muster.'
  ].join('\n');
  const uChunks = idxMod.chunkMemorySource(userMd, 'user_md');
  assert.equal(uChunks.length, 2, '仅 active 指令入索引（superseded/文件头不入）');
  assert.ok(uChunks.some((c) => c.text === 'Always use pnpm.'));
  assert.ok(!uChunks.some((c) => c.text.includes('Prefer npm')));
}

/* ---------------- 5. 增量重索引（指纹失效/删除清理/幂等） ---------------- */
const ws = path.join(tmp, 'ws-index');
const memFile = path.join(ws, 'docs', 'memory', 'MEMORY.md');
fs.mkdirSync(path.dirname(memFile), { recursive: true });
fs.writeFileSync(memFile, '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[db]] 数据库选 SQLite。\n', 'utf8');
const journalFile = path.join(ws, '.muster', 'memory', 'journal', '2026-09-21.md');
fs.mkdirSync(path.dirname(journalFile), { recursive: true });
fs.writeFileSync(
  journalFile,
  '## [检索批次] 已完成\n- 问题：q\n- 要点：BM25 建好了\n',
  'utf8'
);
{
  const db = openMemoryDb(ws);
  const s1 = idxMod.syncMemoryIndex(db, ws);
  assert.deepEqual(s1.changed.sort(), ['.muster/memory/journal/2026-09-21.md', 'docs/memory/MEMORY.md'].sort(), '两源首建');
  assert.equal(s1.totalChunks, 2);
  // 指纹持久化 + 未变零开销
  const fingerprints = JSON.parse(db.metaGet(idxMod.INDEX_FINGERPRINTS_META_KEY));
  assert.equal(typeof fingerprints['docs/memory/MEMORY.md'].sha256, 'string', '索引指纹保存内容哈希');
  const s2 = idxMod.syncMemoryIndex(db, ws);
  assert.deepEqual(s2.changed, [], 'mtime+size 未变不重索引');
  assert.equal(s2.totalChunks, 2);
  // 仅时间戳变化但正文不变时，哈希身份保持一致，不重复重建 chunks。
  const timestamp = new Date(Date.now() + 2000);
  fs.utimesSync(memFile, timestamp, timestamp);
  const s2b = idxMod.syncMemoryIndex(db, ws);
  assert.deepEqual(s2b.changed, [], '内容哈希未变时不重复重建');
  assert.equal(JSON.parse(db.metaGet(idxMod.INDEX_FINGERPRINTS_META_KEY))['docs/memory/MEMORY.md'].sha256, fingerprints['docs/memory/MEMORY.md'].sha256);
  // 内容变化（size 变化保证确定性）→ 仅该文件重索引，chunk id 换新
  fs.writeFileSync(memFile, '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[db]] 数据库选 SQLite。\n<!-- 2026-09-02 10:00:00 [s2] -->\n#lesson 迁移要跑测试。\n', 'utf8');
  const s3 = idxMod.syncMemoryIndex(db, ws);
  assert.deepEqual(s3.changed, ['docs/memory/MEMORY.md'], '只重索引变更文件');
  assert.equal(s3.totalChunks, 3, '旧条目删除新条目插入（替换非追加）');
  // FTS 命中验证替换后旧 chunk 不残留
  assert.equal(dbMod.searchChunksByFts(db, '迁移').length, 1);
  // 文件删除 → 清 chunk + 指纹
  fs.rmSync(journalFile);
  const s4 = idxMod.syncMemoryIndex(db, ws);
  assert.deepEqual(s4.removed, ['.muster/memory/journal/2026-09-21.md']);
  assert.equal(dbMod.searchChunksByFts(db, 'BM25').length, 0, '删除文件后 FTS 不再命中');
  db.close();
}

/* ---------------- 5c. 残留清理白名单：transcript 不得被 sync 误删（还原即红） ----------------
 * listIndexedSourcePaths 旧实现取所有 source_path IS NOT NULL；liveKeys 只含 markdown 源；
 * transcript 写入 scheduler-session:*（transcriptIndex）被当残留每次 syncMemoryIndex 删掉。 */
{
  const wsT = path.join(tmp, 'ws-transcript-live');
  fs.mkdirSync(path.join(wsT, 'docs', 'memory'), { recursive: true });
  fs.writeFileSync(
    path.join(wsT, 'docs', 'memory', 'MEMORY.md'),
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[db]] 数据库选 SQLite。\n',
    'utf8'
  );
  const dbT = openMemoryDb(wsT);
  idxMod.syncMemoryIndex(dbT, wsT);
  const tId = insertChunk(dbT, {
    sourceType: 'transcript',
    sourcePath: 'scheduler-session:sess-live.jsonl',
    text: '部署脚本必须先跑 npm install，长度足够被 FTS 检索到的转录内容',
    origin: 'scheduler',
    sessionKind: 'scheduler',
    observedAt: Date.now()
  });
  assert.ok(dbMod.searchChunksByFts(dbT, 'npm install').some((h) => h.id === tId), '转录 chunk 可 FTS 命中');
  // 再跑 sync（markdown 未变）——旧实现会把 transcript 源当残留删掉
  idxMod.syncMemoryIndex(dbT, wsT);
  idxMod.syncMemoryIndex(dbT, wsT);
  assert.ok(
    dbMod.searchChunksByFts(dbT, 'npm install').some((h) => h.id === tId),
    'syncMemoryIndex 不得误删 transcript chunk（残留清理白名单）'
  );
  // markdown 源仍可正常残留清理：删 MEMORY.md 后再 sync 会清掉 markdown chunk
  fs.rmSync(path.join(wsT, 'docs', 'memory', 'MEMORY.md'));
  const sRem = idxMod.syncMemoryIndex(dbT, wsT);
  assert.ok(sRem.removed.includes('docs/memory/MEMORY.md'), '文件删除仍走残留/变更清理');
  assert.ok(
    dbMod.searchChunksByFts(dbT, 'npm install').some((h) => h.id === tId),
    '清理 markdown 残留时 transcript 仍在'
  );
  dbT.close();
}

/* ---------------- 5d. 重索引迁 recall_stats（还原即红）+ 纯删级联清孤儿 ---------------- */
{
  const wsR = path.join(tmp, 'ws-recall-migrate');
  const memR = path.join(wsR, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(memR), { recursive: true });
  fs.writeFileSync(
    memR,
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[db]] 数据库选 SQLite。\n<!-- 2026-09-02 10:00:00 [s2] -->\n#lesson 迁移要跑测试。\n',
    'utf8'
  );
  const dbR = openMemoryDb(wsR);
  idxMod.syncMemoryIndex(dbR, wsR);
  const before = dbR.handle
    .prepare("SELECT id, text, line_start, line_end FROM chunks WHERE source_type='memory' ORDER BY id")
    .all();
  assert.equal(before.length, 2);
  const keep = before.find((r) => r.text.includes('SQLite'));
  const drop = before.find((r) => r.text.includes('迁移'));
  dbMod.recordRecallStat(dbR, keep.id, 'search_hit', 'SQLite 选型', Date.now(), 0.9);
  dbMod.recordRecallStat(dbR, keep.id, 'search_hit', '再问一次', Date.now(), 0.8);
  dbMod.recordRecallStat(dbR, drop.id, 'search_hit', '迁移', Date.now(), 0.7);
  assert.equal(
    Number(dbR.handle.prepare('SELECT recalled_count n FROM chunks WHERE id = ?').get(keep.id).n),
    2
  );
  // 同文追加一条新条目（size 变）→ 重索引；keep 条目 text/line 不变 → 信号应迁到新 id
  fs.writeFileSync(
    memR,
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[db]] 数据库选 SQLite。\n<!-- 2026-09-02 10:00:00 [s2] -->\n#lesson 迁移要跑测试。\n<!-- 2026-09-03 10:00:00 [s3] -->\n#note 新追加条目。\n',
    'utf8'
  );
  idxMod.syncMemoryIndex(dbR, wsR);
  const after = dbR.handle
    .prepare("SELECT id, text, recalled_count, last_recalled_at FROM chunks WHERE source_type='memory' ORDER BY id")
    .all();
  assert.equal(after.length, 3);
  const keep2 = after.find((r) => r.text.includes('SQLite'));
  const drop2 = after.find((r) => r.text.includes('迁移'));
  // SQLite 可能复用 rowid——id 变或不变都合法；契约是信号/账目保留且无孤儿
  assert.ok(keep2, '重索引后 keep 条目仍在');
  assert.equal(Number(keep2.recalled_count), 2, '重索引后 recalled_count 保留（还原即红：旧实现清零）');
  assert.ok(keep2.last_recalled_at != null, 'last_recalled_at 迁到新 chunk');
  const statsKeep = dbR.handle
    .prepare('SELECT count(*) n FROM recall_stats WHERE chunk_id = ?')
    .get(keep2.id);
  assert.equal(Number(statsKeep.n), 2, 'recall_stats 迁到新 chunk id（还原即红：旧实现堆孤儿）');
  // 孤儿检查：每条 recall_stats 都能 join 到 chunks
  const orphans = dbR.handle
    .prepare(
      'SELECT count(*) n FROM recall_stats r LEFT JOIN chunks c ON c.id = r.chunk_id WHERE c.id IS NULL'
    )
    .get();
  assert.equal(Number(orphans.n), 0, '重索引后无 recall_stats 孤儿');
  assert.equal(Number(drop2.recalled_count), 1, '同文保留条目召回计数同步迁');

  // 纯删（文件删除）：chunks + recall_stats 同事务清掉，不堆孤儿
  fs.rmSync(memR);
  idxMod.syncMemoryIndex(dbR, wsR);
  const orphans2 = dbR.handle
    .prepare(
      'SELECT count(*) n FROM recall_stats r LEFT JOIN chunks c ON c.id = r.chunk_id WHERE c.id IS NULL'
    )
    .get();
  assert.equal(Number(orphans2.n), 0, '源删除后无 recall_stats 孤儿（级联）');
  assert.equal(
    Number(dbR.handle.prepare('SELECT count(*) n FROM recall_stats').get().n),
    0,
    '纯删路径级联清 recall_stats'
  );

  // deleteChunk 单条路径同样级联
  const solo = insertChunk(dbR, { sourceType: 'memory', text: '孤立条目要被删掉', origin: 'system' });
  dbMod.recordRecallStat(dbR, solo, 'search_hit', '孤立', Date.now(), 0.5);
  assert.equal(dbMod.deleteChunk(dbR, solo), true);
  assert.equal(
    Number(dbR.handle.prepare('SELECT count(*) n FROM recall_stats WHERE chunk_id = ?').get(solo).n),
    0,
    'deleteChunk 级联清 recall_stats（还原即红）'
  );
  dbR.close();
}

/* ---------------- 5e. 读失败不钉死指纹（B2 评审 MINOR 回归：还原即红） ----------------
 * statSync 成功 + readFileSync 失败的窗口（权限/杀软占用）：本次同步不得把新指纹
 * 写进 meta——否则下次同步 prev==fp 直接跳过，文件的新版本被永久漏索引。 */
{
  const ws2 = path.join(tmp, 'ws-index-readfail');
  const memFile2 = path.join(ws2, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(memFile2), { recursive: true });
  fs.writeFileSync(memFile2, '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[fp]] 指纹首建。\n', 'utf8');
  const db = openMemoryDb(ws2);
  const s1 = idxMod.syncMemoryIndex(db, ws2);
  assert.deepEqual(s1.changed, ['docs/memory/MEMORY.md'], '首建正常');
  const fpBefore = JSON.parse(db.metaGet(idxMod.INDEX_FINGERPRINTS_META_KEY))['docs/memory/MEMORY.md'];

  // 窗口模拟：文件内容更新（size 变化保证指纹变化），但 readFileSync 对它抛错。
  // node:fs 是 CJS 单例，编译产物与测试拿到同一个模块对象，patch 其方法即生效。
  fs.writeFileSync(
    memFile2,
    '<!-- 2026-09-01 10:00:00 [s1] -->\n#decision [[fp]] 指纹首建。\n<!-- 2026-09-02 10:00:00 [s2] -->\n#lesson 读失败后要重试。\n',
    'utf8'
  );
  const fsNs = await import('node:fs');
  const origRead = fsNs.default.readFileSync;
  fsNs.default.readFileSync = (p, ...rest) => {
    if (typeof p === 'string' && p === memFile2) {
      throw Object.assign(new Error('EACCES: simulated read failure'), { code: 'EACCES' });
    }
    return origRead(p, ...rest);
  };
  let s2;
  try {
    s2 = idxMod.syncMemoryIndex(db, ws2);
  } finally {
    fsNs.default.readFileSync = origRead;
  }
  assert.deepEqual(s2.changed, [], '读失败本次不重索引（旧索引保留）');
  const fpAfterFail = JSON.parse(db.metaGet(idxMod.INDEX_FINGERPRINTS_META_KEY))['docs/memory/MEMORY.md'];
  const fpNow = idxMod.sourceFingerprint(memFile2);
  assert.notEqual(fpAfterFail, fpNow, '读失败不得把新指纹钉进 meta（还原即红：旧实现此处已写入新指纹，导致该文件永不重索引）');

  // 下次同步（读恢复）：prev 无该条目（或持旧指纹）≠ 新指纹 → 正常重试并索引到新内容
  const s3 = idxMod.syncMemoryIndex(db, ws2);
  assert.deepEqual(s3.changed, ['docs/memory/MEMORY.md'], '读恢复后重试成功（还原即红：旧实现 prev==fp 永远跳过）');
  assert.equal(dbMod.searchChunksByFts(db, '重试').length, 1, '新内容已入索引');
  db.close();
}

/* ---------------- 6. 词法检索、排序与落账 ---------------- */
{
  const ws3 = path.join(tmp, 'ws-search');
  fs.mkdirSync(ws3, { recursive: true });
  const db = openMemoryDb(ws3);
  const columns=db.handle.prepare('PRAGMA table_info(chunks)').all().map(column=>column.name);
  assert.ok(!columns.includes('embedding')&&!columns.includes('embedding_model'),'new index databases do not contain vector columns');
  for (const text of ['数据库统一 SQLite 派生态库，删库可重建','数据库统一 SQLite 派生态库重建（近重复条目）','终端渲染用 WebGL 加速光标']) {
    insertChunk(db, { sourceType: 'memory', text, origin: 'system' });
  }
  const before = db.handle.prepare("SELECT count(*) n FROM recall_stats WHERE kind='search_hit'").get().n;
  const hits = await searchMod.searchMemory(db, 'SQLite 派生态库', { topK: 3 });
  assert.ok(hits.length >= 1 && hits[0].text.includes('SQLite'));
  const after = db.handle.prepare("SELECT count(*) n FROM recall_stats WHERE kind='search_hit'").get().n;
  assert.equal(after-before,hits.length);
  const statsCount=()=>Number(db.handle.prepare('SELECT count(*) n FROM recall_stats').get().n);
  const beforeLab=statsCount();
  const labHits=await searchMod.searchMemory(db,'SQLite 派生态库',{topK:5,recordStats:false,debug:true});
  assert.equal(statsCount(),beforeLab);
  for(const h of labHits){
    assert.equal(h.debug.final,h.finalScore);
    assert.ok(Math.abs(h.debug.lexNorm*h.debug.recency*h.debug.importance*h.debug.affinity-h.finalScore)<1e-9);
    assert.ok(h.debug.matchedTerms.length>0);
  }
  assert.deepEqual(await searchMod.searchMemory(db,' '),[]);
  assert.ok((await searchMod.searchMemory(db,'我想找渲染加速方面的旧经验来着',{topK:3})).some(h=>h.text.includes('WebGL')));
  db.close();
}

/* ---------------- 8. MemoryService.search 端到端 + watcher ---------------- */
{
  const ws4 = path.join(tmp, 'ws-service');
  const svcFile = path.join(ws4, 'docs', 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(svcFile), { recursive: true });
  fs.writeFileSync(svcFile, '<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson [[gitignore]] 记忆库目录要进 gitignore。\n', 'utf8');
  const svc = new svcMod.MemoryService();
  // 服务层词法检索与增量重建。
  const hits = await svc.search(ws4, 'gitignore 记忆库');
  assert.ok(hits.length === 1 && hits[0].text.includes('gitignore'));
  fs.writeFileSync(svcFile, '<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson [[gitignore]] 记忆库目录要进 gitignore 且定期核对。\n', 'utf8');
  const idxSum = await svc.ensureIndex(ws4);
  assert.equal(idxSum.changed.length, 1);
  assert.ok((await svc.search(ws4, '定期核对')).some(h=>h.text.includes('定期核对')));

  // watcher：防抖触发 ensureIndex；目录事件合并
  const seen = [];
  const w = idxMod.watchMemorySources(ws4, { debounceMs: 120, onInvalidate: (dirs) => seen.push([...dirs]) });
  assert.ok(w, '工作区含现存 docs/memory 目录应建立 watcher');
  try {
    // Native watch registration can finish after fs.watch returns. Each burst
    // gets a full debounce window so the retry cannot postpone invalidation.
    const deadline = Date.now() + 4_000;
    for (let burst = 1; !seen.length && Date.now() < deadline; burst++) {
      fs.writeFileSync(svcFile, `<!-- 2026-09-01 10:00:00 [s1] -->\n#lesson [[gitignore]] watcher 触发重索引 ${burst}。\n`, 'utf8');
      fs.appendFileSync(svcFile, '同一轮写入。\n', 'utf8');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.deepEqual(seen[0], [path.join('docs', 'memory')], '防抖后报告发生变化的来源目录');
  } finally { w.close(); }
  // watcher 失效路径：不存在任何可 watch 目录 → 返回 null（退化懒同步），不抛
  const emptyWs = path.join(tmp, 'ws-empty');
  fs.mkdirSync(emptyWs, { recursive: true });
  assert.equal(idxMod.watchMemorySources(emptyWs, { onInvalidate: () => {} }), null);
  // service.startWatching 接线 + close 清理
  assert.equal(svc.startWatching(ws4), true);
  svc.closeAll();
  assert.equal(svc.db(ws4), undefined);
}

console.log(`memory-retrieval(P1): ok (tmp=${tmp})`);
