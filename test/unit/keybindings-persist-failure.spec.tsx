/**
 * keybindings F-03：改键/解绑/恢复默认三条 persist 路径的 config.update 失败——
 * ① KeybindingHost 回滚 overrides（UI 不显示未落盘的新绑定）；② 设置页内联提示「保存失败」。
 * 红绿：stash src/renderer/src/keybindings/KeybindingHost.tsx 后「回滚」断言红；
 * stash KeybindingsPane.tsx 后「内联提示」断言红。
 * 运行: npx vitest run test/unit/keybindings-persist-failure.spec.tsx
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { currentApiMock } from './helpers/api-mock';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { KeybindingsPane } from '../../src/renderer/src/components/settings/KeybindingsPane';

function mount(): void {
  render(
    <KeybindingProvider>
      <KeybindingsPane />
    </KeybindingProvider>
  );
}

describe('改键 persist 失败：回滚 + 内联提示（keybindings F-03）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
    currentApiMock();
  });

  it('解绑（清除绑定）落盘失败 → 内联「保存失败」提示 + 绑定回滚为默认值', async () => {
    const mock = currentApiMock();
    mock.override('config.get', async () => ({ workspaces: [], activeWorkspaceId: null, locale: 'zh-CN', keybindings: {} }));
    mock.override('config.update', async () => { throw new Error('磁盘只读'); });
    mount();
    const clearBtns = await screen.findAllByTitle('清除绑定');
    const row = clearBtns[0].closest('.kb-row') as HTMLElement;
    const chordBefore = row.querySelector('.kb-chord')!.textContent;
    expect(chordBefore).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(clearBtns[0]);
    await waitFor(() => expect(mock.mockOf('config.update')).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存失败'));
    expect(screen.getByRole('alert').textContent).toContain('磁盘只读');
    // 回滚：行内绑定仍是原默认键（未显示「未绑定」的假状态）
    expect(row.querySelector('.kb-chord')!.textContent).toBe(chordBefore);
  });

  it('录制改键落盘失败 → 内联提示 + 新绑定不生效（回滚）', async () => {
    const mock = currentApiMock();
    mock.override('config.get', async () => ({ workspaces: [], activeWorkspaceId: null, locale: 'zh-CN', keybindings: {} }));
    mock.override('config.update', async () => { throw new Error('配额已满'); });
    mount();
    const chordBtns = within(document.querySelector('.kb-workbench-section') as HTMLElement).getAllByTitle('点击后按下新快捷键');
    const row = chordBtns[0].closest('.kb-row') as HTMLElement;
    const chordBefore = row.querySelector('.kb-chord')!.textContent;
    fireEvent.click(chordBtns[0]);
    fireEvent.keyDown(window, { key: 'k', code: 'KeyK', ctrlKey: true });
    await waitFor(() => expect(mock.mockOf('config.update')).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('配额已满'));
    expect(row.querySelector('.kb-chord')!.textContent).toBe(chordBefore);
  });

  it('落盘成功 → 无内联提示（不误报）', async () => {
    const mock = currentApiMock();
    mock.override('config.get', async () => ({ workspaces: [], activeWorkspaceId: null, locale: 'zh-CN', keybindings: {} }));
    mock.override('config.update', async () => ({ ok: true }));
    mount();
    const clearBtns = await screen.findAllByTitle('清除绑定');
    fireEvent.click(clearBtns[0]);
    await waitFor(() => expect(mock.mockOf('config.update')).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 30));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
