/**
 * Composer token 分段自测：批注N 切段、贪婪数字（批注1⊂批注10）、未知 token 回落纯文本。
 * 运行: node test/composer-tokens.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'composer-tokens-'));

const transpile = (rel) =>
  ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: rel
  }).outputText;

// composerTokens 依赖 noteAnnotations（token 正则单源）：一并转译进同一临时目录；
// 产物保留 ./name 裸导入，而 Node ESM 要显式扩展名，给入口补 .mjs
const entryCode = transpile('src/shared/composerTokens.ts').replace(
  /from '(\.\/[A-Za-z]+)'/g,
  "from '$1.mjs'"
);
fs.writeFileSync(path.join(tmp, 'composerTokens.mjs'), entryCode, 'utf8');
fs.writeFileSync(path.join(tmp, 'noteAnnotations.mjs'), transpile('src/shared/noteAnnotations.ts').replace("'./workerModelMention'", "'./workerModelMention.mjs'"), 'utf8');
fs.writeFileSync(path.join(tmp, 'workerModelMention.mjs'), transpile('src/shared/workerModelMention.ts'), 'utf8');
const { tokenizeComposerText, expectedNoteTokenIds, noteTokenDomMatches } = await import(
  pathToFileURL(path.join(tmp, 'composerTokens.mjs')).href
);

const NOTES = [
  { id: 'n1', token: '批注1' },
  { id: 'n2', token: '批注2' },
  { id: 'n12', token: '批注12' }
];

assert.deepEqual(tokenizeComposerText('[File: "/work/批注1.md"] 批注1', NOTES), [
  { kind: 'text', text: '[File: "/work/批注1.md"] ' }, { kind: 'note', id: 'n1', token: '批注1' }
]);

function kinds(text, notes = NOTES) {
  return tokenizeComposerText(text, notes).map((s) =>
    s.kind === 'note' ? `note:${s.id}` : `text:${JSON.stringify(s.text)}`
  );
}

// 纯文本单段
assert.deepEqual(kinds('你好世界'), ['text:"你好世界"']);

// 单 token
assert.deepEqual(kinds('批注1'), ['note:n1']);
assert.deepEqual(kinds('看 批注2 谢谢'), ['text:"看 "', 'note:n2', 'text:" 谢谢"']);

// 贪婪数字：批注12 不会被 批注1 咬进
assert.deepEqual(kinds('批注12'), ['note:n12']);
assert.deepEqual(kinds('批注1 批注12'), ['note:n1', 'text:" "', 'note:n12']);

// 未知序号当纯文本（孤儿 token 由 useSessionNotes 摘除，这里不认）
assert.deepEqual(kinds('批注9'), ['text:"批注9"']);
assert.deepEqual(kinds('批注1批注9'), ['note:n1', 'text:"批注9"']);

// 空 token 表全文本
assert.deepEqual(kinds('批注1', []), ['text:"批注1"']);

// 空串
assert.deepEqual(tokenizeComposerText('', NOTES), []);

// 表晚到：草稿已有 批注1 2 3，DOM 只切出前两颗 → 对账失败（要 rebuild）
const three = [
  { id: 'n1', token: '批注1' },
  { id: 'n2', token: '批注2' },
  { id: 'n3', token: '批注3' }
];
assert.deepEqual(expectedNoteTokenIds('批注1 批注2 批注3', three), ['n1', 'n2', 'n3']);
assert.equal(noteTokenDomMatches('批注1 批注2 批注3', three, ['n1', 'n2']), false);
assert.equal(noteTokenDomMatches('批注1 批注2 批注3', three, ['n1', 'n2', 'n3']), true);
// 表只有前两颗时，第三段是纯文本，期望也只有两颗
assert.deepEqual(expectedNoteTokenIds('批注1 批注2 批注3', NOTES.slice(0, 2)), ['n1', 'n2']);

console.log('ok composer-tokens');
