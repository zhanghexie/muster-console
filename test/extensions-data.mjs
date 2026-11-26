import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-data-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ExtensionDataStore, extensionDataDirectory } = await import(pathToFileURL(compile('main/extensions/extensionData.ts')));
  const global = { id: 'demo', name: 'Demo', scope: 'global', data: { workspace: true, shared: false } };
  const shared = { ...global, data: { workspace: true, shared: true } };
  const a = new ExtensionDataStore(temp, 'workspace-a', global);
  const b = new ExtensionDataStore(temp, 'workspace-b', global);
  a.write('reports/today.md', 'A');
  assert.equal(a.read('reports/today.md'), 'A');
  assert.equal(b.read('reports/today.md'), null, 'global default data is isolated per workspace');
  assert.deepEqual(a.list('reports'), [{ name: 'today.md', directory: false }]);
  assert.throws(() => a.write('shared.txt', 'value', 'shared'), /not declared/);
  const sharedA = new ExtensionDataStore(temp, 'workspace-a', shared);
  const sharedB = new ExtensionDataStore(temp, 'workspace-b', shared);
  sharedA.write('shared.txt', 'value', 'shared');
  assert.equal(sharedB.read('shared.txt', 'shared'), 'value');

  const projectA = { ...global, scope: 'project', project: { kind: 'relative', path: '.' } };
  const projectB = { ...global, scope: 'project', project: { kind: 'relative', path: '../other' } };
  const pa = new ExtensionDataStore(temp, 'workspace-a', projectA);
  const pb = new ExtensionDataStore(temp, 'workspace-a', projectB);
  pa.write('reports/today.md', 'project A');
  assert.equal(pb.read('reports/today.md'), null);
  assert.equal(a.read('reports/today.md'), 'A', 'project/global scopes never reuse data');
  assert.throws(() => new ExtensionDataStore(temp, 'workspace-a', { ...projectA, data: { workspace: true, shared: true } }).read('x', 'shared'), /not declared/);
  for (const invalid of ['../escape', 'a/../../escape', '/absolute', 'C:/escape', 'a\\escape', 'CON', '.host/tasks.json']) assert.throws(() => a.write(invalid, 'x'), /Invalid extension data path/, invalid);
  assert.throws(() => a.write('huge.txt', 'x'.repeat(1024 * 1024 + 1)), /size limit/);
  assert.ok(extensionDataDirectory(temp, '..', global).startsWith(path.join(temp, 'extension')));

  const outside = path.join(temp, 'outside'); fs.mkdirSync(outside);
  const dataRoot = extensionDataDirectory(temp, 'workspace-a', global);
  const link = path.join(dataRoot, 'link');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => a.write('link/file.txt', 'no'), /Links are not allowed/);
    assert.equal(fs.existsSync(path.join(outside, 'file.txt')), false);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    console.log('symlink test skipped: creating links is unavailable');
  }
  console.log('extensions-data: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
