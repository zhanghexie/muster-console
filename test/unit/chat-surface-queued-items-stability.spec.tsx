import {overrideGuiHistory} from './helpers/gui-history-range';
import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 快照 queuedItems 引用稳定化（流式热路径手术）：
 * 两个表面（调度 orchestratorSurface / GUI agentSessionSurface）的快照在流式期每批
 * （~50ms rAF 合批）重建一次，queuedItems 若每批都 filter().map() 出新数组，排队面板
 * props 每帧换引用，键盘输入与流式叠加时长任务尖峰。因此：
 * - 空队列必须复用模块级单例（同一引用）；
 * - 非空且排队 (id,text) 未变必须复用旧数组；
 * - 队列真变（编辑/替换）必须换新数组新内容（防过度缓存）。
 * 回归：把两处还原为 filter().map()（orchestratorSurface.snapshot /
 * agentSessionSurface.getSnapshot 的 queuedItems 计算），前两条「复用引用」用例转红。
 * 运行: npx vitest run test/unit/chat-surface-queued-items-stability.spec.tsx
 */
import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import {
  getOrchestratorSurface,
  ensureOrchestratorHistory,
  resetOrchestratorListenersForTest
} from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { currentApiMock } from './helpers/api-mock';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { ChatMessage } from '../../src/shared/types';
import type { GuiChatMessage } from '../../src/shared/guiWorker';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const CONTEXT = {
  modelId: 'deepseek-chat',
  modelName: 'DeepSeek',
  provider: 'deepseek',
  tokens: null,
  contextWindow: 128000,
  percent: null
};

function seedOrchestrator(messages: ChatMessage[]): void {
  const mock = currentApiMock();
  mockHistoryRange(mock, async () => messages);
  mock.override('chat.getMode', async () => 'default');
  mock.override('chat.context', async () => CONTEXT);
}

/* ── 调度面（orchestratorSurface）── */

describe('调度面快照 queuedItems 引用稳定', () => {
  beforeEach(() => {
    resetOrchestratorListenersForTest();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('空队列：快照重建间 queuedItems 复用同一引用', async () => {
    seedOrchestrator([]);
    const mock = currentApiMock();
    const wsId = 'ws-queued-empty';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().messages).toEqual([]));
    const s1 = surface.getSnapshot();
    // 流式活动：新 assistant 占位消息落定（与排队无关的状态推送 → 快照重建）
    mock.emit('agent:message', {
      workspaceId: wsId,
      id: 'a1',
      role: 'assistant',
      content: '流式输出',
      createdAt: 1
    });
    const s2 = surface.getSnapshot();
    expect(s2.messages.length).toBe(1);
    expect(s1.queuedItems).toEqual([]);
    expect(s2.queuedItems).toBe(s1.queuedItems);
    expect(s2.queuedCount).toBe(0);
  });

  it('流式活动中排队未变：queuedItems 复用旧数组', async () => {
    seedOrchestrator([
      { id: 'a1', role: 'assistant', content: '正在回答', createdAt: 100 },
      { id: 'q1', role: 'user', content: '排队一', createdAt: 110, queued: true },
      { id: 'q2', role: 'user', content: '排队二', createdAt: 120, queued: true }
    ]);
    const mock = currentApiMock();
    const wsId = 'ws-queued-stable';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().queuedCount).toBe(2));
    const s1 = surface.getSnapshot();
    expect(s1.queuedItems.map((i) => [i.id, i.text])).toEqual([
      ['q1', '排队一'],
      ['q2', '排队二']
    ]);
    // 流式落定：assistant 内容两次被替换（排队两条不动），每批快照都重建
    mock.emit('agent:message', {
      workspaceId: wsId,
      id: 'a1',
      role: 'assistant',
      content: '正在回答+1',
      createdAt: 100
    });
    const s2 = surface.getSnapshot();
    mock.emit('agent:message', {
      workspaceId: wsId,
      id: 'a1',
      role: 'assistant',
      content: '正在回答+2',
      createdAt: 100
    });
    const s3 = surface.getSnapshot();
    expect(s2.queuedItems).toBe(s1.queuedItems);
    expect(s3.queuedItems).toBe(s1.queuedItems);
    expect(s3.queuedCount).toBe(2);
  });

  it('排队内容变化：换新数组与新内容（防过度缓存）', async () => {
    seedOrchestrator([
      { id: 'a1', role: 'assistant', content: '正在回答', createdAt: 100 },
      { id: 'q1', role: 'user', content: '排队一', createdAt: 110, queued: true },
      { id: 'q2', role: 'user', content: '排队二', createdAt: 120, queued: true }
    ]);
    const mock = currentApiMock();
    const wsId = 'ws-queued-change';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().queuedCount).toBe(2));
    const s1 = surface.getSnapshot();
    // editQueued 的落定形态：排队消息被整体替换（同 id 新内容）
    mock.emit('agent:message', {
      workspaceId: wsId,
      id: 'q2',
      role: 'user',
      content: '排队二（已改）',
      createdAt: 120,
      queued: true
    });
    const s2 = surface.getSnapshot();
    expect(s2.queuedItems).not.toBe(s1.queuedItems);
    expect(s2.queuedItems[0]).toEqual({ id: 'q1', text: '排队一' });
    expect(s2.queuedItems[1]).toEqual({ id: 'q2', text: '排队二（已改）' });
    expect(s2.queuedCount).toBe(2);
  });

  it('排队带图：imageCount 进入条目且随图片变化换新数组', async () => {
    seedOrchestrator([
      {
        id: 'q1',
        role: 'user',
        content: '看图',
        createdAt: 110,
        queued: true,
        images: [
          { id: 'im1', data: 'a', mimeType: 'image/png' },
          { id: 'im2', data: 'b', mimeType: 'image/png' }
        ]
      }
    ]);
    const mock = currentApiMock();
    const wsId = 'ws-queued-img';
    const surface = getOrchestratorSurface(wsId);
    ensureOrchestratorHistory(wsId);
    await waitFor(() => expect(surface.getSnapshot().queuedCount).toBe(1));
    const s1 = surface.getSnapshot();
    expect(s1.queuedItems).toEqual([
      {
        id: 'q1',
        text: '看图',
        imageCount: 2,
        imagePreviews: [
          { id: 'im1', url: 'data:image/png;base64,a' },
          { id: 'im2', url: 'data:image/png;base64,b' }
        ]
      }
    ]);
    // 同 id 内容不变但图片数变化：不得命中缓存
    mock.emit('agent:message', {
      workspaceId: wsId,
      id: 'q1',
      role: 'user',
      content: '看图',
      createdAt: 110,
      queued: true,
      images: [{ id: 'im1', data: 'a', mimeType: 'image/png' }]
    });
    const s2 = surface.getSnapshot();
    expect(s2.queuedItems).not.toBe(s1.queuedItems);
    expect(s2.queuedItems).toEqual([
      {
        id: 'q1',
        text: '看图',
        imageCount: 1,
        imagePreviews: [{ id: 'im1', url: 'data:image/png;base64,a' }]
      }
    ]);
  });
});

/* ── GUI 会话面（agentSessionSurface）── */

function SessionHarness(props: {
  sessionId: string;
  surfaceRef: { current: ChatSurface | null };
}): null {
  const surface = useAgentSessionSurface({
    sessionId: props.sessionId,
    visible: true,
    runtimeId: 'pi'
  });
  props.surfaceRef.current = surface;
  return null;
}

function guiMsg(m: Partial<GuiChatMessage> & { id: string; role: 'user' | 'assistant' }): GuiChatMessage {
  return {
    parts: [{ kind: 'text', text: '' }],
    ts: 1,
    ...m
  } as GuiChatMessage;
}

function seedSession(messages: GuiChatMessage[]): void {
  overrideGuiHistory(currentApiMock(), async () => ({
    messages,
    mode: 'default',
    busy: true
  }));
}

describe('GUI 会话面快照 queuedItems 引用稳定', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('空队列：快照重建间 queuedItems 复用同一引用', async () => {
    seedSession([guiMsg({ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '回答中' }] })]);
    const mock = currentApiMock();
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    render(
      <StoreProvider>
        <SessionHarness sessionId="sess-queued-empty" surfaceRef={surfaceRef} />
      </StoreProvider>
    );
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().messages.length).toBe(1));
    const s1 = surfaceRef.current!.getSnapshot();
    // 流式活动：assistant 消息追加一个 part（与排队无关 → 快照重建）
    mock.emit('agentSession:event', {
      sessionId: 'sess-queued-empty',
      kind: 'part',
      messageId: 'a1',
      partIndex: 1,
      part: { kind: 'text', text: '更多' }
    });
    const s2 = surfaceRef.current!.getSnapshot();
    expect(s2.queuedItems).toEqual([]);
    expect(s2.queuedItems).toBe(s1.queuedItems);
    expect(s2.queuedCount).toBe(0);
  });

  it('流式活动中排队未变：queuedItems 复用旧数组', async () => {
    seedSession([
      guiMsg({ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '回答中' }] }),
      guiMsg({
        id: 'q1',
        role: 'user',
        parts: [{ kind: 'text', text: '排队一' }],
        queued: true,
        ts: 2
      })
    ]);
    const mock = currentApiMock();
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    render(
      <StoreProvider>
        <SessionHarness sessionId="sess-queued-stable" surfaceRef={surfaceRef} />
      </StoreProvider>
    );
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().queuedCount).toBe(1));
    const s1 = surfaceRef.current!.getSnapshot();
    expect(s1.queuedItems).toEqual([{ id: 'q1', text: '排队一' }]);
    // 流式落定两次：assistant 各追加一个 part，排队消息不动
    mock.emit('agentSession:event', {
      sessionId: 'sess-queued-stable',
      kind: 'part',
      messageId: 'a1',
      partIndex: 1,
      part: { kind: 'text', text: '+1' }
    });
    const s2 = surfaceRef.current!.getSnapshot();
    mock.emit('agentSession:event', {
      sessionId: 'sess-queued-stable',
      kind: 'part',
      messageId: 'a1',
      partIndex: 2,
      part: { kind: 'text', text: '+2' }
    });
    const s3 = surfaceRef.current!.getSnapshot();
    expect(s2.queuedItems).toBe(s1.queuedItems);
    expect(s3.queuedItems).toBe(s1.queuedItems);
    expect(s3.queuedCount).toBe(1);
  });

  it('排队内容变化：换新数组与新内容（防过度缓存）', async () => {
    seedSession([
      guiMsg({ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '回答中' }] }),
      guiMsg({
        id: 'q1',
        role: 'user',
        parts: [{ kind: 'text', text: '排队一' }],
        queued: true,
        ts: 2
      })
    ]);
    const mock = currentApiMock();
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    render(
      <StoreProvider>
        <SessionHarness sessionId="sess-queued-change" surfaceRef={surfaceRef} />
      </StoreProvider>
    );
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().queuedCount).toBe(1));
    const s1 = surfaceRef.current!.getSnapshot();
    // editQueued 的落定形态：全量 sync 带回改过的排队消息
    mock.emit('agentSession:event', {
      sessionId: 'sess-queued-change',
      kind: 'sync',
      messages: [
        guiMsg({ id: 'a1', role: 'assistant', parts: [{ kind: 'text', text: '回答中' }] }),
        guiMsg({
          id: 'q1',
          role: 'user',
          parts: [{ kind: 'text', text: '排队一（已改）' }],
          queued: true,
          ts: 2
        })
      ]
    });
    const s2 = surfaceRef.current!.getSnapshot();
    expect(s2.queuedItems).not.toBe(s1.queuedItems);
    expect(s2.queuedItems).toEqual([{ id: 'q1', text: '排队一（已改）' }]);
    expect(s2.queuedCount).toBe(1);
  });

  it('排队带图：imageCount 进入条目', async () => {
    seedSession([
      guiMsg({
        id: 'q1',
        role: 'user',
        parts: [{ kind: 'text', text: '看图' }],
        queued: true,
        ts: 2,
        images: [{ id: 'im1', data: 'a', mimeType: 'image/png' }]
      })
    ]);
    const surfaceRef: { current: ChatSurface | null } = { current: null };
    render(
      <StoreProvider>
        <SessionHarness sessionId="sess-queued-img" surfaceRef={surfaceRef} />
      </StoreProvider>
    );
    await waitFor(() => expect(surfaceRef.current?.getSnapshot().queuedCount).toBe(1));
    expect(surfaceRef.current!.getSnapshot().queuedItems).toEqual([
      {
        id: 'q1',
        text: '看图',
        imageCount: 1,
        imagePreviews: [{ id: 'im1', url: 'data:image/png;base64,a' }]
      }
    ]);
  });
});
