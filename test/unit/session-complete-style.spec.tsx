/**
 * 完成态视觉：done+exited 与 done+idle 同款绿✓/「已完成」；只有 archived 灰化。
 * 看板：未归档的已合入完成进「已完成」列，不因进程 exited 掉进折叠的归档列。
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setBoardFilterPanelIds, setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { retainNeedsRead } from '../../src/renderer/src/panels/needsReadStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];

function sess(
  id: string,
  name: string,
  extra: Partial<SessionMeta> = {}
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
    ...extra
  };
}

const donePhase = { value: 'done' as const, source: 'model' as const, ts: 1 };

const SESSIONS: SessionMeta[] = [
  sess('s-idle', '已读标记持久化', {
    lifecycle: 'idle',
    phase: donePhase,
    liveStatus: { label: '已完成', kind: 'done', ts: 1 }
  }),
  sess('s-exit', '嵌套仓健全性校验', {
    lifecycle: 'exited',
    status: 'exited',
    phase: donePhase,
    liveStatus: { label: '已完成', kind: 'done', ts: 1 }
  }),
  sess('s-arch', '已归档完成单', {
    archived: true,
    lifecycle: 'exited',
    status: 'exited',
    phase: donePhase,
    liveStatus: { label: '已完成', kind: 'done', ts: 1 }
  })
];

function seed(sessions: SessionMeta[] = SESSIONS): void {
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

function renderLeft(sessions?: SessionMeta[]): void {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  seed(sessions);
  const noop = (): void => {};
  render(
    <StoreProvider>
      <PanelHistoryProvider>
        <LeftPanel
          utilityPanel={null}
          onSelectUtilityPanel={noop}
          onCloseUtilityPanel={noop}
        />
      </PanelHistoryProvider>
    </StoreProvider>
  );
}

function rowOf(name: string): HTMLElement {
  const nameEl = screen.getByText(name);
  const row = nameEl.closest('.session-item');
  if (!row) throw new Error(`找不到会话行：${name}`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  retainNeedsRead([]);
  setBoardFilterPanelIds(null);
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
afterEach(() => vi.unstubAllGlobals());

describe('左栏完成态样式', () => {
  it('done+exited 与 done+idle 同款绿✓与「已完成」胶囊，不灰化', async () => {
    renderLeft();
    await screen.findByText('已读标记持久化');
    await screen.findByText('嵌套仓健全性校验');

    for (const name of ['已读标记持久化', '嵌套仓健全性校验']) {
      const row = rowOf(name);
      expect(row.classList.contains('is-archived')).toBe(false);
      expect(row.classList.contains('is-exited')).toBe(false);
      expect(row.querySelector('svg.st-done')).toBeTruthy();
      expect(row.querySelector('svg.st-idle')).toBeNull();
      expect(row.querySelector('.session-state.is-exited')).toBeNull();
      expect(row.querySelector('.session-capsule')?.textContent).toContain('已完成');
      expect(row.querySelector('.session-capsule.dim')).toBeNull();
    }
  });

  it('归档态仍灰（灰环 + is-archived），即使 phase=done', async () => {
    renderLeft();
    await screen.findByText('已读标记持久化');
    expect(screen.queryByText('已归档完成单')).toBeNull();

    fireEvent.click(screen.getByTitle('显示已归档的工作会话（1）'));
    await screen.findByText('已归档完成单');

    const row = rowOf('已归档完成单');
    expect(row.classList.contains('is-archived')).toBe(true);
    expect(row.classList.contains('is-exited')).toBe(true);
    expect(row.querySelector('svg.st-idle')).toBeTruthy();
    expect(row.querySelector('svg.st-done')).toBeNull();
    expect(row.querySelector('.session-state.is-exited')).toBeTruthy();
  });
});

describe('全局看板完成列', () => {
  it('未归档的 done+exited 进已完成列；归档才进折叠归档桶', async () => {
    seed();
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findAllByText('已读标记持久化');
    const doneCol = document.querySelector('.board-column[data-zone="done"]');
    expect(doneCol?.textContent).toContain('已读标记持久化');
    expect(doneCol?.textContent).toContain('嵌套仓健全性校验');
    expect(doneCol?.textContent).not.toContain('已归档完成单');
    expect(doneCol?.querySelectorAll('svg.st-done').length).toBe(2);

    act(() => setBoardFilterPanelIds(['archived']));
    const archCol = document.querySelector('.board-column[data-zone="archived"]');
    expect(archCol?.textContent).toContain('已归档完成单');
    expect(archCol?.querySelector('svg.st-idle')).toBeTruthy();
  });
});
