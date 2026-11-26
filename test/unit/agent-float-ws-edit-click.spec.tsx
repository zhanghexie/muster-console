/**
 * 左下角工作区头像交互（组件级）：
 * - 左键头像展开/收起调度对话（原行为，不打开编辑弹窗）；
 * - 右键头像或整行打开菜单，编辑沿用原工作区弹窗；
 * - 删除经确认后移出列表，不删除磁盘文件；删掉最后一个后常驻新建引导面板；
 * - 气泡「对话 / 收起」常驻入口仍在；
 * - 当前工作区标识（is-active / is-active-row）仍在。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';

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

const TWO = [ws('ws-a', 'Alpha'), ws('ws-b', 'Beta')];

beforeEach(() => localStorage.removeItem('muster.workspace-status-read.v1'));

function seedWorkspaces(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: TWO, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({
      workspaces: TWO,
      activeWorkspaceId: 'ws-a',
      locale: 'zh-CN'
    })
  );
  mock.override('codeAnalysis.status', () => Promise.resolve({ ok: false }));
}

function renderFloat() {
  return render(
    <StoreProvider>
      <AgentFloat stackInline />
    </StoreProvider>
  );
}

function realStack(): HTMLElement {
  return document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost)') as HTMLElement;
}

function stackFaces(): HTMLElement[] {
  return Array.from(realStack().querySelectorAll<HTMLElement>('.agent-float-avatar'));
}

describe('AgentFloat 工作区头像交互', () => {
  it('左键头像展开对话面板，不打开编辑弹窗', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Alpha/);

    fireEvent.click(stackFaces()[0]);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')).toBeTruthy();
    });
    expect(screen.queryByRole('dialog', { name: '编辑工作区' })).toBeNull();
  });

  it('左键头像再点收起对话面板', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Alpha/);

    fireEvent.click(stackFaces()[0]);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')?.className).toContain('is-open');
    });

    fireEvent.click(stackFaces()[0]);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')?.className).toContain('is-exiting');
    });
    expect(screen.queryByRole('dialog', { name: '编辑工作区' })).toBeNull();
  });

  it('右键头像打开菜单，选择编辑后打开原编辑弹窗', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Alpha/);

    fireEvent.contextMenu(stackFaces()[0]);
    expect(await screen.findByText('标记未读')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '编辑工作区' })).toBeNull();
    fireEvent.click(document.getElementById('ctx-item-workspace-edit')!);
    expect(await screen.findByRole('dialog', { name: '编辑工作区' })).toBeTruthy();
    expect(document.querySelector('.agent-ctx-menu')).toBeNull();
  });

  it('当前工作区行仍带 is-active / is-active-row，title 提示左键开合与右键菜单', async () => {
    seedWorkspaces();
    renderFloat();
    const title = (await screen.findByTitle(/Alpha/)).getAttribute('title') ?? '';

    expect(title).toMatch(/单击打开\/关闭对话/);
    expect(title).toMatch(/右键菜单/);
    expect(title).not.toMatch(/单击编辑工作区/);
    expect(realStack().querySelector('.agent-ws-stack-item.is-active')).toBeTruthy();
    expect(realStack().querySelector('.agent-ws-stack-row.is-active-row')).toBeTruthy();
  });

  it('右键非当前工作区头像也打开对应编辑弹窗', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Beta/);

    fireEvent.contextMenu(stackFaces()[1]);
    fireEvent.click(await screen.findByText('编辑', { exact: true }));
    const dialog = await screen.findByRole('dialog', { name: '编辑工作区' });
    expect(dialog).toBeTruthy();
    expect(screen.getByDisplayValue('Beta')).toBeTruthy();
  });

  it('整行右键可删除指定工作区，确认前不调用关闭 API', async () => {
    seedWorkspaces();
    currentApiMock().override('workspaces.close', () => Promise.resolve({ ok: true, workspaces: [TWO[0]], activeWorkspaceId: 'ws-a' }));
    renderFloat();
    await screen.findByTitle(/Beta/);
    const row = stackFaces()[1].closest('.agent-ws-stack-item')!;
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('删除', { exact: true }));
    expect(await screen.findByText(/关闭工作区「Beta」？不会删除磁盘文件/)).toBeTruthy();
    expect(currentApiMock().mockOf('workspaces.close')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认关闭' }));
    await waitFor(() => expect(currentApiMock().mockOf('workspaces.close')).toHaveBeenCalledWith('ws-b'));
  });

  it('最后一个工作区可以删除，删空后常驻新建引导面板', async () => {
    seedWorkspaces();
    currentApiMock().override('workspaces.list', () => Promise.resolve({ workspaces: [TWO[0]], activeWorkspaceId: 'ws-a' }));
    currentApiMock().override('config.get', () => Promise.resolve({ workspaces: [TWO[0]], activeWorkspaceId: 'ws-a', locale: 'zh-CN' }));
    currentApiMock().override('workspaces.close', () => Promise.resolve({ ok: true, workspaces: [], activeWorkspaceId: '' }));
    renderFloat();
    await screen.findByTitle(/Alpha/);
    fireEvent.contextMenu(stackFaces()[0].closest('.agent-ws-stack-item')!);
    const item = await screen.findByRole('menuitemcheckbox', { name: '删除' });
    expect(item.getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(item);
    fireEvent.click(await screen.findByRole('button', { name: '确认关闭' }));
    await waitFor(() => expect(currentApiMock().mockOf('workspaces.close')).toHaveBeenCalledWith('ws-a'));
    expect(await screen.findByText('创建一个工作区就可以使用了')).toBeTruthy();
  });
});
