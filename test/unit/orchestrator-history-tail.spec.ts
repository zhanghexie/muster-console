import { describe, expect, it, vi } from 'vitest';
import { compactHistoryForRenderer, emit, publishHistoryRange } from '../../src/main/agent/orchestrator/eventBus';
import type { OrchestratorHost } from '../../src/main/agent/orchestrator/internal';
import type { ChatMessage } from '../../src/shared/types';

const message = (id: number): ChatMessage => ({
  id: `m-${id}`,
  role: 'assistant',
  content: `message ${id}`,
  createdAt: id
});

describe('调度历史渲染推送尾部窗口', () => {
  it('只复制最近 120 条并附带范围游标，原始事件保持完整', () => {
    const messages = Array.from({ length: 150 }, (_, index) => message(index));
    const payload = { workspaceId: 'ws', messages };

    const compacted = compactHistoryForRenderer(payload) as {
      workspaceId: string;
      messages: ChatMessage[];
      before: number;
      total: number;
      hasEarlier: boolean;
    };

    expect(compacted.workspaceId).toBe('ws');
    expect(compacted.messages).toHaveLength(120);
    expect(compacted.messages[0]?.id).toBe('m-30');
    expect(compacted.messages.at(-1)?.id).toBe('m-149');
    expect(compacted.before).toBe(30);
    expect(compacted.total).toBe(150);
    expect(compacted.hasEarlier).toBe(true);
    expect(payload.messages).toHaveLength(150);
  });

  it('已经是范围页的事件不二次裁剪', () => {
    const messages = Array.from({ length: 120 }, (_, index) => message(index + 30));
    const payload = {
      workspaceId: 'ws',
      messages,
      before: 30,
      total: 150,
      hasEarlier: true
    };

    expect(compactHistoryForRenderer(payload)).toBe(payload);
  });

  it('消息事件按工作区分配单调 eventSeq，元数据事件不抢占游标', () => {
    const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    const host = {
      eventListeners: new Set(),
      ctx: { getWindow: () => ({ webContents: { send: (channel: string, payload: Record<string, unknown>) => sent.push({ channel, payload }) } }) }
    } as unknown as OrchestratorHost;

    emit(host, 'agent:token', { workspaceId: 'ws-a', messageId: 'm', token: 'a' });
    emit(host, 'agent:thinking', { workspaceId: 'ws-a', messageId: 'm', token: 'b' });
    emit(host, 'agent:message', { workspaceId: 'ws-b', id: 'm-b', role: 'assistant', content: 'b' });
    emit(host, 'agent:tool', { workspaceId: 'ws-a', messageId: 'm', toolCall: {} });
    emit(host, 'agent:done', { workspaceId: 'ws-a', message: { id: 'm' } });
    emit(host, 'agent:history', { workspaceId: 'ws-a', messages: [] });

    expect(sent.map((item) => item.payload.eventSeq)).toEqual([1, 2, 1, 3, 4, 5]);
    expect(sent.map((item) => item.channel)).toEqual([
      'agent:token', 'agent:thinking', 'agent:message', 'agent:tool', 'agent:done', 'agent:history'
    ]);
  });
  it('publishes a browsing page without recording a durable replacement even for a hot bucket',()=>{
    const recordDisplayEvent=vi.fn(()=>{throw new Error('a browsing page must never replace durable history');});
    const send=vi.fn(),listener=vi.fn();
    const host={buckets:new Map([['ws',{display:Array.from({length:1000},(_,index)=>message(index)),schedulerSession:{recordDisplayEvent}}]]),
      eventListeners:new Set([listener]),ctx:{getWindow:()=>({webContents:{send}})}} as unknown as OrchestratorHost;
    const page={messages:Array.from({length:12},(_,index)=>message(index+988)),before:988,total:1000,hasEarlier:true};
    publishHistoryRange(host,'ws',page);
    expect(recordDisplayEvent).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith('agent:history',{...page,workspaceId:'ws'});
    expect(send).toHaveBeenCalledWith('agent:history',expect.objectContaining({...page,workspaceId:'ws',eventSeq:1}));
  });

});
