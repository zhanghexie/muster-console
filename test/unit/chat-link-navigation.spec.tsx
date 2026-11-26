import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatSurfaceView } from '../../src/renderer/src/chatSurface/ChatSurfaceView';
import { ChatLinkBoundary } from '../../src/renderer/src/chatSurface/ChatLinkBoundary';

import { ChatMessageView } from '../../src/renderer/src/components/ChatMessageView';
import { MarkdownBody } from '../../src/renderer/src/components/MarkdownBody';
import { ToolTitleTarget } from '../../src/renderer/src/components/ToolVisuals';
import { StoreProvider, useUiStore, useWorkspaceStore } from '../../src/renderer/src/store';
import { getTipSnapshot, subscribeTips } from '../../src/renderer/src/tips';
import { parseChatFileTarget, resolveChatFilePath } from '../../src/renderer/src/chatSurface/onFileLink';
import { buildWorkspaceFileHref } from '../../src/shared/linkifyWorkspacePaths';
import type { ChatSurface, ChatSurfaceKind, ChatSurfaceSnapshot } from '../../src/shared/chatSurface';
import { currentApiMock } from './helpers/api-mock';

it('passes the originating session when a chat link opens in the built-in browser', async () => {
  const api = currentApiMock();
  api.override('browser.open', async () => ({ id: 'browser-owned' }));
  render(<ChatLinkBoundary active workspaceId="ws-owner" sessionId="chat-owner" onFileLink={vi.fn()} flashTip={vi.fn()} showWorkspace={vi.fn()}>
    <a href="https://example.test/" data-chat-link-target="https://example.test/">open owned page</a>
  </ChatLinkBoundary>);
  fireEvent.click(screen.getByText('open owned page'));
  await waitFor(() => expect(api.mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://example.test/', workspaceId: 'ws-owner', sessionId: 'chat-owner', scope: 'session' }));
});

vi.mock('../../src/renderer/src/components/AgentComposer', () => ({ AgentComposer: () => null }));

let openFile: ReturnType<typeof useUiStore>['openWorkspaceFile'] = null;
let activeWorkspaceId: string | null = null;
let tip = '';
function FileRequestProbe(): null {
  openFile = useUiStore().openWorkspaceFile;
  activeWorkspaceId = useWorkspaceStore().activeWorkspaceId;
  tip = React.useSyncExternalStore(subscribeTips, getTipSnapshot)?.text ?? '';
  return null;
}

function surface(kind: ChatSurfaceKind, text: string): ChatSurface {
  const snapshot: ChatSurfaceSnapshot = {
    messages: kind === 'gui-session'
      ? [{ id: 'u1', role: 'user', parts: [{ kind: 'text', text }], ts: 1 }]
      : [{ id: 'u1', role: 'user', content: text, createdAt: 1 }],
    busy: false, queuedCount: 0, queuedItems: [], status: null, mode: null, preset: null
  };
  return {
    sessionId: 'session-1', caps: { surfaceKind: kind, draftKey: 'chat-link-test' },
    subscribe: () => () => {}, getSnapshot: () => snapshot,
    actions: { send: async () => true, stop: () => {}, clear: async () => {}, retry: () => {}, cancelQueued: () => {} }
  };
}

function mount(kind: ChatSurfaceKind, text: string): void {
  render(<StoreProvider><FileRequestProbe /><ChatSurfaceView surface={surface(kind, text)}
    workspaceId="ws-1" cwd="E:/workspace" findEnabled={false} /></StoreProvider>);
}

beforeEach(() => {
  openFile = null;
  activeWorkspaceId = null;
  tip = '';
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const api = currentApiMock();
  const workspaces = [{ id: 'ws-1', name: 'Workspace', path: 'E:/workspace' }];
  api.override('workspaces.list', async () => ({ workspaces, activeWorkspaceId: 'ws-1' }));
  api.override('config.get', async () => ({ workspaces, activeWorkspaceId: 'ws-1', locale: 'zh-CN' }));
  api.override('browser.open', async () => ({ id: 'browser-1' }));
  api.override('shell.openExternal', async () => ({ ok: true }));
  api.override('shell.openPath', async () => ({ ok: true }));
  api.override('shell.statPaths', async () => ({}));
});

describe('文件路径解析', () => {
  it.each([
    [buildWorkspaceFileHref('E:/项目/报告 #1.pdf', 12, 3), { path: 'E:/项目/报告 #1.pdf', line: 12, col: 3 }],
    ['file:///E:/%E9%A1%B9%E7%9B%AE/%E6%8A%A5%E5%91%8A%20%231.pdf', { path: 'E:/项目/报告 #1.pdf' }],
    ['file://server/share/report%20%231.pdf', { path: '//server/share/report #1.pdf' }],
    ['/home/user/report%20%231.pdf', { path: '/home/user/report #1.pdf' }],
    ['docs/%E6%8A%A5%E5%91%8A.pdf', { path: 'docs/报告.pdf' }]
  ])('解析 %s', (input, expected) => expect(parseChatFileTarget(input)).toEqual(expected));
  it('拒绝非法编码及其他协议', () => {
    expect(parseChatFileTarget('docs/%FF')).toBeNull();
    expect(parseChatFileTarget('https://example.com')).toBeNull();
    expect(parseChatFileTarget('mailto:person@example.com')).toBeNull();
  });
  it('POSIX 下保留以单字母目录开头的绝对路径，Windows 仍支持 MSYS 路径', () => {
    expect(resolveChatFilePath('/e/project/report.pdf', '/home/user')).toBe('/e/project/report.pdf');
    expect(resolveChatFilePath('/e/project/report.pdf', 'D:\\workspace')).toBe('E:\\project\\report.pdf');
    expect(resolveChatFilePath('//server/share/report.pdf', 'D:\\workspace')).toBe('//server/share/report.pdf');
  });
});

it('附件名称与本地 Markdown 图片右键提供相同的文件操作，图片左键仍可预览', async () => {
  const sourcePath = `E:/app/conversation-attachments/${'a'.repeat(20)}/abcdef123456-report.pdf`;
  const metadata = `[Attachment metadata]\n${JSON.stringify({ name: '报告.pdf', sourcePath, processing: 'document' })}`;
  mount('dispatch', `![本地图](images/example.png)\n\n${metadata}`);
  const image = await screen.findByRole('button', { name: /点击查看大图.*本地图/ });
  fireEvent.contextMenu(image);
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }));
  await waitFor(() => expect(currentApiMock().mockOf('shell.openPath')).toHaveBeenCalledWith('E:/workspace\\images\\example.png'));
  const attachment = screen.getByRole('button', { name: '报告.pdf' });
  fireEvent.contextMenu(attachment);
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }));
  await waitFor(() => expect(currentApiMock().mockOf('shell.openPath')).toHaveBeenCalledWith(sourcePath));
  fireEvent.click(image);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

it('嵌在网页链接里的图片仍由大图查看器处理点击', async () => {
  mount('dispatch', '[![配图](https://example.com/image.png)](https://example.com/page)');
  fireEvent.click(await screen.findByRole('button', { name: /点击查看大图.*配图/ }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(currentApiMock().mockOf('browser.open')).not.toHaveBeenCalled();
});

it('系统打开和内置浏览器失败时显示原因，不静默回退', async () => {
  const api = currentApiMock();
  api.override('shell.openPath', async () => ({ ok: false, error: '没有默认应用' }));
  api.override('browser.open', async () => { throw new Error('浏览器不可用'); });
  mount('dispatch', '[网页](https://example.com) [文件](report.pdf)');
  await waitFor(() => expect(activeWorkspaceId).toBe('ws-1'));
  fireEvent.click(screen.getByRole('link', { name: '网页' }));
  await waitFor(() => expect(tip).toContain('浏览器不可用'));
  fireEvent.contextMenu(screen.getByRole('link', { name: /文件/ }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }));
  await waitFor(() => expect(tip).toBe('没有默认应用'));
  expect(api.mockOf('shell.openExternal')).not.toHaveBeenCalled();
});

it('带源路径的原生图片可以右键在默认应用中打开', async () => {
  const sourcePath = 'E:/workspace/image.png';
  render(<ChatLinkBoundary active cwd="E:/workspace" onFileLink={vi.fn()} flashTip={vi.fn()} showWorkspace={vi.fn()}>
    <ChatMessageView quiet onFileLink={vi.fn()} message={{ id: 'image', role: 'user', content: '', createdAt: 1,
      images: [{ id: 'image-1', name: 'image.png', sourcePath, data: '', mimeType: 'image/png' }] }} />
  </ChatLinkBoundary>);
  fireEvent.contextMenu(screen.getByRole('img', { name: 'image.png' }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }));
  await waitFor(() => expect(currentApiMock().mockOf('shell.openPath')).toHaveBeenCalledWith(sourcePath));
});

it('相对文件缺少 cwd 时系统操作提示路径不可确定', async () => {
  const tip = vi.fn();
  render(<ChatLinkBoundary active onFileLink={vi.fn()} flashTip={tip} showWorkspace={vi.fn()}>
    <MarkdownBody text="[报告](report.pdf)" onFileLink={vi.fn()} />
  </ChatLinkBoundary>);
  fireEvent.contextMenu(screen.getByRole('link', { name: /报告/ }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在文件管理器中显示' }));
  expect(tip).toHaveBeenCalledWith('无法确定文件路径');
  expect(currentApiMock().mockOf('shell.revealPath')).not.toHaveBeenCalled();
});

it('工具文件路径保留内置跳转行列，系统打开时只使用真实路径', async () => {
  const onFileLink = vi.fn();
  render(<ChatLinkBoundary active cwd="E:/workspace" onFileLink={onFileLink} flashTip={vi.fn()} showWorkspace={vi.fn()}>
    <ToolTitleTarget visual={{ verb: '读取', path: 'E:/workspace/report.ts:12:3' }} onFileLink={onFileLink} />
  </ChatLinkBoundary>);
  const link = screen.getByRole('link', { name: /report.ts:12:3/ });
  fireEvent.click(link);
  expect(onFileLink).toHaveBeenCalledWith(buildWorkspaceFileHref('E:/workspace/report.ts', 12, 3));
  fireEvent.contextMenu(link);
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }));
  await waitFor(() => expect(currentApiMock().mockOf('shell.openPath')).toHaveBeenCalledWith('E:/workspace/report.ts'));
});

describe.each(['gui-session', 'dispatch'] as const)('会话链接 %s', kind => {
  it.each(['https://example.com/help', 'http://localhost:5173/docs/index.html'])('点击 %s 在内置浏览器打开', async url => {
    mount(kind, `[打开网页](${url})`);
    fireEvent.click(await screen.findByRole('link', { name: '打开网页' }));
    await waitFor(() => expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith({ url, workspaceId: 'ws-1', ...(kind === 'gui-session' ? { sessionId: 'session-1' } : {}), scope: 'session' }));
    expect(currentApiMock().mockOf('shell.openExternal')).not.toHaveBeenCalled();
  });

  it('网页右键选择系统浏览器，且不触发消息历史菜单', async () => {
    mount(kind, '[打开网页](https://example.com/help)');
    fireEvent.contextMenu(await screen.findByRole('link', { name: '打开网页' }), { clientX: 80, clientY: 60 });
    expect(screen.queryByRole('dialog', { name: '会话历史' })).toBeNull();
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统浏览器中打开' }));
    await waitFor(() => expect(currentApiMock().mockOf('shell.openExternal')).toHaveBeenCalledWith('https://example.com/help'));
    expect(currentApiMock().mockOf('browser.open')).not.toHaveBeenCalled();
  });

  it('中键点击网页也进入内置浏览器', async () => {
    mount(kind, '[网页](https://example.com/middle)');
    fireEvent(await screen.findByRole('link', { name: '网页' }), new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    await waitFor(() => expect(currentApiMock().mockOf('browser.open')).toHaveBeenCalledWith({ url: 'https://example.com/middle', workspaceId: 'ws-1', ...(kind === 'gui-session' ? { sessionId: 'session-1' } : {}), scope: 'session' }));
    expect(currentApiMock().mockOf('shell.openExternal')).not.toHaveBeenCalled();
  });

  it('文件默认预览，右键可用系统默认应用打开或在文件管理器中显示', async () => {
    mount(kind, '[报告](docs/report%20%231.pdf)');
    const link = await screen.findByRole('link', { name: /报告/ });
    await waitFor(() => expect(activeWorkspaceId).toBe('ws-1'));
    fireEvent.click(link);
    await waitFor(() => expect(openFile?.path.replace(/\\/g, '/')).toBe('E:/workspace/docs/report #1.pdf'));
    fireEvent.contextMenu(link, { clientX: 80, clientY: 60 });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在系统默认应用中打开' }));
    await waitFor(() => expect(currentApiMock().mockOf('shell.openPath')).toHaveBeenCalledWith('E:/workspace\\docs\\report #1.pdf'));
    fireEvent.contextMenu(link, { clientX: 80, clientY: 60 });
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: '在文件管理器中显示' }));
    await waitFor(() => expect(currentApiMock().mockOf('shell.revealPath')).toHaveBeenCalledWith('E:/workspace\\docs\\report #1.pdf'));
  });
});
