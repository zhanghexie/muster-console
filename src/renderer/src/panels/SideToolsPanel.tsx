import { BrandLoading } from '../components/BrandLoader';
import React, { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { runtimeSurface, type SessionMeta } from '../../../shared/types';
import { randomUuid } from '../../../shared/randomUuid';
import { IconChat, IconLayout, IconPlus, IconRefresh, IconTerminal, IconWrench } from '../components/icons';
import { runSessionRestart, sessionRestartActions } from '../sessionRestartActions';
import { beginDockReturn, centerFileDockKey, centerFileHostKey, releaseCenterFileDock, RightDockHost, onRightPinRequest, publishRightPins, rightDockKey, rightDockSnapshot, showInCenter } from '../rightDock';
import { isWorkspaceFileClosePending, prepareWorkspaceFiles, registerWorkspaceFileClose } from '../workspaceFileClose';
import { useUiStore, useWorkspaceStore, useSessionStore, useRuntimesStore } from '../store';
import { useWorkspaceFile } from '../hooks/useWorkspaceFile';
import { useKeybinding } from '../keybindings/KeybindingHost';
import { RightWorkspaceContext, rightToolbarHosts, type RightContentToolbarHosts, type RightWorkspaceBridge } from '../rightWorkspace';
import { publishAgentCenterFiles, registerAgentCenterFile, registerAgentCenterFileRead, registerAgentCenterFileRelease, registerAgentRightClose, registerAgentRightFocus, registerAgentRightLayout, registerAgentRightOpen, registerRightPanelState, readRightPanelState, rightLayoutMatches, type AgentRightOpenResult } from '../rightPanelState';
import { readFileEditorStates } from '../fileEditorState';
import { readArchivedRightTabs, serializeArchivedRightTabs, writeArchivedRightTabs } from '../archivedRightTabs';
import type { RightAction } from '../../../shared/rightWorkspace';
import { activeRightTab, initialRightWorkspace, isDockedRightContent, planRightHistory, projectRightTabs, reduceRightWorkspace, rightContentKey, rightResources, rightScope, rightTabAppliesToSession, rightWebHistoryKeys, saveRightWorkspace, visibleRightTabs, RIGHT_UTILITY_TITLES as UTILITY_TITLES, type ResourcePanel, type RightContent, type RightOpenScope, type RightTab, type RightUtilityId, type RightWebReplay } from '../../../shared/rightWorkspace';
import { RightWorkspaceToolbar, RightWorkspaceContentToolbar } from '../components/RightWorkspaceToolbar';
import { BookmarksPanel } from '../components/BookmarksPanel';
import { ErrorTip } from '../components/ErrorTip';
import type { FilesPanelHandle } from './FilesPanel';
import { SplitPane } from '../components/SplitPane';
import { useExtensionWorkbenchNavigation as useWorkbenchNavigation, setExtensionPlacement as setExtensionPlacement } from '../extensionWorkbench';
import { ExtensionTabHost, extensionSurfaceKey } from '../components/ExtensionSurface';
import { usePresence } from '../components/motion';
import { usePaneFullscreen } from '../hooks/usePaneFullscreen';
import type { RightPanelLayoutChange } from '../../../shared/panelState';
import { rightPanelLayoutTabIds, validateRightPanelSplit, type RightPanelSplit } from '../../../shared/rightPanelLayout';
import { panelNavigationCurrent } from '../panelNavigationIdentity';
import { useRightWorkspaceSplit } from '../hooks/useRightWorkspaceSplit';
import { RightWorkspaceSnapPicker, RightWorkspaceSplitControls, type RightSnapSource } from '../components/RightWorkspaceSplitControls';
import { isWebGateway } from '../webGatewayEnvironment';

const FilesPanel = React.lazy(() => import('./FilesPanel').then(m => ({ default: m.FilesPanel })));
const GitPanel = React.lazy(() => import('./GitPanel').then(m => ({ default: m.GitPanel })));
const BrowserPage = React.lazy(() => import('../components/BrowserPage').then(m => ({ default: m.BrowserPage })));
const IndependentDiff = React.lazy(() => import('./IndependentDiff').then(m => ({ default: m.IndependentDiff })));
const TurnReviewPanel = React.lazy(() => import('./TurnReviewPanel').then(m => ({ default: m.TurnReviewPanel })));
interface TabOperation {
  browsers: Set<string>;
  requests: Set<string>;
  extensions: string[];
}

function SideToolsPanelInner({ active, pageVisible = true, gitEverActive, transitioning = false }: { active: boolean; pageVisible?: boolean; gitEverActive: boolean; transitioning?: boolean }): React.JSX.Element {
  const { t } = useTranslation();
  const remote = isWebGateway();
  const { activeWorkspaceId, workspaces } = useWorkspaceStore();
  const { activeId, sessions: allSessions } = useSessionStore();
  const workspace = workspaces.find(w => w.id === (activeWorkspaceId ?? workspaces[0]?.id));
  const workspaceId = workspace?.id ?? '', sessionId = activeId ?? '';
  const navigation = useWorkbenchNavigation(workspaceId);
  const rootScope = JSON.stringify([workspaceId, workspace?.rootsRevision ?? 0]);
  const { cfg, ready, patch, workspaceId: configWorkspaceId } = useWorkspaceFile();
  const { openWorkspaceFile, clearOpenWorkspaceFile, openTurnReview, clearTurnReview, flashTip, requestShowWorkspace } = useUiStore();
  const { runtimes } = useRuntimesStore();
  const [archiveLoad] = useState(readArchivedRightTabs);
  const [model, dispatchModel] = useReducer(reduceRightWorkspace, undefined, () => reduceRightWorkspace(initialRightWorkspace(workspaceId, sessionId), { type: 'restoreArchived', tabs: archiveLoad.tabs }));
  const bookmarkScope = JSON.stringify([workspaceId, workspace?.controlRoot ?? workspace?.path, workspace?.rootsRevision ?? 0]);
  const currentBookmarkScope = useRef(bookmarkScope);
  currentBookmarkScope.current = bookmarkScope;
  const bookmarkLoad = useRef<{ scope: string; ready: boolean; sent: number; applied: number } | null>(null);
  const [bookmarkError, setBookmarkError] = useState<{ scope: string; message: string } | null>(null);
  useEffect(() => {
    if (!workspaceId || workspaceId !== activeWorkspaceId || !ready || configWorkspaceId !== workspaceId) return;
    if (bookmarkLoad.current?.scope === bookmarkScope) return;
    const owner = { scope: bookmarkScope, ready: false, sent: 0, applied: 0 };
    bookmarkLoad.current = owner;
    dispatchModel({ type: 'bookmarkSnapshot', workspaceId });
    setBookmarkError(null);
    const current = () => bookmarkLoad.current === owner && currentBookmarkScope.current === bookmarkScope;
    void Promise.resolve().then(() => {
      if (!window.api.workspaceBookmarks) throw new Error(t('收藏夹尚未就绪'));
      return window.api.workspaceBookmarks.read(workspaceId);
    }).then(result => {
      if (!current()) return;
      if (!result.ok) throw new Error(result.error);
      const { snapshot, cleanupError } = result;
      owner.ready = true;
      dispatchModel({ type: 'bookmarkSnapshot', workspaceId, saved: snapshot });
      if (cleanupError) setBookmarkError({ scope: bookmarkScope, message: t('收藏夹迁移清理失败：{{error}}', { error: cleanupError }) });
    }).catch(error => {
      if (current()) setBookmarkError({ scope: bookmarkScope, message: t('收藏夹读取失败：{{error}}', { error: String(error) }) });
    });
  }, [workspaceId, activeWorkspaceId, ready, configWorkspaceId, bookmarkScope, t]);
  const dispatch = useCallback((action: RightAction): void => {
    if (action.type !== 'bookmarkChange') { dispatchModel(action); return; }
    const owner = bookmarkLoad.current;
    if (action.workspaceId !== workspaceId || currentBookmarkScope.current !== bookmarkScope || owner?.scope !== bookmarkScope || !owner.ready) return;
    const seq = ++owner.sent;
    const current = () => bookmarkLoad.current === owner && currentBookmarkScope.current === bookmarkScope;
    void window.api.workspaceBookmarks.change(workspaceId, action.change).then(result => {
      if (!current() || seq < owner.applied) return;
      if (!result.ok) throw new Error(result.error);
      owner.applied = seq;
      dispatchModel({ type: 'bookmarkSnapshot', workspaceId, saved: result.snapshot });
    }).catch(error => {
      if (current()) setBookmarkError({ scope: bookmarkScope, message: t('收藏夹保存失败：{{error}}', { error: String(error) }) });
    });
  }, [bookmarkScope, workspaceId, t]);
  const operation = useRef<TabOperation | null>(null);
  const [operationBusy, setOperationBusy] = useState(false);
  const lastNavigation = useRef(navigation);
  if (model.workspaceId !== workspaceId || model.sessionId !== sessionId) dispatch({ type: 'scope', workspaceId, sessionId });
  useEffect(() => {
    const previous = lastNavigation.current;
    lastNavigation.current = navigation;
    if (navigation.workspaceId !== workspaceId || !navigation.sourceRootId) return;
    dispatch({ type: 'extensions', contents: navigation.nodes
      .filter(node => node.kind === 'extension' && node.placement === 'tab')
      .map(node => ({ kind: 'extension' as const, nodeId: node.id, title: node.title })),
      available: navigation.nodes.filter(node => node.kind === 'extension').map(node => node.id),
      held: operation.current?.extensions,
      record: previous !== navigation && previous.workspaceId === workspaceId && previous.sourceRootId === navigation.sourceRootId &&
        previous.selectionRevision === navigation.selectionRevision });
  }, [workspaceId, navigation, operationBusy]);
  useEffect(() => {
    if (remote) return;
    void window.api.browser.retainPanelHistory?.(rightWebHistoryKeys(model)).catch(error => flashTip(String(error)));
  }, [model.histories, flashTip, remote]);
  const modelRef = useRef(model); modelRef.current = model;
  const rightSplitRef = useRef<RightPanelSplit | null>(null);
  const panelReadRef = useRef({ ready, configWorkspaceId });
  panelReadRef.current = { ready, configWorkspaceId };
  useEffect(() => registerRightPanelState(() => {
    const current = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== current.workspaceId ||
        !current.hydrated.includes(current.workspaceId)) return null;
    return { workspaceId: current.workspaceId, sessionId: current.sessionId,
      selectedTabId: activeRightTab(current)?.id ?? null, split: structuredClone(rightSplitRef.current),
      tabs: visibleRightTabs(current).map(tab => ({ id: tab.id, pinned: tab.pinned,
        content: structuredClone(tab.content), origin: tab.origin ?? 'unknown', deferredDock: tab.deferredDock === true })),
      editors: readFileEditorStates(current.workspaceId) };
  }), []);
  const scopeIdentity = JSON.stringify([rootScope, sessionId]);
  const scopeEpoch = useRef({ identity: scopeIdentity, epoch: 0 });
  if (scopeEpoch.current.identity !== scopeIdentity) scopeEpoch.current = { identity: scopeIdentity, epoch: scopeEpoch.current.epoch + 1 };
  const requestScopeRef = useRef(''); requestScopeRef.current = JSON.stringify(scopeEpoch.current);
  useEffect(() => registerAgentRightClose((requestedWorkspace, tabId, expectedContent) => {
    // Flush any already queued user pin/selection before taking the snapshot.
    flushSync(() => {});
    const currentModel = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== currentModel.workspaceId ||
        requestedWorkspace !== currentModel.workspaceId || !currentModel.hydrated.includes(requestedWorkspace)) {
      throw new Error('Right panel is unavailable for the requested workspace');
    }
    const tab = visibleRightTabs(currentModel).find(item => item.id === tabId);
    if (!tab) throw new Error('Panel tab not found');
    if (expectedContent !== undefined && JSON.stringify(tab.content) !== expectedContent) throw new Error('Panel tab changed; inspect before retrying');
    if (tab.pinned) throw new Error('Pinned tabs cannot be closed by an agent');
    if (tab.scope === 'workspace' && !isDockedRightContent(tab.content)) throw new Error('Workspace tabs cannot be closed by an agent');
    if ((tab.content.kind === 'session' || tab.content.kind === 'utility') && tab.origin !== 'agent') {
      throw new Error('User-docked views cannot be closed by an agent');
    }
    if (tab.content.kind === 'review' && tab.origin !== 'agent') throw new Error('User-owned reviews cannot be closed by an agent');
    if (tab.content.kind !== 'file' && tab.content.kind !== 'image' && tab.content.kind !== 'git' && tab.content.kind !== 'diff' && tab.content.kind !== 'session' && tab.content.kind !== 'utility' && tab.content.kind !== 'review') {
      throw new Error('Closing this panel content kind is not implemented');
    }
    if (tab.content.kind === 'file' || tab.content.kind === 'image') {
      const target = tab.content;
      if (rightDockSnapshot().docked.has(centerFileDockKey(tab.id))) throw new Error('File is in use in the center');
      if (target.external || !target.fileRef) throw new Error('Closing external file views is not implemented');
      if (readFileEditorStates(requestedWorkspace).some(editor => editor.unsaved && editor.path === target.path &&
          editor.fileRef?.rootId === target.fileRef?.rootId)) throw new Error('Cannot close a file with unsaved changes');
    }
    flushSync(() => dispatch({ type: 'close', ids: [tabId], record: false }));
    if (visibleRightTabs(modelRef.current).some(item => item.id === tabId)) throw new Error('Panel close outcome is unknown; inspect before retrying');
    return { tabId, closed: true };
  }), []);
  useEffect(() => registerAgentRightFocus((requestedWorkspace, tabId, expectedContent) => {
    flushSync(() => {});
    const currentModel = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== currentModel.workspaceId ||
        requestedWorkspace !== currentModel.workspaceId || !currentModel.hydrated.includes(requestedWorkspace)) {
      throw new Error('Right panel is unavailable for the requested workspace');
    }
    const tab = visibleRightTabs(currentModel).find(item => item.id === tabId);
    if (!tab) throw new Error('Panel tab not found');
    if (expectedContent !== undefined && JSON.stringify(tab.content) !== expectedContent) throw new Error('Panel tab changed; inspect before retrying');
    if (activeRightTab(currentModel)?.id !== tabId && readFileEditorStates(requestedWorkspace).some(editor => editor.active && editor.unsaved)) {
      throw new Error('Cannot change the selected tab while the active editor has unsaved changes');
    }
    if ((tab.content.kind === 'file' || tab.content.kind === 'image') && rightDockSnapshot().docked.has(centerFileDockKey(tab.id))) {
      if (readFileEditorStates(requestedWorkspace).some(editor => editor.active && editor.unsaved)) throw new Error('Cannot move a file with unsaved changes');
      const result = releaseCenterFileDock(tab.id);
      if (!result.ok) throw new Error(result.error);
    }
    flushSync(() => dispatch({ type: 'select', id: tabId }));
    if (activeRightTab(modelRef.current)?.id !== tabId) throw new Error('Panel focus outcome is unknown; inspect before retrying');
    return { tabId, selected: true };
  }), []);
  const pendingAgentOpens = useRef(new Set<{ key: string; expected?: string; scope: string; focus: boolean; existing: boolean;
    resolve: (result: AgentRightOpenResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  useEffect(() => registerAgentCenterFile((requestedWorkspace, content) => {
    flushSync(() => {});
    const currentModel = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== currentModel.workspaceId ||
        requestedWorkspace !== currentModel.workspaceId || !currentModel.hydrated.includes(requestedWorkspace)) throw new Error('File surface is unavailable for the requested workspace');
    if (!content.fileRef || content.fileRef.workspaceId !== requestedWorkspace || content.fileRef.relativePath !== content.path || content.external || content.directory) {
      throw new Error('Center file requires a workspace file reference');
    }
    const key = rightContentKey(content);
    const find = () => projectRightTabs(modelRef.current).find(tab => !tab.suspended && rightTabAppliesToSession(tab, currentModel.sessionId) && rightContentKey(tab.content) === key);
    const existing = find();
    if (!existing) flushSync(() => dispatch({ type: 'openCenterOwned', workspaceId: requestedWorkspace, sessionId: currentModel.sessionId, content }));
    const tab = find();
    if (!tab) throw new Error('Center file preparation outcome is unknown; inspect before retrying');
    return { tabId: tab.id, existing: !!existing, centerOnly: tab.centerOnly === true };
  }), []);
  useEffect(() => registerAgentCenterFileRead((requestedWorkspace, tabId) => {
    const currentModel = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== currentModel.workspaceId ||
        requestedWorkspace !== currentModel.workspaceId || !currentModel.hydrated.includes(requestedWorkspace)) throw new Error('File surface is unavailable for the requested workspace');
    const tab = projectRightTabs(currentModel).find(item => item.id === tabId && !item.suspended && rightTabAppliesToSession(item, currentModel.sessionId));
    if (!tab || (tab.content.kind !== 'file' && tab.content.kind !== 'image')) return null;
    return { tabId: tab.id, centerOnly: tab.centerOnly === true, pinned: tab.pinned, content: structuredClone(tab.content) };
  }), []);
  useEffect(() => { publishAgentCenterFiles(); }, [model]);
  useEffect(() => registerAgentCenterFileRelease((requestedWorkspace, tabId, expectedContent) => {
    flushSync(() => {});
    const currentModel = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== currentModel.workspaceId ||
        requestedWorkspace !== currentModel.workspaceId || !currentModel.hydrated.includes(requestedWorkspace)) throw new Error('File surface is unavailable for the requested workspace');
    const tab = projectRightTabs(currentModel).find(item => item.id === tabId && !item.suspended);
    if (!tab || JSON.stringify(tab.content) !== expectedContent) throw new Error('File surface changed; inspect before retrying');
    if (!tab.centerOnly) return { released: false };
    if (tab.pinned || (tab.content.kind !== 'file' && tab.content.kind !== 'image') || !tab.content.fileRef) throw new Error('File surface cannot be released');
    if (rightDockSnapshot().docked.has(`center-file:${tab.id}`)) throw new Error('Cannot release a file while its center host is in use');
    const file = tab.content;
    if (readFileEditorStates(requestedWorkspace).some(editor => editor.path === file.path && editor.fileRef?.rootId === file.fileRef?.rootId && (editor.active || editor.unsaved))) {
      throw new Error('Cannot release an active or unsaved file');
    }
    flushSync(() => dispatch({ type: 'releaseCenterOwned', workspaceId: requestedWorkspace, id: tabId, expectedContent }));
    if (modelRef.current.tabs.some(item => item.id === tabId)) throw new Error('File release outcome is unknown; inspect before retrying');
    return { released: true };
  }), []);
  useEffect(() => registerAgentRightOpen((requestedWorkspace, content, focus) => {
    const currentModel = modelRef.current;
    if (!panelReadRef.current.ready || panelReadRef.current.configWorkspaceId !== currentModel.workspaceId ||
        requestedWorkspace !== currentModel.workspaceId || !currentModel.hydrated.includes(requestedWorkspace)) {
      return Promise.reject(new Error('Right panel is unavailable for the requested workspace'));
    }
    if (content.kind === 'session') {
      const sessionId = content.sessionId;
      const session = sessionsRef.current.find(item => item.id === sessionId && !item.archived && item.workspaceId === requestedWorkspace);
      if (!session) return Promise.reject(new Error('Session is not available in the requested workspace'));
      content = { kind: 'session', sessionId: session.id, title: session.name,
        chat: runtimeSurface(runtimesRef.current.find(runtime => runtime.id === session.runtime)) === 'chat' };
    } else if (content.kind === 'utility') {
      if (!Object.hasOwn(UTILITY_TITLES, content.sel)) return Promise.reject(new Error('Utility is not available'));
      content = { kind: 'utility', sel: content.sel, title: UTILITY_TITLES[content.sel] };
    } else if (content.kind === 'review') {
      if (!content.owner || !['gui', 'dispatch'].includes(content.owner.kind) || !content.owner.id ||
          (content.owner.kind === 'dispatch' && content.owner.id !== requestedWorkspace)) return Promise.reject(new Error('Invalid review owner'));
    } else if (content.kind === 'git' || content.kind === 'diff') {
      if (!content.repoPath) return Promise.reject(new Error('Agent Git open requires a repository path'));
      if (content.kind === 'diff' && (!content.filePath || typeof content.staged !== 'boolean')) return Promise.reject(new Error('Agent diff open requires a file path and stage'));
    } else if (content.kind === 'web') {
      // Trusted main-process presentation; checked against the full tab model below.
    } else if (!content.fileRef || content.fileRef.workspaceId !== requestedWorkspace || content.fileRef.relativePath !== content.path ||
        content.external || content.directory) return Promise.reject(new Error('Agent file open requires a workspace file reference'));
    if (content.kind === 'web') {
      if (!focus || !content.ownerSessionId || !/^https?:/i.test(content.url)) return Promise.reject(new Error('Browser presentation requires an owned HTTP(S) tab and focus'));
      const matches = currentModel.tabs.filter(tab => tab.workspaceId === requestedWorkspace && !tab.suspended && tab.sessionId === content.ownerSessionId &&
        tab.content.kind === 'web' && tab.content.browserId === content.browserId && tab.content.url === content.url);
      if (matches.length !== 1) return Promise.reject(new Error('Owned browser tab is unavailable or changed'));
      if (readFileEditorStates(requestedWorkspace).some(editor => editor.active && editor.unsaved)) return Promise.reject(new Error('Cannot change the selected tab while the active editor has unsaved changes'));
      flushSync(() => dispatch({ type: 'presentWeb', browserId: content.browserId, url: content.url, ownerSessionId: content.ownerSessionId }));
      const shown = visibleRightTabs(modelRef.current).find(tab => tab.id === matches[0].id);
      if (!shown || activeRightTab(modelRef.current)?.id !== shown.id) return Promise.reject(new Error('Browser presentation outcome is unknown'));
      return Promise.resolve({ tabId: shown.id, existing: true, selected: true });
    }
    const key = rightContentKey(content);
    const centerBacked = projectRightTabs(currentModel).find(tab => !tab.suspended && rightTabAppliesToSession(tab, currentModel.sessionId) && rightContentKey(tab.content) === key && rightDockSnapshot().docked.has(centerFileDockKey(tab.id)));
    if (!focus && projectRightTabs(currentModel).some(tab => tab.centerOnly && !tab.suspended && tab.sessionId === currentModel.sessionId && rightContentKey(tab.content) === key)) {
      return Promise.reject(new Error('Content is already open in the center; focus is required to move it'));
    }
    if (!focus && centerBacked) return Promise.reject(new Error('Content is already open in the center; focus is required to move it'));
    const existing = visibleRightTabs(currentModel).find(tab => rightContentKey(tab.content) === key);
    const selected = activeRightTab(currentModel);
    const changedReview = content.kind === 'review' && existing && (existing.content.kind !== 'review' ||
      existing.content.owner.kind !== content.owner.kind || existing.content.owner.id !== content.owner.id ||
      existing.content.messageId !== content.messageId || existing.content.filePath !== content.filePath || existing.content.repoPath !== content.repoPath);
    if (changedReview && (existing.scope === 'workspace' || existing.pinned || existing.origin !== 'agent')) {
      return Promise.reject(new Error('Cannot replace a workspace-scoped, pinned or user-owned review'));
    }
    if (changedReview && !focus && existing.id === selected?.id) return Promise.reject(new Error('Cannot change the visible review in the background'));
    if (focus && selected?.id !== existing?.id && readFileEditorStates(requestedWorkspace).some(editor => editor.active && editor.unsaved)) {
      return Promise.reject(new Error('Cannot change the selected tab while the active editor has unsaved changes'));
    }
    if (focus && centerBacked) {
      if (readFileEditorStates(requestedWorkspace).some(editor => editor.active && editor.unsaved)) return Promise.reject(new Error('Cannot move a file with unsaved changes'));
      const result = releaseCenterFileDock(centerBacked.id);
      if (!result.ok) return Promise.reject(new Error(result.error));
    }
    if (existing && !changedReview && (!focus || existing.id === selected?.id)) {
      return Promise.resolve({ tabId: existing.id, existing: true, selected: selected?.id === existing.id });
    }
    return new Promise<AgentRightOpenResult>((resolve, reject) => {
      const pending = { key, ...(changedReview ? { expected: JSON.stringify(content) } : {}), scope: requestScopeRef.current, focus, existing: !!existing, resolve, reject,
        timer: setTimeout(() => { pendingAgentOpens.current.delete(pending); reject(new Error('Panel open result is unknown; inspect the panel before retrying')); }, 5000) };
      pendingAgentOpens.current.add(pending);
      if (existing && !changedReview) dispatch({ type: 'select', id: existing.id });
      else dispatch({ type: 'openOwned', workspaceId: requestedWorkspace, sessionId: currentModel.sessionId, content, focus, origin: 'agent' });
    });
  }), []);
  useEffect(() => {
    for (const pending of pendingAgentOpens.current) {
      if (pending.scope !== requestScopeRef.current) {
        clearTimeout(pending.timer); pendingAgentOpens.current.delete(pending);
        pending.reject(new Error('Panel open outcome is unknown after the workspace changed'));
        continue;
      }
      const tab = visibleRightTabs(model).find(item => rightContentKey(item.content) === pending.key);
      if (!tab || (pending.expected && JSON.stringify(tab.content) !== pending.expected) || (pending.focus && activeRightTab(model)?.id !== tab.id)) continue;
      clearTimeout(pending.timer); pendingAgentOpens.current.delete(pending);
      pending.resolve({ tabId: tab.id, existing: pending.existing, selected: activeRightTab(model)?.id === tab.id });
    }
  }, [model]);
  useEffect(() => () => {
    for (const pending of pendingAgentOpens.current) {
      clearTimeout(pending.timer); pending.reject(new Error('Panel open outcome is unknown after panel closed'));
    }
    pendingAgentOpens.current.clear();
  }, []);
  const filesRef = useRef<FilesPanelHandle>(null);
  const flushers = useRef(new Map<string, () => Promise<void>>());
  useEffect(() => registerWorkspaceFileClose(async requestedWorkspace => {
    const read = () => modelRef.current.tabs.filter(tab => tab.workspaceId === requestedWorkspace && !tab.suspended &&
      (tab.content.kind === 'file' || tab.content.kind === 'image')).map(tab => ({ id: tab.id,
        identity: JSON.stringify({ content: tab.content, scope: tab.scope, pinned: tab.pinned, centerOnly: tab.centerOnly, sessionId: tab.sessionId }),
        docked: rightDockSnapshot().docked.has(centerFileDockKey(tab.id)) }));
    return prepareWorkspaceFiles({ read, dirty: () => readFileEditorStates(requestedWorkspace).some(editor => editor.unsaved),
      flush: async id => { await flushers.current.get(id)?.(); },
      begin: ids => beginDockReturn(ids.map(id => ({ dockKey: centerFileDockKey(id), hostKey: centerFileHostKey(id) }))),
      remove: () => { flushSync(() => dispatch({ type: 'forgetWorkspaceFiles', workspaceId: requestedWorkspace })); }
    });
  }), []);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [location, setLocation] = useState<HTMLDivElement | null>(null);
  const [gitReveal, setGitReveal] = useState<{ path: string; nonce: number; workspaceId: string } | null>(null);
  const [filesHost, setFilesHost] = useState<HTMLDivElement | null>(null);
  const [gitHost, setGitHost] = useState<HTMLDivElement | null>(null);
  const [browserHost, setBrowserHost] = useState<HTMLDivElement | null>(null);
  const [saveError, setSaveError] = useState<{ workspaceId: string; message: string } | null>(null);
  useEffect(() => { setSaveError(null); }, [workspaceId]);
  const current = activeRightTab(model), tabs = visibleRightTabs(model), resources = rightResources(model);
  const fullscreenRoot = useRef<HTMLDivElement>(null);
  const fullscreenSelection = useRef(false);
  const fullscreen = usePaneFullscreen<string>(JSON.stringify([rootScope, sessionId]), fullscreenRoot,
    id => activeRightTab(modelRef.current)?.id === id && !transitioning);
  const full = fullscreen.target != null;
  const contentActive = active || full, contentVisible = pageVisible || full;
  useLayoutEffect(() => {
    if (!fullscreen.target || fullscreenSelection.current) return;
    if (!current) void fullscreen.exit();
    else if (current.id !== fullscreen.target) void fullscreen.enter(current.id);
  }, [current?.id, fullscreen.target, fullscreen.enter, fullscreen.exit]);
  useEffect(() => window.api.on('browser:escape', event => {
    if (fullscreen.target && current?.content.kind === 'web' && current.content.browserId === event.tabId) void fullscreen.exit();
  }), [fullscreen.target, fullscreen.exit, current]);
  const history = model.histories[rightScope(model)], presence = usePresence(!resources.collapsed);
  const savedRef = useRef(new Map<string, string>());
  const archivedSavedRef = useRef('');
  useEffect(() => {
    if (archiveLoad.error) flashTip(t('归档标签恢复记录不可用：{{error}}', { error: archiveLoad.error }));
  }, [archiveLoad.error, flashTip, t]);
  useEffect(() => {
    if (archiveLoad.error) return;
    const value = serializeArchivedRightTabs(model);
    if (value === archivedSavedRef.current) return;
    try {
      writeArchivedRightTabs(value);
      archivedSavedRef.current = value;
    } catch (error) {
      flashTip(t('归档标签恢复记录不可用：{{error}}', { error: error instanceof Error ? error.message : String(error) }));
    }
  }, [model.tabs, archiveLoad.error, flashTip, t]);
  useEffect(() => {
    if (!ready || configWorkspaceId !== workspaceId || !workspaceId || model.hydrated.includes(workspaceId)) return;
    if (cfg.rightWorkspace) {
      const { bookmarks: _bookmarks, bookmarkDefaultsVersion: _version, ...layout } = cfg.rightWorkspace;
      savedRef.current.set(workspaceId, JSON.stringify(layout));
      dispatchModel({ type: 'hydrate', workspaceId, saved: layout });
    } else dispatchModel({ type: 'hydrate', workspaceId });
  }, [ready, configWorkspaceId, workspaceId, model.hydrated, cfg.rightWorkspace]);
  useEffect(() => {
    if (model.hydrated.includes(workspaceId) && model.bookmarkDefaultsVersion[workspaceId] === 0) flashTip(t('默认收藏未添加：收藏夹层级或数量超过上限'));
  }, [model.hydrated, model.bookmarkDefaultsVersion, workspaceId, flashTip, t]);
  useEffect(() => {
    if (!ready || configWorkspaceId !== workspaceId || !model.hydrated.includes(workspaceId)) return;
    const saved = saveRightWorkspace(model), json = JSON.stringify(saved);
    if (savedRef.current.get(workspaceId) === json) return;
    savedRef.current.set(workspaceId, json);
    void patch({ rightWorkspace: saved }, workspaceId).then(result => {
      if (!result.ok && modelRef.current.workspaceId === workspaceId) {
        savedRef.current.delete(workspaceId);
        if (result.reason !== 'not-ready' && result.reason !== 'stale-owner') setSaveError({ workspaceId, message: t('标签页状态保存失败') });
      }
    }).catch(error => {
      savedRef.current.delete(workspaceId);
      if (modelRef.current.workspaceId === workspaceId) setSaveError({ workspaceId, message: t('保存失败：{{error}}', { error: error instanceof Error ? error.message : String(error) }) });
    });
  }, [model, ready, configWorkspaceId, workspaceId, patch, flashTip, t]);
  const open = useCallback((content: RightContent, source: 'preview' | 'keep' = 'keep', scope: RightOpenScope = 'workspace') => dispatch({ type: 'open', content, source, scope }), []);
  useEffect(() => {
    if (!openTurnReview) return;
    clearTurnReview();
    if (openTurnReview.workspaceId !== workspaceId || openTurnReview.sessionId !== sessionId) return;
    const current = activeRightTab(modelRef.current)?.content;
    const repoPath = current && (current.kind === 'git' || current.kind === 'diff' || current.kind === 'review') ? current.repoPath : undefined;
    open({ ...openTurnReview.content, repoPath }, 'keep', 'session');
  }, [openTurnReview, clearTurnReview, workspaceId, sessionId, open]);
  const registerFile = useCallback((id: string, flush: (() => Promise<void>) | null) => { if (flush) flushers.current.set(id, flush); else flushers.current.delete(id); }, []);
  const startTabOperation = useCallback((affected: RightTab[]): TabOperation => {
    const op = {
      browsers: new Set(affected.flatMap(tab => tab.content.kind === 'web' && tab.content.browserId ? [tab.content.browserId] : [])),
      requests: new Set<string>(),
      extensions: affected.flatMap(tab => tab.content.kind === 'extension' ? [tab.content.nodeId] : [])
    };
    operation.current = op;
    setOperationBusy(true);
    return op;
  }, []);
  const finishTabOperation = useCallback(() => {
    operation.current = null;
    setOperationBusy(false);
  }, []);
  const flushClosingFiles = useCallback(async (closing: RightTab[]) => {
    for (const tab of closing) {
      if (tab.content.kind !== 'file' && tab.content.kind !== 'image') continue;
      if (rightDockSnapshot().docked.has(centerFileDockKey(tab.id))) throw new Error(t('文件正在中栏使用'));
      await flushers.current.get(tab.id)?.();
    }
  }, [t]);
  const closeTabs = useCallback(async (ids: string[]) => {
    if (operation.current) return;
    const before = modelRef.current;
    const closing = visibleRightTabs(before).filter(tab => ids.includes(tab.id));
    if (!closing.length) return;
    const scope = rightScope(before), epoch = requestScopeRef.current;
    const op = startTabOperation(closing);
    const closed: string[] = [];
    try {
      await flushClosingFiles(closing);
      for (const tab of closing) {
        if (requestScopeRef.current !== epoch) break;
        const current = modelRef.current.tabs.find(item => item.id === tab.id && !item.suspended);
        if (!current || rightContentKey(current.content) !== rightContentKey(tab.content)) continue;
        if (current.content.kind === 'extension') await setExtensionPlacement(current.workspaceId, current.content.nodeId, 'center');
        if (current.content.kind === 'web' && current.content.browserId) {
          op.browsers.add(current.content.browserId);
          const result = await window.api.browser.close({ id: current.content.browserId });
          if (!result.ok) throw new Error(t('关闭标签页'));
          // The close acknowledgement also covers a navigation whose last push
          // arrived while this tab was held by the close operation.
          if (result.tab?.panelHistoryKey) {
            const page = result.tab;
            flushSync(() => dispatch({ type: 'web', browserId: page.id, url: page.url, title: page.title, historyKey: page.panelHistoryKey,
              record: page.panelHistoryUserNavigation === true && requestScopeRef.current === epoch && activeRightTab(modelRef.current)?.id === tab.id }));
          }
        }
        closed.push(tab.id);
      }
    } catch (error) {
      flashTip(String(error instanceof Error ? error.message : error));
    } finally {
      if (closed.length) flushSync(() => dispatch({ type: 'close', ids: closed, scope }));
      finishTabOperation();
    }
  }, [finishTabOperation, flashTip, flushClosingFiles, startTabOperation, t]);
  const selectRightTab = useCallback((id: string): boolean => {
    if (operation.current) return false;
    const tab = visibleRightTabs(modelRef.current).find(item => item.id === id);
    if (!tab) return false;
    if (tab.content.kind === 'file' || tab.content.kind === 'image') {
      const released = releaseCenterFileDock(tab.id);
      if (!released.ok) { flashTip(released.error); return false; }
    }
    dispatch({ type: 'select', id });
    return true;
  }, [flashTip]);
  const navigate = useCallback(async (dir: -1 | 1) => {
    if (operation.current) return;
    const initial = planRightHistory(modelRef.current, dir);
    if (!initial) return;
    const op = startTabOperation([...initial.remove, ...initial.insert.map(item => item.tab)]);
    const prepared: RightWebReplay[] = [];
    const created: string[] = [];
    const closed: string[] = [];
    const moved: Array<{ tab: RightTab; previous: 'tab' | 'center' }> = [];
    try {
      await flushClosingFiles(initial.remove);
      const plan = planRightHistory(modelRef.current, dir, initial.scope, initial.command);
      if (!plan) throw new Error(t('标签页状态已变化，请重试'));
      const selected = plan.insert.find(({ tab }) => tab.id === plan.selected)?.tab ?? modelRef.current.tabs.find(tab => tab.id === plan.selected);
      if (selected && (selected.content.kind === 'file' || selected.content.kind === 'image')) {
        const released = releaseCenterFileDock(selected.id);
        if (!released.ok) throw new Error(released.error);
      }
      for (const { tab } of plan.insert) {
        if (tab.content.kind !== 'web') continue;
        const live = plan.remove.find(item => item.id === tab.id);
        if (live?.content.kind === 'web' && live.content.browserId && live.webHistoryKey === tab.webHistoryKey && live.content.url === tab.content.url) continue;
        const requestId = randomUuid();
        op.requests.add(requestId);
        const result = await window.api.browser.replayPanelHistory({ requestId, browserId: tab.content.browserId || undefined,
          historyKey: tab.webHistoryKey, url: tab.content.url, workspaceId: tab.workspaceId, sessionId: tab.sessionId, scope: tab.scope });
        op.browsers.add(result.id);
        if (result.id !== tab.content.browserId) created.push(result.id);
        prepared.push({ tabId: tab.id, browserId: result.id, historyKey: result.panelHistoryKey, title: result.title, url: result.url });
      }
      for (const { tab } of plan.insert) {
        if (tab.content.kind === 'extension' && !plan.remove.some(old => old.id === tab.id)) {
          await setExtensionPlacement(tab.workspaceId, tab.content.nodeId, 'tab');
          moved.push({ tab, previous: 'center' });
        }
      }
      for (const tab of plan.remove) {
        if (tab.content.kind === 'extension' && !plan.insert.some(item => item.tab.id === tab.id)) {
          await setExtensionPlacement(tab.workspaceId, tab.content.nodeId, 'center');
          moved.push({ tab, previous: 'tab' });
        }
      }
      flushSync(() => {});
      if (!planRightHistory(modelRef.current, dir, initial.scope, initial.command)) throw new Error(t('标签页状态已变化，请重试'));
      for (const tab of plan.remove) {
        if (tab.content.kind !== 'web' || !tab.content.browserId) continue;
        const target = plan.insert.find(item => item.tab.id === tab.id)?.tab.content;
        const binding = prepared.find(item => item.tabId === tab.id)?.browserId ?? (target?.kind === 'web' ? target.browserId : undefined);
        if (binding === tab.content.browserId) continue;
        const result = await window.api.browser.close({ id: tab.content.browserId });
        if (!result.ok) throw new Error(t('关闭标签页'));
        closed.push(tab.content.browserId);
      }
      if (!planRightHistory(modelRef.current, dir, initial.scope, initial.command)) throw new Error(t('标签页状态已变化，请重试'));
      flushSync(() => dispatch({ type: 'history', dir, scope: plan.scope, command: plan.command, web: prepared }));
    } catch (error) {
      const cleanup = await Promise.allSettled([
        ...created.map(id => window.api.browser.close({ id })),
        ...moved.reverse().map(({ tab, previous }) => tab.content.kind === 'extension' && setExtensionPlacement(tab.workspaceId, tab.content.nodeId, previous))
      ]);
      if (closed.length || created.length) flushSync(() => dispatch({ type: 'nativeClosed', browserIds: [...closed, ...created] }));
      flashTip([String(error instanceof Error ? error.message : error), ...cleanup.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : [])].join('\n'));
    } finally {
      finishTabOperation();
    }
  }, [finishTabOperation, flashTip, flushClosingFiles, startTabOperation, t]);
  const selectResource = useCallback((panel: ResourcePanel) => dispatch({ type: 'resources', panel }), []);
  useKeybinding('sideTools.files', () => selectResource('files'), active);
  useKeybinding('sideTools.git', () => selectResource('git'), active);
  useKeybinding('sideTools.browser', () => selectResource('browser'), active);

  // ── 固定到右侧：会话 / 内置工具标签由左栏与中栏请求，项目内共享；视图由中栏 DockSurface 移入 ──
  const sessionsRef = useRef(allSessions ?? []); sessionsRef.current = allSessions ?? [];
  const runtimesRef = useRef(runtimes); runtimesRef.current = runtimes;
  /** 只清理「本次运行中见过、后来删除或归档」的会话：会话表初始为空，不能把未加载当成已删除 */
  const seenSessions = useRef(new Set<string>());
  const sessionKey = JSON.stringify((allSessions ?? []).map(s => [s.id, s.name, !!s.archived]));
  const cleanupTasks = useRef(new Set<string>());
  const cleanupFailures = useRef(new Set<string>());
  const cleanupSessionKey = useRef(sessionKey);
  const [cleanupRevision, setCleanupRevision] = useState(0);
  if (cleanupSessionKey.current !== sessionKey) {
    cleanupSessionKey.current = sessionKey;
    cleanupFailures.current.clear();
  }
  useEffect(() => {
    const list = sessionsRef.current, live = list.filter(s => !s.archived);
    const liveIds = new Set(live.map(s => s.id));
    const removed = [...seenSessions.current].filter(id => !liveIds.has(id));
    for (const s of list) if (s.archived && !removed.includes(s.id)) removed.push(s.id);
    seenSessions.current = liveIds;
    dispatch({ type: 'sessions', titles: live.map(s => ({ id: s.id, title: s.name })), removed });
  }, [sessionKey]);
  // Archive keeps only a serializable tab record. Flush file drafts before
  // unmounting and retire browser guests before allowing a fast unarchive.
  useEffect(() => {
    const sessions = new Map(sessionsRef.current.map(session => [session.id, session]));
    for (const tab of model.tabs) {
      if (isWorkspaceFileClosePending(tab.workspaceId)) continue;
      if (tab.scope !== 'session') continue;
      const session = sessions.get(tab.sessionId);
      if (!session) continue; // The initial session list can still be loading.
      if (!session.archived) {
        if (tab.suspended && !cleanupTasks.current.has(tab.id)) dispatch({ type: 'resume', id: tab.id });
        continue;
      }
      const browserId = tab.content.kind === 'web' ? tab.content.browserId : '';
      if ((tab.suspended && !browserId) || cleanupTasks.current.has(tab.id) || cleanupFailures.current.has(tab.id)) continue;
      cleanupTasks.current.add(tab.id);
      void (async () => {
        try {
          if (!tab.suspended) {
            await flushers.current.get(tab.id)?.();
            const latest = modelRef.current.tabs.find(item => item.id === tab.id);
            if (!latest || latest.scope !== 'session') return;
            dispatch({ type: 'suspend', id: tab.id });
          }
          if (browserId) {
            const result = await window.api.browser.close({ id: browserId });
            if (!result.ok) throw new Error(t('关闭标签页'));
            dispatch({ type: 'releaseWeb', id: tab.id, browserId });
          }
        } catch (error) {
          cleanupFailures.current.add(tab.id);
          flashTip(t('归档时关闭标签失败：{{error}}', { error: error instanceof Error ? error.message : String(error) }));
        } finally {
          cleanupTasks.current.delete(tab.id);
          setCleanupRevision(value => value + 1);
        }
      })();
    }
  }, [sessionKey, model.tabs, cleanupRevision, flashTip, t]);
  const sessionContent = useCallback((session: Pick<SessionMeta, 'id' | 'name' | 'runtime'>): RightContent => ({ kind: 'session', sessionId: session.id, title: session.name,
    chat: runtimeSurface(runtimesRef.current.find(runtime => runtime.id === session.runtime)) === 'chat' }), []);
  useEffect(() => onRightPinRequest(({ workspaceId: owner, ref, command }) => {
    if (owner !== modelRef.current.workspaceId) return;
    const tabs = projectRightTabs(modelRef.current);
    if (ref.kind === 'utility' && ref.sel.startsWith('nav:')) {
      const tab = tabs.find(tab => tab.content.kind === 'extension' && tab.content.nodeId === ref.sel.slice(4));
      if (tab) dispatch({ type: 'select', id: tab.id });
      requestShowWorkspace();
      return;
    }
    const session = ref.kind === 'session' ? sessionsRef.current.find(s => s.id === ref.sessionId) : undefined;
    const content: RightContent | null = ref.kind === 'session' ? session ? sessionContent(session) : null
      : { kind: 'utility', sel: ref.sel as RightUtilityId, title: UTILITY_TITLES[ref.sel as RightUtilityId] };
    if (!content) return;
    const existing = tabs.find(tab => rightContentKey(tab.content) === rightContentKey(content));
    if (command === 'unpin') { if (existing) dispatch({ type: 'close', ids: [existing.id] }); return; }
    if (command === 'reveal' && existing) dispatch({ type: 'select', id: existing.id });
    else if (command === 'pin' && existing) {
      dispatch({ type: 'select', id: existing.id });
      if (!existing.pinned) dispatch({ type: 'pin', id: existing.id });
    } else if (command === 'pin') dispatch({ type: 'open', content, origin: 'user' });
    requestShowWorkspace();
  }), [sessionContent, requestShowWorkspace]);
  const dockedTabs = projectRightTabs(model).filter(tab => tab.content.kind === 'session' || tab.content.kind === 'utility');
  const dockedKey = JSON.stringify(dockedTabs.map(tab => [rightContentKey(tab.content), !!tab.deferredDock]));
  useEffect(() => {
    publishRightPins(workspaceId, dockedTabs.filter(tab => !tab.deferredDock).flatMap(tab => {
      const key = tab.content.kind === 'session' ? rightDockKey({ kind: 'session', sessionId: tab.content.sessionId }) : tab.content.kind === 'utility' ? rightDockKey({ kind: 'utility', sel: tab.content.sel }) : null;
      return key ? [key] : [];
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, dockedKey]);
  useKeybinding('sideTools.back', () => navigate(-1), active);
  useKeybinding('sideTools.forward', () => navigate(1), active);
  useEffect(() => {
    if (!openWorkspaceFile) return;
    const request = openWorkspaceFile, scope = requestScopeRef.current;
    clearOpenWorkspaceFile();
    void (async () => {
      for (let i = 0; i < 40 && !filesRef.current; i++) await new Promise(resolve => window.setTimeout(resolve, 50));
      if (requestScopeRef.current !== scope) return;
      if (!filesRef.current) throw new Error(t('文件面板尚未就绪'));
      await filesRef.current.openPath(request.fileRef ?? request.path, request.line, request.source ?? 'keep', request.replacePreview, request.scope, request.ownerSessionId);
    })().catch(error => flashTip(String(error)));
  }, [openWorkspaceFile, clearOpenWorkspaceFile, flashTip, gitEverActive, t]);
  const split = useRightWorkspaceSplit(scopeIdentity, tabs, current?.id, full, selectRightTab);
  rightSplitRef.current = split.snapshot;
  const paneStyles = split.styles;
  const splitBody = useRef<HTMLDivElement>(null);
  const [snapSource, setSnapSource] = useState<(RightSnapSource & { scope: string }) | null>(null);
  const dismissSnap = useCallback(() => setSnapSource(null), []);
  const snap = !full && !transitioning && !operationBusy && snapSource?.scope === scopeIdentity &&
    tabs.some(tab => tab.id === snapSource.id) ? snapSource : null;
  useLayoutEffect(dismissSnap, [dismissSnap, scopeIdentity, full, transitioning, operationBusy]);
  const applyLayoutRef = useRef<(owner: string, change: RightPanelLayoutChange) => void>(() => {});
  applyLayoutRef.current = (owner, change) => {
    if (transitioning || full || operation.current || snap || splitBody.current?.hasAttribute('data-snap-resizing')) {
      throw new Error('Right panel is busy or fullscreen');
    }
    const snapshot = readRightPanelState(owner);
    if (!rightLayoutMatches(snapshot, change, change.expected)) throw new Error('Right split or tab identity changed; inspect before retrying');
    const target = change.next.selectedTabId;
    if (!target || change.next.split && !change.next.split.tabIds.includes(target)) throw new Error('Invalid right split focus');
    if (change.next.split) validateRightPanelSplit(change.next.split);
    const involved = snapshot.tabs.filter(tab => change.tabs.some(binding => binding.id === tab.id));
    const extensions = involved.flatMap(({ content }) => content.kind === 'extension'
      ? [{ kind: 'utility' as const, sel: `nav:${content.nodeId}` }] : []);
    if (!panelNavigationCurrent(owner, extensions, change.navigation, navigation)) throw new Error('Right split extension changed');
    const shownIds = new Set(rightPanelLayoutTabIds(change.next));
    const hiddenFiles = involved.flatMap(tab => {
      const content = tab.content;
      if (content.kind !== 'file' && content.kind !== 'image') return [];
      if (shownIds.has(tab.id)) {
        if (rightDockSnapshot().docked.has(centerFileDockKey(tab.id))) throw new Error('File is in use in the center');
        return [];
      }
      return [content];
    });
    if (snapshot.editors.some(editor => editor.unsaved && (editor.active || hiddenFiles.some(content =>
      editor.path === content.path && editor.fileRef?.rootId === content.fileRef?.rootId)))) {
      throw new Error('Cannot change the right split while an affected editor has unsaved changes');
    }
    flushSync(() => {
      if (snapshot.selectedTabId !== target) dispatch({ type: 'select', id: target });
      split.apply(change.next);
    });
    if (!rightLayoutMatches(readRightPanelState(owner), change, change.next)) {
      throw new Error('Right split outcome is unknown; inspect before retrying');
    }
  };
  useEffect(() => registerAgentRightLayout((owner, change) => {
    flushSync(() => {});
    applyLayoutRef.current(owner, change);
  }), []);
  const shown = (id: string) => current?.id === id || !!paneStyles?.has(id);
  const isWebVisible = tabs.some(tab => tab.content.kind === 'web' && shown(tab.id));
  useLayoutEffect(() => {
    const body = splitBody.current;
    if (!body || !split.visible || !contentActive) return;
    // Docked content and toolbar portals have separate React owners. Listen
    // on the physical pane host so both select the pane they are displayed in.
    const focusPane = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('.right-pane-close')) return;
      const pane = target.closest<HTMLElement>('[data-right-split-tab]');
      if (!pane || pane.getAttribute('aria-hidden') === 'true') return;
      const id = pane.dataset.rightSplitTab;
      if (id && id !== activeRightTab(modelRef.current)?.id) selectRightTab(id);
    };
    body.addEventListener('pointerdown', focusPane, true);
    body.addEventListener('focusin', focusPane, true);
    return () => {
      body.removeEventListener('pointerdown', focusPane, true);
      body.removeEventListener('focusin', focusPane, true);
    };
  }, [split.visible, contentActive, selectRightTab]);
  const paneProps = (id: string) => ({
    style: paneStyles?.get(id),
    'data-right-split-tab': id,
    'aria-hidden': !shown(id),
    ...(!shown(id) ? { inert: '' } : {})
  });
  const [splitToolbars, setSplitToolbars] = useState(() => new Map<string, RightContentToolbarHosts>());
  const registerSplitToolbar = useCallback((id: string, region: keyof RightContentToolbarHosts, node: HTMLElement | null) => {
    setSplitToolbars(previous => {
      const hosts = previous.get(id) ?? { toolbar: null, location: null };
      if (hosts[region] === node) return previous;
      const next = new Map(previous);
      const updated = { ...hosts, [region]: node };
      if (updated.toolbar || updated.location) next.set(id, updated);
      else next.delete(id);
      return next;
    });
  }, []);
  const bridge = useMemo<RightWorkspaceBridge>(() => ({
    model, current, splitPanes: paneStyles, splitToolbars, toolbar, location, resourceHosts: { files: filesHost, git: gitHost, browser: browserHost }, open, dispatch, registerFile,
    browserTransaction: { busy: operationBusy, manages: (id, request) => !!operation.current &&
      (operation.current.browsers.has(id) || (!!request && operation.current.requests.has(request))) }
  }), [model, current, paneStyles, splitToolbars, toolbar, location, filesHost, gitHost, browserHost, open, registerFile, operationBusy]);
  const web = current?.content.kind === 'web';
  const dockedChrome = dockedTabs.filter(tab => shown(tab.id)).map(tab => {
    const docked = tab.content;
    if (docked.kind !== 'session' && docked.kind !== 'utility') return null;
    const session = docked.kind === 'session' ? (allSessions ?? []).find(item => item.id === docked.sessionId) : undefined;
    const hosts = rightToolbarHosts(bridge, tab.id);
    return <React.Fragment key={tab.id}>
    {hosts?.location ? createPortal(<div className="right-git-location">
      {docked.kind === 'utility' ? <IconWrench size={14}/> : docked.chat ? <IconChat size={14}/> : <IconTerminal size={14}/>}
      <span className="right-full-path" title={session?.cwd}>{docked.kind === 'utility' ? t(docked.title) : session?.cwd ?? docked.title}</span>
      {session?.status === 'exited' ? <span className="right-file-status">{t('已退出')}</span> : null}
    </div>, hosts.location) : null}
    {hosts?.toolbar ? createPortal(<>
      {session && (session.status === 'idle' || session.status === 'exited') &&
        docked.kind === 'session' && !docked.chat ? sessionRestartActions(session, runtimes, t).map(action => (
          <button key={action.id} type="button" className="right-icon" title={action.label} aria-label={action.label}
            onClick={() => void runSessionRestart(session.id, action.id).catch(error => flashTip(String(error)))}>
            {action.id === 'new-conversation' ? <IconPlus size={14}/> : <IconRefresh size={14}/>}
          </button>
        )) : null}
      <button type="button" className="right-icon" title={t('移回中栏')} aria-label={t('移回中栏')} onClick={() => {
        dispatch({ type: 'close', ids: [tab.id] });
        void showInCenter(docked.kind === 'session' ? { kind: 'session', sessionId: docked.sessionId } : { kind: 'utility', sel: docked.sel }).catch(error => flashTip(String(error)));
      }}><IconLayout size={14}/></button>
    </>, hosts.toolbar) : null}
  </React.Fragment>;
  });
  const content = <div className="right-workspace-main" {...(operationBusy ? { inert: '' } : {})}>
    {!split.visible && current?.content.kind !== 'extension' && <RightWorkspaceContentToolbar toolbarRef={setToolbar} locationRef={setLocation}/>}
    <div ref={splitBody} className={`right-workspace-content${split.visible ? ' is-split' : ''}`}>
    {gitEverActive ? <Suspense fallback={<div className="right-empty"><BrandLoading>{t('加载中…')}</BrandLoading></div>}>
      <FilesPanel ref={filesRef} active={contentActive} sideTab={resources.panel} onSideTab={selectResource}/>
      {projectRightTabs(model).filter(tab => !tab.suspended && (tab.content.kind === 'git' || tab.content.kind === 'diff' || tab.content.kind === 'review')).map(tab => {
        // Git and review descendants keep their original tab-specific toolbar
        // contract while the shared tab model remains authoritative.
        const hosts = rightToolbarHosts(bridge, tab.id);
        const tabBridge = split.visible && hosts ? { ...bridge, ...hosts, current: tab } : bridge;
        return <div key={`${rootScope}:${tab.id}`} className={`right-content-page xfade${shown(tab.id) ? ' is-shown' : ''}`} {...paneProps(tab.id)}>
        <RightWorkspaceContext.Provider value={tabBridge}>{tab.content.kind === 'git' ? <GitPanel active={current?.id === tab.id && contentActive} layout="content" tabId={tab.id} fixedRepoPath={tab.content.repoPath} revealAbs={current?.id === tab.id && gitReveal?.workspaceId === workspaceId ? gitReveal : null}/> : tab.content.kind === 'diff' ? <IndependentDiff content={tab.content} active={current?.id === tab.id && contentActive}/> : tab.content.kind === 'review' ? <TurnReviewPanel content={tab.content} active={current?.id === tab.id && contentActive}/> : null}</RightWorkspaceContext.Provider>
        </div>;
      })}
    </Suspense> : null}
    {dockedTabs.map(tab => {
      const content = tab.content as Extract<RightContent, { kind: 'session' | 'utility' }>;
      const dockKey = rightDockKey(content.kind === 'session' ? { kind: 'session', sessionId: content.sessionId } : { kind: 'utility', sel: content.sel })!;
      const missing = content.kind === 'session' && !(allSessions ?? []).some(s => s.id === content.sessionId);
      return <div key={tab.id} className={`right-content-page right-dock-page xfade${shown(tab.id) ? ' is-shown' : ''}`} {...paneProps(tab.id)}>
        {!tab.deferredDock ? <RightDockHost dockKey={dockKey} hostKey={tab.id} shown={contentVisible && shown(tab.id)}/> : null}
        {missing ? <div className="right-empty"><span>{t('会话不存在或尚未加载')}</span></div> : null}
      </div>;
    })}
    {dockedChrome}
    <div className={`right-content-page right-browser-stack xfade${isWebVisible ? ' is-shown' : ''}`} aria-hidden={!isWebVisible}>
      {remote ? (isWebVisible && <div className="right-empty"><span>{t('内置浏览器仅在 Muster 桌面应用中可用。请在桌面应用中继续此操作。')}</span></div>)
        : <Suspense fallback={null}><BrowserPage active={contentActive && web} workspaceActive={contentActive} shown={contentVisible && isWebVisible} sideTab={resources.panel} onSideTab={selectResource}/></Suspense>}
    </div>
    {projectRightTabs(model).filter(tab => tab.content.kind === 'extension').map(tab => tab.content.kind === 'extension' && <div key={tab.id} className={`right-content-page xfade${shown(tab.id) ? ' is-shown' : ''}`} {...paneProps(tab.id)}>
      <ExtensionTabHost surfaceKey={extensionSurfaceKey(workspaceId, tab.content.nodeId)} peek={contentVisible && !contentActive && shown(tab.id)}/>
    </div>)}
    <RightWorkspaceSplitControls split={split} tabs={tabs} selected={current?.id} container={splitBody}
      busy={transitioning || operationBusy} dragSource={snap} registerToolbar={registerSplitToolbar}/>
    {!current ? <div className="right-empty"><span>{t('打开文件、仓库或网页开始查看')}</span><span className="right-empty-hint">{t('单击文件临时预览，双击保留；聊天结果会打开新标签。')}</span></div> : null}
    </div>
  </div>;
  return <RightWorkspaceContext.Provider value={bridge}><div ref={fullscreenRoot} className={`side-tools-panel right-workspace${contentActive ? ' is-active' : ''}${full ? ' is-tab-fullscreen' : ''}`} aria-busy={operationBusy}>
    <ErrorTip message={saveError?.workspaceId === workspaceId ? saveError.message : null} />
    <ErrorTip message={bookmarkError?.scope === bookmarkScope ? bookmarkError.message : null} />
    <RightWorkspaceToolbar transitioning={transitioning} tabs={tabs} current={current} panel={resources.panel} collapsed={resources.collapsed} backDepth={history?.index ?? 0} forwardDepth={history ? history.entries.length - history.index : 0} historyBusy={operationBusy} onHistory={dir => void navigate(dir)} onSelect={selectRightTab} onClose={ids => void closeTabs(ids)} onMove={(id, before) => dispatch({ type: 'move', id, before })} onResource={selectResource} onCollapse={() => dispatch({ type: 'resources', collapsed: !resources.collapsed })} onDropPaths={(panel, paths) => {
      selectResource(panel); const scope = requestScopeRef.current;
      void (async () => {
        if (panel === 'git') { setGitReveal({ path: paths[0]!, nonce: Date.now(), workspaceId }); return; }
        for (const path of paths) {
          if (requestScopeRef.current !== scope) return;
          if (panel === 'files') await filesRef.current?.openPath(path, undefined, 'keep', false, 'workspace');
          else {
            const normalized = path.replace(/\\/g, '/');
            const prefix = normalized.startsWith('//') ? 'file:' : normalized.startsWith('/') ? 'file://' : 'file:///';
            const url = `${prefix}${normalized.split('/').map(encodeURIComponent).join('/')}`.replace(/^file:\/\/\/([a-z])%3A/i, 'file:///$1:');
            await window.api.browser.open({ url, workspaceId, sessionId, scope: 'workspace' });
          }
        }
      })().catch(error => flashTip(String(error)));
    }} onSplit={id => setSnapSource(value => value?.id === id && value.scope === scopeIdentity ? null : { id, scope: scopeIdentity })}
      onSplitDrag={id => setSnapSource(id ? { id, scope: scopeIdentity, dragging: true } : null)}
      splitOpen={split.visible} onUnsplit={split.clear} fullscreenId={fullscreen.target} onFullscreen={id => {
      if (fullscreen.target === id) { void fullscreen.exit(); return; }
      if (operationBusy || transitioning || !tabs.some(tab => tab.id === id)) return;
      fullscreenSelection.current = true;
      try {
        flushSync(() => selectRightTab(id));
        if (activeRightTab(modelRef.current)?.id === id) void fullscreen.enter(id);
      } finally { fullscreenSelection.current = false; }
    }} onAction={(action, id) => { if (id) dispatch({ type: action, id }); }}/>
    <SplitPane axis="row" reverse dividerSize={4} overlayDivider={isWebVisible}
      defaultPrimaryRatio={0.24} primaryRatio={cfg.filesSplitRatio ?? 0.24} onRatioCommit={ratio => void patch({ filesSplitRatio: ratio }, workspaceId)}
      minPrimary={160} minSecondary={360} className={`right-workspace-split${resources.collapsed ? ' resources-collapsed' : ''}`} aria-label={t('调整资源面板宽度')}>
      <div className="right-resources mp-panel" data-mp-stage={presence.stage} aria-hidden={resources.collapsed} {...(operationBusy ? { inert: '' } : {})}>
        <div ref={setFilesHost} className={`right-resource-page xfade${resources.panel === 'files' ? ' is-shown' : ''}`} aria-hidden={resources.panel !== 'files'}/>
        <div ref={setGitHost} className={`right-resource-page xfade${resources.panel === 'git' ? ' is-shown' : ''}`} aria-hidden={resources.panel !== 'git'}/>
        <div ref={setBrowserHost} className={`right-resource-page xfade${resources.panel === 'browser' ? ' is-shown' : ''}`} aria-hidden={resources.panel !== 'browser'}/>
        {gitEverActive ? <Suspense fallback={null}><GitPanel key={rootScope} active={active && resources.panel === 'git' && !resources.collapsed} layout="resources" revealAbs={gitReveal?.workspaceId === workspaceId ? gitReveal : null}/></Suspense> : null}
        <BookmarksPanel/>
      </div>
      {content}
    </SplitPane>
    <RightWorkspaceSnapPicker split={split} tabs={tabs} source={snap} container={splitBody} dismiss={dismissSnap}
      restoreFocus={() => fullscreenRoot.current?.querySelector<HTMLButtonElement>('[data-right-snap-trigger]')?.focus()}/>
  </div></RightWorkspaceContext.Provider>;
}
export const SideToolsPanel = React.memo(SideToolsPanelInner);
