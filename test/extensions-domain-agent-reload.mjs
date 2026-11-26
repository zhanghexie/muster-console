import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-agent-reload-compile'));
const { ExtensionAgentService } = await import(pathToFileURL(compile('main/extensions/extensionAgentService.ts')).href);

const sessions = new Map();
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-agent-workspace-'));
const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-agent-package-'));
const createOptions = [];
const guiModes = [];
let created = 0;
let opened = 0;
const ctx = {
  config: { get() { return { workspaces: [{ id: 'ws', path: workspaceRoot, roots: [{ id: 'root-a', path: workspaceRoot }], defaultRootId: 'root-a' }] }; } },
  sessions: {
    async createTerminal(options) {
      createOptions.push(options);
      const session = { id: `session-${++created}`, archived: false };
      sessions.set(session.id, session);
      return session;
    },
    get(id) { return sessions.get(id); },
    setArchived(id, archived) {
      const session = sessions.get(id);
      if (!session) throw new Error('session missing');
      session.archived = archived;
      return session;
    },
    updateGuiMode(id, mode) { guiModes.push({ id, mode }); }
  },
  agentSessions: {
    onPush() { return () => {}; },
    open() { opened += 1; },
    async waitUntilOpen() {},
    async release(id) { sessions.get(id).archived = true; }
  }
};
const service = new ExtensionAgentService(ctx, packageRoot, {});
service.extensionDomains.register('bookshelf', { create: async () => ({
  async getSnapshot() { return { version: 1, state: {}, availableCommands: [], capturedAt: new Date().toISOString() }; },
  async query() { return {}; },
  async execute() { return { ok: true, version: 1 }; },
  subscribe() { return () => {}; },
  async close() {}
}) });

const manifest = {
  id: 'bookshelf',
  name: '书架',
  scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html' },
  domain: { entry: 'domain.mjs', queries: [], commands: [], events: [] },
  agent: { profile: 'scheduler-pi', skills: [], mcp: [] },
  data: { workspace: true, shared: false },
  permissions: ['agent.state']
};
const base = { extensionId: 'bookshelf', extensionInstanceId: 'ws:bookshelf:main', workspaceId: 'ws', surfaceId: 'main' };
const first = await service.openExtension({ ...base, packageFingerprint: `package-extension:${'a'.repeat(64)}` }, manifest, packageRoot);
await service.releaseExtension({ ...base, packageFingerprint: `package-extension:${'a'.repeat(64)}` });
const second = await service.openExtension({ ...base, packageFingerprint: `package-extension:${'b'.repeat(64)}` }, manifest, packageRoot);

assert.equal(first.sessionId, second.sessionId, 'package reload preserves the Pi session transcript');
assert.equal(created, 1, 'package reload does not create a second hidden session');
assert.equal(createOptions[0].cwd, workspaceRoot, 'Pi cwd stays inside the registered workspace source root');
assert.equal(createOptions[0].rootId, 'root-a', 'Pi session is bound to the registered source root');
assert.deepEqual(guiModes, [{ id: 'session-1', mode: 'standard' }], 'extension agent sessions default to the standard permission level');
assert.equal(opened, 1, 'the retained session is reopened after the new runtime is mounted');
assert.equal(service.extensionBindings.get('ws:bookshelf:ws:bookshelf:main:main').identity.packageFingerprint, `package-extension:${'b'.repeat(64)}`);
const standalone = { ...manifest, agent: undefined, permissions: ['data'] };
const standaloneIdentity = { ...base, packageFingerprint: `package-extension:${'c'.repeat(64)}` };
assert.deepEqual(await Promise.all([
  service.openPanel(standaloneIdentity, standalone, packageRoot),
  service.openPanel(standaloneIdentity, standalone, packageRoot)
]), [undefined, undefined]);
assert.equal(created, 1, 'opening a standalone panel never creates a hidden Pi session');
assert.equal(sessions.get(first.sessionId).archived, true, 'removing the Agent archives the previous session');
assert.equal(service.extensionToolsForSession(first.sessionId).length, 0);
assert.equal((await service.extensionSnapshot(standaloneIdentity, standalone, undefined)).version, 1);
service.extensionData(standaloneIdentity, standalone, undefined, 'data.write', ['note.txt', 'persisted']);
const brokerContext = { signal: new AbortController().signal };
assert.deepEqual(await service.brokerExtensionDomain(standaloneIdentity, standalone, 'data.read', ['note.txt'], brokerContext), { content: 'persisted' });
await assert.rejects(() => service.openExtension(standaloneIdentity, standalone, packageRoot), /does not declare a host Agent/);
await service.closeExtension(standaloneIdentity);
await assert.rejects(() => service.extensionSnapshot(standaloneIdentity, standalone, undefined), /runtime identity is invalid/);
await service.close();
fs.rmSync(workspaceRoot, { recursive: true, force: true });
fs.rmSync(packageRoot, { recursive: true, force: true });
console.log('extensions-agent-reload: ok');


