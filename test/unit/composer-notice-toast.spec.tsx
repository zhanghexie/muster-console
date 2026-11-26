/**
 * 输入区提示出口改版（测试规约第 2 条）：输入框上方 hint 提示条（.agent-composer-hint）
 * 已整体移除——成功确认不再提示；失败/被拒不可静默，改走系统桌面通知（notify.toast）。
 * - 成功路径（发送 / 清空成功）：不弹 toast，也不再渲染任何输入框上方提示条；
 * - 失败/被拒路径（清空失败 / 忙时清空被拒）：notify.toast 收到原文案，DOM 不落文本。
 * 运行: npx vitest run test/unit/composer-notice-toast.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

function freshProps(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'ws-1',
    busy: false,
    surfaceKind: 'gui-session' as const,
    onSend: vi.fn(async () => true),
    onClear: vi.fn(async () => undefined),
    ...overrides
  };
}

function typeInEditor(text: string): void {
  const editor = screen.getByRole('textbox');
  editor.textContent = text;
  fireEvent.input(editor);
}

describe('输入区提示条移除 · 失败改走桌面通知', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('成功发送：不弹桌面通知，且不存在输入框上方提示条', async () => {
    const props = freshProps();
    const { container } = render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('你好');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
    expect(container.querySelector('.agent-composer-hint')).toBeNull();
  });

  it('清空成功：不再提示（无 toast、无提示条）', async () => {
    const props = freshProps();
    const { container } = render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/clear');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onClear).toHaveBeenCalledTimes(1));
    expect(currentApiMock().mockOf('notify.toast')).not.toHaveBeenCalled();
    expect(container.querySelector('.agent-composer-hint')).toBeNull();
  });

  it('清空失败：改弹桌面通知，DOM 不落提示文本', async () => {
    const props = freshProps({
      onClear: vi.fn(async () => {
        throw new Error('清空失败：连接已断开');
      })
    });
    const { container } = render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/clear');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
        text: '清空失败：连接已断开'
      })
    );
    expect(screen.queryByText(/清空失败/)).toBeNull();
    expect(container.querySelector('.agent-composer-hint')).toBeNull();
  });

  it('忙时清空被拒：改弹桌面通知，不清空', async () => {
    const props = freshProps({ busy: true });
    const { container } = render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/new');
    // 先 Esc 关掉斜杠菜单（否则 Enter 选中菜单项，不走 submit 的忙时守卫）
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() =>
      expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
        text: expect.stringMatching(/Agent 正在工作/)
      })
    );
    expect(props.onClear).not.toHaveBeenCalled();
    expect(screen.queryByText(/Agent 正在工作/)).toBeNull();
    expect(container.querySelector('.agent-composer-hint')).toBeNull();
  });
});
