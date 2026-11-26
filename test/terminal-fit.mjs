/**
 * 终端 fit 策略自测：整行取整，余量作底垫，不拉高 lineHeight、不裁剪。
 * 运行: node test/terminal-fit.mjs
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
const entry = path.join(root, 'src', 'shared', 'terminalFit.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'term-fit-'));
  const outFile = path.join(tmp, 'terminalFit.mjs');
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
const {
  TERMINAL_BASE_LINE_HEIGHT,
  rowsFittingHeight,
  verticalPadPx,
  clampRowsToHeight
} = await import(pathToFileURL(outFile).href);

assert.equal(TERMINAL_BASE_LINE_HEIGHT, 1.2);

{
  const cellH = 18;
  const avail = 100; // 5*18=90, leftover 10
  const rows = rowsFittingHeight(avail, cellH);
  assert.equal(rows, 5);
  assert.equal(verticalPadPx(avail, rows, cellH), 10);
  assert.ok(rows * cellH <= avail, 'grid must not exceed container');
}

{
  // 变矮：原 6 行已放不下 → 必须降行，不能靠裁剪
  const cellH = 18;
  const avail = 100;
  assert.equal(clampRowsToHeight(6, avail, cellH), 5);
  assert.equal(clampRowsToHeight(5, avail, cellH), 5);
  assert.equal(clampRowsToHeight(0, avail, cellH), 0);
}

{
  assert.equal(rowsFittingHeight(0, 18), 0);
  assert.equal(verticalPadPx(100, 0, 18), 100);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('terminal-fit: ok');
