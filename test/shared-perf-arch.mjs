/**
 * pathKey / ptyBuffer / chatHistory / errors / ipcEvents
 * Run: node test/shared-perf-arch.mjs
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

function compile(rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022
    }
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-shared-'));
  const out = path.join(tmp, path.basename(rel, '.ts') + '.mjs');
  fs.writeFileSync(out, outputText);
  return out;
}

const pathKeyMod = await import(pathToFileURL(compile('src/shared/pathKey.ts')).href);
const ptyMod = await import(pathToFileURL(compile('src/shared/ptyBuffer.ts')).href);
const chatMod = await import(pathToFileURL(compile('src/shared/chatHistory.ts')).href);
const errMod = await import(pathToFileURL(compile('src/shared/errors.ts')).href);

assert.equal(pathKeyMod.pathKey('D:/Foo/Bar'), pathKeyMod.pathKey('D:\\Foo\\Bar'));
assert.equal(pathKeyMod.pathKey('D:/Foo/Bar/'), pathKeyMod.pathKey('D:/Foo/Bar'));

const buf = ptyMod.createPtyChunkBuf();
ptyMod.appendPtyChunk(buf, 'hello');
ptyMod.appendPtyChunk(buf, ' world');
assert.equal(ptyMod.joinPtyChunks(buf), 'hello world');
const big = ptyMod.createPtyChunkBuf();
ptyMod.appendPtyChunk(big, 'a'.repeat(150_000));
ptyMod.appendPtyChunk(big, 'b'.repeat(150_000));
assert.ok(ptyMod.joinPtyChunks(big).length <= ptyMod.PTY_MAX_BUFFER);

const wrapped = chatMod.wrapChatStore(
  Array.from({ length: 500 }, (_, i) => ({ i })),
  Array.from({ length: 500 }, (_, i) => i)
);
assert.equal(wrapped.version, 1);
assert.equal(wrapped.display.length, 400);
assert.equal(wrapped.api.length, 400);
assert.equal(wrapped.display[0].i, 100);

assert.equal(errMod.errorMessage(new Error('x')), 'x');
assert.equal(errMod.errorMessage('y'), 'y');

console.log('shared-perf-arch ok');
