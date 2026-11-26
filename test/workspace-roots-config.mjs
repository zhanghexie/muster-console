/** 多源根配置迁移/重启与管理根稳定性；只访问临时 userData。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-roots-config-'));
try {
  const userData = path.join(tmp, 'data');
  fs.mkdirSync(userData);
  const compile = createSharedCompiler(repo, tmp);
  // createSharedCompiler 会往 tmp/node_modules/electron 写统一 stub；本用例需要可控的
  // getPath 与目录选择器，必须在 helper 之后覆盖回来，否则 config.json 写到别处、
  // 目录选择断言也读不到调用记录。
  const electron = path.join(tmp, 'node_modules/electron');
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', main: 'index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), `export const app = {getPath:()=>${JSON.stringify(userData)}};
    let pick = {canceled:true, filePaths:[]}; export const calls = []; export const setPick = value => {pick=value};
    export const dialog = { showOpenDialog: async options => { calls.push(options); return pick; } }; export default {app, dialog};`);
  const { ConfigManager } = await import(pathToFileURL(compile('main/config.ts')).href);
  const { WorkspaceService } = await import(pathToFileURL(compile('main/workspaces.ts')).href);
  const { requireWorkspace } = await import(pathToFileURL(compile('main/workspacePaths.ts')).href);
  const configFile = path.join(userData, 'config.json');
  const host = path.join(tmp, 'host');
  const shared = path.join(tmp, 'shared-source');
  const hostB = path.join(tmp, 'host-b');
  for (const dir of [host, shared, hostB]) fs.mkdirSync(dir);
  fs.writeFileSync(configFile, JSON.stringify({
    workspace: host, activeWorkspaceId: 'a',
    workspaces: [{ id: 'a', path: host, name: 'old', openedAt: 123, avatar: '🌱', accent: '#abcdef', codeIndex: true, codeIndexRoots: ['src'] }],
    themeByWorkspace: { a: 'light' }, mcpByWorkspace: { a: [] }
  }));
  let manager = new ConfigManager();
  const migrated = manager.get().workspaces[0];
  assert.deepEqual(migrated.roots, [{ id: 'root-a', path: host }]);
  assert.equal(migrated.defaultRootId, 'root-a');
  assert.equal(migrated.controlRoot, host);
  assert.equal(migrated.rootsRevision, 0);
  assert.equal(migrated.openedAt, 123);
  assert.equal(migrated.avatar, '🌱');

  const roots = [{ id: 'root-shared', path: shared, label: '工具' }, ...migrated.roots];
  manager.update({ workspaces: [{ ...migrated, roots, defaultRootId: 'root-shared', rootsRevision: 1 }] });
  assert.equal(manager.get().workspace, shared, 'default cwd changes independently of management folder');
  assert.equal(manager.get().workspaces.length, 1, 'stale old workspace projection must not create a phantom workspace');
  assert.equal(manager.get().workspaces[0].controlRoot, host);
  assert.equal(manager.get().workspaces[0].rootsRevision, 1);
  manager.update({ workspaces: [{ ...manager.get().workspaces[0], rootsRevision: 999 }] });
  assert.equal(manager.get().workspaces[0].rootsRevision, 1, 'caller cannot forge a roots version');
  manager = new ConfigManager();
  assert.deepEqual(manager.get().workspaces[0].roots, roots, 'root IDs and ordering survive restart');
  assert.equal(manager.get().workspaces[0].accent, '#abcdef');
  assert.equal(manager.get().themeByWorkspace.a, 'light');
  assert.equal(manager.get().workspaces[0].codeIndex, undefined, 'retired index toggle is ignored');
  assert.equal(manager.get().workspaces[0].codeIndexRoots, undefined, 'retired index selections are not active configuration');
  manager.update({ workspaces: [manager.get().workspaces[0], {
    id: 'b', name: 'other', path: shared, openedAt: 456, controlRoot: hostB,
    roots: [{ id: 'root-b', path: hostB }, { id: 'shared-b', path: shared }], defaultRootId: 'shared-b'
  }] });
  assert.equal(manager.get().workspaces.length, 2, 'different workspaces can share a default source root');
  assert.equal(manager.get().workspaces[0].rootsRevision, 1, 'unrelated metadata does not advance roots version');
  const alias = path.join(tmp, 'host-alias');
  fs.symlinkSync(host, alias, 'junction');
  const before = manager.get().workspaces[0];
  manager.update({ workspaces: [{ ...before,
    roots: [...before.roots, { id: 'alias', path: alias }], defaultRootId: 'alias'
  }, manager.get().workspaces[1]] });
  assert.equal(manager.get().workspaces[0].roots.length, 2, 'Junction aliases do not duplicate source membership');
  assert.equal(manager.get().workspaces[0].defaultRootId, 'root-a', 'duplicate alias selection retains the canonical stable ID');

  const offline = path.join(tmp, 'unmounted');
  const ws = manager.get().workspaces[0];
  manager.update({ workspaces: [{ ...ws, roots: [...ws.roots, { id: 'offline', path: offline }], defaultRootId: 'offline' }, manager.get().workspaces[1]] });
  manager = new ConfigManager();
  assert.equal(manager.get().workspace, offline);
  assert.equal(manager.get().workspaces[0].controlRoot, host);
  assert.equal(manager.get().workspaces[0].roots.length, 3, 'offline folders stay registered');

  // 外部配置损坏不能丢弃其他设置，也不能把坏根转成另一工作区的合法访问。
  const data = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  data.workspaces[0].defaultRootId = 'deleted-root';
  fs.writeFileSync(configFile, JSON.stringify(data));
  manager = new ConfigManager();
  assert.equal(manager.get().activeWorkspaceId, 'a');
  assert.equal(manager.get().themeByWorkspace.a, 'light');
  assert.match(manager.get().workspaces[0].rootsError, /default source folder/);
  assert.equal(manager.get().workspaces[0].roots.length, 3);
  assert.throws(() => requireWorkspace(manager.get(), 'a'), /default source folder/);
  assert.throws(() => requireWorkspace(manager.get(), 'missing'), /workspace not found/);
  const duplicate = { ...manager.get().workspaces[1], id: 'c' };
  manager.update({ workspaces: [...manager.get().workspaces, duplicate] });
  assert.equal(manager.get().workspaces.length, 3, 'conflicting external registration is preserved for repair');
  assert.match(manager.get().workspaces[2].rootsError, /already used/);
  assert.throws(() => requireWorkspace(manager.get(), 'c'), /already used/);

  // 实际业务入口：排序/默认不动管理根，保存冲突、依赖阻挡与移除不删盘。
  fs.writeFileSync(configFile, JSON.stringify({ workspace: host, activeWorkspaceId: 'old', workspaces: [{ id: 'old', path: host, name: 'old', openedAt: 0 }] }));
  manager = new ConfigManager();
  const service = new WorkspaceService(manager);
  const picker = await import(pathToFileURL(path.join(electron, 'index.mjs')).href);
  assert.equal((await service.pickDirectory()).message, 'cancelled');
  picker.setPick({ canceled: false, filePaths: [hostB, shared] });
  assert.deepEqual(await service.pickDirectory(true), { ok: true, path: hostB, paths: [hostB, shared] });
  assert.deepEqual(picker.calls.at(-1).properties, ['openDirectory', 'multiSelections']);
  assert.deepEqual(await service.pickDirectory(), { ok: true, path: hostB });
  assert.deepEqual(picker.calls.at(-1).properties, ['openDirectory']);
  const opened = await service.open({ roots: [{ id: 'host-b', path: hostB }, { id: 'source', path: shared }], defaultRootId: 'source', name: 'multi' });
  assert.equal(opened.ok, true);
  const id = opened.activeWorkspaceId;
  let active = service.active();
  assert.equal(service.activePath(), shared);
  assert.equal(active.controlRoot, hostB);
  assert.equal(service.updateMeta(id, { roots: [...active.roots].reverse(), expectedRootsRevision: 0 }).ok, true);
  active = service.active();
  assert.equal(active.defaultRootId, 'source');
  assert.equal(active.controlRoot, hostB);
  assert.equal(active.rootsRevision, 1);
  assert.equal(service.updateMeta(id, { roots: active.roots, expectedRootsRevision: 0 }).ok, false, 'stale settings cannot overwrite the new order');
  assert.equal(service.updateMeta(id, { roots: active.roots.filter((r) => r.id !== 'host-b'), expectedRootsRevision: 1 }).ok, false, 'management root cannot be removed');
  assert.equal(service.updateMeta(id, { roots: active.roots.filter((r) => r.id !== 'source'), defaultRootId: 'host-b', expectedRootsRevision: 1 }).ok, false, 'missing dependency guard blocks removal');
  service.setRootRemovalGuard(() => 'active task depends on source');
  assert.equal(service.updateMeta(id, { roots: active.roots.filter((r) => r.id !== 'source'), defaultRootId: 'host-b', expectedRootsRevision: 1 }).message, 'active task depends on source');
  service.setRootRemovalGuard(() => undefined);
  assert.equal(service.updateMeta(id, { roots: active.roots.filter((r) => r.id !== 'source'), defaultRootId: 'host-b', expectedRootsRevision: 1 }).ok, true);
  assert.equal(fs.statSync(shared).isDirectory(), true, 'root removal does not delete the directory');
  assert.equal(service.activePath(), hostB);
  assert.equal((await service.open(hostB)).activeWorkspaceId, id, 'legacy open matches control root after default changes');
  const duplicateHost = await service.open({ roots: [{ id: 'again', path: hostB }], name: 'conflict' });
  assert.equal(duplicateHost.ok, false);
  const revision = service.active().rootsRevision;
  assert.equal(service.close(id).ok, true);
  manager = new ConfigManager();
  assert.equal(manager.get().closedWorkspaces[0].id, id);
  const restarted = new WorkspaceService(manager);
  assert.equal((await restarted.open(hostB)).activeWorkspaceId, id);
  assert.equal(restarted.active().rootsRevision, revision);
  console.log('workspace-roots-config: OK');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
