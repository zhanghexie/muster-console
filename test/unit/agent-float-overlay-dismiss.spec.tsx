/**
 * 调度面板使用全屏磨砂遮罩，点击遮罩空白关闭；
 * portal 浮层（data-overlay-root）仍保留自己的交互层级。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StoreProvider } from '../../src/renderer/src/store';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { SelectionBar } from '../../src/renderer/src/components/SelectionBar';
import { OVERLAY_ROOT_ATTR } from '../../src/renderer/src/keybindings/overlayStack';
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
}

function GenericPortal({ label }: { label: string }): React.JSX.Element {
  return createPortal(
    <div {...{ [OVERLAY_ROOT_ATTR]: '' }}>
      <button type="button">{label}</button>
    </div>,
    document.body
  );
}

function CopyBar(): React.JSX.Element {
  return (
    <SelectionBar
      text="copied-text"
      anchor={{ x: 80, y: 90 }}
      items={[{ id: 'copy', label: '复制', run: () => undefined }]}
      dismiss={() => undefined}
      clearSelection={() => undefined}
    />
  );
}

function renderFloat(extra?: React.ReactNode, backdropBlur = true) {
  return render(
    <StoreProvider>
      <AgentFloat stackInline backdropBlur={backdropBlur} />
      {extra}
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

async function openPanel(extra?: React.ReactNode, backdropBlur = true): Promise<HTMLElement> {
  seedWorkspaces();
  renderFloat(extra, backdropBlur);
  await screen.findByTitle(/Alpha/);
  fireEvent.click(chatButtons()[0]);
  return waitFor(() => {
    const el = document.querySelector('.agent-float-panel');
    expect(el).toBeTruthy();
    return el as HTMLElement;
  });
}

describe('AgentFloat 遮罩关闭', () => {
  it('点通用 overlay 根（非 .sel-bar）不收起面板——守住体系而非类名特判', async () => {
    await openPanel(<GenericPortal label="overlay-action" />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'overlay-action' }));
    expect(document.querySelector('.agent-float-panel')?.className).not.toContain('is-exiting');
  });

  it('点划词浮条「复制」不收起调度面板', async () => {
    await openPanel(<CopyBar />);
    const copy = await screen.findByRole('button', { name: '复制' });
    expect(copy.closest('.sel-bar')?.hasAttribute(OVERLAY_ROOT_ATTR)).toBe(true);

    fireEvent.pointerDown(copy);
    expect(document.querySelector('.agent-float-panel')?.className).not.toContain('is-exiting');
    expect(screen.getByRole('toolbar', { name: '选区操作' })).toBeTruthy();
  });

  it('点遮罩空白收起调度面板', async () => {
    await openPanel();
    const backdrop = document.querySelector('.agent-float-backdrop.backdrop-blur-overlay.mp-scrim');
    expect(backdrop).toBeTruthy();
    expect(backdrop?.getAttribute('data-mp-stage')).toBe('in');
    fireEvent.pointerDown(backdrop!);
    await waitFor(() => expect(document.querySelector('.agent-float-panel')?.className).toContain('is-exiting'));
    expect(backdrop?.getAttribute('data-mp-stage')).toBe('out');
    expect(backdrop?.getAttribute('data-agent-backdrop-interactive')).toBe('false');

    await act(async () => { fireEvent.click(chatButtons()[0]); });
    expect(document.querySelector('.agent-float-backdrop')).toBe(backdrop);
    expect(backdrop?.getAttribute('data-mp-stage')).toBe('in');
  });

  it('右侧虚拟屏激活时保留调度面板但不挂磨砂遮罩', async () => {
    await openPanel(undefined, false);
    expect(document.querySelector('.agent-float-panel')).toBeTruthy();
    expect(document.querySelector('.agent-float-backdrop')).toBeNull();
  });
});
