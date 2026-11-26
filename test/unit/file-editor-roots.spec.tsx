import React, { createRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceInfo, WorkspaceFileRef } from '../../src/shared/types';
import { createApiMock, type ApiMock } from './helpers/api-mock';

const state = vi.hoisted(() => ({ workspaces: [] as WorkspaceInfo[], wordRender: vi.fn() }));
vi.mock('../../src/renderer/src/store', () => ({ useWorkspaceStore: () => ({ workspaces: state.workspaces }) }));
vi.mock('docx-preview', () => ({ renderAsync: state.wordRender }));
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
import { FileEditor, type FileEditorHandle } from '../../src/renderer/src/components/FileEditor';
import { applyTheme, getResolvedAppearance, setWorkspaceAppearance, terminalTheme } from '../../src/renderer/src/theme';
import { builtinTheme } from '../../src/shared/theme';
import { readFileEditorStates } from '../../src/renderer/src/fileEditorState';
import { setPeekPointerHandler } from '../../src/renderer/src/browserPointer';

let api: ApiMock;
const fileRef = (rootId: string): WorkspaceFileRef => ({ workspaceId: 'ws', rootId, relativePath: 'index.txt' });
const editorProps = { findBarOpen: false, onFindBarClose: () => {} };
beforeEach(() => {
  state.workspaces = [{ id: 'ws', name: 'Workspace', path: 'E:/A', openedAt: 0, defaultRootId: 'a', controlRoot: 'E:/A', rootsRevision: 0,
    roots: [{ id: 'a', path: 'E:/A' }, { id: 'b', path: 'D:/B' }] }];
  api = createApiMock(); window.api = api.api;
  api.override('fs.readTextRef', async (ref: WorkspaceFileRef) => ({ ok: true, content: `from ${ref.rootId}`, mtimeMs: 1 }));
  api.override('fs.writeTextRef', async () => ({ ok: true, mtimeMs: 2 }));
});
afterEach(() => vi.unstubAllGlobals());

describe('真实 FileEditor 的源根身份', () => {
  it.each([false, true])('opens the saved HTML in the browser from either toolbar (compact %s)', async compactToolbar => {
    const host = document.createElement('div');
    document.body.append(host);
    const open = vi.fn(async () => ({ ok: true }));
    api.override('fs.openBrowserPreview', open);
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="deck/slide.HTM"
      compactToolbar={compactToolbar} toolbarHost={host} />);
    try {
      await screen.findByLabelText('HTML 预览');
      fireEvent.click(screen.getByRole(compactToolbar ? 'button' : 'tab', { name: '编辑' }));
      const editor = EditorView.findFromDOM(view.container.querySelector('.cm-content')!)!;
      act(() => editor.dispatch({ changes: { from: 0, insert: 'unsaved' } }));
      const button = screen.getByRole('button', { name: '浏览器预览' });
      expect(button.title).toContain('磁盘上已保存');
      fireEvent.click(button);
      expect(open).toHaveBeenCalledWith({ workspaceId: 'ws', rootId: 'b', relativePath: 'deck/slide.HTM' });
      expect(api.mockOf('fs.writeTextRef')).not.toHaveBeenCalled();
      expect(editor.state.doc.toString()).toContain('unsaved');
    } finally {
      view.unmount();
      host.remove();
    }
  });
  it('reports a browser preview error and hides the action for ordinary text', async () => {
    api.override('fs.openBrowserPreview', async () => ({ ok: false, error: 'File removed' }));
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="page.html" />);
    await screen.findByLabelText('HTML 预览');
    fireEvent.click(screen.getByRole('button', { name: '浏览器预览' }));
    await waitFor(() => expect(api.mockOf('notify.toast')).toHaveBeenCalledWith({ workspaceId: 'ws', label: '浏览器预览', text: 'File removed' }));
    view.rerender(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="ordinary.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    expect(screen.queryByRole('button', { name: '浏览器预览' })).toBeNull();
  });
  it('reports live editing and unsaved state through debounce, in-flight writes and unmount', async () => {
    let finish!: (result: { ok: boolean; mtimeMs: number }) => void;
    api.override('fs.writeTextRef', () => new Promise(resolve => { finish = resolve; }));
    const ref = createRef<FileEditorHandle>();
    const view = render(<FileEditor {...editorProps} ref={ref} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    expect(readFileEditorStates('ws')).toEqual([]);
    fireEvent.click(await screen.findByRole('tab', { name: '编辑' }));
    expect(readFileEditorStates('ws')).toMatchObject([{ path: 'index.txt', fileRef: fileRef('b'), editing: true, unsaved: false }]);
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-content')!)!;
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'changed' } }));
    expect(readFileEditorStates('ws')[0].unsaved).toBe(true);
    let flushing!: Promise<void>;
    act(() => { flushing = ref.current!.flush(); });
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(readFileEditorStates('ws')[0].unsaved).toBe(true);
    await act(async () => { finish({ ok: true, mtimeMs: 2 }); await flushing; });
    expect(readFileEditorStates('ws')[0].unsaved).toBe(false);
    expect(readFileEditorStates('other')).toEqual([]);
    view.unmount();
    expect(readFileEditorStates('ws')).toEqual([]);
  });
  it('已打开编辑器随主题和工作区换色，dark facet 正确且未保存正文/选择保持', async () => {
    applyTheme(builtinTheme('dark')!);
    const rendered = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    try {
      await waitFor(() => expect(rendered.container.querySelector('.cm-content')?.textContent).toBe('from b'));
      const editor = EditorView.findFromDOM(rendered.container.querySelector('.cm-content')!)!;
      act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved content' }, selection: { anchor: 3 } }));
      expect(editor.state.facet(EditorView.darkTheme)).toBe(true);
      act(() => applyTheme(builtinTheme('light')!, { persist: false }));
      expect(editor.state.facet(EditorView.darkTheme)).toBe(false);
      act(() => setWorkspaceAppearance({ workspaceId: 'ws', accent: '#2fc4b2', enabled: true }));
      const palette = getResolvedAppearance();
      expect(editor.dom.dataset.appearanceRevision).toBe(String(palette.revision));
      expect(palette.cm.background).toBe(terminalTheme().background);
      expect(editor.state.doc.toString()).toBe('unsaved content');
      expect(editor.state.selection.main.anchor).toBe(3);
      expect(EditorView.findFromDOM(rendered.container.querySelector('.cm-content')!)).toBe(editor);
    } finally {
      rendered.unmount();
      setWorkspaceAppearance({ workspaceId: null, accent: '#8e8e96', enabled: false });
      applyTheme(builtinTheme('dark')!);
    }
  });
  it('删除代码索引后右键和 Ctrl/Cmd 点击不再发起定义查询，正文仍可编辑', async () => {
    api.override('fs.readTextRef', async () => ({ ok: true, content: 'commonSymbol', mtimeMs: 1 }));
    const query = vi.fn();
    api.override('codeAnalysis.definition', query);
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('commonSymbol'));
    const coords = vi.spyOn(EditorView.prototype, 'posAtCoords').mockReturnValue(1);
    const content = view.container.querySelector<HTMLElement>('.cm-content')!;
    fireEvent.contextMenu(content, { clientX: 30, clientY: 30 });
    fireEvent.mouseDown(content, { button: 0, ctrlKey: true, clientX: 30, clientY: 30 });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    const editor = EditorView.findFromDOM(content)!;
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'still editable' } }));
    expect(editor.state.doc.toString()).toBe('still editable');
    coords.mockRestore();
  });
  it('保存失败的 flush 拒绝导航，未保存正文和源文件登记继续保留', async () => {
    const ref = createRef<FileEditorHandle>();
    api.override('fs.writeTextRef', async () => ({ ok: false, conflict: true, error: 'save conflict' }));
    const view = render(<FileEditor {...editorProps} ref={ref} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    fireEvent.click(await screen.findByRole('tab', { name: '编辑' }));
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-content')!)!;
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved b' } }));
    await act(async () => { await expect(ref.current!.flush()).rejects.toThrow(); });
    expect(editor.state.doc.toString()).toBe('unsaved b');
    expect(api.mockOf('fs.openFile')).toHaveBeenCalledOnce();
    expect(api.mockOf('fs.closeFile')).not.toHaveBeenCalled();
  });
  it('文件使用登记成功前不可编辑；失效登记显示错误并保持只读', async () => {
    let finish!: (result: unknown) => void;
    api.override('fs.openFile', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    expect((await screen.findByRole('tab', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
    await act(async () => finish({ ok: false, error: 'source folder removed' }));
    expect(screen.getByRole('alert').textContent).toBe('source folder removed');
    expect((screen.getByRole('tab', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.mockOf('fs.writeTextRef')).not.toHaveBeenCalled();
  });
  it('HTML 等正文加载并进入预览后挂载，编辑时卸载脚本与资源', async () => {
    let finish!: (value: unknown) => void;
    api.override('fs.readTextRef', () => new Promise(resolve => { finish = resolve; }));
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="preview.html" />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(view.container.querySelector('iframe')).toBeNull();
    await act(async () => finish({ ok: true, content: '<h1>from b</h1>', mtimeMs: 1 }));
    await waitFor(() => expect(view.container.querySelector('iframe')?.srcdoc).toContain('from b'));
    fireEvent.click(await screen.findByRole('tab', { name: '编辑' }));
    expect(view.container.querySelector('iframe')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '预览' }));
    expect(view.container.querySelector('iframe')?.srcdoc).toContain('from b');
  });
  it('HTML 预览的露条手势按实际所在的虚拟屏转发，编辑时移除手势层', async () => {
    const pointer = vi.fn();
    setPeekPointerHandler(pointer);
    try {
      const editor = <FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.html" />;
      const view = render(<div data-h-page="git" data-h-peek="">{editor}</div>);
      await screen.findByLabelText('HTML 预览');
      const shield = view.container.querySelector('.file-editor-html-peek')!;
      expect(shield).not.toBeNull();
      fireEvent.pointerMove(shield);
      fireEvent.pointerDown(shield, { button: 0 });
      expect(pointer.mock.calls).toEqual([['move', 'git'], ['down', 'git']]);

      view.rerender(<div data-h-page="terminal" data-h-peek="">{editor}</div>);
      fireEvent.pointerDown(shield, { button: 0 });
      expect(pointer).toHaveBeenLastCalledWith('down', 'terminal');
      fireEvent.click(screen.getByRole('tab', { name: '编辑' }));
      expect(shield.isConnected).toBe(false);
    } finally {
      setPeekPointerHandler(null);
    }
  });
  it('外改只更新对应版本/根；脏正文保留并提示覆盖选择', async () => {
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    api.mockOf('fs.readTextRef').mockClear();
    api.override('fs.readTextRef', async () => ({ ok: true, content: 'external b', mtimeMs: 2 }));
    act(() => api.emit('fs:changed', { workspaceId: 'ws', rootId: 'a', rootsRevision: 0, relativePaths: ['index.txt'] }));
    act(() => api.emit('fs:changed', { workspaceId: 'ws', rootId: 'b', rootsRevision: -1, relativePaths: ['index.txt'] }));
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
    act(() => api.emit('fs:changed', { workspaceId: 'ws', rootId: 'b', rootsRevision: 0, relativePaths: ['index.txt'] }));
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('external b'));
    fireEvent.click(await screen.findByRole('tab', { name: '编辑' }));
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-content')!)!;
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved b' } }));
    api.mockOf('fs.readTextRef').mockClear();
    act(() => api.emit('fs:changed', { workspaceId: 'ws', rootId: 'b', rootsRevision: 0, relativePaths: ['index.txt'] }));
    expect(editor.state.doc.toString()).toBe('unsaved b');
    expect(screen.getByRole('button', { name: '覆盖保存' })).not.toBeNull();
    expect(api.mockOf('fs.readTextRef')).not.toHaveBeenCalled();
  });
  it('后台配置页回读只更新变动的字段，保留后续文本的选区且不触发自动保存', async () => {
    const before = '{\n  "hDock": "terminal",\n  "label": "保留选区 📝"\n}\n';
    const after = before.replace('terminal', 'git');
    const path = '.muster/workspace.json';
    const emitChange = () => api.emit('fs:changed', { workspaceId: 'ws', rootId: 'b', rootsRevision: 0, relativePaths: [path] });
    api.override('fs.readTextRef', async () => ({ ok: true, content: before, mtimeMs: 1 }));
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path={path} active={false} />);
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-editor')!)!;
    await waitFor(() => expect(editor.state.doc.toString()).toBe(before));
    const anchor = before.indexOf('保留选区');
    act(() => editor.dispatch({ selection: { anchor, head: anchor + 4 } }));
    const update = vi.spyOn(editor, 'update');

    api.override('fs.readTextRef', async () => ({ ok: true, content: after.replaceAll('\n', '\r\n'), mtimeMs: 2 }));
    await act(async () => emitChange());
    expect(editor.state.doc.toString()).toBe(after);
    const changes = update.mock.calls.flatMap(([transactions]) => transactions).filter(transaction => transaction.docChanged);
    expect(changes).toHaveLength(1);
    const ranges: Array<[number, number, string]> = [];
    changes[0].changes.iterChanges((from, to, _fromB, _toB, insert) => ranges.push([from, to, insert.toString()]));
    const from = before.indexOf('terminal');
    expect(ranges).toEqual([[from, from + 'terminal'.length, 'git']]);
    const nextAnchor = after.indexOf('保留选区');
    expect(editor.state.selection.main).toMatchObject({ anchor: nextAnchor, head: nextAnchor + 4 });

    update.mockClear();
    await act(async () => emitChange());
    expect(update.mock.calls.flatMap(([transactions]) => transactions).some(transaction => transaction.docChanged)).toBe(false);
    expect(api.mockOf('fs.writeTextRef')).not.toHaveBeenCalled();
  });
  it('同名媒体使用各自根 URL，旧 Word 渲染不能写到新根的宿主节点', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    api.override('fs.statRef', async () => ({ ok: true, size: 10, isFile: true }));
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="a" path="same.png" />);
    await waitFor(() => expect(api.mockOf('fs.statRef')).toHaveBeenCalledWith({ ...fileRef('a'), relativePath: 'same.png' }));
    expect(new URL(view.container.querySelector('img.file-media-img')!.getAttribute('src')!).searchParams.get('rootId')).toBe('a');
    view.rerender(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="same.png" />);
    expect(new URL(view.container.querySelector('img.file-media-img')!.getAttribute('src')!).searchParams.get('rootId')).toBe('b');
    let finishA!: () => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, headers: new Headers(),
      arrayBuffer: async () => Uint8Array.of(new URL(url).searchParams.get('rootId') === 'a' ? 1 : 2).buffer })));
    state.wordRender.mockImplementation(async (buf: ArrayBuffer, host: HTMLElement) => {
      if (new Uint8Array(buf)[0] === 1) await new Promise<void>(resolve => { finishA = resolve; });
      host.textContent = new Uint8Array(buf)[0] === 1 ? 'late word a' : 'word b';
    });
    view.rerender(<FileEditor {...editorProps} workspaceId="ws" rootId="a" path="same.docx" />);
    await waitFor(() => expect(finishA).toBeTypeOf('function'));
    view.rerender(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="same.docx" />);
    await screen.findByText('word b');
    await act(async () => finishA());
    expect(screen.queryByText('late word a')).toBeNull();
    expect(screen.getByText('word b')).not.toBeNull();
  });
  it('相同相对路径切根读取对应文件，失败的旧请求不能覆盖当前根', async () => {
    let resolveA!: (value: unknown) => void;
    api.override('fs.readTextRef', (ref: WorkspaceFileRef) => ref.rootId === 'a'
      ? new Promise(resolve => { resolveA = resolve; }) : Promise.resolve({ ok: true, content: 'from b', mtimeMs: 1 }));
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="a" path="index.txt" />);
    await waitFor(() => expect(api.mockOf('fs.readTextRef')).toHaveBeenCalledWith(fileRef('a')));
    view.rerender(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    await act(async () => resolveA({ ok: true, content: 'late a', mtimeMs: 1 }));
    expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b');
    expect(api.mockOf('fs.readText')).not.toHaveBeenCalled();
  });

  it('改名和排序保留未保存正文，后续自动保存仍写原根', async () => {
    const view = render(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    await waitFor(() => expect(view.container.querySelector('.cm-content')?.textContent).toBe('from b'));
    fireEvent.click(await screen.findByRole('tab', { name: '编辑' }));
    const editor = EditorView.findFromDOM(view.container.querySelector('.cm-content')!)!;
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved b' } }));
    state.workspaces = [{ ...state.workspaces[0], rootsRevision: 1,
      roots: [{ id: 'b', path: 'D:/B', label: 'Renamed' }, { id: 'a', path: 'E:/A' }] }];
    view.rerender(<FileEditor {...editorProps} workspaceId="ws" rootId="b" path="index.txt" />);
    expect(editor.state.doc.toString()).toBe('unsaved b');
    expect(api.mockOf('fs.readTextRef')).toHaveBeenCalledOnce();
    await waitFor(() => expect(api.mockOf('fs.writeTextRef')).toHaveBeenCalledWith(fileRef('b'), 'unsaved b', 1));
  });
});
