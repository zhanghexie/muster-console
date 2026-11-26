/**
 * Esc 让位（keybindings F-05 / sessions-dock F-04）组件级回归：
 * 1) useSessionsPeekEscape：注册更早的 capture Esc 已 preventDefault（快捷键录制取消、
 *    overlay 栈关弹窗）时，速览不再跟着收回——只关一层；
 * 2) LeftPanel 会话详情预览：同样让位（录制中按 Esc 不误关预览），
 *    未被 prevent 的 Esc 仍正常收回。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { PanelHistoryProvider } from '../../src/renderer/src/panelHistory';
import { LeftPanel } from '../../src/renderer/src/panels/LeftPanel';
import { useSessionsPeekEscape } from '../../src/renderer/src/components/useSessionsPeekEscape';
import { currentApiMock } from './helpers/api-mock';
import type { SessionMeta } from '../../src/shared/types';

// 隔离 LeftPanel 自身 effect 的 Esc 让位：SessionDetailsCard 组件内部还有一条
// 无 defaultPrevented 检查的 Esc 关闭路径（清单外同族漏点，见实施报告），
// mock 掉后关闭只经 LeftPanel 的 capture 让位分支。
vi.mock('../../src/renderer/src/components/SessionDetailsCard', () => ({
  SessionDetailsCard: ({ target }: { target: unknown }): React.JSX.Element | null =>
    target ? <div role="dialog" aria-label="会话详情" /> : null
}));

function PeekHarness({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  useSessionsPeekEscape(open, onClose);
  return <div data-testid="peek" />;
}

describe('useSessionsPeekEscape 让位', () => {
  it('未让位的 Esc 正常收回速览', () => {
    const onClose = vi.fn();
    render(<PeekHarness open onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('更早注册的 capture Esc 已 preventDefault 时，速览不跟着收回（只关一层）', () => {
    // 模拟 overlay 栈 / 快捷键录制取消：注册更早的 capture 监听先 preventDefault
    const earlier = (e: KeyboardEvent): void => e.preventDefault();
    window.addEventListener('keydown', earlier, true);
    try {
      const onClose = vi.fn();
      render(<PeekHarness open onClose={onClose} />);
      fireEvent.keyDown(document.body, { key: 'Escape', cancelable: true });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', earlier, true);
    }
  });

  it('open=false 不监听', () => {
    const onClose = vi.fn();
    render(<PeekHarness open={false} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('LeftPanel 会话详情预览 Esc 让位', () => {
  function setup(): SessionMeta {
    Element.prototype.scrollIntoView ??= () => {};
    const ws = { id: 'ws-a', path: 'E:/demo', name: '演示', openedAt: 1 };
    const session: SessionMeta = { id: 's-a', type: 'terminal', launchKind: 'agent', runtime: 'cursor',
      name: '测试会话', workspaceId: ws.id, createdAt: 1, status: 'running', lifecycle: 'idle' };
    const mock = currentApiMock();
    mock.override('workspaces.list', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id }));
    mock.override('config.get', () => Promise.resolve({ workspaces: [ws], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
    mock.override('sessions.list', () => Promise.resolve({ sessions: [session], activeId: session.id }));
    const noop = (): void => {};
    render(<StoreProvider><PanelHistoryProvider><LeftPanel utilityPanel={null} onSelectUtilityPanel={noop}
      onCloseUtilityPanel={noop} /></PanelHistoryProvider></StoreProvider>);
    return session;
  }

  async function openDetails(): Promise<HTMLElement> {
    const row = (await screen.findByText('测试会话')).closest('.session-item') as HTMLElement;
    fireEvent.mouseEnter(row);
    return screen.findByRole('dialog', { name: '会话详情' });
  }

  it('未被 prevent 的 Esc 正常收回详情预览', async () => {
    setup();
    await openDetails();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '会话详情' })).toBeNull()
    , { timeout: 3000 });
  });

  it('更早注册的 capture Esc 已 preventDefault（如快捷键录制取消）时，预览不误关', async () => {
    // 生产序：全局 Esc 层（KeybindingHost/录制）在 App 挂载时注册，早于 LeftPanel；
    // 同为 window capture 时按注册序执行——先注册者 preventDefault 后面板让位。
    const earlier = (e: KeyboardEvent): void => e.preventDefault();
    window.addEventListener('keydown', earlier, true);
    try {
      setup();
      await openDetails();
      fireEvent.keyDown(document.body, { key: 'Escape', cancelable: true });
      // 给退场动画留时间：预览必须在场（让位生效）
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700));
      });
      expect(screen.getByRole('dialog', { name: '会话详情' })).toBeTruthy();
    } finally {
      window.removeEventListener('keydown', earlier, true);
    }
  });
});
