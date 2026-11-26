/**
 * 调度 Agent 面板气泡开合钮（组件级）：
 * - 常驻「对话」，不靠 hover 才出现；
 * - 面板对话中文案切「收起」，点击收起（显式开合）；
 * - CSS 契约：静息态不得 width:0 / opacity:0。
 * window.api 走 helpers/api-mock（AGENTS.md 测试规约）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function renderFloat() {
  return render(
    <StoreProvider>
      <AgentFloat stackInline />
    </StoreProvider>
  );
}

function DockedFloat(): React.JSX.Element {
  const [slot, setSlot] = React.useState<HTMLDivElement | null>(null);
  return (
    <StoreProvider>
      <div className="left-ws-slot" ref={setSlot} />
      <AgentFloat wsStackSlot={slot} />
    </StoreProvider>
  );
}

function realStack(): HTMLElement {
  return document.querySelector('.agent-ws-stack:not(.agent-ws-stack-ghost)') as HTMLElement;
}

function chatButtons(): HTMLElement[] {
  return Array.from(realStack().querySelectorAll<HTMLElement>('.agent-notify-chat'));
}

describe('AgentFloat 气泡开合钮', () => {
  it('左栏工作区整颗胶囊包含头像与名称，头像仍可开合对话', async () => {
    seedWorkspaces();
    render(<DockedFloat />);
    await screen.findByTitle(/Alpha/);

    const first = realStack().querySelector('.agent-ws-stack-item') as HTMLElement;
    const bubble = first.querySelector('.agent-notify-bubble') as HTMLElement;
    expect(bubble.querySelector('.agent-float-avatar')).toBeTruthy();
    expect(bubble.querySelector('.agent-notify-body')?.textContent).toContain('Alpha');
    expect(first.firstElementChild?.classList.contains('agent-ws-stack-main')).toBe(true);

    fireEvent.click(bubble.querySelector('.agent-float-avatar') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.agent-float-panel')?.className).toContain('is-open'));
    fireEvent.click(bubble.querySelector('.agent-float-avatar') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.agent-float-panel')?.className).toContain('is-exiting'));
  });

  it('收起态常驻「对话」，不依赖 hover', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Alpha/);

    const btn = chatButtons()[0];
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('对话');
    expect(btn.className).not.toContain('is-open');
    expect(document.querySelector('.agent-float-panel')).toBeNull();
  });

  it('回合收口后在工作区项目上显示未读标记，悬浮预览不清除，点击后清除', async () => {
    const replyWorkspaces = [ws('reply-a', 'Reply Alpha'), ws('reply-b', 'Reply Beta')];
    const mock = currentApiMock();
    mock.override('workspaces.list', () => Promise.resolve({ workspaces: replyWorkspaces, activeWorkspaceId: 'reply-a' }));
    mock.override('config.get', () => Promise.resolve({ workspaces: replyWorkspaces, activeWorkspaceId: 'reply-a', locale: 'zh-CN' }));
    mock.override('sessions.list', () => Promise.resolve({ sessions: [], activeId: null }));
    mock.override('chat.historyRange', (workspaceId: string) => Promise.resolve({
      messages: [{ id: `reply-${workspaceId}`, role: 'assistant', content: `${workspaceId} 的调度回复`, createdAt: 1, finishedAt: 2 }],
      before: 0, total: 1, hasEarlier: false
    }));
    renderFloat();
    await screen.findByTitle(/Alpha/);
    await waitFor(() => expect(document.querySelectorAll('.agent-notify-chat.has-reply-unread')).toHaveLength(2));
    const row = realStack().querySelector('.agent-ws-stack-item') as HTMLElement;
    fireEvent.mouseEnter(row);
    const preview = await screen.findByRole('dialog', { name: '未读调度回复' });
    expect(preview.textContent).toContain('reply-a 的调度回复');
    expect(document.querySelectorAll('.agent-notify-chat.has-reply-unread')).toHaveLength(2);
    fireEvent.click(preview);
    await waitFor(() => expect(document.querySelectorAll('.agent-notify-chat.has-reply-unread')).toHaveLength(1));
  });

  it('调度状态不再作为工作区胶囊，悬浮仍保留同一个对话开合按钮', async () => {
    seedWorkspaces();
    currentApiMock().override('sessions.list', () => Promise.resolve({
      sessions: [], activeId: null,
      schedulerByWs: { 'ws-a': { workspaceId: 'ws-a', sessionId: 'orchestrator:ws-a',
        phase: 'needs_you', note: '夜间托管完成，等待你确认下一步操作', ts: 1 } }
    }));
    render(<DockedFloat />);
    await screen.findByTitle(/Alpha/);
    const row = realStack().querySelector('.agent-ws-stack-item') as HTMLElement;
    const chat = row.querySelector('.agent-notify-chat') as HTMLElement;
    fireEvent.click(chat);
    await waitFor(() => expect(chat.textContent).toBe('收起'));
    fireEvent.mouseLeave(row);
    expect(row.querySelector('.agent-notify-scheduler')).toBeNull();
    fireEvent.mouseEnter(row);
    expect(row.querySelector('.agent-notify-scheduler')).toBeNull();
    expect(row.querySelector('.agent-notify-chat')).toBe(chat);
    fireEvent.click(chat);
    await waitFor(() => expect(document.querySelector('.agent-float-panel')?.className).toContain('is-exiting'));
    await waitFor(() => expect(chat.textContent).toBe('对话'));
    fireEvent.mouseLeave(row);
    expect(row.querySelector('.agent-notify-scheduler')).toBeNull();
  });

  it('左栏对话态只标记当前对象；切换/收起后原胶囊复原且头像不重挂', async () => {
    seedWorkspaces();
    render(<DockedFloat />);
    await screen.findByTitle(/Alpha/);
    const rows = Array.from(realStack().querySelectorAll<HTMLElement>('.agent-ws-stack-item'));
    const [alpha, beta] = rows;
    const alphaFace = alpha.querySelector('.agent-float-avatar') as HTMLElement;
    fireEvent.click(alphaFace);
    await waitFor(() => expect(alpha.classList.contains('is-chatting')).toBe(true));
    expect(beta.classList.contains('is-chatting')).toBe(false);
    expect(alpha.querySelector('.agent-notify-text')?.textContent).toBe('正在对话');
    expect(alpha.querySelector('.agent-float-avatar')).toBe(alphaFace);
    expect(alpha.querySelector('.agent-notify-bubble')?.contains(alphaFace)).toBe(true);
    expect(alphaFace.title).toContain('Alpha');

    fireEvent.click(beta.querySelector('.agent-notify-chat') as HTMLElement);
    await waitFor(() => expect(beta.classList.contains('is-chatting')).toBe(true));
    expect(alpha.classList.contains('is-chatting')).toBe(false);
    expect(alpha.querySelector('.agent-notify-text')?.textContent).toBe('Alpha');
    expect(realStack().querySelectorAll('.is-chatting')).toHaveLength(1);

    fireEvent.click(beta.querySelector('.agent-notify-chat') as HTMLElement);
    await waitFor(() => expect(document.querySelector('.agent-float-panel')).toBeNull());
    expect(realStack().querySelectorAll('.is-chatting')).toHaveLength(0);
    expect(beta.querySelector('.agent-notify-text')?.textContent).toBe('Beta');
    expect(alpha.querySelector('.agent-float-avatar')).toBe(alphaFace);
  });

  it('点「对话」打开面板，文案切「收起」；再点收起面板', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Alpha/);

    fireEvent.click(chatButtons()[0]);
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')?.className).toContain('is-open');
    });
    expect(chatButtons()[0].textContent).toBe('收起');
    expect(chatButtons()[0].className).toContain('is-open');

    fireEvent.click(chatButtons()[0]);
    expect(chatButtons()[0].textContent).toBe('对话');
    expect(chatButtons()[0].className).not.toContain('is-open');
    await waitFor(() => {
      expect(document.querySelector('.agent-float-panel')?.className).toContain('is-exiting');
    });
  });

  it('退场中再点「对话」立即回弹（不吞点击）；开着换区只换内容不重播进出场', async () => {
    seedWorkspaces();
    renderFloat();
    await screen.findByTitle(/Alpha/);
    const panel = () => document.querySelector<HTMLElement>('.agent-float-panel');

    fireEvent.click(chatButtons()[0]);
    await waitFor(() => expect(panel()?.className).toContain('is-open'));
    const opened = panel();

    fireEvent.click(chatButtons()[0]);
    await waitFor(() => expect(panel()?.className).toContain('is-exiting'));
    fireEvent.click(chatButtons()[0]);
    await waitFor(() => expect(panel()?.className).toContain('is-open'));
    expect(panel()).toBe(opened);

    fireEvent.click(chatButtons()[1]);
    await waitFor(() => expect(panel()?.querySelector('.agent-panel-title')?.textContent).toBe('Beta'));
    expect(panel()).toBe(opened);
    expect(panel()?.className).toContain('is-open');
    expect(chatButtons()[1].className).toContain('is-open');
  });

  it('float.css 进出场走 transition 骨架（可打断），不再用 keyframes', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/float.css'),
      'utf8'
    );
    expect(css).not.toMatch(/@keyframes agent-panel-(enter|exit)/);
    expect(css).toMatch(/\.agent-float-panel\.is-exiting\s*\{[^}]*var\(--dur-exit\)/);
  });

  it('float.css 开合钮静息即可见（禁 hover 才 width:0 / opacity:0）', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/float.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const base = css.match(/\.agent-notify-chat\s*\{([^{}]*)\}/)?.[1] ?? '';
    expect(base).toBeTruthy();
    expect(base).not.toMatch(/width\s*:\s*0/);
    expect(base).not.toMatch(/opacity\s*:\s*0/);
    expect(css).not.toMatch(/\.agent-notify-bubble:hover\s+\.agent-notify-chat\s*\{/);
  });

  it('调度面板固定绑定左侧工作页，不给右侧 Git 页额外加横向偏移', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/float.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.agent-float\.is-collapsed,[\s\S]*?\.agent-float\.is-expanded\s*\{[^}]*left:\s*var\(--agent-float-inset/);
    expect(css).not.toContain('--agent-float-page-left');
  });

  it('调度磨砂层覆盖工作面，但只抬高底部工作区列表', () => {
    const css = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/float.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.agent-float-backdrop\s*\{[^}]*inset:\s*0[^}]*bottom:\s*calc\(-1\s*\*\s*var\(--frame-gap/);
    const leftCss = readFileSync(
      resolve(__dirname, '../../src/renderer/src/styles/left.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(leftCss).toMatch(/\.main-view:has\(\.agent-float-panel\)\s+\.left-panel\s*\{[^}]*z-index:\s*auto/);
    expect(leftCss).toMatch(/\.main-view:has\(\.agent-float-panel\)\s+\.left-ws-slot\s*\{[^}]*z-index:\s*calc\(var\(--z-popover\)\s*\+\s*1\)/);
  });
});
