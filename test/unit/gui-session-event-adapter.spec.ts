import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuiSessionEventAdapter, type GuiSessionProjection } from '../../src/main/runtimeKernel/guiSession';
import { SessionEventLog } from '../../src/main/runtimeKernel/sessionEventLog';
import type { GuiChatMessage } from '../../src/shared/guiWorker';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-gui-session-'));
  roots.push(value);
  return value;
}

function message(id: string, text: string): GuiChatMessage {
  return { id, role: 'assistant', ts: 1, parts: [{ kind: 'text', text }] };
}

function projection(messages: GuiChatMessage[]): GuiSessionProjection {
  return { messages, lastUsage: null, injections: [], compactions: [] };
}

describe('GuiSessionEventAdapter', () => {
  it('restores a trusted prefix and replays only bounded suffix batches', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'suffix', projection([]), () => false);
    adapter.persist(projection([message('a', '')]));
    for (let i = 0; i < 100; i++) adapter.recordDelta('a', 'text', 'p');
    await adapter.flush('prefix');
    const checkpoint = adapter.checkpoint()!;
    const prefix = adapter.snapshot();
    for (let i = 0; i < 600; i++) adapter.recordDelta('a', 'text', 's');
    await adapter.flush('suffix');
    const load = vi.spyOn(SessionEventLog.prototype, 'loadSync');
    const range = vi.spyOn(SessionEventLog.prototype, 'readRangeSync');
    try {
      const restored = new GuiSessionEventAdapter(dir, 'suffix', prefix, () => false, { checkpoint });
      expect(restored.snapshot()).toEqual(adapter.snapshot());
      expect(load.mock.calls.every(args => !args[0])).toBe(true);
      expect(range.mock.calls.every(([query]) => query.fromSeq! >= checkpoint.lastAppliedSeq && query.limit <= 512)).toBe(true);
      expect(range.mock.calls.filter(([query]) => query.fromSeq! > checkpoint.lastAppliedSeq).length).toBe(3);
    } finally { load.mockRestore(); range.mockRestore(); }
  });

  it('rejects a mismatched checkpoint anchor and rebuilds the real log', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'bad-anchor', projection([]), () => false);
    adapter.persist(projection([message('real', 'kept')]));
    await adapter.flush('checkpoint');
    const checkpoint = { ...adapter.checkpoint()!, lastEventId: 'other-log' };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const restored = new GuiSessionEventAdapter(dir, 'bad-anchor', adapter.snapshot(), () => false, { checkpoint });
      expect(restored.snapshot()).toEqual(adapter.snapshot());
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('rebuilding'), 'bad-anchor', expect.stringContaining('does not match'));
    } finally { warning.mockRestore(); }
  });

  it('rejects a modified checkpoint projection even when its anchor still matches', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'bad-checksum', projection([]), () => false);
    adapter.persist(projection([message('real', 'kept')]));
    await adapter.flush('checkpoint');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const restored = new GuiSessionEventAdapter(dir, 'bad-checksum', projection([message('fake', 'lost')]), () => false,
        { checkpoint: adapter.checkpoint() });
      expect(restored.snapshot()).toEqual(adapter.snapshot());
      expect(warning).toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });

  it('retains the initial checkpoint when the first append fails and is retried', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'retry', projection([message('original', 'kept')]), () => false);
    const internal = adapter as unknown as { log: { appendSync: (...args: unknown[]) => unknown } };
    const fail = vi.spyOn(internal.log, 'appendSync').mockImplementationOnce(() => { throw new Error('append failed'); });
    expect(() => adapter.persistChanges([message('new', 'new')], projection([]))).toThrow('append failed');
    fail.mockRestore();
    adapter.persistChanges([message('new', 'new')], projection([]));
    await adapter.flush('retry');
    expect(new GuiSessionEventAdapter(dir, 'retry', projection([]), () => false).snapshot().messages.map(message => message.id)).toEqual(['original', 'new']);
  });

  it('replays scalar text and tool events without periodic full-message saves', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'stream', projection([message('a', '')]), () => true);
    adapter.recordDelta('a', 'text', 'before');
    adapter.recordDelta('a', 'thinking', 'private');
    const tool = { kind: 'tool' as const, tool: { id: 't1', name: 'read', input: {}, status: 'running' as const } };
    adapter.recordToolPart('a', tool);
    adapter.recordDelta('a', 'text', 'after');
    adapter.recordToolPart('a', { ...tool, tool: { ...tool.tool, status: 'ok', output: 'result' } });
    tool.tool.name = 'caller mutation';
    await adapter.flush('stream');
    const restored = new GuiSessionEventAdapter(dir, 'stream', projection([]), () => true);
    expect(restored.snapshot().messages[0].parts).toEqual([
      { kind: 'text', text: 'before' },
      { kind: 'tool', tool: { id: 't1', name: 'read', input: {}, status: 'ok', output: 'result' } },
      { kind: 'text', text: 'after' }
    ]);
    const events = fs.readFileSync(path.join(dir, 'agent-session-events', 'stream.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(events.slice(1).every(event => event.causationId === (event.type === 'gui-session.tool' ? 't1' : 'a') && event.correlationId === 'stream:a')).toBe(true);
    expect(events.some(event => JSON.stringify(event).includes('private'))).toBe(false);
    const size = fs.statSync(path.join(dir, 'agent-session-events', 'stream.ndjson')).size;
    expect(() => adapter.recordDelta('unknown', 'text', 'orphan')).toThrow(/unknown message/);
    await adapter.flush('rejected');
    expect(fs.statSync(path.join(dir, 'agent-session-events', 'stream.ndjson')).size).toBe(size);
  });

  it('persists a seed plus changed messages and restores without a full snapshot rewrite', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'gui-one', projection([message('a', 'first')]), () => false);
    adapter.persistChanges([message('a', 'updated'), message('b', 'second')], projection([]));
    await adapter.flush('test');

    const file = path.join(dir, 'agent-session-events', 'gui-one.ndjson');
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('gui-session.snapshot');
    expect(lines[1]).toContain('gui-session.messages');
    expect(lines[1]).not.toContain('"text":"first"');

    const restored = new GuiSessionEventAdapter(dir, 'gui-one', projection([]), () => false);
    expect(restored.snapshot()).toEqual(projection([message('a', 'updated'), message('b', 'second')]));
  });

  it('never reads old message bodies when updating one record in a long session', async () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'gui-bounded', projection([]), () => false);
    adapter.persist(projection(Array.from({ length: 3000 }, (_, index) => message(`m${index}`, 'long body '.repeat(100)))));
    await adapter.flush('seed');
    const file = path.join(dir, 'agent-session-events', 'gui-bounded.ndjson');
    const before = fs.statSync(file).size;
    const internal = adapter as unknown as { state: GuiSessionProjection };
    Object.defineProperty(internal.state.messages[0], 'parts', { get() { throw new Error('hot write touched old body'); } });
    const updated = message('m2999', 'changed');
    adapter.persistChanges([updated], projection([]));
    updated.parts.push({ kind: 'text', text: 'caller mutation' });
    await adapter.flush('delta');
    expect(fs.statSync(file).size - before).toBeLessThan(1000);
    expect(adapter.readMessagesRange(undefined, 1).messages).toEqual([message('m2999', 'changed')]);
    const restored = new GuiSessionEventAdapter(dir, 'gui-bounded', projection([]), () => false);
    expect(restored.readMessagesRange(undefined, 1)).toMatchObject({ total: 3000, messages: [message('m2999', 'changed')] });
  });

  it('applies the display-thinking projection before appending events', async () => {
    const dir = root();
    const messages: GuiChatMessage[] = [{
      id: 'assistant',
      role: 'assistant',
      ts: 1,
      parts: [{ kind: 'thinking', text: 'secret' }, { kind: 'text', text: 'answer' }]
    }];
    const adapter = new GuiSessionEventAdapter(dir, 'gui-two', projection([]), () => true);
    adapter.persist(projection(messages));
    await adapter.flush('test');
    expect(adapter.snapshot().messages[0]?.parts).toEqual([{ kind: 'text', text: 'answer' }]);
    expect(messages[0].parts).toHaveLength(2);
  });

  it('drains a first persist synchronously for the quit path', () => {
    const dir = root();
    const adapter = new GuiSessionEventAdapter(dir, 'gui-sync', projection([]), () => false);
    adapter.persist(projection([message('sync', 'durable')]));
    adapter.flushSync();
    const restored = new GuiSessionEventAdapter(dir, 'gui-sync', projection([]), () => false);
    expect(restored.snapshot()).toEqual(projection([message('sync', 'durable')]));
  });

  it('reseeds a newer checkpoint before appending patches', async () => {
    const dir = root();
    const original = new GuiSessionEventAdapter(dir, 'gui-checkpoint', projection([message('old', 'old')]), () => false);
    original.persist(projection([message('old', 'old')]));
    await original.flush('seed');
    const checkpoint = projection([message('external', 'edited')]);
    const edited = new GuiSessionEventAdapter(dir, 'gui-checkpoint', checkpoint, () => false, { preferInitial: true });
    edited.persist(projection([...checkpoint.messages, message('new', 'new')]));
    await edited.flush('checkpoint');
    const restored = new GuiSessionEventAdapter(dir, 'gui-checkpoint', projection([]), () => false);
    expect(restored.snapshot()).toEqual(projection([...checkpoint.messages, message('new', 'new')]));
  });

  it('reads a bounded tail without returning the complete message array', async () => {
    const dir = root();
    const messages = Array.from({ length: 5 }, (_, index) => message(`m${index}`, String(index)));
    const adapter = new GuiSessionEventAdapter(dir, 'gui-range', projection(messages), () => false);
    adapter.persist(projection(messages));
    await adapter.flush('range');

    expect(adapter.readMessagesRange(undefined, 2)).toEqual({
      messages: [message('m3', '3'), message('m4', '4')],
      before: 3,
      total: 5,
      hasEarlier: true
    });
    expect(adapter.readMessagesRange(3, 2)).toEqual({
      messages: [message('m1', '1'), message('m2', '2')],
      before: 1,
      total: 5,
      hasEarlier: true
    });
  });
});
