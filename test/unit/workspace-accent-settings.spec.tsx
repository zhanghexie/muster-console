import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WorkspaceAccentSettings } from '../../src/renderer/src/components/settings/WorkspaceAccentSettings';
import { applyWorkspaceAccentPatch, setWorkspaceAccentDefault, WORKSPACE_ACCENTS } from '../../src/shared/workspaceAccent';
import type { WorkspaceInfo, WorkspaceUpdateOptions } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/avatarAccent', () => ({ extractAvatarAccent: () => Promise.resolve('#aabbcc') }));

function setup(overrides: Partial<WorkspaceInfo> = {}, enabled = true) {
  let workspaces: WorkspaceInfo[] = [
    { id: 'a', name: '项目 A', path: 'E:/a', openedAt: 1, avatar: '🤖', ...overrides },
    { id: 'b', name: '项目 B', path: 'E:/b', openedAt: 2, accent: '#f06a8a' }
  ];
  let defaults = { accent: WORKSPACE_ACCENTS[1], enabled };
  const api = currentApiMock();
  api.override('config.get', () => Promise.resolve({ workspaces, activeWorkspaceId: 'a', workspaceAccentDefault: defaults }));
  api.override('config.update', (patch) => {
    defaults = patch.workspaceAccentDefault;
    return Promise.resolve({ workspaces, activeWorkspaceId: 'a', workspaceAccentDefault: defaults });
  });
  api.override('workspaces.update', (id: string, patch: WorkspaceUpdateOptions) => {
    workspaces = workspaces.map(ws => ws.id === id ? applyWorkspaceAccentPatch(ws, patch) : ws);
    return Promise.resolve({ ok: true, workspaces, activeWorkspaceId: 'a' });
  });
  setWorkspaceAccentDefault(undefined);
  render(<WorkspaceAccentSettings />);
  return api;
}

const color = (hex: string) => screen.getByRole('button', { name: hex });
const scope = () => screen.getByRole('group', { name: '主题色作用范围' });
const enabled = () => screen.getByRole('checkbox', { name: '启用主题色' }) as HTMLInputElement;

it('全局设置只写默认；切换编辑范围本身不写配置', async () => {
  const api = setup();
  await screen.findByRole('checkbox', { name: '启用主题色' });
  fireEvent.click(color(WORKSPACE_ACCENTS[0]));
  await waitFor(() => expect(color(WORKSPACE_ACCENTS[0]).getAttribute('aria-pressed')).toBe('true'));
  expect(api.mockOf('config.update')).toHaveBeenCalledWith({ workspaceAccentDefault: { accent: WORKSPACE_ACCENTS[0], enabled: true } });
  fireEvent.click(within(scope()).getByRole('button', { name: '仅当前工作区' }));
  expect(api.mockOf('workspaces.update')).not.toHaveBeenCalled();
  expect(screen.getByText('当前工作区跟随全局默认')).toBeTruthy();
  fireEvent.click(color(WORKSPACE_ACCENTS[4]));
  await waitFor(() => expect(api.mockOf('workspaces.update')).toHaveBeenCalledWith('a', { accent: WORKSPACE_ACCENTS[4], accentOff: false }));
  await screen.findByText('当前工作区已单独设置');
});

it('局部启用可以覆盖全局禁用；恢复全局同时恢复开关和颜色', async () => {
  const api = setup({}, false);
  await screen.findByRole('checkbox', { name: '启用主题色' });
  fireEvent.click(within(scope()).getByRole('button', { name: '仅当前工作区' }));
  expect(enabled().checked).toBe(false);
  expect((color(WORKSPACE_ACCENTS[1]) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(enabled());
  await waitFor(() => expect(enabled().checked).toBe(true));
  expect(api.mockOf('workspaces.update')).toHaveBeenCalledWith('a', { accent: WORKSPACE_ACCENTS[1], accentOff: false });
  fireEvent.click(screen.getByRole('button', { name: '恢复跟随全局' }));
  await waitFor(() => expect(enabled().checked).toBe(false));
  expect(api.mockOf('workspaces.update')).toHaveBeenLastCalledWith('a', { accent: null, accentOff: false });
});

it('旧工作区覆盖原样回显；手选自定义与跟随头像即时保存', async () => {
  const api = setup({ accent: '#123456' });
  await screen.findByText('当前工作区已单独设置');
  expect(within(scope()).getByRole('button', { name: '仅当前工作区' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.change(screen.getByLabelText('自定义主题色'), { target: { value: '#abcdef' } });
  await waitFor(() => expect(api.mockOf('workspaces.update')).toHaveBeenCalledWith('a', { accent: '#abcdef', accentOff: false }));
  await waitFor(() => expect(enabled().disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '跟随头像' }));
  await waitFor(() => expect(api.mockOf('workspaces.update')).toHaveBeenLastCalledWith('a', { accent: 'avatar', accentOff: false, avatarAccent: '#aabbcc' }));
});

it('保存失败显示错误并保留原设置；重试可继续保存', async () => {
  const api = setup({ accent: WORKSPACE_ACCENTS[1] });
  await screen.findByText('当前工作区已单独设置');
  api.mockOf('workspaces.update').mockResolvedValueOnce({ ok: false, message: 'disk full' });
  fireEvent.click(color(WORKSPACE_ACCENTS[0]));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'disk full');
  expect(color(WORKSPACE_ACCENTS[1]).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(color(WORKSPACE_ACCENTS[0]));
  await waitFor(() => expect(color(WORKSPACE_ACCENTS[0]).getAttribute('aria-pressed')).toBe('true'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('工作区切换事件后编辑新的当前区，不写回旧工作区', async () => {
  const api = setup({ accent: WORKSPACE_ACCENTS[1] });
  await screen.findByText('当前工作区已单独设置');
  act(() => api.emit('workspaces:changed', { activeWorkspaceId: 'b', workspaces: [{ id: 'b', name: '项目 B', accent: '#f06a8a' }] }));
  fireEvent.click(color(WORKSPACE_ACCENTS[0]));
  await waitFor(() => expect(api.mockOf('workspaces.update')).toHaveBeenCalledWith('b', { accent: WORKSPACE_ACCENTS[0], accentOff: false }));
});
