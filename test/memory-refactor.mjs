/**
 * 记忆重构 P0 地基（memory-refactor B1）：SQLite 派生态库 schema/迁移幂等、
 * 条目格式扩展（行尾注解/旧格式 roundtrip/USER.md 画像）、FTS 中文检索冒烟、
 * MemoryService 骨架（init 幂等 / inject 空合同 / 文件版本 token）。
 * Run: node test/memory-refactor.mjs
 * 全部落系统临时目录（mkdtemp），严禁写仓库内 .muster。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-refactor-'));
const compile = createSharedCompiler(root, tmp);

const dbMod = await import(pathToFileURL(compile('main/memory/db.ts')).href);
const fmtMod = await import(pathToFileURL(compile('main/memory/entryFormat.ts')).href);
const oldFmt = await import(pathToFileURL(compile('shared/memoryFormat.ts')).href);
const svcMod = await import(pathToFileURL(compile('main/memory/service.ts')).href);

const {
  openMemoryDb,
  insertChunk,
  deleteChunk,
  searchChunksByFts,
  listTableNames,
  cjkBigramTokenize,
  ftsMatchExpr
} = dbMod;
const {
  parseMemoryEntriesV2,
  serializeMemoryEntryV2,
  serializeMemoryFileV2,
  splitEntryAnnotations,
  formatEntryAnnotations,
  parseProfileEntries,
  serializeProfileEntry,
  USER_PROFILE_MAX_CHARS
} = fmtMod;

/* ---------------- 1. schema 建表 / 迁移幂等 ---------------- */
const ws1 = path.join(tmp, 'ws1');
const db1 = openMemoryDb(ws1);
assert.equal(db1.schemaVersion(), 5, '新库 schema_version 应为 5（B4 镜像/B5 bootstrap/M1 事件账本 v4/审批执行日志 v5）');
const tables = listTableNames(db1);
for (const t of [
  'meta',
  'chunks',
  'chunks_fts',
  'staging',
  'recall_stats',
  'preimages',
  'approvals',
  'intents',
  'consolidation_log',
  'memory_events'
]) {
  assert.ok(tables.includes(t), `缺表 ${t}`);
}
assert.equal(tables.length, 11, `应恰为 10 表 + FTS 虚拟表（M1 v4 增 memory_events；v5 增 approval_exec），实际：${tables.join(',')}`);

// 重开幂等：版本不涨、表集不变、数据仍在（迁移无副作用）
const persistId = insertChunk(db1, {
  sourceType: 'memory',
  sourcePath: 'docs/memory/MEMORY.md',
  lineStart: 3,
  lineEnd: 4,
  text: '重开后仍在的中文条目。',
  origin: 'scheduler',
  taskId: 'T-1',
  repoKey: 'github.com/foo/bar',
  importance: 7,
  triggers: ['重开']
});
db1.close();
const db1b = openMemoryDb(ws1);
assert.equal(db1b.schemaVersion(), 5, '重开 schema_version 应仍为 5');
assert.deepEqual(listTableNames(db1b), tables, '重开不应重复建表');
assert.equal(searchChunksByFts(db1b, '重开').length, 1, '重开数据应仍在');

// 未来版本守卫：库由更高 schema 写入 → 拒绝打开
const wsFut = path.join(tmp, 'ws-future');
const dbF = openMemoryDb(wsFut);
dbF.metaSet('schema_version', '99');
dbF.close();
assert.throws(() => openMemoryDb(wsFut), /更高版本/);

// 写事务回滚：抛错的批量写不落半截
const before = db1b.handle.prepare('SELECT count(*) n FROM staging').get().n;
assert.throws(
  () =>
    db1b.write((tx) => {
      tx.prepare("INSERT INTO staging (text, origin, created_at) VALUES ('x', 'user', 1)").run();
      throw new Error('boom');
    }),
  /boom/
);
assert.equal(db1b.handle.prepare('SELECT count(*) n FROM staging').get().n, before, '回滚后 staging 不应有残留');

// importance 校验：非法值拒绝
assert.throws(
  () => insertChunk(db1b, { sourceType: 'memory', text: 'x', origin: 'user', importance: 11 }),
  /importance/
);
db1b.close();

/* ---------------- 2. CJK 二元组预分词 / FTS 中文冒烟 ---------------- */
assert.deepEqual(cjkBigramTokenize('嵌套仓容器'), ['嵌套', '套仓', '仓容', '容器']);
assert.deepEqual(cjkBigramTokenize('用 pnpm 装依赖'), ['用', 'pnpm', '装依', '依赖']);
// 增补面 CJK（扩展 B 区）按码点切，不拆代理对
assert.deepEqual(cjkBigramTokenize('𠀀モ'), ['𠀀モ']);
assert.equal(ftsMatchExpr('记忆 "系统'), '"记忆" "系统"', '查询 token 双引号转义');

const wsFts = path.join(tmp, 'ws-fts');
const dbFts = openMemoryDb(wsFts);
const idA = insertChunk(dbFts, {
  sourceType: 'memory',
  text: '记忆系统重构采用 SQLite 派生态库与分层记忆架构。',
  origin: 'scheduler',
  importance: 8
});
const idB = insertChunk(dbFts, {
  sourceType: 'journal',
  text: '终端渲染用 WebGL 加速光标闪烁。',
  origin: 'worker'
});
// 二字中文词（trigram 方案命不中的形态）命中且只命中目标
let hits = searchChunksByFts(dbFts, '记忆系统');
assert.equal(hits.length, 1);
assert.equal(hits[0].id, idA);
assert.equal(hits[0].sourceType, 'memory');
// 多词 AND、他表命中
hits = searchChunksByFts(dbFts, '系统 重构');
assert.deepEqual(hits.map((h) => h.id), [idA]);
hits = searchChunksByFts(dbFts, '光标');
assert.deepEqual(hits.map((h) => h.id), [idB]);
// 无命中 / 空查询
assert.equal(searchChunksByFts(dbFts, 'pnpm').length, 0);
assert.deepEqual(searchChunksByFts(dbFts, '  '), []);
// 删除连 FTS 索引一起清（外部内容表 delete 命令路径）
assert.equal(deleteChunk(dbFts, idA), true);
assert.equal(deleteChunk(dbFts, idA), false);
assert.equal(searchChunksByFts(dbFts, '记忆系统').length, 0, '删除后 FTS 不应再命中');
dbFts.close();

/* ---------------- 3. 条目格式：旧格式 roundtrip 不丢字节 ---------------- */
const { serializeMemoryEntry, appendEntryToContent } = oldFmt;
let oldMd = '';
for (const e of [
  { ts: '2026-08-30 09:00:00', sessionId: 'e5f6a7b8', tags: ['preference'], links: [], text: '本仓库一律 pnpm，不用 npm。' },
  { ts: '2026-09-02 14:20:00', sessionId: 'a1b2c3d4', tags: ['lesson'], links: ['api-versioning'], text: 'URL 前缀版本号（/v1/）可避免 CDN 缓存失效问题。' },
  {
    ts: '2026-09-21 10:12:03',
    sessionId: 'c0ffee',
    tags: ['decision', 'memory'],
    links: ['db-choice'],
    text: '数据库统一 SQLite（node:sqlite），派生态删库可重建。\n多行正文也原样保留。'
  }
]) {
  oldMd = appendEntryToContent(oldMd, serializeMemoryEntry(e));
}
const oldEntries = parseMemoryEntriesV2(oldMd);
assert.equal(oldEntries.length, 3);
for (const e of oldEntries) {
  assert.deepEqual(e.annotations, {}, '旧格式条目注解应为中性（全缺省）');
  assert.equal(serializeMemoryEntryV2(e), e.raw, '旧格式条目逐条 roundtrip 必须逐字节一致');
}
assert.equal(serializeMemoryFileV2(oldEntries), oldMd, '旧格式整文件 roundtrip 不丢字节');

// 前导未识别内容（手写头/格式坏）：原样保留，不丢
const withHeader = `# 手写文件头（无时间戳）\n\n${oldMd}`;
for (const e of parseMemoryEntriesV2(withHeader)) {
  assert.equal(serializeMemoryEntryV2(e), e.raw, '未识别块应原样返回');
}

/* ---------------- 4. 行尾注解：解析 / 规范化 / 非法值保留 ---------------- */
// 方案 §4.3 示例原样
const planExample =
  '<!-- 2026-09-21 14:02:11 [s3] -->\n' +
  '#lesson [[isolate-worktree]] 嵌套仓容器必须写主仓 info/exclude。 ' +
  '<!-- trigger: 嵌套仓, 容器恒脏, exclude --> <!-- importance: 8 --> <!-- project: github.com/foo/bar -->';
const [annotated] = parseMemoryEntriesV2(planExample);
assert.ok(annotated && !annotated.unparsed);
assert.deepEqual(annotated.annotations, {
  trigger: ['嵌套仓', '容器恒脏', 'exclude'],
  importance: 8,
  project: 'github.com/foo/bar'
});
assert.equal(annotated.text, '#lesson [[isolate-worktree]] 嵌套仓容器必须写主仓 info/exclude。');
assert.equal(serializeMemoryEntryV2(annotated), planExample, '规范注解 roundtrip 应逐字节稳定');
assert.deepEqual(
  parseMemoryEntriesV2(serializeMemoryEntryV2(annotated))[0].annotations,
  annotated.annotations,
  'format→parse 应收敛（canonical 稳定）'
);

// 非法 importance（>10）：留在正文不剥、不丢字节；合法 project 照常解析
const weird =
  '<!-- 2026-09-21 14:02:11 [s3] -->\n#lesson 正文 <!-- importance: 99 --> <!-- project: ok -->';
const [weirdEntry] = parseMemoryEntriesV2(weird);
assert.equal(weirdEntry.annotations.importance, undefined, '非法 importance 应视为缺省（中性）');
assert.equal(weirdEntry.annotations.project, 'ok');
assert.ok(weirdEntry.text.includes('importance: 99'), '非法值留在正文原样保留');
const reSerialized = serializeMemoryEntryV2(weirdEntry);
assert.ok(reSerialized.includes('importance: 99'), '序列化不得丢非法值内容');
assert.deepEqual(
  parseMemoryEntriesV2(reSerialized)[0].annotations,
  weirdEntry.annotations,
  '重排后再解析应稳定'
);

// 注解缺省=中性 + 纯函数直查
assert.deepEqual(splitEntryAnnotations('纯正文').annotations, {});
assert.equal(formatEntryAnnotations({}), '');
assert.equal(
  formatEntryAnnotations({ trigger: ['a', 'b'], importance: 10, project: 'k' }),
  '<!-- trigger: a, b --> <!-- importance: 10 --> <!-- project: k -->'
);

/* ---------------- 5. USER.md 画像条目解析 ---------------- */
const userMd = [
  '# 用户画像',
  '',
  '<!-- observed: 2026-08-01 | status: superseded -->',
  'Prefer npm scripts.',
  '',
  '<!-- observed: 2026-09-01 | status: active -->',
  'Always use pnpm.',
  '',
  '<!-- observed: 2026-09-10 -->',
  'Never commit .muster.',
  ''
].join('\n');
const profile = parseProfileEntries(userMd);
assert.equal(profile.filter((e) => !e.unparsed).length, 3);
const active = profile.find((e) => e.directive === 'Always use pnpm.');
assert.ok(active, '应解析出 active 指令');
assert.equal(active.observed, '2026-09-01');
assert.equal(active.status, 'active');
const superseded = profile.find((e) => e.directive === 'Prefer npm scripts.');
assert.equal(superseded.status, 'superseded');
const lenient = profile.find((e) => e.directive === 'Never commit .muster.');
assert.equal(lenient.status, 'active', 'status 缺省容错为 active');
assert.ok(profile[0].unparsed, '元数据行外内容归未识别块');
assert.equal(
  serializeProfileEntry(active),
  '<!-- observed: 2026-09-01 | status: active -->\nAlways use pnpm.'
);
assert.equal(USER_PROFILE_MAX_CHARS, 4000, '画像上限 4000（只可调低）');

/* ---------------- 6. MemoryService 骨架：init 幂等 / inject 合同 / 版本 token ---------------- */
const wsS = path.join(tmp, 'ws-svc');
fs.mkdirSync(wsS, { recursive: true });
const svc = new svcMod.MemoryService();
const dFirst = svc.init(wsS);
const dAgain = svc.init(wsS);
assert.equal(dAgain, dFirst, '同根 init 应幂等返回同一句柄');
assert.ok(fs.existsSync(path.join(wsS, '.muster', 'memory', 'runtime', 'state.sqlite')), '库应落在工作区 memory/runtime/');

const inj = svc.inject(wsS, 'scheduler');
assert.equal(inj.text, '', 'P0 恒空注入（B5 接线）');
assert.deepEqual(inj.sections, []);
assert.deepEqual(inj.injectedChunkIds, []);
assert.ok(typeof inj.versionToken === 'string' && inj.versionToken.length > 0);
assert.ok(inj.versionToken.includes('none'), '文件缺失时版本片段为 none');
// 无头/心跳/自动会话：合同面可调、零预算、不抛
for (const kind of ['headless', 'heartbeat', 'auto']) {
  const zero = svc.inject(wsS, kind);
  assert.equal(zero.text, '');
}

// 文件变化 → 版本 token 变化（mtime+size 口径；用 size 变化保证确定性）
const memFile = path.join(wsS, 'docs', 'memory', 'MEMORY.md');
fs.mkdirSync(path.dirname(memFile), { recursive: true });
fs.writeFileSync(memFile, '<!-- 2026-09-21 10:00:00 [t] -->\n#decision 一。\n');
const tok1 = svc.inject(wsS, 'worker').versionToken;
fs.writeFileSync(memFile, '<!-- 2026-09-21 10:00:00 [t] -->\n#decision 一二。\n');
const tok2 = svc.inject(wsS, 'worker').versionToken;
assert.notEqual(tok1, tok2, 'canonical 文件 size 变化应反映到版本 token');

svc.closeAll();
assert.equal(svc.db(wsS), undefined, 'closeAll 后句柄应移除');
assert.equal(dFirst.isClosed, true);

console.log(`memory-refactor(P0): ok (tmp=${tmp})`);
