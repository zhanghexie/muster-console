import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { FileSessionManager } from '../../src/main/runtimeKernel/sessionManager';
import { SchedulerSessionAdapter } from '../../src/main/runtimeKernel/schedulerSession';
import { GuiSessionEventAdapter } from '../../src/main/runtimeKernel/guiSession';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function create() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-manager-')); roots.push(root); return new FileSessionManager(root); }
const event = { eventId: 'e1', sessionId: 's1', seq: 0, type: 'message', schemaVersion: 1, createdAt: 1, payload: { text: 'saved' } };

it('drains accepted appends on release, rejects late work and reopens durable events', async () => {
  const manager = create();
  const handle = await manager.create('s1');
  expect(await manager.open('s1')).toBe(handle);
  let live = 0;
  handle.subscribeLive(() => live++);
  const pending = handle.append(event);
  await manager.release('s1');
  await pending;
  expect(live).toBe(0);
  await expect(handle.append(event)).rejects.toThrow('released');
  expect(manager.list()).toEqual([]);
  const reopened = await manager.open('s1');
  expect(await reopened.readRange({ limit: 10 })).toMatchObject([{ seq: 1, payload: { text: 'saved' } }]);
  await manager.dispose();
  await expect(reopened.readRange({ limit: 1 })).rejects.toThrow('released');
  await expect(manager.open('s1')).rejects.toThrow('disposed');
});

it('protects existing files from create and rejects path traversal', async () => {
  const manager = create();
  await manager.create('s1');
  await manager.release('s1');
  await expect(manager.create('s1')).rejects.toMatchObject({ code: 'EEXIST' });
  await expect(manager.open('../escape')).rejects.toThrow('Invalid session');
  const stopping = manager.dispose();
  expect(manager.dispose()).toBe(stopping);
  await stopping;
});

it('keeps GUI writers in the manager while scheduler SQLite is session-owned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-manager-')); roots.push(root);
  const factory = new FileSessionManager(path.join(root, 'plugin'), {
    scheduler: path.join(root, 'scheduler-sessions'), gui: path.join(root, 'agent-session-events')
  });
  const scheduler = new SchedulerSessionAdapter(root, 'ws', { display: [], api: [] }, factory);
  scheduler.recordMessage({ id: 'human', role: 'user', content: 'request', createdAt: 1 });
  const initial = { messages: [], lastUsage: null, injections: [], compactions: [] };
  const gui = new GuiSessionEventAdapter(root, 'gui', initial, () => false, { factory });
  gui.persistChanges([{ id: 'reply', role: 'assistant', parts: [{ kind: 'text', text: 'answer' }], ts: 1 }], initial);
  // Reopening a projection over the shared writer includes unflushed events.
  const reread = new GuiSessionEventAdapter(root, 'gui', initial, () => false, { factory });
  expect(reread.snapshot().messages[0].id).toBe('reply');
  expect([...factory.list()].sort()).toEqual(['gui:gui']);
  await factory.dispose();
  expect(() => scheduler.recordMessage({ id: 'late', role: 'user', content: '', createdAt: 2 })).not.toThrow();
  scheduler.close();
  const reopenedScheduler = new SchedulerSessionAdapter(root, 'ws', { display: [], api: [] });
  expect(reopenedScheduler.snapshot().display[0].id).toBe('human');
  reopenedScheduler.close();
  expect(new GuiSessionEventAdapter(root, 'gui', initial, () => false).snapshot().messages[0].id).toBe('reply');
});
