/**
 * 编辑器语言映射自测。
 * 运行: node test/editor-languages.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'editorLanguages.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ed-lang-'));
  const outFile = path.join(tmp, 'editorLanguages.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const { languageIdForPath } = await import(pathToFileURL(outFile).href);

assert.equal(languageIdForPath('a.ts'), 'typescript');
assert.equal(languageIdForPath('src/x.tsx'), 'typescript');
assert.equal(languageIdForPath('a.js'), 'javascript');
assert.equal(languageIdForPath('a.json'), 'json');
assert.equal(languageIdForPath('README.md'), 'markdown');
assert.equal(languageIdForPath('a.py'), 'python');
assert.equal(languageIdForPath('a.css'), 'css');
assert.equal(languageIdForPath('a.html'), 'html');
assert.equal(languageIdForPath('a.cpp'), 'cpp');
assert.equal(languageIdForPath('a.unknown'), 'plaintext');
assert.equal(languageIdForPath('Makefile'), 'plaintext');

console.log('editor-languages: ok');
fs.rmSync(tmp, { recursive: true, force: true });
