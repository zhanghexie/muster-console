import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'metaagent-cli-host-'));
const compile = createSharedCompiler(root, temp);
const hostFile = compile('main/capabilities/hosts/cliRuns.ts');
// Replace only persistence I/O in the emitted fixture. Identity, workspace
// resolution, readiness checks and handlers execute the production code.
const { cliRunsHost } = await import(pathToFileURL(hostFile));
const { bindCliRuns } = await import(pathToFileURL(compile('main/cliRuns/runtimeRef.ts')));
const { runAsAgentWorkspace, runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
const { CliRunStore } = await import(pathToFileURL(compile('main/cliRuns/runtime.ts')));
const { attachEventRelay, onWebEventBroadcast } = await import(pathToFileURL(compile('main/webAccess/relay.ts')));
try {
  const desktop = [], remote = [];
  const fakeWindow = { webContents: { send: (channel, payload) => desktop.push([channel, payload]) } };
  const off = onWebEventBroadcast(channel => remote.push(channel)); attachEventRelay(fakeWindow);
  fakeWindow.webContents.send('cli:openRun', { workspaceId: 'ws-a', runId: 'test' });
  assert.equal(desktop.length, 1); assert.deepEqual(remote, [], 'local open does not navigate connected Web clients');
  fakeWindow.webContents.send('ui:confirm', { requestId: 'local', localOnly: true, detail: 'private screenshot' });
  assert.deepEqual(remote, [], 'local-only confirmations never reach remote Web clients');
  fakeWindow.webContents.send('ui:confirm', { requestId: 'regular', detail: 'ordinary confirmation' });
  fakeWindow.webContents.send('sessions:reveal', { sessionId: 'worker-a' }); assert.deepEqual(remote, ['ui:confirm', 'sessions:reveal']); off();
  const store = new CliRunStore(path.join(temp, 'runs'));
  const run = store.submit('ws-a', 'host tools fixture');
  store.change(run.runId, draft => { draft.pending = []; draft.state = 'running'; draft.workers = [{ taskId: 'task-a', sessionId: 'worker-a' }]; }, 'host', 'fixture ready');
  const ctx = { config: { get: () => ({ activeWorkspaceId: 'ws-a', workspaces: [{ id: 'ws-a', path: temp, roots: [{ id: 'a', path: temp }], defaultRootId: 'a', controlRootId: 'a' }] }) }, sessions: { get: () => session } };
  let session = { id: 'worker-a', workspaceId: 'ws-a', meta: {creationKey:'cli:task-a'}, phase:{value:'idle'}, lifecycle: 'idle' };
  bindCliRuns({ store, workspace: id => { assert.equal(id, 'ws-a'); } });
  const args = { runId: run.runId, summary: 'done', artifacts: [], verification: 'fixture only' };
  assert.throws(() => cliRunsHost['runs.get'](ctx, args), /scheduler identity/);
  assert.throws(() => runAsAgentWorkspace('ws-a', () => cliRunsHost['runs.get'](ctx, args)), /scheduler identity/);
  assert.throws(() => runAsAgentWorkspace('ws-b', () => runAsSchedulerTool(() => cliRunsHost['runs.get'](ctx, args))), /scheduler identity/);
  const call = () => runAsAgentWorkspace('ws-a', () => runAsSchedulerTool(() => cliRunsHost['runs.deliver'](ctx, args)));
  assert.throws(call, /still executing/);
  session.phase.value = 'needs_you'; session.lifecycle = 'working';
  assert.throws(call, /still executing/);
  session.lifecycle = 'idle'; session.meta.creationKey = 'cli:another-task';
  assert.throws(call, /ownership changed/);
  session.meta.creationKey = 'cli:task-a';
  assert.equal(call().state, 'delivered');
  console.log('CLI host tools: scheduler-only identity, workspace isolation, worker readiness and ownership passed');
} finally { bindCliRuns(null); delete globalThis.__cliTasks; assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(temp, { recursive: true, force: true }); }
