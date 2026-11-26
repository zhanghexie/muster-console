/**
 * Composer 待发图片条：必须落在输入凹槽内；点击缩略图开灯箱，× 只移除不开灯箱。
 * 回归：旧实现托盘在 .chat-input-shell 外且缩略图不可放大。
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposerImageStrip } from '../../src/renderer/src/components/ComposerImageStrip';
import { ComposerAttachBar } from '../../src/renderer/src/components/agentComposer/ComposerAttachBar';
import type { ChatImageAttachment } from '../../src/shared/types';

const IMG: ChatImageAttachment = {
  id: 'img-1',
  data: 'AAAA',
  mimeType: 'image/png',
  url: 'data:image/png;base64,AAAA',
  name: 'shot.png'
};

function mountStrip(onRemove = vi.fn()) {
  return {
    onRemove,
    ...render(
      <div className="chat-input-shell">
        <ComposerImageStrip images={[IMG]} onRemove={onRemove} />
        <div className="composer-ta-wrap" />
      </div>
    )
  };
}

describe('ComposerImageStrip 输入框内预览', () => {
  it('最后一个附件移除时保留不可交互的退场内容，并能中途恢复', async () => {
    const fileInputRef = React.createRef<HTMLInputElement>();
    const props = { allowImages: true, fileInputRef, onPickFiles: vi.fn(), onRemoveImage: vi.fn() };
    const view = render(<ComposerAttachBar {...props} images={[IMG]} />);
    const fold = view.container.querySelector('.acc')!;
    expect(fold.classList.contains('is-open')).toBe(true);
    view.rerender(<ComposerAttachBar {...props} images={[]} />);
    expect(fold.classList.contains('is-open')).toBe(false);
    expect(fold.getAttribute('aria-hidden')).toBe('true');
    expect(fold.querySelector('.agent-composer-images')).not.toBeNull();
    view.rerender(<ComposerAttachBar {...props} images={[IMG]} />);
    expect(fold.classList.contains('is-open')).toBe(true);
    view.rerender(<ComposerAttachBar {...props} images={[]} />);
    await waitFor(() => expect(view.container.querySelector('.acc')).toBeNull());
  });
  it('缩略图渲染在 .chat-input-shell 内', () => {
    mountStrip();
    const tray = document.querySelector('.chat-input-shell .agent-composer-images');
    expect(tray).toBeTruthy();
    expect(document.querySelectorAll('.agent-composer-images').length).toBe(1);
  });

  it('点击缩略图打开图片灯箱；点 × 只移除、不开灯箱', async () => {
    const user = userEvent.setup();
    const { onRemove } = mountStrip();

    expect(screen.queryByRole('dialog', { name: '图片查看' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '点击查看大图' }));
    expect(await screen.findByRole('dialog', { name: '图片查看' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog', { name: '图片查看' })).toBeNull();

    await user.click(screen.getByRole('button', { name: '移除图片' }));
    expect(onRemove).toHaveBeenCalledWith('img-1');
    expect(screen.queryByRole('dialog', { name: '图片查看' })).toBeNull();
  });
});
