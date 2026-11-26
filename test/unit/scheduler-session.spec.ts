import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadSchedulerHistoryRange,
  loadSchedulerSessionMetadata,
  loadSchedulerSessionSnapshot,
  SchedulerSessionAdapter,
  schedulerSessionId,
  type SchedulerSessionSnapshot
} from '../../src/main/runtimeKernel/schedulerSession';
import { schedulerSqlitePath } from '../../src/main/runtimeKernel/schedulerSqlite';
import { STALE_TURN_MS } from '../../src/shared/chatStaleTurn';
import type { ChatDisplayPart, ChatMessage, ToolCallRecord } from '../../src/shared/types';

const roots: string[] = [];
const adapters: SchedulerSessionAdapter[] = [];

afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-scheduler-sqlite-'));
  roots.push(value);
  return value;
}

function open(rootDir: string, workspaceId: string, initial: SchedulerSessionSnapshot): SchedulerSessionAdapter {
  const adapter = new SchedulerSessionAdapter(rootDir, workspaceId, initial);
  adapters.push(adapter);
  return adapter;
}

function message(id: string, content: string, createdAt = Date.now(), extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content, createdAt, ...extra };
}

function tool(id: string, result: string, status: ToolCallRecord['status'] = 'ok'): ToolCallRecord {
  return { id, name: 'sessions.list', arguments: '{"workspace":"demo"}', result, status };
}

describe('SchedulerSessionAdapter SQLite projection', () => {
  it('uses a readable stable-hash scheduler identity for lossy workspace IDs', () => {
    const slash = schedulerSessionId('a/b');
    expect(slash).toMatch(/^workspace-a-b~[a-f0-9]{16}$/);
    expect(slash).toBe(schedulerSessionId('a/b'));
    expect(slash).not.toBe(schedulerSessionId('a?b'));
    expect(schedulerSessionId('workspace-a')).toBe('workspace-workspace-a');
  });

  it('creates one SQLite database per scheduler session and no NDJSON log', () => {
    const dir = root();
    const first = open(dir, 'workspace-a', { display: [message('a', 'A')], api: [] });
    const second = open(dir, 'workspace-b', { display: [message('b', 'B')], api: [] });
    expect(fs.existsSync(schedulerSqlitePath(dir, first.sessionId))).toBe(true);
    expect(fs.existsSync(schedulerSqlitePath(dir, second.sessionId))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'scheduler-sessions')).some(name => name.endsWith('.ndjson'))).toBe(false);
    expect(first.snapshot().display[0]?.content).toBe('A');
    expect(second.snapshot().display[0]?.content).toBe('B');
  });

  it('stores text parts and tool payloads once, then restores the same interleaved projection', () => {
    const dir = root();
    const assistant: ChatMessage = {
      ...message('live', 'answer'),
      parts: [
        { kind: 'text', text: 'answer' },
        { kind: 'tool', toolCall: tool('tool-1', 'first result', 'running') }
      ],
      toolCalls: [tool('tool-1', 'first result', 'running')]
    };
    const adapter = open(dir, 'events', { display: [], api: [] });
    adapter.recordMessage(assistant, false);
    adapter.recordDisplayEvent('agent:tool', { messageId: 'live', toolCall: tool('tool-1', 'large result '.repeat(1000)) }, false);
    adapter.recordMessage(structuredClone(adapter.snapshot().display[0]), false);
    const db = new DatabaseSync(schedulerSqlitePath(dir, adapter.sessionId));
    try {
      const columns = db.prepare("SELECT name FROM pragma_table_info('scheduler_message') ORDER BY cid").all() as Array<{ name: string }>;
      expect(columns.map(column => column.name)).not.toContain('content');
      expect(Number((db.prepare('SELECT COUNT(*) AS n FROM scheduler_message').get() as { n: number }).n)).toBe(1);
      expect(Number((db.prepare('SELECT COUNT(*) AS n FROM scheduler_part').get() as { n: number }).n)).toBe(2);
      expect(Number((db.prepare('SELECT COUNT(*) AS n FROM scheduler_tool').get() as { n: number }).n)).toBe(1);
      expect((db.prepare('SELECT result FROM scheduler_tool WHERE tool_id=?').get('tool-1') as { result: string }).result).toHaveLength(13_000);
    } finally {
      db.close();
    }
    const restored = open(dir, 'events', { display: [], api: [] });
    expect(restored.snapshot().display[0]).toMatchObject({
      content: 'answer',
      parts: [{ kind: 'text', text: 'answer' }, { kind: 'tool', toolCall: { id: 'tool-1', status: 'ok' } }],
      toolCalls: [{ id: 'tool-1', result: 'large result '.repeat(1000) }]
    });
  });

  it('persists streaming deltas in parts and serves bounded history pages', () => {
    const dir = root();
    const history = Array.from({ length: 200 }, (_, index) => message(`m-${index}`, `body ${index}`, Date.now()));
    const adapter = open(dir, 'paged', { display: history, api: [], piSessionFile: 'pi-session.jsonl' });
    adapter.recordMessage(message('live', ''), false);
    adapter.recordDisplayEvent('agent:token', { messageId: 'live', token: 'hello ' }, false);
    adapter.recordDisplayEvent('agent:token', { messageId: 'live', token: 'world' }, false);
    adapter.recordDisplayEvent('agent:thinking', { messageId: 'live', token: 'internal' }, false);
    expect(loadSchedulerSessionMetadata(dir, 'paged')).toEqual({ piSessionFile: 'pi-session.jsonl' });
    const page = loadSchedulerHistoryRange(dir, 'paged', undefined, 12, 'm-123');
    expect(page.total).toBe(201);
    expect(page.messages).toHaveLength(12);
    expect(page.messages.some(item => item.id === 'm-123')).toBe(true);
    expect(loadSchedulerSessionSnapshot(dir, 'paged')?.display.at(-1)).toMatchObject({ content: 'hello world', thinking: 'internal' });
  });

  it('archives completed old turns while retaining final text and tool summaries only', () => {
    const dir = root();
    const old = Date.now() - STALE_TURN_MS - 60_000;
    const archivedTool = tool('tool-old', 'secret result '.repeat(1000));
    const adapter = open(dir, 'archive', {
      display: [{
        ...message('old', 'final answer', old, { finishedAt: old + 1000, thinking: 'private reasoning' }),
        parts: [
          { kind: 'thinking', text: 'private reasoning' },
          { kind: 'text', text: 'final answer' },
          { kind: 'tool', toolCall: archivedTool }
        ] as ChatDisplayPart[],
        toolCalls: [archivedTool]
      }],
      api: []
    });
    const restored = adapter.snapshot().display[0]!;
    expect(restored).toMatchObject({ archived: true, content: 'final answer', archivedTools: [{ id: 'tool-old', name: 'sessions.list', status: 'ok' }] });
    expect(restored.toolCalls).toBeUndefined();
    expect(restored.thinking).toBeUndefined();
    const db = new DatabaseSync(schedulerSqlitePath(dir, adapter.sessionId));
    try {
      expect(db.prepare('SELECT arguments,input_json,result,preview_path,patch FROM scheduler_tool WHERE tool_id=?').get('tool-old')).toEqual({ arguments: null, input_json: null, result: null, preview_path: null, patch: null });
      expect(Number((db.prepare("SELECT COUNT(*) AS n FROM scheduler_part WHERE message_id='old' AND kind='thinking'").get() as { n: number }).n)).toBe(0);
      expect((db.prepare("SELECT text FROM scheduler_part WHERE message_id='old' AND kind='text'").get() as { text: string }).text).toBe('final answer');
    } finally {
      db.close();
    }
  });

  it('keeps fork sessions isolated and switches the active pointer only on publish', async () => {
    const dir = root();
    const parent = open(dir, 'branch', { display: [message('first', 'prefix'), message('later', 'later')], api: [{ private: true }] });
    const child = await parent.prepareFork([message('first', 'prefix')], 'child-pi.jsonl', 'first');
    adapters.push(child);
    expect(fs.existsSync(schedulerSqlitePath(dir, child.sessionId))).toBe(true);
    expect(loadSchedulerHistoryRange(dir, 'branch').messages.map(item => item.id)).toEqual(['first', 'later']);
    child.publishFork();
    expect(loadSchedulerHistoryRange(dir, 'branch').messages.map(item => item.id)).toEqual(['first']);
    expect(loadSchedulerSessionSnapshot(dir, 'branch')?.fork).toEqual({ parentSessionId: parent.sessionId, atSeq: parent.revision, uptoMessageId: 'first' });
    expect(loadSchedulerSessionSnapshot(dir, 'branch')?.piSessionFile).toBe('child-pi.jsonl');
    await expect(child.discardFork()).rejects.toThrow('active scheduler fork');
  });

  it('removes only an unpublished fork database', async () => {
    const dir = root();
    const parent = open(dir, 'discard', { display: [message('first', 'prefix')], api: [] });
    const child = await parent.prepareFork([message('first', 'prefix')], 'child-pi.jsonl');
    adapters.push(child);
    const file = schedulerSqlitePath(dir, child.sessionId);
    await child.discardFork();
    expect(fs.existsSync(file)).toBe(false);
    expect(loadSchedulerHistoryRange(dir, 'discard').messages.map(item => item.id)).toEqual(['first']);
  });
});
