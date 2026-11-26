/**
 * 设置弹窗加载失败与二次编辑离开确认回归（P3 settings F-01/F-02）：
 * - F-01：config.get 拒绝不再永远停在「加载配置…」——错误态 + 重试按钮，重试成功进表单；
 * - F-02：首次 Esc 确认离开后又产生新编辑（未保存计数变化但 dirty 保持）时复位确认态，
 *         再次 Esc 仍先确认——旧实现 dirty 未归零时 leaveAsk 不复位，第二次 Esc 直接
 *         onClose 无提示丢掉确认后又累积的编辑。
 * 两条还原即红：SettingsModal 里删掉 loadError 分支 / 把 changeCount 复位 effect 改回 dirty。
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from '../../src/renderer/src/components/settings/SettingsModal';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { closeTopOverlay } from '../../src/renderer/src/keybindings/overlayStack';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig } from '../../src/shared/types';

const CONFIG: AppConfig = {
  defaultRuntime: 'cursor', workspace: 'E:/ws', workspaces: [{ id: 'w1', name: 'WS', path: 'E:/ws', openedAt: 1 }],
  activeWorkspaceId: 'w1', locale: 'zh-CN', mcp: { enabled: false, servers: [] }, tasksKeepAwake: true,
  journalExitSummaryEnabled: false,
  openai: { baseUrl: '', apiKey: '', model: '' },
  runtimeOverrides: {}, mcpByWorkspace: {}, dispatcherAppendPrompt: ''
};

function mount() {
  const onClose = vi.fn();
  render(
    <KeybindingProvider>
      <SettingsModal onClose={onClose} />
    </KeybindingProvider>
  );
  return onClose;
}

beforeEach(() => {
  const api = currentApiMock();
  api.override('config.get', async () => CONFIG);
  api.override('config.update', async () => undefined);
  api.override('capabilities.get', () => new Promise(() => {}));
  api.override('themes.list', () => new Promise(() => {}));
  api.override('runtimes.list', async () => []);
  Element.prototype.scrollIntoView ??= () => {};
});

describe('设置弹窗 · 初始加载失败（F-01）', () => {
  it('config.get 拒绝时展示错误态与重试按钮，不再停在「加载配置…」', async () => {
    const api = currentApiMock();
    // 只让 SettingsModal 的首次拉取失败（子 effect 先于 KeybindingProvider 的挂载拉取，
    // 后者无 catch——全量 reject 会产生 unhandled rejection，与本域无关）
    let calls = 0;
    api.override('config.get', async () => {
      calls += 1;
      if (calls === 1) throw new Error('store unavailable');
      return CONFIG;
    });
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('加载配置失败：store unavailable');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    // 卡死态的占位文案已被错误态取代
    expect(screen.queryByText('加载配置…')).toBeNull();
  });

  it('点重试重新拉取，成功后进入表单页', async () => {
    const user = userEvent.setup();
    const api = currentApiMock();
    let calls = 0;
    api.override('config.get', async () => {
      calls += 1;
      if (calls === 1) throw new Error('store unavailable');
      return CONFIG;
    });
    mount();
    await screen.findByRole('alert');
    // 同一弹窗实例内重试闭环（不要求用户重开设置）：第 3 次调用（重试）成功
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' })).toBeTruthy();
    expect(calls).toBe(3);
  });

  it('capabilities.get 失败不卡整页：配置页照常渲染，能力页保留加载占位', async () => {
    currentApiMock().override('capabilities.get', async () => {
      throw new Error('cap down');
    });
    mount();
    expect(await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' })).toBeTruthy();
    expect(document.querySelector('.settings-load-error')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '调度 Agent' }));
    expect(await screen.findByText('加载能力信息…')).toBeTruthy();
  });
});

describe('设置弹窗 · 确认离开后继续编辑（F-02）', () => {
  it('首次 Esc 确认后又改一项：复位确认态，再按 Esc 仍先确认而非直接 onClose', async () => {
    const user = userEvent.setup();
    const onClose = mount();
    const keepAwake = await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' });
    await user.click(keepAwake); // changeCount=1
    await waitFor(() => expect(screen.getByText('有 1 项更改未保存')).toBeTruthy());

    act(() => closeTopOverlay()); // 首次 Esc：进入「离开前确认」
    const bar = document.querySelector('.settings-savebar') as HTMLElement;
    expect(within(bar).getByText('还有 1 项更改没保存，离开前要保存吗？')).toBeTruthy();

    // 确认后又产生新编辑（dirty 保持，未保存计数 1→2）：确认态复位
    await user.click(screen.getByRole('checkbox', { name: '会话结束自动写日志' }));
    await waitFor(() => expect(within(bar).getByText('有 2 项更改未保存')).toBeTruthy());
    expect(within(bar).queryByRole('button', { name: '放弃并离开' })).toBeNull();

    // 再按 Esc：仍先确认（还原即红：旧实现 leaveAsk 未随 changeCount 复位，此处直接 onClose）
    act(() => closeTopOverlay());
    expect(within(bar).getByText('还有 2 项更改没保存，离开前要保存吗？')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    // 第三次 Esc（确认态中）= 明确放弃，才离开
    act(() => closeTopOverlay());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('撤销后 dirty 归零收起未保存条，正常 Esc 直接离开', async () => {
    const user = userEvent.setup();
    const onClose = mount();
    const keepAwake = await screen.findByRole('checkbox', { name: '任务运行时阻止休眠' });
    await user.click(keepAwake);
    const bar = document.querySelector('.settings-savebar') as HTMLElement;
    await user.click(within(bar).getByRole('button', { name: '撤销' }));
    await waitFor(() => expect(document.querySelector('.settings-savebar')).toBeNull());
    act(() => closeTopOverlay());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
