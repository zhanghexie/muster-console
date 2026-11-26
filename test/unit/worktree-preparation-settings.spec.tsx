import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreePreparationSettings } from '../../src/renderer/src/components/WorktreePreparationSettings';
import { CreateWorkspaceModal } from '../../src/renderer/src/components/CreateWorkspaceModal';
import type { WorktreePreparationSnapshot } from '../../src/shared/worktreePreparation';
import { legacyWorkspaceRootId } from '../../src/shared/workspaceRoots';
import { currentApiMock } from './helpers/api-mock';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());

const snapshot: WorktreePreparationSnapshot = {
  workspaceId: 'ws', rootsRevision: 2, controlKey: 'e:/a', sourceKeys: [{ rootId: 'a', physicalPath: 'e:/a' }, { rootId: 'b', physicalPath: 'd:/b' }], configVersion: 'v1',
  workspace: { id: 'ws', name: 'Workspace', path: 'E:/A', controlRoot: 'E:/A', openedAt: 0,
    roots: [{ id: 'a', path: 'E:/A', label: 'Same' }, { id: 'b', path: 'D:/B', label: 'Same' }], defaultRootId: 'a', rootsRevision: 2 },
  commands: ['echo first\necho second'], recipes: [{ rootId: 'b', relativePath: '', commands: ['echo B'] }]
};
const list = { workspaceId: 'ws', rootsRevision: 2, issueCount: 0, issues: [], repos: [
  { rootId: 'a', path: 'E:/A', name: 'A', dirty: false }, { rootId: 'b', path: 'D:/B', name: 'B', dirty: false },
  { rootId: 'b', path: 'D:/B/Plugins/Same', name: 'Same', dirty: false }
] };
const expand = () => {
  if (screen.queryByRole('button', { name: '更多设置' })?.getAttribute('aria-expanded') === 'false') fireEvent.click(screen.getByRole('button', { name: '更多设置' }));
  fireEvent.click(screen.getByRole('button', { name: '隔离准备命令' }));
};
const globalCommand = () => screen.getByRole('textbox', { name: '工作区：命令 1' }) as HTMLTextAreaElement;
const save = () => screen.getByRole('button', { name: '保存准备命令' }) as HTMLButtonElement;
beforeEach(() => {
  currentApiMock().override('workspaces.getWorktreePreparation', async () => structuredClone(snapshot));
  currentApiMock().override('git.listRepoLocations', async () => structuredClone(list));
  currentApiMock().override('workspaces.saveWorktreePreparation', async input => ({ ...structuredClone(snapshot), ...input, configVersion: 'v2' }));
});

it('参考仓排除可以添加、保存和取消，刷新和折叠不丢草稿', async () => {
  render(<WorktreePreparationSettings workspaceId="ws" active />); expand(); await waitFor(() => globalCommand());
  fireEvent.click(screen.getByRole('button', { name: '自动隔离排除仓库' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Same / Plugins/Same · D:/B/Plugins/Same' }));
  fireEvent.click(screen.getByRole('button', { name: '添加排除仓库' }));
  fireEvent.click(screen.getByRole('button', { name: '刷新仓库' }));
  await waitFor(() => expect(save().disabled).toBe(false)); expand(); expand();
  await screen.findByRole('button', { name: '取消排除 Same / Plugins/Same' });
  fireEvent.click(save()); await screen.findByText('准备命令已保存，创建隔离任务时执行。');
  expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenLastCalledWith(expect.objectContaining({
    exclusions: [{ rootId: 'b', relativePath: 'Plugins/Same' }], commands: snapshot.commands, recipes: snapshot.recipes
  }));
  fireEvent.click(screen.getByRole('button', { name: '取消排除 Same / Plugins/Same' })); fireEvent.click(save());
  await waitFor(() => expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenLastCalledWith(expect.objectContaining({ exclusions: [] })));
});

it('实际编辑工作区入口懒加载配置，整段多行命令独立保存，主表单取消不写命令', async () => {
  const onSave = vi.fn(), onClose = vi.fn();
  render(<CreateWorkspaceModal mode="edit" initial={snapshot.workspace} onSave={onSave} onClose={onClose} />);
  expect(currentApiMock().mockOf('workspaces.getWorktreePreparation')).not.toHaveBeenCalled(); expand();
  await waitFor(() => expect(globalCommand().value).toBe(snapshot.commands[0]));
  expect(currentApiMock().mockOf('git.listRepoLocations')).toHaveBeenCalledWith(false, 'ws');
  expect(currentApiMock().mockOf('git.listReposDetailed')).not.toHaveBeenCalled();
  fireEvent.change(globalCommand(), { target: { value: 'echo edited\n\necho end' } }); fireEvent.click(save());
  await screen.findByText('准备命令已保存，创建隔离任务时执行。');
  expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenCalledWith({ workspaceId: 'ws', rootsRevision: 2,
    controlKey: 'e:/a', sourceKeys: snapshot.sourceKeys, configVersion: 'v1', commands: ['echo edited\n\necho end'], recipes: snapshot.recipes, exclusions: [] });
  expect(onSave).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(onClose).toHaveBeenCalledOnce(); expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenCalledOnce();
});

it('同名来源按绝对路径选仓，手动刷新不重置草稿，折叠重开保留修改', async () => {
  render(<WorktreePreparationSettings workspaceId="ws" active />); expand(); await waitFor(() => globalCommand());
  fireEvent.change(globalCommand(), { target: { value: 'draft' } });
  fireEvent.click(screen.getByRole('button', { name: '刷新仓库' }));
  await waitFor(() => expect(currentApiMock().mockOf('git.listRepoLocations')).toHaveBeenLastCalledWith(true, 'ws'));
  await waitFor(() => expect(save().disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '准备命令目标仓库' }));
  fireEvent.click(await screen.findByRole('option', { name: 'Same / Plugins/Same · D:/B/Plugins/Same' }));
  fireEvent.click(screen.getByRole('button', { name: '添加仓库配置' }));
  const label = 'Same / Plugins/Same'; fireEvent.click(screen.getByRole('button', { name: `为 ${label} 添加命令` }));
  fireEvent.change(screen.getByRole('textbox', { name: `${label}：命令 1` }), { target: { value: 'echo plugin' } });
  expand(); expand(); await waitFor(() => expect(globalCommand().value).toBe('draft'));
  expect(currentApiMock().mockOf('workspaces.getWorktreePreparation')).toHaveBeenCalledOnce();
  fireEvent.click(save()); await screen.findByText('准备命令已保存，创建隔离任务时执行。');
  expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenLastCalledWith(expect.objectContaining({ commands: ['draft'],
    recipes: [...snapshot.recipes, { rootId: 'b', relativePath: 'Plugins/Same', commands: ['echo plugin'] }] }));
});

it('过期保存失败保留修改，只有明确重新加载才丢弃草稿，连续保存使用新版本', async () => {
  currentApiMock().override('workspaces.saveWorktreePreparation', async () => { throw Error('scope changed; reload settings'); });
  render(<WorktreePreparationSettings workspaceId="ws" active />); expand(); await waitFor(() => globalCommand());
  fireEvent.change(globalCommand(), { target: { value: 'unsaved' } }); fireEvent.click(save());
  await waitFor(() => expect(getTipSnapshot()?.text).toContain('scope changed')); expect(globalCommand().value).toBe('unsaved');
  fireEvent.click(screen.getByRole('button', { name: '重新加载配置' })); await waitFor(() => expect(globalCommand().value).toBe(snapshot.commands[0]));
  currentApiMock().override('workspaces.saveWorktreePreparation', async input => ({ ...structuredClone(snapshot), ...input, configVersion: 'v2' }));
  fireEvent.click(save()); await screen.findByText('准备命令已保存，创建隔离任务时执行。');
  fireEvent.change(globalCommand(), { target: { value: 'second save' } }); fireEvent.click(save());
  await waitFor(() => expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenLastCalledWith(expect.objectContaining({ configVersion: 'v2', commands: ['second save'] })));
});

it('切换工作区时丢弃旧读取/保存回调，来源已移除的配方仍可见并可删除', async () => {
  let resolveOld!: (value: WorktreePreparationSnapshot) => void;
  const old = new Promise<WorktreePreparationSnapshot>(resolve => { resolveOld = resolve; });
  currentApiMock().override('workspaces.getWorktreePreparation', async id => id === 'ws' ? old : { ...structuredClone(snapshot), workspaceId: 'new', recipes: [{ rootId: 'removed', relativePath: '', commands: ['preserve me'] }] });
  currentApiMock().override('git.listRepoLocations', async (_force, id) => ({ ...list, workspaceId: id }));
  const view = render(<WorktreePreparationSettings workspaceId="ws" active />); expand();
  view.rerender(<WorktreePreparationSettings workspaceId="new" active />); expand();
  await screen.findByText('该源文件夹已移除，请删除对应准备命令。');
  await act(async () => { resolveOld(snapshot); await old; });
  expect((screen.getByRole('textbox', { name: /removed.*命令 1/ }) as HTMLTextAreaElement).value).toBe('preserve me');
  fireEvent.click(screen.getByRole('button', { name: '删除 removed / （源文件夹根） 仓库配置' }));
  let resolveSave!: (value: WorktreePreparationSnapshot) => void;
  currentApiMock().override('workspaces.saveWorktreePreparation', () => new Promise(resolve => { resolveSave = resolve; }));
  fireEvent.click(save());
  view.rerender(<WorktreePreparationSettings workspaceId="ws" active />); expand(); await waitFor(() => globalCommand());
  await act(async () => resolveSave({ ...snapshot, workspaceId: 'new' }));
  expect(screen.queryByText('准备命令已保存，创建隔离任务时执行。')).toBeNull();
});

it('空白命令不提交，扫描失败仍可编辑既有配置，忙时禁止重复保存', async () => {
  currentApiMock().override('git.listRepoLocations', async () => { throw Error('discovery unavailable'); });
  render(<WorktreePreparationSettings workspaceId="ws" active />); expand(); await screen.findByText('discovery unavailable');
  fireEvent.click(screen.getByRole('button', { name: '为 工作区 添加命令' })); fireEvent.click(save()); await waitFor(() => expect(getTipSnapshot()?.tone).toBe('error'));
  expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '删除 工作区 命令 2' }));
  let resolveSave!: (value: WorktreePreparationSnapshot) => void;
  currentApiMock().override('workspaces.saveWorktreePreparation', () => new Promise(resolve => { resolveSave = resolve; }));
  fireEvent.click(save()); fireEvent.click(screen.getByRole('button', { name: '保存中…' }));
  expect(currentApiMock().mockOf('workspaces.saveWorktreePreparation')).toHaveBeenCalledOnce();
  await act(async () => resolveSave(snapshot)); await screen.findByText('准备命令已保存，创建隔离任务时执行。');
});

it('旧单目录工作区的隐式源根仍显示路径，不误报配置来源已移除', async () => {
  const id = legacyWorkspaceRootId('ws');
  currentApiMock().override('workspaces.getWorktreePreparation', async () => ({ ...structuredClone(snapshot),
    workspace: { id: 'ws', name: 'Legacy', path: 'E:/A', openedAt: 0 }, recipes: [{ rootId: id, relativePath: '', commands: ['echo legacy'] }] }));
  render(<WorktreePreparationSettings workspaceId="ws" active />); expand();
  await screen.findByRole('textbox', { name: 'E:/A / （源文件夹根）：命令 1' });
  expect(screen.queryByText('该源文件夹已移除，请删除对应准备命令。')).toBeNull();
  expect(screen.getByText('E:/A', { exact: true })).toBeTruthy();
});
