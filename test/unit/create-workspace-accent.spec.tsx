/** 主题色已迁入外观设置；工作区编辑只更新头像缓存，不覆盖颜色作用域。 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CreateWorkspaceModal, type CreateWorkspaceResult } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { legacyWorkspaceRootId } from '../../src/shared/workspaceRoots';
vi.mock('../../src/renderer/src/avatarAccent', () => ({
  extractAvatarAccent: (avatar?: string) => Promise.resolve(avatar === 'builtin-workspace:news' ? '#f08a3d' : '#7a6cff')
}));
it('关闭工作区使用独立确认弹窗，取消不关闭，确认才执行', async () => {
  const remove = vi.fn(async () => {});
  render(<CreateWorkspaceModal mode="edit" initial={{ id: 'a', path: 'E:/a', name: 'A' }} onClose={() => {}} onSave={async () => {}} onDelete={remove} canDelete />);
  fireEvent.click(screen.getByRole('button', { name: '更多设置' }));
  fireEvent.click(screen.getByRole('button', { name: '关闭工作区' }));
  const dialog = await screen.findByRole('dialog', { name: '关闭工作区' });
  expect(dialog.closest('.create-ws-modal')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '关闭工作区' }));
  fireEvent.click(within(await screen.findByRole('dialog', { name: '关闭工作区' })).getByRole('button', { name: '确认关闭' }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
});
it('编辑工作区不再显示主题色；改头像仅保存头像缓存', async () => {
  const onSave = vi.fn<(r: CreateWorkspaceResult) => Promise<void>>(() => Promise.resolve());
  render(<CreateWorkspaceModal mode="edit" initial={{ id:'a',path:'E:/a',name:'A',avatar:'🤖' }} onClose={() => {}} onSave={onSave} />);
  expect(screen.queryByText('主题色')).toBeNull();
  expect(screen.queryByRole('button', {name:'跟随头像'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name:'更换头像'}));
  fireEvent.click(screen.getByRole('option', {name:'新闻'}));
  fireEvent.click(screen.getByRole('button', {name:'保存'}));
  await waitFor(() => expect(onSave).toHaveBeenCalled());
  expect(onSave.mock.calls[0][0]).toEqual({ path:'E:/a',name:'A',avatar:'builtin-workspace:news',avatarAccent:'#f08a3d',
    roots: [{ id: legacyWorkspaceRootId('a'), path: 'E:/a' }], defaultRootId: legacyWorkspaceRootId('a'),
    controlRootId: legacyWorkspaceRootId('a'), expectedRootsRevision: 0 });
});
