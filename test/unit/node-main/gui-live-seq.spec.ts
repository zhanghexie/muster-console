import { describe, expect, it, vi } from 'vitest';
import { push } from '../../../src/main/agentSession/host/base';
import type { HostCore } from '../../../src/main/agentSession/host/internal';
import type { GuiWorkerPush } from '../../../src/shared/guiWorker';

describe('GUI Worker live message cursor', () => {
  it('sequences message pushes per session while metadata stays outside the cursor', () => {
    const sent: Array<{ channel: string; payload: GuiWorkerPush }> = [];
    const host = {
      entries: new Map([['session-a', {}]]),
      ctx: {
        getWindow: () => ({
          webContents: {
            send: (channel: string, payload: GuiWorkerPush) => sent.push({ channel, payload })
          }
        })
      },
      pushSubs: new Set(),
      // push() 现在会把消息事件同步落进 store（base.ts），夹具需提供这两个写入口。
      store: { recordDelta: vi.fn(), recordToolPart: vi.fn() }
    } as unknown as HostCore;

    push(host, {
      kind: 'sync', sessionId: 'session-a', messages: [], before: 0, total: 0, hasEarlier: false
    });
    push(host, {
      kind: 'delta', sessionId: 'session-a', messageId: 'm1', partIndex: 0,
      deltaKind: 'text', delta: 'a'
    });
    push(host, { kind: 'context', sessionId: 'session-a', usage: null });

    expect(sent.map(item => item.channel)).toEqual(['agentSession:event', 'agentSession:event', 'agentSession:event']);
    expect(sent[0]?.payload.liveSeq).toBe(1);
    expect(sent[1]?.payload.liveSeq).toBe(2);
    expect(sent[2]?.payload.liveSeq).toBeUndefined();
    expect(sent[0]?.payload.messagesVersion).toMatch(/^[0-9a-f-]+:1$/i);
    expect(sent[1]?.payload.messagesVersion).toMatch(/^[0-9a-f-]+:2$/i);
  });
});
