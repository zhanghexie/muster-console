import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionReminderStore } from '../../../src/main/sessionReminders/store';
import { runAsAgentSession, runAsAgentWorkspace, runAsSchedulerTool } from '../../../src/main/agent/agentScope';
import { runAsHeadlessTurn } from '../../../src/main/agent/turnScope';
import type { AppContext } from '../../../src/main/context';
import { inboundMcpToolDefs } from '../../../src/main/inboundMcp/toolList';
import { workerToolRequiresToken, bindWorkerToolArgs } from '../../../src/main/capabilities/workerBinding';
import { residentHostToolIds } from '../../../src/shared/toolDiscovery';
import { buildCatalogAppendix } from '../../../src/main/agent/systemPrompt';
import { resolveTurnHiddenTools } from '../../../src/shared/turnVisibility';
import { SESSION_REMINDER_GUIDANCE } from '../../../src/shared/sessionReminders';
import { SESSION_REMINDER_TOOL_DEFS } from '../../../src/main/capabilities/catalog/sessionReminders';

const mock = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => mock.directory } }));
import { sessionRemindersHost } from '../../../src/main/capabilities/hosts/sessionReminders';
import { closeSessionReminderStore, completeSessionReminder, deleteSessionReminder, listSessionReminders } from '../../../src/main/sessionReminders/service';

beforeAll(() => { mock.directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-session-reminders-')); });
afterAll(() => {
  closeSessionReminderStore();
  if (path.dirname(mock.directory) !== os.tmpdir() || !path.basename(mock.directory).startsWith('ma-session-reminders-')) throw new Error('Unsafe cleanup');
  fs.rmSync(mock.directory, { recursive: true, force: true });
});

describe('persistent conversation reminders', () => {
  it('registers the bound tool for scheduler, GUI, CLI and ACP, and guides only available interactive tools', () => {
    expect(SESSION_REMINDER_GUIDANCE.length).toBeLessThan(250);
    const definition = SESSION_REMINDER_TOOL_DEFS[0];
    expect(definition.description.length).toBeLessThan(300);
    expect(definition.description).toContain('Only users can delete');
    expect(definition.description).toContain('A check does not delete, answer, authorize or wake');
    expect(definition.parameters.properties?.offset).toMatchObject({ description: expect.stringContaining('nextOffset') });
    expect(definition.parameters.properties?.reminderId).toMatchObject({ description: expect.stringContaining('add.item.id') });
    expect(SESSION_REMINDER_TOOL_DEFS[0].parameters.properties?.action).toMatchObject({ enum: ['list', 'add', 'complete', 'reopen'] });
    for (const role of ['scheduler', 'worker'] as const) expect(residentHostToolIds(role)).toContain('ui.reminders');
    for (const preset of ['gui-full', 'pty-allowlist', 'acp-subset'] as const) {
      const tool = inboundMcpToolDefs(preset).find(item => item.name === 'host_ui_reminders');
      expect(tool?.inputSchema).toMatchObject({ required: ['action'] });
      expect(tool?.description).toContain('before handing a required action to the user');
    }
    expect(workerToolRequiresToken('ui.reminders')).toBe(true);
    const bound = bindWorkerToolArgs({ sessions: { get: () => ({ name: 'worker' }) } }, 'ui.reminders', { __actorSessionId: 'forged' }, 'real');
    expect(bound.__actorSessionId).toBe('real');
    expect(buildCatalogAppendix()).toMatch(/host_ui_reminders.*action=add before replying.*chat to-do.*user still needs to/);
    expect(buildCatalogAppendix(resolveTurnHiddenTools('prompt-task'))).not.toContain('host_ui_reminders');
  });

  it('deletes exactly one reminder or one entire scope, rejecting missing and cross-scope ids', () => {
    const file = path.join(mock.directory, 'delete-test.sqlite');
    const store = new SessionReminderStore(file);
    const a = store.add('session:a', '待处理', null).item;
    const b = store.add('session:a', '已完成', null).item;
    const other = store.add('session:b', '其他会话', null).item;
    store.setCompleted('session:a', b.id, true, 'user');
    expect(() => store.delete('session:b', a.id)).toThrow('does not exist');
    store.delete('session:a', a.id);
    expect(store.list('session:a').map(item => item.id)).toEqual([b.id]);
    expect(() => store.delete('session:a', a.id)).toThrow('does not exist');
    store.deleteScope('session:a');
    expect(store.list('session:a')).toEqual([]);
    expect(store.list('session:b').map(item => item.id)).toEqual([other.id]);
    store.close();
  });
  it('persists independent conversations, avoids duplicate open reminders and records who completed them', () => {
    const file = path.join(mock.directory, 'store-test.sqlite');
    let store = new SessionReminderStore(file);
    const first = store.add('session:a', '确认目标分支', 'message-1');
    expect(first.created).toBe(true);
    expect(store.add('session:a', ' 确认目标分支 ', null)).toMatchObject({ created: false, item: { id: first.item.id } });
    expect(store.list('session:b')).toEqual([]);
    expect(() => store.setCompleted('session:b', first.item.id, true, 'user')).toThrow('does not exist');
    expect(store.setCompleted('session:a', first.item.id, true, 'user')).toMatchObject({ completedBy: 'user' });
    store.close();
    store = new SessionReminderStore(file);
    expect(store.list('session:a')).toEqual([expect.objectContaining({ id: first.item.id, sourceMessageId: 'message-1', completedBy: 'user' })]);
    expect(store.setCompleted('session:a', first.item.id, false, 'ai')).toMatchObject({ completedAt: null, completedBy: null });
    expect(store.setCompleted('session:a', first.item.id, true, 'ai')).toMatchObject({ completedBy: 'ai' });
    expect(() => store.add('session:a', ' ', null)).toThrow();
    store.close();
  });

  it('binds GUI and CLI calls to their actual session and keeps scheduler histories separate', async () => {
    let currentFile = 'conversation-a.jsonl';
    const sent = vi.fn();
    const ctx = {
      sessions: { get: (id: string) => ['gui', 'cli', 'bulk'].includes(id) ? { id } : undefined },
      workspaces: { list: () => [{ id: 'ws' }] },
      agentSessions: { currentAssistantMessageId: (id: string) => id === 'gui' ? 'gui-message' : null },
      orchestrator: { getHistory: () => {throw new Error('reminders must not load transcript bodies');}, getCurrentSessionFile: () => currentFile, currentAssistantMessageId: () => 'scheduler-message' },
      getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: sent } })
    } as unknown as AppContext;
    const invokeWorker = (id: string, args: Record<string, unknown>) => runAsAgentSession(id, async () => sessionRemindersHost['ui.reminders'](ctx, args));
    const invokeScheduler = (args: Record<string, unknown>) => runAsAgentWorkspace('ws', () => runAsSchedulerTool(async () => sessionRemindersHost['ui.reminders'](ctx, args)));
    const gui = await invokeWorker('gui', { action: 'add', text: 'GUI 确认', sessionId: 'cli' }) as { item: { id: string; sourceMessageId: string | null } };
    expect(gui.item.sourceMessageId).toBe('gui-message');
    await invokeWorker('gui', { action: 'complete', reminderId: gui.item.id });
    expect((await invokeWorker('gui', { action: 'list' }) as { items: Array<{ completedBy: string }> }).items[0].completedBy).toBe('ai');
    expect((await invokeWorker('cli', { action: 'list' }) as { items: unknown[] }).items).toEqual([]);
    await expect(invokeWorker('cli', { action: 'complete', reminderId: gui.item.id })).rejects.toThrow('does not exist');
    await expect(invokeWorker('gui', { action: 'delete', reminderId: gui.item.id })).rejects.toThrow('Choose list, add, complete, or reopen');
    const cli = await invokeWorker('cli', { action: 'add', text: 'CLI 确认' }) as { item: { sourceMessageId: string | null } };
    expect(cli.item.sourceMessageId).toBeNull();
    for (let i = 0; i < 30; i++) await invokeWorker('bulk', { action: 'add', text: `${i}${'"\\'.repeat(130)}` });
    let offset: number | undefined = 0;
    let count = 0;
    do {
      const page = await invokeWorker('bulk', { action: 'list', offset }) as { items: unknown[]; nextOffset?: number };
      expect(JSON.stringify(page).length).toBeLessThan(12000);
      count += page.items.length;
      offset = page.nextOffset;
    } while (offset !== undefined);
    expect(count).toBe(30);
    const scheduler = await invokeScheduler({ action: 'add', text: '调度确认' }) as { item: { id: string; sourceMessageId: string | null } };
    expect(scheduler.item.sourceMessageId).toBe('scheduler-message');
    await expect(invokeScheduler({ action: 'delete', reminderId: scheduler.item.id })).rejects.toThrow('Choose list, add, complete, or reopen');
    const target = { kind: 'scheduler', workspaceId: 'ws' } as const;
    const a = listSessionReminders(ctx, target);
    expect(a.items).toHaveLength(1);
    currentFile = 'conversation-b.jsonl';
    expect(listSessionReminders(ctx, target).items).toEqual([]);
    expect(() => completeSessionReminder(ctx, target, a.scope!, scheduler.item.id, true, 'user')).toThrow('conversation changed');
    expect(() => deleteSessionReminder(ctx, target, a.scope!, scheduler.item.id)).toThrow('conversation changed');
    currentFile = 'conversation-a.jsonl';
    completeSessionReminder(ctx, target, a.scope!, scheduler.item.id, true, 'user');
    expect((await invokeScheduler({ action: 'list' }) as { items: Array<{ completedBy: string }> }).items[0].completedBy).toBe('user');
    deleteSessionReminder(ctx, target, a.scope!, scheduler.item.id);
    expect(listSessionReminders(ctx, target).items).toEqual([]);
    await expect(runAsAgentWorkspace('ws', () => runAsSchedulerTool(async () => runAsHeadlessTurn(() => sessionRemindersHost['ui.reminders'](ctx, { action: 'list' }))))).rejects.toThrow('No interactive conversation');
    expect(sent).toHaveBeenCalledWith('sessionReminders:changed', target);
  });
});
