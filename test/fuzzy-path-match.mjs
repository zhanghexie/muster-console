/**
 * 模糊路径匹配自测。
 * 运行: node test/fuzzy-path-match.mjs
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
const entry = path.join(root, 'src', 'shared', 'fuzzyPathMatch.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzzy-'));
  const outFile = path.join(tmp, 'fuzzyPathMatch.mjs');
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
const { rankFuzzyPaths, scoreFuzzyPath } = await import(pathToFileURL(outFile).href);

assert.ok(scoreFuzzyPath('src/a.ts', 'a.ts') > 0);
const ranked = rankFuzzyPaths(['src/a.ts', 'lib/b.ts', 'src/ab.ts'], 'a.ts', 10);
assert.ok(ranked.includes('src/a.ts'));
assert.equal(rankFuzzyPaths(['a', 'b'], 'zzz', 10).length, 0);
assert.deepEqual(rankFuzzyPaths(['a', 'b'], '', 1), ['a']);

console.log('fuzzy-path-match: ok');
fs.rmSync(tmp, { recursive: true, force: true });
