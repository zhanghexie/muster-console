import {overrideGuiHistory} from './helpers/gui-history-range';
/**
 * agentSessionSurface 整表替换 reconcile（P1-4）：attach/sync/resync（切服务商后续
 * 推送同走 sync）把 IPC 克隆的历史写入 this.messages 前先 reconcileById——未变消息
 * 复用旧引用（下游缓存与行级 memo 全走 === 命中），变更消息换新引用且内容可见。
 * 还原即红：替换点恢复直赋值后「未变消息引用保持」断言转红（IPC 克隆必换新引用）。
 * 运行: npx vitest run test/unit/agent-session-reconcile.spec.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { useAgentSessionSurface } from '../../src/renderer/src/chatSurface/agentSessionSurface';
import { currentApiMock } from './helpers/api-mock';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { GuiChatMessage } from '../../src/shared/guiWorker';

function guiMsg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  ts = 1
): GuiChatMessage {
  return {
    id,
    role,
    parts: [{ kind: 'text', text }],
    ts
  } as GuiChatMessage;
}

let historyPayload: { messages: GuiChatMessage[]; mode: 'default'; busy: boolean };

/** 快照消息是 surface 泛型擦除后的 unknown，取 id 做定位 */
const idOf = (m: unknown): string => (m as { id: string }).id;

const Harness = (props: { sessionId: string; surfaceRef: { current: ChatSurface | null } }): null => {
  const surface = useAgentSessionSurface({
    sessionId: props.sessionId,
    visible: true,
    runtimeId: 'pi'
  });
  props.surfaceRef.current = surface;
  return null;
};

describe('agentSessionSurface 整表替换 reconcile（P1-4）', () => {
  beforeEach(() => {
    const mock = currentApiMock();
    overrideGuiHistory(mock, async () => historyPayload);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      }
    );
  });

  it('resync 后变更可见且未变消息保持引用（=== 命中）', async () => {
    const v1 = [guiMsg('m1', 'user', '问题'), guiMsg('a1', 'assistant', 'v1 结论', 2)];
    historyPayload = { messages: v1, mode: 'default', busy: false };

    const surfaceRef: { current: ChatSurface | null } = { current: null };
    render(
      <StoreProvider>
        <Harness sessionId="sess-p14" surfaceRef={surfaceRef} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(surfaceRef.current?.getSnapshot().messages.length).toBe(2);
    });
    const m1Before = surfaceRef.current!.getSnapshot().messages.find((m) => idOf(m) === 'm1');
    expect(m1Before).toBeTruthy();

    // resync 兜底路径：part 推送带未知 messageId → 判定不同步 → 重拉权威历史。
    // 服务端此刻返回 v2：m1 内容未变（但为 IPC 新克隆）、a1 结论已更新
    const v2 = [guiMsg('m1', 'user', '问题'), guiMsg('a1', 'assistant', 'v2 已更新结论', 2)];
    historyPayload = { messages: v2, mode: 'default', busy: false };
    currentApiMock().emit('agentSession:event', {
      sessionId: 'sess-p14',
      kind: 'part',
      messageId: 'ghost-unknown',
      partIndex: 0,
      part: { kind: 'text', text: 'x' }
    });

    await waitFor(() => {
      const msgs = surfaceRef.current!.getSnapshot().messages;
      const a1 = msgs.find((m) => idOf(m) === 'a1') as { parts?: Array<{ text?: string }> } | undefined;
      expect(a1?.parts?.[0]?.text).toBe('v2 已更新结论'); // 变更可见
    });
    // P1-4 核心：未变的 m1 复用旧引用（reconcile 命中），不因整表替换换新对象
    const m1After = surfaceRef.current!.getSnapshot().messages.find((m) => idOf(m) === 'm1');
    expect(m1After).toBe(m1Before);
  });
});
