/**
 * 会话批注共享逻辑自测：token 生成、发送展开、摘除、位置查找、序号推进。
 * 运行: node test/note-annotations.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'note-annotations-'));

const entry = path.join(root, 'src/shared/noteAnnotations.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'noteAnnotations.mjs');
fs.writeFileSync(out, outputText.replace("'./workerModelMention'", "'./workerModelMention.mjs'"), 'utf8');
fs.writeFileSync(path.join(tmp, 'workerModelMention.mjs'), ts.transpileModule(
  fs.readFileSync(path.join(root, 'src/shared/workerModelMention.ts'), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, 'utf8');
const {
  makeNoteToken,
  nextNoteSeq,
  expandNoteTokens,
  stripNoteToken,
  stripOrphanNoteTokens,
  noteTokensInText,
  composerFileReference,
  composerSkillReference,
  findNoteTokenRanges,
  separateNoteTokens,
  hasAdjacentNoteTokens
} = await import(pathToFileURL(out).href);

assert.equal(makeNoteToken(1), '批注1');
assert.equal(makeNoteToken(12), '批注12');
assert.equal(nextNoteSeq([]), 1);
assert.equal(nextNoteSeq([1, 3, 2]), 4);

// 文件/技能路径里的批注字样不是批注，重建、删除和发送时必须逐字保留。
{
  const file = composerFileReference('C:\\工作区\\批注1 "稿".md');
  const skill = composerSkillReference('批注1-helper', '/repo/批注2/SKILL.md');
  const draft = `${file} 批注1 ${skill}`;
  assert.deepEqual(noteTokensInText(draft), ['批注1']);
  assert.equal(stripOrphanNoteTokens(`${file} ${skill}`, []), `${file} ${skill}`);
  assert.equal(stripNoteToken(draft, '批注1'), `${file} ${skill}`);
  const expanded = expandNoteTokens(draft, [{ seq: 1, quote: '原文', note: '改进' }]);
  assert.ok(expanded.startsWith(file)); assert.ok(expanded.endsWith(skill));
  assert.match(expanded, /用户批注：改进/);
}

// 展开：多批注各自替换；无 token 原样
{
  const notes = [
    { seq: 1, quote: '第一段原文', note: '这里写错了' },
    { seq: 2, quote: '第二段原文', note: '补充一下' }
  ];
  assert.equal(
    expandNoteTokens('批注1 另外批注2 也看下', notes),
    '[会话批注] 原文：“第一段原文”；用户批注：这里写错了 另外[会话批注] 原文：“第二段原文”；用户批注：补充一下 也看下'
  );
  assert.equal(expandNoteTokens('没有批注', notes), '没有批注');
  // quote/note 里的引号原样保留（不做转义，内容面交付给模型）
  assert.equal(
    expandNoteTokens('批注1', [{ seq: 1, quote: 'a"b', note: 'n' }]),
    '[会话批注] 原文：“a"b”；用户批注：n'
  );
}

// 摘除：带前导空格/紧贴/孤立三种形态；「批注1」不误伤「批注10」；最多吞 3 个前导空格
{
  assert.equal(stripNoteToken('看看这个 批注1 好吗', '批注1'), '看看这个 好吗');
  assert.equal(stripNoteToken('开头批注1 在前', '批注1'), '开头 在前');
  assert.equal(stripNoteToken('末尾 批注1', '批注1'), '末尾');
  assert.equal(stripNoteToken('批注1', '批注1'), '');
  assert.equal(stripNoteToken('批注10 不匹配 批注1', '批注1'), '批注10 不匹配');
  assert.equal(stripNoteToken('前   批注1 后', '批注1'), '前 后');
}

// 位置查找：多处在、跨 token、空 token
{
  assert.deepEqual(findNoteTokenRanges('a批注1b批注1c', '批注1'), [
    [1, 4],
    [5, 8]
  ]);
  assert.deepEqual(findNoteTokenRanges('批注2', '批注1'), []);
  assert.deepEqual(findNoteTokenRanges('abc', ''), []);
}

// 连写/窄间隔补空格：零空格与 1-2 空格都规范到 3 空格（药丸视觉外沿比字形宽，
// 不足 3 空格会贴死或重叠）；批注10 与批注1 相邻不吞数字
{
  assert.equal(hasAdjacentNoteTokens('批注1批注2'), true);
  assert.equal(hasAdjacentNoteTokens('批注1 批注2'), true);
  assert.equal(hasAdjacentNoteTokens('批注1   批注2'), false);
  assert.equal(separateNoteTokens('批注1批注2'), '批注1   批注2');
  assert.equal(separateNoteTokens('批注1批注2批注3'), '批注1   批注2   批注3');
  assert.equal(separateNoteTokens('批注1 批注2'), '批注1   批注2');
  assert.equal(separateNoteTokens('批注1  批注2'), '批注1   批注2');
  assert.equal(separateNoteTokens('批注1   批注2'), '批注1   批注2');
  assert.equal(separateNoteTokens('看看批注10批注1吧'), '看看批注10   批注1吧');
}

// 文件批注：带标签的结构化展开（原文/用户批注分开，AI 不混淆）；行号区间；
// 无行号只带路径；与会话批注混排互不干扰
{
  assert.equal(
    expandNoteTokens('批注1 这个命名不行', [
      { seq: 1, quote: 'const fooBar = 1', note: '', file: { path: 'src/app.ts', line: 42 } }
    ]),
    '[文件批注 src/app.ts:42] 原文：“const fooBar = 1” 这个命名不行'
  );
  assert.equal(
    expandNoteTokens('批注1', [
      { seq: 1, quote: '第一段', note: '', file: { path: 'docs/prd.md' } }
    ]),
    '[文件批注 docs/prd.md] 原文：“第一段”'
  );
  assert.equal(
    expandNoteTokens('批注1', [
      { seq: 1, quote: '第一段', note: '改成两段', file: { path: 'docs/prd.md', line: 7 } }
    ]),
    '[文件批注 docs/prd.md:7] 原文：“第一段”；用户批注：改成两段'
  );
  // 多行选区：行号区间
  assert.equal(
    expandNoteTokens('批注1', [
      {
        seq: 1,
        quote: '多行内容',
        note: '整段重写',
        file: { path: 'src/app.ts', line: 12, endLine: 18 }
      }
    ]),
    '[文件批注 src/app.ts:12-18] 原文：“多行内容”；用户批注：整段重写'
  );
  // 起止同行不重复标区间
  assert.equal(
    expandNoteTokens('批注1', [
      { seq: 1, quote: 'x', note: '', file: { path: 'src/a.ts', line: 3, endLine: 3 } }
    ]),
    '[文件批注 src/a.ts:3] 原文：“x”'
  );
  assert.equal(
    expandNoteTokens('批注1 看下 批注2', [
      { seq: 1, quote: '会话原文', note: '会话批注' },
      { seq: 2, quote: '文件原文', note: '', file: { path: 'src/a.ts', line: 3 } }
    ]),
    '[会话批注] 原文：“会话原文”；用户批注：会话批注 看下 [文件批注 src/a.ts:3] 原文：“文件原文”'
  );
}

// ---------- 孤儿 token 摘除（批注内存态 vs 草稿持久化的生命周期错位） ----------
{
  const { stripOrphanNoteTokens } = await import(pathToFileURL(out).href);
  // 批注1 有效、批注2/3 已不存在：孤儿摘除、有效保留、多余空格收敛
  assert.equal(
    stripOrphanNoteTokens('批注1   批注2 看下 批注3', [1]),
    '批注1 看下'
  );
  // 全部有效：原样返回
  assert.equal(stripOrphanNoteTokens('批注1   批注2', [1, 2]), '批注1   批注2');
  // 无 token：原样返回
  assert.equal(stripOrphanNoteTokens('普通草稿', [1]), '普通草稿');
  // 序号不误伤（批注1 不匹配 validSeqs 里的 10）
  assert.equal(stripOrphanNoteTokens('批注1', [10]), '');
  assert.equal(stripOrphanNoteTokens('批注10', [10]), '批注10');
}

console.log('ok note-annotations');
