/**
 * TTY 注入提交（typeAndSubmit/submitOnly）自测：粘贴模式包裹、Enter 只发 \r 不补 \n。
 * 运行: node test/pty-submit.mjs
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

function transpile(srcPath) {
  const src = fs.readFileSync(srcPath, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  return outputText;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-pty-submit-'));
const srcPath = path.join(root, 'src', 'main', 'pty', 'submit.ts');
const outFile = path.join(tmp, 'submit.mjs');
const stubFile = path.join(tmp, 'i18n-stub.mjs');
fs.writeFileSync(stubFile, 'export const t = (s) => s;\n');
fs.writeFileSync(
  outFile,
  transpile(srcPath).replace(
    /from\s+'([^']+)'/g,
    (_m, p) =>
      p.endsWith('shared/i18n')
        ? `from '${pathToFileURL(stubFile).href}'`
        : `from '${p.startsWith('node:') ? p : pathToFileURL(path.resolve(path.dirname(srcPath), p)).href}'`
  )
);
const { typeAndSubmit, submitOnly, flattenForTypedInput } = await import(pathToFileURL(outFile).href);

// ---- flatten ----
assert.equal(flattenForTypedInput('a\n\n b \r\nc'), 'a | b | c');
assert.equal(flattenForTypedInput('   '), '');

// ---- typed 模式：Enter 只发 \r，绝不补 \n ----
{
  const writes = [];
  const pty = { write: (_id, d) => (writes.push(d), true) };
  const r = await typeAndSubmit(pty, 's1', '任务一\n任务二', { afterTypeMs: 1, enterGapMs: 1 });
  assert.equal(r.submits, 3);
  assert.equal(writes[0], '任务一 | 任务二');
  for (const w of writes.slice(1)) assert.equal(w, '\r', 'Enter 必须是裸 \\r');
  assert.ok(!writes.includes('\n'), '禁止补写 \\n（输入框残留空行根因）');
}

// ---- paste 模式：bracketed paste 包裹 + 单次 \r ----
{
  const writes = [];
  const pty = { write: (_id, d) => (writes.push(d), true) };
  const r = await typeAndSubmit(pty, 's1', '只需回复：收到', { paste: true });
  assert.equal(r.submits, 1, 'paste 模式只按一次 Enter');
  assert.equal(writes[0], '\x1b[200~只需回复：收到\x1b[201~');
  assert.equal(writes[1], '\r');
  assert.equal(writes.length, 2);
}

// ---- submitOnly：裸 \r ----
{
  const writes = [];
  const pty = { write: (_id, d) => (writes.push(d), true) };
  await submitOnly(pty, 's1');
  assert.deepEqual(writes, ['\r']);
}

// ---- paste 失败传播 ----
{
  const pty = { write: () => false };
  await assert.rejects(() => typeAndSubmit(pty, 's1', 'x', { paste: true }), /写入终端失败/);
}

// ---- cancel after typing, before the first Enter ----
{
  const writes = [];
  const cancel = new AbortController();
  const pty = { write: (_id, d) => (writes.push(d), true) };
  const pending = typeAndSubmit(pty, 'cancel', 'pending', { signal: cancel.signal, generation: 'first' });
  assert.deepEqual(writes, ['pending']);
  cancel.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(writes, ['pending']);
  await typeAndSubmit(pty, 'cancel', 'new process', { generation: 'second', afterTypeMs: 1, enterCount: 1 });
  assert.deepEqual(writes, ['pending', 'new process', '\r']);
}

// ---- cancel after the initial Enter, before retries ----
{
  const writes = [];
  const cancel = new AbortController();
  const pty = { write: (_id, d) => (writes.push(d), true) };
  await assert.rejects(typeAndSubmit(pty, 'submitted', 'committed', {
    signal: cancel.signal, afterTypeMs: 1, onFirstSubmit: () => cancel.abort()
  }), { name: 'AbortError' });
  assert.deepEqual(writes, ['committed', '\r']);
}

console.log('pty-submit: ok');
