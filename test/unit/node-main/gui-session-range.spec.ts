import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuiSessionStore } from '../../../src/main/agentSession/persist';
import type { GuiChatMessage } from '../../../src/shared/guiWorker';
import { getHistoryRange } from '../../../src/main/agentSession/host/settings';
import type { HostCore } from '../../../src/main/agentSession/host/internal';
import { messageRangeIndexPath } from '../../../src/main/runtimeKernel/messageRangeIndex';

// History queries must not start messaging/driver connections or browser tools.
vi.mock('../../../src/main/agentSession/host/messaging', () => ({ send: vi.fn() }));

const tempDirs: string[] = [];

function message(id: string): GuiChatMessage {
  return { id, role: 'assistant', ts: Number(id.slice(1)), parts: [{ kind: 'text', text: id }] };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('GUI session cold history range', () => {
  it('uses a newer compact checkpoint without replaying a corrupt older event log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-range-'));
    tempDirs.push(dir);
    const sessionId = 'range-fast';
    const messages = Array.from({ length: 5 }, (_, index) => message(`m${index}`));
    new GuiSessionStore(dir).save(sessionId, messages);

    const eventFile = path.join(dir, 'agent-session-events', `${sessionId}.ndjson`);
    fs.writeFileSync(eventFile, '{broken event}\n', 'utf8');
    fs.utimesSync(eventFile, new Date(0), new Date(0));

    const range = new GuiSessionStore(dir).loadMessageRange(sessionId, 4, 2);
    expect(range).toMatchObject({
      before: 2,
      total: 5,
      hasEarlier: true
    });
    expect(range.messages.map(item => item.id)).toEqual(['m2', 'm3']);
  });

  it('cold host range reads metadata and target page without loading the full snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-range-'));
    tempDirs.push(dir);
    const sessionId = 'indexed-cold';
    new GuiSessionStore(dir).save(sessionId, Array.from({ length: 10000 }, (_, i) => message(`m${i}`)));
    const store = new GuiSessionStore(dir);
    vi.spyOn(store, 'loadSnapshot').mockImplementation(() => { throw new Error('Must not load the complete cold snapshot'); });
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('Must use positional reads'); });
    const host = { entries: new Map(), store, ctx: { sessions: { get: () => ({ id: sessionId, runtime: 'codex-gui' }) } } } as unknown as HostCore;
    const range = getHistoryRange(host, sessionId, undefined, 120, 'm5000');
    expect(range).toMatchObject({ before: 4940, total: 10000, busy: false });
    expect(range?.messages.map(item => item.id)).toEqual(Array.from({ length: 120 }, (_, i) => `m${4940 + i}`));
  });

  it('refreshes a legacy emoji-only board preview from the newest bounded history page', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-range-'));
    tempDirs.push(dir);
    const sessionId = 'board-preview';
    const store = new GuiSessionStore(dir);
    store.save(sessionId, [
      message('m1'),
      { ...message('m2'), parts: [{ kind: 'text', text: '游戏已启动。玩得开心！ 🏁' }] },
      { ...message('m3'), role: 'user' }
    ]);
    const session = { id: sessionId, runtime: 'codex-gui', boardReplyPreview: '🏁' };
    const setBoardReplyPreview = vi.fn();
    const host = { entries: new Map(), store, ctx: { sessions: { get: () => session, setBoardReplyPreview } } } as unknown as HostCore;
    vi.spyOn(store, 'loadSnapshot').mockImplementation(() => { throw new Error('Must not load the complete cold snapshot'); });
    getHistoryRange(host, sessionId, undefined, 1, 'm1');
    getHistoryRange(host, sessionId, 2, 1);
    getHistoryRange(host, sessionId, undefined, 1);
    expect(setBoardReplyPreview).not.toHaveBeenCalled();
    getHistoryRange(host, sessionId, undefined, 2);
    expect(setBoardReplyPreview).toHaveBeenCalledExactlyOnceWith(sessionId, '玩得开心！ 🏁');
  });

  it('rebuilds a missing range index once even when checkpoint and log mtimes are equal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-range-')); tempDirs.push(dir);
    const sessionId = 'equal-mtimes';
    new GuiSessionStore(dir).save(sessionId, Array.from({ length: 1000 }, (_, i) => message(`m${i}`)));
    const checkpoint = path.join(dir, 'agent-sessions', `${sessionId}.json`);
    const event = path.join(dir, 'agent-session-events', `${sessionId}.ndjson`);
    const same = new Date(Date.now() - 1000); fs.utimesSync(checkpoint, same, same); fs.utimesSync(event, same, same);
    fs.unlinkSync(messageRangeIndexPath(checkpoint));
    const store = new GuiSessionStore(dir);
    expect(store.loadMessageRange(sessionId, undefined, 10).messages.map(item => item.id)).toEqual(Array.from({ length: 10 }, (_, i) => `m${990 + i}`));
    expect(fs.existsSync(messageRangeIndexPath(checkpoint))).toBe(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('Index must be reusable without full JSON parse'); });
    expect(store.loadMessageRange(sessionId, undefined, 10).total).toBe(1000);
  });

  it('deletes the derived index with the session', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-range-')); tempDirs.push(dir);
    const store = new GuiSessionStore(dir);
    store.save('delete-range', [message('m1')]);
    const index = messageRangeIndexPath(path.join(dir, 'agent-sessions/delete-range.json'));
    expect(fs.existsSync(index)).toBe(true);
    store.delete('delete-range');
    expect(fs.existsSync(index)).toBe(false);
  });

  it('sweeps orphan indexes while retaining the live session checkpoint and indexes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-range-')); tempDirs.push(dir);
    const store = new GuiSessionStore(dir);
    const orphan = '11111111-1111-1111-1111-111111111111', live = '22222222-2222-2222-2222-222222222222';
    store.save(orphan, [message('m1')]); store.save(live, [message('m2')]);
    new GuiSessionStore(dir).sweepOrphans(new Set([live]));
    const files = [...fs.readdirSync(path.join(dir, 'agent-sessions')), ...fs.readdirSync(path.join(dir, 'agent-session-events'))];
    expect(files.some(file => file.includes(orphan))).toBe(false);
    expect(files).toContain(`${live}.json.ranges`);
    expect(files).toContain(`${live}.ndjson.index.json`);
  });
});
