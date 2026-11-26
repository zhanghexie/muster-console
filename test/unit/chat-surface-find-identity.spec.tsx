import React from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { StoreProvider } from '../../src/renderer/src/store';
import { chatFindIdFor } from '../../src/renderer/src/chatSurface/useChatFind';
import type { ChatSurface, ChatSurfaceKind, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';
import { currentApiMock } from './helpers/api-mock';

type FindIdentity = { messageId: string; indexInMessage: number };
type TranscriptProps = {
  findActive: FindIdentity | null;
  interactionActive: boolean;
  sessionId: string;
  messages: readonly unknown[];
  model: { toDisplay: (message: unknown) => { content: string } };
};
const fixture = vi.hoisted(() => ({
  owner: true,
  hit: null as null | { sessionId: string; messageId: string; indexInMessage: number },
  transcripts: [] as TranscriptProps[],
  composers: [] as Array<{ reminders?: React.ReactElement<{ kind: string; id: string; visible: boolean }> | null }>,
  activeEffects: 0
}));
vi.mock('../../src/renderer/src/chatSurface/useChatFind', async importOriginal => {
  const original = await importOriginal<typeof import('../../src/renderer/src/chatSurface/useChatFind')>();
  return { ...original, useChatFind: () => ({
    open: true, isOwner: fixture.owner, query: 'needle', scope: 'current', hits: [], groups: [], activeIndex: 0,
    // The upstream search can return an equivalent hit object on every snapshot.
    activeHit: fixture.hit ? { ...fixture.hit } : null,
    setQuery: () => {}, toggleScope: () => {}, go: () => {}, close: () => {}, jumpToHit: () => {}, focusEpoch: 0
  }) };
});
vi.mock('../../src/renderer/src/chatSurface/ChatTranscript', async () => {
  const React = await import('react');
  return { ChatTranscript: (props: TranscriptProps) => {
    fixture.transcripts.push(props);
    // Production paintFindMarks depends on findActive identity. This records
    // exactly that invalidation contract while retaining the real parent binding.
    React.useLayoutEffect(() => { fixture.activeEffects++; }, [props.findActive]);
    return null;
  } };
});
vi.mock('../../src/renderer/src/components/AgentComposer', () => ({ AgentComposer: (props: { reminders?: React.ReactElement<{ kind: string; id: string; visible: boolean }> | null }) => {
  fixture.composers.push(props); return null;
} }));
vi.mock('../../src/renderer/src/chatSurface/ChatFindBar', () => ({ ChatFindBar: () => null }));

const latest = () => fixture.transcripts.at(-1)!;
function makeSurface(kind: ChatSurfaceKind): { surface: ChatSurface; publish: (patch: Partial<ChatSurfaceSnapshot>) => void } {
  let snapshot: ChatSurfaceSnapshot = {
    messages: kind === 'gui-session'
      ? [{ id: 'm1', role: 'user', parts: [{ kind: 'text', text: 'needle' }], ts: 1 }]
      : [{ id: 'm1', role: 'user', content: 'needle', createdAt: 1 }],
    busy: false, queuedItems: [], queuedCount: 0, status: null, mode: null, preset: null
  };
  const subscribers = new Set<() => void>();
  return {
    surface: {
      sessionId: 'surface-1', caps: { surfaceKind: kind, draftKey: 'surface-1' },
      subscribe: listener => { subscribers.add(listener); return () => subscribers.delete(listener); },
      getSnapshot: () => snapshot,
      actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} }
    },
    publish: patch => { snapshot = { ...snapshot, ...patch }; for (const listener of subscribers) listener(); }
  };
}

beforeEach(() => {
  fixture.owner = true; fixture.hit = null; fixture.transcripts = []; fixture.composers = []; fixture.activeEffects = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const api = currentApiMock();
  api.override('config.get', async () => ({ workspaces: [], locale: 'zh-CN' }));
  api.override('workspaces.list', async () => ({ workspaces: [], activeWorkspaceId: null }));
  api.override('sessions.list', async () => ({ sessions: [], activeId: null }));
  api.override('runtimes.list', async () => []);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(['gui-session', 'dispatch'] as const)('真实 ChatSurfaceView %s 查找接线', kind => {
  it('将当前会话待办交给输入框底栏，并尊重会话可见性与禁用项', () => {
    const { surface } = makeSurface(kind);
    const tree = (active: boolean, enabled = true) => <StoreProvider><ChatSurfaceView surface={surface}
      workspaceId="ws-reminders" interactionActive={active} remindersEnabled={enabled}/></StoreProvider>;
    const view = render(tree(true));
    let reminder = fixture.composers.at(-1)?.reminders;
    expect(reminder?.props).toMatchObject({ kind: kind === 'dispatch' ? 'scheduler' : 'session',
      id: kind === 'dispatch' ? 'ws-reminders' : 'surface-1', visible: true });
    expect(view.container.querySelector('.session-reminder-overlay')).toBeNull();
    view.rerender(tree(false));
    reminder = fixture.composers.at(-1)?.reminders;
    expect(reminder?.props.visible).toBe(false);
    view.rerender(tree(true, false));
    expect(fixture.composers.at(-1)?.reminders).toBeNull();
  });
  it('相同命中在状态快照和父层重渲中保持引用，新消息/命中序号立即更新，失主或会话不符归 null', async () => {
    const { surface, publish } = makeSurface(kind);
    const ownSessionId = chatFindIdFor(kind, surface.sessionId);
    fixture.hit = { sessionId: ownSessionId, messageId: 'm1', indexInMessage: 0 };
    const tree = (className = '') => <StoreProvider><ChatSurfaceView surface={surface} className={className}/></StoreProvider>;
    const view = render(tree());
    await act(async () => {});
    const first = latest().findActive;
    expect(first).toEqual({ messageId: 'm1', indexInMessage: 0 });
    const effects = fixture.activeEffects;
    const renders = fixture.transcripts.length;
    act(() => publish({ status: { modelLabel: 'Updated status' } }));
    view.rerender(tree('parent-refresh'));
    expect(fixture.transcripts.length).toBeGreaterThan(renders);
    expect(latest().findActive).toBe(first);
    expect(fixture.activeEffects).toBe(effects);
    expect(latest().model.toDisplay(latest().messages[0]).content).toBe('needle');

    fixture.hit = { ...fixture.hit!, indexInMessage: 1 };
    view.rerender(tree());
    const second = latest().findActive;
    expect(second).not.toBe(first);
    expect(second).toEqual({ messageId: 'm1', indexInMessage: 1 });
    expect(fixture.activeEffects).toBe(effects + 1);
    fixture.hit = { ...fixture.hit, messageId: 'm2' };
    view.rerender(tree());
    expect(latest().findActive).toEqual({ messageId: 'm2', indexInMessage: 1 });
    expect(latest().findActive).not.toBe(second);

    fixture.owner = false;
    view.rerender(tree());
    expect(latest().findActive).toBeNull();
    fixture.owner = true; fixture.hit = { ...fixture.hit, sessionId: 'another-surface' };
    view.rerender(tree());
    expect(latest().findActive).toBeNull();
    fixture.hit = { ...fixture.hit, sessionId: ownSessionId };
    view.rerender(tree());
    expect(latest().findActive).toEqual({ messageId: 'm2', indexInMessage: 1 });
    fixture.hit = null;
    view.rerender(tree());
    expect(latest().findActive).toBeNull();
  });

  it('活跃状态按壳/live/disabled 透传，切会话仍传新sessionId且相同消息身份不用重建', async () => {
    const { surface } = makeSurface(kind);
    fixture.hit = { sessionId: chatFindIdFor(kind, surface.sessionId), messageId: 'm1', indexInMessage: 0 };
    const tree = (current = surface, props: Partial<React.ComponentProps<typeof ChatSurfaceView>> = {}) =>
      <StoreProvider><ChatSurfaceView surface={current} {...props}/></StoreProvider>;
    const view = render(tree());
    await act(async () => {});
    expect(latest().interactionActive).toBe(true);
    const active = latest().findActive;
    for (const props of [{ interactionActive: false }, { live: false }, { disabled: true }]) {
      view.rerender(tree(surface, props));
      expect(latest().interactionActive).toBe(false);
      expect(latest().findActive).toBe(active);
    }
    view.rerender(tree());
    expect(latest().interactionActive).toBe(true);
    const moved = { ...surface, sessionId: 'surface-2' };
    fixture.hit = { ...fixture.hit!, sessionId: chatFindIdFor(kind, moved.sessionId) };
    view.rerender(tree(moved));
    expect(latest().sessionId).toBe('surface-2');
    expect(latest().findActive).toBe(active);
    fixture.hit = { ...fixture.hit, sessionId: chatFindIdFor(kind, surface.sessionId) };
    view.rerender(tree(moved));
    expect(latest().findActive).toBeNull();
  });
});
