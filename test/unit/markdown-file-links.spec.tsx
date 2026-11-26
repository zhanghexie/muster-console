import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { handleChatFileLink } from '../../src/renderer/src/chatSurface/onFileLink';
import { buildWorkspaceFileHref } from '../../src/shared/linkifyWorkspacePaths';

describe('Markdown 文件链接', () => {
  it.each([
    ['/E:/Projects/PhySicsLab/output/playwright/layout-wide.png', 'E:/Projects/PhySicsLab/output/playwright/layout-wide.png'],
    ['/e:/Projects/my%20app/截图.png', 'e:/Projects/my app/截图.png'],
    ['/home/user/image.png', '/home/user/image.png'],
    ['//server/share/image.png', '//server/share/image.png'],
    ['E:/Projects/image.png', 'E:/Projects/image.png']
  ])('保留悬浮地址并正确路由 %s', async (href, path) => {
    const requestOpenWorkspaceFile = vi.fn();
    const host = { cwd: 'D:/workspace', requestOpenWorkspaceFile, flashTip: vi.fn(), t: (key: string) => key };
    render(<MarkdownBody text={`[查看宽屏效果](${href})`} onFileLink={value => { void handleChatFileLink(value, host); }} />);
    const link = screen.getByRole('link', { name: /查看宽屏效果/ });
    expect(link.getAttribute('title')).toBe(decodeURI(href));
    fireEvent.click(link);
    expect(requestOpenWorkspaceFile).toHaveBeenCalledWith({ path, line: undefined, col: undefined });
  });

  it('自动转换的路径显示可读原路径及行列', () => {
    const path = 'E:/项目/my app/file.ts';
    render(<MarkdownBody text={`[file](${buildWorkspaceFileHref(path, 12, 3)})`} onFileLink={vi.fn()} />);
    expect(screen.getByRole('link').getAttribute('title')).toBe(`${path}:12:3`);
  });
});
