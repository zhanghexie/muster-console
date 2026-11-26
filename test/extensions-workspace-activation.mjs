import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-workspace-activation-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ensureExtensionStorageRoot, extensionWorkspaceActivationPath, ExtensionWorkspaceActivationStore } = await import(pathToFileURL(compile('main/extensions/extensionWorkspaceActivation.ts')));
  const profile = path.join(temp, 'profile');
  const file = extensionWorkspaceActivationPath(profile);
  assert.equal(file, path.join(profile, 'extension', 'workspace-activation.json'));
  const legacyRoot = path.join(temp, 'legacy-profile', 'extension');
  fs.mkdirSync(path.dirname(legacyRoot), { recursive: true });
  fs.writeFileSync(legacyRoot, '{"version":1,"records":[]}');
  assert.equal(ensureExtensionStorageRoot(path.dirname(legacyRoot)), legacyRoot);
  assert.ok(fs.statSync(legacyRoot).isDirectory(), 'the extension root must remain a directory after recovering a legacy file collision');
  assert.ok(fs.existsSync(path.join(legacyRoot, 'workspace-activation.json')));
  const store = new ExtensionWorkspaceActivationStore(file);
  const global = { workspaceId: 'one', scope: 'global', extensionId: 'daily-report' };

  assert.equal(store.isEnabled(global), true, 'legacy packages remain enabled until migrated');
  await store.set(global, false);
  assert.equal(store.isEnabled(global), false);
  assert.equal(store.get(global)?.enabled, false);
  assert.equal(store.list('one').length, 1);

  await store.ensure([{ workspaceId: 'one', scope: 'global', extensionId: 'daily-report' }, { workspaceId: 'two', scope: 'global', extensionId: 'daily-report' }], true);
  assert.equal(store.isEnabled(global), false, 'ensure does not overwrite an explicit user choice');
  assert.equal(store.isEnabled({ workspaceId: 'two', scope: 'global', extensionId: 'daily-report' }), true);

  const project = { workspaceId: 'one', scope: 'project', extensionId: 'local-dev', controlRoot: path.join(temp, 'project') };
  await store.set(project, true);
  assert.equal(store.isEnabled(project), true);
  assert.equal(store.get({ ...project, controlRoot: path.join(temp, 'project', '.') })?.enabled, true);
  await assert.rejects(() => store.set({ workspaceId: 'one', scope: 'project', extensionId: 'missing-root' }, true), /control root/i);

  const reloaded = new ExtensionWorkspaceActivationStore(file);
  assert.equal(reloaded.isEnabled(global), false);
  assert.equal(reloaded.isEnabled({ workspaceId: 'two', scope: 'global', extensionId: 'daily-report' }), true);
  assert.equal(reloaded.isEnabled(project), true);

  fs.writeFileSync(file, '{broken');
  const recovered = new ExtensionWorkspaceActivationStore(file);
  assert.equal(recovered.list().length, 0);
  assert.ok(fs.readdirSync(path.dirname(file)).some(name => name.startsWith('workspace-activation.json.corrupt-')));
  console.log('extensions-workspace-activation: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
