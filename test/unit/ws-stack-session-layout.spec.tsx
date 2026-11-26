/**
 * 展开工作区列表不得改变会话列表布局尺寸：
 * - 栈经 portal 挂 .left-ws-slot，与 .session-list 是左栏兄弟，不得给列表注入 width/padding；
 * - 槽位 CSS 切断浮层公式宽（contain:inline-size + --ws-bubble:100%）；
 * - 幽灵占位钉在 --sessions-col-w，展开不得靠 fit-content 改锚点宽。
 * UI 交互改动须带组件测试（AGENTS.md）；window.api 走 helpers/api-mock。
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const KEY = 'muster.sidebarCollapsed.v1:ws-a:workspaces';

function ws(id: string, name: string): WorkspaceInfo {
  return { id, path: `E:/demo/${id}`, name, openedAt: 1 };
}

const THREE = [
  ws('ws-a', 'AlphaWorkspaceWithAVeryLongDisplayName'),
  ws('ws-b', 'Beta'),
  ws('ws-c', 'Gamma')
];

function seedWorkspaces(): void {
  const mock = currentApiMock();
  mock.override('workspaces.list', () =>
    Promise.resolve({ workspaces: THREE, activeWorkspaceId: 'ws-a' })
  );
  mock.override('config.get', () =>
    Promise.resolve({
      workspaces: THREE,
      activeWorkspaceId: 'ws-a',
      locale: 'zh-CN'
    })
  );
}

function DockedSidebar(): React.JSX.Element {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  return (
    <StoreProvider>
      <aside className="left-panel" data-testid="left-panel">
        <div className="left-panel-scroll">
          <div className="session-list ui-list" data-testid="session-list">
            <div className="session-item active">工作会话甲</div>
            <div className="session-item">工作会话乙</div>
          </div>
        </div>
        <div className="left-ws-slot" ref={setSlot} data-testid="ws-slot" />
      </aside>
      <AgentFloat wsStackSlot={slot} />
    </StoreProvider>
  );
}

function collapseBtn(): HTMLElement {
  return document.querySelector<HTMLElement>(
    '.left-ws-slot .agent-ws-collapse-btn'
  )!;
}

function snapshotList(): { style: string; className: string; html: string } {
  const list = document.querySelector('[data-testid="session-list"]') as HTMLElement;
  const panel = document.querySelector('[data-testid="left-panel"]') as HTMLElement;
  return {
    style: list.getAttribute('style') ?? '',
    className: list.className,
    html: `${panel.getAttribute('style') ?? ''}|${list.parentElement?.className ?? ''}`
  };
}

beforeEach(() => {
  localStorage.removeItem(KEY);
  localStorage.removeItem('muster.wsStackCollapsed.v1');
});

describe('展开工作区列表不改变会话列表布局', () => {
  it('portal 栈与会话列表是左栏兄弟：展开只改栈，不给列表写 width/padding', async () => {
    seedWorkspaces();
    render(<DockedSidebar />);
    await screen.findByTitle(/AlphaWorkspaceWithAVeryLongDisplayName/);

    const slot = document.querySelector('[data-testid="ws-slot"]')!;
    const list = document.querySelector('[data-testid="session-list"]')!;
    const stack = slot.querySelector('.agent-ws-stack');
    expect(stack).toBeTruthy();
    expect(list.contains(stack)).toBe(false);
    expect(list.parentElement?.className).toContain('left-panel-scroll');
    expect(slot.previousElementSibling?.className).toContain('left-panel-scroll');

    const before = snapshotList();
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(collapseBtn());
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('false');
    expect(snapshotList()).toEqual(before);

    fireEvent.click(collapseBtn());
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('true');
    expect(snapshotList()).toEqual(before);
  });

  it('CSS 隔离：槽位切断浮层公式宽，幽灵占位钉死栏宽', () => {
    const left = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/styles/left.css'),
      'utf8'
    );
    const float = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/styles/float.css'),
      'utf8'
    );
    const slot = left.match(/\.left-ws-slot\s*\{[^}]*\}/)?.[0];
    expect(slot).toMatch(/contain:\s*inline-size/);
    expect(slot).toMatch(/min-width:\s*0/);
    expect(slot).not.toMatch(/overflow-x:/);

    const item = left.match(/\.left-ws-slot \.agent-ws-stack-item\s*\{[^}]*\}/)?.[0];
    expect(item).toMatch(/--ws-bubble:\s*100%/);
    expect(item).toMatch(/max-width:\s*100%/);
    expect(item).not.toMatch(/max-width:\s*none/);

    const ghost = float.match(/\.agent-ws-stack-ghost\s*\{[^}]*\}/)?.[0];
    expect(ghost).toMatch(/contain:\s*inline-size/);
    expect(ghost).toMatch(/--sessions-col-w/);
  });
});
