import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-mappings-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ExtensionProjectMappings } = await import(pathToFileURL(compile('main/extensions/extensionProjectMappings.ts')));
  const { resolveExtensionProjectBinding } = await import(pathToFileURL(compile('main/extensions/extensionProjectBinding.ts')));
  const main = path.join(temp, 'main'), external = path.join(temp, 'external'); fs.mkdirSync(main); fs.mkdirSync(external);
  const workspace = { id: 'ws', name: 'Workspace', path: main, controlRoot: main, roots: [{ id: 'main', path: main }, { id: 'external', path: external }], defaultRootId: 'main', openedAt: 0 };
  const file = path.join(temp, 'profile', 'mappings.json'), store = new ExtensionProjectMappings(file);
  store.bind(workspace, 'portable-project', 'external');
  assert.equal(resolveExtensionProjectBinding(workspace, { kind: 'mapped', key: 'portable-project' }, store.list()).id, 'external');
  assert.equal(new ExtensionProjectMappings(file).list()[0].rootId, 'external');
  const moved = { ...workspace, roots: [{ id: 'main', path: main }, { id: 'external', path: main }] };
  assert.throws(() => resolveExtensionProjectBinding(moved, { kind: 'mapped', key: 'portable-project' }, store.list()), /no longer registered/);
  assert.throws(() => store.bind(moved, 'ambiguous', 'main'), /ambiguous/);
  assert.throws(() => store.bind(workspace, 'portable-project', 'main'), /current root ID/);
  assert.equal(store.list()[0].rootId, 'external', 'a reused key cannot silently rebind an existing project');
  assert.throws(() => store.bind(workspace, 'portable-project', 'main', 'outdated'), /current root ID/);
  store.bind(workspace, 'portable-project', 'main', 'external');
  assert.equal(resolveExtensionProjectBinding(workspace, { kind: 'mapped', key: 'portable-project' }, store.list()).id, 'main');
  assert.throws(() => store.bind(workspace, '../invalid', 'main'), /identity/);
  store.unbind('ws', 'portable-project');
  assert.throws(() => resolveExtensionProjectBinding(workspace, { kind: 'mapped', key: 'portable-project' }, store.list()), /explicit local mapping/);
  console.log('extensions-project-mappings: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
