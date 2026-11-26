import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { HtmlFilePreview, htmlWithResourceBase } from '../../src/renderer/src/components/HtmlFilePreview';
import { currentApiMock } from './helpers/api-mock';
import { buildWorkspaceResourceUrl, parseWorkspaceMediaUrl } from '../../src/shared/mediaKinds';
import { filePreviewUrl } from '../../src/renderer/src/filePreviewUrl';

const gateway = vi.hoisted(() => ({ active: false }));
vi.mock('../../src/renderer/src/webGatewayEnvironment', () => ({ isWebGateway: () => gateway.active }));
const ref = { workspaceId: 'Mixed/中文', rootId: 'b /中文', relativePath: 'docs/index.html' };
beforeEach(() => { gateway.active = false; });

describe('HTML 相对资源与 Web 预览地址', () => {
  it('默认 base 保留根和目录，已有相对/外部 base 仍按其语义解析', () => {
    const url = buildWorkspaceResourceUrl(ref);
    const doc = new DOMParser().parseFromString(htmlWithResourceBase('<p>hello</p>', url), 'text/html');
    expect(parseWorkspaceMediaUrl(new URL('style.css', doc.querySelector('base')!.href).href)).toEqual({ ...ref, relativePath: 'docs/style.css' });
    const authored = new DOMParser().parseFromString(htmlWithResourceBase('<base href="../assets/"><img src="x.png">', url), 'text/html');
    expect(parseWorkspaceMediaUrl(new URL('x.png', authored.querySelector('base')!.href).href)).toEqual({ ...ref, relativePath: 'assets/x.png' });
    expect(htmlWithResourceBase('<base href="https://example.org/"><p>x</p>', url)).toContain('href="https://example.org/"');
  });
  it('Web 媒体转换保留根查询参数及编码，外部路径不额外加 f', () => {
    gateway.active = true;
    expect(filePreviewUrl('muster-ws://workspace/a%20%23.png?v=2&workspaceId=WS&rootId=B')).toBe('/media/ws/workspace/a%20%23.png?v=2&workspaceId=WS&rootId=B');
    expect(filePreviewUrl('muster-ext://f/E%3A%2Fsame.png')).toBe('/media/ext/E%3A%2Fsame.png');
  expect(filePreviewUrl('muster-app://token/panel/panel.html?__ma_reload=2')).toBe('/media/extension/token/view/panel/panel.html?__ma_reload=2');
  });
  it('原生预览禁同源权限，Web 只读地址在切文件/卸载及晚到后释放', async () => {
    const native = render(<HtmlFilePreview content="<p>native</p>" fileRef={ref} rootsRevision={0} label="Preview" />);
    expect(native.container.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(native.container.querySelector('iframe')?.srcdoc).toContain('muster-root:');
    native.unmount(); gateway.active = true;
    const mock = currentApiMock(); let finish: (value: unknown) => void = () => {};
    mock.override('fs.createPreview', () => new Promise(resolve => { finish = resolve; }));
    mock.override('fs.releasePreview', async () => ({ ok: true }));
    const view = render(<HtmlFilePreview content="<p>web</p>" fileRef={ref} rootsRevision={0} label="Preview" />);
    expect(screen.getByRole('status')).toBeTruthy();
    view.unmount();
    await act(async () => finish({ ok: true, token: 'late', path: '/media/preview/late/docs/index.html' }));
    expect(mock.mockOf('fs.releasePreview')).toHaveBeenCalledWith('late');
    mock.override('fs.createPreview', async () => ({ ok: true, token: 'current', path: '/media/preview/current/docs/index.html' }));
    const next = render(<HtmlFilePreview content="<p>web</p>" fileRef={ref} rootsRevision={0} label="Preview" />);
    await waitFor(() => expect(next.container.querySelector('iframe')?.srcdoc).toContain('/media/preview/current/docs/'));
    next.unmount(); expect(mock.mockOf('fs.releasePreview')).toHaveBeenCalledWith('current');
  });
  it('根版本或来源变更时先隐藏旧预览，并释放旧地址及晚到地址', async () => {
    gateway.active = true;
    const mock = currentApiMock();
    const pending: Array<(value: unknown) => void> = [];
    mock.override('fs.createPreview', () => new Promise(resolve => pending.push(resolve)));
    mock.override('fs.releasePreview', async () => ({ ok: true }));
    const view = render(<HtmlFilePreview content="<p>same</p>" fileRef={ref} rootsRevision={0} label="Preview" />);
    await act(async () => pending[0]({ ok: true, token: 'old', path: '/media/preview/old/docs/index.html' }));
    expect(view.container.querySelector('iframe')?.srcdoc).toContain('/media/preview/old/');
    view.rerender(<HtmlFilePreview content="<p>same</p>" fileRef={ref} rootsRevision={1} label="Preview" />);
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(mock.mockOf('fs.releasePreview')).toHaveBeenCalledWith('old');
    const second = { ...ref, rootId: 'another' };
    view.rerender(<HtmlFilePreview content="<p>same</p>" fileRef={second} rootsRevision={1} label="Preview" />);
    await act(async () => pending[1]({ ok: true, token: 'stale', path: '/media/preview/stale/docs/index.html' }));
    expect(view.container.querySelector('iframe')).toBeNull();
    expect(mock.mockOf('fs.releasePreview')).toHaveBeenCalledWith('stale');
    await act(async () => pending[2]({ ok: true, token: 'new', path: '/media/preview/new/docs/index.html' }));
    expect(view.container.querySelector('iframe')?.srcdoc).toContain('/media/preview/new/');
    view.unmount(); expect(mock.mockOf('fs.releasePreview')).toHaveBeenCalledWith('new');
  });
});
