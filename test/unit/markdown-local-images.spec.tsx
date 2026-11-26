import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatMarkdownBody } from '../../src/renderer/src/chatSurface/ChatMarkdownBody';
import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { buildExternalFileUrl } from '../../src/shared/filePreview';
import type { ChatMessage } from '../../src/shared/types';
import { isWebGateway } from '../../src/renderer/src/webGatewayEnvironment';
import { currentApiMock } from './helpers/api-mock';

vi.mock('../../src/renderer/src/webGatewayEnvironment', () => ({ isWebGateway: vi.fn(() => false) }));
afterEach(() => vi.mocked(isWebGateway).mockReturnValue(false));

describe('聊天 Markdown 本地图片', () => {
  it.each([
    ['D:/MetaApp/image-render-test-20261030.png', 'D:/MetaApp/image-render-test-20261030.png'],
    ['/D:/项目/my%20image.png', 'D:/项目/my image.png'],
    ['/home/user/image.png', '/home/user/image.png'],
    ['/Users/me/image.png', '/Users/me/image.png'],
    ['file:///D:/MetaApp/image.png', 'D:/MetaApp/image.png'],
    ['file://server/share/image.png', '//server/share/image.png'],
    ['./images/a.png', 'D:/workspace/./images/a.png']
  ])('assistant 图片 %s 经只读媒体通道加载', (src, path) => {
    render(<ChatMarkdownBody text={`![测试](${src})`} cwd="D:/workspace" streaming />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe(buildExternalFileUrl(path));
  });

  it('Web 网关将本地图片转换为对应媒体路由', () => {
    vi.mocked(isWebGateway).mockReturnValue(true);
    render(<ChatMarkdownBody text="![测试](D:/MetaApp/image.png)" streaming />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe('/media/ext/D%3A%2FMetaApp%2Fimage.png');
  });

  it('用户消息的 content 和 parts 也解析本地图片', () => {
    const message = { id: 'm', role: 'user', createdAt: 1, content: '![测试](./image.png)' } as ChatMessage;
    const view = render(<ChatMessageView message={message} cwd="/home/user" />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe(buildExternalFileUrl('/home/user/./image.png'));
    view.rerender(<ChatMessageView message={{ ...message, content: '', parts: [{ kind: 'text', text: '![测试](./image.png)' }] }} cwd="/home/user" />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe(buildExternalFileUrl('/home/user/./image.png'));
  });

  it('网络图片保持原地址，本地图片失败时展示提示并在 cwd 改变后重试', () => {
    const view = render(<MarkdownBody text="![测试](./image.png)" localImages imageCwd="/one" />);
    fireEvent.error(screen.getByRole('img', { name: '测试' }));
    expect(screen.getByRole('status').textContent).toContain('测试');
    view.rerender(<MarkdownBody text="![测试](./image.png)" localImages imageCwd="/two" />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe(buildExternalFileUrl('/two/./image.png'));
    view.rerender(<MarkdownBody text="![测试](https://example.com/image.png)" localImages />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe('https://example.com/image.png');
  });

  it('图片卡片显示 Markdown 标题，没有标题时显示替代文字', () => {
    const view = render(<MarkdownBody text={'![替代文字](D:/image.png "图片标题")'} localImages />);
    expect(view.container.querySelector('.chat-markdown-image-caption')?.textContent).toBe('图片标题');
    expect(screen.getByRole('img', { name: '替代文字' })).toBeTruthy();
    view.rerender(<MarkdownBody text="![图片展示测试](D:/image.png)" localImages />);
    expect(view.container.querySelector('.chat-markdown-image-caption')?.textContent).toBe('图片展示测试');
    view.rerender(<MarkdownBody text="![](D:/image.png)" localImages />);
    expect(view.container.querySelector('.chat-markdown-image-caption')).toBeNull();
  });

  it('点击和键盘可打开大图，关闭后可再次打开，且不会触发消息点击', async () => {
    const user = userEvent.setup();
    const onMessageClick = vi.fn();
    render(<div onClick={onMessageClick}><MarkdownBody text="![测试](D:/image.png)" localImages /></div>);
    const button = screen.getByRole('button', { name: /测试/ });
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    // jsdom does not load the media URL; the real viewer reveals the stage on image load.
    fireEvent.load(dialog.querySelector('img')!);
    expect(within(dialog).getByRole('img', { name: '测试' }).getAttribute('src')).toBe(buildExternalFileUrl('D:/image.png'));
    expect(onMessageClick).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    button.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onMessageClick).not.toHaveBeenCalled();
  });

  it('无 cwd 的相对路径提示失败，其他 Markdown 使用场景保持原有图片解析', () => {
    const view = render(<MarkdownBody text="![测试](./image.png)" localImages />);
    expect(screen.getByRole('status')).toBeTruthy();
    view.rerender(<MarkdownBody text="![测试](./image.png)" />);
    expect(screen.getByRole('img', { name: '测试' }).getAttribute('src')).toBe('./image.png');
  });

  it('限制路径候选数量，并在同一 stat 请求进行中复用结果', async () => {
    const mock = currentApiMock();
    const calls: string[][] = [];
    let resolveStats!: (value: Record<string, { exists: boolean }>) => void;
    const pending = new Promise<Record<string, { exists: boolean }>>(resolve => { resolveStats = resolve; });
    mock.override('shell.statPaths', (paths: string[]) => { calls.push(paths); return pending; });
    const candidates = Array.from({ length: 300 }, (_, index) => `src/stat-candidate-${index}.ts`).join(' ');
    const first = render(<ChatMarkdownBody text={candidates} cwd="D:/workspace" />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toHaveLength(256);
    const second = render(<ChatMarkdownBody text="src/in-flight.ts" cwd="D:/workspace" />);
    await new Promise(resolve => setTimeout(resolve, 30));
    const third = render(<ChatMarkdownBody text="src/in-flight.ts" cwd="D:/workspace" />);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(calls).toHaveLength(2);
    third.unmount(); second.unmount(); first.unmount();
    resolveStats(Object.fromEntries(calls[0].map(path => [path, { exists: true }])));
  });
});
