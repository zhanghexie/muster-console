import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuiSessionStore } from '../../src/main/agentSession/persist';
import { SessionEventLog } from '../../src/main/runtimeKernel/sessionEventLog';
import { PersistQueue } from '../../src/main/persistQueue';
import { sanitizeRestoredMessages } from '../../src/shared/guiWorker';
import type { GuiChatMessage } from '../../src/shared/guiWorker';

describe('GUI display history persistence', () => {
  it('reopens its own release checkpoint without replaying the prefix or reseeding history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-checkpoint-release-'));
    try {
      const store = new GuiSessionStore(dir, () => false);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'before' }] }];
      store.retain('one', { messages, lastUsage: null, injections: [], compactions: [] });
      store.save('one', messages, undefined, undefined, undefined, true);
      await store.release('one');
      const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'agent-sessions', 'one.json'), 'utf8')).checkpoint;
      expect(checkpoint.lastAppliedSeq).toBe(2);
      const range = vi.spyOn(SessionEventLog.prototype, 'readRangeSync');
      const load = vi.spyOn(SessionEventLog.prototype, 'loadSync');
      try {
        store.retain('one');
        expect(store.load('one')).toEqual(messages);
        expect(load.mock.calls.every(args => !args[0])).toBe(true);
        expect(range.mock.calls.every(([query]) => query.fromSeq! >= checkpoint.lastAppliedSeq)).toBe(true);
      } finally { range.mockRestore(); load.mockRestore(); }
      store.recordDelta('one', 'a', 'text', ' after');
      await store.release('one');
      const events = fs.readFileSync(path.join(dir, 'agent-session-events', 'one.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.type === 'gui-session.snapshot')).toHaveLength(1);
      expect(events.at(-1).type).toBe('gui-session.delta');
      expect(new GuiSessionStore(dir, () => false).load('one')[0].parts).toEqual([{ kind: 'text', text: 'before after' }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a host checkpoint valid when the display-thinking policy changes before release', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-checkpoint-policy-'));
    try {
      let liveOnly = false;
      const store = new GuiSessionStore(dir, () => liveOnly);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [
        { kind: 'thinking', text: 'saved while enabled' }, { kind: 'text', text: 'answer' }
      ] }];
      store.retain('one', { messages: [], lastUsage: null, injections: [], compactions: [] });
      store.save('one', messages);
      liveOnly = true;
      await store.release('one');
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent-sessions', 'one.json'), 'utf8'));
      const range = vi.spyOn(SessionEventLog.prototype, 'readRangeSync');
      try {
        store.retain('one');
        expect(store.load('one')).toEqual(messages);
        expect(range.mock.calls.every(([query]) => query.fromSeq! >= raw.checkpoint.lastAppliedSeq)).toBe(true);
      } finally { range.mockRestore(); }
      await store.release('one');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('validates original metadata before parsing and persists recovery sanitation', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-checkpoint-sanitize-'));
    try {
      const store = new GuiSessionStore(dir, () => false);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [
        { kind: 'tool', tool: { id: 't', name: 'read', input: {}, status: 'running' } }
      ] }];
      // Different key order from parseLastUsage must not turn our own write into
      // an external edit. The Host sanitizes messages only after restoration.
      store.save('one', messages, { ts: 10, contextWindow: 4096, tokens: 321 });
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agent-sessions', 'one.json'), 'utf8'));
      const range = vi.spyOn(SessionEventLog.prototype, 'readRangeSync');
      try {
        store.retain('one');
        expect(range.mock.calls.every(([query]) => query.fromSeq! >= raw.checkpoint.lastAppliedSeq)).toBe(true);
      } finally { range.mockRestore(); }
      const restored = store.load('one');
      expect(restored).toEqual(messages);
      store.save('one', sanitizeRestoredMessages(restored), undefined, undefined, undefined, true);
      await store.release('one');
      const reopened = new GuiSessionStore(dir, () => false).loadSnapshot('one');
      expect(reopened.messages[0].parts[0]).toMatchObject({ tool: { status: 'cancelled' } });
      expect(reopened.lastUsage).toEqual({ ts: 10, contextWindow: 4096, tokens: 321 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('repairs a mismatched anchor once and uses the repaired checkpoint on the next cold load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-checkpoint-repair-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new GuiSessionStore(dir, () => false);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'kept' }] }];
      store.save('one', messages);
      const file = path.join(dir, 'agent-sessions', 'one.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')); raw.checkpoint.lastEventId = 'not-in-this-log';
      fs.writeFileSync(file, JSON.stringify(raw));
      expect(store.load('one')).toEqual(messages);
      expect(warning).toHaveBeenCalled();
      const repaired = JSON.parse(fs.readFileSync(file, 'utf8')).checkpoint;
      expect(repaired.lastEventId).not.toBe('not-in-this-log');
      const range = vi.spyOn(SessionEventLog.prototype, 'readRangeSync');
      try {
        expect(store.load('one')).toEqual(messages);
        expect(range.mock.calls.every(([query]) => query.fromSeq! >= repaired.lastAppliedSeq)).toBe(true);
      } finally { range.mockRestore(); }
    } finally { warning.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('diagnoses a newer externally edited checkpoint and durably seeds it before a delta', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-checkpoint-edited-'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = new GuiSessionStore(dir, () => false);
      store.save('one', [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'original' }] }]);
      const file = path.join(dir, 'agent-sessions', 'one.json');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.messages[0].parts[0].text = 'external';
      fs.writeFileSync(file, JSON.stringify(raw));
      const newer = new Date(Date.now() + 10000); fs.utimesSync(file, newer, newer);
      store.retain('one');
      store.recordDelta('one', 'a', 'text', ' delta');
      await store.release('one');
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('external JSON as seed'), 'one');
      expect(new GuiSessionStore(dir, () => false).load('one')[0].parts).toEqual([{ kind: 'text', text: 'external delta' }]);
    } finally { warning.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('omits thinking even while streaming, retains it when disabled, and does not mutate runtime messages', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thinking-display-'));
    try {
      let liveOnly = true;
      const store = new GuiSessionStore(dir, () => liveOnly);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'thinking', text: 'secret' }, { kind: 'text', text: 'answer' }] }];
      store.save('one', messages);
      store.flushSync();
      const saved = fs.readFileSync(path.join(dir, 'agent-sessions', 'one.json'), 'utf8');
      expect(saved.trim()).toBe(JSON.stringify(JSON.parse(saved)));
      expect(saved).not.toContain('secret');
      expect(saved).toContain('answer');
      expect(messages[0].parts).toHaveLength(2);
      liveOnly = false;
      store.save('two', messages);
      store.flushSync();
      expect(fs.readFileSync(path.join(dir, 'agent-sessions', 'two.json'), 'utf8')).toContain('secret');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps compact history on queued and strict writes while other queues remain readable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-history-'));
    try {
      const store = new GuiSessionStore(dir, () => false);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'answer' }] }];
      const file = path.join(dir, 'agent-sessions', 'one.json');
      store.save('one', messages);
      for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 10));
      const queued = fs.readFileSync(file, 'utf8');
      expect(queued.trim()).toBe(JSON.stringify(JSON.parse(queued)));
      let committed = false;
      await store.saveSnapshotStrict('one', () => ({ messages, lastUsage: null, injections: [], compactions: [] }), () => { committed = true; });
      const strict = fs.readFileSync(file, 'utf8');
      expect(committed).toBe(true);
      expect(strict.trim()).toBe(JSON.stringify(JSON.parse(strict)));
      expect(JSON.parse(strict).messages).toEqual(messages);
      const ordinary = new PersistQueue(dir);
      ordinary.write('config.json', { nested: { value: 1 } });
      ordinary.flushSync();
      expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toContain('\n  "nested"');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('releases a live adapter after draining an older checkpoint write', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-history-'));
    try {
      const store = new GuiSessionStore(dir, () => false);
      const messages: GuiChatMessage[] = [{ id: 'a', role: 'assistant', ts: 1, parts: [{ kind: 'text', text: 'latest' }] }];
      store.retain('one');
      store.save('one', messages);
      await store.release('one');
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'agent-sessions', 'one.json'), 'utf8')).messages).toEqual(messages);
      expect(store.load('one')).toEqual(messages);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('turns strict snapshot callback failures into rejected promises', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-history-error-'));
    try {
      const store = new GuiSessionStore(dir, () => false);
      await expect(store.saveSnapshotStrict('one', () => { throw new Error('snapshot failed'); }, () => {})).rejects.toThrow('snapshot failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('flush waits for write-behind snapshots without a synchronous emergency path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-async-'));
    try {
      const queue = new PersistQueue(dir);
      queue.write('state.json', { value: 42 });
      await queue.flush();
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))).toEqual({ value: 42 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
