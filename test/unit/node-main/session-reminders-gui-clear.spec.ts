import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/main/context';
import type { HostCore } from '../../../src/main/agentSession/host/internal';
import { SessionReminderStore } from '../../../src/main/sessionReminders/store';

const state = vi.hoisted(() => ({ directory: '', push: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }));
vi.mock('../../../src/main/agentSession/host/base', () => ({
  applyInjectQueueChange: vi.fn(), getDriver: vi.fn(), log: vi.fn(), persistEntry: vi.fn(),
  push: state.push, syncEntry: vi.fn(), applySignal: vi.fn(), cancelStreamingPersist: vi.fn()
}));
vi.mock('../../../src/main/agentSession/host/approvals', () => ({ rejectSubagentApprovalsFor: vi.fn() }));
vi.mock('../../../src/main/agentSession/host/lifecycle', () => ({
  purgeEngine: vi.fn(async () => {}),
  // sessionOps.clear 现在先经 materializeForExecution 取 entry；
  // 夹具的 entries 已直接给出可用 entry，这里保持等价的最小实现。
  materializeForExecution: (host: { entries: Map<string, unknown> }, id: string) => host.entries.get(id)
}));
vi.mock('../../../src/main/agentSession/host/messaging', () => ({ abort: vi.fn(async () => {}) }));
vi.mock('../../../src/main/agentSession/host/workspaceContext', () => ({ endWorkspaceContext: vi.fn() }));
vi.mock('../../../src/main/agentSession/host/messagesVersion', () => ({ advanceGuiMessagesVersion: vi.fn() }));
vi.mock('../../../src/main/agentSession/host/retirement', () => ({
  ConnectionCleanupError: class extends Error {}, markRetirementFailure: vi.fn(), retireConnection: vi.fn(),
  retirePendingConnection: vi.fn(), retirementBarrier: vi.fn(async () => {})
}));
vi.mock('../../../src/main/agentSession/host/connection', () => ({ ensureConnection: vi.fn() }));
import { clear } from '../../../src/main/agentSession/host/sessionOps';
import { addSessionReminder, closeSessionReminderStore, listSessionReminders } from '../../../src/main/sessionReminders/service';

beforeAll(() => { state.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-clear-reminders-')); });
afterAll(() => {
  closeSessionReminderStore();
  if (path.dirname(state.directory) !== os.tmpdir() || !path.basename(state.directory).startsWith('gui-clear-reminders-')) throw new Error('Unsafe cleanup');
  fs.rmSync(state.directory, { recursive: true, force: true });
});

function fixture() {
  const send = vi.fn();
  const rows = new Map([['gui', { id: 'gui' }], ['other', { id: 'other' }]]);
  const ctx = {
    sessions: { get: (id: string) => rows.get(id), resetRuntimeHandleStrict: async (_id: string, validate: () => void) => validate() },
    getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } })
  } as unknown as AppContext;
  const entry = { sessionId: 'gui', closed: false, clearing: false, forking: false, messages: [], queue: [], injections: [] };
  const store = { savePendingFork: vi.fn(), clearDataStrict: vi.fn(async (_id: string, validate: () => void) => validate()),
    clearPendingFork: vi.fn(), retain: vi.fn(), release: vi.fn() };
  const host = { ctx, entries: new Map([['gui', entry]]), store } as unknown as HostCore;
  return { ctx, host, entry, store, send };
}

describe('GUI reset clears reminders for the old conversation', () => {
  it('clears only the reset session and notifies the visible reminder panel', async () => {
    const { ctx, host, store, send } = fixture();
    const target = { kind: 'session', sessionId: 'gui' } as const;
    const other = { kind: 'session', sessionId: 'other' } as const;
    addSessionReminder(ctx, target, '旧会话提醒', null);
    addSessionReminder(ctx, other, '其他会话提醒', null);
    send.mockClear();
    await clear(host, 'gui');
    expect(listSessionReminders(ctx, target).items).toEqual([]);
    expect(listSessionReminders(ctx, other).items.map(item => item.text)).toEqual(['其他会话提醒']);
    expect(send).toHaveBeenCalledWith('sessionReminders:changed', target);
    expect(store.clearPendingFork).toHaveBeenCalledWith('gui');
  });

  it('keeps the clear marker and reports an error when reminder cleanup fails', async () => {
    const { ctx, host, entry, store } = fixture();
    const target = { kind: 'session', sessionId: 'gui' } as const;
    addSessionReminder(ctx, target, '清理失败时保留', null);
    const failure = vi.spyOn(SessionReminderStore.prototype, 'deleteScope').mockImplementation(() => { throw new Error('db unavailable'); });
    try {
      await expect(clear(host, 'gui')).rejects.toThrow('db unavailable');
      expect(store.clearPendingFork).not.toHaveBeenCalled();
      expect((entry as { forkPendingError?: string }).forkPendingError).toContain('db unavailable');
      expect(listSessionReminders(ctx, target).items.map(item => item.text)).toEqual(['清理失败时保留']);
    } finally { failure.mockRestore(); }
    await clear(host, 'gui');
    expect(listSessionReminders(ctx, target).items).toEqual([]);
  });
});
