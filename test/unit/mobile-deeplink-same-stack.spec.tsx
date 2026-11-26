/**
 * MobileApp deepLinkSession 同栈等价短路（mobile-surface F-01）组件级回归：
 * needs_you 抽屉点「当前正在看的会话」时不重排栈（同 key 双实例闪切 + 数据重取），
 * 只补 jumpToSession 选中；目标与当前栈不同时仍整栈深链重排。
 */
import React, { useEffect } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { MobileApp } from '../../src/renderer/src/mobile/MobileApp';
import { persistNav } from '../../src/renderer/src/mobile/nav';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const jumpToSession = vi.hoisted(() => vi.fn(async () => undefined));
const chatMounts = vi.hoisted(() => ({ count: 0 }));
const gateway = vi.hoisted(() => ({ connected: true, note: '' }));

vi.mock('../../src/renderer/src/sessionJump', () => ({
  jumpToSession,
  subscribeRevealNeedsRead: () => () => {}
}));
vi.mock('../../src/renderer/src/webApiShim', () => ({
  getWebGatewayStatus: () => gateway,
  subscribeWebGatewayStatus: () => () => {},
  isWebGateway: () => false,
  setWebGatewayOverlaySuppressed: vi.fn()
}));
vi.mock('../../src/renderer/src/mobile/pages/WorkspaceListPage', () => ({
  WorkspaceListPage: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}));
vi.mock('../../src/renderer/src/mobile/pages/WorkspaceDetailPage', () => ({
  WorkspaceDetailPage: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
}));
vi.mock('../../src/renderer/src/mobile/pages/ChatPage', () => ({
  ChatPage: ({ target }: { target: { kind: string; sessionId?: string } }): React.JSX.Element => {
    useEffect(() => {
      chatMounts.count += 1;
    }, []);
    const id = target.kind === 'session' ? target.sessionId : target.kind;
    return <div data-testid={`chat-${id}`} />;
  }
}));
vi.mock('../../src/renderer/src/mobile/MobileFiles', () => ({ MobileFiles: () => null }));
// 记录退场帧（active=false 的 MobilePageFrame 实例）：同栈短路时不应出现；
// 真实组件在 jsdom 下 presence(false) 立即卸载，无法从 DOM 观测，故在此计数。
const closingFrames = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/renderer/src/mobile/MobilePageFrame', () => ({
  MobilePageFrame: ({ active, top, children }: { active: boolean; top: boolean; children?: React.ReactNode }): React.JSX.Element => {
    useEffect(() => {
      if (active === false) closingFrames.count += 1;
    }, []);
    return <div aria-hidden={!top} data-frame-active={String(active)}>{children}</div>;
  }
}));
vi.mock('../../src/renderer/src/mobile/useSessionStatusPush', () => ({ useSessionStatusPush() {} }));
vi.mock('../../src/renderer/src/mobile/useHashDeepLink', () => ({ useHashDeepLink() {} }));

const WS = { id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 };

function needsYouSession(id: string): SessionMeta {
  return {
    id,
    type: 'terminal',
    name: `CLI ${id}`,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'claude-code',
    workspaceId: WS.id,
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 }
  } as SessionMeta;
}

function seedStack(currentSessionId: string): void {
  persistNav([
    { kind: 'workspaces' },
    { kind: 'workspace', wsId: WS.id },
    { kind: 'chat', wsId: WS.id, target: { kind: 'session', sessionId: currentSessionId } }
  ]);
}

function seedStores(viewing: string): void {
  localStorage.clear();
  seedStack(viewing);
  jumpToSession.mockClear();
  chatMounts.count = 0;
  closingFrames.count = 0;
  const sessions = [needsYouSession('pty-1'), needsYouSession('pty-2')];
  const api = currentApiMock();
  api.override('workspaces.list', () =>
    Promise.resolve({ workspaces: [WS], activeWorkspaceId: WS.id })
  );
  api.override('config.get', () =>
    Promise.resolve({ workspaces: [WS], activeWorkspaceId: WS.id, locale: 'zh-CN' })
  );
  api.override('sessions.list', () =>
    Promise.resolve({ sessions: viewing ? [...sessions] : sessions, activeId: viewing || null })
  );
}

async function deepLinkFromSheet(): Promise<void> {
  // badge 在 L1/L2 顶栏（非栈顶页，对 role 查询隐藏），按类名直查
  const badge = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('button.ma-badge.needs');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(badge);
  const item = await screen.findByRole('button', { name: /CLI pty-1/ });
  fireEvent.click(item);
}

describe('deepLinkSession 同栈等价短路', () => {
  it('正在看 pty-1 时深链 pty-1：不重排栈（无新 ChatPage 实例），仍补 jumpToSession 选中', async () => {
    seedStores('pty-1');
    render(
      <StoreProvider>
        <MobileApp />
      </StoreProvider>
    );
    await screen.findByTestId('chat-pty-1');
    expect(chatMounts.count).toBe(1);

    await deepLinkFromSheet();

    // 短路：无 closing 退场帧、无新页入栈 → ChatPage 实例数与退场帧数都不变
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(chatMounts.count).toBe(1);
    expect(closingFrames.count).toBe(0);
    // 选中语义保留
    expect(jumpToSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-1', workspaceId: WS.id })
    );
  });

  it('正在看 pty-2 时深链 pty-1：栈不等价，仍整栈重排（新 ChatPage 实例出现）', async () => {
    seedStores('pty-2');
    render(
      <StoreProvider>
        <MobileApp />
      </StoreProvider>
    );
    await screen.findByTestId('chat-pty-2');
    expect(chatMounts.count).toBe(1);

    await deepLinkFromSheet();

    await waitFor(() => expect(screen.getAllByTestId('chat-pty-1').length).toBeGreaterThan(0));
    expect(chatMounts.count).toBeGreaterThan(1);
    expect(closingFrames.count).toBeGreaterThanOrEqual(2);
    expect(jumpToSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty-1', workspaceId: WS.id })
    );
  });
});
