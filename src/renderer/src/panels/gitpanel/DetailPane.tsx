import { useScopedGit } from './GitWorkspaceScope';
/**
 * GitPanel 详情区（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * work/history/pr 三视图常驻叠放淡切（.xfade）+ 变更列表/分栏 diff + 提交条 + PrCreateDialog。
 * 无 memo：重渲时机与原整面板渲染保持一致；key 随仓库切换重建的契约保持。
 */
import React from 'react';
import { useRightWorkspace } from '../../rightWorkspace';
import { IconPlus } from '../../components/icons';
import { useTranslation } from 'react-i18next';
import type { GitFileChange, GitRepoSummary } from '../../../../shared/types';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { SplitPane } from '../../components/SplitPane';
import { FileDiffView } from '../FileDiffView';
import { DiffCommentPanel } from '../DiffCommentPanel';
import { AdoptDiffView } from '../AdoptDiffView';
import { PrPanel } from '../PrPanel';
import { PrCreateDialog } from '../PrCreateDialog';
import { GitChangeTree, type GitChangeContextTarget } from '../GitChangeTree';
import { GitHistory } from '../GitHistory';
import { CommitBar } from './CommitBar';
import { BrandLoading } from '../../components/BrandLoader';
import { GitDetailTopBar } from './GitDetailTopBar';
import { isStaged, isUnstaged, stagedBadge, unstagedBadge, type DetailTab } from './gitPanelPure';
import type { GitAdoptCommentsApi } from './useGitAdoptComments';
import type { GitRepoDataApi } from './useGitRepoData';
import { GitRemoteFeedback } from './GitRemoteFeedback';
import type { GitRemoteApi } from './useGitRemote';

export function DetailPane({
  active,
  toolbarHost,
  worktreeSwitcher,
  busy,
  detailTab,
  setDetailTab,
  selectedPath,
  selectedSummary,
  branchPopOpen,
  setBranchPopOpen,
  refreshStatus,
  refreshList,
  commitSelectedPath,
  runAction,
  selectedIsWorktree,
  unstagedFiles,
  stagedFiles,
  stagePaths,
  unstagePaths,
  openChangeCtxMenu,
  adopt,
  selectedChange,
  commitDraftRef,
  commitWithMessage,
  data,
  onCheckoutWarning,
  remote
}: {
  active: boolean;
  toolbarHost?: HTMLElement | null;
  worktreeSwitcher: React.ReactNode;
  busy: boolean;
  detailTab: DetailTab;
  setDetailTab: (tab: DetailTab) => void;
  selectedPath: string | null;
  selectedSummary: GitRepoSummary | null;
  branchPopOpen: boolean;
  setBranchPopOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshStatus: (repoPath: string | null, quiet?: boolean) => Promise<void>;
  refreshList: (quiet?: boolean, forceRescan?: boolean) => Promise<void>;
  commitSelectedPath: (repoPath: string) => void;
  runAction: (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>;
  selectedIsWorktree: boolean;
  unstagedFiles: GitFileChange[];
  stagedFiles: GitFileChange[];
  stagePaths: (paths: string[]) => void;
  unstagePaths: (paths: string[]) => void;
  openChangeCtxMenu: (e: React.MouseEvent, target: GitChangeContextTarget) => void;
  /** 部分采纳 + diff 评论 + 开 PR 的聚合状态与回调（useGitAdoptComments 返回值） */
  adopt: GitAdoptCommentsApi;
  selectedChange: GitFileChange | undefined;
  commitDraftRef: { current: string };
  commitWithMessage: (msg: string) => Promise<boolean>;
  onCheckoutWarning?: (message: string) => void;
  remote: GitRemoteApi;
  /** 数据层切片：status / 选中文件 / diff 文本与加载态 / 文件选中回调 */
  data: Pick<
    GitRepoDataApi,
    | 'status'
    | 'statusLoading'
    | 'statusError'
    | 'statusUpdatedAt'
    | 'selectedFile'
    | 'diffStaged'
    | 'setDiffStaged'
    | 'diffText'
    | 'diffLoading'
    | 'onSelectFile'
  >;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bridge = useRightWorkspace();
  const git = useScopedGit();
  const { status, statusLoading, statusError, statusUpdatedAt, selectedFile, diffStaged, setDiffStaged, diffText, diffLoading, onSelectFile } = data;
  const {
    adoptOpen,
    adoptPreview,
    adoptLoading,
    adoptSel,
    adoptSelIds,
    toggleAdoptHunk,
    toggleAdoptFile,
    toggleAdoptMode,
    setAdoptConfirmOpen,
    commentMode,
    setCommentMode,
    diffComments,
    setDiffComments,
    commentWorker,
    commentSending,
    pickDiffLine,
    sendDiffComments,
    prDetecting,
    openPrFlow,
    prDialogOpen,
    prRepository,
    createdPr,
    setPrDialogOpen,
    onPrCreated
  } = adopt;
  return (
    <div className="git-detail">
      {!selectedPath ? (
        <div className="empty-hint">{t('选择左侧仓库')}</div>
      ) : (
        <>
          <GitDetailTopBar
            toolbarHost={toolbarHost}
            worktreeSwitcher={worktreeSwitcher}
            branchPopOpen={branchPopOpen}
            setBranchPopOpen={setBranchPopOpen}
            status={status}
            selectedSummary={selectedSummary}
            busy={busy}
            selectedPath={selectedPath}
            refreshStatus={refreshStatus}
            refreshList={refreshList}
            commitSelectedPath={commitSelectedPath}
            detailTab={detailTab}
            setDetailTab={setDetailTab}
            runAction={runAction}
            selectedIsWorktree={selectedIsWorktree}
            prDetecting={prDetecting}
            openPrFlow={openPrFlow}
            onCheckoutWarning={onCheckoutWarning}
            remote={remote}
          />

          {statusLoading && !status ? <BrandLoading>{t('正在读取仓库状态…')}</BrandLoading> : null}
          <GitRemoteFeedback remote={remote} repoPath={selectedPath} status={statusError ? null : status} active={active}/>

          {statusError ? <div className="git-status-warning" role="status">
            <span>{status && statusUpdatedAt
              ? t('状态读取失败，显示 {{time}} 的旧数据', { time: new Date(statusUpdatedAt).toLocaleTimeString() })
              : t('无法确认工作区状态')}</span>
            <button type="button" className="git-btn ghost tiny" disabled={statusLoading} onClick={() => void refreshStatus(selectedPath)}>{t('重试')}</button>
          </div> : null}

          {/* 工作↔历史：双视图常驻叠放淡切（.xfade）——work 的分栏与滚动保留、
              history 尊重 active 自闲置；key 随仓库切换重建 */}
          <div className="git-detail-views xfade-stack">
            <div className={`git-detail-pane xfade${detailTab === 'work' ? ' is-shown' : ''}`}>
              <SplitPane
                axis="row"
                className="git-work"
                defaultPrimaryRatio={0.32}
                minPrimary={160}
                minSecondary={200}
                reverse
                aria-label={t('拖动调整变更列表与 Diff 宽度')}
              >
                <SplitPane
                  axis="column"
                  className="git-changes"
                  defaultPrimaryRatio={0.5}
                  minPrimary={80}
                  minSecondary={80}
                  aria-label={t('拖动调整未暂存与已暂存高度')}
                >
                  <div className="git-changes-section">
                    <div className="git-col-title-row">
                      <span className="git-col-title">
                        Changes
                        {unstagedFiles.length ? ` · ${unstagedFiles.length}` : ''}
                      </span>
                      <button
                        type="button"
                        className="git-btn ghost tiny"
                        disabled={busy || !!statusError || unstagedFiles.length === 0}
                        onClick={() =>
                          void runAction(() => git.stageAll(selectedPath))
                        }
                      >
                        Stage All
                      </button>
                    </div>
                    <div className="git-changes-scroll">
                      {statusLoading && !status ? (
                        null
                      ) : !status ? <div className="empty-hint">{t('状态未知')}</div> : unstagedFiles.length === 0 && !statusError ? (
                        <div className="empty-hint">
                          {stagedFiles.length ? t('无未暂存改动') : t('工作区干净')}
                        </div>
                      ) : (
                        <GitChangeTree
                          files={unstagedFiles}
                          zone="unstaged"
                          selectedFile={selectedFile}
                          activeZone={!diffStaged}
                          busy={busy || !!statusError}
                          badgeOf={unstagedBadge}
                          onSelectFile={onSelectFile}
                          onTogglePaths={stagePaths}
                          onContextMenu={openChangeCtxMenu}
                          repoPath={selectedPath}
                        />
                      )}
                    </div>
                  </div>
                  <div className="git-changes-section">
                    <div className="git-col-title-row">
                      <span className="git-col-title">
                        Staged
                        {stagedFiles.length ? ` · ${stagedFiles.length}` : ''}
                      </span>
                      <button
                        type="button"
                        className="git-btn ghost tiny"
                        disabled={busy || !!statusError || stagedFiles.length === 0}
                        onClick={() =>
                          void unstagePaths(stagedFiles.map((f) => f.path))
                        }
                      >
                        Unstage All
                      </button>
                    </div>
                    <div className="git-changes-scroll">
                      {statusLoading && !status ? (
                        null
                      ) : !status ? <div className="empty-hint">{t('状态未知')}</div> : stagedFiles.length === 0 && !statusError ? (
                        <div className="empty-hint">{t('无已暂存文件')}</div>
                      ) : (
                        <GitChangeTree
                          files={stagedFiles}
                          zone="staged"
                          selectedFile={selectedFile}
                          activeZone={diffStaged}
                          busy={busy || !!statusError}
                          badgeOf={stagedBadge}
                          onSelectFile={onSelectFile}
                          onTogglePaths={unstagePaths}
                          onContextMenu={openChangeCtxMenu}
                          repoPath={selectedPath}
                        />
                      )}
                    </div>
                  </div>
                </SplitPane>
                <div className="git-diff-pane">
                  <div className="git-col-title-row">
                    {bridge && selectedFile && !adoptOpen ? <button type="button" className="right-icon" title={t('在新标签中打开 Diff')} aria-label={t('在新标签中打开 Diff')} onClick={() => bridge.open({ kind: 'diff', repoPath: selectedPath, filePath: selectedFile, staged: diffStaged, untracked: selectedChange?.index === '?' || selectedChange?.working_dir === '?' }, 'keep', bridge.current?.scope ?? 'session')}><IconPlus/></button> : null}
                    {adoptOpen ? (
                      <span
                        className="git-col-title"
                        title={adoptPreview?.targetRepo}
                      >
                        {adoptPreview?.base
                          ? t('部分采纳 · 基线 {{sha}}', {
                              sha: adoptPreview.base.slice(0, 7)
                            })
                          : t('部分采纳')}
                      </span>
                    ) : (
                      <span className="git-col-title">
                        Diff{selectedFile ? ` · ${selectedFile}` : ''}
                      </span>
                    )}
                    {adoptOpen ? (
                      <div className="git-diff-toggle">
                        <button
                          type="button"
                          className="git-btn ghost tiny"
                          disabled={busy || adoptLoading || adoptSel.size === 0}
                          onClick={() => setAdoptConfirmOpen(true)}
                        >
                          {t('采纳 {{n}} 个 hunk', { n: adoptSel.size })}
                        </button>
                        <button
                          type="button"
                          className="git-btn ghost tiny"
                          disabled={busy}
                          onClick={toggleAdoptMode}
                        >
                          {t('退出')}
                        </button>
                      </div>
                    ) : (
                      <>
                        {selectedChange &&
                        isStaged(selectedChange) &&
                        isUnstaged(selectedChange) ? (
                          <div className="git-diff-toggle">
                            <button
                              type="button"
                              className={`git-btn ghost tiny${!diffStaged ? ' is-on' : ''}`}
                              onClick={() => setDiffStaged(false)}
                            >
                              {t('工作区')}
                            </button>
                            <button
                              type="button"
                              className={`git-btn ghost tiny${diffStaged ? ' is-on' : ''}`}
                              onClick={() => setDiffStaged(true)}
                            >
                              {t('暂存')}
                            </button>
                          </div>
                        ) : null}
                        {selectedIsWorktree ? (
                          <button
                            type="button"
                            className="git-btn ghost tiny"
                            disabled={busy}
                            title={t('勾选 worktree 改动的部分 hunk，原子应用到主仓（staged 不提交）')}
                            onClick={toggleAdoptMode}
                          >
                            {t('部分采纳')}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`git-btn ghost tiny${commentMode ? ' is-on' : ''}`}
                          disabled={busy || !selectedFile}
                          title={t('点击 diff 行添加评论')}
                          onClick={() => setCommentMode((v) => !v)}
                        >
                          {commentMode ? t('退出评论') : t('评论模式')}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="git-diff-scroll">
                    {adoptOpen ? (
                      <AdoptDiffView
                        diffText={adoptPreview?.diff ?? ''}
                        loading={adoptLoading}
                        selectedIds={adoptSelIds}
                        onToggleHunk={toggleAdoptHunk}
                        onToggleFile={toggleAdoptFile}
                      />
                    ) : selectedFile ? (
                      <FileDiffView
                        diffText={diffText}
                        loading={diffLoading}
                        commentMode={commentMode}
                        onPickLine={pickDiffLine}
                      />
                    ) : (
                      <div className="empty-hint">{t('选择文件查看 Diff')}</div>
                    )}
                  </div>
                  {!adoptOpen && commentMode ? (
                    <DiffCommentPanel
                      comments={diffComments}
                      workerName={commentWorker?.name ?? commentWorker?.id ?? null}
                      sending={commentSending}
                      onChangeBody={(id, body) =>
                        setDiffComments((prev) =>
                          prev.map((c) => (c.id === id && c.status === 'draft' ? { ...c, body } : c))
                        )
                      }
                      onRemove={(id) => setDiffComments((prev) => prev.filter((c) => c.id !== id))}
                      onSend={sendDiffComments}
                    />
                  ) : null}
                </div>
              </SplitPane>

              <CommitBar busy={busy || !status || !!statusError} draftRef={commitDraftRef} onCommit={commitWithMessage} />
            </div>
            <div className={`git-detail-pane xfade${detailTab === 'history' ? ' is-shown' : ''}`}>
              <ErrorBoundary label={t('Git 历史')}>
                <GitHistory
                  key={selectedPath}
                  repoPath={selectedPath}
                  currentBranch={status?.branch}
                  active={active && detailTab === 'history'}
                />
              </ErrorBoundary>
            </div>
            <div className={`git-detail-pane xfade${detailTab === 'pr' ? ' is-shown' : ''}`}>
              <ErrorBoundary label={t('PR')}>
                <PrPanel
                  key={selectedPath}
                  repoPath={selectedPath}
                  active={active && detailTab === 'pr'}
                  createdPr={createdPr}
                />
              </ErrorBoundary>
            </div>
          </div>
          {selectedPath && status?.branch && prRepository ? (
            <PrCreateDialog
              open={prDialogOpen}
              repoPath={selectedPath}
              branch={status.branch}
              repository={prRepository}
              onCreated={onPrCreated}
              onClose={() => setPrDialogOpen(false)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
