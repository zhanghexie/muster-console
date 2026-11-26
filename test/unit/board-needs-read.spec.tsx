/**
 * 全局看板两处细节：
 * 1. 「需要你」卡片已读/未读必须在 UI 上可区分（data-needs + 未读点 + 列头「N 未读」）；
 * 2. 工作区过滤菜单支持多选，并提供快速选择入口。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { markNeedsRead, retainNeedsRead } from '../../src/renderer/src/panels/needsReadStore';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function needsSession(id: string, name: string): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
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

const cardBase = {
  sessionId: 's1',
  name: '验收会话',
  runtimeLabel: 'pi',
  relTimeTs: Date.now(),
  isActive: false,
  onSelect: () => {},
  onContextMenu: () => {}
};

beforeEach(() => {
  retainNeedsRead([]);
  setFilterActiveWorkspace(false);
  setFreeViewMode('status');
});

describe('看板卡片需要你已读/未读（组件级）', () => {
  it('未读：data-needs=unread、有未读点、图标仍呼吸', () => {
    const { container } = render(<BoardCard {...cardBase} status="waiting" needsUnread />);
    const card = container.querySelector('.board-card');
    expect(card?.getAttribute('data-needs')).toBe('unread');
    expect(card?.classList.contains('is-needs-unread')).toBe(true);
    expect(container.querySelector('.board-card-unread-pip')).toBeTruthy();
    expect(container.querySelector('.session-state-slot svg')).toBeTruthy();
  });

  it('已读：data-needs=read、无未读点、带 is-needs-read', () => {
    const { container } = render(<BoardCard {...cardBase} status="waiting" needsUnread={false} />);
    const card = container.querySelector('.board-card');
    expect(card?.getAttribute('data-needs')).toBe('read');
    expect(card?.classList.contains('is-needs-read')).toBe(true);
    expect(container.querySelector('.board-card-unread-pip')).toBeNull();
  });

  it('非需要你列不传 needsUnread：无 data-needs、无未读点', () => {
    const { container } = render(<BoardCard {...cardBase} status="working" />);
    expect(container.querySelector('.board-card')?.getAttribute('data-needs')).toBeNull();
    expect(container.querySelector('.board-card-unread-pip')).toBeNull();
    expect(container.querySelector('.is-needs-unread')).toBeNull();
    expect(container.querySelector('.is-needs-read')).toBeNull();
  });
});

describe('全局看板已读观感与过滤开关（组件级）', () => {
  it('已读会话可从看板右键标记未读，不跳转会话，并恢复未读提醒', async () => {
    renderBoard([needsSession('s-need', '等验收')]);
    const name = await screen.findByText('等验收', { selector: '.board-column .board-card-name' });
    const card = name.closest('.board-card')!;
    act(() => markNeedsRead('s-need'));
    expect(card.getAttribute('data-needs')).toBe('read');
    fireEvent.contextMenu(card);
    fireEvent.click(await screen.findByText('标记未读'));
    await waitFor(() => expect(card.getAttribute('data-needs')).toBe('unread'));
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
  });
  it('底栏只显示数量，文字不再轮播、跳转或标记已读', async () => {
    renderBoard([needsSession('ticker-a', '第一项'), needsSession('ticker-b', '第二项')]);
    await screen.findByText('第一项', { selector: '.board-column .board-card-name' });
    const ticker = document.querySelector('.board-ticker')!;
    expect(ticker.textContent).toContain('2 个需要处理 · 2 未读');
    expect(ticker.querySelector('button')).toBeNull();
    expect(ticker.querySelector('.board-ticker-track')).toBeNull();
    fireEvent.click(ticker.querySelector('span')!);
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
    expect(ticker.textContent).toContain('2 未读');
  });

  it('需要你列：默认未读；markNeedsRead 后切已读并去掉列头未读数', async () => {
    renderBoard([needsSession('s-need', '等验收')]);
    // 状态列和隐藏的自由画布都常驻，等两份卡片就绪后只定位本用例检查的状态列。
    await waitFor(() => expect(document.querySelector('.fc-node[data-cnode="s-need"]')).toBeTruthy());
    await screen.findByText('等验收', { selector: '.board-column[data-zone="needsYou"] .board-card-name' });

    const col = document.querySelector('.board-column[data-zone="needsYou"]');
    expect(col?.querySelector('.board-card')?.getAttribute('data-needs')).toBe('unread');
    expect(col?.querySelector('.board-column-unread')?.textContent).toBe('1 未读');
    expect(col?.querySelector('.board-card-unread-pip')).toBeTruthy();

    act(() => {
      markNeedsRead('s-need');
    });

    await waitFor(() => {
      expect(col?.querySelector('.board-card')?.getAttribute('data-needs')).toBe('read');
    });
    expect(col?.querySelector('.board-column-unread')).toBeNull();
    expect(col?.querySelector('.board-card-unread-pip')).toBeNull();
    expect(col?.querySelector('.board-card.is-needs-read')).toBeTruthy();
  });

  it('过滤菜单支持工作区多选与快速全选', async () => {
    const user = userEvent.setup();
    renderBoard([needsSession('filter-need', '过滤会话')]);
    await user.click(await screen.findByRole('button', { name: '过滤' }));
    const menu = await screen.findByRole('dialog', { name: '过滤' });
    const alpha = within(menu).getByRole<HTMLInputElement>('checkbox', { name: 'Alpha' });
    expect(alpha.checked).toBe(true);
    await user.click(alpha);
    expect(document.querySelector('[data-zone="needsYou"] .board-card')).toBeNull();
    await user.click(within(menu).getByRole('button', { name: '全选工作区' }));
    await waitFor(() => expect(document.querySelector('[data-zone="needsYou"] .board-card')).toBeTruthy());
  });
});
