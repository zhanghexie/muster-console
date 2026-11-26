/**
 * CJK Markdown 强调预处理（soften / 跳过代码 / 剥 ZWSP）。
 * 运行: node test/cjk-markdown-emphasis.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cjk-md-em-'));
const entry = path.join(root, 'src/shared/cjkMarkdownEmphasis.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'cjkMarkdownEmphasis.mjs');
fs.writeFileSync(out, outputText);
const {
  CJK_EMPHASIS_ZWSP: Z,
  collectMarkdownCodeSpans,
  softenCjkMarkdownEmphasis,
  stripCjkEmphasisZwspFromTree
} = await import(pathToFileURL(out).href);

const unifiedPath = pathToFileURL(require.resolve('unified')).href;
const parsePath = pathToFileURL(require.resolve('remark-parse')).href;
const gfmPath = pathToFileURL(require.resolve('remark-gfm')).href;
const { unified } = await import(unifiedPath);
const remarkParse = (await import(parsePath)).default;
const remarkGfm = (await import(gfmPath)).default;

function types(tree, acc = []) {
  if (!tree) return acc;
  if (tree.type && tree.type !== 'root' && tree.type !== 'paragraph') {
    acc.push(tree.type + (tree.value !== undefined ? ':' + JSON.stringify(tree.value) : ''));
  }
  for (const c of tree.children || []) types(c, acc);
  return acc;
}

function parse(s) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(s);
  stripCjkEmphasisZwspFromTree(tree);
  return types(tree);
}

// ── 插入位置：闭合内侧（标点|定界符|汉字） ──
assert.equal(softenCjkMarkdownEmphasis('**a。**b'), `**a。${Z}**b`);
assert.equal(softenCjkMarkdownEmphasis('*a。*b'), `*a。${Z}*b`);
assert.equal(softenCjkMarkdownEmphasis('~~a。~~b'), `~~a。${Z}~~b`);
assert.equal(softenCjkMarkdownEmphasis('**已经完成。**然后继续'), `**已经完成。${Z}**然后继续`);

// ── 插入位置：开启内侧（汉字|定界符|标点） ──
assert.equal(softenCjkMarkdownEmphasis('然后**。强调**继续'), `然后**${Z}。强调**继续`);

// ── 已能 flanking 的形态不插 ──
assert.equal(softenCjkMarkdownEmphasis('**bold** text'), '**bold** text');
assert.equal(softenCjkMarkdownEmphasis('已经完成。**然后继续**做'), '已经完成。**然后继续**做');
assert.equal(softenCjkMarkdownEmphasis('。**然后**'), '。**然后**');
assert.equal(softenCjkMarkdownEmphasis('a~b'), 'a~b');

// ── 幂等 ──
const once = softenCjkMarkdownEmphasis('**a。**b');
assert.equal(softenCjkMarkdownEmphasis(once), once);

// ── 行内代码不动 ──
assert.equal(softenCjkMarkdownEmphasis('`**a。**b`'), '`**a。**b`');
assert.equal(softenCjkMarkdownEmphasis('前`**a。**b`后'), '前`**a。**b`后');
assert.equal(softenCjkMarkdownEmphasis('`` **a。**b ``'), '`` **a。**b ``');

// ── 围栏不动 ──
const fence = '```\n**a。**b\n```';
assert.equal(softenCjkMarkdownEmphasis(fence), fence);
const fenceTilde = '~~~\n**a。**b\n~~~';
assert.equal(softenCjkMarkdownEmphasis(fenceTilde), fenceTilde);
const mermaid = '```mermaid\n**a。**b\n```';
assert.equal(softenCjkMarkdownEmphasis(mermaid), mermaid);

// 围栏外仍处理
const mixed = '**a。**b\n```\n**a。**b\n```\n**a。**c';
assert.equal(softenCjkMarkdownEmphasis(mixed), '**a。' + Z + '**b\n```\n**a。**b\n```\n**a。' + Z + '**c');

// ── 保护区间 ──
const spans = collectMarkdownCodeSpans('x `y` z\n```\ncode\n```\n');
assert.equal(spans.length, 2);
assert.equal(spans[0].start, 2);
assert.ok(spans[1].start > spans[0].end);

// ── 解析：预处理后能出 strong / em / delete；剥 ZWSP 后文本干净 ──
assert.deepEqual(parse(softenCjkMarkdownEmphasis('**a。**b')), [
  'strong',
  'text:"a。"',
  'text:"b"'
]);
assert.deepEqual(parse(softenCjkMarkdownEmphasis('*a。*b')), [
  'emphasis',
  'text:"a。"',
  'text:"b"'
]);
assert.deepEqual(parse(softenCjkMarkdownEmphasis('~~a。~~b')), [
  'delete',
  'text:"a。"',
  'text:"b"'
]);
assert.deepEqual(parse(softenCjkMarkdownEmphasis('然后**。强调**继续')), [
  'text:"然后"',
  'strong',
  'text:"。强调"',
  'text:"继续"'
]);
assert.deepEqual(parse('**bold** text'), ['strong', 'text:"bold"', 'text:" text"']);
assert.deepEqual(parse(softenCjkMarkdownEmphasis('`**a。**b`')), ['inlineCode:"**a。**b"']);

console.log('ok: cjk-markdown-emphasis');
