import { ErrorTip } from '../components/ErrorTip';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { rightToolbarHosts, useRightWorkspace } from '../rightWorkspace';
import { centerFileDockKey, DockSurface, releaseCenterFileDock, useRightDock } from '../rightDock';
import { findRightTabForOpen, rightPreviewFor, rightContentKey, type RightContent, type RightOpenScope, type RightTab } from '../../../shared/rightWorkspace';
import { useUiStore, useWorkspaceStore } from '../store';
import { useWorkspaceFile } from '../hooks/useWorkspaceFile';
import { usePanelHistory, useHistoryWsId } from '../panelHistory';
import { SplitPane } from '../components/SplitPane';
import { FileTree } from '../components/FileTree';
import { FileEditor, type FileEditorHandle } from '../components/FileEditor';
import { ChatLinkOwnerContext } from '../chatSurface/chatLinkOwner';
import {
  SideToolsHistoryNav,
  SideToolsSwitcher,
  type SideToolsTab
} from '../components/SideToolsSwitcher';
import { isTextPreviewKind, previewKindForPath } from '../../../shared/filePreview';
import { resolveWorkspaceId } from '../../../shared/workspaceFallback';
import { isOutsideWorkspaceRootsResult } from '../../../shared/errors';
import type { WorkspaceFileRef } from '../../../shared/types';
import { sourceRootsFor, workspaceFileKey, workspaceRootLabel } from '../../../shared/workspaceRoots';
import { useChordLabel, useKeybinding } from '../keybindings/KeybindingHost';
import { BrandLoading } from '../components/BrandLoader';
import { IconPanelToggle, IconSearch, IconFile, IconRefresh } from '../components/icons';
import {
  clampSplitRatio,
  FILES_SPLIT_RATIO_DEFAULT
} from '../../../shared/workspaceUiPersist';

export type FilesPanelHandle = {
  flush: () => Promise<void>;
  openPath: (target: string | WorkspaceFileRef, line?: number, source?: 'preview' | 'keep', replacePreview?: boolean, scope?: RightOpenScope, ownerSessionId?: string) => Promise<boolean>;
  /** 工作区外绝对路径：只读预览 */
  openExternal: (absPath: string, line?: number) => Promise<void>;
  /** 当前打开的文件（无打开文件/目录视图时 null）；面板历史 file 轴回放用 */
  getOpenFile: () => { path: string; external: boolean; fileRef?: WorkspaceFileRef } | null;
};

function workspaceFileKeyOrNull(ref?: WorkspaceFileRef | null): string | null {
  return ref ? JSON.stringify([ref.workspaceId, workspaceFileKey(ref)]) : null;
}

export const FilesPanel = forwardRef<
  FilesPanelHandle,
  {
    active: boolean;
    sideTab: SideToolsTab;
    onSideTab: (tab: SideToolsTab) => void;
    onDropOnTab?: (tab: SideToolsTab, paths: string[]) => void;
    /** 面板历史：返回/前进（右栈按工作区独立） */
    onBackTab?: () => void;
    canBackTab?: boolean;
    onForwardTab?: () => void;
    canForwardTab?: boolean;
  }
>(function FilesPanel(
  { active, sideTab, onSideTab, onDropOnTab, onBackTab, canBackTab, onForwardTab, canForwardTab },
  ref
) {
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  // Keep the old root revision until its file surface is safely removed after
  // workspace closure; a disappearing workspace must not remount the editor.
  const rootRevisions = useRef(new Map<string, number>());
  for (const workspace of workspaces) rootRevisions.current.set(workspace.id, workspace.rootsRevision ?? 0);
  const { t } = useTranslation();
  const bridge = useRightWorkspace();
  const bridgeRef = useRef(bridge); bridgeRef.current = bridge;
  const tabEditors = useRef(new Map<string, FileEditorHandle>());
  const { openCommandPalette, flashTip } = useUiStore();
  const workspaceId = resolveWorkspaceId(activeWorkspaceId, workspaces);
  const workspace = workspaces.find((w) => w.id === workspaceId);
  const roots = useMemo(() => {
    try { return workspace ? sourceRootsFor(workspace) : []; }
    catch { return []; }
  }, [workspace]);
  const scopeRef = useRef('');
  scopeRef.current = JSON.stringify([workspaceId, workspace?.rootsRevision ?? 0, bridge?.model.sessionId]);
  const openRequestRef = useRef(0);
  const { cfg, ready, patch } = useWorkspaceFile();

  const editorRef = useRef<FileEditorHandle>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openFileRef, setOpenFileRef] = useState<WorkspaceFileRef | null>(null);
  const [openIsDir, setOpenIsDir] = useState(false);
  /** 打开的是工作区外的绝对路径：只读预览（无树定位/编辑/保存） */
  const [openIsExternal, setOpenIsExternal] = useState(false);
  /** 树定位请求（文件/目录皆可）：文件树展开祖先链并滚动到目标行 */
  const [revealTree, setRevealTree] = useState<{
    path: string;
    rootId?: string;
    isDir: boolean;
    nonce: number;
  } | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  /** 当前文件内查找条（Ctrl+F）：只对打开中的文本文件生效 */
  const [findInFileOpen, setFindInFileOpen] = useState(false);
  const [treeOpen, setTreeOpen] = useState(true);
  /** 右侧文件列表共用一次刷新：递增后每棵源根树各自重读 */
  const [fileRefreshNonce, setFileRefreshNonce] = useState(0);
  const [loadingRoots, setLoadingRoots] = useState<ReadonlySet<string>>(() => new Set());
  const onTreeLoading = useCallback((id: string, loading: boolean) => {
    setLoadingRoots((prev) => {
      if (prev.has(id) === loading) return prev;
      const next = new Set(prev);
      if (loading) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const rootOrderRef = useRef<string[]>([]);
  rootOrderRef.current = roots.map((root) => root.id);
  const treeNavRef = useRef(new Map<string, { focusEdge: (edge: 'start' | 'end') => void; clear: () => void }>());
  const registerTreeNav = useCallback((id: string, api: { focusEdge: (edge: 'start' | 'end') => void; clear: () => void } | null) => {
    if (api) treeNavRef.current.set(id, api);
    else treeNavRef.current.delete(id);
  }, []);
  const leaveTree = useCallback((id: string, direction: 'up' | 'down') => {
    const index = rootOrderRef.current.indexOf(id);
    if (index < 0) return false;
    const next = treeNavRef.current.get(rootOrderRef.current[index + (direction === 'down' ? 1 : -1)] ?? '');
    if (!next) return false;
    next.focusEdge(direction === 'down' ? 'start' : 'end');
    return true;
  }, []);
  const claimTree = useCallback((id: string) => {
    for (const [other, api] of treeNavRef.current) if (other !== id) api.clear();
  }, []);

  const flush = useCallback(async () => {
    const current = bridgeRef.current?.current;
    if (current) await tabEditors.current.get(current.id)?.flush();
    await editorRef.current?.flush();
  }, []);

  useEffect(() => {
    openRequestRef.current += 1;
    setOpenPath(null);
    setOpenFileRef(null);
    setOpenIsDir(false);
    setOpenIsExternal(false);
    setRevealTree(null);
    setRevealLine(null);
    setFindInFileOpen(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!ready) return;
    setTreeOpen(cfg.filesTreeOpen !== false);
  }, [ready, cfg.filesTreeOpen]);

  useEffect(() => {
    if (!active) {
      void flush().catch(error => flashTip(String(error instanceof Error ? error.message : error)));
    }
  }, [active, flush, flashTip]);

  useEffect(() => {
    return () => {
      void flush().catch(error => flashTip(String(error instanceof Error ? error.message : error)));
    };
  }, [flush, flashTip]);

  const toggleTree = useCallback(() => {
    setTreeOpen((prev) => {
      const next = !prev;
      void patch({ filesTreeOpen: next });
      return next;
    });
  }, [patch]);

  const dispatchFile = useCallback((content: RightContent, source: 'preview' | 'keep', replacePreview: boolean, scope: RightOpenScope, ownerSessionId?: string, origin?: RightTab['origin']) => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    if (scope === 'session' && ownerSessionId && ownerSessionId !== bridge.model.sessionId) {
      bridge.dispatch({ type: 'openOwned', workspaceId: bridge.model.workspaceId, sessionId: ownerSessionId, content, focus: false, origin });
    } else bridge.dispatch({ type: 'open', content, source, replacePreview, scope, origin });
  }, []);
  const showExternal = useCallback(
    (absPath: string, line?: number, source: 'preview' | 'keep' = 'keep', replacePreview = false, scope: RightOpenScope = 'session', ownerSessionId?: string, origin?: RightTab['origin']) => {
      dispatchFile({ kind: previewKindForPath(absPath) === 'image' ? 'image' : 'file', path: absPath, external: true, line, revealNonce: Date.now() }, source, replacePreview, scope, ownerSessionId, origin);
      setOpenFileRef(null);
      setOpenIsDir(false);
      setOpenIsExternal(true);
      setOpenPath(absPath);
      setRevealLine(line ?? null);
    },
    [dispatchFile]
  );

  /** 历史回放在切区或后续导航后不能再打开旧区外文件。 */
  const openExternal = useCallback(async (absPath: string, line?: number, source: 'preview' | 'keep' = 'keep', replacePreview = false, tabScope: RightOpenScope = 'session', origin?: RightTab['origin']) => {
    const scope = scopeRef.current;
    const request = ++openRequestRef.current;
    try { await flush(); }
    catch (error) { flashTip(String(error instanceof Error ? error.message : error)); return; }
    if (scopeRef.current !== scope || request !== openRequestRef.current) return;
    const preview = source === 'preview' || replacePreview ? bridgeRef.current && rightPreviewFor(bridgeRef.current.model, tabScope) : null;
    if (preview) { try { await tabEditors.current.get(preview.id)?.flush(); } catch (error) { flashTip(String(error)); return; } }
    if (scopeRef.current !== scope || request !== openRequestRef.current) return;
    showExternal(absPath, line, source, replacePreview, tabScope, undefined, origin);
  }, [flush, showExternal, flashTip]);

  const openFile = useCallback(
    async (target: string | WorkspaceFileRef, line?: number, source: 'preview' | 'keep' = 'keep', replacePreview = false, tabScope: RightOpenScope = 'session', ownerSessionId?: string, origin?: RightTab['origin']): Promise<boolean> => {
      const scope = scopeRef.current;
      const request = ++openRequestRef.current;
      try { await flush(); }
      catch (error) { flashTip(String(error instanceof Error ? error.message : error)); return false; }
      if (scopeRef.current !== scope || request !== openRequestRef.current) return false;
      const preview = source === 'preview' || replacePreview ? bridgeRef.current && rightPreviewFor(bridgeRef.current.model, tabScope) : null;
      if (preview) { try { await tabEditors.current.get(preview.id)?.flush(); } catch (error) { flashTip(String(error)); return false; } }
      const resolved = typeof target === 'string' ? await window.api.fs.resolveRef(workspaceId, target) : { ok: true as const, fileRef: target };
      if (scopeRef.current !== scope || request !== openRequestRef.current) return false;
      if (!resolved.ok) {
        // 只有完整区外路径可进入只读通道；相对路径与坏根身份不能改指默认根。
        if (typeof target === 'string' && (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\\\'))) {
          const stats = await window.api.shell.statPaths([target]);
          if (scopeRef.current !== scope || request !== openRequestRef.current) return false;
          if (stats[target]?.exists && stats[target].isFile && isOutsideWorkspaceRootsResult(resolved)) {
            showExternal(target, line, source, replacePreview, tabScope, ownerSessionId, origin);
            return true;
          }
        }
        flashTip(resolved.error);
        return false;
      }
      const fileRef = resolved.fileRef;
      if (fileRef.workspaceId !== workspaceId) { flashTip(t('工作区不存在')); return false; }
      const rel = fileRef.relativePath;
      const st = await window.api.fs.statRef(fileRef);
      if (scopeRef.current !== scope || request !== openRequestRef.current) return false;
      if (st.ok) {
        const isDir = st.isDirectory;
        const content: RightContent = { kind: previewKindForPath(rel) === 'image' ? 'image' : 'file', path: rel, fileRef, directory: isDir, line, revealNonce: Date.now() };
        const model = bridgeRef.current?.model;
        const background = tabScope === 'session' && ownerSessionId && ownerSessionId !== model?.sessionId;
        const existing = model && !background ? findRightTabForOpen(model, content, tabScope) : undefined;
        if (existing) {
          const released = releaseCenterFileDock(existing.id);
          if (!released.ok) { flashTip(released.error); return false; }
        }
        dispatchFile(content, source, replacePreview, tabScope, ownerSessionId, origin);
        setOpenIsDir(isDir);
        setOpenIsExternal(false);
        setOpenPath(rel);
        setOpenFileRef(fileRef);
        setRevealLine(!isDir && line ? line : null);
        if (isDir) setRevealTree({ path: rel, rootId: fileRef.rootId, isDir: true, nonce: Date.now() });
        return true;
      }
      flashTip(st.error ?? t('无法读取文件'));
      return false;
    },
    [flush, workspaceId, showExternal, dispatchFile, flashTip, t]
  );

  /** 编辑器头「定位」按钮：确保树可见并展开定位到当前文件 */
  const revealInTree = useCallback(() => {
    if (!openPath) return;
    setTreeOpen(true);
    setRevealTree({ path: openPath, rootId: openFileRef?.rootId, isDir: openIsDir, nonce: Date.now() });
  }, [openPath, openIsDir, openFileRef]);

  // ---- 面板历史（右栈 file 轴）：打开文件切换入栈（文件树点选/超链接/快开等全部来源）。
  //  只记「被切走的上一个文件」；目录不算文件不入栈；切工作区清空打开态只重置基线不入栈
  //  （(wsId, path) 配对防串栈，同 GitPanel repo 轴） ----
  const { pushRight: pushRightPanelHistory } = usePanelHistory();
  const historyWsId = useHistoryWsId();
  const prevFileNavRef = useRef<{
    wsId: string;
    path: string | null;
    external: boolean;
    fileRef?: WorkspaceFileRef;
    isFile: boolean;
  } | null>(null);
  useEffect(() => {
    if (bridgeRef.current) return;
    const prev = prevFileNavRef.current;
    const isFile = openPath != null && !openIsDir;
    prevFileNavRef.current = {
      wsId: historyWsId,
      path: openPath,
      external: openIsExternal,
      fileRef: openFileRef ?? undefined,
      isFile
    };
    if (!prev || prev.wsId !== historyWsId) return;
    if (prev.path === openPath && prev.external === openIsExternal && workspaceFileKeyOrNull(prev.fileRef) === workspaceFileKeyOrNull(openFileRef)) return;
    if (prev.isFile && prev.path != null) {
      pushRightPanelHistory(historyWsId, {
        kind: 'file',
        path: prev.path,
        external: prev.external,
        fileRef: prev.fileRef
      });
    }
  }, [openPath, openFileRef, openIsDir, openIsExternal, historyWsId, pushRightPanelHistory]);

  useImperativeHandle(
    ref,
    () => ({
      flush,
      openPath: (relativePath, line, source, replacePreview, scope, ownerSessionId) => openFile(relativePath, line, source, replacePreview, scope, ownerSessionId),
      openExternal: (absPath, line) => openExternal(absPath, line),
      getOpenFile: () =>
        openPath != null && !openIsDir ? { path: openPath, external: openIsExternal, fileRef: openFileRef ?? undefined } : null
    }),
    [flush, openFile, openExternal, openPath, openFileRef, openIsDir, openIsExternal]
  );

  useKeybinding(
    'files.find',
    () => {
      if (openPath && !openIsDir && isTextPreviewKind(previewKindForPath(openPath))) {
        if (findInFileOpen) editorRef.current?.focusFindBar();
        else setFindInFileOpen(true);
      } else openCommandPalette('content');
    },
    active && !bridge
  );

  const quickOpenLabel = useChordLabel('files.quickOpen');
  const findInFilesLabel = useChordLabel('files.findInFiles');

  if (bridge) {
    const file = bridge.current?.content.kind === 'file' || bridge.current?.content.kind === 'image' ? bridge.current.content : undefined;
    const resourceActive = active && bridge.model.resources[workspaceId]?.panel === 'files' && !bridge.model.resources[workspaceId]?.collapsed;
    return <>
      {bridge.resourceHosts.files ? createPortal(<div className="right-files-resources">
        <div className="right-resource-heading"><span>{t('文件')}</span><div>
          <button type="button" className="right-icon" title={t('刷新')} aria-label={t('刷新')} onClick={() => setFileRefreshNonce((n) => n + 1)}>
            {loadingRoots.size > 0 ? <BrandLoading size={14} /> : <IconRefresh size={14} />}
          </button>
          <button type="button" className="right-icon" title={t('搜索文件')} aria-label={t('搜索文件')} onClick={() => openCommandPalette('file')}><IconFile size={14}/></button>
          <button type="button" className="right-icon" title={t('所有文件中搜索')} aria-label={t('所有文件中搜索')} onClick={() => openCommandPalette('content')}><IconSearch size={14}/></button>
        </div></div>
        <div className={roots.length > 1 ? 'workspace-file-trees' : 'workspace-file-tree-single'}>
          {roots.map(root => <FileTree key={root.id} workspaceId={workspaceId} rootId={root.id} rootLabel={workspaceRootLabel(root)} showHeader={false} refreshNonce={fileRefreshNonce} onLoadingChange={onTreeLoading} onRegisterNav={roots.length > 1 ? registerTreeNav : undefined} onBoundary={roots.length > 1 ? (direction) => leaveTree(root.id, direction) : undefined} onClaimFocus={roots.length > 1 ? claimTree : undefined} active={resourceActive}
             onOpenFile={(p, external) => void (external ? openExternal(external, undefined, 'preview', false, 'workspace', 'user') : openFile({ workspaceId, rootId: root.id, relativePath: p }, undefined, 'preview', false, 'workspace', undefined, 'user'))}
             onKeepFile={(p, external) => void (external ? openExternal(external, undefined, 'keep', true, 'workspace', 'user') : openFile({ workspaceId, rootId: root.id, relativePath: p }, undefined, 'keep', true, 'workspace', undefined, 'user'))}
            selectedPath={file?.fileRef?.rootId === root.id ? file.path : openFileRef?.rootId === root.id ? openPath : null}
            reveal={revealTree?.rootId === root.id ? revealTree : null}/>) }
          {!roots.length ? <ErrorTip message={workspace?.rootsError ?? t('工作区不存在')} /> : null}
        </div>
      </div>, bridge.resourceHosts.files) : null}
      {bridge.model.tabs.filter(tab => !tab.suspended && (tab.content.kind === 'file' || tab.content.kind === 'image')).map(tab => <WorkspaceFileTab key={`${tab.id}:${rightContentKey(tab.content)}:${rootRevisions.current.get(tab.workspaceId) ?? 0}`} tab={tab} active={active && tab.id === bridge.current?.id} shown={tab.id === bridge.current?.id || bridge.splitPanes?.has(tab.id) === true} onOpen={openFile} register={editor => { if (editor) tabEditors.current.set(tab.id, editor); else tabEditors.current.delete(tab.id); bridge.registerFile(tab.id, editor ? () => editor.flush() : null); }} onReveal={() => {
        if (tab.content.kind !== 'file' && tab.content.kind !== 'image') return;
        bridge.dispatch({ type: 'resources', panel: 'files', collapsed: false });
        setRevealTree({ path: tab.content.path, rootId: tab.content.fileRef?.rootId, isDir: !!tab.content.directory, nonce: Date.now() });
      }}/>) }
    </>;
  }

  const editorCol = (
    <div className="files-panel-editor-col">
      <FileEditor
        ref={editorRef}
        workspaceId={workspaceId}
        rootId={openFileRef?.rootId}
        path={openPath}
        revealLine={revealLine}
        isDirectory={openIsDir}
        isExternal={openIsExternal}
        onOpenFileRef={(ref, line) => void openFile(ref, line)}
        onOpenPath={(p, line) => void openFile(openFileRef && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(p) ? { ...openFileRef, relativePath: p } : p, line)}
        onRevealInTree={revealInTree}
        findBarOpen={findInFileOpen}
        onFindBarClose={() => setFindInFileOpen(false)}
      />
    </div>
  );

  return (
    <div className={`files-panel${active ? ' is-active' : ''}`}>
      <div className="files-panel-toolbar">
        <SideToolsHistoryNav
          onBack={onBackTab}
          canBack={canBackTab}
          onForward={onForwardTab}
          canForward={canForwardTab}
        />
        <button
          type="button"
          className="git-btn ghost tiny"
          title={quickOpenLabel ? t('快速打开 ({{chord}})', { chord: quickOpenLabel }) : t('快速打开')}
          onClick={() => openCommandPalette('file')}
        >
          {t('搜索文件')}
        </button>
        <button
          type="button"
          className="git-btn ghost tiny"
          title={
            findInFilesLabel
              ? t('所有文件中搜索 ({{chord}})', { chord: findInFilesLabel })
              : t('所有文件中搜索')
          }
          onClick={() => openCommandPalette('content')}
        >
          {t('所有文件中搜索')}
        </button>
        <button
          type="button"
          className={`side-list-toggle is-icon${treeOpen ? ' is-open' : ''}`}
          aria-label={treeOpen ? t('关闭文件列表') : t('打开文件列表')}
          title={treeOpen ? t('关闭文件列表') : t('打开文件列表')}
          aria-expanded={treeOpen}
          onClick={toggleTree}
        >
          <IconPanelToggle size={14} placement="top" open={treeOpen} />
        </button>
        <SideToolsSwitcher tab={sideTab} onSelect={onSideTab} onDropOnTab={onDropOnTab} />
      </div>
      <div className={`files-panel-body${treeOpen ? '' : ' tree-collapsed'}`}>
        {treeOpen ? (
          <SplitPane
            axis="row"
            defaultPrimaryRatio={FILES_SPLIT_RATIO_DEFAULT}
            primaryRatio={clampSplitRatio(cfg.filesSplitRatio, FILES_SPLIT_RATIO_DEFAULT)}
            onRatioCommit={(r) => void patch({ filesSplitRatio: r })}
            minPrimary={160}
            minSecondary={240}
            reverse
            className="files-panel-split"
            aria-label={t('调整文件树与编辑器宽度')}
          >
            <div className={roots.length > 1 ? 'workspace-file-trees' : 'workspace-file-tree-single'}>
              {roots.map((root) => <FileTree key={root.id} workspaceId={workspaceId} rootId={root.id}
                rootLabel={workspaceRootLabel(root)} showRootPath={roots.length > 1} active={active}
                onRegisterNav={roots.length > 1 ? registerTreeNav : undefined}
                onBoundary={roots.length > 1 ? (direction) => leaveTree(root.id, direction) : undefined}
                onClaimFocus={roots.length > 1 ? claimTree : undefined}
                onOpenFile={(p, external) => void (external ? openExternal(external) : openFile({ workspaceId, rootId: root.id, relativePath: p }))}
                selectedPath={openFileRef?.rootId === root.id ? openPath : null}
                reveal={revealTree?.rootId === root.id ? revealTree : null}
                onDeleted={(deleted) => {
                  if (openFileRef?.rootId !== root.id || !openPath) return;
                  if (openPath === deleted || openPath.startsWith(`${deleted}/`)) { setOpenPath(null); setOpenFileRef(null); }
                }} />)}
              {!roots.length ? <ErrorTip message={workspace?.rootsError ?? t('工作区不存在')} /> : null}
            </div>
            {editorCol}
          </SplitPane>
        ) : (
          editorCol
        )}
      </div>
    </div>
  );
});

function WorkspaceFileTab({ tab, active, shown, onOpen, register, onReveal }: { tab: RightTab; active: boolean; shown: boolean; onOpen: (target: string | WorkspaceFileRef, line?: number, source?: 'preview' | 'keep', replacePreview?: boolean, scope?: RightOpenScope, ownerSessionId?: string) => Promise<boolean>; register: (editor: FileEditorHandle | null) => void; onReveal: () => void }): React.JSX.Element | null {
  const bridge = useRightWorkspace();
  const { flashTip } = useUiStore();
  const dock = useRightDock();
  const dockKey = centerFileDockKey(tab.id);
  const [moveFailed, setMoveFailed] = useState(false);
  const inCenter = dock.docked.has(dockKey) && !moveFailed, centerShown = inCenter && dock.shown.has(dockKey);
  const visible = inCenter ? centerShown : shown;
  const editorActive = inCenter ? centerShown : active;
  const [find, setFind] = useState(false);
  const editorRef = useRef<FileEditorHandle | null>(null);
  const registerRef = useRef(register); registerRef.current = register;
  const setEditor = useCallback((editor: FileEditorHandle | null) => { editorRef.current = editor; registerRef.current(editor); }, []);
  useKeybinding('files.find', () => { setFind(true); editorRef.current?.focusFindBar(); }, editorActive);
  if (tab.content.kind !== 'file' && tab.content.kind !== 'image') return null;
  const file = tab.content;
  const hosts = !inCenter ? rightToolbarHosts(bridge, tab.id) : undefined;
  return <DockSurface dockKey={dockKey} preserveEmbeddedState onMoveStatus={success => setMoveFailed(!success)} onMoveError={error => flashTip(String(error))}>
    <div className={`right-content-page files-panel xfade${visible ? ' is-shown' : ''}`} aria-hidden={!visible}
    style={inCenter ? undefined : bridge?.splitPanes?.get(tab.id)} data-right-split-tab={inCenter ? undefined : tab.id}
    {...(!visible ? { inert: '' } : {})} data-right-link-scope={tab.scope} data-right-link-workspace={tab.workspaceId} data-right-link-session={tab.sessionId}>
    <ChatLinkOwnerContext.Provider value={{ workspaceId: tab.workspaceId, sessionId: tab.sessionId, scope: tab.scope }}><FileEditor ref={setEditor} active={editorActive} toolbarHost={hosts?.toolbar} locationHost={hosts?.location} compactToolbar={!inCenter} onKeep={() => bridge?.dispatch({ type: 'keep', id: tab.id })} onFind={() => setFind(true)} workspaceId={tab.workspaceId} rootId={file.fileRef?.rootId} path={file.path} revealLine={file.line} revealNonce={file.revealNonce} isDirectory={file.directory} isExternal={file.external}
      onOpenFileRef={(ref, line) => void onOpen(ref, line, 'keep', false, tab.scope, tab.sessionId)}
      onOpenPath={(path, line) => void onOpen(file.fileRef && !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path) ? { ...file.fileRef, relativePath: path } : path, line, 'keep', false, tab.scope, tab.sessionId)}
      onRevealInTree={onReveal} findBarOpen={find} onFindBarClose={() => setFind(false)}/></ChatLinkOwnerContext.Provider>
  </div></DockSurface>;
}
