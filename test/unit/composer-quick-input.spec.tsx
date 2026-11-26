import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentComposer } from '../../src/renderer/src/components/AgentComposer';
import { StoreProvider } from '../../src/renderer/src/store';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { pushOverlay, popOverlay, resetOverlayStackForTest } from '../../src/renderer/src/keybindings/overlayStack';

beforeEach(() => {
  localStorage.clear(); resetOverlayStackForTest();
  Element.prototype.scrollIntoView ??= () => {};
  document.execCommand ??= () => false;
});
describe('快捷短语与完整快捷键宿主', () => {
  it('全局 Escape 先退出短语编辑，再关闭短语列表，背景弹层保持打开；搜索词不可入队', async () => {
    const backgroundClose = vi.fn(); const onSend = vi.fn(async () => true);
    const background = pushOverlay(backgroundClose);
    try {
      await act(async () => { render(<StoreProvider><KeybindingProvider><AgentComposer workspaceId="quick-real" busy={false}
        surfaceKind="dispatch" onSend={onSend} onClear={async () => {}}/></KeybindingProvider></StoreProvider>); });
      const editor = screen.getByRole('textbox');
      editor.textContent = '/quickInput'; fireEvent.input(editor);
      fireEvent.keyDown(editor, { key: 'Enter' });
      await screen.findByRole('dialog', { name: '快捷短语' });
      editor.textContent = '搜索词'; fireEvent.input(editor);
      expect((screen.getByRole('button', { name: '留待确认' }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: '新增短语' }));
      fireEvent.change(screen.getByPlaceholderText('名称（如：地址）'), { target: { value: '草稿名称' } });
      fireEvent.keyDown(screen.getByPlaceholderText('名称（如：地址）'), { key: 'Escape' });
      expect(screen.queryByPlaceholderText('名称（如：地址）')).toBeNull();
      expect(screen.getByRole('dialog', { name: '快捷短语' })).toBeTruthy();
      fireEvent.keyDown(editor, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: '快捷短语' })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(editor));
      expect(editor.textContent).toBe('');
      expect(backgroundClose).not.toHaveBeenCalled();
      expect(onSend).not.toHaveBeenCalled();
      expect(document.querySelector('.agent-composer-qspanel')).toBeNull();
    } finally { popOverlay(background); }
  });
});
