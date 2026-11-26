import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * ⑥ 设置 → 通用页「worktree 存储目录」：保留手输（直接粘路径），
 * 新增「浏览…」按钮复用 workspaces.pickDir 系统目录选择器（2026-10-07 报单⑥）。
 * 断言：api-mock pickDir 返回路径 → 草稿写入选中路径；取消选择不改动。
 */
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createApiMock } from './helpers/api-mock';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import type { AppConfig } from '../../src/shared/types';

let api: ReturnType<typeof createApiMock>;

beforeEach(() => {
  api = createApiMock();
  window.api = api.api;
});

function makeCfg(patch?: Partial<AppConfig>): AppConfig {
  return { tasksKeepAwake: true, ...patch } as AppConfig;
}

it('浏览按钮：pickDir 返回路径写入草稿；取消不动', async () => {
  const set = vi.fn();
  const { container } = render(<GeneralPane cfg={makeCfg({ worktreeStorageRoot: 'D:\\old' })} set={set} />);
  const input = screen.getByLabelText('worktree 存储目录') as HTMLInputElement;
  expect(input.value).toBe('D:\\old');
  const browse = screen.getByRole('button', { name: '选择目录…' });
  expect(browse).toBeTruthy();
  expect(container.querySelector('.s-path-control')).toBeTruthy();

  api.override('workspaces.pickDir', async () => ({ ok: true, path: 'E:\\worktrees' }));
  fireEvent.click(browse);
  await waitFor(() => {
    expect(set).toHaveBeenCalledWith({ worktreeStorageRoot: 'E:\\worktrees' });
  });
  // 手输框仍是受控组件：选中路径经 set 写草稿，由设置页保存后回灌

  set.mockClear();
  const pickFn = api.mockOf('workspaces.pickDir');
  pickFn.mockClear();
  api.override('workspaces.pickDir', async () => ({ ok: false, message: 'cancelled' }));
  fireEvent.click(browse);
  await waitFor(() => expect(api.mockOf('workspaces.pickDir')).toHaveBeenCalledTimes(1));
  expect(set).not.toHaveBeenCalled();
});

it('手输仍直接写草稿（高级用户粘路径）', () => {
  const set = vi.fn();
  render(<GeneralPane cfg={makeCfg()} set={set} />);
  fireEvent.change(screen.getByLabelText('worktree 存储目录'), { target: { value: 'F:\\wt' } });
  expect(set).toHaveBeenCalledWith({ worktreeStorageRoot: 'F:\\wt' });
});

it('打开位置交给宿主准备目录，失败时在当前字段显示原因', async () => {
  const storage = '/app-data/muster-console/worktrees';
  const set = vi.fn();
  api.override('shell.revealPath', async () => ({ ok: false, error: '无法创建默认 worktree 目录。请检查写入权限或选择其他目录。' }));
  render(<GeneralPane cfg={makeCfg({ worktreeStorageRoot: storage })} set={set} />);
  fireEvent.click(screen.getByRole('button', { name: '打开worktree 存储目录的位置' }));
  expect(await screen.findByText(/请检查写入权限或选择其他目录/)).toBeTruthy();
  expect(api.mockOf('shell.revealPath')).toHaveBeenCalledWith(storage);
  expect(set).not.toHaveBeenCalled();
});
