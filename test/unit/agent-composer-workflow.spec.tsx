/**
 * 工作流输入框命令（dynamic-workflow W1，测试规约第 2 条）：
 * - 调度表面：斜杠菜单不列工作流命令；手动输入后仍由主进程展开；
 * - GUI Worker 表面：不列这两个命令，输入落未支持桌面通知，不误发给模型。
 * 运行: npx vitest run test/unit/agent-composer-workflow.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

function freshProps(surfaceKind: 'dispatch' | 'gui-session') {
  return {
    workspaceId: 'ws-1',
    busy: false,
    surfaceKind,
    onSend: vi.fn(async () => true),
    onClear: vi.fn(async () => undefined)
  };
}

function typeInEditor(text: string) {
  const editor = screen.getByRole('textbox');
  editor.textContent = text;
  fireEvent.input(editor);
}

describe('AgentComposer 工作流命令', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('调度表面斜杠菜单不列工作流命令或工作流名称', async () => {
    const props = freshProps('dispatch');
    currentApiMock().override('workflow.overview', async () => ({
      workflows: [{ name: 'review-then-merge' }], active: [], recent: []
    }));
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/');
    expect(await screen.findByRole('option', { name: /^\/new\b/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /\/workflow/ })).toBeNull();
    typeInEditor('/work');
    expect(screen.queryByRole('option', { name: /\/workflow/ })).toBeNull();
    expect(screen.getByRole('textbox').textContent).toBe('/work');
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('调度表面输入 /workflow 名字 参数 回车 → 原文发给调度', async () => {
    const props = freshProps('dispatch');
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/workflow review-then-merge 修复登录超时');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect((props.onSend.mock.calls[0] as unknown[])[0]).toBe('/workflow review-then-merge 修复登录超时');
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
    expect(screen.queryByText(/未支持的命令/)).toBeNull();
  });

  it('工作流命令末尾的空格不妨碍发送后清空输入框', async () => {
    const props = freshProps('dispatch');
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/workflow smoke ');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect((props.onSend.mock.calls[0] as unknown[])[0]).toBe('/workflow smoke');
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toBe(''));
  });

  it('扩展任务的技能草稿按 Enter 原文发送', async () => {
    const props = freshProps('gui-session');
    render(<StoreProvider><AgentComposer {...props} extensionTask /></StoreProvider>);
    typeInEditor('/design-slide 帮我做一页 PPT');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect((props.onSend.mock.calls[0] as unknown[])[0]).toBe('/design-slide 帮我做一页 PPT');
  });

  it('GUI Worker 表面不列工作流命令，输入落未支持桌面通知', async () => {
    const props = freshProps('gui-session');
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/workflow demo');
    expect(screen.queryByRole('option', { name: /\/workflow/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
        text: expect.stringMatching(/未支持的命令/)
      })
    );
    expect(screen.queryByText(/未支持的命令/)).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled();
  });
});
