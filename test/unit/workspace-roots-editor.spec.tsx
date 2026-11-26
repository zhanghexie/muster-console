import { renderWithAppTips as render, getAppTip } from './helpers/app-tips';
import React, { useState } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { WorkspaceRoot } from '../../src/shared/types';
import { WorkspaceRootsEditor } from '../../src/renderer/src/components/WorkspaceRootsEditor';
import { CreateWorkspaceModal, type CreateWorkspaceResult } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { currentApiMock } from './helpers/api-mock';
import { legacyWorkspaceRootId } from '../../src/shared/workspaceRoots';

vi.mock('../../src/renderer/src/avatarAccent', () => ({ extractAvatarAccent: () => Promise.resolve(null) }));

const roots: WorkspaceRoot[] = [{ id: 'host', path: 'D:/MetaApp' }, { id: 'tool', path: 'E:/Tools/MetaApp' }];
function Fixture({ pick, busy = false }: { pick: () => Promise<string[] | undefined>; busy?: boolean }): React.JSX.Element {
  const [items, setItems] = useState(roots);
  const [defaultRootId, setDefault] = useState('tool');
  return <><WorkspaceRootsEditor roots={items} defaultRootId={defaultRootId} controlRootId="host" busy={busy} onPick={pick}
    onChange={(next, id) => { setItems(next); setDefault(id!); }} />
    <output aria-label="Source root state">{JSON.stringify({ items, defaultRootId })}</output></>;
}
const state = (): { items: WorkspaceRoot[]; defaultRootId: string } => JSON.parse(screen.getByRole('status', { name: 'Source root state' }).textContent!);

it('批量添加/重复/取消保留根身份与默认目录', async () => {
  const pick = vi.fn().mockResolvedValueOnce(['F:/New', 'D:/MetaApp']).mockResolvedValueOnce(undefined);
  render(<Fixture pick={pick} />);
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  await waitFor(() => expect(state().items).toHaveLength(3));
  expect(state().items[0].id).toBe('host');
  expect(state().defaultRootId).toBe('tool');
  expect(getAppTip().textContent).toBe('源文件夹已在列表中');
  const before = state();
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  await waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
  expect(state()).toEqual(before);
});

it('只显示路径，无排序和改名；切换默认不移动管理根', () => {
  render(<Fixture pick={async () => undefined} />);
  const host = screen.getAllByRole('listitem')[0];
  expect(screen.queryByRole('button', { name: '下移文件夹' })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getAllByText('D:/MetaApp')).toHaveLength(1);
  fireEvent.click(within(host).getByRole('button', { name: 'D:/MetaApp' }));
  expect(state().items.map((r) => r.id)).toEqual(['host', 'tool']);
  expect(state().defaultRootId).toBe('tool');
  fireEvent.click(within(host).getByRole('button', { name: '设为默认' }));
  expect(state().defaultRootId).toBe('host');
  expect(within(host).getByText('管理目录，保存工作区数据')).toBeTruthy();
});

it('管理根不可移除；普通移除只编辑列表，最后一根也不可移除', () => {
  render(<Fixture pick={async () => undefined} />);
  const [host, tool] = screen.getAllByRole('listitem');
  fireEvent.click(within(host).getByRole('button', { name: roots[0].path }));
  expect((within(host).getByRole('button', { name: '移除文件夹' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(tool).getByRole('button', { name: roots[1].path }));
  fireEvent.click(within(tool).getByRole('button', { name: '移除文件夹' }));
  expect(state().items).toEqual([roots[0]]);
  expect(state().defaultRootId).toBe('host');
  fireEvent.click(within(host).getByRole('button', { name: roots[0].path }));
  expect((within(host).getByRole('button', { name: '移除文件夹' }) as HTMLButtonElement).disabled).toBe(true);
});

it('忙态锁定所有编辑，目录选择期间不会重复请求', async () => {
  const pick = vi.fn(() => new Promise<string[] | undefined>(() => {}));
  const { rerender } = render(<Fixture pick={pick} />);
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  expect(pick).toHaveBeenCalledTimes(1);
  expect(screen.getAllByRole('button').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  rerender(<Fixture pick={pick} busy />);
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('关闭后忽略在途选择结果；失败显示错误并允许重试', async () => {
  let finish: (paths: string[]) => void = () => {};
  const change = vi.fn();
  const pick = vi.fn(() => new Promise<string[]>((resolve) => { finish = resolve; }));
  const { rerender } = render(<WorkspaceRootsEditor roots={roots} defaultRootId="tool" controlRootId="host" onPick={pick} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  rerender(<WorkspaceRootsEditor roots={roots} defaultRootId="tool" controlRootId="host" active={false} onPick={pick} onChange={change} />);
  finish(['F:/late']);
  await waitFor(() => expect(change).not.toHaveBeenCalled());
  rerender(<WorkspaceRootsEditor roots={roots} defaultRootId="tool" controlRootId="host" onPick={async () => { throw new Error('picker failed'); }} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  await waitFor(() => expect(getAppTip().textContent).toBe('picker failed'));
  expect((screen.getByRole('button', { name: '添加文件夹' }) as HTMLButtonElement).disabled).toBe(false);
});

it('普通创建入口默认支持批量选择，保存全部根和独立默认目录', async () => {
  currentApiMock().override('workspaces.pickDir', () => ({ ok: true, paths: ['D:/MetaApp', 'E:/Tools'] }));
  const save = vi.fn<(opts: CreateWorkspaceResult) => Promise<void>>(async () => {});
  render(<CreateWorkspaceModal onClose={() => {}} onSave={save} />);
  const create = screen.getByRole('button', { name: '创建' }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  expect(currentApiMock().mockOf('workspaces.pickDir')).toHaveBeenCalledWith(true);
  fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: 'E:/Tools' }));
  fireEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: '设为默认' }));
  fireEvent.click(create);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  const saved = save.mock.calls[0][0] as { path: string; roots: WorkspaceRoot[]; defaultRootId: string; controlRootId: string };
  expect(saved.path).toBe('E:/Tools');
  expect(saved.roots.map((r) => r.path)).toEqual(['D:/MetaApp', 'E:/Tools']);
  expect(saved.controlRootId).toBe(saved.roots[0].id);
  expect(saved.defaultRootId).toBe(saved.roots[1].id);
});

it('旧单目录工作区可直接添加第二根，保存保留原管理根和版本', async () => {
  currentApiMock().override('workspaces.pickDir', () => ({ ok: true, paths: ['E:/Tools'] }));
  const save = vi.fn<(opts: CreateWorkspaceResult) => Promise<void>>(async () => {});
  render(<CreateWorkspaceModal mode="edit" initial={{ id: 'legacy', path: 'D:/MetaApp', name: '旧工作区', rootsRevision: 3 }}
    onClose={() => {}} onSave={save} />);
  const originalId = legacyWorkspaceRootId('legacy');
  fireEvent.click(screen.getByRole('button', { name: '添加文件夹' }));
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toMatchObject({ path: 'D:/MetaApp', defaultRootId: originalId,
    controlRootId: originalId, expectedRootsRevision: 3, roots: [{ id: originalId, path: 'D:/MetaApp' }, { path: 'E:/Tools' }] });
});

it('编辑弹窗预填根及版本，保存保留根身份与旧名称元数据', async () => {
  const save = vi.fn<(opts: CreateWorkspaceResult) => Promise<void>>(async () => {});
  render(<CreateWorkspaceModal mode="edit" multiFolder initial={{ id: 'ws', path: roots[1].path, name: 'multiple', roots,
    defaultRootId: 'tool', controlRoot: roots[0].path, rootsRevision: 7 }} onClose={() => {}} onSave={save} />);
  fireEvent.change(screen.getByRole('textbox', { name: '工作区名称' }), { target: { value: '工具' } });
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0][0]).toMatchObject({ defaultRootId: 'tool', controlRootId: 'host', expectedRootsRevision: 7,
    name: '工具', roots });
});
