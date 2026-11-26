/**
 * mermaid 围栏语言检测（MarkdownBody 用来分流渲染）。
 * 运行: node test/mermaid-fence.mjs
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mermaid-fence-'));
const entry = path.join(root, 'src/shared/mermaidFence.ts');
const { outputText } = ts.transpileModule(fs.readFileSync(entry, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: entry
});
const out = path.join(tmp, 'mermaidFence.mjs');
fs.writeFileSync(out, outputText);
const { isMermaidFenceClass, mermaidSourceFromCodeChildren } = await import(pathToFileURL(out).href);

assert.equal(isMermaidFenceClass('language-mermaid'), true);
assert.equal(isMermaidFenceClass('language-Mermaid'), true);
assert.equal(isMermaidFenceClass('mermaid'), true);
assert.equal(isMermaidFenceClass('language-js mermaid'), true);
assert.equal(isMermaidFenceClass('language-javascript'), false);
assert.equal(isMermaidFenceClass('language-mermaidjs'), false);
assert.equal(isMermaidFenceClass(''), false);
assert.equal(isMermaidFenceClass(undefined), false);
assert.equal(isMermaidFenceClass(null), false);

assert.equal(mermaidSourceFromCodeChildren('graph TD;\nA-->B\n'), 'graph TD;\nA-->B');
assert.equal(mermaidSourceFromCodeChildren(['graph TD;\n', 'A-->B']), 'graph TD;\nA-->B');
assert.equal(mermaidSourceFromCodeChildren(null), '');

console.log('ok: mermaid-fence');
