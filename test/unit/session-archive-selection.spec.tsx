import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import type { ArchiveSelectionHint } from '../../src/shared/workspaceActiveSession';
import type { SessionMeta } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const ws = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };
const row = (id: string, name: string, createdAt: number): SessionMeta => ({
  id, name, createdAt, type: 'terminal', launchKind: 'agent', runtime: 'cursor',
  workspaceId: ws.id, status: 'running', lifecycle: 'idle'
});

function setup(archiveRows: SessionMeta[] = []): void {
  Element.prototype.scrollIntoView ??= () => {};
  let sessions = [row('last', '计划丙', 1), row('next', '计划乙', 2),
    row('filtered', '其他内容', 3), row('current', '计划甲', 4), row('first', '更早一行', 5), ...archiveRows];
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id }));
  mock.override('config.get', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ sessions, activeId: 'current' }));
  // Model the main-process broadcast after it accepts the visible-rail hint.
  mock.override('sessions.setArchived', (id: string, archived: boolean, hint?: ArchiveSelectionHint) => {
    sessions = sessions.map(s => s.id === id ? { ...s, archived } : s);
    mock.emit('sessions:changed', { sessions, activeId: hint?.nextId ?? 'last' });
    return Promise.resolve(sessions.find(s => s.id === id));
  });
  mock.override('sessions.close', async (id: string) => {
    sessions = sessions.filter(session => session.id !== id);
    mock.emit('sessions:changed', { sessions, activeId: 'current' });
  });
  render(<StoreProvider><PanelHistoryProvider>
    <LeftPanel utilityPanel={null} onSelectUtilityPanel={() => {}} onCloseUtilityPanel={() => {}} />
  </PanelHistoryProvider></StoreProvider>);
}

function sessionRow(id: string): HTMLElement {
  return document.querySelector(`[data-session-row="${id}"]`) as HTMLElement;
}

describe('归档当前会话后的列表选中', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('点击归档后，传入并选中列表里紧邻的下一行', async () => {
    setup();
    await screen.findByText('计划甲');
    expect(sessionRow('current').getAttribute('aria-current')).toBe('true');
    fireEvent.click(sessionRow('current').querySelector('.session-archive-btn')!);
    expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith(
      'current', true, { activeId: 'current', nextId: 'filtered' }
    );
    await waitFor(() => expect(sessionRow('filtered').getAttribute('aria-current')).toBe('true'));
    expect(sessionRow('current')).toBeNull();
  });

  it('搜索过滤后，右键归档选择当前可见的下一行', async () => {
    setup();
    await screen.findByText('计划甲');
    fireEvent.click(screen.getByRole('button', { name: '搜索工作会话' }));
    fireEvent.change(screen.getByPlaceholderText('搜索工作会话…'), { target: { value: '计划' } });
    await waitFor(() => expect(sessionRow('filtered')).toBeNull());
    fireEvent.contextMenu(sessionRow('current'));
    fireEvent.click(await screen.findByText('归档'));
    expect(currentApiMock().mockOf('sessions.setArchived')).toHaveBeenCalledWith(
      'current', true, { activeId: 'current', nextId: 'next' }
    );
    await waitFor(() => expect(sessionRow('next').getAttribute('aria-current')).toBe('true'));
  });

  it('按 worktree 保留项筛选并只预览勾选的归档会话', async () => {
    setup([{ ...row('kept', '保留目录', 7), archived: true, worktreePath: 'checkout' },
      { ...row('plain', '普通归档', 6), archived: true }]);
    const api = currentApiMock();
    api.override('sessions.deletePreview', async () => ({ name: '保留目录', fingerprint: 'preview', descendants: 0, active: 0, worktrees: [] }));
    fireEvent.click(await screen.findByRole('button', { name: /显示已归档的工作会话/ }));
    expect(sessionRow('current')).toBeNull();
    expect(sessionRow('plain')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^有保留项$/ }));
    await waitFor(() => expect(sessionRow('plain')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }));
    const choose = await screen.findByRole('dialog', { name: '选择要删除的归档会话' });
    fireEvent.click(within(choose).getByRole('checkbox', { name: '保留目录' }));
    fireEvent.click(within(choose).getByRole('button', { name: '预览删除范围' }));
    expect(await screen.findByRole('dialog', { name: '永久删除' })).toBeTruthy();
    expect(api.mockOf('sessions.deletePreview').mock.calls).toEqual([['kept']]);
    expect(api.mockOf('sessions.close')).not.toHaveBeenCalled();
  });

  it('没有归档时也能打开空列表，再返回普通会话', async () => {
    setup();
    await screen.findByText('计划甲');
    fireEvent.click(screen.getByRole('button', { name: /显示已归档的工作会话/ }));
    expect(screen.getByText('暂无归档会话')).toBeTruthy();
    expect(sessionRow('current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回工作会话' }));
    expect(sessionRow('current')).toBeTruthy();
  });

  it('删完归档后停在空列表，清除旧筛选并保留返回入口', async () => {
    setup([{ ...row('kept', '最后一条归档', 7), archived: true, worktreePath: 'checkout' }]);
    const api = currentApiMock();
    api.override('sessions.deletePreview', async () => ({ name: '最后一条归档', fingerprint: 'preview', descendants: 0, active: 0, worktrees: [] }));
    fireEvent.click(await screen.findByRole('button', { name: /显示已归档的工作会话/ }));
    fireEvent.click(screen.getByRole('button', { name: /^有保留项$/ }));
    expect(sessionRow('current')).toBeNull();
    fireEvent.click(within(sessionRow('kept')).getByRole('button', { name: '永久删除' }));
    const confirmation = await screen.findByRole('dialog', { name: '永久删除' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '永久删除' }));
    await waitFor(() => {
      expect(screen.getByText('暂无归档会话')).toBeTruthy();
      expect(sessionRow('current')).toBeNull();
      expect(screen.queryByRole('button', { name: /^有保留项$/ })).toBeNull();
      expect(screen.queryByRole('button', { name: '批量删除' })).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: '返回工作会话' }));
    fireEvent.click(within(sessionRow('current')).getByRole('button', { name: '归档' }));
    await screen.findByRole('button', { name: '显示已归档的工作会话（1）' });
    expect(sessionRow('current')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /显示已归档的工作会话/ }));
    expect(screen.getByRole('button', { name: /^有保留项$/ }).getAttribute('aria-pressed')).toBe('false');
    expect(sessionRow('current')).toBeTruthy();
  });
});
