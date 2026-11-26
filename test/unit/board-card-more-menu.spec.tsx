/** 看板卡片不提供更多按钮，右键菜单和清理错误仍可用。 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { BoardPanel } from '../../src/renderer/src/panels/BoardPanel';
import { setFreeViewMode } from '../../src/renderer/src/panels/freeViewStore';
import { getTipSnapshot, subscribeTips } from '../../src/renderer/src/tips';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';


const WS = [{ id: 'ws-a', path: 'E:/demo/a', name: 'Alpha', openedAt: 1 }];
function Bubble() {
  const tip = React.useSyncExternalStore(subscribeTips, getTipSnapshot);
  return <div data-testid="bubble">{tip?.text ?? ''}</div>;
}

function workingSession(id: string, name: string): SessionMeta {
  return {
    id,
    type: 'terminal',
    name,
    createdAt: 1,
    lastUsedAt: 1,
    launchKind: 'agent',
    runtime: 'pi',
    workspaceId: 'ws-a',
    status: 'running',
    lifecycle: 'idle',
    liveStatus: { label: '写代码', kind: 'active', ts: 1 }
  };
}

function stubHoverPreview(enabled: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: enabled && query.includes('hover: hover') && query.includes('pointer: fine'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false
  })) as typeof window.matchMedia;
}

function setupBoard(sessions: SessionMeta[] = [workingSession('s1', '看板会话一'), workingSession('s2', '看板会话二')]): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a' }));
  mock.override('config.get', () => Promise.resolve({ workspaces: WS, activeWorkspaceId: 'ws-a', locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ sessions, activeId: sessions[0]?.id ?? null }));
  mock.override('sessions.deletePreview', () => Promise.resolve({ name: '遗留会话', fingerprint: 'preview', descendants: 0, active: 0, worktrees: [] }));
  render(
    <StoreProvider>
      <BoardPanel />
      <Bubble />
    </StoreProvider>
  );
}

function menu(): HTMLElement | null {
  return document.querySelector('.ctx-menu');
}

/** 模拟真点击：pointerdown 会先打到 ContextMenu 的点外关闭 */
function fullClick(el: Element): void {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.pointerUp(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

/** 删除走「预览 → 确认」两步：点确认框的「永久删除」才真正调用 sessions.close */
async function confirmDelete(): Promise<void> {
  const dialog = await screen.findByRole('dialog', { name: '永久删除' });
  fullClick(within(dialog).getByRole('button', { name: '永久删除' }));
}

beforeEach(() => {
  setFreeViewMode('status');
  Element.prototype.scrollIntoView ??= (() => {}) as never;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('看板卡片不渲染更多按钮，仍提供与会话列表共用的归档入口', async () => {
  setupBoard();
  const title = await screen.findByRole('button', { name: '看板会话一' });
  const card = title.closest('.board-card')!;
  expect(card.querySelector('.board-card-more-btn')).toBeNull();
  const archive = card.querySelector('.session-row-tools .session-archive-btn')!;
  expect(archive).toBeTruthy();
  fireEvent.click(archive);
  expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('s1', true);
  expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
});

it('右键卡片仍是 fixed 菜单（既有行为不回归）', async () => {
  stubHoverPreview(false);
  setupBoard();
  const els = await screen.findAllByText('看板会话二');
  const card = els.map((e) => e.closest('.board-card')).find(Boolean) as HTMLElement;
  fireEvent.contextMenu(card);
  await waitFor(() => expect(menu()).toBeTruthy());
  expect(menu()?.getAttribute('data-menu-hold')).toBe('fixed');
});

it('仅启动的动态终端在看板菜单显式开启新对话', async () => {
  stubHoverPreview(false);
  const api = currentApiMock();
  api.override('runtimes.list', async () => [{ id: 'fixture-cli', label: 'Fixture CLI', script: '',
    builtin: false, enabled: true, surface: 'pty', updatedAt: 0 }]);
  api.override('sessions.respawn', async () => {});
  setupBoard([{ ...workingSession('fixture', '动态终端'), runtime: 'fixture-cli', externalSessionId: 'placeholder' }]);
  const card = (await screen.findByRole('button', { name: '动态终端' })).closest('.board-card')!;
  fireEvent.contextMenu(card);
  const start = await screen.findByRole('menuitemcheckbox', { name: '开启新对话' });
  expect(screen.queryByRole('menuitemcheckbox', { name: '恢复原对话' })).toBeNull();
  expect(api.mockOf('sessions.respawn')).not.toHaveBeenCalled();
  fullClick(start);
  await waitFor(() => expect(api.mockOf('sessions.respawn')).toHaveBeenCalledWith('fixture', 'new'));
});

it('自由画布节点不渲染 ⋯（画布指针由视口统一派发）', async () => {
  stubHoverPreview(false);
  setupBoard();
  setFreeViewMode('free');
  await waitFor(() => expect(document.querySelector('.fc-node')).toBeTruthy());
  expect(document.querySelectorAll('.fc-node .board-card .board-card-more-btn').length).toBe(0);
});

it('归档卡片删除失败时显示后端原因，清理失败结果也显示原因', async () => {
  const api = currentApiMock();
  api.override('sessions.close', () => Promise.reject(new Error('worktree 有未提交改动，已保留')));
  api.override('sessions.discardWorktree', () => Promise.resolve({ ok: false, message: '仓库身份无法确认' }));
  setupBoard([{ ...workingSession('s1', '遗留会话'), archived: true, status: 'exited',
    worktreePath: 'E:/tree', worktreeBranch: 'ao/task', meta: { orphanWorktree: 'locked' } }]);
  const card = (await screen.findAllByText('遗留会话')).map(el => el.closest('.board-card')).find(Boolean)!;
  fireEvent.contextMenu(card);
  fullClick(await screen.findByRole('menuitemcheckbox', { name: '永久删除' }));
  await confirmDelete();
  const failure = await screen.findByRole('dialog', { name: '删除失败' });
  expect(failure.textContent).toContain('worktree 有未提交改动，已保留');
  fullClick(within(failure).getByText('关闭', { selector: 'button' }));
  fireEvent.contextMenu(card);
  fullClick(await screen.findByText('强制清理 worktree'));
  fullClick(await screen.findByRole('button', { name: '放弃并清理' }));
  expect(await screen.findByText('仓库身份无法确认')).toBeTruthy();
});

it('未登记目录失败后，关闭提示不执行强制删除，显式确认才提交同一预览', async () => {
  const api = currentApiMock();
  const close = api.mockOf('sessions.close')
    .mockRejectedValueOnce(new Error('E:/tree (unregistered directory at the task path; ownership is unknown)'))
    .mockRejectedValueOnce(new Error('E:/tree (unregistered directory at the task path; ownership is unknown)'))
    .mockResolvedValueOnce(undefined);
  setupBoard([{ ...workingSession('s1', '遗留会话'), archived: true, status: 'exited',
    worktreePath: 'E:/tree', worktreeBranch: 'ao/task', meta: { orphanWorktree: 'locked' } }]);
  const card = (await screen.findAllByText('遗留会话')).map(el => el.closest('.board-card')).find(Boolean)!;
  const request = async () => {
    fireEvent.contextMenu(card);
    fullClick(await screen.findByRole('menuitemcheckbox', { name: '永久删除' }));
    await confirmDelete();
    const failure = await screen.findByRole('dialog', { name: '删除失败' });
    expect(failure.textContent).toMatch(/ownership is unknown/);
    return failure;
  };
  fullClick(within(await request()).getByText('关闭', { selector: 'button' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenLastCalledWith('s1', { fingerprint: 'preview', keepWorktrees: false });

  const failure = await request();
  expect(close).toHaveBeenCalledTimes(2);
  fullClick(within(failure).getByRole('button', { name: '强制删除 worktree 和分支' }));
  await waitFor(() => expect(close).toHaveBeenCalledTimes(3));
  expect(close).toHaveBeenLastCalledWith('s1', { fingerprint: 'preview', forceWorktrees: true });
});
