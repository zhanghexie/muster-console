import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-caller-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const read = rel => import(pathToFileURL(compile(rel)).href);
  const { resolveExtensionToolCaller, runAsExtensionSchedulerCaller } = await read('main/extensions/extensionToolCaller.ts');
  const { runAsAgentSession, runAsSchedulerTool } = await read('main/agent/agentScope.ts');
  const { captureWorkspaceExecutionContext } = await read('main/workspaceExecutionContext.ts');
  const root = path.join(temp, 'main'), project = path.join(temp, 'project'), replacement = path.join(temp, 'replacement');
  for (const directory of [root, project, replacement]) fs.mkdirSync(directory);
  const workspace = { id: 'a', name: 'A', path: root, controlRoot: root, rootsRevision: 1, roots: [{ id: 'a1', path: root }, { id: 'a2', path: project }], defaultRootId: 'a1', openedAt: 0 };
  const session = { id: 'one', workspaceId: 'a', cwd: project, sourceRoot: { rootId: 'a2', path: project, cwd: project } };
  const config = { workspaces: [workspace], activeWorkspaceId: 'a' };
  const ctx = { config: { get: () => config }, sessions: { peek: id => id === 'one' ? session : undefined, list: () => [session] } };
  assert.throws(() => resolveExtensionToolCaller(ctx), /identity is unavailable/);
  const caller = await runAsAgentSession('one', async () => resolveExtensionToolCaller(ctx));
  assert.deepEqual(caller, { workspaceId: 'a', sourceRootId: 'a2', actor: 'session:one' });
  await assert.rejects(runAsAgentSession('missing', async () => resolveExtensionToolCaller(ctx)), /no longer exists/);
  const captured = captureWorkspaceExecutionContext(config, session, [session]);
  const invoke = () => runAsExtensionSchedulerCaller(captured, 'task:one', () => runAsSchedulerTool(async () => resolveExtensionToolCaller(ctx)));
  assert.deepEqual(await invoke(), { workspaceId: 'a', sourceRootId: 'a2', actor: 'scheduler:task:one' });
  assert.throws(() => runAsExtensionSchedulerCaller(captured, 'task:one', () => resolveExtensionToolCaller(ctx)), /identity is unavailable/);
  workspace.roots[1].path = replacement;
  await assert.rejects(invoke(), /source folder changed/);
  await assert.rejects(runAsAgentSession('one', async () => resolveExtensionToolCaller(ctx)), /source folder changed/);
  console.log('extensions-tool-caller: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
