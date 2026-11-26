/** File tree links are browsable without granting write access outside a source root. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-tree-links-'));
try {
  const compile = createSharedCompiler(repo, tmp);
  const { listTreeDir, listDir, readText, writeText, removePath } = await import(pathToFileURL(compile('main/workspaceFs.ts')).href);
  const { withWorkspaceFileTarget } = await import(pathToFileURL(compile('main/workspaceFileAccess.ts')).href);
  const root = path.join(tmp, 'root');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'inside'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inside', 'local.txt'), 'local');
  fs.writeFileSync(path.join(outside, 'nested', 'SKILL.md'), 'linked skill');
  const dirLink = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(root, 'skills'), dirLink);
  fs.symlinkSync(path.join(root, 'inside'), path.join(root, 'local-alias'), dirLink);
  fs.symlinkSync(root, path.join(outside, 'back'), dirLink);
  fs.symlinkSync(path.join(tmp, 'missing'), path.join(root, 'broken'), dirLink);
  const rootEntries = await listTreeDir(root);
  assert.equal(rootEntries.find(e => e.name === 'skills')?.isSymbolicLink, true);
  assert.equal(rootEntries.find(e => e.name === 'skills')?.isDirectory, true);
  assert.ok(rootEntries.find(e => e.name === 'broken')?.linkError, 'broken links remain visible with an error');
  const local = (await listTreeDir(root, 'local-alias')).find(e => e.name === 'local.txt');
  assert.equal(local.relativePath, 'local-alias/local.txt');
  assert.equal(local.viaSymbolicLink, true);
  assert.equal(local.externalPath, undefined);
  assert.equal((await readText(root, 'local-alias/local.txt')).content, 'local');
  assert.equal((await writeText(root, 'local-alias/local.txt', 'edited inside')).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'inside', 'local.txt'), 'utf8'), 'edited inside');
  const nested = (await listTreeDir(root, 'skills')).find(e => e.name === 'nested');
  assert.equal(nested.relativePath, 'skills/nested');
  const skill = (await listTreeDir(root, 'skills/nested')).find(e => e.name === 'SKILL.md');
  assert.equal(skill.relativePath, 'skills/nested/SKILL.md');
  assert.equal(skill.externalPath, await fs.promises.realpath(path.join(outside, 'nested', 'SKILL.md')));
  assert.ok((await listTreeDir(root, 'skills')).find(e => e.name === 'back')?.linkError, 'cycle is visible but cannot be expanded');
  const workspace = { id: 'ws', name: 'test', openedAt: 0, path: root, controlRoot: root, rootsRevision: 0,
    defaultRootId: 'root', roots: [{ id: 'root', path: root }] };
  let config = { workspaces: [workspace], activeWorkspaceId: 'ws' };
  const get = () => config;
  const ref = { workspaceId: 'ws', rootId: 'root', relativePath: 'skills/nested' };
  const listed = await withWorkspaceFileTarget(get, ref, '', (source, current) => listTreeDir(source, current.relativePath), false, true);
  assert.equal(listed[0].relativePath, 'skills/nested/SKILL.md');
  await assert.rejects(withWorkspaceFileTarget(get, ref, '', async () => true), /outside workspace root/);
  await assert.rejects(withWorkspaceFileTarget(get, { ...ref, relativePath: '../outside' }, '', async () => true, false, true), /invalid workspace relative path/);
  await assert.rejects(withWorkspaceFileTarget(get, ref, '', async () => {
    config = { ...config, workspaces: [{ ...workspace, rootsRevision: 1 }] };
    return true;
  }, false, true), /source folders changed/);
  await assert.rejects(listTreeDir(root, '../outside'), /outside workspace root|invalid workspace relative path/);
  await assert.rejects(listDir(root, 'skills'), /outside workspace root/);
  assert.equal((await writeText(root, 'skills/nested/SKILL.md', 'wrong')).ok, false);
  assert.equal((await removePath(root, 'skills/nested/SKILL.md')).ok, false);
  assert.equal(fs.readFileSync(path.join(outside, 'nested', 'SKILL.md'), 'utf8'), 'linked skill');
  try {
    fs.symlinkSync(path.join(outside, 'nested', 'SKILL.md'), path.join(root, 'skill-link.md'), 'file');
    const link = (await listTreeDir(root)).find(e => e.name === 'skill-link.md');
    assert.equal(link.isDirectory, false);
    assert.equal(link.externalPath, await fs.promises.realpath(path.join(outside, 'nested', 'SKILL.md')));
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('file symlink fixture unavailable on Windows without symlink privilege');
    // Still exercise the file-link classification branch using a synthetic Dirent.
    const promises = fs.promises;
    const original = { readdir: promises.readdir, stat: promises.stat, realpath: promises.realpath };
    const virtualLink = path.join(root, 'simulated-link.md');
    const destination = path.join(outside, 'nested', 'SKILL.md');
    try {
      promises.readdir = async (dir, options) => {
        const entries = await original.readdir(dir, options);
        if (dir === root) entries.push({ name: 'simulated-link.md', isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false });
        return entries;
      };
      promises.stat = (file, ...args) => original.stat(file === virtualLink ? destination : file, ...args);
      promises.realpath = (file, ...args) => original.realpath(file === virtualLink ? destination : file, ...args);
      const link = (await listTreeDir(root)).find(e => e.name === 'simulated-link.md');
      assert.equal(link.isSymbolicLink, true);
      assert.equal(link.isDirectory, false);
      assert.equal(link.externalPath, await original.realpath(destination));
    } finally { Object.assign(promises, original); }
  }
  console.log('workspace-tree-links: OK');
} finally {
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(tmp));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('invalid temporary fixture path');
  fs.rmSync(tmp, { recursive: true, force: true });
}
