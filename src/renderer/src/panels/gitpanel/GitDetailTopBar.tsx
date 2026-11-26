import { OperationButton } from '../../components/OperationButton';
import { useScopedGit } from './GitWorkspaceScope';
/**
 * GitPanel 详情顶部条（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * 分支切换按钮（GitBranchPopover）、tracking/ahead-behind 徽标、work/history/pr 页签、
 * Fetch/Pull/Push 与开 PR。无 memo：重渲时机与原整面板渲染保持一致。
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { useRightWorkspace } from '../../rightWorkspace';
import { IconBranch, IconClock, IconDiff, IconRefresh, IconDownload, IconUpload, IconFetch, IconEye } from '../../components/icons';
import { useSessionStore, useRuntimesStore } from '../../store';
import { useTranslation } from 'react-i18next';
import type { GitRepoStatus, GitRepoSummary } from '../../../../shared/types';
import { GitBranchPopover } from '../GitBranchPopover';
import type { DetailTab } from './gitPanelPure';
import type { GitRemoteApi } from './useGitRemote';
import type { RemoteKind } from './gitRemoteState';
import { runtimeSurface } from '../../../../shared/types';

function TurnReviewButton({ repoPath }: { repoPath: string }) {
  const { t } = useTranslation(), bridge = useRightWorkspace();
  const { activeId, sessions } = useSessionStore();
  const { runtimes } = useRuntimesStore();
  const session = sessions.find(s => s.id === activeId);
  const gui = session && runtimeSurface(runtimes.find(r => r.id === session.runtime)) === 'chat';
  return <button type="button" className="right-icon" title={t('审阅')} aria-label={t('审阅')} onClick={() => {
    if (bridge) bridge.open({ kind: 'review', owner: gui ? { kind: 'gui', id: session.id } : { kind: 'dispatch', id: bridge.model.workspaceId }, repoPath }, 'keep', bridge.current?.scope ?? 'session');
  }}><IconEye size={14}/></button>;
}

export function GitDetailTopBar({
  branchPopOpen,
  toolbarHost,
  worktreeSwitcher,
  setBranchPopOpen,
  status,
  selectedSummary,
  busy,
  selectedPath,
  refreshStatus,
  refreshList,
  commitSelectedPath,
  detailTab,
  setDetailTab,
  runAction,
  selectedIsWorktree,
  prDetecting,
  openPrFlow,
  onCheckoutWarning,
  remote
}: {
  branchPopOpen: boolean;
  toolbarHost?: HTMLElement | null;
  worktreeSwitcher?: React.ReactNode;
  setBranchPopOpen: React.Dispatch<React.SetStateAction<boolean>>;
  status: GitRepoStatus | null;
  selectedSummary: GitRepoSummary | null;
  busy: boolean;
  selectedPath: string;
  refreshStatus: (repoPath: string | null, quiet?: boolean) => Promise<void>;
  refreshList: (quiet?: boolean, forceRescan?: boolean) => Promise<void>;
  commitSelectedPath: (repoPath: string) => void;
  detailTab: DetailTab;
  setDetailTab: (tab: DetailTab) => void;
  runAction: (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>;
  selectedIsWorktree: boolean;
  prDetecting: boolean;
  openPrFlow: () => void;
  onCheckoutWarning?: (message: string) => void;
  remote?: GitRemoteApi;
}): React.JSX.Element {
  const { t } = useTranslation();
  const git = useScopedGit();
  const bridge = useRightWorkspace();
  const runRemote = (kind: RemoteKind) => remote ? remote.run(kind) : runAction(() => git[kind](selectedPath));
  const branchInfo = (
      <div className="git-branch-info">
        <button
          type="button"
          className={`git-branch-name-btn${branchPopOpen ? ' is-open' : ''}`}
          title={t('点击切换 / 新建分支')}
          disabled={!status?.branch || busy}
          onClick={() => setBranchPopOpen((v) => !v)}
        >
          {/* status 未回时先用列表摘要垫上（乐观切换），回来再校正 */}
          <span className="git-branch-name">
            {status?.branch ?? selectedSummary?.branch ?? '…'}
          </span>
          <span className="git-branch-caret" aria-hidden>
            ▾
          </span>
        </button>
        {worktreeSwitcher}
        {status?.tracking ? (
          <span className="git-tracking">{status.tracking}</span>
        ) : null}
        {!remote && status ? (
          <span className="git-ab">
            ↑{status.ahead} ↓{status.behind}
          </span>
        ) : !remote && (selectedSummary?.ahead || selectedSummary?.behind) ? (
          <span className="git-ab">
            ↑{selectedSummary.ahead ?? 0} ↓{selectedSummary.behind ?? 0}
          </span>
        ) : null}
        {selectedPath && status?.branch ? (
          <GitBranchPopover
            repoPath={selectedPath}
            currentBranch={status.branch}
            dirty={(status.files?.length ?? 0) > 0}
            open={branchPopOpen}
            onClose={() => setBranchPopOpen(false)}
            onChanged={(newRepoPath, result) => {
              if (result?.warning && result.message) onCheckoutWarning?.(result.message);
              void refreshStatus(selectedPath);
              // New worktrees are explicitly requested after selection. Their creation
              // changes task paths, not the source repository discovery snapshot.
              void refreshList(true, false).then(() => {
                // worktree 新建：自动选中新 repo
                if (newRepoPath) commitSelectedPath(newRepoPath);
              });
            }}
          />
        ) : null}
      </div>
  );
  if (bridge) return <>
    {toolbarHost && bridge.location ? createPortal(<div className="right-git-location"><IconBranch size={14}/><span className="right-full-path" title={selectedPath}>{selectedPath}</span>{branchInfo}</div>, bridge.location) : null}
    {toolbarHost ? createPortal(<>
      <div className="right-tool-group right-mode-tools">
        {(['work', 'history', 'pr'] as DetailTab[]).map(tab => { const Icon = tab === 'work' ? IconDiff : tab === 'history' ? IconClock : IconBranch; const label = tab === 'work' ? t('工作区') : tab === 'history' ? t('历史') : 'PR'; return <button type="button" key={tab} className={`right-icon${detailTab === tab ? ' is-on' : ''}`} title={label} aria-label={label} aria-pressed={detailTab === tab} onClick={() => setDetailTab(tab)}><Icon size={14}/></button>; })}
        <TurnReviewButton repoPath={selectedPath}/>
      </div>
      <div className="right-tool-group">
        <OperationButton type="button" iconOnly className="right-icon" title={t('刷新本地状态')} aria-label={t('刷新本地状态')} disabled={busy} onAction={() => refreshStatus(selectedPath)}><IconRefresh size={14}/></OperationButton>
        <button type="button" className="right-icon" title={t('检查远端（Fetch）')} aria-label="Fetch" disabled={busy} onClick={() => void runRemote('fetch')}><IconFetch size={14}/></button>
        <button type="button" className="right-icon" title={t('拉取（Pull）')} aria-label="Pull" disabled={busy} onClick={() => void runRemote('pull')}><IconDownload size={14}/></button>
        <button type="button" className="right-icon" title={t('推送（Push）')} aria-label="Push" disabled={busy} onClick={() => void runRemote('push')}><IconUpload size={14}/></button>
        {selectedIsWorktree ? <button type="button" className="right-icon" title={t('开 PR')} aria-label={t('开 PR')} disabled={busy || prDetecting} onClick={openPrFlow}><IconBranch size={14}/></button> : null}
      </div>
    </>, toolbarHost) : null}
  </>;
  return (
    <div className="git-branch-bar">
      {branchInfo}
<div className="git-remote-actions">
        <div className="git-detail-tabs">
          <button
            type="button"
            className={`git-btn ghost tiny${detailTab === 'work' ? ' is-on' : ''}`}
            onClick={() => setDetailTab('work')}
          >
            {t('工作区')}
          </button>
          <button
            type="button"
            className={`git-btn ghost tiny${detailTab === 'history' ? ' is-on' : ''}`}
            onClick={() => setDetailTab('history')}
          >
            {t('历史')}
          </button>
          <button
            type="button"
            className={`git-btn ghost tiny${detailTab === 'pr' ? ' is-on' : ''}`}
            onClick={() => setDetailTab('pr')}
          >
            {t('PR')}
          </button>
        </div>
        <button
          type="button"
          className="git-btn"
          disabled={busy}
          onClick={() =>
            void runRemote('fetch')
          }
        >
          {t('检查远端')}
        </button>
        <button
          type="button"
          className="git-btn"
          disabled={busy}
          onClick={() =>
            void runRemote('pull')
          }
        >
          Pull
        </button>
        <button
          type="button"
          className="git-btn"
          disabled={busy}
          onClick={() =>
            void runRemote('push')
          }
        >
          Push
        </button>
        {/* 创建 PR 的入口对应独立 worktree 分支。 */}
        {selectedIsWorktree ? (
          <button
            type="button"
            className="git-btn"
            disabled={busy || prDetecting}
            title={t('把当前隔离分支推送到 GitHub 并创建 PR')}
            onClick={openPrFlow}
          >
            {prDetecting ? t('检测中…') : t('开 PR')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
