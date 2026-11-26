import { ErrorTip } from '../../components/ErrorTip';
import type { ContextMenuPoint } from '../../components/ContextMenu';
/**
 * GitPanel 主组件（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * 状态经 useGitPrefs / useRepoTree / useGitRepoData / useGitActions / useGitAdoptComments /
 * useGitRepoSetup 分层；导航与浮层副作用集中在 useGitPanelEffects。hook 调用顺序对齐原
 * effect 声明顺序（初次拉取 → 选中仓 → diff 随数据层按原相对顺序排列）。
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRightWorkspace } from '../../rightWorkspace';
import { useTranslation } from 'react-i18next';
import { resolveWorkspaceId } from '../../../../shared/workspaceFallback';
import { sourceRootsFor } from '../../../../shared/workspaceRoots';
import { pathKey } from '../../../../shared/pathKey';
import { sessionWorktreeReviewRepos } from '../../../../shared/sessionWorktreeReview';
import { clampSplitRatio, GIT_REPO_SPLIT_RATIO_DEFAULT } from '../../../../shared/workspaceUiPersist';
import { repoMatchesSearchQuery } from '../../../../shared/gitRepoSearch';
import { useWorkspaceStore, useSessionStore } from '../../store';
import { useHistoryWsId } from '../../panelHistory';
import { useWorkspaceFile, type WorkspaceFilePatchOutcome } from '../../hooks/useWorkspaceFile';
import type { WorkspaceFileConfig } from '../../../../shared/metaAgent';
import { SplitPane } from '../../components/SplitPane';
import type { SideToolsTab } from '../../components/SideToolsSwitcher';
import type { DetailTab, RepoSort } from './gitPanelPure';
import { useGitPrefs } from './useGitPrefs';
import { useRepoTree } from './useRepoTree';
import { useGitRepoData } from './useGitRepoData';
import { useGitActions } from './useGitActions';
import { useGitAdoptComments } from './useGitAdoptComments';
import { useGitRepoSetup } from './useGitRepoSetup';
import { useGitPanelEffects } from './useGitPanelEffects';
import { useGitPanelDerived } from './useGitPanelDerived';
import { GitPanelHeader } from './GitPanelHeader';
import { GitNoRepoState } from './GitEmptyStates';
import { DetailPane } from './DetailPane';
import { RepoListPane } from './RepoListPane';
import { GitPanelOverlays } from './GitPanelOverlays';
import { GitDiscoveryNotice } from './GitDiscoveryNotice';
import { GitWorkspaceProvider } from './GitWorkspaceScope';
import { useGitRemote } from './useGitRemote';
import { WorktreeSwitcher } from './WorktreeSwitcher';

/** 供面板历史（SideToolsPanel）回放仓库条目用 */
export type GitPanelHandle = {
  /** 切换选中仓（回放路径：不入栈，抑制由 panelHistory 时间窗吞掉） */
  selectRepo: (path: string) => void;
  /** 当前选中仓绝对路径（无选中 null） */
  getSelectedRepo: () => string | null;
};

const GitPanelBody = forwardRef<
  GitPanelHandle,
  {
    active: boolean;
    layout?: 'content' | 'resources';
    fixedRepoPath?: string;
    tabId?: string;
    sideTab?: SideToolsTab;
    onSideTab?: (tab: SideToolsTab) => void;
    onDropOnTab?: (tab: SideToolsTab, paths: string[]) => void;
    revealAbs?: { path: string; nonce: number } | null;
    /** 面板历史：返回/前进（右栈按工作区独立） */
    onBackTab?: () => void;
    canBackTab?: boolean;
    onForwardTab?: () => void;
    canForwardTab?: boolean;
  }
>(function GitPanelCore(
  {
    active, layout, fixedRepoPath, tabId,
    sideTab,
    onSideTab,
    onDropOnTab,
    revealAbs,
    onBackTab,
    canBackTab,
    onForwardTab,
    canForwardTab
  },
  ref
): React.JSX.Element {
  const { activeWorkspaceId, workspaces, switching } = useWorkspaceStore();
  const { visibleSessions, activeId } = useSessionStore();
  const { t } = useTranslation();
  const bridge = useRightWorkspace();
  const workspaceId = resolveWorkspaceId(activeWorkspaceId, workspaces);
  const workspace = workspaces.find(w => w.id === workspaceId);
  const rootsRevision = workspace?.rootsRevision ?? 0;
  const workspacePath = workspace?.path ?? '';
  const workspaceRoots = useMemo(() => workspace && !workspace.rootsError ? sourceRootsFor(workspace) : [], [workspace]);
  const { cfg, cfgRef, ready: prefsReady, workspaceId: prefsWorkspaceId, patch: patchWorkspaceFile } = useWorkspaceFile();
  const [prefsError, setPrefsError] = useState<string | null>(null);
  const patchScope = useMemo(() => ({ workspaceId, prefsWorkspaceId, prefsReady }), [workspaceId, prefsWorkspaceId, prefsReady]);
  const currentPatchScope = useRef<typeof patchScope | null>(patchScope);
  currentPatchScope.current = patchScope;
  useEffect(() => {
    currentPatchScope.current = patchScope;
    return () => { if (currentPatchScope.current === patchScope) currentPatchScope.current = null; };
  }, [patchScope]);
  const patch = useCallback(async (partial: Partial<WorkspaceFileConfig>): Promise<WorkspaceFilePatchOutcome> => {
    if (!patchScope.prefsReady || !patchScope.workspaceId || patchScope.prefsWorkspaceId !== patchScope.workspaceId) return { ok: false, config: cfgRef.current, reason: 'not-ready' };
    try {
      const result = await patchWorkspaceFile(partial, patchScope.workspaceId);
      if (!result.ok && result.reason !== 'not-ready' && result.reason !== 'stale-owner' && currentPatchScope.current === patchScope) setPrefsError(t('Git 偏好保存失败'));
      return result;
    } catch (error) {
      if (currentPatchScope.current === patchScope) setPrefsError(t('Git 偏好保存失败：{{error}}', { error: error instanceof Error ? error.message : String(error) }));
      return { ok: false, config: cfgRef.current, reason: 'write-failed' };
    }
  }, [patchScope, patchWorkspaceFile, cfgRef, t]);
  const historyWsId = useHistoryWsId();

  // ---------- 面板自有状态（原 GitPanel state 中跨 hook 共享的 busy/error 与 UI 菜单态） ----------
  const [error, setError] = useState<string | null>(null);
  const [localBusy, setBusy] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('work');
  const [branchPopOpen, setBranchPopOpen] = useState(false);
  const [repoQuickOpen, setRepoQuickOpen] = useState(false);
  const [hideBtnMenu, setHideBtnMenu] = useState<ContextMenuPoint | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const sortMenuRef = useRef<HTMLDivElement | null>(null);
  const repoQuickRef = useRef<HTMLDivElement | null>(null);
  /** 提交说明草稿（不放 state：CommitBar 自持，卸载后由此恢复，击键不重渲面板） */
  const commitDraftRef = useRef('');

  // ---------- prefs：selectedPath + 置顶/隐藏/视图/排序的水合与写盘 ----------
  const prefs = useGitPrefs({ ready: prefsReady, gitCfg: cfg.git, cfgRef, patch, historyWsId, fixedRepoPath });
  const contentRepo = bridge?.current?.content.kind === 'git' || bridge?.current?.content.kind === 'diff' ? bridge.current.content.repoPath : undefined;
  useEffect(() => {
    if (layout === 'resources' && contentRepo) prefs.setSelectedPath(contentRepo);
  }, [layout, contentRepo, prefsReady, prefs.setSelectedPath]);

  // ---------- 数据层：列表/status/diff + 初次拉取/选中仓/diff 联动 + fs/焦点刷新 ----------
  const task = visibleSessions.find((s) => s.id === activeId);
  const taskReview = useMemo(() => {
    try { return { paths: sessionWorktreeReviewRepos(task).map(repo => repo.repoPath), error: null }; }
    catch (error) { return { paths: [], error: String(error) }; }
  }, [task]);
  const requestedPaths = [...taskReview.paths, ...fixedRepoPath ? [fixedRepoPath] : [], ...layout === 'resources' && contentRepo ? [contentRepo] : []];
  if (revealAbs?.path) requestedPaths.push(revealAbs.path);
  // refreshList reads the selected/saved path from refs. A selection already in
  // the list must not change its dependencies and query every repository again.
  const data = useGitRepoData({
    active, fixedRepoPath,
    requestedPaths,
    workspaceId,
    workspacePath,
    workspaceRoots,
    rootsRevision,
    defaultRootId: workspace?.defaultRootId ?? workspaceRoots[0]?.id,
    selectedPath: prefs.selectedPath,
    setSelectedPath: prefs.setSelectedPath,
    savedRepoRef: prefs.savedRepoRef,
    patch,
    setError,
    clearSelectedRepo: prefs.clearSelectedRepo,
    setDetailTab,
    prefsAppliedRef: prefs.prefsAppliedRef,
    setBranchPopOpen,
    prefsReady
  });
  const remote = useGitRemote({ scopeKey: JSON.stringify([workspaceId, rootsRevision]),
    repoPath: prefs.selectedPath, active: active && layout !== 'resources', busy: localBusy || branchPopOpen,
    status: data.status, refreshStatus: data.refreshStatus });
  const busy = localBusy || remote.pending;

  // 面板级列表派生（原 hiddenCount / reposAfterHidden / displayedRepos）
  const sourceRepos = useMemo(() => data.repos.filter(repo => !repo.worktree), [data.repos]);
  const worktreeLocations = useMemo(() => data.repos.filter(repo => repo.worktree), [data.repos]);
  const hiddenRepos = useMemo(
    () => sourceRepos.filter(repo => prefs.hiddenKeys.has(pathKey(repo.path))),
    [sourceRepos, prefs.hiddenKeys]
  );
  const hiddenCount = hiddenRepos.length;
  const reposAfterHidden = useMemo(() => {
    if (prefs.hiddenView === 'exclude') {
      return sourceRepos.filter(r => !prefs.hiddenKeys.has(pathKey(r.path)));
    }
    if (prefs.hiddenView === 'only') return hiddenRepos;
    return sourceRepos;
  }, [sourceRepos, hiddenRepos, prefs.hiddenKeys, prefs.hiddenView]);
  const displayedRepos = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return reposAfterHidden;
    return reposAfterHidden.filter((r) => repoMatchesSearchQuery(r, q));
  }, [reposAfterHidden, searchQuery]);

  // ---------- 仓库树交互 ----------
  const hiddenRepoKeys = prefs.hiddenView === 'exclude' ? prefs.hiddenKeys : undefined;
  const treeRepos = useMemo(() => [
    ...displayedRepos,
    ...(hiddenRepoKeys ? hiddenRepos : []),
    ...worktreeLocations
  ], [displayedRepos, hiddenRepoKeys, hiddenRepos, worktreeLocations]);
  const openGit = bridge?.open;
  const selectTreeRepo: React.Dispatch<React.SetStateAction<string | null>> = useCallback(selection => {
    if (!fixedRepoPath || typeof selection !== 'string' || pathKey(selection) === pathKey(fixedRepoPath)) prefs.setSelectedPath(selection);
    if (typeof selection === 'string') openGit?.({ kind: 'git', repoPath: selection });
  }, [fixedRepoPath, openGit, prefs.setSelectedPath]);
  const repoTree = useRepoTree({
    selectedPath: layout === 'resources' && contentRepo ? contentRepo : prefs.selectedPath,
    setSelectedPath: selectTreeRepo,
    repos: treeRepos,
    hiddenRepoKeys,
    workspacePath,
    workspaceRoots,
    repoSort: prefs.repoSort
  });
  const { commitSelectedPath } = repoTree;

  // ---------- 面板级派生量（会话 worktree 徽标 / 文件分区 / 选中仓摘要） ----------
  const {
    activeSessionWorktree,
    unstagedFiles,
    stagedFiles,
    selectedRepoName,
    selectedSummary,
    selectedChange,
    selectedIsWorktree
  } = useGitPanelDerived({
    visibleSessions,
    activeId,
    selectedPath: prefs.selectedPath,
    data
  });

  useImperativeHandle(
    ref,
    () => ({
      selectRepo: (path: string) => commitSelectedPath(path),
      getSelectedRepo: () => prefs.selectedPath
    }),
    [commitSelectedPath, prefs.selectedPath]
  );

  // ---------- 导航与浮层副作用（面板历史入栈 / reveal / 跟随会话 / 菜单关闭） ----------
  useGitPanelEffects({
    selectedPath: prefs.selectedPath,
    prefsAppliedRef: prefs.prefsAppliedRef,
    repoNavBaselineRef: prefs.repoNavBaselineRef,
    historyWsId,
    revealAbs,
    repos: data.repos,
    listLoading: data.listLoading,
    hiddenKeys: prefs.hiddenKeys,
    commitSelectedPath,
    refreshStatus: data.refreshStatus,
    patch,
    setHiddenView: prefs.setHiddenView,
    setRepoListOpen: prefs.setRepoListOpen,
    pendingChangeRelRef: data.pendingChangeRelRef,
    followSessionRepo: !layout && prefs.followSessionRepo,
    followTargetPath: activeSessionWorktree?.path,
    searchOpen,
    searchInputRef,
    sortMenuOpen,
    setSortMenuOpen,
    sortMenuRef,
    repoQuickOpen,
    setRepoQuickOpen,
    repoQuickRef,
    repoListOpen: prefs.repoListOpen
  });

  const changeSort = useCallback(
    (sort: RepoSort) => {
      prefs.setRepoSort(sort);
      setSortMenuOpen(false);
      void patch({ git: { repoSort: sort } });
    },
    [patch, prefs.setRepoSort]
  );

  // ---------- 部分采纳 + diff 评论 + 开 PR ----------
  const adopt = useGitAdoptComments({
    selectedPath: prefs.selectedPath,
    visibleSessions,
    status: data.status,
    busy,
    setBusy,
    setError,
    refreshList: data.refreshList,
    setSelectedPath: prefs.setSelectedPath,
    setDetailTab
  });

  // ---------- 动作层：runAction / commit / stage / unstage / 变更右键菜单 ----------
  const actions = useGitActions({
    selectedPath: prefs.selectedPath,
    busy,
    setBusy,
    setError,
    refreshStatus: data.refreshStatus,
    onSelectFile: data.onSelectFile,
    files: data.status?.files
  });

  const onSearchQuery = useCallback((q: string) => {
    setSearchQuery(q);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchQuery('');
    setSearchOpen(false);
  }, []);

  // ---------- 添加/初始化仓库 ----------
  const setup = useGitRepoSetup({
    setBusy,
    setError,
    refreshList: data.refreshList,
    setSelectedPath: prefs.setSelectedPath
  });

  const showNoRepoState = !data.listLoading && data.repos.length === 0 && !data.discoveryIssueCount && !error && !taskReview.error;
  const worktreeToOpen = worktreeLocations.find(repo => pathKey(repo.path) === pathKey(prefs.selectedPath ?? '')) ?? worktreeLocations[0];

  const repoPane = (
        <RepoListPane
          refreshRepos={() => void data.refreshList(false, true)}
          repoTree={repoTree}
          repos={sourceRepos}
          onOpenWorktreeDetails={worktreeToOpen ? () => commitSelectedPath(worktreeToOpen.path) : undefined}
          discoveryIncomplete={data.discoveryIssueCount > 0 || Boolean(error || taskReview.error)}
          displayedRepos={displayedRepos}
          reposAfterHidden={reposAfterHidden}
          searchOpen={searchOpen}
          searchInputRef={searchInputRef}
          onSearchQuery={onSearchQuery}
          closeSearch={closeSearch}
          setSearchOpen={setSearchOpen}
          searchQuery={searchQuery}
          busy={busy}
          listLoading={data.listLoading}
          hiddenCount={hiddenCount}
          hiddenView={prefs.hiddenView}
          persistHiddenView={prefs.persistHiddenView}
          setHideBtnMenu={setHideBtnMenu}
          sortMenuRef={sortMenuRef}
          sortMenuOpen={sortMenuOpen}
          setSortMenuOpen={setSortMenuOpen}
          repoSort={prefs.repoSort}
          changeSort={changeSort}
          pinnedKeys={prefs.pinnedKeys}
          hiddenKeys={prefs.hiddenKeys}
          togglePin={prefs.togglePin}
          toggleHidden={prefs.toggleHidden}
          hideRepos={prefs.hideRepos}
          setReposPinned={prefs.setReposPinned}
          pathKey={pathKey}
        />
  );
  const detailPane = (
        <DetailPane
          active={active}
          toolbarHost={layout === 'content' && bridge?.current?.id === tabId ? bridge?.toolbar : undefined}
          worktreeSwitcher={prefs.selectedPath && <WorktreeSwitcher key={prefs.selectedPath}
            workspaceId={workspaceId} rootsRevision={rootsRevision} session={task} repoPath={prefs.selectedPath}
            enabled={active && !switching && !bridge?.browserTransaction?.busy} onSelect={commitSelectedPath} onError={setError} />}
          busy={busy}
          detailTab={detailTab}
          setDetailTab={setDetailTab}
          selectedPath={prefs.selectedPath}
          selectedSummary={selectedSummary}
          branchPopOpen={branchPopOpen}
          setBranchPopOpen={setBranchPopOpen}
          refreshStatus={data.refreshStatus}
          refreshList={data.refreshList}
          commitSelectedPath={commitSelectedPath}
          runAction={actions.runAction}
          selectedIsWorktree={selectedIsWorktree}
          unstagedFiles={unstagedFiles}
          stagedFiles={stagedFiles}
          stagePaths={actions.stagePaths}
          unstagePaths={actions.unstagePaths}
          openChangeCtxMenu={actions.openChangeCtxMenu}
          adopt={adopt}
          selectedChange={selectedChange}
          commitDraftRef={commitDraftRef}
          commitWithMessage={actions.commitWithMessage}
          data={data}
          onCheckoutWarning={actions.reportWarning}
          remote={remote}
        />
  );
  const body = (
    <aside className="git-panel">
      {!layout ? <GitPanelHeader
        onBackTab={onBackTab}
        canBackTab={canBackTab}
        onForwardTab={onForwardTab}
        canForwardTab={canForwardTab}
        activeSessionWorktree={activeSessionWorktree}
        commitSelectedPath={commitSelectedPath}
        followSessionRepo={prefs.followSessionRepo}
        toggleFollowSessionRepo={prefs.toggleFollowSessionRepo}
        repoListOpen={prefs.repoListOpen}
        selectedRepoName={selectedRepoName}
        selectedPath={prefs.selectedPath}
        repoQuickOpen={repoQuickOpen}
        setRepoQuickOpen={setRepoQuickOpen}
        repoQuickRef={repoQuickRef}
        displayedRepos={displayedRepos}
        setSelectedPath={prefs.setSelectedPath}
        setRepoListOpen={prefs.setRepoListOpen}
        patch={patch}
        listLoading={data.listLoading}
        busy={busy}
        refreshList={() => void data.refreshList(false, true)}
        toggleRepoList={prefs.toggleRepoList}
        showNoRepoState={showNoRepoState}
        sideTab={sideTab}
        onSideTab={onSideTab}
        onDropOnTab={onDropOnTab}
      /> : null}

      <ErrorTip active={active} message={taskReview.error || error} />
      <ErrorTip active={active} message={prefsError} />
      <ErrorTip active={active} message={actions.actionError} />
      <GitDiscoveryNotice key={`${workspaceId}:${rootsRevision}`} issues={data.discoveryIssues}
        count={data.discoveryIssueCount} roots={workspaceRoots} busy={busy || data.listLoading}
        retry={() => void data.refreshList(false, true)} />

      {showNoRepoState ? (
        <GitNoRepoState
          busy={busy}
          workspacePath={workspacePath}
          runInitRepo={(dirPath) => void setup.runInitRepo(dirPath)}
        />
      ) : (
      <div className={`git-panel-main${prefs.repoListOpen ? '' : ' repo-list-collapsed'}`}>
        {layout === 'resources' ? repoPane : layout === 'content' ? detailPane : <SplitPane
          axis="row"
          className={`git-repo-split${prefs.repoListOpen ? '' : ' is-repo-list-collapsed'}`}
          defaultPrimaryRatio={GIT_REPO_SPLIT_RATIO_DEFAULT}
          primaryRatio={clampSplitRatio(cfg.git?.repoListSplitRatio, GIT_REPO_SPLIT_RATIO_DEFAULT)}
          onRatioCommit={(r) => void patch({ git: { repoListSplitRatio: r } })}
          minPrimary={140}
          minSecondary={200}
          reverse
          aria-label={t('拖动调整仓库树与详情宽度')}
        >
        {repoPane}
        {detailPane}
        </SplitPane>}
      </div>
      )}
      <GitPanelOverlays
        hideBtnMenu={hideBtnMenu}
        setHideBtnMenu={setHideBtnMenu}
        hiddenView={prefs.hiddenView}
        unhideAll={prefs.unhideAll}
        persistHiddenView={prefs.persistHiddenView}
        changeCtxMenu={actions.changeCtxMenu}
        setChangeCtxMenu={actions.setChangeCtxMenu}
        changeCtxItems={actions.changeCtxItems}
        onChangeCtxSelect={actions.onChangeCtxSelect}
        adoptConfirmOpen={adopt.adoptConfirmOpen}
        setAdoptConfirmOpen={adopt.setAdoptConfirmOpen}
        adoptSel={adopt.adoptSel}
        doAdopt={adopt.doAdopt}
        discardConfirm={actions.discardConfirm}
        setDiscardConfirm={actions.setDiscardConfirm}
        selectedPath={prefs.selectedPath}
        runAction={actions.runAction}
      />
    </aside>
  );
  return layout === 'resources' ? bridge?.resourceHosts.git ? createPortal(body, bridge.resourceHosts.git) : <></> : body;
});

export const GitPanelCore = React.memo(forwardRef<GitPanelHandle, React.ComponentPropsWithoutRef<typeof GitPanelBody>>(
  function GitPanelCore(props, ref) {
    const { activeWorkspaceId, workspaces } = useWorkspaceStore();
    const workspaceId = resolveWorkspaceId(activeWorkspaceId, workspaces);
    const workspace = workspaces.find(w => w.id === workspaceId);
    if (!workspace) return <aside className="git-panel" />;
    const rootsRevision = workspace.rootsRevision ?? 0;
    // Dialogs/drafts/pending actions belong to this scope. Dispose them on a root
    // change even when the same physical repository also belongs to the next scope.
    return <GitWorkspaceProvider scope={{ workspaceId, rootsRevision }}>
      <GitPanelBody key={`${workspaceId}:${rootsRevision}`} {...props} ref={ref} />
    </GitWorkspaceProvider>;
  }
));
