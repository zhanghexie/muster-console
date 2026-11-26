/**
 * 全局看板展开态点外关闭 vs portal 浮层（组件级）：
 * 点外空白关闭看板；面板自身（.g-board-sheet）与任意 overlay 根（data-overlay-root，
 * 如划词浮条 portal）不算「点外面」。GlobalBoard 的 overlay 豁免是本次与 AgentFloat
 * 共用的机制，此前无组件级守卫（AGENTS.md 测试规约：UI 交互改动必须带 UI 测试）。
 * window.api 走 helpers/api-mock。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import { OVERLAY_ROOT_ATTR } from '../../src/renderer/src/keybindings/overlayStack';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn((media: string) => ({ media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => vi.unstubAllGlobals());

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

function ws(id: string, name: string): WorkspaceInfo {
  return { id, path: `E:/demo/${id}`, name, openedAt: 1 };
}

function seedWorkspaces(): void {
  const mock = currentApiMock();
  const two = [ws('ws-a', 'Alpha'), ws('ws-b', 'Beta')];
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: two, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({ workspaces: two, activeWorkspaceId: 'ws-a', locale: 'zh-CN' })
  );
}

function GenericPortal({ label }: { label: string }): React.JSX.Element {
  return createPortal(
    <div {...{ [OVERLAY_ROOT_ATTR]: '' }}>
      <button type="button">{label}</button>
    </div>,
    document.body
  );
}

function renderBoard(onClose: () => void, extra?: React.ReactNode): void {
  seedWorkspaces();
  render(
    <StoreProvider>
      <GlobalBoard open onClose={onClose} onOpen={() => undefined} />
      {extra}
    </StoreProvider>
  );
}

describe('GlobalBoard 展开态点外关闭', () => {
  it('点面板自身不关闭', () => {
    const onClose = vi.fn();
    renderBoard(onClose);
    const sheet = document.querySelector('.g-board-sheet');
    expect(sheet).toBeTruthy();
    fireEvent.pointerDown(sheet as Element, { button: 0 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('点通用 overlay 根（portal 浮条）不关闭——守体系而非类名特判', () => {
    const onClose = vi.fn();
    renderBoard(onClose, <GenericPortal label="overlay-action" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'overlay-action' }), { button: 0 });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('点空白关闭（onClose 触发）', () => {
    const onClose = vi.fn();
    renderBoard(onClose);
    fireEvent.pointerDown(document.body, { button: 0 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
