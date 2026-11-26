/**
 * 路径沙箱自测。
 * 运行: node test/workspace-path.mjs
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
const entry = path.join(root, 'src', 'shared', 'workspacePath.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-path-'));
  const outFile = path.join(tmp, 'workspacePath.mjs');
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
const { resolveInsideRoot, toPosixRel } = await import(pathToFileURL(outFile).href);

const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws);
const inside = path.join(ws, 'a.ts');
fs.writeFileSync(inside, 'x');

assert.equal(resolveInsideRoot(ws, 'a.ts'), path.resolve(ws, 'a.ts'));
assert.equal(resolveInsideRoot(ws, inside), path.resolve(inside));
assert.throws(() => resolveInsideRoot(ws, path.join(tmp, 'other', 'a.ts')), /outside/);
assert.throws(() => resolveInsideRoot(ws, '..'), /outside/);
assert.equal(toPosixRel(ws, inside), 'a.ts');
assert.equal(resolveInsideRoot(ws, '..visible.txt'), path.join(ws, '..visible.txt'));
assert.equal(toPosixRel(ws, path.join(ws, '..visible.txt')), '..visible.txt');

console.log('workspace-path: ok');
fs.rmSync(tmp, { recursive: true, force: true });
