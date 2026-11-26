/**
 * GitPanel 面板头（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，原样迁出）：
 * 历史导航、会话 worktree 快捷按钮、跟随会话开关、仓库快速切换菜单、刷新/列表开关、页签切换器。
 * 无 memo：重渲时机与原整面板渲染保持一致。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoSummary } from '../../../../shared/types';
import type { WorkspaceFileConfig } from '../../../../shared/metaAgent';
import type { WorkspaceFilePatchOutcome } from '../../hooks/useWorkspaceFile';
import {
  SideToolsHistoryNav,
  SideToolsSwitcher,
  type SideToolsTab
} from '../../components/SideToolsSwitcher';
import { IconPanelToggle } from '../../components/icons';

export type SessionWorktreeBadge = {
  path: string;
  branch: string;
  name: string;
};

export function GitPanelHeader({
  onBackTab,
  canBackTab,
  onForwardTab,
  canForwardTab,
  activeSessionWorktree,
  commitSelectedPath,
  followSessionRepo,
  toggleFollowSessionRepo,
  repoListOpen,
  selectedRepoName,
  selectedPath,
  repoQuickOpen,
  setRepoQuickOpen,
  repoQuickRef,
  displayedRepos,
  setSelectedPath,
  setRepoListOpen,
  patch,
  listLoading,
  busy,
  refreshList,
  toggleRepoList,
  showNoRepoState,
  sideTab,
  onSideTab,
  onDropOnTab
}: {
  onBackTab?: () => void;
  canBackTab?: boolean;
  onForwardTab?: () => void;
  canForwardTab?: boolean;
  activeSessionWorktree: SessionWorktreeBadge | null;
  commitSelectedPath: (repoPath: string) => void;
  followSessionRepo: boolean;
  toggleFollowSessionRepo: () => void;
  repoListOpen: boolean;
  selectedRepoName: string | null;
  selectedPath: string | null;
  repoQuickOpen: boolean;
  setRepoQuickOpen: React.Dispatch<React.SetStateAction<boolean>>;
  repoQuickRef: React.MutableRefObject<HTMLDivElement | null>;
  displayedRepos: GitRepoSummary[];
  setSelectedPath: (repoPath: string) => void;
  setRepoListOpen: (open: boolean) => void;
  patch: (partial: Partial<WorkspaceFileConfig>) => Promise<WorkspaceFilePatchOutcome>;
  listLoading: boolean;
  busy: boolean;
  refreshList: () => void;
  toggleRepoList: () => void;
  showNoRepoState: boolean;
  sideTab?: SideToolsTab;
  onSideTab?: (tab: SideToolsTab) => void;
  onDropOnTab?: (tab: SideToolsTab, paths: string[]) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="git-panel-header">
      <div className="git-panel-header-left">
        <SideToolsHistoryNav
          onBack={onBackTab}
          canBack={canBackTab}
          onForward={onForwardTab}
          canForward={canForwardTab}
        />
        {activeSessionWorktree ? (
          <button
            type="button"
            className="git-btn ghost tiny git-session-worktree-btn"
            title={t(
              '会话「{{name}}」的隔离 worktree：{{path}}\n点击把仓库切过去',
              { name: activeSessionWorktree.name, path: activeSessionWorktree.path }
            )}
            onClick={() => commitSelectedPath(activeSessionWorktree.path)}
          >
            ◉ {activeSessionWorktree.name} · {activeSessionWorktree.branch}
          </button>
        ) : null}
        <button
          type="button"
          className={`git-btn ghost tiny${followSessionRepo ? ' is-on' : ''}`}
          title={
            followSessionRepo
              ? t('Git 面板跟随会话：已开启（切会话时自动选中其 worktree）')
              : t('Git 面板跟随会话：默认关；开启后切会话时自动选中其 worktree')
          }
          onClick={toggleFollowSessionRepo}
        >
          {followSessionRepo ? t('◉ 跟随会话') : t('○ 跟随会话')}
        </button>
        {!repoListOpen && selectedRepoName ? (
          <div className={`git-repo-quick${repoQuickOpen ? ' is-open' : ''}`} ref={repoQuickRef}>
            <button
              type="button"
              className="git-panel-current-repo git-repo-quick-btn"
              title={selectedPath ?? undefined}
              aria-haspopup="menu"
              aria-expanded={repoQuickOpen}
              onClick={() => setRepoQuickOpen((v) => !v)}
            >
              <span className="git-repo-quick-name">{selectedRepoName}</span>
              <span className="git-repo-quick-caret" aria-hidden>
                ▾
              </span>
            </button>
            {repoQuickOpen ? (
              <div className="git-repo-quick-menu ui-menu" role="menu">
                {displayedRepos.length === 0 ? (
                  <div className="empty-hint">{t('无可用仓库')}</div>
                ) : (
                  displayedRepos.map((r) => (
                    <button
                      key={r.path}
                      type="button"
                      role="menuitem"
                      className={`ui-menu-item${selectedPath === r.path ? ' is-active' : ''}`}
                      title={r.path}
                      onClick={() => {
                        setSelectedPath(r.path);
                        setRepoQuickOpen(false);
                      }}
                    >
                      {r.dirty ? <span className="git-dirty-dot" /> : null}
                      {r.name}
                    </button>
                  ))
                )}
                <div className="chrome-dropdown-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="ui-menu-item"
                  onClick={() => {
                    setRepoQuickOpen(false);
                    setRepoListOpen(true);
                    void patch({ git: { repoListOpen: true } });
                  }}
                >
                  {t('展开完整仓库列表…')}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="git-btn ghost tiny"
        disabled={listLoading || busy}
        onClick={refreshList}
      >
        {t('刷新')}
      </button>
      <button
        type="button"
        className={`side-list-toggle is-icon${repoListOpen ? ' is-open' : ''}`}
        aria-label={repoListOpen ? t('隐藏仓库列表') : t('打开仓库列表')}
        title={repoListOpen ? t('隐藏仓库列表') : t('打开仓库列表')}
        aria-expanded={repoListOpen}
        onClick={toggleRepoList}
        disabled={showNoRepoState}
      >
        <IconPanelToggle size={14} placement="top" open={repoListOpen} />
      </button>
      {sideTab && onSideTab ? (
        <SideToolsSwitcher tab={sideTab} onSelect={onSideTab} onDropOnTab={onDropOnTab} />
      ) : null}
    </div>
  );
}
