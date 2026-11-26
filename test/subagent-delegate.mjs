/** Subagent workspace selection uses the bound parent, before creating resources. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-delegate-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { delegateTask } = await import(pathToFileURL(compile('main/tasks/delegate.ts')).href);
  const parent = { id: 'parent', workspaceId: 'parent-ws', runtime: 'pi' };
  const cfg = { activeWorkspaceId: 'other-ws', defaultRuntime: 'pi', workspaces: [
    { id: 'parent-ws', path: tmp }, { id: 'other-ws', path: tmp }
  ] };
  let reached = 0;
  const ctx = {
    config: { get: () => cfg },
    resolveBubbleWorkspaceId: () => 'other-ws',
    sessions: {
      get: id => id === parent.id ? parent : undefined,
      list: () => [parent],
      isChatRuntime: () => true,
      createTerminal: async () => { reached++; throw new Error('fixture-stop-before-create'); }
    }
  };
  const input = { task: 'read only', parentSessionId: parent.id, isolate: false, skipConcurrencyQueue: true };
  await assert.rejects(() => delegateTask(ctx, { ...input, workspaceId: 'other-ws' }), /同一工作区/);
  assert.equal(reached, 0, '跨区拒绝必须早于建会话');
  await assert.rejects(() => delegateTask(ctx, input), /fixture-stop-before-create/);
  assert.equal(reached, 1, '默认区必须跟父，活动工作区变化不影响派活');
  const { createAgentTerminalSession } = await import(pathToFileURL(compile('main/sessions/createTerminal.ts')).href);
  const { resolveSessionTarget } = await import(pathToFileURL(compile('main/sessions/targets.ts')).href);
  const target = await resolveSessionTarget(cfg, { workspaceId: 'parent-ws' });
  const rows = [parent];
  const creation = { isChatRuntime: () => false, config: ctx.config, sessions: rows, runtimes: { get: () => { parent.archived = true; return { enabled: true }; } } };
  await assert.rejects(() => createAgentTerminalSession(creation, { parentSessionId: parent.id, force: true }, target), /父会话已归档或删除/);
  assert.equal(rows.length, 1, '创建过程中父被归档，最终入表必须拒绝');
  rows.length = 0;
  await assert.rejects(() => createAgentTerminalSession(creation, { parentSessionId: parent.id, force: true }, target), /父会话已归档或删除/);
  console.log('subagent-delegate: workspace guard and parent default passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
