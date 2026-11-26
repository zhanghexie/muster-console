import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-binding-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { portableProjectPath, isPortableProjectPath, validateExtensionProjectBinding, createExtensionProjectBinding, resolveExtensionProjectBinding, resolveExtensionProjectBindingAsync } = await import(pathToFileURL(compile('main/extensions/extensionProjectBinding.ts')));
  assert.equal(portableProjectPath('C:\\work\\main', 'C:\\work\\other', path.win32), '../other');
  assert.equal(portableProjectPath('C:\\work', 'D:\\other', path.win32), null);
  assert.equal(portableProjectPath('/work/main', '/work/other', path.posix), '../other');
  for (const invalid of ['', '/absolute', 'a/../b', 'a\\b', 'C:/other', 'CON', 'name.', 'a//b']) assert.equal(isPortableProjectPath(invalid), false, invalid);
  for (const valid of ['.', '..', '../project', 'projects/应用']) assert.equal(isPortableProjectPath(valid), true, valid);
  assert.equal(validateExtensionProjectBinding({ kind: 'mapped', key: 'project-42' }), true);
  assert.equal(validateExtensionProjectBinding({ kind: 'mapped', key: '../escape' }), false);
  assert.equal(validateExtensionProjectBinding({ kind: 'relative', path: '.', rootId: 'local' }), false);

  const main = path.join(temp, 'work', 'main');
  const other = path.join(temp, 'work', 'other');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const workspace = { id: 'ws', name: 'Workspace', path: main, controlRoot: main, roots: [{ id: 'one', path: main }, { id: 'two', path: other }], defaultRootId: 'one', openedAt: 0 };
  const binding = createExtensionProjectBinding(workspace, 'two');
  assert.deepEqual(binding, { kind: 'relative', path: '../other' });
  assert.equal(resolveExtensionProjectBinding(workspace, binding).id, 'two');
  const originalRealpathSync = fs.realpathSync;
  fs.realpathSync = () => { throw new Error('synchronous root lookup'); };
  try { assert.equal((await resolveExtensionProjectBindingAsync(workspace, binding)).id, 'two'); }
  finally { fs.realpathSync = originalRealpathSync; }
  assert.equal(resolveExtensionProjectBinding(workspace, { kind: 'relative', path: '.' }).id, 'one');
  assert.throws(() => createExtensionProjectBinding(workspace, 'missing'), /not registered/);
  assert.throws(() => resolveExtensionProjectBinding({ ...workspace, roots: [workspace.roots[0]] }, binding), /no longer registered/);
  assert.throws(() => resolveExtensionProjectBinding({ ...workspace, roots: [...workspace.roots, { id: 'duplicate', path: other }] }, binding), /ambiguous/);
  await assert.rejects(resolveExtensionProjectBindingAsync({ ...workspace, roots: [...workspace.roots, { id: 'duplicate', path: other }] }, binding), /ambiguous/);

  const mapped = { kind: 'mapped', key: 'portable-project-id' };
  const mapping = { key: mapped.key, workspaceId: 'ws', rootId: 'two', realPath: fs.realpathSync(other) };
  assert.equal(resolveExtensionProjectBinding(workspace, mapped, [mapping]).id, 'two');
  assert.equal((await resolveExtensionProjectBindingAsync(workspace, mapped, [mapping])).id, 'two');
  await assert.rejects(resolveExtensionProjectBindingAsync(workspace, mapped, [{ ...mapping, rootId: 'one' }]), /no longer registered/);
  assert.throws(() => resolveExtensionProjectBinding(workspace, mapped), /explicit local mapping/);
  assert.throws(() => resolveExtensionProjectBinding(workspace, mapped, [{ ...mapping, rootId: 'one' }]), /no longer registered/);
  assert.throws(() => resolveExtensionProjectBinding(workspace, mapped, [mapping, mapping]), /explicit local mapping/);
  assert.throws(() => resolveExtensionProjectBinding({ ...workspace, id: 'different' }, mapped, [mapping]), /explicit local mapping/);
  console.log('extensions-project-binding: ok');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
