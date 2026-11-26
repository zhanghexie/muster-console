/**
 * /compact 手动压缩命令（Composer 交互，测试规约第 2 条）：
 * - 提供 onCompact 的表面（pi GUI 会话 / 调度面板）：斜杠菜单列 /compact；
 *   点选菜单项或输入「/compact <侧重>」回车 → onCompact 收到指令，绝不进 onSend；
 * - Tab 只补全不执行；Enter 连发不叠调用；失败走桌面通知 notify.toast（成功改走消息流
 *   分割线；输入框上方 hint 条已移除，失败不静默）；
 * - 未提供 onCompact 的表面（cursor/claude/codex/acp）：不列命令，
 *   输入 /compact 落「未支持命令」桌面通知，不误发给模型。
 * 运行: npx vitest run test/unit/agent-composer-compact.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';

/** 每用例全新 mocks，避免调用记录串场 */
function freshProps() {
  return {
    workspaceId: 'ws-1',
    busy: false,
    surfaceKind: 'gui-session' as const,
    onSend: vi.fn(async () => true),
    onClear: vi.fn(async () => undefined)
  };
}

function typeInEditor(text: string) {
  const editor = screen.getByRole('textbox');
  editor.textContent = text;
  // ComposerEditable 用原生 input 监听兜 onChange；jsdom 下手动触发
  fireEvent.input(editor);
}

describe('AgentComposer /compact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // jsdom 未实现 scrollIntoView（斜杠菜单键盘跟随滚动用）
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    // jsdom 无 execCommand；Tab 补全走 ComposerEditable 手动 DOM 回落
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('斜杠菜单列出 /compact；点选后调用 onCompact（不进 onSend）', async () => {
    const props = freshProps();
    const onCompact = vi.fn(async (_summary?: string) => ({ ok: true }));
    render(<StoreProvider><AgentComposer {...props} onCompact={onCompact} /></StoreProvider>);
    typeInEditor('/');
    const item = await screen.findByRole('option', { name: /\/compact/ });
    fireEvent.mouseDown(item);
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1));
    // 菜单点选无摘要侧重：不得把输入框文本当参数传进去（实现方自行归一）
    expect(onCompact.mock.calls[0][0]).toBeUndefined();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('输入 /compact <摘要侧重> 回车（含空格菜单不开）→ onCompact 收到侧重', async () => {
    const props = freshProps();
    const onCompact = vi.fn(async (_summary?: string) => ({ ok: true }));
    render(<StoreProvider><AgentComposer {...props} onCompact={onCompact} /></StoreProvider>);
    typeInEditor('/compact 保留结论');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onCompact).toHaveBeenCalledWith('保留结论'));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('裸 /compact 回车走菜单选中路径：onCompact(undefined)', async () => {
    const props = freshProps();
    const onCompact = vi.fn(async (_summary?: string) => ({ ok: true }));
    render(<StoreProvider><AgentComposer {...props} onCompact={onCompact} /></StoreProvider>);
    typeInEditor('/compact');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1));
    expect(onCompact.mock.calls[0][0]).toBeUndefined();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('无 onCompact 的表面（非 pi runtime）：不列 /compact，未支持走桌面通知', async () => {
    const props = freshProps();
    render(<StoreProvider><AgentComposer {...props} /></StoreProvider>);
    typeInEditor('/compact');
    expect(screen.queryByRole('option', { name: /\/compact/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    // 输入框上方 hint 条已移除：不落 DOM 文本，失败改弹桌面通知
    await waitFor(() =>
      expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
        text: expect.stringMatching(/未支持的命令/)
      })
    );
    expect(screen.queryByText(/未支持的命令/)).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('Tab 只补全、不执行：onCompact 不触发，输入不被清空', async () => {
    const props = freshProps();
    const onCompact = vi.fn(async (_summary?: string) => ({ ok: true }));
    render(<StoreProvider><AgentComposer {...props} onCompact={onCompact} /></StoreProvider>);
    typeInEditor('/comp');
    await screen.findByRole('option', { name: /\/compact/ });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' });
    expect(onCompact).not.toHaveBeenCalled();
    expect(props.onSend).not.toHaveBeenCalled();
    // 旧 bug：Tab 走执行路径会 applyValue('') 并立刻 compact，之后无法继续输入侧重
    await waitFor(() =>
      expect(screen.getByRole('textbox').textContent).toMatch(/\/compact\s/)
    );
  });

  it('Enter 连发（key repeat）不重叠触发 compact', async () => {
    const props = freshProps();
    let release!: (v: { ok: true }) => void;
    const onCompact = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = resolve;
        })
    );
    render(<StoreProvider><AgentComposer {...props} onCompact={onCompact} /></StoreProvider>);
    typeInEditor('/compact');
    const editor = screen.getByRole('textbox');
    fireEvent.keyDown(editor, { key: 'Enter' });
    fireEvent.keyDown(editor, { key: 'Enter', repeat: true });
    await waitFor(() => expect(onCompact).toHaveBeenCalledTimes(1));
    expect(props.onSend).not.toHaveBeenCalled();
    release({ ok: true });
    // 成功不再 hint（改走消息流 CompactDivider）；这里只守不叠调用
    await waitFor(() => expect(screen.queryByText(/正在压缩|上下文已压缩/)).toBeNull());
  });

  it('压缩失败改走桌面通知（输入框上方 hint 条已移除）', async () => {
    const props = freshProps();
    const onCompact = vi.fn(async () => ({
      ok: false,
      error: 'Turn prefix summarization failed: This operation was aborted'
    }));
    render(<StoreProvider><AgentComposer {...props} onCompact={onCompact} /></StoreProvider>);
    typeInEditor('/compact 保留结论');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(onCompact).toHaveBeenCalledWith('保留结论'));
    await waitFor(() =>
      expect(currentApiMock().mockOf('notify.toast')).toHaveBeenCalledWith({
        text: expect.stringMatching(/Turn prefix summarization failed|压缩失败/)
      })
    );
    expect(screen.queryByText(/Turn prefix summarization failed|压缩失败/)).toBeNull();
    expect(props.onSend).not.toHaveBeenCalled();
  });
});
