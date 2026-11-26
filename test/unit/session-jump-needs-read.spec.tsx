/**
 * 跳转会话的已读合同（组件级）：
 * - 渲染层入口一律 `jumpToSession`（看板卡片 / 左栏 / 回放 / 通知历史条目）；
 * - 主进程系统 toast / 通知中心点击走 sessions.select → sessions:reveal，
 *   StoreProvider 稳定订阅标已读（不挂在 App 切页 effect 上）。
 * 自查：去掉 jumpToSession 里的 markNeedsRead，点卡片应仍未读；
 * 去掉 StoreProvider 的 subscribeRevealNeedsRead，emit reveal 应仍未读。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider, useWorkspaceStore } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { isNeedsRead, retainNeedsRead, useNeedsRead } from '../../src/renderer/src/panels/needsReadStore';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { jumpToSession } from '../../src/renderer/src/sessionJump';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function needsSession(id: string, name: string, workspaceId = 'ws-a'): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId,
    status: 'running',
    lifecycle: 'idle',
    phase: { value: 'needs_you', source: 'model', ts: 1 }
  };
}

function seed(sessions: SessionMeta[] = []): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
  mock.override('sessions.list', () =>
    Promise.resolve({ sessions, activeId: sessions[0]?.id ?? null })
  );
}

function renderBoard(sessions: SessionMeta[] = []): void {
  seed(sessions);
  render(
    <StoreProvider>
      <BoardPanel />
    </StoreProvider>
  );
}

function NeedsReadProbe({ id }: { id: string }): React.JSX.Element {
  const read = useNeedsRead();
  return <div data-testid="needs-read" data-read={read.has(id) ? 'yes' : 'no'} />;
}

/** 通知历史条目：与看板/左栏同一套 jumpToSession，禁止另写 select */
function NotifyHistoryItem({
  sessionId,
  workspaceId
}: {
  sessionId: string;
  workspaceId: string;
}): React.JSX.Element {
  const { activeWorkspaceId, switchWorkspace } = useWorkspaceStore();
  return (
    <button
      type="button"
      onClick={() => {
        void jumpToSession({
          sessionId,
          workspaceId,
          activeWorkspaceId,
          switchWorkspace
        });
      }}
    >
      打开会话
    </button>
  );
}

beforeEach(() => {
  retainNeedsRead([]);
  setFilterActiveWorkspace(false);
  setFreeViewMode('status');
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      })) as typeof window.matchMedia;
  }
});

describe('jumpToSession 已读合同', () => {
  it('成功跳转即已读，并调用 sessions.select', async () => {
    seed([needsSession('s-need', '等验收')]);
    expect(isNeedsRead('s-need')).toBe(false);
    await jumpToSession({ sessionId: 's-need' });
    expect(isNeedsRead('s-need')).toBe(true);
    expect(currentApiMock().mockOf('sessions.select')).toHaveBeenCalledWith('s-need');
  });

  it('切区失败不算已读、不 select', async () => {
    currentApiMock().override('workspaces.switch', () =>
      Promise.resolve({ ok: false, message: '已关闭' })
    );
    const r = await jumpToSession({
      sessionId: 's-need',
      workspaceId: 'ws-b',
      activeWorkspaceId: 'ws-a',
      switchWorkspace: (id) => window.api.workspaces.switch(id)
    });
    expect(r.ok).toBe(false);
    expect(isNeedsRead('s-need')).toBe(false);
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
  });
});

describe('看板 / 通知历史 / 系统 reveal 同一套已读', () => {
  it('点看板需要你卡片：未 emit reveal 也标已读', async () => {
    renderBoard([needsSession('s-need', '等验收')]);
    await waitFor(() => {
      expect(document.querySelector('.board-column[data-zone="needsYou"] .board-card')).toBeTruthy();
    });
    const card = document.querySelector('.board-column[data-zone="needsYou"] .board-card');
    expect(card?.getAttribute('data-needs')).toBe('unread');

    fireEvent.click(card as HTMLElement);

    await waitFor(() => {
      expect(
        document.querySelector('.board-column[data-zone="needsYou"] .board-card')?.getAttribute('data-needs')
      ).toBe('read');
    });
    expect(isNeedsRead('s-need')).toBe(true);
    expect(currentApiMock().mockOf('sessions.select')).toHaveBeenCalledWith('s-need');
  });

  it('点通知历史条目：与看板同一 jumpToSession，标已读', async () => {
    const user = userEvent.setup();
    seed([needsSession('s-need', '等验收')]);
    render(
      <StoreProvider>
        <NotifyHistoryItem sessionId="s-need" workspaceId="ws-a" />
      </StoreProvider>
    );
    expect(isNeedsRead('s-need')).toBe(false);

    await user.click(screen.getByRole('button', { name: '打开会话' }));

    await waitFor(() => {
      expect(isNeedsRead('s-need')).toBe(true);
    });
    expect(currentApiMock().mockOf('sessions.select')).toHaveBeenCalledWith('s-need');
  });

  it('主进程系统通知 reveal（通知中心点击）：StoreProvider 订阅后标已读', async () => {
    seed();
    render(
      <StoreProvider>
        <NeedsReadProbe id="s-need" />
      </StoreProvider>
    );
    expect(screen.getByTestId('needs-read').getAttribute('data-read')).toBe('no');

    act(() => {
      currentApiMock().emit('sessions:reveal', { sessionId: 's-need' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('needs-read').getAttribute('data-read')).toBe('yes');
    });
    expect(isNeedsRead('s-need')).toBe(true);
  });
});
