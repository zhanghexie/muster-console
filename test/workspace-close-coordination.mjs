import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-close-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const electron = path.join(temp, 'node_modules/electron'); fs.mkdirSync(electron, { recursive: true });
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', type: 'module', exports: './index.mjs' }));
  fs.writeFileSync(path.join(electron, 'index.mjs'), 'export const dialog = {};\n');
  const { WorkspaceService } = await import(pathToFileURL(compile('main/workspaces.ts')));
  const { closeWorkspaceWithSessions, closeWorkspaceCoordinated } = await import(pathToFileURL(compile('main/workspaceClose.ts')));
  const initial = () => ({ activeWorkspaceId: 'one', workspace: path.join(temp, 'one'), workspaces: [
    { id: 'one', path: path.join(temp, 'one') }, { id: 'two', path: path.join(temp, 'two') } ] });
  for (const workspace of initial().workspaces) fs.mkdirSync(workspace.path);
  let state = initial(), calls = [];
  const config = { get: () => state, update: patch => { calls.push('config'); state = { ...state, ...patch }; } };
  const workspaces = new WorkspaceService(config);
  const ctx = { workspaces, sessions: { removeByWorkspace: () => { assert.fail('Closing a workspace must preserve sessions'); } },
    desktopEpochs: { endScheduler: id => { calls.push(`epoch:${id}`); } } };
  assert.equal(closeWorkspaceWithSessions(ctx, 'missing').ok, false); assert.deepEqual(calls, []);
  ctx.desktopEpochs.endScheduler = () => { throw new Error('epoch storage failed'); };
  assert.match(closeWorkspaceWithSessions(ctx, 'one').message, /epoch storage failed/);
  assert.equal(state.workspaces.length, 2); assert.deepEqual(calls, []);
  ctx.desktopEpochs.endScheduler = id => { calls.push(`epoch:${id}`); };
  assert.equal(closeWorkspaceWithSessions(ctx, 'one').ok, true);
  assert.deepEqual(calls, ['epoch:one', 'config']);
  assert.equal(state.activeWorkspaceId, 'two');
  assert.equal(state.closedWorkspaces[0].id, 'one');
  // 允许删到零个：主进程返回空活动区，渲染层据此常驻新建引导面板。
  calls = []; const last = closeWorkspaceWithSessions(ctx, 'two');
  assert.equal(last.ok, true, '最后一个工作区可以关闭');
  assert.deepEqual(calls, ['epoch:two', 'config']);
  assert.equal(state.workspaces.length, 0);
  assert.equal(state.activeWorkspaceId, '');
  assert.equal(last.activeWorkspaceId, '', '关闭结果必须带空活动区，不能沿用旧 id');
  assert.deepEqual(last.workspaces, []);
  state = JSON.parse(JSON.stringify(state));
  assert.equal((await new WorkspaceService(config).open(path.join(temp, 'one'))).activeWorkspaceId, 'one');
  assert.equal(state.closedWorkspaces.length, 1, '重开只移除该工作区的关闭记录');
  assert.equal(state.closedWorkspaces[0].id, 'two');
  state = initial(); calls = [];
  const prepare = async () => { calls.push('prepare'); return { commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback') }; };
  assert.equal((await closeWorkspaceCoordinated(ctx, 'missing', prepare)).ok, false); assert.deepEqual(calls, []);
  assert.equal((await closeWorkspaceCoordinated(ctx, 'one', async () => { throw new Error('flush failed'); })).ok, false);
  assert.equal(state.workspaces.length, 2); assert.deepEqual(calls, []);
  ctx.desktopEpochs.endScheduler = id => { calls.push(`epoch:${id}`); throw new Error('epoch storage failed'); };
  assert.equal((await closeWorkspaceCoordinated(ctx, 'one', prepare)).ok, false);
  assert.deepEqual(calls, ['prepare', 'epoch:one', 'rollback']); assert.equal(state.workspaces.length, 2);
  calls = []; ctx.desktopEpochs.endScheduler = id => { calls.push(`epoch:${id}`); };
  assert.equal((await closeWorkspaceCoordinated(ctx, 'one', prepare)).ok, true);
  assert.deepEqual(calls, ['prepare', 'epoch:one', 'config', 'commit']);
  state = initial(); calls = [];
  const result = await closeWorkspaceCoordinated(ctx, 'one', async () => ({ commit: async () => { throw new Error('cleanup failed'); }, rollback: async () => {} }));
  assert.equal(result.ok, false); assert.match(result.message, /closed.*cleanup failed/i);
  assert.equal(state.workspaces.length, 1);
  state = initial(); calls = [];
  const changed = await closeWorkspaceCoordinated(ctx, 'one', async () => {
    state = { ...state, workspaces: state.workspaces.filter(item => item.id !== 'one') };
    return { commit: async () => calls.push('commit'), rollback: async () => calls.push('rollback') };
  });
  assert.equal(changed.ok, false); assert.deepEqual(calls, ['rollback']);
  state = initial(); calls = []; ctx.desktopEpochs.endScheduler = () => { throw new Error('epoch storage failed'); };
  const rollbackFailed = await closeWorkspaceCoordinated(ctx, 'one', async () => ({ commit: async () => {}, rollback: async () => { throw new Error('restore failed'); } }));
  assert.equal(rollbackFailed.ok, false); assert.match(rollbackFailed.message, /rollback failed.*restore failed/i);
  state = initial(); calls = [];
  const staleWindow = await closeWorkspaceCoordinated(ctx, 'one', prepare, () => { throw new Error('renderer changed'); });
  assert.equal(staleWindow.ok, false); assert.match(staleWindow.message, /renderer changed/);
  assert.deepEqual(calls, ['prepare', 'rollback']); assert.equal(state.workspaces.length, 2);
  console.log('workspace close: preserves the registration and session ownership, supports reopening, and rolls back failed preparation');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
