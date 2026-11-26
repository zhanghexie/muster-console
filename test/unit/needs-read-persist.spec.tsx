/**
 * 「需要你」已读集合跨重启：落 localStorage，hydrate 后仍已读；
 * 新边沿 markNeedsUnread / retain 修剪写盘后重启仍生效。
 * 自查：去掉 mark/unread/retain 里的 persist，drop 内存再 hydrate 应转红。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider, useSessionStore } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import {
  hydrateNeedsReadFromStorage,
  isNeedsRead,
  markNeedsRead,
  markNeedsUnread,
  NEEDS_READ_STORAGE_KEY,
  retainNeedsRead
} from '../../src/renderer/src/panels/needsReadStore';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function session(
  id: string,
  name: string,
  phase: 'needs_you' | 'idle' = 'needs_you'
): SessionMeta {
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
    phase: { value: phase, source: 'model', ts: 1 }
  };
}

function needsSession(id: string, name: string): SessionMeta {
  return session(id, name, 'needs_you');
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

function SessionCountProbe(): React.JSX.Element {
  const { sessions } = useSessionStore();
  return <div data-testid="session-count">{sessions.length}</div>;
}

function storedIds(): string[] {
  const raw = localStorage.getItem(NEEDS_READ_STORAGE_KEY);
  if (!raw) return [];
  const v = JSON.parse(raw) as unknown;
  return Array.isArray(v) ? (v as string[]) : [];
}

/** 进程死亡：内存清空但盘上还在，再 hydrate = 重启 */
function simulateRestart(): void {
  hydrateNeedsReadFromStorage();
}

beforeEach(() => {
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

describe('needsReadStore 落盘与重启', () => {
  it('标记已读后写入 localStorage；清空内存再 hydrate 仍已读', () => {
    markNeedsRead('s-need');
    expect(isNeedsRead('s-need')).toBe(true);
    expect(storedIds()).toContain('s-need');

    // 只清内存、不碰盘：先用坏数据覆盖内存路径——直接 hydrate 覆盖
    localStorage.setItem(NEEDS_READ_STORAGE_KEY, JSON.stringify(['s-need']));
    // 先标另一个再 retain 空，确认内存可被 hydrate 盖掉
    markNeedsRead('s-other');
    expect(isNeedsRead('s-other')).toBe(true);
    localStorage.setItem(NEEDS_READ_STORAGE_KEY, JSON.stringify(['s-need']));
    simulateRestart();

    expect(isNeedsRead('s-need')).toBe(true);
    expect(isNeedsRead('s-other')).toBe(false);
  });

  it('新边沿 markNeedsUnread 清已读并写盘；重启后仍未读', () => {
    markNeedsRead(['s-need', 's-keep']);
    markNeedsUnread(['s-need']);
    expect(isNeedsRead('s-need')).toBe(false);
    expect(isNeedsRead('s-keep')).toBe(true);
    expect(storedIds()).not.toContain('s-need');
    expect(storedIds()).toContain('s-keep');

    simulateRestart();
    expect(isNeedsRead('s-need')).toBe(false);
    expect(isNeedsRead('s-keep')).toBe(true);
  });

  it('retain 修剪离开需要你区的 id，重启后不再复活', () => {
    markNeedsRead(['keep', 'gone']);
    retainNeedsRead(['keep']);
    expect(isNeedsRead('gone')).toBe(false);
    expect(storedIds()).toEqual(['keep']);

    simulateRestart();
    expect(isNeedsRead('keep')).toBe(true);
    expect(isNeedsRead('gone')).toBe(false);
  });

  it('坏数据 / 非数组回落空集合，不把脏值当已读', () => {
    localStorage.setItem(NEEDS_READ_STORAGE_KEY, '{not-json');
    simulateRestart();
    expect(isNeedsRead('s-need')).toBe(false);

    localStorage.setItem(NEEDS_READ_STORAGE_KEY, JSON.stringify({ s: true }));
    simulateRestart();
    expect(isNeedsRead('s')).toBe(false);
  });
});

describe('看板组件：重启后已读观感 / 新边沿清已读', () => {
  it('盘上已有已读 id 时挂载即已读（无未读点、无列头未读数）', async () => {
    localStorage.setItem(NEEDS_READ_STORAGE_KEY, JSON.stringify(['s-need']));
    hydrateNeedsReadFromStorage();
    seed([needsSession('s-need', '等验收')]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(document.querySelector('.board-column[data-zone="needsYou"] .board-card')).toBeTruthy();
    });

    const col = document.querySelector('.board-column[data-zone="needsYou"]');
    expect(col?.querySelector('.board-card')?.getAttribute('data-needs')).toBe('read');
    expect(col?.querySelector('.board-column-unread')).toBeNull();
    expect(col?.querySelector('.board-card-unread-pip')).toBeNull();
    expect(col?.querySelector('.board-card.is-needs-read')).toBeTruthy();
  });

  it('新边沿清已读后卡片回到未读，且重启不把已读加回来', async () => {
    markNeedsRead('s-need');
    seed([needsSession('s-need', '等验收')]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(
        document
          .querySelector('.board-column[data-zone="needsYou"] .board-card')
          ?.getAttribute('data-needs')
      ).toBe('read');
    });

    act(() => {
      markNeedsUnread(['s-need']);
    });
    await waitFor(() => {
      expect(
        document
          .querySelector('.board-column[data-zone="needsYou"] .board-card')
          ?.getAttribute('data-needs')
      ).toBe('unread');
    });
    expect(document.querySelector('.board-column-unread')?.textContent).toBe('1 未读');

    simulateRestart();
    expect(isNeedsRead('s-need')).toBe(false);
    await waitFor(() => {
      expect(
        document
          .querySelector('.board-column[data-zone="needsYou"] .board-card')
          ?.getAttribute('data-needs')
      ).toBe('unread');
    });
  });

  it('启动存量未读不探出：首帧空表不误判边沿', async () => {
    seed([needsSession('s-need', '等验收')]);
    expect(isNeedsRead('s-need')).toBe(false);
    render(
      <StoreProvider>
        <SessionCountProbe />
        <GlobalBoard open={false} onClose={() => {}} onOpen={() => {}} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('session-count').textContent).toBe('1');
    });
    expect(document.querySelector('.g-board-peek-trigger')).toBeNull();
    expect(document.querySelector('.g-board-sheet')).toBeNull();
  });

  it('首帧空表不 retain([])：落盘已读在 list 到达后仍在', async () => {
    markNeedsRead('s-need');
    seed([needsSession('s-need', '等验收')]);
    render(
      <StoreProvider>
        <SessionCountProbe />
        <GlobalBoard open={false} onClose={() => {}} onOpen={() => {}} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('session-count').textContent).toBe('1');
    });
    expect(isNeedsRead('s-need')).toBe(true);
    expect(storedIds()).toContain('s-need');
    expect(document.querySelector('.g-board-peek-trigger')).toBeNull();
  });

  it('首帧快照之后的新边沿仍探出并清已读', async () => {
    const idle = session('s-need', '干活', 'idle');
    const onOpen = vi.fn();
    seed([idle]);
    render(
      <StoreProvider>
        <SessionCountProbe />
        <GlobalBoard open={false} onClose={() => {}} onOpen={onOpen} />
      </StoreProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('session-count').textContent).toBe('1');
    });
    expect(document.querySelector('.g-board-peek-trigger')).toBeNull();

    act(() => {
      markNeedsRead('s-need');
      currentApiMock().emit('sessions:changed', {
        sessions: [needsSession('s-need', '干活')],
        activeId: 's-need'
      });
    });

    await waitFor(() => {
      expect(document.querySelector('.g-board-peek-trigger')).toBeTruthy();
    });
    fireEvent.click(document.querySelector('.g-board-peek-trigger')!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
    expect(isNeedsRead('s-need')).toBe(false);
    expect(isNeedsRead('s-need')).toBe(false);
  });
});
