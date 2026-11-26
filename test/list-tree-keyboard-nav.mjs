/**
 * List/tree keyboard navigation pure functions self-test.
 * Run: node test/list-tree-keyboard-nav.mjs
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
const entry = path.join(root, 'src', 'shared', 'listTreeKeyboardNav.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'list-tree-nav-'));
  const outFile = path.join(tmp, 'listTreeKeyboardNav.mjs');
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
const { moveListIndex, nextTreeIndexOnArrow } = await import(pathToFileURL(outFile).href);

assert.equal(moveListIndex(0, 'ArrowUp', 3), 0);
assert.equal(moveListIndex(0, 'ArrowDown', 3), 1);
assert.equal(moveListIndex(2, 'ArrowDown', 3), 2);
assert.equal(moveListIndex(1, 'Home', 3), 0);
assert.equal(moveListIndex(1, 'End', 3), 2);
assert.equal(moveListIndex(-1, 'ArrowDown', 3), 0);
assert.equal(moveListIndex(0, 'ArrowDown', 0), -1);

const rows = [
  { id: 'root', parentId: null, expandable: true, expanded: true },
  { id: 'dir', parentId: 'root', expandable: true, expanded: false },
  { id: 'file', parentId: 'root', expandable: false, expanded: false }
];
assert.deepEqual(nextTreeIndexOnArrow(rows, 1, 'ArrowRight'), { index: 1, toggleId: 'dir' });
const rowsOpen = rows.map((r) => (r.id === 'dir' ? { ...r, expanded: true } : r));
// 展开后若无子行：Right 不移动
assert.deepEqual(nextTreeIndexOnArrow(rowsOpen, 1, 'ArrowRight'), { index: 1 });
const withChild = [
  { id: 'dir', parentId: null, expandable: true, expanded: true },
  { id: 'child', parentId: 'dir', expandable: false, expanded: false }
];
assert.deepEqual(nextTreeIndexOnArrow(withChild, 0, 'ArrowRight'), { index: 1 });
assert.deepEqual(nextTreeIndexOnArrow(withChild, 0, 'ArrowLeft'), { index: 0, toggleId: 'dir' });
assert.deepEqual(nextTreeIndexOnArrow(withChild, 1, 'ArrowLeft'), { index: 0 });

console.log('list-tree-keyboard-nav: ok');
fs.rmSync(tmp, { recursive: true, force: true });
