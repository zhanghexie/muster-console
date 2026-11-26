/**
 * 文件读写的乐观锁自测：readText 带 mtime 基线；writeText 基线不符拒绝覆盖（外部修改保护）。
 * 运行: node test/workspace-fs-write.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// workspaceFs.ts 现 import shared/i18n（i18next）：用带目录解析与 i18next shim 的 shared-compile
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-fs-write-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('main/workspaceFs.ts');
const { readText, writeText } = await import(pathToFileURL(outFile).href);

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ma-fs-write-ws-'));
try {
  const file = path.join(wsRoot, 'a.txt');
  await fsp.writeFile(file, 'v1', 'utf8');

  // readText 返回 mtime 基线
  const first = await readText(wsRoot, 'a.txt');
  assert.equal(first.ok, true);
  assert.equal(first.content, 'v1');
  assert.equal(typeof first.mtimeMs, 'number');

  // 基线一致 → 正常写入，并返回新 mtime
  const w1 = await writeText(wsRoot, 'a.txt', 'v2', first.mtimeMs);
  assert.equal(w1.ok, true);
  assert.equal(typeof w1.mtimeMs, 'number');
  assert.equal(await fsp.readFile(file, 'utf8'), 'v2');

  // 基线未变 → 再写也放行（自写链路：用上次返回的新 mtime）
  const w2 = await writeText(wsRoot, 'a.txt', 'v3', w1.mtimeMs);
  assert.equal(w2.ok, true);

  // 模拟外部修改：内容变更 + mtime 明确推进（吸收文件系统时间戳粒度）
  const stale = w2.mtimeMs;
  await fsp.writeFile(file, 'external', 'utf8');
  const future = new Date(stale + 5000);
  await fsp.utimes(file, future, future);

  // 带旧基线写入 → 拒绝覆盖（conflict），磁盘保留外部内容
  const w3 = await writeText(wsRoot, 'a.txt', 'local', stale);
  assert.equal(w3.ok, false);
  assert.equal(w3.conflict, true);
  assert.equal(await fsp.readFile(file, 'utf8'), 'external');

  // 不带基线 → 放行（显式覆盖保存/旧调用方语义）
  const w4 = await writeText(wsRoot, 'a.txt', 'forced');
  assert.equal(w4.ok, true);
  assert.equal(await fsp.readFile(file, 'utf8'), 'forced');

  // 新文件（stat 无从谈起）带不带基线都可写
  const w5 = await writeText(wsRoot, 'new.txt', 'x', 12345);
  assert.equal(w5.ok, true);

  console.log('ok: workspace-fs-write 乐观锁/外部修改保护');
} finally {
  await fsp.rm(wsRoot, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
