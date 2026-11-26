/**
 * journal/memory 格式单源测试：解析、序列化、校验、recovery schema、重复检测、BM25。
 * 运行: node test/memory-format.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-format-'));
const compile = createSharedCompiler(root, tmp);

function pathToFileURL(p) {
  return 'file:///' + p.replace(/\\/g, '/');
}

const jf = await import(pathToFileURL(compile('shared/journalFormat.ts')));
const mf = await import(pathToFileURL(compile('shared/memoryFormat.ts')));
const st = await import(pathToFileURL(compile('shared/searchTokens.ts')));
const bm = await import(pathToFileURL(compile('shared/bm25Search.ts')));

// ---------- journalFormat ----------
{
  const md = [
    '# 2026-09-02 工作日志',
    '',
    '## [缺陷 7067 排查] 已完成',
    '- 问题：审批流无法触发',
    '- 要点：根因是签名校验失败',
    '- 要点：已回归通过',
    '',
    '## [记忆面板开发] 进行中',
    '- 问题：做卡片面板',
    '- 要点：UI 待完善'
  ].join('\n');
  const entries = jf.parseJournalEntries(md);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].topic, '缺陷 7067 排查');
  assert.equal(entries[0].status, '已完成');
  assert.equal(entries[0].points.length, 2);
  assert.equal(entries[1].status, '进行中');

  const text = jf.serializeJournalEntry(entries[0]);
  assert.match(text, /^## \[缺陷 7067 排查\] 已完成\n- 问题：/);
  const roundtrip = jf.parseJournalEntries(text);
  assert.deepEqual(roundtrip[0], entries[0], 'serialize→parse roundtrip');

  // 校验单源：合法 / 缺要点 / 缺问题 / 双标题 / 主题超长
  assert.equal(jf.validateSingleEntryText(text).ok, true);
  assert.equal(jf.validateSingleEntryText('## [A] 已完成\n- 问题：x').ok, false, '缺要点');
  assert.equal(jf.validateSingleEntryText('## [A] 已完成\n- 要点：x').ok, false, '缺问题');
  assert.equal(
    jf.validateSingleEntryText(`${text}\n\n## [B] 进行中\n- 问题：x\n- 要点：y`).ok,
    false,
    '双标题拒绝'
  );
  assert.equal(
    jf.validateSingleEntryText('## [这是一个超过二十个字的主题名字所以不合法了哦] 进行中\n- 问题：x\n- 要点：y').ok,
    false,
    '主题超 20 字'
  );

  const appended = jf.appendEntryToContent('# 2026-09-02 工作日志\n\n## [A] 已完成\n- 问题：x\n- 要点：y', entries[0], '2026-09-02');
  assert.match(appended, /- 要点：已回归通过\n$/, '追加到末尾');

  // prefixComment（退出摘要去重 marker）随条目同块落盘，位于条目标题之上且不干扰解析
  const withMarker = jf.appendEntryToContent('', entries[0], '2026-09-02', '<!-- exit-summary:s1 -->');
  assert.match(withMarker, /^# 2026-09-02 工作日志\n\n<!-- exit-summary:s1 -->\n## \[/, 'marker 在条目标题上方');
  assert.equal(jf.parseJournalEntries(withMarker).length, 1, 'marker 不干扰解析');

  // 嵌套子要点并入上一条要点（检索语料不能只索引行首一层）
  const nested = [
    '# 2026-09-04 工作日志',
    '',
    '## [嵌套要点] 进行中',
    '- 问题：子列表要进检索语料',
    '- 要点：',
    '  - 子要点甲：关键细节',
    '  - 子要点乙：另一个细节',
    '- 要点：普通要点',
    '',
    '## [下一条] 已完成',
    '- 问题：x',
    '- 要点：y'
  ].join('\n');
  const nestedEntries = jf.parseJournalEntries(nested);
  assert.equal(nestedEntries.length, 2);
  assert.equal(nestedEntries[0].points.length, 2);
  assert.match(nestedEntries[0].points[0], /^子要点甲/, '空要点 + 缩进子行 = 该要点的正文');
  assert.match(nestedEntries[0].points[0], /子要点乙/, '同组子行全部并入');
  assert.equal(nestedEntries[0].points[1], '普通要点');
  console.log('ok: journalFormat');
}

// ---------- memoryFormat：解析 / 序列化 ----------
{
  const md = [
    '手写的旧内容，没有时间戳注释。',
    '',
    '<!-- 2026-09-02 10:12:03 [a1b2c3d4] -->',
    '#decision [[database-choice]] 数据库统一 PostgreSQL，弃 MySQL（JSON 性能）。',
    '',
    '<!-- 2026-08-30 09:00:00 [e5f6a7b8] -->',
    '#preference 本仓库一律 pnpm，不用 npm。'
  ].join('\n');
  const entries = mf.parseMemoryEntries(md);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].unparsed, true, '前导无注释 → 未识别条目');
  assert.equal(entries[1].ts, '2026-09-02 10:12:03');
  assert.deepEqual(entries[1].tags, ['decision']);
  assert.deepEqual(entries[1].links, ['database-choice']);
  assert.match(entries[1].id, /^2026-09-02 10:12:03-a1b2c3d4-[0-9a-z]+$/, 'id = ts+sid+内容指纹');

  const block = mf.serializeMemoryEntry({ ts: '', sessionId: 'test1234', tags: ['lesson'], links: [], text: 'URL 前缀版本号避免 CDN 缓存问题' }, new Date('2026-09-02T10:00:00'));
  assert.match(block, /^<!-- 2026-09-02 10:00:00 \[test1234\] -->\n#lesson /);

  const removed = mf.removeEntryById(md, entries[1].id);
  assert.ok(removed);
  assert.match(removed.content, /#preference 本仓库一律 pnpm/);
  assert.doesNotMatch(removed.content, /#decision/);
  assert.equal(mf.removeEntryById(md, '不存在'), null);

  assert.deepEqual(mf.extractTags('#a #b 文本 #a'), ['a', 'b'], 'tag 去重保序');
  assert.deepEqual(mf.extractLinks('见 [[x]] 与 [[y]]'), ['x', 'y']);

  const stamp = mf.stampNow(new Date('2026-09-02T08:05:09'), 'sid');
  assert.equal(stamp, '<!-- 2026-09-02 08:05:09 [sid] -->');

  // BOM 容错：带 BOM 的文件首条目不降级「未识别」
  const bom = `﻿${md}`;
  const bomEntries = mf.parseMemoryEntries(bom);
  assert.equal(bomEntries[0].unparsed, true); // 原 md 首行本就是无注释手写内容
  const bomOnly = mf.parseMemoryEntries('﻿<!-- 2026-09-01 09:00:00 [b1] -->\n#decision 带 BOM 的首条');
  assert.equal(bomOnly.length, 1);
  assert.equal(bomOnly[0].tags[0], 'decision', 'BOM 不吃掉首条结构化解析');
  console.log('ok: memoryFormat parse/serialize');
}

// ---------- 同文重复条目 id 消歧（git 多机并发追加的常见形态） ----------
{
  const md = [
    '<!-- 2026-09-01 10:00:00 [a1] -->',
    '#lesson 相同的教训',
    '',
    '<!-- 2026-09-02 10:00:00 [a2] -->',
    '#note 别的条目',
    '',
    '<!-- 2026-09-01 10:00:00 [a1] -->',
    '#lesson 相同的教训'
  ].join('\n');
  const entries = mf.parseMemoryEntries(md);
  assert.equal(entries.length, 3);
  assert.match(entries[2].id, /#2$/, '重复条目 id 带位序后缀');
  // 删带后缀的副本只删第二处；剩余副本 id 回到无后缀形态
  const r = mf.removeEntryById(md, entries[2].id);
  assert.ok(r);
  const rest = mf.parseMemoryEntries(r.content);
  assert.equal(rest.length, 2);
  assert.equal(rest[0].id, entries[0].id.replace(/#2$/, ''), '第一副本保留且 id 不再带后缀');
  assert.equal(mf.removeEntryById(md, '不存在'), null);
  console.log('ok: duplicate id disambiguation');
}

// ---------- 未识别条目原位替换 ----------
{
  const md = '手写旧块\n\n<!-- 2026-09-01 10:00:00 [a] -->\n#decision 保留';
  const out = mf.replaceRawBlock(md, '手写旧块', '<!-- 2026-09-02 00:00:00 [manual] -->\n#lesson 换新的');
  assert.match(out, /换新的/);
  assert.doesNotMatch(out, /手写旧块/);
  assert.match(out, /保留/);
  const out2 = mf.replaceRawBlock('# 标题\n', '不存在', '<!-- 2026-09-02 00:00:00 [manual] -->\n#lesson 新块');
  assert.match(out2, /新块\n$/, '目标不存在时退化为追加');
  console.log('ok: replaceRawBlock');
}

// ---------- 输入归一（写入侧约束：杜绝 ##tag / [[x]] 伪标记进文件） ----------
{
  assert.deepEqual(mf.normalizeTagInput(['#decision', '＃preference', 'decision', 'x'.repeat(50), 'ok']), [
    'decision',
    'preference',
    'ok'
  ]);
  assert.deepEqual(mf.normalizeLinkInput(['[[db]]', 'db', 'plain-link']), ['db', 'plain-link']);
  console.log('ok: input normalization');
}

// ---------- 注入优先级选择（预算装箱，替代整文件中间截断） ----------
{
  const mk = (ts, tag, text) => `<!-- ${ts} [s] -->\n#${tag} ${text}`;
  const md = [
    '手写坏块无注释', // 只有文件前导无注释内容才解析为未识别条目
    mk('2026-09-01 10:00:00', 'lesson', '旧教训内容'),
    mk('2026-09-02 10:00:00', 'decision', '决策甲'),
    mk('2026-09-03 10:00:00', 'lesson', '新教训'),
    mk('2026-09-04 10:00:00', 'preference', '偏好乙')
  ].join('\n\n');
  const entries = mf.parseMemoryEntries(md);
  assert.equal(entries.length, 5, '1 条未识别 + 4 条结构化');
  // 预算 = decision+preference 两条恰好装满（按实测 raw 尺寸，避免对字符数的脆弱断言）
  const budget = entries
    .filter((e) => !e.unparsed && ['decision', 'preference'].includes(e.tags[0]))
    .reduce((n, e) => n + e.raw.length + 2, 0);
  const sel = mf.selectEntriesForInjection(entries, budget);
  assert.deepEqual(sel.selected.map((e) => e.tags[0]), ['decision', 'preference'], '选中集保持文件原序');
  assert.equal(sel.dropped.length, 3, '两条 lesson 与未识别块被挤出');
  // 预算充裕：全进、零挤出
  const full = mf.selectEntriesForInjection(entries, 100000);
  assert.equal(full.selected.length, 5);
  assert.equal(full.dropped.length, 0);
  // 单条超预算：至少保底一条，其余全部进 dropped（挤出标注不漏记）
  const huge = mf.parseMemoryEntries(`<!-- 2026-09-01 10:00:00 [s] -->\n#note ${'长'.repeat(300)}`);
  const floor = mf.selectEntriesForInjection(huge, 50);
  assert.equal(floor.selected.length, 1, '首条无条件保底');
  assert.equal(floor.dropped.length, 0, '没有其它条目可挤出');
  const huge2 = mf.parseMemoryEntries(
    `<!-- 2026-09-01 10:00:00 [s] -->\n#note ${'长'.repeat(300)}\n\n<!-- 2026-09-01 09:00:00 [s] -->\n#note 小条目`
  );
  const floor2 = mf.selectEntriesForInjection(huge2, 50);
  assert.equal(floor2.selected.length, 1, '保底条占满预算');
  assert.deepEqual(floor2.dropped.map((e) => e.text), ['#note 小条目'], '其余条目完整记入 dropped');
  // 空条目 / 零预算
  assert.deepEqual(mf.selectEntriesForInjection([], 100).selected, []);
  assert.equal(mf.selectEntriesForInjection(mf.parseMemoryEntries('<!-- 2026-09-01 10:00:00 [s] -->\n#note x'), 0).selected.length, 1, '零预算仍保底一条');
  console.log('ok: injection selection');
}

// ---------- recovery schema ----------
{
  const good = { version: 1, id: '9b2f1a3c-0000-4a1b-8c2d-123456789abc', createdAt: '2026-09-02T00:00:00Z', removedContent: ['x'] };
  assert.equal(mf.isRecoveryRecord(good), true);
  assert.equal(mf.isRecoveryRecord({ ...good, version: 2 }), false);
  assert.equal(mf.isRecoveryRecord({ ...good, id: 'not-a-uuid' }), false);
  assert.equal(mf.isRecoveryRecord({ ...good, removedContent: [] }), false);
  console.log('ok: recovery schema');
}

// ---------- 重复检测 ----------
{
  const entries = mf.parseMemoryEntries(
    [
      '<!-- 2026-09-01 10:00:00 [a1] -->',
      '#decision 数据库统一选 PostgreSQL 放弃 MySQL 因为 JSON 性能更好',
      '',
      '<!-- 2026-09-02 10:00:00 [a2] -->',
      '#decision 数据库统一选 PostgreSQL 放弃 MySQL，因为 JSON 性能更好',
      '',
      '<!-- 2026-09-03 10:00:00 [a3] -->',
      '#preference 包管理器一律用 pnpm 不用 npm'
    ].join('\n')
  );
  const dup = mf.findDuplicatePairs(entries);
  assert.equal(dup.length, 1, '只判出前两条相似');
  assert.equal(dup[0].aId, entries[0].id);
  assert.equal(dup[0].bId, entries[1].id);
  console.log('ok: duplicates');
}

// ---------- 分词 + BM25 ----------
{
  assert.deepEqual(st.tokenize('数据库选型 database-choice'), ['数据', '据库', '库选', '选型', 'database-choice'], 'CJK bigram + 拉丁词');
  const docs = [
    { id: 'a', text: 'pnpm 包管理器偏好，本仓库用 pnpm' },
    { id: 'b', text: '数据库统一 PostgreSQL' },
    { id: 'c', text: '审批流 webhook 签名校验排查' }
  ];
  const idx = bm.buildBm25Index(docs);
  const hits = idx.search('pnpm 包管理', 2);
  assert.equal(hits[0].id, 'a');
  assert.equal(hits.length <= 2, true);
  assert.equal(idx.search('不存在的词', 5).length, 0, '无命中返回空');
  console.log('ok: searchTokens + bm25');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('memory-format: all ok');
