import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MobileFiles } from '../../src/renderer/src/mobile/MobileFiles';
import type { WorkspaceFileRef, WorkspaceInfo } from '../../src/shared/types';
import { currentApiMock } from './helpers/api-mock';

const gateway = vi.hoisted(() => ({ active: false }));
vi.mock('../../src/renderer/src/webGatewayEnvironment', () => ({ isWebGateway: () => gateway.active }));
const ws: WorkspaceInfo = { id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, controlRoot: 'E:/A', defaultRootId: 'a', rootsRevision: 0,
  roots: [{ id: 'a', path: 'E:/A', label: 'Same' }, { id: 'b /中文', path: 'D:/B', label: 'Same' }] };
const ref = (rootId = 'b /中文', relativePath = 'same.txt'): WorkspaceFileRef => ({ workspaceId: ws.id, rootId, relativePath });
const props = { open: true, wsId: ws.id, workspace: ws, nonce: 1, onClose: vi.fn(), onTip: vi.fn() };
beforeEach(() => {
  gateway.active = false;
  props.onClose.mockClear(); props.onTip.mockClear();
  const api = currentApiMock();
  api.override('fs.listDirRef', async () => ({ entries: [{ name: 'same.txt', relativePath: 'same.txt', isDirectory: false }] }));
  api.override('fs.readTextRef', async (file: WorkspaceFileRef) => ({ ok: true, content: 'from ' + file.rootId }));
  api.override('fs.statRef', async () => ({ ok: true, isFile: true, isDirectory: false }));
  api.override('fs.refreshWatch', async () => ({ ok: true }));
  api.override('fs.resolveRef', async (_id: string, path: string) => ({ ok: true, fileRef: ref('b /中文', path) }));
});

describe('手机文件抽屉的源根身份', () => {
  it('先列全部根并显示同名根的路径，选择后只读对应根；返回保留来源', async () => {
    const api = currentApiMock();
    render(<MobileFiles {...props} />);
    expect(api.mockOf('fs.listDirRef')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Same D:/B' }));
    fireEvent.click(await screen.findByRole('button', { name: 'same.txt' }));
    await screen.findByText('from b /中文');
    expect(api.mockOf('fs.readTextRef')).toHaveBeenCalledWith(ref());
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await screen.findByRole('button', { name: 'same.txt' });
    expect(api.mockOf('fs.listDirRef')).toHaveBeenLastCalledWith(ref('b /中文', ''));
    fireEvent.click(screen.getByRole('button', { name: '源文件夹' }));
    fireEvent.click(screen.getByRole('button', { name: 'Same E:/A' }));
    fireEvent.click(await screen.findByRole('button', { name: 'same.txt' }));
    await screen.findByText('from a');
    expect(api.mockOf('fs.listDir')).not.toHaveBeenCalled();
    expect(api.mockOf('fs.readText')).not.toHaveBeenCalled();
  });
  it('旧单根直接浏览，并为列表和文件补稳定根 ID', async () => {
    const api = currentApiMock();
    render(<MobileFiles {...props} workspace={{ id: 'ws', name: 'old', path: 'E:/A', openedAt: 0 }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'same.txt' }));
    await screen.findByText('from root-ws');
    expect(api.mockOf('fs.listDirRef')).toHaveBeenCalledWith(ref('root-ws', ''));
  });
  it('根删除或元数据错误不会打开默认根的同名文件，恢复选择须由用户点击', async () => {
    const api = currentApiMock();
    const view = render(<MobileFiles {...props} target={{ path: 'same.txt', fileRef: ref() }} />);
    await screen.findByText('from b /中文');
    api.mockOf('fs.readTextRef').mockClear();
    view.rerender(<MobileFiles {...props} workspace={{ ...ws, rootsRevision: 1, roots: [ws.roots![0]] }} target={{ path: 'same.txt', fileRef: ref() }} />);
    await screen.findByRole('alert');
    expect(screen.queryByText('from a')).toBeNull();
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
    expect(api.mockOf('shell.statPaths')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '源文件夹' }));
    fireEvent.click(screen.getByRole('button', { name: 'Same E:/A' }));
    expect(await screen.findByRole('button', { name: 'same.txt' })).toBeTruthy();
  });
  it('慢目标、关闭和卸载后的返回不覆盖后续目录或弹提示', async () => {
    const api = currentApiMock(); let finish!: (value: unknown) => void;
    api.override('fs.statRef', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<MobileFiles {...props} target={{ path: 'same.txt', fileRef: ref('a') }} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Same D:/B' }));
    await act(async () => finish({ ok: true, isFile: true }));
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
    view.rerender(<MobileFiles {...props} nonce={2} target={{ path: 'same.txt', fileRef: ref('a') }} />);
    await waitFor(() => expect(api.mockOf('fs.statRef')).toHaveBeenCalledTimes(2));
    view.unmount();
    await act(async () => finish({ ok: false, error: 'late failure' }));
    expect(props.onTip).not.toHaveBeenCalled();
  });
  it('相对 Markdown 内链继续使用当前源根，回到文件所在目录', async () => {
    const api = currentApiMock();
    api.override('fs.readTextRef', async (file: WorkspaceFileRef) => ({ ok: true,
      content: file.relativePath.endsWith('.md') ? '[open](../same.txt)' : 'linked b' }));
    render(<MobileFiles {...props} target={{ path: 'docs/readme.md', fileRef: ref('b /中文', 'docs/readme.md') }} />);
    fireEvent.click(await screen.findByText('open'));
    await screen.findByText('linked b');
    expect(api.mockOf('fs.statRef')).toHaveBeenLastCalledWith(ref());
    expect(api.mockOf('fs.resolveRef')).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '返回' }));
    await screen.findByRole('button', { name: 'same.txt' });
    expect(api.mockOf('fs.listDirRef')).toHaveBeenLastCalledWith(ref('b /中文', ''));
  });
  it('旧多根相对链接拒绝歧义，Junction/坏根失败不降级为区外读取', async () => {
    const api = currentApiMock();
    api.override('fs.resolveRef', async () => ({ ok: false, error: 'source folder selection required' }));
    const view = render(<MobileFiles {...props} target={{ path: 'same.txt' }} />);
    expect((await screen.findByRole('alert')).textContent).toContain('selection required');
    api.override('fs.resolveRef', async () => ({ ok: false, error: 'path outside source folder (Junction)' }));
    view.rerender(<MobileFiles {...props} nonce={2} target={{ path: 'D:/B/escape/same.txt' }} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Junction'));
    expect(api.mockOf('shell.statPaths')).not.toHaveBeenCalled();
    expect(api.mockOf('fs.readExternal')).not.toHaveBeenCalled();
  });
  it('真正区外媒体保持只读，Web URL 不把 f 当作磁盘路径一部分', async () => {
    gateway.active = true;
    const api = currentApiMock();
    // 结构化 reason 判定区外（files-panel F-02）：error 文案可为任意语言/改写，不再匹配英文原文
    api.override('fs.resolveRef', async () => ({ ok: false, error: '路径在所有源根之外', reason: 'outside-workspace-roots' }));
    api.override('shell.statPaths', async () => ({ 'E:/outside/a #.png': { exists: true, isFile: true } }));
    render(<MobileFiles {...props} target={{ path: 'E:/outside/a #.png' }} />);
    const image = await screen.findByRole('img', { name: 'a #.png' });
    expect(image.getAttribute('src')).toBe('/media/ext/E%3A%2Foutside%2Fa%20%23.png');
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
  });
  it('关闭、根版本更新及切工作区都会使在途目标失效', async () => {
    const api = currentApiMock(); const pending: Array<(value: unknown) => void> = [];
    api.override('fs.statRef', () => new Promise(resolve => pending.push(resolve)));
    const target = { path: 'same.txt', fileRef: ref() };
    const view = render(<MobileFiles {...props} target={target} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    view.rerender(<MobileFiles {...props} target={target} open={false} />);
    await act(async () => pending[0]({ ok: true, isFile: true }));
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
    view.rerender(<MobileFiles {...props} target={target} nonce={2} />);
    await waitFor(() => expect(pending).toHaveLength(2));
    view.rerender(<MobileFiles {...props} target={target} nonce={2} workspace={{ ...ws, rootsRevision: 1 }} />);
    await act(async () => pending[1]({ ok: true, isFile: true }));
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
    view.rerender(<MobileFiles {...props} target={target} nonce={3} workspace={{ ...ws, rootsRevision: 1 }} />);
    await waitFor(() => expect(pending).toHaveLength(3));
    view.rerender(<MobileFiles {...props} wsId="other" workspace={{ ...ws, id: 'other' }} target={null} />);
    await act(async () => pending[2]({ ok: false, error: 'old workspace failed' }));
    expect(props.onTip).not.toHaveBeenCalled();
    expect(screen.queryByText('old workspace failed')).toBeNull();
  });
  it('绝对路径通过主进程定位第二根；显式错误工作区不能做外部判断', async () => {
    const api = currentApiMock();
    api.override('fs.resolveRef', async () => ({ ok: true, fileRef: ref() }));
    const view = render(<MobileFiles {...props} target={{ path: 'D:/B/same.txt' }} />);
    await screen.findByText('from b /中文');
    expect(api.mockOf('fs.resolveRef')).toHaveBeenCalledWith('ws', 'D:/B/same.txt');
    expect(api.mockOf('shell.statPaths')).not.toHaveBeenCalled();
    view.rerender(<MobileFiles {...props} nonce={2} target={{ path: 'D:/B/same.txt', fileRef: { ...ref(), workspaceId: 'other' } }} />);
    await screen.findByRole('alert');
    expect(api.mockOf('shell.statPaths')).not.toHaveBeenCalled();
    expect(api.mockOf('fs.statRef')).toHaveBeenCalledOnce();
  });
  it('元数据晚到后补处理原目标，改名排序保留已选来源', async () => {
    const target = { path: 'same.txt', fileRef: ref() };
    const view = render(<MobileFiles {...props} workspace={undefined} target={target} />);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    view.rerender(<MobileFiles {...props} target={target} />);
    await screen.findByText('from b /中文');
    view.rerender(<MobileFiles {...props} target={target} workspace={{ ...ws, rootsRevision: 1,
      roots: [{ ...ws.roots![1], label: 'Renamed' }, ws.roots![0]] }} />);
    await screen.findByText('from b /中文');
    expect(screen.getByRole('button', { name: '源文件夹' }).textContent).toContain('Renamed');
  });
  it('媒体 URL 保留特殊根 ID；HTML 禁脚本并在关闭时撤销资源地址', async () => {
    gateway.active = true;
    const api = currentApiMock();
    api.override('fs.createPreview', async () => ({ ok: true, token: 'preview', path: '/media/preview/preview/' }));
    api.override('fs.releasePreview', async () => ({ ok: true }));
    const view = render(<MobileFiles {...props} target={{ path: 'image.png', fileRef: ref('b /中文', 'image.png') }} />);
    const image = await screen.findByRole('img', { name: 'image.png' });
    expect(new URL(image.getAttribute('src')!, location.href).searchParams.get('rootId')).toBe('b /中文');
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
    view.rerender(<MobileFiles {...props} nonce={2} target={{ path: 'index.html', fileRef: ref('b /中文', 'index.html') }} />);
    await waitFor(() => expect(view.container.querySelector('iframe')?.getAttribute('sandbox')).toBe(''));
    view.rerender(<MobileFiles {...props} open={false} nonce={2} target={{ path: 'index.html', fileRef: ref('b /中文', 'index.html') }} />);
    expect(api.mockOf('fs.releasePreview')).toHaveBeenCalledWith('preview');
  });
  it('离线目录不循环请求，手动刷新只恢复该根', async () => {
    const api = currentApiMock();
    api.override('fs.listDirRef', async () => ({ entries: [], error: 'offline b' }));
    render(<MobileFiles {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Same D:/B' }));
    await screen.findByText('offline b');
    expect(api.mockOf('fs.listDirRef')).toHaveBeenCalledOnce();
    api.override('fs.listDirRef', async () => ({ entries: [{ name: 'same.txt', relativePath: 'same.txt', isDirectory: false }] }));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await screen.findByRole('button', { name: 'same.txt' });
    expect(api.mockOf('fs.refreshWatch')).toHaveBeenCalledWith('ws', 'b /中文');
  });
});
