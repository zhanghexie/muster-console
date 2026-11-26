import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';
import { GlobalBoard } from '../../src/renderer/src/panels/GlobalBoard';
import { isNeedsRead, markNeedsRead, resetNeedsReadForTest } from '../../src/renderer/src/panels/needsReadStore';

beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); });

function setup(overrides: Partial<SessionMeta> = {}, withBoard = false): SessionMeta {
  Element.prototype.scrollIntoView ??= () => {};
  const ws = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };
  const session: SessionMeta = { id: 's-a', type: 'terminal', launchKind: 'agent', runtime: 'cursor',
    name: '测试会话', workspaceId: ws.id, createdAt: 1, status: 'running', lifecycle: 'idle',
    activity: { kind: 'active', ts: Date.now() }, liveStatus: { label: '检查输入交互', kind: 'active', ts: 1 }, ...overrides };
  const mock = currentApiMock();
  mock.override('workspaces.list', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id }));
  mock.override('config.get', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
  mock.override('sessions.list', () => Promise.resolve({ sessions: [session], activeId: session.id }));
  const noop = (): void => {};
  render(<StoreProvider><PanelHistoryProvider><LeftPanel utilityPanel={null} onSelectUtilityPanel={noop}
    onCloseUtilityPanel={noop}/>{withBoard && <GlobalBoard open={false} onClose={noop} onOpen={noop}/>}</PanelHistoryProvider></StoreProvider>);
  return session;
}

beforeEach(() => resetNeedsReadForTest());
async function menu(): Promise<HTMLElement> {
  const name = await screen.findByText('测试会话');
  const row = name.closest('.session-item') as HTMLElement;
  fireEvent.contextMenu(row);
  await waitFor(() => expect(document.querySelector('.ctx-menu')).toBeTruthy());
  return row;
}
describe('实际会话行更多入口', () => {
  it('聊天刷新及自动滚动不关闭整行详情，详情内滚动也保留，左栏列表滚动才关闭', async () => {
    const session = setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    expect(row.querySelector('.session-row-content .session-state-slot')).toBeTruthy();
    expect(row.querySelector('.session-row-content .session-rail-content')).toBeTruthy();
    const transcript = document.body.appendChild(document.createElement('section'));
    try {
      fireEvent.mouseEnter(row);
      await screen.findByRole('dialog', { name: '会话详情' });
      act(() => currentApiMock().emit('sessions:changed', {
        sessions: [{ ...session, liveStatus: { label: '继续处理', ts: 2 } }], activeId: session.id
      }));
      fireEvent.scroll(transcript);
      await waitFor(() => expect(within(screen.getByRole('dialog', { name: '会话详情' })).getByText('继续处理')).toBeTruthy());
      expect(screen.getByRole('dialog', { name: '会话详情' }).getAttribute('data-mp-stage')).not.toBe('out');
      // 等待超过退场时长，不能把尚未卸载的退出卡片误判为保留。
      vi.useFakeTimers();
      act(() => vi.advanceTimersByTime(500));
      const card = screen.getByRole('dialog', { name: '会话详情' });
      fireEvent.scroll(card.querySelector('dl')!);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeTruthy();
      fireEvent.scroll(row.parentElement!);
      act(() => vi.advanceTimersByTime(500));
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
    } finally { vi.useRealTimers(); transcript.remove(); }
  });

  it('悬停等待期间聊天滚动不取消打开，列表滚动取消打开', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    const transcript = document.body.appendChild(document.createElement('section'));
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(row);
      fireEvent.scroll(transcript);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => vi.advanceTimersByTime(500));
      act(() => vi.advanceTimersByTime(500));
      fireEvent.mouseLeave(row); fireEvent.mouseEnter(row);
      fireEvent.scroll(row.parentElement!);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
    } finally { vi.useRealTimers(); transcript.remove(); }
  });

  it('鼠标从条目经过间隙进入详情卡后保持显示，离开两者才收起', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    fireEvent.mouseEnter(row);
    const card = await screen.findByRole('dialog', { name: '会话详情' });
    vi.useFakeTimers();
    try {
      fireEvent.mouseLeave(row, { relatedTarget: document.body });
      act(() => vi.advanceTimersByTime(60));
      fireEvent.mouseEnter(card);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeTruthy();
      fireEvent.mouseLeave(card);
      act(() => vi.advanceTimersByTime(130));
      act(() => vi.advanceTimersByTime(400));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('鼠标从条目直接移到外部元素后关闭详情，不必先进入卡片', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    fireEvent.mouseEnter(row);
    await screen.findByRole('dialog', { name: '会话详情' });
    vi.useFakeTimers();
    try {
      fireEvent.mouseLeave(row, { relatedTarget: document.body });
      act(() => vi.advanceTimersByTime(130));
      act(() => vi.advanceTimersByTime(400));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('行被 DOM 移动派发的假 mouseleave（指针仍悬在行上）不收回详情卡', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    fireEvent.mouseEnter(row);
    await screen.findByRole('dialog', { name: '会话详情' });
    const matchesSpy = vi.spyOn(row, 'matches').mockReturnValue(true); // 模拟浏览器 :hover 命中
    vi.useFakeTimers();
    try {
      fireEvent.mouseLeave(row); // DOM move 假离开：relatedTarget 为 null、指针仍悬在行上
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeTruthy();
      matchesSpy.mockRestore();
      fireEvent.mouseLeave(row); // 真实离开（jsdom 下 :hover 不命中）
      act(() => vi.advanceTimersByTime(130)); // 120ms 离开宽限
      act(() => vi.advanceTimersByTime(400)); // 退场动画卸载定时器
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
    } finally {
      matchesSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('悬浮整行展示分组详情，不再局限状态图标或展开名称与胶囊', async () => {
    setup({ externalSessionId: 'cli-session-123', worktreeBranch: 'codex/detail-card', worktreePath: 'E:/demo/worktree',
      liveStatus: { label: '检查输入交互', kind: 'active', summary: '当前正在检查事件响应与状态显示。', ts: 1 } });
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    expect(row.querySelector('.session-state')?.getAttribute('title')).toBeNull();
    fireEvent.mouseEnter(row);
    const card = await screen.findByRole('dialog', { name: '会话详情' });
    expect(row.contains(card)).toBe(false);
    expect(row.getAttribute('aria-describedby')).toBe(card.id);
    expect(within(card).getByText('测试会话')).toBeTruthy();
    expect(within(card).getByText('当前正在检查事件响应与状态显示。')).toBeTruthy();
    expect(within(card).getByText('演示')).toBeTruthy();
    expect(within(card).getByText('codex/detail-card')).toBeTruthy();
    expect(within(card).getByText('cli-session-123')).toBeTruthy();
    expect(card.querySelectorAll('dl dt').length).toBeGreaterThanOrEqual(3);
    fireEvent.mouseLeave(row);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull());
  });

  it('快速划过不弹详情，右键和 Escape 能收回详情', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(row); fireEvent.mouseLeave(row);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
      fireEvent.mouseEnter(row);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeTruthy();
      fireEvent.keyDown(window, { key: 'Escape' });
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
      fireEvent.mouseLeave(row); fireEvent.mouseEnter(row);
      act(() => vi.advanceTimersByTime(500));
      fireEvent.contextMenu(row);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull();
      expect(document.getElementById('ctx-item-rename')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });

  it('已读胶囊仅在悬浮条目时显示，移开隐藏且不改变已读', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    act(() => markNeedsRead('s-a'));
    expect(row.querySelector('.session-rail-status')).toBeNull();
    fireEvent.mouseEnter(row);
    expect(row.querySelector('.session-rail-status')?.textContent).toBe('检查输入交互');
    expect(isNeedsRead('s-a')).toBe(true);
    fireEvent.mouseLeave(row);
    expect(row.querySelector('.session-rail-status')).toBeNull();
    expect(isNeedsRead('s-a')).toBe(true);
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
  });

  it.each(['idle', 'needs_you', 'done'] as const)('工作会话 %s：阅读隐藏胶囊，右键标记未读恢复，下一次阅读再隐藏', async phase => {
    setup({ phase: { value: phase, source: 'model', ts: 1 }, activity: undefined }, true);
    const name = await screen.findByText('测试会话');
    const row = name.closest('.session-item') as HTMLElement;
    expect(row.querySelector('.session-rail-status')).toBeTruthy();
    fireEvent.click(row);
    await waitFor(() => expect(row.querySelector('.session-rail-status')).toBeNull());
    expect(isNeedsRead('s-a')).toBe(true);
    const selects = currentApiMock().mockOf('sessions.select').mock.calls.length;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('标记未读'));
    await waitFor(() => expect(row.querySelector('.session-rail-status')?.textContent).toBe('检查输入交互'));
    expect(isNeedsRead('s-a')).toBe(false);
    expect(currentApiMock().mockOf('sessions.select')).toHaveBeenCalledTimes(selects);
    fireEvent.click(row);
    await waitFor(() => expect(row.querySelector('.session-rail-status')).toBeNull());
  });

  it('已读胶囊在新状态出现时恢复，普通会话快照刷新不恢复', async () => {
    const session = setup({ activity: undefined }, true);
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    fireEvent.click(row);
    await waitFor(() => expect(row.querySelector('.session-rail-status')).toBeNull());
    act(() => currentApiMock().emit('sessions:changed', { sessions: [{ ...session, lastUsedAt: 42 }], activeId: session.id }));
    expect(row.querySelector('.session-rail-status')).toBeNull();
    act(() => currentApiMock().emit('sessions:changed', { sessions: [{ ...session, liveStatus: { label: '等待验收', kind: 'waiting', ts: 2 } }], activeId: session.id }));
    await waitFor(() => expect(row.querySelector('.session-rail-status')?.textContent).toBe('等待验收'));
  });

  it('主进程 reveal 标记已读也隐藏胶囊', async () => {
    setup();
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    act(() => currentApiMock().emit('sessions:reveal', { sessionId: 's-a' }));
    await waitFor(() => expect(row.querySelector('.session-rail-status')).toBeNull());
  });

  it('普通终端不隐藏状态，也不提供工作会话的标记未读菜单', async () => {
    setup({ launchKind: 'shell' });
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    act(() => markNeedsRead('s-a'));
    expect(row.querySelector('.session-rail-status')).toBeTruthy();
    fireEvent.contextMenu(row);
    await waitFor(() => expect(document.querySelector('.ctx-menu')).toBeTruthy());
    expect(document.getElementById('ctx-item-mark-unread')).toBeNull();
  });

  it('更多菜单保留中断并发送 Ctrl+C，不额外切换会话', async () => {
    setup(); await menu();
    fireEvent.click(document.getElementById('ctx-item-interrupt')!);
    expect(currentApiMock().mockOf('pty.input')).toHaveBeenCalledWith('s-a', '\x03');
    expect(currentApiMock().mockOf('sessions.touchUsed')).toHaveBeenCalledWith('s-a');
    expect(currentApiMock().mockOf('sessions.select')).not.toHaveBeenCalled();
  });
  it('重命名时胶囊让出空间，取消后恢复；菜单保留置顶与归档', async () => {
    setup(); const row = await menu();
    expect(document.getElementById('ctx-item-pin')).toBeTruthy();
    expect(document.getElementById('ctx-item-archive')).toBeTruthy();
    fireEvent.click(document.getElementById('ctx-item-rename')!);
    const input = row.querySelector('.session-rename-input')!;
    expect(row.querySelector('.session-rail-status')).toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(row.querySelector('.session-rail-status')?.textContent).toBe('检查输入交互');
    expect(currentApiMock().mockOf('sessions.rename')).not.toHaveBeenCalled();
  });
  it('置顶仍走原有 API', async () => {
    setup(); await menu();
    fireEvent.click(document.getElementById('ctx-item-pin')!);
    expect(currentApiMock().mockOf('sessions.setPinned')).toHaveBeenCalledWith('s-a', true);
  });
});
