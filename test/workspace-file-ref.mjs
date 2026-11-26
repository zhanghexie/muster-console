/** 真实文件与 Junction：同名文件、重叠根、失效身份、越界与新文件写入。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-file-ref-'));
try {
  const compile = createSharedCompiler(repo, tmp);
  const { resolveFileRef, locateAbsolutePath, normalizeWorkspaceRoots, requireWorkspace, captureWorkspaceRoots, workspaceRootsAreCurrent } = await import(pathToFileURL(compile('main/workspacePaths.ts')).href);
  const { readText, writeText, removePath, statPath, listDir } = await import(pathToFileURL(compile('main/workspaceFs.ts')).href);
  const { requireSourceRoot, workspaceFileKey } = await import(pathToFileURL(compile('shared/workspaceRoots.ts')).href);
  const a = path.join(tmp, 'a');
  const b = path.join(tmp, 'b');
  const outside = path.join(tmp, 'outside');
  for (const dir of [a, b, outside]) { fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.writeFileSync(path.join(dir, 'src/index.ts'), dir); }
  const workspace = normalizeWorkspaceRoots({ id: 'ws', name: 'test', openedAt: 0, path: a, controlRoot: a,
    roots: [{ id: 'a', path: a }, { id: 'b', path: b }, { id: 'child', path: path.join(a, 'src') }], defaultRootId: 'b' });
  const config = { workspaces: [workspace], activeWorkspaceId: 'ws' };
  const refA = { workspaceId: 'ws', rootId: 'a', relativePath: 'src/index.ts' };
  const refB = { ...refA, rootId: 'b' };
  assert.equal(await resolveFileRef(config, refA), path.join(a, 'src/index.ts'));
  assert.equal(await resolveFileRef(config, refB), path.join(b, 'src/index.ts'));
  assert.notEqual(workspaceFileKey(refA), workspaceFileKey(refB));
  assert.deepEqual(await locateAbsolutePath(workspace, path.join(a, 'src/index.ts')), { workspaceId: 'ws', rootId: 'child', relativePath: 'index.ts' });
  assert.equal(await locateAbsolutePath(workspace, path.join(outside, 'src/index.ts')), undefined);
  assert.throws(() => requireWorkspace(config, 'unknown'), /workspace not found/);
  assert.throws(() => requireWorkspace(config, ''), /workspace not found/);
  assert.throws(() => requireSourceRoot(workspace), /selection required/);
  const token = captureWorkspaceRoots(config, 'ws');
  assert.equal(workspaceRootsAreCurrent(config, token), true);
  assert.equal(workspaceRootsAreCurrent({ ...config, workspaces: [{ ...workspace, rootsRevision: 1 }] }, token), false);
  assert.equal(workspaceRootsAreCurrent({ ...config, workspaces: [] }, token), false);
  await assert.rejects(resolveFileRef(config, { ...refA, rootId: 'removed' }), /source folder not found/);
  for (const relativePath of ['../b/src/index.ts', 'src/../../b/index.ts', path.join(b, 'src/index.ts'), 'D:relative.ts', '\\server\\share\\f.txt']) {
    await assert.rejects(resolveFileRef(config, { ...refA, relativePath }), /invalid workspace relative path/);
  }
  fs.writeFileSync(path.join(a, '..visible.txt'), 'valid dot prefix');
  assert.equal((await readText(a, '..visible.txt')).content, 'valid dot prefix', 'dot prefixes are not parent segments');
  assert.equal((await writeText(b, 'new.ts', 'new')).ok, true);
  assert.equal(fs.readFileSync(path.join(b, 'new.ts'), 'utf8'), 'new');
  const escape = path.join(a, 'escape');
  fs.symlinkSync(outside, escape, 'junction');
  for (const result of [await readText(a, 'escape/src/index.ts'), await statPath(a, 'escape/src/index.ts'),
    await writeText(a, 'escape/src/index.ts', 'corruption'), await writeText(a, 'escape/new.ts', 'corruption'),
    await removePath(a, 'escape/src'), await removePath(a, 'escape')]) {
    assert.equal(result.ok, false, 'a Junction cannot expand the registered root boundary');
    assert.match(result.error, /outside workspace root/);
  }
  await assert.rejects(listDir(a, 'escape/src'), /outside workspace root/);
  assert.equal(fs.readFileSync(path.join(outside, 'src/index.ts'), 'utf8'), outside, 'outside content is preserved');
  assert.equal(fs.existsSync(path.join(outside, 'new.ts')), false);
  assert.equal((await removePath(a, '.')).ok, false);
  const alias = path.join(tmp, 'alias');
  fs.symlinkSync(a, alias, 'junction');
  assert.deepEqual(await locateAbsolutePath(workspace, path.join(alias, 'src/index.ts')), { workspaceId: 'ws', rootId: 'child', relativePath: 'index.ts' });
  assert.equal((await readText(alias, 'src/index.ts')).content, a, 'a registered root may itself be an alias');
  console.log('workspace-file-ref: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
