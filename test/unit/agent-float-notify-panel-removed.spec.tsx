/**
 * 工作区通知面板移除回归（组件级）：
 * 调度会话面板内曾有两处应用内通知 UI——面板头部通知中心（agent-bubble /
 * agent-notify-panel，最新一条 + 更早列表 + 清空）与工作区气泡上的计数胶囊
 * （agent-notify-count）。产品决定彻底移除应用内通知面板，通知一律走系统桌面
 * toast。本用例守住移除不被「顺手恢复」：
 * - 栈上气泡不渲染计数胶囊，主体仍显示工作区名 / live 态；
 * - 打开调度会话面板后，头部不再渲染通知中心（agent-bubble 系列全无）；
 * - 主进程残留的 ui:notify 事件推送对 UI 无影响（渲染层不再订阅面板数据）。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { currentApiMock } from './helpers/api-mock';
import type { WorkspaceInfo } from '../../src/shared/types';

// jsdom 无 ResizeObserver（打开面板后 ChatSurfaceView 挂载时量列宽用），空桩即可
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

function seedWorkspaces(list: WorkspaceInfo[], activeId: string): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: list, activeWorkspaceId: activeId })
  );
  mock.override('config.get', () =>
    Promise.resolve({
      workspaces: list,
      activeWorkspaceId: activeId,
      locale: 'zh-CN'
    })
  );
}

function renderFloat() {
  return render(
    <StoreProvider>
      {/* stackInline：栈内联渲染（窄屏路径），无需 portal 槽位即可测真实栈本体 */}
      <AgentFloat stackInline />
    </StoreProvider>
  );
}

function chatButtons(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '.agent-ws-stack:not(.agent-ws-stack-ghost) .agent-notify-chat'
    )
  );
}

describe('工作区通知面板移除（通知全走系统 toast）', () => {
  it('栈上气泡：无计数胶囊，主体仍显示工作区名', async () => {
    seedWorkspaces(TWO, 'ws-a');
    renderFloat();
    await screen.findByTitle(/Alpha/);

    expect(document.querySelectorAll('.agent-notify-count')).toHaveLength(0);
    const body = document.querySelector('.agent-notify-body .agent-notify-text');
    expect(body?.textContent).toContain('Alpha');
  });

  it('ui:bubble live 态仍照常显示（ui:bubble 通道不受移除影响）', async () => {
    seedWorkspaces(TWO, 'ws-a');
    renderFloat();
    await screen.findByTitle(/Alpha/);

    currentApiMock().emit('ui:bubble', {
      text: '正在执行工具',
      status: 'working',
      workspaceId: 'ws-a'
    });
    await waitFor(() => {
      expect(document.querySelector('.agent-notify-bubble')?.className).toContain('is-live');
    });
    expect(document.querySelector('.agent-notify-body .agent-notify-text')?.textContent).toBe(
      '正在执行工具'
    );
  });

  it('打开调度会话面板：头部无通知中心（agent-bubble / agent-notify-panel 全无）', async () => {
    seedWorkspaces(TWO, 'ws-a');
    renderFloat();
    await screen.findByTitle(/Alpha/);

    // 点「对话」打开调度对话面板（entering 态即渲染头部，无需等动画收口）
    fireEvent.click(chatButtons()[0]);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')).toBeTruthy();
    });
    expect(document.querySelectorAll('.agent-bubble')).toHaveLength(0);
    expect(document.querySelectorAll('.agent-notify-panel')).toHaveLength(0);
    expect(document.querySelectorAll('.agent-notify-latest')).toHaveLength(0);
    expect(document.querySelectorAll('.agent-notify-panel-clear')).toHaveLength(0);
  });

  it('残留的 ui:notify 事件推送对 UI 无影响（不再驱动任何应用内通知 UI）', async () => {
    seedWorkspaces(TWO, 'ws-a');
    renderFloat();
    await screen.findByTitle(/Alpha/);

    currentApiMock().emit('ui:notify', {
      id: 'n1',
      workspaceId: 'ws-a',
      sessionId: 'notify:ws-a',
      sessionName: 'Alpha',
      kind: 'info',
      text: 'Alpha · 计划已全部执行完成',
      ts: Date.now()
    });
    // 渲染层已不订阅面板数据：计数胶囊/通知中心不因推送出现
    await waitFor(() => {
      expect(document.querySelectorAll('.agent-notify-count')).toHaveLength(0);
      expect(document.querySelectorAll('.agent-bubble')).toHaveLength(0);
    });
    expect(document.querySelector('.agent-notify-body .agent-notify-text')?.textContent).toContain(
      'Alpha'
    );
  });
});
