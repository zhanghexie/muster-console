import { mockHistoryRange } from './helpers/chat-history-mock';
/**
 * 调度面会话批注：caps.notes + notesHost 注入后 selArea 走 gui-chat，
 * 角标/操作行可见，发送经 expandForSend 展开 token。
 * 回归：去掉 caps.notes、调度转写不铺 noteTranscriptProps、或 expand 不进 send，本文件应转红。
 * 运行: npx vitest run test/unit/orchestrator-notes.spec.tsx
 */
import React, { useRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { getOrchestratorSurface } from '../../src/renderer/src/chatSurface/orchestratorSurface';
import { useSessionNotes, type SessionNotesHost } from '../../src/renderer/src/chatSurface/useSessionNotes';
import { deliverFileNote } from '../../src/renderer/src/agentChat/noteBridge';
import { getDraft, replaceDraft } from '../../src/renderer/src/composerDrafts';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import { expandNoteTokens } from '../../src/shared/noteAnnotations';
import type { ChatSurface } from '../../src/shared/chatSurface';
import type { ChatMessage } from '../../src/shared/types';

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
);

const messages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '看这段', createdAt: 100 },
  {
    id: 'a1',
    role: 'assistant',
    content: '这段可以批注',
    createdAt: 200,
    parts: [{ kind: 'text', text: '这段可以批注' }]
  }
];

const notes = [{ id: 'n1', seq: 1, quote: '这段可以批注', note: '请展开看', messageId: 'a1' }];

function makeNotesHost(overrides: Partial<SessionNotesHost> = {}): SessionNotesHost {
  return {
    notes,
    pendingNote: null,
    onNoteUpdate: vi.fn(),
    onNoteDelete: vi.fn(),
    onPendingConfirm: vi.fn(),
    onPendingCancel: vi.fn(),
    tokens: [{ id: 'n1', token: '批注1', title: '这段可以批注' }],
    onTokenClick: vi.fn(),
    onTokenDelete: vi.fn(),
    openNoteId: null,
    onOpenNote: vi.fn(),
    onValueChange: vi.fn(),
    expandForSend: (text) => expandNoteTokens(text, notes),
    ...overrides
  };
}

function makeDispatchSurface(opts: {
  notes?: boolean;
  send?: ChatSurface['actions']['send'];
}): ChatSurface {
  const snap = {
    messages,
    busy: false,
    queuedCount: 0,
    queuedItems: [],
    status: null,
    mode: null as null,
    preset: null
  };
  return {
    sessionId: 'ws-orch-notes',
    caps: {
      surfaceKind: 'dispatch',
      draftKey: 'ws-orch-notes',
      images: false,
      notes: opts.notes
    },
    subscribe: () => () => undefined,
    getSnapshot: () => snap,
    actions: {
      send: opts.send ?? (async () => true),
      stop: () => undefined,
      clear: async () => undefined,
      retry: () => undefined,
      cancelQueued: () => undefined
    }
  };
}

function NotesDraftHarness(props: { sessionId: string; draftKey?: string }): React.JSX.Element {
  const viewRef = useRef<HTMLDivElement>(null);
  useSessionNotes({
    sessionId: props.sessionId,
    draftKey: props.draftKey,
    getMessageRole: () => 'assistant',
    viewRef,
    flashTip: () => undefined,
    requestOpenWorkspaceFile: () => undefined
  });
  return <div ref={viewRef} />;
}

describe('调度面会话批注', () => {
  beforeEach(() => {
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('orchestratorSurface caps.notes 开启', () => {
    mockHistoryRange(currentApiMock(), async () => []);
    currentApiMock().override('chat.getMode', async () => 'default');
    currentApiMock().override('chat.context', async () => ({
      modelId: 'm',
      modelName: 'm',
      provider: 'p',
      tokens: null,
      contextWindow: 1,
      percent: null
    }));
    const surface = getOrchestratorSurface('ws-orch-notes-caps');
    expect(surface.caps.notes).toBe(true);
    expect(surface.caps.draftKey).toBe('ws-orch-notes-caps');
  });

  it('注入 notesHost 后 selArea=gui-chat，操作行出现批注N', () => {
    const { container } = render(
      <StoreProvider>
        <ChatSurfaceView
          surface={makeDispatchSurface({ notes: true })}
          workspaceId="ws-orch-notes"
          notesHost={makeNotesHost()}
        />
      </StoreProvider>
    );
    expect(container.querySelector('[data-sel-area]')?.getAttribute('data-sel-area')).toBe(
      'gui-chat'
    );
    expect(screen.getByRole('button', { name: '批注1' })).toBeTruthy();
  });

  it('有 caps.notes 但未注入 notesHost 时 selArea 仍是 agent-chat', () => {
    const { container } = render(
      <StoreProvider>
        <ChatSurfaceView
          surface={makeDispatchSurface({ notes: true })}
          workspaceId="ws-orch-notes"
        />
      </StoreProvider>
    );
    expect(container.querySelector('[data-sel-area]')?.getAttribute('data-sel-area')).toBe(
      'agent-chat'
    );
    expect(screen.queryByRole('button', { name: '批注1' })).toBeNull();
  });

  it('发送经 expandForSend 把批注1 展开再走 send', async () => {
    const sent: string[] = [];
    replaceDraft('ws-orch-notes', '请看 批注1');
    render(
      <StoreProvider>
        <ChatSurfaceView
          surface={makeDispatchSurface({
            notes: true,
            send: async (text) => {
              sent.push(text);
              return true;
            }
          })}
          workspaceId="ws-orch-notes"
          notesHost={makeNotesHost()}
        />
      </StoreProvider>
    );
    await waitFor(() => {
      expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(
        false
      );
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toBe('请看 [会话批注] 原文：“这段可以批注”；用户批注：请展开看');
  });

  it('draftKey 写入调度草稿桶，而不是 agent-session: 前缀', async () => {
    replaceDraft('ws-orch-notes-draft', '');
    replaceDraft('agent-session:ws-orch-notes-draft', '');
    render(
      <NotesDraftHarness sessionId="ws-orch-notes-draft" draftKey="ws-orch-notes-draft" />
    );
    await waitFor(() => {
      const seq = deliverFileNote('ws-orch-notes-draft', {
        quote: '选中的文件行',
        path: 'src/a.ts',
        line: 3,
        endLine: 3,
        markKey: null,
        note: '调度草稿',
        noteId: 'file-n1'
      });
      expect(seq).toBe(1);
    });
    expect(getDraft('ws-orch-notes-draft')).toContain('批注1');
    expect(getDraft('agent-session:ws-orch-notes-draft')).toBe('');
  });
});
