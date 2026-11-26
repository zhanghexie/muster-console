import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-domain-daily-domain-'));
const workspaceRoot = path.join(userData, 'workspace');
fs.mkdirSync(workspaceRoot, { recursive: true });
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-daily-domain-compile'));
const { ExtensionAgentService } = await import(pathToFileURL(compile('main/extensions/extensionAgentService.ts')).href);
const { createDomainRuntime } = await import(pathToFileURL(path.join(repo, 'resources/extensions/daily-report/domain.mjs')).href);
const ctx = {
  config: { get: () => ({ workspaces: [{ id: 'ws', name: '工作区', path: workspaceRoot, roots: [{ id: 'root', path: workspaceRoot }], defaultRootId: 'root' }] }) },
  notify: { push(value) { ctx.notifications.push(value); } },
  notifications: [],
  agentSessions: { onPush() { return () => {}; } }
};
const service = new ExtensionAgentService(ctx, userData, {});
const identity = { extensionId: 'daily-report', extensionInstanceId: 'ws:daily-report:main', workspaceId: 'ws', sourceRootId: 'root', packageFingerprint: `package-extension:${'a'.repeat(64)}`, surfaceId: 'main' };
const manifest = { id: 'daily-report', name: '工作日报', scope: 'global', surface: { kind: 'sidebar', entry: 'ui/panel.html' }, domain: { entry: 'domain.mjs', queries: ['todos.open'], commands: ['todo.create'], events: ['state.changed'] }, agent: { profile: 'scheduler-pi', skills: [], mcp: [] }, data: { workspace: true, shared: false }, permissions: ['data', 'agent.state', 'agent.commands', 'hostTools'] };
const context = actor => ({ identity, manifest, actor, requestId: actor === 'agent' ? 'agent' : 'human', signal: new AbortController().signal });
const runtime = createDomainRuntime({ identity, broker: (method, args, callContext) => {
  if (method === 'data.read' || method === 'data.write' || method === 'data.list') return service.extensionData(identity, manifest, 'session', method, args);
  if (method === 'journal.list' || method === 'journal.read') return service.extensionJournal(identity, manifest, 'session', method, args);
  if (method === 'notify') return service.extensionNotify(identity, manifest, 'session', args[0]);
  throw new Error(`unexpected broker call: ${method}`);
} });
service.extensionBindings.set('ws:daily-report:ws:daily-report:main:main', { sessionId: 'session', runtime: {}, manifest, identity });
service.extensionSessions.set('session', { runtime: {}, manifest, identity });
const events = [];
runtime.subscribe(event => events.push(event));
const before = await runtime.getSnapshot(context('human'));
const result = await runtime.execute('todo.create', { text: '迁移日报' }, { ...context('human'), requestId: 'create' });
assert.equal(result.ok, true);
assert.equal(result.version, before.version + 1);
assert.equal(events[0].extensionId, 'daily-report');
assert.equal(events[0].extensionInstanceId, identity.extensionInstanceId);
const open = await runtime.query('todos.open', {}, { ...context('agent'), requestId: 'open' });
assert.ok(open.todos.some(todo => todo.text === '迁移日报'));
await service.extensionData(identity, manifest, 'session', 'data.write', ['ui.json', '{"ok":true}']);
assert.deepEqual(await service.extensionData(identity, manifest, 'session', 'data.read', ['ui.json']), { content: '{"ok":true}' });
assert.equal(service.extensionNotify(identity, manifest, 'session', '日报已更新'), true);
assert.equal(ctx.notifications[0].text, '日报已更新');
console.log('extensions-daily-domain: ok');


