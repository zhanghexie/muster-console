import { AppTipHost } from '../../src/renderer/src/components/AppTip';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';
import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/renderer/src/components/settings/SettingsModal';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import { MOTION } from '../../src/renderer/src/components/motion';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig } from '../../src/shared/types';

beforeEach(() => dismissTip());

let width = 360, height = 44;
const bar = () => document.querySelector<HTMLElement>('.settings-savebar')!;
const primarySave = () => within(bar()).getByRole('button', { name: /^保存/ });
const switchInput = () => screen.getByRole('checkbox', { name: '任务运行时阻止休眠' });
function mount() {
  const onClose = vi.fn();
  const view = render(<KeybindingProvider><SettingsModal onClose={onClose}/><AppTipHost /></KeybindingProvider>);
  return { ...view, onClose };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  width = 360; height = 44;
  const api = currentApiMock();
  const config: AppConfig = {
    defaultRuntime: 'cursor', workspace: 'E:/ws', workspaces: [{ id: 'w1', name: 'WS', path: 'E:/ws', openedAt: 1 }],
    activeWorkspaceId: 'w1', locale: 'zh-CN', mcp: { enabled: false, servers: [] }, tasksKeepAwake: true,
    openai: { baseUrl: '', apiKey: '', model: '' },
    runtimeOverrides: {}, mcpByWorkspace: {}, dispatcherAppendPrompt: ''
  };
  api.override('config.get', async () => config);
  api.override('config.update', async () => undefined);
  api.override('capabilities.get', () => new Promise(() => {}));
  api.override('themes.list', () => new Promise(() => {}));
  api.override('runtimes.list', async () => []);
  Element.prototype.scrollIntoView ??= () => {};
  const widthGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')?.get;
  const heightGetter = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')?.get;
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('settings-savebar') ? width : widthGetter?.call(this) ?? 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('settings-savebar') ? height : heightGetter?.call(this) ?? 0;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('真实设置页保存完成反馈', () => {
  it('保存业务即时执行，成功保留本轮几何，只保留aria-hidden文字退场且旧操作立即移除', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    currentApiMock().override('config.update', () => pending.promise);
    const { onClose } = mount();
    await user.click(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' }));
    const save = primarySave();
    const container = bar();
    await user.click(save);
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledOnce();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(save.querySelectorAll('.brand-loader')).toHaveLength(1);
    await act(async () => { pending.resolve(); await pending.promise; });
    expect(bar()).toBe(container);
    expect(container.querySelector('.brand-loader')).toBeNull();
    expect(container.style.getPropertyValue('--savebar-retained-width')).toBe('360px');
    expect(container.style.getPropertyValue('--savebar-retained-height')).toBe('44px');
    expect(within(container).getByText('已保存 ✓')).toBeTruthy();
    expect(container.querySelector('.settings-savebar-success')?.getAttribute('aria-hidden')).not.toBe('true');
    expect(container.querySelector('.settings-savebar-notice')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(save.isConnected).toBe(false);
    fireEvent.click(save);
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('成功动画中再次修改立即恢复真实按钮，旧成功文本不可读/不可点，新保存采用新尺寸', async () => {
    mount();
    const input = await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' });
    vi.useFakeTimers();
    try {
      fireEvent.click(input);
      await act(async () => { fireEvent.click(primarySave()); });
      expect(screen.getByText('已保存 ✓')).toBeTruthy();
      const container = bar();
      const success = container.querySelector('.settings-savebar-success')!;
      fireEvent.click(switchInput());
      expect(bar()).toBe(container);
    expect(container.querySelector('.brand-loader')).toBeNull();
      expect(container.style.getPropertyValue('--savebar-retained-width')).toBe('');
      expect(success.getAttribute('aria-hidden')).toBe('true');
      expect(success.querySelector('button')).toBeNull();
      expect(within(container).getByText('有 1 项更改未保存').closest('[aria-hidden="true"]')).toBeNull();
      expect((primarySave() as HTMLButtonElement).disabled).toBe(false);
      width = 520; height = 48;
      await act(async () => { fireEvent.click(primarySave()); });
      expect(container.classList.contains('is-saved')).toBe(true);
      expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledTimes(2);
      expect(container.style.getPropertyValue('--savebar-retained-width')).toBe('520px');
      expect(container.style.getPropertyValue('--savebar-retained-height')).toBe('48px');
      expect(container.querySelector('.settings-savebar-success')).toBe(success);
      expect(success.getAttribute('aria-hidden')).not.toBe('true');
      expect(success.getAttribute('data-mp-stage')).toBe('in');
    } finally { vi.useRealTimers(); }
  });

  it('连续保存刷新完整1600ms反馈寿命，旧截止点不提前撤销第二次成功', async () => {
    mount();
    const input = await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' });
    vi.useFakeTimers();
    try {
      fireEvent.click(input);
      await act(async () => { fireEvent.click(primarySave()); });
      const container = bar();
      act(() => vi.advanceTimersByTime(1500));
      fireEvent.click(input);
      await act(async () => { fireEvent.click(primarySave()); });
      expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledTimes(2);

      // First save's original deadline; second save is only 100ms old.
      act(() => vi.advanceTimersByTime(100));
      expect(bar()).toBe(container);
    expect(container.querySelector('.brand-loader')).toBeNull();
      expect(container.getAttribute('data-mp-stage')).toBe('in');
      expect(container.querySelector('.settings-savebar-success')?.getAttribute('aria-hidden')).not.toBe('true');
      act(() => vi.advanceTimersByTime(1499));
      expect(container.getAttribute('data-mp-stage')).toBe('in');
      expect(container.querySelector('.settings-savebar-success')?.getAttribute('aria-hidden')).not.toBe('true');

      // Second success owns a full 1600ms, then uses the original presence exit.
      act(() => vi.advanceTimersByTime(1));
      expect(container.getAttribute('data-mp-stage')).toBe('out');
      expect(container.querySelector('.settings-savebar-success')?.getAttribute('aria-hidden')).toBe('true');
      act(() => vi.advanceTimersByTime(MOTION.exitMs + 80));
      expect(document.querySelector('.settings-savebar')).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('保存失败弹出 tip，保留草稿和重试操作', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await user.click(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' }));
    act(() => { closeTopOverlay(); });
    expect(within(bar()).getByText('还有 1 项更改没保存，离开前要保存吗？')).toBeTruthy();
    const update = currentApiMock().mockOf('config.update');
    update.mockRejectedValueOnce(new Error('disk unavailable'));
    await user.click(within(bar()).getByRole('button', { name: '保存并离开' }));
    expect(await screen.findByText('保存失败：disk unavailable')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(bar().querySelector('.settings-savebar-success')).toBeNull();
    expect(within(bar()).queryByText('保存失败：disk unavailable')).toBeNull();
    expect(getTipSnapshot()?.tone).toBe('error');
    const save = within(bar()).getByRole('button', { name: '保存并离开' });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    expect(within(bar()).getByRole('button', { name: '放弃并离开' })).toBeTruthy();
    await user.click(save);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledTimes(2);
    expect(within(bar()).getByText('已保存 ✓')).toBeTruthy();
    expect(bar().querySelectorAll('button')).toHaveLength(0);
  });

  it('放弃离开与撤销仍是即时业务动作；成功槽只过渡合成属性，捕获几何受容器max宽即时约束', async () => {
    const user = userEvent.setup();
    const { onClose } = mount();
    await user.click(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' }));
    await user.click(within(bar()).getByRole('button', { name: '撤销' }));
    expect((switchInput() as HTMLInputElement).checked).toBe(true);
    expect(within(bar()).queryByRole('button', { name: /^保存/ })).toBeNull();
    await user.click(switchInput());
    act(() => { closeTopOverlay(); });
    await user.click(within(bar()).getByRole('button', { name: '放弃并离开' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
    const css = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles/settings.css'), 'utf8');
    expect(css).toMatch(/\.settings-savebar\s*\{[^}]*max-width:\s*calc\(100% - 48px\)/);
    expect(css).toMatch(/\.settings-savebar\.is-saved\s*\{[^}]*width:\s*var\(--savebar-retained-width, max-content\)/);
    const transition = css.match(/\.settings-savebar-copy-layer\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(transition).toContain('opacity var(--dur-menu) var(--ease-standard)');
    expect(transition).toContain('transform var(--dur-menu) var(--ease-standard)');
    expect(transition).not.toMatch(/transition:[^;]*(?:width|height|padding|margin|all)/);
  });
});
