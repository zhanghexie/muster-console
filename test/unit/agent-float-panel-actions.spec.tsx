/**
 * 调度浮窗顶栏：左「重置」清上下文、右「收起」关面板；无定时任务侧栏。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';
import { applyLocaleSetting } from '../../src/shared/i18n';

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

const ONE = [ws('ws-a', 'Alpha')];

function seedWorkspaces(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: ONE, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({
      workspaces: ONE,
      activeWorkspaceId: 'ws-a',
      locale: 'zh-CN'
    })
  );
}

async function openPanel(): Promise<void> {
  seedWorkspaces();
  render(
    <StoreProvider>
      <AgentFloat stackInline />
    </StoreProvider>
  );
  await screen.findByTitle(/Alpha/);
  fireEvent.click(
    document.querySelector<HTMLElement>(
      '.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat'
    ) as HTMLElement
  );
  await waitFor(() => {
    expect(document.querySelector('.agent-float-panel')?.className).toContain('is-open');
  });
}

describe('AgentFloat 顶栏重置/收起，无定时任务侧栏', () => {
  it('桌面绑定命令指向 Channel，状态查询不再访问旧飞书桥', async () => {
    await openPanel();
    const editor = document.querySelector<HTMLElement>('.agent-float-panel [contenteditable="true"]')!;
    expect(editor).toBeTruthy();
    for (const command of ['/bind demo', '/unbind']) {
      editor.textContent = command;
      fireEvent.input(editor);
      fireEvent.keyDown(editor, { key: 'Enter' });
      await waitFor(() => expect(screen.getAllByText('请在已授权的 Channel 对话中使用 /bind 或 /unbind 选择远程会话。').length).toBeGreaterThan(0));
    }
    editor.textContent = '/status v';
    fireEvent.input(editor);
    fireEvent.keyDown(editor, { key: 'Enter' });
    await screen.findByText(/工作区：Alpha/);
    const mock = currentApiMock();
    for (const method of ['feishu.get', 'feishu.bindTerminal', 'feishu.unbindTerminal']) expect(mock.mockOf(method)).not.toHaveBeenCalled();
    expect(mock.mockOf('chat.send')).not.toHaveBeenCalled();
  });

  it('安全与手机入口随语言切换无障碍名称', async () => {
    await openPanel();
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(await screen.findByRole('button', { name: 'Open safety subsystem' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Open phone apps' })).toBeTruthy();
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });
  it('打开后面板有重置与收起，没有定时任务侧钮/抽屉', async () => {
    await openPanel();
    expect(screen.getByRole('button', { name: '重置' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '收起' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByRole('button', { name: '定时任务' })).toBeNull();
    expect(document.querySelector('.agent-history-drawer')).toBeNull();
    expect(screen.queryByText('定时任务会话')).toBeNull();
  });

  it('手机入口在右侧收起按钮前，手动开合正常', async () => {
    await openPanel();
    const phone = screen.getByRole('button', { name: '打开手机应用' });
    expect(phone.closest('.agent-panel-tools-right')).toBeTruthy();
    expect(phone.nextElementSibling).toBe(within(phone.parentElement!).getByRole('button', { name: '收起' }));
    fireEvent.click(phone);
    expect(await screen.findByRole('region', { name: 'Alpha的手机' })).toBeTruthy();
    expect(phone.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(phone);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Alpha的手机' })).toBeNull());
  });

  it('点收起关闭面板（与气泡开合共存）', async () => {
    await openPanel();
    const headerCollapse = document.querySelector<HTMLElement>('.agent-panel-side-right');
    expect(headerCollapse).toBeTruthy();
    fireEvent.click(headerCollapse!);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')?.className).toContain('is-exiting');
    });
  });

  it('重置图标只打开确认框，确认后才清空调度会话', async () => {
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    expect(currentApiMock().mockOf('chat.clear')).not.toHaveBeenCalled();
    const confirm = screen.getByRole('dialog', { name: '重置调度会话？' });
    fireEvent.click(within(confirm).getByRole('button', { name: '确认重置' }));
    await waitFor(() => expect(currentApiMock().mockOf('chat.clear')).toHaveBeenCalledTimes(1));
  });
});
