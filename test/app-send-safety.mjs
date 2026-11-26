import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-send-safety-'));
const compile = createSharedCompiler(process.cwd(), path.join(directory, 'compiled'));
const { authorizeAppSend } = await import(pathToFileURL(compile('main/agentApps/sendAuthorization.ts')));
const { createSafetyService } = await import(pathToFileURL(compile('main/safety/service.ts')));
const { AgentAppsService } = await import(pathToFileURL(compile('main/agentApps/service.ts')));
let reviews = 0, humans = 0, sends = 0;
const safety = createSafetyService({ userDataPath: directory, reviewer: async () => { reviews++; throw new Error('Routine sends must not invoke the reviewer'); } });
const ctx = { safety, resolveBubbleWorkspaceId: () => 'w', ui: { confirm: async () => { humans++; return { confirmed: false }; } } };
const service = new AgentAppsService({ root: path.join(directory, 'apps'), workspaces: () => ['w'], emit() {}, encrypt: x => x, decrypt: x => x,
  confirmSend: (ws, name, values, signal) => authorizeAppSend(ctx, ws, name, values, signal), deliver: async () => ({ muted: true }),
  connectors: { send: async () => { sends++; return { messageId: `out-${sends}` }; }, test: async () => {}, sync: async () => ({ records: [], cursor: {} }), feed: async () => [] }
});
ctx.agentApps = service;
try {
  service.store.transact('w', state => state.connections.push({ id: 'chat', kind: 'feishu', name: 'Direct', chatId: 'oc_direct', identity: 'bot', profile: 'dedicated', enabled: true, revision: 1, grants: { messages: ['messages.read', 'messages.send'] } }));
  const call = { appId: 'messages', commandId: 'send', params: { accountId: 'chat', values: { body: 'ordinary message' } }, requestId: 'send-once' };
  await service.execute('w', call, { kind: 'agent' });
  await service.execute('w', call, { kind: 'agent' });
  assert.equal(sends, 1); assert.equal(reviews, 0); assert.equal(humans, 0);
  service.store.transact('w', state => { state.connections[0].grants.messages = ['messages.read']; });
  await assert.rejects(() => service.execute('w', { ...call, requestId: 'denied' }, { kind: 'agent' }));
  assert.equal(sends, 1); assert.equal(reviews, 0); assert.equal(humans, 0);
  const cancelled = new AbortController(); cancelled.abort();
  assert.equal(await authorizeAppSend(ctx, 'w', 'Mail', { to: 'a@example.com', body: 'ordinary' }, cancelled.signal), false);
  assert.equal(await authorizeAppSend(ctx, 'w', 'Mail', { to: 'a@example.com', body: 'ordinary' }), true);
  assert.equal(reviews, 0); assert.equal(humans, 0);
  assert.deepEqual(safety.snapshot('w').records, []);
  assert.deepEqual(safety.snapshot('w').messages, []);
  console.log('app send safety: real service dispatch, no routine reviews, permission and idempotency guards passed');
} finally { service.stop(); service.store.close?.(); safety.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
