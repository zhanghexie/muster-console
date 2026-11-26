import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * 头像上传落盘失败的反馈链（P3 chat-message-avatar F-01 回归）：
 * 旧实现：crop 成功 → config.update 内主进程 256KB 落盘失败 → 静默回落默认 emoji，
 * 设置页 error 态永远不触发。新实现：主进程抛错 → config.update 拒绝 →
 * setUserAvatar 回滚本地态并返回 {ok:false,msg} → 设置页显示失败原因。
 * 还原即红：把 UserAvatarSettings.onFile 改回 pick() 即无错误提示。
 */
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserAvatarSettings } from '../../src/renderer/src/components/settings/UserAvatarSettings';
import { getUserAvatar, resetUserAvatarForTest } from '../../src/renderer/src/userAvatar';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/cropAvatarImage', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/renderer/src/cropAvatarImage')
  >();
  return {
    ...actual,
    // 跳过真实 canvas 裁剪：统一产出「处理成功」的 data URL，聚焦落盘失败路径
    cropScaleAvatarFile: vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=')
  };
});

function uploadFile(file: File): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('用户头像上传落盘失败反馈', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🐶' });
  });

  it('主进程拒绝（>256KB）时显示失败原因并回滚原头像，不再静默换默认表情', async () => {
    currentApiMock().override('config.update', async () => {
      throw new Error('图片处理后仍超过 256KB 上限或数据无效，未更新头像');
    });
    render(<UserAvatarSettings />);
    uploadFile(new File(['x'], 'big.png', { type: 'image/png' }));
    expect(
      await screen.findByText('头像保存失败：图片处理后仍超过 256KB 上限或数据无效，未更新头像')
    ).toBeTruthy();
    await waitFor(() => expect(getUserAvatar()).toEqual({ kind: 'emoji', value: '🐶' }));
  });

  it('落盘成功不产生错误提示，本地态随主进程返回值保持', async () => {
    const api = currentApiMock();
    api.override('config.update', async () => ({
      workspaces: [],
      activeWorkspaceId: null,
      locale: 'zh-CN',
      userAvatar: { kind: 'image', value: 'data:image/png;base64,iVBORw0KGgo=' }
    }));
    render(<UserAvatarSettings />);
    uploadFile(new File(['x'], 'ok.png', { type: 'image/png' }));
    await waitFor(() => expect(getUserAvatar().kind).toBe('image'));
    expect(document.querySelector('.user-avatar-error')).toBeNull();
    expect(api.mockOf('config.update')).toHaveBeenCalledOnce();
  });
});
