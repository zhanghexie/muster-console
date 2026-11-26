import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QuickOpen } from '../../src/renderer/src/components/QuickOpen';
import { KeybindingProvider } from '../../src/renderer/src/keybindings/KeybindingHost';
import type { PresenceStage } from '../../src/renderer/src/components/motion';
import { StoreProvider, useUiStore } from '../../src/renderer/src/store';
import { currentApiMock } from './helpers/api-mock';
import type { PaletteMode } from '../../src/shared/commandPalette';
import type { WorkspaceInfo, WorkspaceQueryResult, WorkspaceListedFile } from '../../src/shared/types';
import { dismissTip, getTipSnapshot } from '../../src/renderer/src/tips';

beforeEach(() => dismissTip());

const ws: WorkspaceInfo = { id: 'palette-roots', name: 'Sources', path: 'E:/alpha', openedAt: 1, rootsRevision: 0,
  defaultRootId: 'a', controlRoot: 'E:/alpha', roots: [{ id: 'a', path: 'E:/alpha', label: 'Alpha' }, { id: 'b', path: 'E:/beta', label: 'Beta' }] };
const other: WorkspaceInfo = { ...ws, id: 'other-roots' };
let workspaceSequence = 0;
function file(rootId = 'a', path = 'src/same.ts', workspaceId = ws.id): WorkspaceListedFile {
  return { path, absolutePath: `E:/${rootId === 'a' ? 'alpha' : 'beta'}/${path}`, fileRef: { workspaceId, rootId, relativePath: path } };
}
function result(items: WorkspaceListedFile[] = [file(), file('b')], revision = 0): WorkspaceQueryResult<WorkspaceListedFile> {
  return { items, roots: [], rootsRevision: revision, truncated: false, cancelled: false };
}
function Harness({ id = ws.id, mode = 'file', show = true, stage, onClose = () => {} }: {
  id?: string; mode?: PaletteMode; show?: boolean; stage?: PresenceStage; onClose?: () => void;
}) {
  const { openWorkspaceFile } = useUiStore();
  return <>{show ? <QuickOpen workspaceId={id} mode={mode} seq={0} stage={stage} onRequestMode={() => {}} onOpenSettings={() => {}} onClose={onClose} /> : null}
    {openWorkspaceFile ? <output data-testid="opened">{JSON.stringify(openWorkspaceFile)}</output> : null}</>;
}
function tree(props: Parameters<typeof Harness>[0] = {}) {
  return <StoreProvider><KeybindingProvider><Harness {...props} /></KeybindingProvider></StoreProvider>;
}
function seed() {
  // The production cache intentionally survives unmounts; each test gets a
  // distinct workspace identity instead of inheriting another test's results.
  ws.id = `palette-roots-${++workspaceSequence}`;
  other.id = `other-roots-${workspaceSequence}`;
  const mock = currentApiMock();
  mock.override('workspaces.list', async () => ({ workspaces: [ws, other], activeWorkspaceId: ws.id }));
  mock.override('config.get', async () => ({ workspaces: [ws, other], activeWorkspaceId: ws.id, locale: 'zh-CN' }));
  mock.override('fs.listFiles', async () => result());
  mock.override('fs.cancelQuery', async () => ({ cancelled: true }));
  Element.prototype.scrollIntoView = () => {};
  return mock;
}
async function changed(activeWorkspaceId: string, rootsRevision = 0) {
  await act(async () => currentApiMock().emit('workspaces:changed', { workspaces: [{ ...ws, rootsRevision }, other], activeWorkspaceId }));
}

describe('QuickOpen 多根文件身份与请求生命周期', () => {
  it('点击搜索外壳关闭后，磨砂独立淡出且不再占用 Esc', async () => {
    seed();
    const onClose = vi.fn();
    const view = render(tree({ mode: 'goto', onClose }));
    const dialog = await screen.findByRole('dialog', { name: '搜索' });
    const mask = dialog.parentElement as HTMLElement;
    const scrim = mask.querySelector<HTMLElement>(':scope > .backdrop-blur-overlay.mp-scrim');
    expect(mask.classList.contains('mp-scrim')).toBe(false);
    expect(dialog.classList.contains('mp-panel-fly')).toBe(true);
    expect(scrim?.dataset.mpStage).toBe('in');

    fireEvent.mouseDown(mask);
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(tree({ mode: 'goto', stage: 'out', onClose }));
    expect(scrim?.dataset.mpStage).toBe('out');
    expect(dialog.dataset.mpStage).toBe('out');
    expect(mask.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('普通 HTTP 页面没有 randomUUID 时仍能搜索并打开文件', async () => {
    const previous = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    try {
      const mock = seed();
      render(tree());
      expect(await screen.findByText('Beta/src/same.ts')).toBeTruthy();
      const request = mock.mockOf('fs.listFiles').mock.calls[0][1];
      expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      fireEvent.click(screen.getByRole('option', { name: /Beta\/src\/same.ts/ }));
      expect(JSON.parse((await screen.findByTestId('opened')).textContent!).fileRef).toEqual(file('b').fileRef);
    } finally {
      if (previous) Object.defineProperty(crypto, 'randomUUID', previous);
      else Reflect.deleteProperty(crypto, 'randomUUID');
    }
  });

  it('同名文件显示来源，键盘打开第二根并携带 FileRef', async () => {
    seed(); render(tree());
    expect(await screen.findByText('Alpha/src/same.ts')).toBeTruthy();
    expect(screen.getByText('Beta/src/same.ts')).toBeTruthy();
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    const opened = JSON.parse((await screen.findByTestId('opened')).textContent!);
    expect(opened.fileRef).toEqual(file('b').fileRef);
    expect(opened.path).toBe('E:/beta/src/same.ts');
  });

  it('会话结果插入到前面后，键盘仍打开已选中的第二根文件', async () => {
    const mock = seed(); render(tree({ mode: 'goto' }));
    const input = await screen.findByRole('combobox');
    fireEvent.change(input, { target: { value: 'same' } });
    await screen.findByText('Beta/src/same.ts');
    const beta = screen.getByText('Beta/src/same.ts').closest('[role="option"]')!;
    const betaIndex = screen.getAllByRole('option').indexOf(beta as HTMLElement);
    for (let index = 0; index < betaIndex; index++) fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(beta.getAttribute('aria-selected')).toBe('true');
    await act(async () => mock.emit('sessions:changed', {
      sessions: [{ id: 'new-session', name: 'same task', type: 'terminal', cwd: 'E:/alpha', workspaceId: ws.id, createdAt: 1 }],
      activeId: null
    }));
    expect(screen.getByRole('option', { name: /same task/ })).toBeTruthy();
    expect(beta.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(JSON.parse((await screen.findByTestId('opened')).textContent!).fileRef).toEqual(file('b').fileRef);
  });

  it('查询往返时复位到首项，不恢复旧查询的第二根选择', async () => {
    seed(); render(tree());
    await screen.findByText('Beta/src/same.ts');
    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByText('Beta/src/same.ts').closest('[role="option"]')!.getAttribute('aria-selected')).toBe('true');
    fireEvent.change(input, { target: { value: 'same' } });
    expect(screen.getByText('Alpha/src/same.ts').closest('[role="option"]')!.getAttribute('aria-selected')).toBe('true');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(JSON.parse((await screen.findByTestId('opened')).textContent!).fileRef).toEqual(file('a').fileRef);
  });

  it('部分失败和截断可见，保留可用根；内容选择保留根及行号', async () => {
    const mock = seed();
    mock.override('fs.searchFiles', async () => ({ ...result([file('b')]), items: [{ ...file('b'), line: 12, preview: 'needle in Beta' }],
      roots: [{ rootId: 'a', error: 'offline', truncated: false, timedOut: false }], truncated: true }));
    render(tree({ mode: 'content' }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'needle' } });
    expect(await screen.findByText('Beta/src/same.ts:12')).toBeTruthy();
    expect(getTipSnapshot()?.text).toMatch(/部分文件夹搜索失败：Alpha/);
    expect(screen.getByText('搜索结果已截断，请缩小范围')).toBeTruthy();
    fireEvent.click(screen.getByRole('option'));
    const opened = JSON.parse((await screen.findByTestId('opened')).textContent!);
    expect(opened.fileRef).toEqual(file('b').fileRef);
    expect(opened.line).toBe(12);
  });

  it('A→B→A 不接收首个 A 的晚到结果，取消无消费者的查询', async () => {
    const mock = seed();
    const pending: Array<{ id: string; requestId: string; resolve: (value: ReturnType<typeof result>) => void }> = [];
    mock.override('fs.listFiles', (id: string, opts: { requestId: string }) => new Promise(resolve => pending.push({ id, requestId: opts.requestId, resolve })));
    const view = render(tree());
    await waitFor(() => expect(pending).toHaveLength(1));
    await changed(other.id); view.rerender(tree({ id: other.id }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await changed(ws.id); view.rerender(tree());
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => pending[2].resolve(result([file('a', 'new.ts')])));
    expect(await screen.findByText('new.ts')).toBeTruthy();
    await act(async () => pending[0].resolve(result([file('b', 'old.ts')])));
    expect(screen.queryByText('old.ts')).toBeNull();
    expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalledWith(ws.id, pending[0].requestId);
    expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalledWith(other.id, pending[1].requestId);
    view.rerender(tree({ show: false }));
    view.rerender(tree());
    expect(await screen.findByText('new.ts')).toBeTruthy();
    expect(screen.queryByText('old.ts')).toBeNull();
  });

  it('源根版本变更立即隐藏旧候选并重查，拒绝无根和移除根候选', async () => {
    const mock = seed(); render(tree());
    await screen.findByText('Beta/src/same.ts');
    let complete: (value: unknown) => void = () => {};
    mock.override('fs.listFiles', () => new Promise(resolve => { complete = resolve; }));
    await changed(ws.id, 1);
    expect(screen.queryByText('Beta/src/same.ts')).toBeNull();
    await act(async () => complete(result([file('a', 'fresh.ts'), { path: 'bare.ts' } as WorkspaceListedFile, file('removed', 'wrong.ts')], 1)));
    expect(await screen.findByText('fresh.ts')).toBeTruthy();
    expect(screen.queryByText('bare.ts')).toBeNull();
    expect(screen.queryByText('wrong.ts')).toBeNull();
  });

  it('A 已加载后切到 B 再返回 A，恢复原缓存且不永久加载', async () => {
    const mock = seed(); const view = render(tree());
    await screen.findByText('Beta/src/same.ts');
    let finishB: (value: unknown) => void = () => {};
    mock.override('fs.listFiles', () => new Promise(resolve => { finishB = resolve; }));
    await changed(other.id); view.rerender(tree({ id: other.id }));
    await waitFor(() => expect(mock.mockOf('fs.listFiles')).toHaveBeenCalledTimes(1));
    await changed(ws.id); view.rerender(tree());
    expect(await screen.findByText('Beta/src/same.ts')).toBeTruthy();
    expect(screen.queryByText('枚举文件中…')).toBeNull();
    await act(async () => finishB(result([file('a', 'wrong-workspace.ts', other.id)])));
    expect(screen.queryByText('wrong-workspace.ts')).toBeNull();
    expect(mock.mockOf('fs.listFiles')).toHaveBeenCalledTimes(1);
  });

  it('切离内容档和关闭浮层取消旧查询，晚到错误不回填', async () => {
    const mock = seed(); let complete: (value: unknown) => void = () => {};
    mock.override('fs.searchFiles', () => new Promise(resolve => { complete = resolve; }));
    const view = render(tree({ mode: 'content' }));
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'pending' } });
    await waitFor(() => expect(mock.mockOf('fs.searchFiles')).toHaveBeenCalledTimes(1));
    const request = mock.mockOf('fs.searchFiles').mock.calls[0][1];
    fireEvent.click(screen.getByRole('tab', { name: '文件' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await screen.findByText('Beta/src/same.ts');
    await act(async () => complete({ ...result([]), error: 'late failure' }));
    expect(screen.queryByText('late failure')).toBeNull();
    expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalledWith(ws.id, request.requestId);
    view.rerender(tree({ show: false }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('共享枚举只在最后一个消费者关闭时取消，关闭后的结果不回填', async () => {
    const mock = seed(); let complete: (value: unknown) => void = () => {};
    mock.override('fs.listFiles', () => new Promise(resolve => { complete = resolve; }));
    const both = (first: boolean, second: boolean) => <StoreProvider><KeybindingProvider>
      <Harness key="first" show={first} /><Harness key="second" show={second} />
    </KeybindingProvider></StoreProvider>;
    const view = render(both(true, true));
    await waitFor(() => expect(mock.mockOf('fs.listFiles')).toHaveBeenCalledTimes(1));
    view.rerender(both(false, true));
    await act(async () => { await Promise.resolve(); });
    expect(mock.mockOf('fs.cancelQuery')).not.toHaveBeenCalled();
    view.rerender(both(false, false));
    await waitFor(() => expect(mock.mockOf('fs.cancelQuery')).toHaveBeenCalledTimes(1));
    await act(async () => complete(result()));
    expect(screen.queryByText('Beta/src/same.ts')).toBeNull();
  });
});
