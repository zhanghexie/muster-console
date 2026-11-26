/**
 * Composer 按键热路径：普通打字不得每击重渲整棵输入条；发送必须读最新 DOM 文本
 * （按键不回写 value state 后，若 submit 仍读旧 state 会发出空串）。
 * 运行: npx vitest run test/unit/agent-composer-hotpath.spec.tsx
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi, beforeEach } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';

const { panelMock } = vi.hoisted(() => ({
  panelMock: vi.fn((_props: unknown) => <div data-testid="queue-panel" />)
}));

vi.mock('../../src/renderer/src/components/QueueSendPanel', () => ({
  QueueSendPanel: (props: unknown) => panelMock(props)
}));

function freshProps() {
  return {
    workspaceId: 'ws-hotpath',
    busy: false,
    surfaceKind: 'gui-session' as const,
    onSend: vi.fn(async () => true),
    onClear: vi.fn(async () => undefined)
  };
}

function typeInEditor(text: string): void {
  const editor = screen.getByRole('textbox');
  editor.textContent = text;
  fireEvent.input(editor);
}

describe('AgentComposer 按键热路径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
    if (typeof document.execCommand !== 'function') {
      document.execCommand = () => false;
    }
  });

  it('首字之后继续打字不重渲排队面板（输入条 chrome）', () => {
    const props = freshProps();
    render(
      <StoreProvider>
        <AgentComposer {...props} />
      </StoreProvider>
    );
    typeInEditor('h');
    const afterFirst = panelMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    typeInEditor('he');
    typeInEditor('hel');
    typeInEditor('hell');
    typeInEditor('hello');
    expect(panelMock.mock.calls.length).toBe(afterFirst);
  });

  it('Enter 发送读到未回写 state 的最新文本', async () => {
    const props = freshProps();
    render(
      <StoreProvider>
        <AgentComposer {...props} />
      </StoreProvider>
    );
    typeInEditor('hello from ref');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1));
    expect(props.onSend).toHaveBeenCalledWith('hello from ref', undefined);
  });

  it('发送后输入框被命令式清空（value 已是空串时 React 不会 bail 掉 DOM）', async () => {
    const props = freshProps();
    render(
      <StoreProvider>
        <AgentComposer {...props} />
      </StoreProvider>
    );
    typeInEditor('clear-me');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('textbox').textContent ?? '').toBe(''));
  });
});
