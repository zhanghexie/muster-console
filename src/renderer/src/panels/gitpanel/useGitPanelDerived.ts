/**
 * GitPanel 面板级派生量（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * 当前会话 worktree 徽标、未暂存/已暂存分区、选中仓摘要与名称、当前选中文件、
 * 隔离 worktree 判定——原面板文件内的 useMemo 集合原样迁出，deps 保持一致。
 */
import { useMemo } from 'react';
import type { GitFileChange, GitRepoSummary, SessionMeta } from '../../../../shared/types';
import { pathKey } from '../../../../shared/pathKey';
import { isIsolatedWorktreePath } from '../../../../shared/worktreePath';
import { sessionWorktreeReviewTarget } from '../../../../shared/sessionWorktreeReview';
import { isStaged, isUnstaged } from './gitPanelPure';
import type { GitRepoDataApi } from './useGitRepoData';

export type GitPanelDerived = {
  /** 当前选中终端会话（快捷按钮 + 跟随开关用） */
  activeSession: SessionMeta | null;
  activeSessionWorktree: { path: string; branch: string; name: string } | null;
  unstagedFiles: GitFileChange[];
  stagedFiles: GitFileChange[];
  selectedRepoName: string | null;
  /** 当前仓在列表里的摘要：切仓后 status 未回时，顶部分支条先用它乐观垫上 */
  selectedSummary: GitRepoSummary | null;
  selectedChange: GitFileChange | undefined;
  /** 选中仓是隔离 worktree 时才提供「部分采纳」（与顶部分支条的 worktree 判定同源） */
  selectedIsWorktree: boolean;
};

export function useGitPanelDerived({
  visibleSessions,
  activeId,
  selectedPath,
  data
}: {
  visibleSessions: SessionMeta[];
  activeId: string | null;
  selectedPath: string | null;
  data: GitRepoDataApi;
}): GitPanelDerived {
  const activeSession = useMemo(
    () => visibleSessions.find((s) => s.id === activeId && s.type === 'terminal') ?? null,
    [visibleSessions, activeId]
  );
  const activeSessionWorktree = useMemo(() => {
    try {
      const repo = sessionWorktreeReviewTarget(activeSession ?? undefined);
      return repo?.branch && activeSession ? { path: repo.repoPath, branch: repo.branch, name: activeSession.name } : null;
    } catch { return null; }
  }, [activeSession]);

  const unstagedFiles = useMemo(
    () => (data.status?.files ?? []).filter(isUnstaged),
    [data.status?.files]
  );
  const stagedFiles = useMemo(
    () => (data.status?.files ?? []).filter(isStaged),
    [data.status?.files]
  );

  const selectedRepoName = useMemo(() => {
    if (!selectedPath) return null;
    const k = pathKey(selectedPath);
    return data.repos.find((r) => pathKey(r.path) === k)?.name ?? null;
  }, [data.repos, selectedPath, pathKey]);

  const selectedSummary = useMemo(() => {
    if (!selectedPath) return null;
    const k = pathKey(selectedPath);
    return data.repos.find((r) => pathKey(r.path) === k) ?? null;
  }, [data.repos, selectedPath, pathKey]);

  const selectedChange = data.status?.files.find((f) => f.path === data.selectedFile);

  const selectedIsWorktree = selectedSummary?.worktree ?? (selectedPath ? isIsolatedWorktreePath(selectedPath) : false);

  return {
    activeSession,
    activeSessionWorktree,
    unstagedFiles,
    stagedFiles,
    selectedRepoName,
    selectedSummary,
    selectedChange,
    selectedIsWorktree
  };
}
