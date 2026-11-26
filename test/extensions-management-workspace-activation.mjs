import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-management-activation-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ExtensionManagementService } = await import(pathToFileURL(compile('main/extensions/extensionManagement.ts')));
  const { ExtensionWorkspaceActivationStore } = await import(pathToFileURL(compile('main/extensions/extensionWorkspaceActivation.ts')));
  const workspace = id => ({ id, name: id, path: `C:/${id}`, controlRoot: `C:/${id}`, rootsRevision: 1, defaultRootId: 'p1', openedAt: 0,
    roots: [{ id: 'p1', path: `C:/${id}`, label: 'First' }] });
  const changes = [];
  const catalog = {
    get(scope, extensionId, controlRoot) {
      return { scope, extensionId, controlRoot, name: extensionId, surfaceKind: 'sidebar', directory: `C:/extensions/${extensionId}`, fingerprint: `package-extension:${'0'.repeat(64)}`, enabled: true, updatedAt: new Date().toISOString() };
    }
  };
  const activation = new ExtensionWorkspaceActivationStore(path.join(temp, 'workspace-activation.json'));
  const service = new ExtensionManagementService(catalog, () => [workspace('one'), workspace('two')], id => changes.push(id), undefined, undefined, activation);
  await service.setEnabled('one', 'p1', 'global', 'daily-report', false, service.selectionRevision('one'));
  assert.equal(activation.isEnabled({ workspaceId: 'one', scope: 'global', extensionId: 'daily-report' }), false);
  assert.equal(activation.isEnabled({ workspaceId: 'two', scope: 'global', extensionId: 'daily-report' }), true);
  await service.setEnabledAll('one', 'daily-report', true);
  assert.equal(activation.isEnabled({ workspaceId: 'one', scope: 'global', extensionId: 'daily-report' }), true);
  assert.equal(activation.isEnabled({ workspaceId: 'two', scope: 'global', extensionId: 'daily-report' }), true);
  assert.deepEqual(changes.sort(), ['one', 'one', 'two']);
  console.log('extensions-management-workspace-activation: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
