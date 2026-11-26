import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppDataView } from '../../src/renderer/src/agentApps/AppDataView';
import { CustomAppView } from '../../src/renderer/src/agentApps/CustomAppView';
import { photoAlbumExample } from '../../src/shared/agentAppsExamples';
import type { AppImageAsset, AppRecord } from '../../src/shared/agentApps';
import type { PhoneRoute } from '../../src/renderer/src/agentApps/presentation';
import { currentApiMock } from './helpers/api-mock';

const app = photoAlbumExample(), id = '12345678-1234-4234-8234-123456789abc';
const asset: AppImageAsset = { id, appId: app.id, name: 'fixture.png', mime: 'image/png', width: 20, height: 10, bytes: 8, sha256: 'a'.repeat(64), thumbnailSha256: 'b'.repeat(64), createdAt: 1 };
function Harness() {
  const [route, navigate] = useState<PhoneRoute>({ appId: app.id, viewId: app.homeView });
  return <AppDataView workspaceId="one" app={app} view={app.views[0]} route={route} navigate={navigate} connections={[]} search="" revision={0} scrollPositions={new Map()}/>;
}
beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:fixture') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  currentApiMock().override('agentApps.readImage', async () => ({ mime: 'image/png', bytes: new Uint8Array([1, 2]) }));
  currentApiMock().override('agentApps.releaseImage', async () => true);
});

describe('phone image interaction', () => {
  it('选择图片后保存记录、列表显示缩略图并打开大图', async () => {
    let saved: AppRecord | undefined;
    currentApiMock().override('agentApps.query', async (_ws, query) => query.id ? { record: saved } : { records: saved ? [saved] : [], total: saved ? 1 : 0 });
    currentApiMock().override('agentApps.pickImage', async () => ({ canceled: false, asset }));
    currentApiMock().override('agentApps.call', async (_ws, call) => { saved = { id: 'record', collection: 'items', revision: 1, createdAt: 1, updatedAt: 1, values: call.params.values }; return { record: saved }; });
    render(<Harness/>);
    fireEvent.click(await screen.findByRole('button', { name: '新增' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '海边' } });
    fireEvent.click(screen.getByRole('button', { name: '选择图片' }));
    await screen.findByRole('img', { name: '图片' });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.call')).toHaveBeenCalledWith('one', expect.objectContaining({ commandId: 'create', params: { values: { title: '海边', image: id } } })));
    fireEvent.click(await screen.findByRole('button', { name: '海边' }));
    expect(await screen.findByRole('img', { name: '海边' })).toBeTruthy();
    expect(currentApiMock().mockOf('agentApps.readImage')).toHaveBeenCalledWith('one', app.id, id, true);
    expect(currentApiMock().mockOf('agentApps.readImage')).toHaveBeenCalledWith('one', app.id, id, false);
  });
  it('拖入图片会使用本机文件入口，取消表单清理未使用的导入', async () => {
    currentApiMock().override('agentApps.query', async () => ({ records: [], total: 0 }));
    currentApiMock().override('agentApps.dropImage', async () => asset);
    render(<Harness/>);
    fireEvent.click(await screen.findByRole('button', { name: '新增' }));
    const file = new File(['fixture'], 'fixture.png', { type: 'image/png' });
    fireEvent.drop(screen.getByRole('button', { name: '选择图片' }).parentElement!, { dataTransfer: { files: [file] } });
    await screen.findByRole('img', { name: '图片' });
    expect(currentApiMock().mockOf('agentApps.dropImage')).toHaveBeenCalledWith('one', app.id, file);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.releaseImage')).toHaveBeenCalledWith('one', app.id, id));
    expect(currentApiMock().mockOf('agentApps.call')).not.toHaveBeenCalled();
  });
  it('自定义页面通过本应用身份读取图片，拒绝无关窗口消息', async () => {
    const view = { ...app.views[0], kind: 'custom' as const, html: '<script>app.onPresent(()=>{});</script>' };
    render(<CustomAppView workspaceId="one" app={app} view={view} revision={0} select={() => {}} interact={() => {}} fallback={() => {}}/>);
    const frame = screen.getByTitle('相册 · 相册') as HTMLIFrameElement;
    const html = frame.getAttribute('srcdoc')!;
    expect(html).toContain('img-src data: blob:');
    const token = /const token="([^"]+)"/.exec(html)![1];
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: window, data: { phoneApp: token, type: 'asset', id: 1, query: { id, thumbnail: true } } })); });
    expect(currentApiMock().mockOf('agentApps.readImage')).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data: { phoneApp: token, type: 'asset', id: 2, query: { id, thumbnail: true } } })); });
    await waitFor(() => expect(currentApiMock().mockOf('agentApps.readImage')).toHaveBeenCalledWith('one', app.id, id, true));
  });
  it('自定义页面的 ma-text 随展示数据更新并保留组件内诊断', async () => {
    const view = { ...app.views[0], kind: 'custom' as const, html: `
      <ma-text id="title" bind="recordTitle" text="等待记录"></ma-text>
      <ma-text id="invalid" expr="1 / 0"></ma-text>
      <script>app.onPresent(presentation => maUi.set('recordTitle', presentation.title));</script>` };
    render(<CustomAppView workspaceId="one" app={app} view={view} revision={0} select={() => {}} interact={() => {}} fallback={() => {}}/>);
    const frame = screen.getByTitle('相册 · 相册') as HTMLIFrameElement;
    const html = frame.getAttribute('srcdoc')!;
    const token = /const token="([^"]+)"/.exec(html)![1];
    const JSDOM = (globalThis as any).jsdom.constructor;
    const post = vi.fn();
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      beforeParse(window: Window) { window.postMessage = post; }
    });
    try {
      await new Promise<void>(resolve => dom.window.addEventListener('load', resolve, { once: true }));
      const doc = dom.window.document;
      const title = doc.querySelector('#title .ma-text-value');
      expect(title.textContent).toBe('等待记录');
      const receive = (data: object) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
        source: dom.window, data: { phoneApp: token, ...data }
      }));
      receive({ type: 'present', presentation: { title: '第一条持久记录' } });
      expect(title.textContent).toBe('第一条持久记录');
      expect(doc.querySelector('#title').hasAttribute('aria-invalid')).toBe(false);
      expect(doc.querySelector('#invalid [role="alert"]').hidden).toBe(false);
      receive({ type: 'locale', locale: 'en', labels: { useAppActions: 'Use the app controls' } });
      expect(doc.querySelector('#invalid [role="alert"]').textContent).toContain('Cannot divide by zero');
      await expect(dom.window.maUi.action({ type: 'copy' })).rejects.toThrow('Use the app controls');
      expect(post.mock.calls.map(([message]) => message.type)).toEqual(['ready']);
    } finally { dom.window.close(); }
  });
});
