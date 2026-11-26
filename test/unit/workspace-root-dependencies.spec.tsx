import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SessionMeta, WorkspaceInfo, WorkspaceRootDependency } from '../../src/shared/types';
import { CreateWorkspaceModal } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { WorkspaceRootDependencies, WorkspaceSaveError } from '../../src/renderer/src/components/WorkspaceRootDependencies';
import { AgentFloat } from '../../src/renderer/src/panels/AgentFloat';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { openWorkspaceDependency } from '../../src/renderer/src/workspaceDependencyNavigation';
import { currentApiMock } from './helpers/api-mock';

const accent = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/src/avatarAccent', () => ({ extractAvatarAccent: accent }));
class ResizeObserverStub { observe(): void {} unobserve(): void {} disconnect(): void {} }
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

const workspace: WorkspaceInfo = { id: 'ws', name: 'Multi', path: 'D:/Host', controlRoot: 'D:/Host',
  openedAt: 1, rootsRevision: 7, defaultRootId: 'host',
  roots: [{ id: 'host', path: 'D:/Host', label: '同名根' }, { id: 'tool', path: 'E:/Tools', label: '同名根' }] };
const other: WorkspaceInfo = { id: 'other', name: 'Other', path: 'F:/Other', openedAt: 1 };
const dependencies: WorkspaceRootDependency[] = [
  { rootId: 'tool', kind: 'session', id: 'terminal', label: 'Tool worker', sessionId: 'terminal' },
  { rootId: 'tool', kind: 'service', id: 'service', label: 'Disabled service', serviceId: 'service' },
  { rootId: 'tool', kind: 'open-file', id: 'view', label: 'src/same.ts', relativePath: 'src/same.ts' },
  { rootId: 'tool', kind: 'queued-task', id: 'queue', label: 'Queued tool task' },
  { rootId: 'tool', kind: 'file-write', id: 'write', label: 'src/same.ts' }
];
const terminal = { id: 'terminal', type: 'terminal', name: 'Tool worker', workspaceId: 'ws', cwd: 'E:/Tools',
  sourceRoot: { rootId: 'tool', path: 'E:/Tools', cwd: 'E:/Tools' }, status: 'running' } as SessionMeta;
const service = { ...terminal, id: 'scheduled', type: 'scheduled', serviceId: 'service' } as SessionMeta;

beforeEach(() => { accent.mockReset(); accent.mockResolvedValue(null); });
it('后台任务与排队写入显示来源和等待提示', () => {
  render(<WorkspaceRootDependencies roots={workspace.roots!} dependencies={[
    { rootId: 'tool', kind: 'background-task', id: 'task-1', label: 'task-1 · Pending task' },
    { rootId: 'tool', kind: 'file-write', id: 'pending:task-2', label: 'Queued write' }
  ]} />);
  expect(screen.getByText('task-1 · Pending task')).toBeTruthy();
  expect(screen.getAllByText('操作仍在进行，请稍后重试保存')).toHaveLength(2);
  expect(screen.queryByRole('button')).toBeNull();
});
function initial() { return { ...workspace, roots: workspace.roots!.map(root => ({ ...root })) }; }
function removeTool() {
  fireEvent.click(within(document.querySelector('[data-root-id="tool"]') as HTMLElement).getByRole('button', { name: initial().roots![1].path }));
  fireEvent.click(within(document.querySelector('[data-root-id="tool"]') as HTMLElement).getByRole('button', { name: '移除文件夹' }));
}
function Probe(): React.JSX.Element {
  const { requestWorkspaceEdit, openWorkspaceFile } = useUiStore();
  return <><button onClick={() => requestWorkspaceEdit('ws')}>编辑 Multi</button>
    <button onClick={() => requestWorkspaceEdit('other')}>编辑 Other</button>
    <output data-testid="opened-file">{JSON.stringify(openWorkspaceFile)}</output></>;
}
function seed(activeWorkspaceId = 'ws') {
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces: [workspace, other], activeWorkspaceId }));
  mock.override('config.get', async () => ({ workspaces: [workspace, other], activeWorkspaceId, locale: 'zh-CN' }));
  mock.override('codeAnalysis.status', async () => ({ ok: false }));
  mock.override('sessions.list', async () => ({ sessions: [terminal, service], activeId: null }));
  mock.override('workspaces.update', async () => ({ ok: false, message: 'blocked', rootDependencies: dependencies }));
  return mock;
}
async function renderParent() {
  render(<StoreProvider><AgentFloat stackInline /><Probe /></StoreProvider>);
  await screen.findByTitle(/Multi/);
  fireEvent.click(screen.getByRole('button', { name: '编辑 Multi' }));
  await screen.findByRole('dialog', { name: '编辑工作区' });
  await waitFor(() => expect(document.querySelector('[data-root-id="tool"]')).toBeTruthy());
}

it('真实 Store/弹窗保存携根版本，显示结构化依赖；失败保留草稿，重试重新检查', async () => {
  const mock = seed(); await renderParent(); removeTool();
  fireEvent.change(screen.getByDisplayValue('Multi'), { target: { value: 'Draft name' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  const blockers = await screen.findByRole('region', { name: '移除受阻的依赖' });
  expect(within(blockers).getAllByRole('listitem')).toHaveLength(5);
  expect(within(blockers).getByRole('button', { name: '查看服务' })).toBeTruthy();
  expect(within(blockers).getByRole('button', { name: '查看会话' })).toBeTruthy();
  expect(within(blockers).getByRole('button', { name: '打开文件' })).toBeTruthy();
  expect(within(blockers).getAllByText('操作仍在进行，请稍后重试保存')).toHaveLength(2);
  expect(screen.getByDisplayValue('Draft name')).toBeTruthy();
  expect(document.querySelector('[data-root-id="tool"]')).toBeNull();
  expect(mock.mockOf('workspaces.update')).toHaveBeenCalledWith('ws', expect.objectContaining({
    name: 'Draft name', roots: [workspace.roots![0]], defaultRootId: 'host', expectedRootsRevision: 7
  }));
  mock.override('workspaces.update', async () => ({ ok: true, workspaces: [workspace, other], activeWorkspaceId: 'ws' }));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑工作区' })).toBeNull());
  expect(mock.mockOf('fs.closeFile')).not.toHaveBeenCalled();
  expect(mock.mockOf('sessions.close')).not.toHaveBeenCalled();
});

it('查看文件携原 rootId，关闭设置但不保存草稿或解除其他视图', async () => {
  const mock = seed(); await renderParent(); removeTool();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  fireEvent.click(await screen.findByRole('button', { name: '打开文件' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑工作区' })).toBeNull());
  expect(JSON.parse(screen.getByTestId('opened-file').textContent!).fileRef).toEqual({
    workspaceId: 'ws', rootId: 'tool', relativePath: 'src/same.ts'
  });
  expect(mock.mockOf('workspaces.update')).toHaveBeenCalledTimes(1);
  expect(mock.mockOf('fs.closeFile')).not.toHaveBeenCalled();
});

it('真实 Store 从非活动区编辑跳转文件，切区后立即导航仍携正确 FileRef', async () => {
  const mock = seed('other');
  mock.override('workspaces.switch', async () => ({ ok: true, workspaces: [workspace, other], activeWorkspaceId: 'ws' }));
  await renderParent(); removeTool(); fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('button', { name: '打开文件' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '打开文件' })); });
  await waitFor(() => expect(JSON.parse(screen.getByTestId('opened-file').textContent!)?.fileRef).toEqual({
    workspaceId: 'ws', rootId: 'tool', relativePath: 'src/same.ts'
  }));
  expect(mock.mockOf('workspaces.switch')).toHaveBeenCalledWith('ws');
});

it('查看服务选择实际 scheduled 会话；对象已删除时报错且保留设置与依赖', async () => {
  const mock = seed(); await renderParent(); removeTool();
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('button', { name: '查看服务' });
  mock.override('sessions.list', async () => ({ sessions: [], activeId: null }));
  fireEvent.click(screen.getByRole('button', { name: '查看服务' }));
  await waitFor(() => expect(getAppTip().textContent).toContain('依赖对象已变更'));
  expect(screen.getByRole('dialog', { name: '编辑工作区' })).toBeTruthy();
  expect(mock.mockOf('sessions.select')).not.toHaveBeenCalled();
  mock.override('sessions.list', async () => ({ sessions: [service], activeId: null }));
  fireEvent.click(screen.getByRole('button', { name: '查看服务' }));
  await waitFor(() => expect(mock.mockOf('sessions.select')).toHaveBeenCalledWith('scheduled'));
});

it('关闭后旧保存错误不进入另一工作区的编辑弹窗', async () => {
  const mock = seed(); let finish!: (result: unknown) => void;
  mock.override('workspaces.update', () => new Promise(resolve => { finish = resolve; }));
  await renderParent(); removeTool(); fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑 Other' }));
  await screen.findByDisplayValue('Other');
  await act(async () => { finish({ ok: false, message: 'old failure', rootDependencies: dependencies }); });
  expect(screen.queryByRole('region', { name: '移除受阻的依赖' })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('同一工作区关闭并重开后，旧保存成功和旧导航都不能关闭或跳转新弹窗', async () => {
  const mock = seed(); let finish!: (result: unknown) => void;
  mock.override('workspaces.update', () => new Promise(resolve => { finish = resolve; }));
  await renderParent(); removeTool(); fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑 Multi' }));
  await screen.findByDisplayValue('Multi');
  await act(async () => { finish({ ok: true, workspaces: [workspace, other], activeWorkspaceId: 'ws' }); });
  expect(screen.getByRole('dialog', { name: '编辑工作区' })).toBeTruthy();
  mock.override('workspaces.update', async () => ({ ok: false, message: 'blocked', rootDependencies: dependencies }));
  removeTool(); fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('button', { name: '查看会话' });
  mock.override('sessions.list', () => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: '查看会话' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑 Multi' }));
  await screen.findByDisplayValue('Multi');
  await act(async () => { finish({ sessions: [terminal], activeId: null }); });
  expect(screen.getByRole('dialog', { name: '编辑工作区' })).toBeTruthy();
  expect(mock.mockOf('sessions.select')).not.toHaveBeenCalled();
});

it.each([true, false])('旧关闭工作区操作返回（ok=%s）不关闭另一工作区设置或显示旧错误', async (ok) => {
  const mock = seed(); let finish!: (result: unknown) => void;
  mock.override('workspaces.close', () => new Promise(resolve => { finish = resolve; }));
  await renderParent(); fireEvent.click(screen.getByRole('button', { name: '更多设置' })); fireEvent.click(screen.getByRole('button', { name: '关闭工作区' }));
  fireEvent.click(screen.getByRole('button', { name: '确认关闭' }));
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  fireEvent.click(within(screen.getByRole('dialog', { name: '编辑工作区' })).getByRole('button', { name: '关闭' }));
  fireEvent.click(screen.getByRole('button', { name: '编辑 Other' }));
  await screen.findByDisplayValue('Other');
  await act(async () => { finish(ok ? { ok: true, workspaces: [other], activeWorkspaceId: 'other' } : { ok: false, message: 'old close failure' }); });
  expect(screen.getByRole('dialog', { name: '编辑工作区' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('解码头像期间锁重复保存；关闭后不调用旧保存，重新打开重置状态', async () => {
  let finish!: (accent: string | null) => void;
  accent.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const save = vi.fn(async () => {});
  const { rerender } = render(<CreateWorkspaceModal mode="edit" multiFolder initial={initial()} onClose={() => {}} onSave={save} />);
  const button = screen.getByRole('button', { name: '保存' });
  fireEvent.click(button); fireEvent.click(button);
  expect(accent).toHaveBeenCalledTimes(1);
  expect((screen.getByDisplayValue('Multi') as HTMLInputElement).disabled).toBe(true);
  // The settings toggle is locked while saving, as are the hidden index actions.
  expect((screen.getByRole('button', { name: '更多设置' }) as HTMLButtonElement).disabled).toBe(true);
  rerender(<CreateWorkspaceModal mode="edit" multiFolder open={false} initial={initial()} onClose={() => {}} onSave={save} />);
  await act(async () => { finish(null); });
  expect(save).not.toHaveBeenCalled();
  rerender(<CreateWorkspaceModal mode="edit" multiFolder initial={initial()} onClose={() => {}} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
});

it('修改移除草稿清除旧依赖；普通创建也开放多根入口', async () => {
  const error = new WorkspaceSaveError('blocked', dependencies);
  const { unmount } = render(<CreateWorkspaceModal mode="edit" multiFolder initial={initial()} onClose={() => {}}
    onSave={async () => { throw error; }} />);
  removeTool(); fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await screen.findByRole('region', { name: '移除受阻的依赖' });
  currentApiMock().override('workspaces.pickDir', async () => ({ ok: true, paths: ['F:/New'] }));
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  await waitFor(() => expect(screen.queryByRole('region', { name: '移除受阻的依赖' })).toBeNull());
  unmount(); render(<CreateWorkspaceModal onClose={() => {}} onSave={async () => {}} />);
  expect(screen.getByRole('button', { name: '添加文件夹' })).toBeTruthy();
});

function navigation(dependency = dependencies[0]) {
  return { workspace, dependency, activeWorkspaceId: 'other', getWorkspace: () => workspace,
    isCurrent: () => true, switchWorkspace: vi.fn(async () => ({ ok: true })), openFile: vi.fn() };
}
it('跨区查看先切到原工作区；切换失败不 select、不打开文件', async () => {
  const mock = currentApiMock(); mock.override('sessions.list', async () => ({ sessions: [terminal], activeId: null }));
  const input = navigation(); await openWorkspaceDependency(input);
  expect(input.switchWorkspace).toHaveBeenCalledWith('ws');
  expect(mock.mockOf('sessions.select')).toHaveBeenCalledWith('terminal');
  const file = navigation(dependencies[2]); file.switchWorkspace.mockResolvedValue({ ok: false });
  await expect(openWorkspaceDependency(file)).rejects.toThrow('切换失败');
  expect(file.openFile).not.toHaveBeenCalled();
});
it('等待列表/切区时源身份失效、窗口关闭或会话换根都不继续导航', async () => {
  const mock = currentApiMock(); let finish!: (result: { sessions: SessionMeta[]; activeId: null }) => void;
  mock.override('sessions.list', () => new Promise(resolve => { finish = resolve; }));
  let current = true;
  const input = { ...navigation(), isCurrent: () => current };
  const pending = openWorkspaceDependency(input); current = false;
  finish({ sessions: [terminal], activeId: null });
  await expect(pending).rejects.toThrow('依赖对象已变更');
  expect(input.switchWorkspace).not.toHaveBeenCalled();
  mock.override('sessions.list', async () => ({ sessions: [{ ...terminal, sourceRoot: { ...terminal.sourceRoot!, rootId: 'host' } }], activeId: null }));
  await expect(openWorkspaceDependency(navigation())).rejects.toThrow('依赖对象已变更');
  const file = navigation(dependencies[2]); let rootExists = true;
  const switching = { ...file, getWorkspace: () => rootExists ? workspace : { ...workspace, roots: [workspace.roots![0]] },
    switchWorkspace: async () => { rootExists = false; return { ok: true }; } };
  await expect(openWorkspaceDependency(switching)).rejects.toThrow('依赖对象已变更');
  expect(file.openFile).not.toHaveBeenCalled();
  expect(mock.mockOf('sessions.select')).not.toHaveBeenCalled();
});
