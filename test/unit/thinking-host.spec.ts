import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {} }));
vi.mock('../../src/main/agent/providers/piProvider', () => ({ disposePiSessionResources: vi.fn() }));
vi.mock('../../src/main/attachments/service', () => ({ clearAttachments: vi.fn() }));
vi.mock('../../src/main/agentSession/host/fileChanges', () => ({ noteFileChangeStart: vi.fn(), noteFileChangeEnd: vi.fn() }));
vi.mock('../../src/main/agentSession/host/turn', () => ({ finishTurn: vi.fn(), handleTurnFailure: vi.fn(), splitSteeredTurn: vi.fn() }));
import { persistBucket } from '../../src/main/agent/orchestrator/buckets';
import { handleEvent } from '../../src/main/agentSession/host/events';

describe('thinking display host boundary', () => {
  it('stores the scheduler display projection while preserving runtime state and api', () => {
    const display = [{ id: 'a', role: 'assistant', thinking: 'thought', parts: [{ kind: 'thinking', text: 'thought' }, { kind: 'text', text: 'reply' }] }];
    const api = [{ runtime: 'unchanged' }];
    // 落盘责任已从 ctx.store.saveChat 迁到 bucket.schedulerSession：
    // 元数据只收 api + 指针，thinking 由 recordMessage 按 liveThinkingOnly 单独处理。
    const persistMetadata = vi.fn();
    const recordMessage = vi.fn();
    const bucket: any = { display, api, piSessionFile: 'runtime.jsonl',
      schedulerSession: { persistMetadata, recordMessage } };
    const host: any = { buckets: new Map([['w', bucket]]), ctx: { config: { get: () => ({}) } } };
    persistBucket(host, 'w');
    expect(persistMetadata).toHaveBeenCalledWith(api, 'runtime.jsonl');
    expect(JSON.stringify(persistMetadata.mock.calls)).not.toContain('thought');
    expect(display[0].parts).toHaveLength(2);
    bucket.streamingAssistant = display[0];
    host.ctx.config.get = () => ({ liveThinkingOnly: false });
    persistBucket(host, 'w');
    expect(recordMessage).toHaveBeenCalledOnce();
    expect(recordMessage.mock.calls[0][1]).toBe(false);
  });
  it('does not mix identified Cursor nested thinking into persisted tool output', () => {
    const output = { id: 'tool', status: 'running', output: '' };
    const entry: any = { sessionId: 's', assistant: { parts: [{ kind: 'tool', tool: output }] } };
    const host: any = { ctx: { config: { get: () => ({}) }, getWindow: () => null }, entries: new Map([['s', entry]]), pushSubs: new Set(),
      streamPersistTimers: new Map(), store: { recordDelta: vi.fn(), recordToolPart: vi.fn() } };
    handleEvent(host, entry, { type: 'tool-progress', toolCallId: 'tool', delta: 'private', thinking: true });
    expect(output.output).toBe('');
    handleEvent(host, entry, { type: 'tool-progress', toolCallId: 'tool', delta: 'progress' });
    expect(output.output).toBe('progress');
    for (const timer of host.streamPersistTimers.values()) clearTimeout(timer as ReturnType<typeof setTimeout>);
  });
});
