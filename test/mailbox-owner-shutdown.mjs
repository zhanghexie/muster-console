import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-owner-'));
const compile = createSharedCompiler(process.cwd(), path.join(dir, 'compiled'));
const load = file => import(pathToFileURL(compile(file)).href);
const store = await load('main/metaAgent/messageStore.ts');
const { attachMailboxWakes, flushMailboxWake, requestMailboxWake } = await load('main/messages/wake.ts');
store.setAgentMessagesUserDataDir(dir);
let release, sends = 0, drained = false;
const listeners = new Set();
const target = { id: 'target', runtime: 'pi', lifecycle: 'idle', workspaceId: 'ws' };
const ctx = { workspaces: { list: () => [{ id: 'ws', path: dir }] },
  sessions: { get: () => target, isChatRuntime: () => true, broadcastMessagesChanged() {},
    onLifecycle(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
  agentSessions: { isOpen: () => true, isBusy: () => false, send: () => { sends++; return new Promise(resolve => { release = resolve; }); } } };
let owner;
try {
  await store.appendAgentMessageToStore(dir, 'ws', { from: 'sender', to: 'target', kind: 'notice', text: 'result', ts: Date.now(), receipt: 'stored' });
  owner = attachMailboxWakes(ctx);
  const pending = flushMailboxWake(ctx, 'target', 'ws');
  for (let i = 0; i < 100 && !release; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof release, 'function'); assert.equal(sends, 1);
  owner(); const draining = owner.drain().then(() => { drained = true; });
  assert.equal(listeners.size, 0);
  requestMailboxWake(ctx, 'target', 'ws'); await flushMailboxWake(ctx, 'target', 'ws');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(drained, false, 'drain waits for an already accepted GUI receipt until the GUI owner releases it');
  assert.equal(sends, 1, 'new requests cannot recreate a service after owner stop');
  release({ ok: true }); await pending; await draining;
  assert.equal(drained, true); assert.ok(store.readAgentMessageLedger(dir, 'ws').messages[0].notifiedAt);
  console.log('mailbox-owner-shutdown: stop admission, remove listeners, no resurrection and actual receipt drain passed');
} finally { release?.({ ok: false }); owner?.(); await owner?.drain(); fs.rmSync(dir, { recursive: true, force: true }); }
