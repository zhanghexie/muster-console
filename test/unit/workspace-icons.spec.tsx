import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WORKSPACE_ICONS, DEFAULT_WORKSPACE_ICON, workspaceIconValue } from '../../src/shared/workspaceIcons';
import { workspaceAvatarImageSrc, workspaceIconUrl } from '../../src/renderer/src/workspaceIcons';
import { CreateWorkspaceModal } from '../../src/renderer/src/components/CreateWorkspaceModal';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
vi.mock('../../src/renderer/src/avatarAccent', () => ({ extractAvatarAccent: async () => '#6499ff' }));

it.each(WORKSPACE_ICONS)('编辑工作区选择 $label，存稳定 ID 并保持图片与选中态', async icon => {
  const save = vi.fn(async () => {});
  render(<CreateWorkspaceModal mode="edit" initial={{ id:'ws', path:'E:/source', name:'My app', avatar:'🤖' }} onClose={() => {}} onSave={save} />);
  fireEvent.click(screen.getByRole('button', { name:'更换头像' }));
  expect(screen.getAllByRole('option')).toHaveLength(36);
  expect(screen.queryByPlaceholderText('自定义 emoji')).toBeNull();
  expect(screen.queryByRole('button', { name:'用 emoji' })).toBeNull();
  const option = screen.getByRole('option', { name:icon.label });
  fireEvent.click(option);
  expect(option.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('button', { name:'更换头像' }).querySelector('img')?.getAttribute('src')).toContain(`/${icon.id}.webp`);
  fireEvent.click(screen.getByRole('button', { name:'保存' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ avatar:workspaceIconValue(icon.id), avatarAccent:'#6499ff' })));
});

it('新建缺省开发图标，可选择通用手柄；再次编辑保持手柄', async () => {
  const save = vi.fn(async () => {});
  const create = render(<CreateWorkspaceModal initial={{ path:'E:/new', name:'Game' }} onClose={() => {}} onSave={save} />);
  expect(screen.getByRole('button', { name:'更换头像' }).querySelector('img')?.getAttribute('src')).toContain('/development.webp');
  fireEvent.click(screen.getByRole('button', { name:'更换头像' }));
  fireEvent.click(screen.getByRole('option', { name:'通用游戏' }));
  fireEvent.click(screen.getByRole('button', { name:'创建' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ avatar:workspaceIconValue('gamepad') })));
  create.unmount();
  render(<CreateWorkspaceModal mode="edit" initial={{ id:'w',path:'E:/new',name:'Game',avatar:workspaceIconValue('gamepad') }} onClose={() => {}} onSave={async () => {}} />);
  fireEvent.click(screen.getByRole('button', { name:'更换头像' }));
  expect(screen.getByRole('option', { name:'通用游戏' }).getAttribute('aria-selected')).toBe('true');
});

it('解析保留上传和旧 emoji，未知内置 ID 回落开发图片，调度注入解析为符号', () => {
  expect(workspaceAvatarImageSrc('data:image/png;base64,abc')).toBe('data:image/png;base64,abc');
  expect(workspaceAvatarImageSrc('😺')).toBeUndefined();
  expect(workspaceIconUrl('builtin-workspace:missing')).toBe(workspaceIconUrl(DEFAULT_WORKSPACE_ICON));
  const { container } = render(<ChatMessageView quiet message={{ id:'scheduler',role:'user',source:'scheduler',content:'注入',createdAt:1 }} avatarContext={{ surfaceKind:'gui-session',workspaceAvatar:workspaceIconValue('video') }} />);
  expect(container.querySelector('.chat-msg-avatar')?.classList.contains('is-symbol')).toBe(true);
  expect(container.querySelector('.chat-msg-avatar img')?.getAttribute('src')).toContain('/video.webp');
});
