import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-management-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { ExtensionManagementService } = await import(pathToFileURL(compile('main/extensions/extensionManagement.ts')));
  const workspace = { id: 'a', name: 'A', path: 'C:/A', controlRoot: 'C:/A', rootsRevision: 1, defaultRootId: 'p1', openedAt: 0,
    roots: [{ id: 'p1', path: 'C:/A', label: 'First' }, { id: 'p2', path: 'C:/B', label: 'Second' }] };
  const changes = [], enabled = [];
  const catalog = { setEnabled(input) { enabled.push(input); return Promise.resolve(input); } };
  const service = new ExtensionManagementService(catalog, () => [workspace], workspaceId => changes.push(workspaceId));
  assert.equal(service.snapshot('a').sourceRootId, 'p1');
  assert.deepEqual(service.snapshot('a').projects.map(item => item.label), ['First', 'Second']);
  const selected = service.select('a', 'p2');
  assert.equal(selected.sourceRootId, 'p2');
  assert.deepEqual(changes, ['a']);
  await assert.rejects(() => service.setEnabled('a', 'p1', 'project', 'dev', false, selected.selectionRevision), /selected project changed/i);
  await service.setEnabled('a', 'p2', 'project', 'dev', false, selected.selectionRevision);
  assert.deepEqual(enabled, [{ scope: 'project', extensionId: 'dev', controlRoot: 'C:/B', enabled: false }]);
  workspace.roots[1].path = 'C:/Other';
  assert.throws(() => service.rootId('a'), /path changed/);

  const fingerprint = `package-extension:${'a'.repeat(64)}`;
  const directory = path.join(temp, 'global', 'dev');
  let active = true;
  const events = [];
  const removal = new ExtensionManagementService({
    get: () => ({ enabled: active }),
    syncGlobal: async () => { events.push('sync'); },
  }, () => [workspace], id => events.push(id));
  const operations = {
    layout: { discover: async () => ({ descriptor: { directory }, fingerprint }) },
    close: async () => { events.push('close'); },
    trash: async target => { assert.equal(target, directory); events.push('trash'); },
  };
  await assert.rejects(removal.uninstallGlobal('a', 'daily-report', fingerprint, operations), /内置扩展/);
  await assert.rejects(removal.uninstallGlobal('a', 'dev', fingerprint, operations), /先关闭/);
  assert.deepEqual(events, []);
  active = false;
  await assert.rejects(removal.uninstallGlobal('a', 'dev', 'stale', operations), /内容已变化/);
  assert.deepEqual(events.splice(0), ['close']);
  await assert.rejects(removal.uninstallGlobal('a', 'dev', fingerprint, {
    ...operations, trash: async () => { throw new Error('system trash unavailable'); },
  }), /检查回收站和目录权限/);
  assert.deepEqual(events.splice(0), ['close']);
  await removal.uninstallGlobal('a', 'dev', fingerprint, operations);
  assert.deepEqual(events, ['close', 'trash', 'sync', 'a']);
  console.log('extensions-management: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
