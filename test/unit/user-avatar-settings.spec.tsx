import { renderWithAppTips as render } from './helpers/app-tips';
/**
 * 外观页用户头像选择器：网格 / 自定义 emoji / 上传 即时落盘。
 * 运行: npx vitest run test/unit/user-avatar-settings.spec.tsx
 */
import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UserAvatarSettings } from '../../src/renderer/src/components/settings/UserAvatarSettings';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import {
  getUserAvatar,
  resetUserAvatarForTest,
  setUserAvatar
} from '../../src/renderer/src/userAvatar';
import { cropScaleAvatarFile } from '../../src/renderer/src/cropAvatarImage';
import { currentApiMock } from './helpers/api-mock';
import type { ChatMessage } from '../../src/shared/types';
import { SUBAGENT_CHARACTERS } from '../../src/shared/subagentCharacters';
import { AvatarPicker } from '../../src/renderer/src/components/AvatarPicker';
import { applyLocaleSetting } from '../../src/shared/i18n';

vi.mock('../../src/renderer/src/cropAvatarImage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/renderer/src/cropAvatarImage')>();
  return {
    ...actual,
    cropScaleAvatarFile: vi.fn(async () => 'data:image/png;base64,aaa')
  };
});

function userMsg(): ChatMessage {
  return { id: 'u', role: 'user', content: 'hi', createdAt: 1_000 };
}

describe('外观页头像选择器即时落盘', () => {
  beforeEach(() => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🙂' });
    vi.mocked(cropScaleAvatarFile).mockClear();
  });

  it('switches built-in labels with the language while retaining the stored avatar and sender name', () => {
    resetUserAvatarForTest({ kind: 'builtin', value: 'pixel', displayName: '我的名字' });
    const identity = { sessionId: 'child', name: '用户指定的名字', characterId: 'pixel' as const };
    const message: ChatMessage = { id: 'child-message', role: 'user', source: 'agent', content: 'hello', createdAt: 1, sourceAgent: identity };
    const { container } = render(<><UserAvatarSettings /><ChatMessageView message={message} /></>);
    expect(screen.getByRole('option', { name: '像素（设计师）' })).toBeTruthy();
    try {
      act(() => { applyLocaleSetting('en'); });
      expect(screen.getByRole('option', { name: 'Pixel (Designer)' }).getAttribute('aria-selected')).toBe('true');
      expect(container.querySelector('[data-avatar-sender="agent"]')?.getAttribute('title')).toBe('用户指定的名字 (Designer)');
      expect(getUserAvatar()).toEqual({ kind: 'builtin', value: 'pixel', displayName: '我的名字' });
      expect(message.sourceAgent).toEqual(identity);
      act(() => { applyLocaleSetting('zh-CN'); });
      expect(screen.getByRole('option', { name: '像素（设计师）' }).getAttribute('aria-selected')).toBe('true');
    } finally { act(() => { applyLocaleSetting('zh-CN'); }); }
  });

  it.each(SUBAGENT_CHARACTERS)('选择内置 $id 立即保存 ID 并更新已挂载消息，保留显示名', async c => {
    resetUserAvatarForTest({ kind: 'emoji', value: '🌸', displayName: '我的名字' });
    const user = await import('@testing-library/user-event').then(m => m.default);
    const { container } = render(<><UserAvatarSettings /><ChatMessageView message={userMsg()} /></>);
    expect(screen.getByRole('listbox', { name: '内置符号' }).querySelectorAll('[role=option]')).toHaveLength(24);
    const option = screen.getByRole('option', { name: `${c.name}（${c.role}）` });
    await user.click(option);
    expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith({ userAvatar: { kind: 'builtin', value: c.id, displayName: '我的名字' } });
    expect(option.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('.create-ws-avatar-preview img')?.getAttribute('src')).toContain(`/${c.id}.webp`);
    const avatar = container.querySelector('[data-avatar-sender="user"]');
    expect(avatar?.classList.contains('is-symbol')).toBe(true);
    expect(avatar?.querySelector('img')?.getAttribute('src')).toContain(`/${c.id}.webp`);
    expect(avatar?.getAttribute('title')).toBe('我的名字');
    expect(screen.queryByPlaceholderText('自定义 emoji')).toBeNull();
  });

  it('内置符号可切换或上传，显示名保持，选中状态互斥', async () => {
    resetUserAvatarForTest({ kind: 'builtin', value: 'pixel', displayName: '我自己' });
    const user = await import('@testing-library/user-event').then(m => m.default);
    const { container } = render(<><UserAvatarSettings /><ChatMessageView message={userMsg()} /></>);
    await user.click(screen.getByRole('option', { name: '星探（探索者）' }));
    expect(getUserAvatar()).toEqual({ kind: 'builtin', value: 'scout', displayName: '我自己' });
    expect(screen.getByRole('option', { name: '像素（设计师）' }).getAttribute('aria-selected')).toBe('false');
    await user.click(screen.getByRole('option', { name: '像素（设计师）' }));
    const file = new File(['test'], 'face.png', { type: 'image/png' });
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } });
    await waitFor(() => expect(getUserAvatar()).toEqual({ kind: 'image', value: 'data:image/png;base64,aaa', displayName: '我自己' }));
    expect(screen.getByRole('option', { name: '像素（设计师）' }).getAttribute('aria-selected')).toBe('false');
  });

  it('保存失败回滚原头像和符号选中态', async () => {
    currentApiMock().override('config.update', () => Promise.reject(new Error('write failed')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const user = await import('@testing-library/user-event').then(m => m.default);
      const { container } = render(<><UserAvatarSettings /><ChatMessageView message={userMsg()} /></>);
      await user.click(screen.getByRole('option', { name: '像素（设计师）' }));
      await waitFor(() => expect(getUserAvatar()).toEqual({ kind: 'emoji', value: '🙂' }));
      expect(container.querySelector('[data-avatar-sender=user]')?.textContent).toBe('🙂');
      expect(screen.getByRole('option', { name: '像素（设计师）' }).getAttribute('aria-selected')).toBe('false');
    } finally { warn.mockRestore(); }
  });

  it('用户设置仅有 24 个符号与上传入口，移除 emoji 网格、输入和采用按钮', () => {
    render(<UserAvatarSettings />);
    expect(screen.getAllByRole('option')).toHaveLength(24);
    expect(screen.queryByRole('option', { name: '😺' })).toBeNull();
    expect(screen.queryByPlaceholderText('自定义 emoji')).toBeNull();
    expect(screen.queryByRole('button', { name: '用 emoji' })).toBeNull();
    expect(screen.getByRole('button', { name: '上传图片' })).toBeTruthy();
  });

  it('未启用符号目录的通用选择器保留旧 emoji 调用兼容', async () => {
    const onChange = vi.fn();
    const user = await import('@testing-library/user-event').then(m => m.default);
    render(<AvatarPicker value="🙂" onChange={onChange} onUpload={() => {}} />);
    await user.click(screen.getByRole('option', { name: '😺' }));
    expect(onChange).toHaveBeenCalledWith('😺');
    fireEvent.change(screen.getByPlaceholderText('自定义 emoji'), { target: { value: '🎃' } });
    await user.click(screen.getByRole('button', { name: '用 emoji' }));
    expect(onChange).toHaveBeenCalledWith('🎃');
  });

  it('旧主进程把 builtin 回写为 emoji:scout 时仍保持图片选中，不闪成文字', async () => {
    currentApiMock().override('config.update', args => Promise.resolve({ userAvatar: {
      ...(args as { userAvatar: object }).userAvatar, kind: 'emoji'
    } }));
    const user = await import('@testing-library/user-event').then(m => m.default);
    const { container } = render(<><UserAvatarSettings /><ChatMessageView message={userMsg()} /></>);
    await user.click(screen.getByRole('option', { name: '星探（探索者）' }));
    await waitFor(() => expect(getUserAvatar()).toEqual({ kind: 'builtin', value: 'scout' }));
    expect(container.querySelector('.create-ws-avatar-preview img')?.getAttribute('src')).toContain('/scout.webp');
    expect(container.querySelector('[data-avatar-sender=user] img')?.getAttribute('src')).toContain('/scout.webp');
    expect(screen.getByRole('option', { name: '星探（探索者）' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByPlaceholderText('自定义 emoji')).toBeNull();
  });

  it('点「上传图片」打开文件框；选图后裁圆并 config.update image', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default);
    const { container } = render(<UserAvatarSettings />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(fileInput, 'click');

    await user.click(screen.getByRole('button', { name: '上传图片' }));
    expect(clickSpy).toHaveBeenCalled();

    const file = new File([new Uint8Array([1, 2, 3])], 'face.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(cropScaleAvatarFile).toHaveBeenCalledWith(file);
      expect(currentApiMock().mockOf('config.update')).toHaveBeenCalledWith({
        userAvatar: { kind: 'image', value: 'data:image/png;base64,aaa' }
      });
    });
  });

  it('超大图入口即拒，不裁切不落盘', () => {
    const { container } = render(<UserAvatarSettings />);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(['x'], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });

    fireEvent.change(fileInput, { target: { files: [big] } });

    expect(screen.getByText('图片太大，请选择小于 20MB 的图片')).toBeTruthy();
    expect(cropScaleAvatarFile).not.toHaveBeenCalled();
    expect(currentApiMock().mockOf('config.update')).not.toHaveBeenCalled();
  });
});

describe('头像上传原生 file input 保持隐藏', () => {
  it('input[type=file] 内联 display:none（防容器样式渗透顶开设置页）', () => {
    render(<UserAvatarSettings />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.style.display).toBe('none');
  });
});

describe('头像配置陈旧回写守卫', () => {
  it('config.update 慢响应不覆盖期间的新选择（回归：成功分支加 current === applied 守卫）', async () => {
    const resolvers: Array<() => void> = [];
    currentApiMock().override('config.update', (args) => {
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ userAvatar: (args as { userAvatar: unknown }).userAvatar }));
      });
    });
    resetUserAvatarForTest({ kind: 'emoji', value: '🙂' });

    setUserAvatar({ kind: 'emoji', value: '😺' }); // 第一次落盘：响应挂起
    setUserAvatar({ kind: 'emoji', value: '🐶' }); // 期间用户又换了
    expect(getUserAvatar().value).toBe('🐶');

    resolvers[0]!(); // 旧响应先回：不得把 🐶 冲回 😺
    await new Promise((r) => setTimeout(r, 0));
    expect(getUserAvatar().value).toBe('🐶');

    resolvers[1]!(); // 新响应回：归一值一致，保持不变
    await new Promise((r) => setTimeout(r, 0));
    expect(getUserAvatar().value).toBe('🐶');
  });
});
