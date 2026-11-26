/** 会话行悬浮归档；更多操作只通过右键菜单进入。 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { SessionRowTools } from '../../src/renderer/src/components/SessionRowTools';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

function setup(overrides: Partial<SessionMeta> = {}): void {
  Element.prototype.scrollIntoView ??= () => {};
  const ws = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };
  const session: SessionMeta = {
    id: 's-a', type: 'terminal', launchKind: 'agent', runtime: 'cursor', name: '测试会话',
    workspaceId: ws.id, createdAt: 1, status: 'running', lifecycle: 'idle',
    activity: { kind: 'active', ts: Date.now() }, liveStatus: { label: '检查输入交互', kind: 'active', ts: 1 },
    ...overrides
  };
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id }));
  mock.override('config.get', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ sessions: [session], activeId: session.id }));
  render(<StoreProvider><PanelHistoryProvider>
    <LeftPanel utilityPanel={null} onSelectUtilityPanel={() => {}} onCloseUtilityPanel={() => {}} />
  </PanelHistoryProvider></StoreProvider>);
}
async function row(): Promise<HTMLElement> {
  return (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
}
const menu = (): HTMLElement | null => document.querySelector('.ctx-menu');

describe('会话行归档与右键更多菜单', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('悬停出现归档图标，持续悬停也不打开更多菜单', async () => {
    setup(); const item = await row();
    const button = item.querySelector<HTMLButtonElement>('.session-archive-btn')!;
    expect(item.querySelector('.session-more-btn')).toBeNull();
    expect(button.getAttribute('aria-label')).toBe('归档');
    expect(button.querySelector('svg')).toBeTruthy();
    vi.useFakeTimers(); fireEvent.pointerEnter(button);
    act(() => vi.advanceTimersByTime(1000));
    expect(menu()).toBeNull();
    expect(currentApiMock().mockOf('sessions.setArchived')).not.toHaveBeenCalled();
  });
  it.each(['agent', 'shell'] as const)('%s 行点击归档直接调用原流程，不打开菜单、不选中会话', async launchKind => {
    setup({ launchKind, activity: undefined }); const item = await row();
    const select = currentApiMock().mockOf('sessions.select'); select.mockClear();
    fireEvent.click(item.querySelector('.session-archive-btn')!);
    expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('s-a', true);
    expect(select).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });
  it('显示已归档的会话时，行内按钮可取消归档', async () => {
    setup({ archived: true });
    fireEvent.click(await screen.findByRole('button', { name: /显示已归档的工作会话/ }));
    const item = await row(); const button = item.querySelector('.session-archive-btn')!;
    expect(button.getAttribute('aria-label')).toBe('取消归档');
    fireEvent.click(button);
    expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('s-a', false);
  });
  it('取消归档保留归档盒盒身并转斜盒盖', () => {
    const { rerender } = render(<SessionRowTools ts={1} onArchive={() => {}} />);
    const paths = (name: string) => Array.from(
      screen.getByRole('button', { name }).querySelectorAll('svg path'),
      path => ({ shape: path.getAttribute('d'), transform: path.getAttribute('transform') }),
    );
    const [archiveBox, archiveLid, archiveMark] = paths('归档');
    rerender(<SessionRowTools ts={1} archived onArchive={() => {}} />);
    const [restoreBox, restoreLid, restoreMark] = paths('取消归档');
    expect(restoreBox).toEqual(archiveBox);
    expect(restoreMark).toEqual(archiveMark);
    expect(restoreLid.shape).toBe(archiveLid.shape);
    expect(archiveLid.transform).toBeNull();
    expect(restoreLid.transform).toMatch(/rotate\(/);
  });
  it('右键仍能打开完整菜单，离开菜单不自动关闭，选项仍可执行', async () => {
    setup(); const item = await row();
    fireEvent.contextMenu(item, { clientX: 50, clientY: 60 });
    await waitFor(() => expect(menu()).toBeTruthy());
    for (const id of ['rename', 'pin', 'archive']) expect(document.getElementById(`ctx-item-${id}`)).toBeTruthy();
    expect(menu()?.getAttribute('data-menu-hold')).toBe('fixed');
    vi.useFakeTimers(); fireEvent.pointerLeave(menu()!);
    act(() => vi.advanceTimersByTime(1000));
    expect(menu()).toBeTruthy();
    vi.useRealTimers(); fireEvent.click(document.getElementById('ctx-item-pin')!);
    expect(currentApiMock().mockOf('sessions.setPinned')).toHaveBeenCalledWith('s-a', true);
  });
  it('右键菜单仍能归档，与行内按钮调用同一归档入口', async () => {
    setup({ activity: undefined }); const item = await row();
    fireEvent.contextMenu(item);
    await waitFor(() => expect(document.getElementById('ctx-item-archive')).toBeTruthy());
    fireEvent.click(document.getElementById('ctx-item-archive')!);
    expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith('s-a', true);
  });
  it('已归档会话右键删除先预览，再等用户确认', async () => {
    setup({ archived: true });
    const api = currentApiMock();
    api.override('sessions.deletePreview', async () => ({ name: '测试会话', fingerprint: 'preview', descendants: 0, active: 0, worktrees: [] }));
    fireEvent.click(await screen.findByRole('button', { name: /显示已归档的工作会话/ }));
    fireEvent.contextMenu(await row());
    const action = await waitFor(() => {
      const item = document.getElementById('ctx-item-delete');
      expect(item).toBeTruthy();
      return item!;
    });
    fireEvent.click(action);
    expect(await screen.findByRole('dialog', { name: '永久删除' })).toBeTruthy();
    expect(api.mockOf('sessions.deletePreview')).toHaveBeenCalledWith('s-a');
    expect(api.mockOf('sessions.close')).not.toHaveBeenCalled();
  });
});
