/**
 * 全局看板：orchestrated 会话在头像或状态图标右上角出小蓝点；非编排会话没有。
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { retainNeedsRead } from '../../src/renderer/src/panels/needsReadStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const cardBase = {
  sessionId: 's1',
  name: '卡',
  runtimeLabel: 'pi',
  status: 'idle' as const,
  relTimeTs: Date.now(),
  isActive: false,
  onSelect: () => {},
  onContextMenu: () => {}
};

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(partial: Partial<SessionMeta> & Pick<SessionMeta, 'id' | 'name'>): SessionMeta {
  return {
    type: 'terminal',
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'cursor',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    ...partial
  };
}

function seed(sessions: SessionMeta[]): void {
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

describe('BoardCard orchestrated 角标', () => {
  it('空闲会话在共享状态槽保留编排角标', () => {
    const { container } = render(<BoardCard {...cardBase} orchestrated />);
    const slot = container.querySelector('.board-card-orch-dot');
    expect(container.querySelector('.board-card-state')).toBeNull();
    expect(slot?.getAttribute('title')).toBe('由调度编排');
    const dot = container.querySelector('.board-card-orch-dot');
    expect(dot).toBeTruthy();
    expect(dot?.getAttribute('aria-label')).toBe('由调度编排');
  });

  it('工作中会话仍在共享状态槽标记编排身份', () => {
    const { container } = render(<BoardCard {...cardBase} status="working" orchestrated />);
    expect(container.querySelector('.session-state-slot .board-card-orch-dot')).toBeTruthy();
    expect(container.querySelector('.board-card-orch-dot')?.getAttribute('title')).toBe('由调度编排');
  });

  it('非 orchestrated 无角标', () => {
    const { container } = render(<BoardCard {...cardBase} />);
    expect(container.querySelector('.board-card-orch-dot')).toBeNull();
    expect(container.querySelector('.board-card-avatar-marker')).toBeNull();
  });

  it('orchestrated=false 与缺省一样无角标', () => {
    const { container } = render(<BoardCard {...cardBase} orchestrated={false} />);
    expect(container.querySelector('.board-card-orch-dot')).toBeNull();
  });
});

describe('BoardPanel orchestrated 接线', () => {
  it('会话 orchestrated=true 才出角标', async () => {
    seed([
      sess({ id: 's-orch', name: '编排会话', orchestrated: true }),
      sess({ id: 's-hand', name: '手工会话' })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findByRole('button', { name: '编排会话' });
    const cards = [...document.querySelectorAll('.board-card')];
    const orch = cards.find((el) => el.textContent?.includes('编排会话'));
    const hand = cards.find((el) => el.textContent?.includes('手工会话'));
    expect(orch?.querySelector('.board-card-orch-dot')).toBeTruthy();
    expect(orch?.querySelector('.board-card-orch-dot')?.getAttribute('title')).toBe('由调度编排');
    expect(hand?.querySelector('.board-card-orch-dot')).toBeNull();
  });
});
