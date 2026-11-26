import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { WorkspaceInfo } from '../../src/shared/types';
import { StoreProvider } from '../../src/renderer/src/store';
import { WorkspaceDetailPage } from '../../src/renderer/src/mobile/pages/WorkspaceDetailPage';
import { currentApiMock } from './helpers/api-mock';

const ws: WorkspaceInfo = { id: 'own', name: 'Own', path: 'E:/A', openedAt: 0, roots: [
  { id: 'a', path: 'E:/A', label: 'Same' }, { id: 'b', path: 'D:/B', label: 'Same' }
], defaultRootId: 'b', controlRoot: 'E:/A', rootsRevision: 3 };
const other: WorkspaceInfo = { id: 'active', name: 'Active', path: 'F:/Other', openedAt: 0 };
const p = () => ({ wsId: 'own', onBack: vi.fn(), onTip: vi.fn(), onOpenChat: vi.fn() });
const data = (workspaces = [ws, other]) => ({ workspaces, activeWorkspaceId: other.id });
beforeEach(() => {
  const api = currentApiMock(); api.override('config.get', async () => data()); api.override('workspaces.list', async () => data());
  api.override('runtimes.list', async () => [{ id: 'pi', label: 'Pi', enabled: true, surface: 'chat' }]);
  api.override('runtimes.availability', async () => ({ runtimes: [{ id: 'pi', label: 'Pi', enabled: true, surface: 'chat' }], acpAgents: [], checkedAt: 1 }));
  api.override('sessions.create', async () => ({ id: 'created' }));
});
const open = async () => {
  const button = screen.getByRole('button', { name: '新建会话' });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button); await screen.findByRole('button', { name: 'Pi' });
};
const view = (props: ReturnType<typeof p>) => <StoreProvider><WorkspaceDetailPage {...props} /></StoreProvider>;

it('工作区清单未加载时不能创建，加载后选择正确默认根', async () => {
  let finish!: (v: ReturnType<typeof data>) => void;
  const pending = new Promise<ReturnType<typeof data>>(resolve => { finish = resolve; });
  const api = currentApiMock(); api.override('config.get', () => pending); api.override('workspaces.list', () => pending);
  render(view(p())); expect(screen.getByRole('button', { name: '新建会话' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '新建会话' })); expect(screen.queryByRole('dialog')).toBeNull();
  await act(async () => finish(data())); await open(); fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(api.mockOf('sessions.create')).toHaveBeenCalledWith({ runtime: 'pi', workspaceId: 'own', rootId: 'b', rootsRevision: 3 }));
});

it('手机新会话绑定显示的工作区和默认第二根，不使用全局活动工作区', async () => {
  const props = p(); render(view(props)); await waitFor(() => expect(currentApiMock().mockOf('workspaces.list')).toHaveBeenCalled());
  await open(); fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(props.onOpenChat).toHaveBeenCalledWith('own', { kind: 'session', sessionId: 'created' }));
  expect(currentApiMock().mockOf('sessions.create')).toHaveBeenCalledWith({ runtime: 'pi', workspaceId: 'own', rootId: 'b', rootsRevision: 3 });
});

it('手选根和默认变更保持选择，根移除后须显式重选', async () => {
  render(view(p())); await open();
  await act(async () => currentApiMock().emit('workspaces:changed', data([{ ...ws, defaultRootId: 'a', rootsRevision: 4 }, other])));
  expect(screen.getByText('D:/B')).toBeTruthy();
  await act(async () => currentApiMock().emit('workspaces:changed', data([{ ...ws, defaultRootId: 'a', roots: [ws.roots![0]], rootsRevision: 5 }, other])));
  expect(getAppTip().textContent).toMatch(/所选源文件夹已失效/);
  expect(screen.getByRole('button', { name: 'Pi' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '运行位置' }));
  fireEvent.click(await screen.findByRole('option', { name: 'E:/A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(currentApiMock().mockOf('sessions.create')).toHaveBeenCalledWith({ runtime: 'pi', workspaceId: 'own', rootId: 'a', rootsRevision: 5 }));
});

it('创建失败保留抽屉/目录并显示原因，重试不会重复创建', async () => {
  const props = p(); const api = currentApiMock(); api.mockOf('sessions.create').mockRejectedValueOnce(new Error('offline'));
  render(view(props)); await open(); fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(props.onTip).toHaveBeenCalledWith('offline'));
  expect(screen.getByRole('button', { name: 'Pi' })).toBeTruthy(); expect(props.onOpenChat).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(props.onOpenChat).toHaveBeenCalledOnce()); expect(api.mockOf('sessions.create')).toHaveBeenCalledTimes(2);
});

it('页面切换或卸载后的创建返回不跳转、不向其他工作区发提示', async () => {
  const props = p(); let resolve!: (v: unknown) => void;
  currentApiMock().mockOf('sessions.create').mockImplementation(() => new Promise(done => { resolve = done; }));
  const instance = render(view(props)); await open(); fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(currentApiMock().mockOf('sessions.create')).toHaveBeenCalledOnce());
  instance.rerender(view({ ...props, wsId: 'active' })); await act(async () => resolve({ id: 'late' }));
  expect(props.onOpenChat).not.toHaveBeenCalled(); expect(props.onTip).not.toHaveBeenCalled();
  await open(); fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(currentApiMock().mockOf('sessions.create')).toHaveBeenCalledTimes(2)); instance.unmount();
  await act(async () => resolve({ id: 'unmounted' })); expect(props.onOpenChat).not.toHaveBeenCalled();
});

it('关闭工作区后不回落活动区，旧单根使用稳定 ID', async () => {
  const props = p(); const instance = render(view(props)); await open();
  await act(async () => currentApiMock().emit('workspaces:changed', data([other])));
  expect(getAppTip().textContent).toMatch(/请先打开工作区/);
  expect(screen.getByRole('button', { name: 'Pi' }).hasAttribute('disabled')).toBe(true);
  instance.rerender(view({ ...props, wsId: 'active' })); await open(); fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(currentApiMock().mockOf('sessions.create')).toHaveBeenCalledWith({ runtime: 'pi', workspaceId: 'active', rootId: 'root-active', rootsRevision: undefined }));
});

it('手机新建的检测失败不回落注册类型，重新检测保留源文件夹', async () => {
  const api = currentApiMock(); let reject!: (error: Error) => void;
  api.override('runtimes.availability', () => new Promise((_resolve, fail) => { reject = fail; }));
  const props = p(); render(view(props));
  const fab = screen.getByRole('button', { name: '新建会话' });
  await waitFor(() => expect((fab as HTMLButtonElement).disabled).toBe(false)); fireEvent.click(fab);
  expect(screen.getByText('正在检测 Worker…')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Pi' })).toBeNull();
  await act(async () => reject(new Error('probe offline')));
  expect(screen.getByText('Worker 检测失败：probe offline')).toBeTruthy();
  api.override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 2 }));
  fireEvent.click(screen.getByRole('button', { name: '重新检测 Worker' }));
  await screen.findByText('暂无可用 Worker，请在设置中安装或配置');
  expect(screen.getByRole('button', { name: '运行位置' }).textContent).toContain('D:/B');
  expect(api.mockOf('sessions.create')).not.toHaveBeenCalled(); expect(props.onOpenChat).not.toHaveBeenCalled();
});

it('手机提交前重检失败不创建，重新检测后用实际可用 ACP 预设', async () => {
  const api = currentApiMock(); const props = p(); render(view(props)); await open();
  api.override('runtimes.availability', async () => ({ runtimes: [], acpAgents: [], checkedAt: 2 }));
  fireEvent.click(screen.getByRole('button', { name: 'Pi' }));
  await waitFor(() => expect(props.onTip).toHaveBeenCalledWith('所选 Worker 已不可用，请重新选择'));
  expect(api.mockOf('sessions.create')).not.toHaveBeenCalled();
  const acp = { id: 'acp', label: 'ACP', enabled: true, surface: 'chat' };
  api.override('runtimes.availability', async () => ({ runtimes: [acp], acpAgents: [{ id: 'codex', name: 'Codex' }], checkedAt: 3 }));
  act(() => api.emit('runtimes:changed', [acp]));
  fireEvent.click(await screen.findByRole('button', { name: 'ACP' }));
  await waitFor(() => expect(api.mockOf('sessions.create')).toHaveBeenCalledWith({ runtime: 'acp', piModeId: 'codex', workspaceId: 'own', rootId: 'b', rootsRevision: 3 }));
});
