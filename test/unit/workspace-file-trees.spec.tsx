import { renderWithAppTips as render } from './helpers/app-tips';
import React, { createRef, forwardRef, useImperativeHandle } from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiMock, type ApiMock } from './helpers/api-mock';
import type { WorkspaceFileRef, WorkspaceInfo } from '../../src/shared/types';

const state = vi.hoisted(() => ({
  activeWorkspaceId: 'ws',
  workspaces: [] as WorkspaceInfo[],
  flashTip: vi.fn(), pushRight: vi.fn(), flush: vi.fn(async () => {}), patch: vi.fn(async () => {})
}));
vi.mock('../../src/renderer/src/store', () => ({
  useWorkspaceStore: () => ({ activeWorkspaceId: state.activeWorkspaceId, workspaces: state.workspaces }),
  useUiStore: () => ({ flashTip: state.flashTip, openCommandPalette: vi.fn() })
}));
vi.mock('../../src/renderer/src/hooks/useWorkspaceFile', () => ({ useWorkspaceFile: () => ({ cfg: {}, ready: true, patch: state.patch }) }));
vi.mock('../../src/renderer/src/panelHistory', () => ({ useHistoryWsId: () => 'ws', usePanelHistory: () => ({ pushRight: state.pushRight }) }));
vi.mock('../../src/renderer/src/keybindings/KeybindingHost', () => ({ useKeybinding: () => {}, useChordLabel: () => '', useOverlayDismiss: () => {} }));
vi.mock('../../src/renderer/src/components/FileEditor', () => ({
  FileEditor: forwardRef((props: any, ref) => {
    useImperativeHandle(ref, () => ({ flush: state.flush, focusFindBar: vi.fn() }));
    return <div data-testid="editor" data-root={props.rootId} data-path={props.path} data-external={String(props.isExternal)}>
      <button onClick={() => props.onOpenPath('src/other.ts')}>相对链接</button>
      <button onClick={props.onRevealInTree}>定位</button>
    </div>;
  })
}));
import { FilesPanel, type FilesPanelHandle } from '../../src/renderer/src/panels/FilesPanel';

let api: ApiMock;
const ref = (rootId: string, relativePath = 'src/index.ts'): WorkspaceFileRef => ({ workspaceId: 'ws', rootId, relativePath });
const props = { active: true, sideTab: 'files' as const, onSideTab: vi.fn() };
beforeEach(() => {
  state.activeWorkspaceId = 'ws';
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'a', controlRoot: 'E:/A', rootsRevision: 0,
    roots: [{ id: 'a', path: 'E:/A', label: '工程 A' }, { id: 'b', path: 'D:/B', label: '工程 B' }] }];
  state.flashTip.mockClear(); state.pushRight.mockClear(); state.flush.mockReset(); state.flush.mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
  api = createApiMock(); window.api = api.api;
  api.override('fs.listTreeDirRef', async (r: WorkspaceFileRef) => ({ entries: r.relativePath === ''
    ? [{ name: 'src', isDirectory: true, relativePath: 'src', fileRef: ref(r.rootId, 'src') }]
    : [{ name: 'index.ts', isDirectory: false, relativePath: 'src/index.ts', fileRef: ref(r.rootId) }] }));
  api.override('fs.statRef', async (r: WorkspaceFileRef) => ({ ok: ['a', 'b'].includes(r.rootId), isDirectory: false, isFile: true, error: 'source folder not found' }));
  api.override('fs.resolveRef', async () => ({ ok: false, error: 'source folder selection required' }));
});

async function expand(root: '工程 A' | '工程 B') {
  const tree = screen.getByRole('tree', { name: root });
  fireEvent.click(await within(tree).findByText('src'));
  await within(tree).findByText('index.ts');
  return tree;
}

describe('多根文件树与导航身份', () => {
  it('树中区外链接文件进入只读预览，区内链接保留来源身份', async () => {
    api.override('fs.listTreeDirRef', async (r: WorkspaceFileRef) => ({ entries: r.relativePath === '' ? [
      { name: 'linked', relativePath: 'linked', isDirectory: true, isSymbolicLink: true, externalPath: 'C:/skills' },
      { name: 'local-link.md', relativePath: 'local-link.md', isDirectory: false, isSymbolicLink: true }
    ] : [{ name: 'SKILL.md', relativePath: 'linked/SKILL.md', isDirectory: false, viaSymbolicLink: true, externalPath: 'C:/skills/SKILL.md' }] }));
    const handle = createRef<FilesPanelHandle>(); render(<FilesPanel {...props} ref={handle} />);
    const tree = screen.getByRole('tree', { name: '工程 A' });
    fireEvent.click(await within(tree).findByText('linked'));
    fireEvent.click(await within(tree).findByText('SKILL.md'));
    await waitFor(() => expect(handle.current?.getOpenFile()).toEqual({ path: 'C:/skills/SKILL.md', external: true }));
    expect(screen.getByTestId('editor').getAttribute('data-external')).toBe('true');
    fireEvent.click(within(tree).getByText('local-link.md'));
    await waitFor(() => expect(handle.current?.getOpenFile()?.fileRef).toEqual(ref('a', 'local-link.md')));
    expect(screen.getByTestId('editor').getAttribute('data-external')).toBe('false');
  });
  it('刷新保存失败时不切文件或改成外部预览，保留原来源并提示', async () => {
    const handle = createRef<FilesPanelHandle>();
    render(<FilesPanel {...props} ref={handle} />);
    await act(async () => { expect(await handle.current!.openPath(ref('b'))).toBe(true); });
    state.flush.mockRejectedValue(new Error('save conflict'));
    await act(async () => { expect(await handle.current!.openPath(ref('a'))).toBe(false); });
    expect(screen.getByTestId('editor').getAttribute('data-root')).toBe('b');
    expect(state.flashTip).toHaveBeenCalledWith('save conflict');
    await act(async () => { await handle.current!.openExternal('D:/outside.txt'); });
    expect(screen.getByTestId('editor').getAttribute('data-root')).toBe('b');
  });
  it('隐藏期间不刷新，重新显示后补读目录和监听错误；手动刷新可恢复', async () => {
    const view = render(<FilesPanel {...props} active={false} />);
    await screen.findAllByText('src');
    api.mockOf('fs.listTreeDirRef').mockClear();
    act(() => api.emit('fs:changed', { workspaceId: 'ws', rootId: 'b', rootsRevision: 0, relativePaths: [], error: 'watch offline' }));
    expect(api.mockOf('fs.listTreeDirRef')).not.toHaveBeenCalled();
    api.override('fs.listTreeDirRef', async (r: WorkspaceFileRef) => ({ entries: [], watchError: r.rootId === 'b' ? 'watch offline' : undefined }));
    view.rerender(<FilesPanel {...props} />);
    expect(await screen.findByText('文件监听失败：watch offline')).not.toBeNull();
    const rootB = screen.getByRole('tree', { name: '工程 B' }).closest('.file-tree')!;
    api.override('fs.refreshWatch', async () => ({ ok: true }));
    api.override('fs.listTreeDirRef', async () => ({ entries: [] }));
    fireEvent.click(within(rootB as HTMLElement).getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(within(view.container).queryByText('文件监听失败：watch offline')).toBeNull());
    expect(api.mockOf('fs.refreshWatch')).toHaveBeenCalledWith('ws', 'b');
  });
  it('切区再返回仍丢弃第一轮打开和目录请求', async () => {
    const finishes: Array<(result: any) => void> = [];
    api.override('fs.listTreeDirRef', (r: WorkspaceFileRef) => r.workspaceId === 'ws' && r.rootId === 'a'
      ? new Promise(resolve => { finishes.push(resolve); }) : Promise.resolve({ entries: [] }));
    let finishOpen!: (result: any) => void;
    api.override('fs.statRef', () => new Promise(resolve => { finishOpen = resolve; }));
    const handle = createRef<FilesPanelHandle>(); const view = render(<FilesPanel {...props} ref={handle} />);
    let pending!: Promise<boolean>;
    await act(async () => { pending = handle.current!.openPath(ref('a')); await Promise.resolve(); });
    const oldListing = finishes[0];
    state.workspaces = [...state.workspaces, { ...state.workspaces[0], id: 'other' }];
    state.activeWorkspaceId = 'other'; view.rerender(<FilesPanel {...props} ref={handle} />);
    state.activeWorkspaceId = 'ws'; view.rerender(<FilesPanel {...props} ref={handle} />);
    await act(async () => {
      oldListing({ entries: [{ name: 'stale.ts', relativePath: 'stale.ts', isDirectory: false }] });
      finishOpen({ ok: true, isDirectory: false });
      expect(await pending).toBe(false);
    });
    expect(screen.queryByText('stale.ts')).toBeNull();
    expect(handle.current!.getOpenFile()).toBeNull();
    await act(async () => { finishes[1]({ entries: [{ name: 'current.ts', relativePath: 'current.ts', isDirectory: false }] }); });
    expect(await screen.findByText('current.ts')).not.toBeNull();
  });
  it('旧区外请求等待保存时，后续根内导航优先且区外闸口只 flush 一次', async () => {
    const handle = createRef<FilesPanelHandle>(); render(<FilesPanel {...props} ref={handle} />);
    let finish!: () => void;
    state.flush.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    let pending!: Promise<void>;
    act(() => { pending = handle.current!.openExternal('C:/outside.txt'); });
    await act(async () => { await handle.current!.openPath(ref('b')); });
    await act(async () => { finish(); await pending; });
    expect(handle.current!.getOpenFile()?.fileRef).toEqual(ref('b'));
    state.flush.mockClear();
    // 结构化 reason 判定区外（files-panel F-02）：error 文案可为任意语言/改写，不再匹配英文原文
    api.override('fs.resolveRef', async () => ({ ok: false, error: '路径在所有源根之外', reason: 'outside-workspace-roots' }));
    api.override('shell.statPaths', async () => ({ 'C:/outside.txt': { exists: true, isFile: true } }));
    await act(async () => { expect(await handle.current!.openPath('C:/outside.txt')).toBe(true); });
    expect(handle.current!.getOpenFile()).toEqual({ path: 'C:/outside.txt', external: true });
    expect(state.flush).toHaveBeenCalledOnce();
  });
  it('同名文件、相对链接、定位与历史保留源根，键盘焦点独立', async () => {
    const handle = createRef<FilesPanelHandle>();
    render(<FilesPanel {...props} ref={handle} />);
    const a = await expand('工程 A'); const b = await expand('工程 B');
    fireEvent.click(within(b).getByText('index.ts'));
    await waitFor(() => expect(screen.getByTestId('editor').getAttribute('data-root')).toBe('b'));
    expect(handle.current?.getOpenFile()?.fileRef).toEqual(ref('b'));
    fireEvent.click(screen.getByText('相对链接'));
    await waitFor(() => expect(api.mockOf('fs.statRef')).toHaveBeenCalledWith(ref('b', 'src/other.ts')));
    fireEvent.click(within(a).getByText('index.ts'));
    await waitFor(() => expect(screen.getByTestId('editor').getAttribute('data-root')).toBe('a'));
    expect(state.pushRight.mock.calls.some(([, entry]) => entry.fileRef?.rootId === 'b')).toBe(true);
    fireEvent.keyDown(a, { key: 'ArrowLeft' });
    expect(a.querySelector('.file-tree-row.is-active')?.getAttribute('data-file-tree-row')).toBe('src');
    expect(b.querySelector('.file-tree-row.is-active')).toBeNull();
    fireEvent.click(screen.getByText('定位'));
    await waitFor(() => expect(a.querySelector('.file-tree-row.is-active')?.getAttribute('data-file-tree-row')).toBe('src/index.ts'));
    expect(api.mockOf('fs.listTreeDir')).not.toHaveBeenCalled();
  });

  it('未知根和无来源的相对路径拒绝打开，保留原文件身份', async () => {
    const handle = createRef<FilesPanelHandle>(); render(<FilesPanel {...props} ref={handle} />);
    await act(async () => { await handle.current?.openPath(ref('b')); });
    const before = handle.current?.getOpenFile();
    await act(async () => { expect(await handle.current?.openPath(ref('removed'))).toBe(false); });
    expect(handle.current?.getOpenFile()).toEqual(before);
    await act(async () => { expect(await handle.current?.openPath('src/index.ts')).toBe(false); });
    expect(handle.current?.getOpenFile()).toEqual(before);
    expect(state.flashTip).toHaveBeenCalledWith('source folder selection required');
    expect(api.mockOf('fs.readExternal')).not.toHaveBeenCalled();
  });

  it('源根版本变化后丢弃旧目录结果，失败根只等待手动刷新', async () => {
    let finish!: (result: any) => void;
    api.override('fs.listTreeDirRef', (r: WorkspaceFileRef) => r.rootId === 'a'
      ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ entries: [], error: 'offline' }));
    const view = render(<FilesPanel {...props} />);
    await screen.findAllByText('offline');
    await act(async () => { await Promise.resolve(); });
    expect(api.mockOf('fs.listTreeDirRef').mock.calls.filter(([r]) => r.rootId === 'b')).toHaveLength(1);
    const old = finish;
    state.workspaces = [{ ...state.workspaces[0], rootsRevision: 1 }];
    view.rerender(<FilesPanel {...props} />);
    await act(async () => { old({ entries: [{ name: 'stale.ts', relativePath: 'stale.ts', isDirectory: false }] }); });
    expect(screen.queryByText('stale.ts')).toBeNull();
    await act(async () => { finish({ entries: [{ name: 'current.ts', relativePath: 'current.ts', isDirectory: false }] }); });
    expect(await screen.findByText('current.ts')).not.toBeNull();
  });

  it('监听根身份只刷新对应树；根顺序变化不改打开文件', async () => {
    const handle = createRef<FilesPanelHandle>(); const view = render(<FilesPanel {...props} ref={handle} />);
    await expand('工程 A'); await expand('工程 B');
    await act(async () => { await handle.current?.openPath(ref('b')); });
    api.mockOf('fs.listTreeDirRef').mockClear();
    await act(async () => { api.emit('fs:changed', { workspaceId: 'ws', rootId: 'b', relativePaths: ['src/index.ts'] }); });
    expect(api.mockOf('fs.listTreeDirRef').mock.calls.length).toBeGreaterThan(0);
    expect(api.mockOf('fs.listTreeDirRef').mock.calls.every(([r]) => r.rootId === 'b')).toBe(true);
    state.workspaces = [{ ...state.workspaces[0], roots: [...state.workspaces[0].roots!].reverse(), rootsRevision: 1 }];
    await act(async () => { view.rerender(<FilesPanel {...props} ref={handle} />); });
    expect(handle.current?.getOpenFile()?.fileRef).toEqual(ref('b'));
  });
});
