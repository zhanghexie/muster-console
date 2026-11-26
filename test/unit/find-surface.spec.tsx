import React, { useState } from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { KeybindingProvider, useKeybinding } from '../../src/renderer/src/keybindings/KeybindingHost';
import {
  getPreferredFindSurface,
  resetPreferredFindSurfaceForTest,
  resolveCtrlFSurface,
  setPreferredFindSurface
} from '../../src/renderer/src/keybindings/findSurface';
import { resetChatFindSharedForTest } from '../../src/renderer/src/chatSurface/chatFindRegistry';

function RouteHarness(): React.JSX.Element {
  const [opened, setOpened] = useState<'none' | 'chat' | 'files'>('none');
  useKeybinding('chat.find', () => setOpened('chat'));
  useKeybinding('files.find', () => setOpened('files'));
  return (
    <div>
      <div className="chat-surface-view" data-testid="chat">
        会话
      </div>
      <div className="file-editor" data-testid="file">
        文件
      </div>
      <span data-testid="opened">{opened}</span>
    </div>
  );
}

describe('findSurface Ctrl+F 分流', () => {
  beforeEach(() => {
    resetPreferredFindSurfaceForTest();
    resetChatFindSharedForTest();
  });

  it('无焦点时跟虚拟屏 preferred', () => {
    expect(resolveCtrlFSurface(document.body, 'chat')).toBe('chat');
    expect(resolveCtrlFSurface(document.body, 'files')).toBe('files');
  });

  it('焦点在文件/会话内盖过 preferred', () => {
    const file = document.createElement('div');
    file.className = 'file-editor';
    const chat = document.createElement('div');
    chat.className = 'chat-surface-view';
    expect(resolveCtrlFSurface(file, 'chat')).toBe('files');
    expect(resolveCtrlFSurface(chat, 'files')).toBe('chat');
  });

  it('Git/文件页 preferred=files 时 Ctrl+F 打开文件查找', () => {
    setPreferredFindSurface('files');
    expect(getPreferredFindSurface()).toBe('files');
    render(
      <KeybindingProvider>
        <RouteHarness />
      </KeybindingProvider>
    );
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('opened').textContent).toBe('files');
  });

  it('工作页 preferred=chat 时 Ctrl+F 打开会话查找', () => {
    setPreferredFindSurface('chat');
    render(
      <KeybindingProvider>
        <RouteHarness />
      </KeybindingProvider>
    );
    fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('opened').textContent).toBe('chat');
  });

  it('文件页时焦点在会话面仍打开会话查找', () => {
    setPreferredFindSurface('files');
    render(
      <KeybindingProvider>
        <RouteHarness />
      </KeybindingProvider>
    );
    fireEvent.keyDown(screen.getByTestId('chat'), { key: 'f', ctrlKey: true });
    expect(screen.getByTestId('opened').textContent).toBe('chat');
  });
});
