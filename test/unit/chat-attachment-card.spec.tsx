import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { ChatAttachmentCard } from '../../src/renderer/src/components/ChatAttachmentCard';
import { buildWorkspaceFileHref } from '../../src/shared/linkifyWorkspacePaths';
import { buildExternalFileUrl } from '../../src/shared/filePreview';

const attachment = { name: '演示 #1.mp4', processing: 'video sampling',
  sourcePath: `C:\\app\\conversation-attachments\\${'a'.repeat(20)}\\abcdef123456-演示 #1.mp4` };
describe('chat attachment navigation and media', () => {
  it('renders an inline video with controls and routes its filename through file navigation', () => {
    const onFileLink = vi.fn();
    const content = '[Attachment metadata]\n' + JSON.stringify(attachment);
    const { container } = render(<ChatMessageView quiet onFileLink={onFileLink}
      message={{ id: 'm', role: 'user', content, createdAt: 1 }} />);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe(buildExternalFileUrl(attachment.sourcePath));
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(false);
    fireEvent.click(video);
    expect(onFileLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: attachment.name }));
    expect(onFileLink).toHaveBeenCalledWith(buildWorkspaceFileHref(attachment.sourcePath));
    fireEvent.error(video);
    expect(screen.getByRole('status').textContent).toContain('视频无法播放');
    expect(screen.getByRole('button', { name: attachment.name })).toBeTruthy();
  });
  it('opens other documents and does not render inactive buttons without a navigation host', () => {
    const onFileLink = vi.fn();
    const file = { ...attachment, name: '报告.pdf' };
    const { rerender } = render(<ChatAttachmentCard attachment={file} onFileLink={onFileLink} />);
    fireEvent.click(screen.getByRole('button', { name: file.name }));
    expect(onFileLink).toHaveBeenCalledWith(buildWorkspaceFileHref(file.sourcePath));
    rerender(<ChatAttachmentCard attachment={file} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(file.name)).toBeTruthy();
  });
});
