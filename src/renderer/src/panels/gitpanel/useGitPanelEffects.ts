/**
 * GitPanel 导航与浮层副作用层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * - 面板历史 repo 轴入栈（applied 稳定期才记录，切工作区换源不入栈）；
 * - revealAbs 落点（找包含仓 → 隐藏仓切 include → 待命文件 → 选中）；
 * - 跟随会话 worktree（同一会话只跟一次）；
 * - 搜索框聚焦、排序菜单与仓库快开菜单的外点/Escape 关闭、列表展开时收快开。
 * 原面板文件内的对应 effect 原样迁出；均为无返回值的副作用 hook。
 */
import { useRightWorkspace } from '../../rightWorkspace';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitRepoSummary } from '../../../../shared/types';
import { tryRelativizeToRoot } from '../../../../shared/workspaceRelPath';
import { pathKey } from '../../../../shared/pathKey';
import { usePanelHistory } from '../../panelHistory';
import { useOverlayDismiss } from '../../keybindings/KeybindingHost';
import { useUiStore } from '../../store';
import { findContainingRepo } from './gitPanelPure';

export function useGitPanelEffects({
  // 面板历史（repo 轴）
  selectedPath,
  prefsAppliedRef,
  repoNavBaselineRef,
  historyWsId,
  // reveal 落点
  revealAbs,
  repos,
  listLoading,
  hiddenKeys,
  commitSelectedPath,
  refreshStatus,
  patch,
  setHiddenView,
  setRepoListOpen,
  pendingChangeRelRef,
  // 跟随会话
  followSessionRepo,
  followTargetPath,
  // 浮层菜单
  searchOpen,
  searchInputRef,
  sortMenuOpen,
  setSortMenuOpen,
  sortMenuRef,
  repoQuickOpen,
  setRepoQuickOpen,
  repoQuickRef,
  repoListOpen
}: {
  selectedPath: string | null;
  prefsAppliedRef: React.MutableRefObject<boolean>;
  repoNavBaselineRef: React.MutableRefObject<{ wsId: string; path: string | null } | null>;
  historyWsId: string;
  revealAbs?: { path: string; nonce: number } | null;
  repos: GitRepoSummary[];
  listLoading: boolean;
  hiddenKeys: Set<string>;
  commitSelectedPath: (repoPath: string) => void;
  refreshStatus: (repoPath: string | null, quiet?: boolean) => Promise<void>;
  patch: (partial: Record<string, unknown>) => Promise<unknown>;
  setHiddenView: (v: 'exclude' | 'include' | 'only') => void;
  setRepoListOpen: (open: boolean) => void;
  pendingChangeRelRef: React.MutableRefObject<{ repo: string; rel: string } | null>;
  followSessionRepo: boolean;
  followTargetPath: string | undefined;
  searchOpen: boolean;
  searchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  sortMenuOpen: boolean;
  setSortMenuOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  sortMenuRef: React.MutableRefObject<HTMLDivElement | null>;
  repoQuickOpen: boolean;
  setRepoQuickOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  repoQuickRef: React.MutableRefObject<HTMLDivElement | null>;
  repoListOpen: boolean;
}): void {
  const { t } = useTranslation();
  const unified = !!useRightWorkspace();
  const { flashTip } = useUiStore();
  /** 同一会话只跟一次（之后手动浏览其它 repo 不被打扰） */
  const lastFollowedRepoRef = useRef<string | null>(null);
  const lastRevealNonceRef = useRef(0);

  // ---- 面板历史（右栈）：仓库选中切换入栈（点击/键盘/快开/拖放等全部来源都记录）。
  //  基线由 prefs effect 在恢复时同步重置（恢复不是导航）；此处只在 applied 稳定期
  //  记录真实导航，切工作区「wsId 先变、selectedPath 后变」的两个 commit 都不入栈 ----
  const { pushRight: pushRightPanelHistory } = usePanelHistory();
  useEffect(() => {
    if (unified || !prefsAppliedRef.current) return;
    const prev = repoNavBaselineRef.current;
    if (prev && prev.wsId === historyWsId && prev.path === selectedPath) return;
    repoNavBaselineRef.current = { wsId: historyWsId, path: selectedPath };
    if (prev && prev.wsId === historyWsId && prev.path != null) {
      pushRightPanelHistory(historyWsId, { kind: 'repo', path: prev.path });
    }
  }, [selectedPath, historyWsId, pushRightPanelHistory, prefsAppliedRef, repoNavBaselineRef, unified]);

  useEffect(() => {
    if (!revealAbs || revealAbs.nonce === lastRevealNonceRef.current) return;
    if (listLoading) return;
    lastRevealNonceRef.current = revealAbs.nonce;
    const match = findContainingRepo(revealAbs.path, repos, pathKey);
    if (!match) {
      flashTip(t('未找到对应 Git 仓库'));
      return;
    }
    if (!match.worktree && hiddenKeys.has(pathKey(match.path))) {
      setHiddenView('include');
      void patch({ git: { hiddenView: 'include', repoListOpen: true } });
    } else {
      void patch({ git: { repoListOpen: true } });
    }
    setRepoListOpen(true);
    const rel = tryRelativizeToRoot(match.path, revealAbs.path);
    pendingChangeRelRef.current =
      rel && rel !== '' ? { repo: match.path, rel: rel.replace(/\\/g, '/') } : null;
    const already =
      selectedPath != null && pathKey(selectedPath) === pathKey(match.path);
    commitSelectedPath(match.path);
    if (already) void refreshStatus(match.path);
  }, [
    revealAbs,
    repos,
    listLoading,
    pathKey,
    hiddenKeys,
    commitSelectedPath,
    flashTip,
    patch,
    selectedPath,
    refreshStatus,
    setHiddenView,
    setRepoListOpen,
    pendingChangeRelRef,
    t
  ]);

  // 跟随开关开启：会话变化时 selectedRepo 自动跟到该会话的 worktree；
  // 同一会话只跟一次（之后手动浏览其它 repo 不被打扰）
  useEffect(() => {
    if (!prefsAppliedRef.current || !followSessionRepo || !followTargetPath) return;
    if (lastFollowedRepoRef.current === followTargetPath) return;
    lastFollowedRepoRef.current = followTargetPath;
    commitSelectedPath(followTargetPath);
  }, [followSessionRepo, followTargetPath, commitSelectedPath, prefsAppliedRef]);

  // 搜索框自动聚焦 / 排序与快开菜单的外点关闭
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen, searchInputRef]);

  useEffect(() => {
    if (!sortMenuOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuOpen(false);
    };
    // capture：避免菜单项 pointerdown 被其它层抢走；选项用 onMouseDown 切换
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [sortMenuOpen, sortMenuRef, setSortMenuOpen]);
  useOverlayDismiss(sortMenuOpen, () => setSortMenuOpen(false));

  useEffect(() => {
    if (!repoQuickOpen) return;
    const onDoc = (e: PointerEvent) => {
      if (!repoQuickRef.current?.contains(e.target as Node)) setRepoQuickOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [repoQuickOpen, repoQuickRef, setRepoQuickOpen]);
  useOverlayDismiss(repoQuickOpen, () => setRepoQuickOpen(false));

  useEffect(() => {
    if (repoListOpen) setRepoQuickOpen(false);
  }, [repoListOpen, setRepoQuickOpen]);
}
