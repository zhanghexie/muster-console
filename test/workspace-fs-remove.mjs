/**
 * removePath（真 src/main/workspaceFs.ts）：根目录拒绝、越界拒绝、文件/目录递归删除、缺失路径不误报成功。
 * 自查：把 removePath 的根判定或 resolveRealPathInsideRoot 越界防护去掉，本文件应转红。
 * Run: node test/workspace-fs-remove.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// workspaceFs.ts import shared/i18n（i18next）：用带目录解析与 i18next shim 的 shared-compile
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-fs-rm-'));
const compile = createSharedCompiler(root, tmp);
const { removePath } = await import(pathToFileURL(compile('main/workspaceFs.ts')).href);

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'ma-fs-rm-ws-'));
try {
  await fsp.mkdir(path.join(wsRoot, 'sub'));
  await fsp.writeFile(path.join(wsRoot, 'sub', 'a.txt'), 'x');
  await fsp.writeFile(path.join(wsRoot, 'b.txt'), 'y');

  // 根目录拒绝：空串与 '.' 都视为根
  assert.equal((await removePath(wsRoot, '')).ok, false, '空 rel 应拒绝删除根');
  assert.equal((await removePath(wsRoot, '.')).ok, false, "'.' 应拒绝删除根");
  assert.equal((await removePath(wsRoot, '../outside')).ok, false, '越界路径应拒绝');

  // 文件删除
  assert.equal((await removePath(wsRoot, 'b.txt')).ok, true);
  await assert.rejects(fsp.stat(path.join(wsRoot, 'b.txt')));

  // 目录递归删除
  assert.equal((await removePath(wsRoot, 'sub')).ok, true);
  await assert.rejects(fsp.stat(path.join(wsRoot, 'sub')));

  // 不存在的路径：force:false 下 ENOENT 归一为失败结果，不得报成功
  const miss = await removePath(wsRoot, 'missing.txt');
  assert.equal(miss.ok, false);
  assert.ok(miss.error, '缺失路径应带回错误信息');

  console.log('ok: workspace-fs-remove');
} finally {
  await fsp.rm(wsRoot, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
