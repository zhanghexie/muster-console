import { renderWithAppTips as render } from './helpers/app-tips';
import React, { useState } from 'react';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GeneralPane } from '../../src/renderer/src/components/settings/GeneralPane';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import { currentApiMock } from './helpers/api-mock';
import type { AppConfig } from '../../src/shared/types';

beforeEach(() => {
  currentApiMock().override('config.waitingTips', async () => ({ ok: true, path: '/home/example/tips.json', tips: [{ 'zh-CN': '查看会话历史', en: 'History' }, { 'zh-CN': '查找消息', en: 'Find messages' }] }));
});
it('uses the flat template and groups journal settings with conversations', async () => {
  const { container } = render(<GeneralPane cfg={{} as AppConfig} set={() => {}}/>);
  expect(container.querySelector('.settings-content')?.getAttribute('data-settings-layout')).toBe('flat');
  const journal = screen.getByRole('checkbox', { name: '会话结束自动写日志' }).closest('section')!;
  expect(within(journal).getByRole('heading', { name: '会话与记录' })).toBeTruthy();
  expect(within(journal).getByRole('checkbox', { name: '只显示当前思考' })).toBeTruthy();
  const tasks = screen.getByRole('textbox', { name: 'worktree 存储目录' }).closest('section')!;
  expect(within(tasks).getByRole('heading', { name: '任务与工作区' })).toBeTruthy();
  expect(within(tasks).getByRole('checkbox', { name: '任务运行时阻止休眠' })).toBeTruthy();
  await act(async () => {});
});
it('opens and searches the tip catalog without changing the draft, traps focus and restores it on Escape', async () => {
  const setDraft = vi.fn();
  function Holder() { const [cfg, setCfg] = useState({ showWaitingTips: false } as AppConfig); return <KeybindingProvider><GeneralPane cfg={cfg} set={patch => { setDraft(patch); setCfg(previous => ({ ...previous, ...patch })); }}/></KeybindingProvider>; }
  render(<Holder/>);
  await userEvent.click(screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }));
  const trigger = screen.getByRole('button', { name: '查看全部提示' });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('dialog', { name: '全部功能提示' });
  expect((document.querySelector('.settings-content') as HTMLElement).inert).toBe(true);
  const search = within(dialog).getByRole('searchbox', { name: '搜索功能提示' });
  expect(document.activeElement).toBe(search);
  await within(dialog).findByText('查看会话历史');
  await userEvent.type(search, '历史');
  expect(within(dialog).queryByText('查找消息')).toBeNull();
  currentApiMock().override('shell.revealPath', async () => ({ ok: true }));
  await userEvent.click(within(dialog).getByRole('button', { name: '打开功能提示文件的位置' }));
  expect(currentApiMock().mockOf('shell.revealPath')).toHaveBeenCalledWith('/home/example/tips.json');
  within(dialog).getByRole('button', { name: '关闭' }).focus();
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: '重新读取' }));
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: '全部功能提示' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect((document.querySelector('.settings-content') as HTMLElement).inert).toBe(false);
  expect((screen.getByRole('checkbox', { name: '任务运行时阻止休眠' }) as HTMLInputElement).checked).toBe(false);
  expect(setDraft.mock.calls).toEqual([[{ tasksKeepAwake: false }]]);
});
it('reports directory-picker failure in the window tip, and cancellation does not change the draft', async () => {
  const api = currentApiMock(), set = vi.fn();
  api.override('workspaces.pickDir', async () => { throw new Error('folder picker unavailable'); });
  render(<GeneralPane cfg={{} as AppConfig} set={set}/>);
  await userEvent.click(screen.getByRole('button', { name: '选择目录…' }));
  await screen.findByText('folder picker unavailable');
  expect(set).not.toHaveBeenCalled();
  api.override('workspaces.pickDir', async () => ({ ok: false, message: 'cancelled' }));
  await userEvent.click(screen.getByRole('button', { name: '选择目录…' }));
  expect(screen.queryByText('cancelled')).toBeNull();
  expect(set).not.toHaveBeenCalled();
});
