import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-host-tools-'));
try {
  const compile = createSharedCompiler(repo, path.join(temp, 'compiled'));
  const { prepareExtensionHostToolCall, resolveExtensionHostToolTarget } = await import(pathToFileURL(compile('main/extensions/extensionHostTool.ts')));
  let valid = true;
  const context = { workspaceId: 'a', sourceRootId: 'project-a', rootsRevision: 7, sourceRoot: 'bound-root', manifest: { permissions: ['hostTools'] }, assertCurrent() { if (!valid) throw new Error('stale'); } };
  const sessions = reference => ({ 'a-session': { id: 'a-session', workspaceId: 'a' }, 'b-session': { id: 'b-session', workspaceId: 'b' } })[reference];
  const call = (name, args) => prepareExtensionHostToolCall(context, name, args, sessions);
  assert.deepEqual(call('host.sessions.create', { name: 'test', isolation: 'shared' }), { name: 'test', isolation: 'shared', workspaceId: 'a', rootId: 'project-a', rootsRevision: 7, cwd: 'bound-root' });
  assert.equal(call('host.sessions.create', { isolation: 'isolated', isolationGroups: [{ rootId: 'project-a', relativePath: '', repoSet: [] }] }).rootId, 'project-a');
  assert.throws(() => call('host.sessions.create', { isolation: 'shared', workspaceId: 'b' }), /outside/);
  assert.throws(() => call('host.sessions.create', { isolation: 'shared', cwd: 'other' }), /bound project/);
  assert.throws(() => call('host.sessions.create', { isolation: 'isolated', isolationGroups: [{ rootId: 'other' }] }), /bound project/);
  assert.throws(() => call('host.sessions.create', { isolation: 'shared', asSubagent: true }), /bound project/);
  assert.equal(call('host.mail.send', { to: 'a-session', text: 'hello' }).to, 'a-session');
  assert.throws(() => call('host.mail.send', { to: 'b-session', text: 'no' }), /outside/);
  assert.throws(() => call('host.mail.send', { to: 'a-session', text: 'no', interrupt: true }), /interrupt/);
  assert.throws(() => call('host.sessions.select', { sessionId: 'b-session' }), /outside/);
  assert.equal(call('host.sessions.observe', {}).workspaceId, 'a');
  assert.throws(() => call('host.sessions.observe', { workspaceId: '*' }), /outside/);
  assert.throws(() => call('host.sessions.observe', { sessionId: 'orchestrator:b' }), /outside/);
  assert.equal(call('host.runtimes.run', { action: 'preflight', params: {} }).action, 'preflight');
  assert.throws(() => call('host.runtimes.run', { action: 'update', params: {} }), /only list or preflight/);
  assert.throws(() => call('host.runtimes.run', { action: 'list', params: { __actorSessionId: 'forged' } }), /caller identity/);
  assert.equal(resolveExtensionHostToolTarget('host.runtimes.run', { action: 'list', params: {} }).name, 'runtimes.list');
  assert.throws(() => resolveExtensionHostToolTarget('host.runtimes.run', { action: 'update', params: {} }));
  assert.throws(() => call('host.runtimes.run', { action: 'list', params: {}, __actorSessionId: 'a-session' }), /caller identity/);
  assert.equal(call('host.terminal.write', { sessionId: 'a-session', text: 'hello' }).sessionId, 'a-session');
  assert.throws(() => call('host.terminal.write', { sessionId: 'b-session', text: 'hello' }), /outside/);
  assert.throws(() => call('host.terminal.create', { cwd: 'other' }), /bound project/);
  assert.deepEqual(call('host.tasks.render', { action: 'start', url: 'file:///tmp/demo.html', times: [0, 100], width: 640, height: 360 }), {
    action: 'start', url: 'file:///tmp/demo.html', times: [0, 100], width: 640, height: 360,
    workspaceId: 'a', __browserOwner: { workspaceId: 'a' }
  });
  assert.throws(() => call('host.tasks.render', { action: 'status' }), /requires renderId/);
  assert.equal(call('host.tasks.render', { action: 'status', jobId: 'r1' }).renderId, 'r1');
  assert.throws(() => call('host.tasks.render', { action: 'start', workspaceId: 'b', url: 'file:///tmp/demo.html' }), /outside/);
  assert.equal(resolveExtensionHostToolTarget('host.tasks.render', { action: 'status', renderId: 'r1' }).name, 'tasks.render');
  assert.throws(() => call('host.terminal.capture', {}), /did not declare/);
  context.manifest.permissions = [];
  assert.throws(() => call('host.runtimes.run', { action: 'list', params: {} }), /did not declare/);
  valid = false; assert.throws(() => call('host.runtimes.run', { action: 'list', params: {} }), /stale/);
  console.log('extensions-host-tools: ok');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
