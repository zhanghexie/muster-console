/**
 * R-14 交验前置门看板面：
 * - 红灯 needs_you 会话不进「需要你」列（卡片留在工作列带红灯徽标，无通过/打回/搁置底钮）
 * - 右键红灯会话出「打回重做（附维度门详情）/ 强制验收（跳过维度门）」；非红灯会话没有
 * - 强制验收确认框含 dimension-gate-override 留痕文案，确认走 sessions.review passed + skipDimensionGate
 * - 打回弹窗预填红灯详情
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardCard } from '../../src/renderer/src/panels/BoardCard';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setFilterActiveWorkspace, setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { retainNeedsRead } from '../../src/renderer/src/panels/needsReadStore';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';
import type { DimensionGatesSnapshot } from '../../src/shared/dimensionGates';

const cardBase = {
  sessionId: 's1',
  name: '卡',
  runtimeLabel: 'pi',
  status: 'waiting' as const,
  relTimeTs: Date.now(),
  isActive: false,
  onSelect: () => {},
  onContextMenu: () => {}
};

const redGates: DimensionGatesSnapshot = {
  at: 1,
  trigger: 'needs_you',
  results: [
    {
      id: 'i18n',
      status: 'red',
      checkedFiles: ['src/shared/i18n/locales/en.ts'],
      problems: ['「新词条」缺英文词条（src/renderer/src/panels/Demo.tsx）']
    }
  ]
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

function cardOf(name: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.board-card')].find((el) =>
    el.textContent?.includes(name)
  );
}

function zoneOfCard(el: HTMLElement): string | null {
  return el.closest('.board-column')?.getAttribute('data-zone') ?? null;
}

describe('BoardCard 维度门红灯徽标', () => {
  it('gateRedLabel 出红灯胶囊（静态徽标），title 带详情', () => {
    const { container } = render(
      <BoardCard {...cardBase} gateRedLabel="维度门未过：多语言" gateRedDetail="【多语言】\n- 「新词条」缺英文词条" />
    );
    const badge = container.querySelector('.board-card-gate-red');
    expect(badge).toBeTruthy();
    expect(badge?.getAttribute('aria-label')).toBe('维度门未过：多语言');
    expect(badge?.getAttribute('title')).toContain('缺英文词条');
  });

  it('无 gateRedLabel 无红灯胶囊', () => {
    const { container } = render(<BoardCard {...cardBase} />);
    expect(container.querySelector('.board-card-gate-red')).toBeNull();
  });
});

describe('BoardPanel 维度门红灯接线', () => {
  it('红灯 needs_you 不进需要你列：留在工作列带徽标、无验收底钮', async () => {
    seed([
      sess({
        id: 's-red',
        name: '红灯会话',
        orchestrated: true,
        phase: { value: 'needs_you', source: 'model', ts: 1 },
        dimensionGates: redGates
      }),
      sess({
        id: 's-ok',
        name: '正常待验收',
        orchestrated: true,
        phase: { value: 'needs_you', source: 'model', ts: 1 }
      })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    await screen.findByRole('button', { name: '红灯会话' });
    const red = cardOf('红灯会话');
    const ok = cardOf('正常待验收');
    expect(red).toBeTruthy();
    expect(ok).toBeTruthy();
    expect(zoneOfCard(red!)).toBe('working');
    expect(zoneOfCard(ok!)).toBe('needsYou');
    expect(red!.querySelector('.board-card-gate-red')).toBeTruthy();
    expect(ok!.querySelector('.board-card-gate-red')).toBeNull();
    // 卡片不显示看板专属验收按钮；红灯处置仍走右键。
    expect(red!.querySelector('.board-card-actions .board-card-act')).toBeNull();
    expect(ok!.querySelector('.board-card-actions .board-card-act')).toBeNull();
  });

  it('右键红灯会话出打回/强制验收；正常待验收没有', async () => {
    seed([
      sess({
        id: 's-red',
        name: '红灯会话',
        orchestrated: true,
        phase: { value: 'needs_you', source: 'model', ts: 1 },
        dimensionGates: redGates
      }),
      sess({
        id: 's-ok',
        name: '正常待验收',
        orchestrated: true,
        phase: { value: 'needs_you', source: 'model', ts: 1 }
      })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    const red = await waitFor(() => {
      const el = cardOf('红灯会话');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.contextMenu(red!);
    await waitFor(() => {
      expect(document.getElementById('ctx-item-gate-reject')?.textContent).toBe(
        '打回重做（附维度门详情）'
      );
    });
    expect(document.getElementById('ctx-item-gate-force')?.textContent).toBe(
      '强制验收（跳过维度门）'
    );

    const ok = cardOf('正常待验收');
    fireEvent.contextMenu(ok!);
    await waitFor(() => {
      expect(document.querySelector('.ctx-menu')).toBeTruthy();
    });
    expect(document.getElementById('ctx-item-gate-reject')).toBeNull();
    expect(document.getElementById('ctx-item-gate-force')).toBeNull();
  });

  it('强制验收：确认框含红灯详情与留痕文案，确认走 skipDimensionGate', async () => {
    seed([
      sess({
        id: 's-red',
        name: '红灯会话',
        orchestrated: true,
        phase: { value: 'needs_you', source: 'model', ts: 1 },
        dimensionGates: redGates
      })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    const red = await waitFor(() => {
      const el = cardOf('红灯会话');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.contextMenu(red!);
    await waitFor(() => {
      expect(document.getElementById('ctx-item-gate-force')).toBeTruthy();
    });
    fireEvent.click(document.getElementById('ctx-item-gate-force')!);
    const confirmBtn = await screen.findByRole('button', { name: '强制验收（跳过维度门）' });
    const dialog = confirmBtn.closest('.confirm-modal') ?? document;
    expect(dialog.textContent).toContain('维度门未过：多语言');
    expect(dialog.textContent).toContain('dimension-gate-override');
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      const call = currentApiMock().mockOf('sessions.review').mock.calls.at(-1);
      expect(call?.[0]).toMatchObject({
        sessionId: 's-red',
        decision: 'passed',
        skipDimensionGate: true
      });
    });
  });

  it('打回弹窗预填红灯详情', async () => {
    seed([
      sess({
        id: 's-red',
        name: '红灯会话',
        orchestrated: true,
        phase: { value: 'needs_you', source: 'model', ts: 1 },
        dimensionGates: redGates
      })
    ]);
    render(
      <StoreProvider>
        <BoardPanel />
      </StoreProvider>
    );
    const red = await waitFor(() => {
      const el = cardOf('红灯会话');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.contextMenu(red!);
    await waitFor(() => {
      expect(document.getElementById('ctx-item-gate-reject')).toBeTruthy();
    });
    fireEvent.click(document.getElementById('ctx-item-gate-reject')!);
    const note = await screen.findByLabelText('打回说明');
    expect((note as HTMLTextAreaElement).value).toContain('缺英文词条');
  });
});
