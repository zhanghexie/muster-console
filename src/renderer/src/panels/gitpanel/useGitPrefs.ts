/**
 * GitPanel prefs 层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * selectedPath + pinned/hidden/hiddenView/repoListOpen/repoSort 的 workspace.json 水合与写盘。
 * 原面板文件内的 hydrate effect / persist 回调原样迁出；时序契约保持：
 * - 水合（含切工作区换源）不是导航：入栈基线同步设为恢复目标（repoNavBaselineRef）；
 * - 等本次 apply 的 setState 提交后再允许 selectedPath 写回（queueMicrotask 置 prefsAppliedRef）。
 * hiddenCount / reposAfterHidden 依赖面板级 repos 列表，留在 GitPanelCore 计算（原位置语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFileConfig } from '../../../../shared/metaAgent';
import type { WorkspaceFilePatchOutcome } from '../../hooks/useWorkspaceFile';
import { pathKey } from '../../../../shared/pathKey';
import {
  parseHiddenView,
  type HiddenView
} from '../../../../shared/workspaceUiPersist';
import { parseRepoSort, type RepoSort } from './gitPanelPure';

export type GitPrefsApi = {
  selectedPath: string | null;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  prefsAppliedRef: React.MutableRefObject<boolean>;
  savedRepoRef: React.MutableRefObject<string | null>;
  /** 面板历史 repo 轴入栈基线：(wsId, path) 配对——切工作区换源只重置基线不入栈（防串栈） */
  repoNavBaselineRef: React.MutableRefObject<{ wsId: string; path: string | null } | null>;
  pinned: string[];
  hidden: string[];
  hiddenView: HiddenView;
  setHiddenView: React.Dispatch<React.SetStateAction<HiddenView>>;
  repoListOpen: boolean;
  setRepoListOpen: React.Dispatch<React.SetStateAction<boolean>>;
  repoSort: RepoSort;
  setRepoSort: React.Dispatch<React.SetStateAction<RepoSort>>;
  hiddenKeys: Set<string>;
  pinnedKeys: Set<string>;
  clearSelectedRepo: (badPath?: string) => void;
  togglePin: (repoPath: string) => void;
  toggleHidden: (repoPath: string) => void;
  hideRepos: (repoPaths: string[], hide: boolean) => void;
  setReposPinned: (repoPaths: string[], pinned: boolean) => void;
  persistHiddenView: (next: HiddenView) => void;
  unhideAll: () => void;
  toggleRepoList: () => void;
  followSessionRepo: boolean;
  toggleFollowSessionRepo: () => void;
};

export function useGitPrefs({
  ready,
  gitCfg,
  cfgRef,
  patch,
  historyWsId,
  fixedRepoPath
}: {
  ready: boolean;
  gitCfg: WorkspaceFileConfig['git'];
  /** 当次 workspace.json 值引用：水合 effect 经它取数，deps 不随任意并发 patch 换引用 */
  cfgRef: React.MutableRefObject<WorkspaceFileConfig>;
  patch: (partial: Partial<WorkspaceFileConfig>) => Promise<WorkspaceFilePatchOutcome>;
  historyWsId: string;
  fixedRepoPath?: string;
}): GitPrefsApi {
  const [selectedPath, setSelectedPath] = useState<string | null>(fixedRepoPath ?? null);
  const prefsAppliedRef = useRef(false);
  const savedRepoRef = useRef<string | null>(null);
  /** 面板历史 repo 轴入栈基线：(wsId, path) 配对——切工作区换源只重置基线不入栈（防串栈） */
  const repoNavBaselineRef = useRef<{ wsId: string; path: string | null } | null>(null);
  const [pinned, setPinned] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [hiddenView, setHiddenView] = useState<HiddenView>('exclude');
  const [repoListOpen, setRepoListOpen] = useState(true);
  const [repoSort, setRepoSort] = useState<RepoSort>('name');

  useEffect(() => {
    if (!ready) {
      prefsAppliedRef.current = false;
      return;
    }
    // A2-6-1：deps 收窄为 [ready, historyWsId]——gitCfg 引用随任意并发 patch 换新，
    // 会让本 effect 把用户会话内已改的 prefs 重新水合回去（竞态回写）；effect 内
    // 经 cfgRef 读当次值，水合只发生在就绪/切工作区时机
    const git = cfgRef.current?.git ?? {};
    const saved = fixedRepoPath ?? git.selectedRepo ?? null;
    savedRepoRef.current = saved;
    setSelectedPath(saved);
    setPinned(Array.isArray(git.pinnedRepos) ? git.pinnedRepos : []);
    setHidden(Array.isArray(git.hiddenRepos) ? git.hiddenRepos : []);
    setRepoListOpen(git.repoListOpen !== false);
    setHiddenView(parseHiddenView(git.hiddenView));
    setRepoSort(parseRepoSort(git.repoSort));
    // prefs 恢复（含切工作区换源）不是导航：入栈基线同步设为恢复目标，
    // 历史 effect 在 applied 窗口外才记录，恢复路径两个 commit 都不会误入栈
    repoNavBaselineRef.current = { wsId: historyWsId, path: saved };
    // 等本次 apply 的 setState 提交后再允许 selectedPath 写回，避免用旧选中误 patch 新工作区
    queueMicrotask(() => {
      prefsAppliedRef.current = true;
    });
  }, [ready, historyWsId, cfgRef, fixedRepoPath]);

  const clearSelectedRepo = useCallback(
    (badPath?: string) => {
      setSelectedPath((prev) => {
        if (!badPath) return null;
        if (prev && pathKey(prev) === pathKey(badPath)) return null;
        return prev;
      });
      savedRepoRef.current = null;
      void patch({ git: { selectedRepo: null } });
    },
    [pathKey, patch]
  );

  const hiddenKeys = useMemo(
    () => new Set(hidden.map((p) => pathKey(p))),
    [hidden, pathKey]
  );

  const pinnedKeys = useMemo(
    () => new Set(pinned.map((p) => pathKey(p))),
    [pinned, pathKey]
  );

  const togglePin = useCallback(
    (repoPath: string) => {
      setPinned((prev) => {
        const key = pathKey(repoPath);
        const exists = prev.some((p) => pathKey(p) === key);
        const next = exists
          ? prev.filter((p) => pathKey(p) !== key)
          : [...prev, repoPath];
        void patch({ git: { pinnedRepos: next } });
        return next;
      });
    },
    [pathKey, patch]
  );

  const toggleHidden = useCallback(
    (repoPath: string) => {
      setHidden((prev) => {
        const key = pathKey(repoPath);
        const exists = prev.some((p) => pathKey(p) === key);
        const next = exists
          ? prev.filter((p) => pathKey(p) !== key)
          : [...prev, repoPath];
        void patch({ git: { hiddenRepos: next } });
        return next;
      });
    },
    [pathKey, patch]
  );

  /** 多选批量：一次 patch 隐藏/取消隐藏多个仓库（pathKey 去重） */
  const hideRepos = useCallback(
    (repoPaths: string[], hide: boolean) => {
      if (repoPaths.length === 0) return;
      setHidden((prev) => {
        const keys = new Set(repoPaths.map((p) => pathKey(p)));
        const next = hide
          ? [...prev, ...repoPaths.filter((p) => !prev.some((q) => pathKey(q) === pathKey(p)))]
          : prev.filter((p) => !keys.has(pathKey(p)));
        void patch({ git: { hiddenRepos: next } });
        return next;
      });
    },
    [pathKey, patch]
  );

  /** 多选批量：一次 patch 设置多个仓库的置顶态 */
  const setReposPinned = useCallback(
    (repoPaths: string[], pinnedNext: boolean) => {
      if (repoPaths.length === 0) return;
      setPinned((prev) => {
        const keys = new Set(repoPaths.map((p) => pathKey(p)));
        const next = pinnedNext
          ? [...prev, ...repoPaths.filter((p) => !prev.some((q) => pathKey(q) === pathKey(p)))]
          : prev.filter((p) => !keys.has(pathKey(p)));
        void patch({ git: { pinnedRepos: next } });
        return next;
      });
    },
    [pathKey, patch]
  );

  const persistHiddenView = useCallback(
    (next: HiddenView) => {
      setHiddenView(next);
      void patch({ git: { hiddenView: next } });
    },
    [patch]
  );

  const unhideAll = useCallback(() => {
    setHidden([]);
    setHiddenView('exclude');
    void patch({ git: { hiddenRepos: [], hiddenView: 'exclude' } });
  }, [patch]);

  useEffect(() => {
    // 用隐藏名单本身判断，不用 hiddenCount：名单还在、列表未扫完时 count=0，
    // 若此刻回落 exclude 会把刚 hydrate 的 include/only 写回磁盘。
    if (hidden.length === 0 && hiddenView !== 'exclude') {
      persistHiddenView('exclude');
    }
  }, [hidden.length, hiddenView, persistHiddenView]);

  const toggleRepoList = useCallback(() => {
    setRepoListOpen((prev) => {
      const next = !prev;
      void patch({ git: { repoListOpen: next } });
      return next;
    });
  }, [patch]);

  const followSessionRepo = gitCfg?.followSessionRepo === true;

  const toggleFollowSessionRepo = useCallback(() => {
    void patch({ git: { followSessionRepo: !followSessionRepo } });
  }, [patch, followSessionRepo]);

  return {
    selectedPath,
    setSelectedPath,
    prefsAppliedRef,
    savedRepoRef,
    repoNavBaselineRef,
    pinned,
    hidden,
    hiddenView,
    setHiddenView,
    repoListOpen,
    setRepoListOpen,
    repoSort,
    setRepoSort,
    hiddenKeys,
    pinnedKeys,
    clearSelectedRepo,
    togglePin,
    toggleHidden,
    hideRepos,
    setReposPinned,
    persistHiddenView,
    unhideAll,
    toggleRepoList,
    followSessionRepo,
    toggleFollowSessionRepo
  };
}
