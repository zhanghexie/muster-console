/**
 * GitPanel 数据层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * 仓库列表 / status / diff 的拉取与过期响应保护（gen ref）、fs:changed 节流刷新、窗口焦点刷新。
 * 初次/手动先发布目录；选中仓与其他仓的小批次状态查询独立推进：
 * - refreshList 过期响应丢弃（listGenRef）；refreshStatus 过期丢弃 + 未知仓库清理（statusGenRef）；
 * - fs status 刷新 1.5s 最小间隔节流、列表刷新 800ms 防抖、空路径信号 10s 冷却；
 * - fs/focus 为事件注册类 effect，随本 hook 前置注册（事件异步触发，注册顺序无观测差异）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createScopedGit } from './GitWorkspaceScope';
import { useTranslation } from 'react-i18next';
import type {
  FsChangedPayload,
  GitFileChange,
  GitRepoStatus,
  GitRepoSummary,
  GitRepoDiscoveryIssue,
  WorkspaceRoot
} from '../../../../shared/types';
import { shouldRefreshRepoList } from '../../../../shared/gitRefreshSignal';
import { pathKey } from '../../../../shared/pathKey';
import type { WorkspaceFileConfig } from '../../../../shared/metaAgent';
import type { WorkspaceFilePatchOutcome } from '../../hooks/useWorkspaceFile';
import {
  FS_EMPTY_LIST_COOLDOWN_MS,
  FS_LIST_DEBOUNCE_MS,
  FS_STATUS_DEBOUNCE_MS,
  FS_STATUS_MIN_INTERVAL_MS,
  PATCH_REPO_DEBOUNCE_MS,
  changeTouchesRepo,
  isStaged,
  isUnstaged,
  mergeRepoList,
  type DetailTab
} from './gitPanelPure';

export type GitRepoDataApi = {
  repos: GitRepoSummary[];
  discoveryIssues: GitRepoDiscoveryIssue[];
  discoveryIssueCount: number;
  listLoading: boolean;
  status: GitRepoStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  statusUpdatedAt: number | null;
  selectedFile: string | null;
  setSelectedFile: React.Dispatch<React.SetStateAction<string | null>>;
  diffStaged: boolean;
  setDiffStaged: React.Dispatch<React.SetStateAction<boolean>>;
  diffText: string;
  diffLoading: boolean;
  setStatus: React.Dispatch<React.SetStateAction<GitRepoStatus | null>>;
  setStatusLoading: React.Dispatch<React.SetStateAction<boolean>>;
  /** reveal 落点待命中：status 回来后命中该文件自动选中（原 pendingChangeRelRef 语义） */
  pendingChangeRelRef: React.MutableRefObject<{ repo: string; rel: string } | null>;
  refreshList: (quiet?: boolean, forceRescan?: boolean) => Promise<void>;
  refreshStatus: (repoPath: string | null, quiet?: boolean) => Promise<void>;
  loadDiff: (
    repoPath: string,
    filePath: string,
    staged: boolean,
    untracked?: boolean
  ) => Promise<void>;
  onSelectFile: (f: GitFileChange, zone: 'unstaged' | 'staged') => void;
};

export function useGitRepoData({
  active,
  fixedRepoPath,
  requestedPaths = [],
  workspaceId,
  workspacePath,
  workspaceRoots,
  rootsRevision = 0,
  defaultRootId,
  selectedPath,
  setSelectedPath,
  savedRepoRef,
  patch,
  setError,
  clearSelectedRepo,
  setDetailTab,
  prefsAppliedRef,
  setBranchPopOpen,
  prefsReady
}: {
  active: boolean;
  fixedRepoPath?: string;
  requestedPaths?: string[];
  workspaceId: string;
  workspacePath: string;
  workspaceRoots?: readonly WorkspaceRoot[];
  rootsRevision?: number;
  defaultRootId?: string;
  selectedPath: string | null;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  savedRepoRef: React.MutableRefObject<string | null>;
  patch: (partial: Partial<WorkspaceFileConfig>) => Promise<WorkspaceFilePatchOutcome>;
  setError: (e: string | null) => void;
  clearSelectedRepo: (badPath?: string) => void;
  setDetailTab: (tab: DetailTab) => void;
  prefsAppliedRef: React.MutableRefObject<boolean>;
  setBranchPopOpen: React.Dispatch<React.SetStateAction<boolean>>;
  prefsReady: boolean;
}): GitRepoDataApi {
  const { t } = useTranslation();
  const git = useMemo(() => createScopedGit({ workspaceId, rootsRevision }), [workspaceId, rootsRevision]);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const scope = JSON.stringify([workspaceId, rootsRevision, workspacePath, workspaceRoots?.map(r => [r.id, r.path])]);
  const [repos, setRepos] = useState<GitRepoSummary[]>([]);
  const [statusSnapshot, setStatusSnapshot] = useState<{ scope: string; repo: string | null; value: GitRepoStatus | null }>({ scope, repo: selectedPath, value: null });
  const selectedRef = useRef(selectedPath);
  selectedRef.current = selectedPath;
  const setStatus = useCallback<React.Dispatch<React.SetStateAction<GitRepoStatus | null>>>(action => {
    setStatusSnapshot(prev => ({ scope, repo: selectedRef.current, value: typeof action === 'function'
      ? action(prev.scope === scope && prev.repo === selectedRef.current ? prev.value : null) : action }));
  }, [scope]);
  const status = statusSnapshot.scope === scope && statusSnapshot.repo === selectedPath ? statusSnapshot.value : null;
  /** 当前仓 status 拉取中（配合 status==null 时显示骨架，不闪空白） */
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusRead, setStatusRead] = useState<{ scope: string; repo: string | null; error: string | null; at: number | null }>({ scope, repo: selectedPath, error: null, at: null });
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diffStaged, setDiffStaged] = useState(false);
  const diffSelection = JSON.stringify([selectedPath, selectedFile, diffStaged]);
  const [diffSnapshot, setDiffSnapshot] = useState<{ scope: string; selection: string; value: string } | null>(null);
  const visibleDiff = diffSnapshot?.scope === scope && diffSnapshot.selection === diffSelection ? diffSnapshot : null;
  const [diffLoading, setDiffLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const windowFocused = useRef(true);
  const prevActive = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;
  const backgroundGen = useRef(0);
  const backgroundFlight = useRef<Promise<unknown> | null>(null);
  const backgroundTimer = useRef<number>();
  const pendingChangeRelRef = useRef<{ repo: string; rel: string } | null>(null);
  /** 过期响应保护：快速切仓时先发的慢请求回来不允许覆盖新仓 state */
  const statusGenRef = useRef(0);
  const listGenRef = useRef(0);
  const diffGenRef = useRef(0);
  const scopeRef = useRef(scope);
  if (scopeRef.current !== scope) {
    scopeRef.current = scope;
    listGenRef.current++; statusGenRef.current++; diffGenRef.current++;
  }
  const selectionRef = useRef(selectedPath);
  const diffSelectionRef = useRef(diffSelection);
  if (selectionRef.current !== selectedPath) { selectionRef.current = selectedPath; statusGenRef.current++; }
  if (diffSelectionRef.current !== diffSelection) { diffSelectionRef.current = diffSelection; diffGenRef.current++; }
  useEffect(() => () => { listGenRef.current++; statusGenRef.current++; diffGenRef.current++; }, [scope]);
  /** fs 触发的 refreshStatus 节流 / 空信号列表刷新冷却 */
  const lastFsStatusAtRef = useRef(0);
  const lastFsEmptyListAtRef = useRef(0);

  const requestedKey = JSON.stringify(requestedPaths);
  const [loadedRequestedKey, setLoadedRequestedKey] = useState<string | null>(null);
  const [loadedScope, setLoadedScope] = useState<string>();
  const [listPublication, setListPublication] = useState({ generation: 0, refreshSelected: false });
  const [discovery, setDiscovery] = useState<{ scope: string; issues: GitRepoDiscoveryIssue[]; count: number }>({ scope, issues: [], count: 0 });
  const currentRepos = loadedScope === scope ? repos : [];
  const selectionAllowed = currentRepos.some(r => pathKey(r.path) === pathKey(selectedPath ?? ''));
  const membershipRef = useRef(selectionAllowed);
  if (membershipRef.current !== selectionAllowed) {
    membershipRef.current = selectionAllowed; statusGenRef.current++; diffGenRef.current++;
  }
  const membersRef = useRef(currentRepos);
  membersRef.current = currentRepos;
  useEffect(() => {
    if (active) return;
    listGenRef.current++; statusGenRef.current++; diffGenRef.current++;
    setListLoading(false); setStatusLoading(false); setDiffLoading(false);
  }, [active]);
  const refreshList = useCallback(
    async (quiet = false, forceRescan = false) => {
      if (!mounted.current || !activeRef.current || scopeRef.current !== scope) return;
      backgroundGen.current++;
      window.clearTimeout(backgroundTimer.current);
      if (!quiet) setListLoading(true);
      const gen = ++listGenRef.current;
      try {
        const result = await window.api.git.listRepoLocations(forceRescan, workspaceId,
          [...JSON.parse(requestedKey), selectedRef.current || savedRepoRef.current].filter(Boolean));
        // 过期响应丢弃：更新的列表请求已在飞行中
        if (listGenRef.current !== gen || !activeRef.current) return;
        if (result.workspaceId !== workspaceId || result.rootsRevision !== rootsRevision) throw new Error('workspace repository scope changed');
        const known = new Map(membersRef.current.map(repo => [pathKey(repo.path), repo]));
        const list = result.repos.map(location => {
          const previous = known.get(pathKey(location.path));
          return previous && previous.rootId === location.rootId ? { ...previous, ...location } : location;
        });
        setDiscovery({ scope, issues: result.issues, count: result.issueCount });
        setLoadedRequestedKey(requestedKey);
        setLoadedScope(scope);
        if (!quiet) setError(null);
        setRepos((prev) => mergeRepoList(prev, list, pathKey));
        setListPublication(value => ({ generation: value.generation + 1,
          refreshSelected: known.has(pathKey(selectedRef.current ?? '')) }));
        setSelectedPath((prev) => {
          if (scopeRef.current !== scope || listGenRef.current !== gen) return prev;
          if (fixedRepoPath) return fixedRepoPath;
          if (prev && list.some((r) => pathKey(r.path) === pathKey(prev))) return prev;
          const saved = savedRepoRef.current;
          if (saved) {
            const match = list.find((r) => pathKey(r.path) === pathKey(saved));
            if (match) return match.path;
            savedRepoRef.current = null;
            void patch({ git: { selectedRepo: null } });
          }
          if (!workspaceRoots || workspaceRoots.length <= 1) return list[0]?.path ?? null;
          const exact = list.find(r => r.rootId === defaultRootId && pathKey(r.path) === pathKey(workspacePath));
          const candidates = list.filter(r => r.rootId === defaultRootId && !r.worktree);
          return exact?.path ?? (candidates.length === 1 ? candidates[0].path : null);
        });
      } catch (err) {
        if (listGenRef.current === gen && activeRef.current) {
          setLoadedRequestedKey(requestedKey); setLoadedScope(scope); setRepos([]);
          setDiscovery({ scope, issues: [], count: 0 });
          setError(String(err));
        }
      } finally {
        if (listGenRef.current === gen) setListLoading(false);
      }
    },
    [requestedKey, scope, workspaceId, rootsRevision, workspacePath, workspaceRoots, defaultRootId, pathKey, patch, savedRepoRef, setSelectedPath, setError, fixedRepoPath]
  );

  const refreshStatus = useCallback(
    async (repoPath: string | null, quiet = false) => {
      // A completed action can invoke an old callback after the user selects
      // another repo. Such callbacks must not cancel or publish its status.
      if (!mounted.current || !activeRef.current || scopeRef.current !== scope
        || pathKey(repoPath ?? '') !== pathKey(selectedRef.current ?? '')) return;
      if (!repoPath || !membersRef.current.some(r => pathKey(r.path) === pathKey(repoPath))) {
        statusGenRef.current++;
        setStatus(null);
        setStatusLoading(false);
        return;
      }
    const gen = ++statusGenRef.current;
    setStatusLoading(true);
    try {
      const st = await git.status(repoPath);
      if (statusGenRef.current !== gen || !activeRef.current || scopeRef.current !== scope
        || pathKey(repoPath) !== pathKey(selectedRef.current ?? '')) return;
      setStatusSnapshot({ scope, repo: selectedRef.current, value: st });
      setStatusRead({ scope, repo: repoPath, error: null, at: Date.now() });
      const pending = pendingChangeRelRef.current;
      if (pending && pathKey(pending.repo) === pathKey(repoPath)) {
        const hit = st.files.find((f) => f.path.replace(/\\/g, '/') === pending.rel);
        if (hit) {
          setSelectedFile(hit.path);
          setDiffStaged(isStaged(hit) && !isUnstaged(hit));
          setDetailTab('work');
        }
        pendingChangeRelRef.current = null;
      }
      if (!quiet) setError(null);
      setRepos((prev) => {
        const k = pathKey(repoPath);
        let changed = false;
        const next = prev.map((r) => {
          if (pathKey(r.path) !== k) return r;
          const updated = {
            ...r,
            dirty: st.files.length > 0,
            branch: st.branch,
            ahead: st.ahead,
            behind: st.behind
          };
          // 仅当摘要字段真变时返回新对象，否则复用旧引用让下游 useMemo 命中缓存
          if (
            r.dirty === updated.dirty &&
            r.branch === updated.branch &&
            r.ahead === updated.ahead &&
            r.behind === updated.behind
          ) {
            return r;
          }
          changed = true;
          return updated;
        });
        return changed ? next : prev;
      });
    } catch (err) {
      if (statusGenRef.current !== gen || !activeRef.current || scopeRef.current !== scope
        || pathKey(repoPath) !== pathKey(selectedRef.current ?? '')) return;
      setRepos(prev => mergeRepoList(prev, prev.map(repo => pathKey(repo.path) === pathKey(repoPath)
        ? { ...repo, dirty: undefined, branch: undefined, ahead: undefined, behind: undefined } : repo), pathKey));
      const msg = String(err);
      setStatusRead(prev => ({ scope, repo: repoPath, error: msg,
        at: prev.scope === scope && prev.repo === repoPath ? prev.at : null }));
      // 过期选中项：清掉，避免反复 status 刷主进程日志（主进程消息已 t()，比较用同词条保证双语命中）
      if (msg.includes(t('未知仓库')) || msg.includes(t('不是 git 仓库'))) {
        setSelectedPath((prev) => (prev && pathKey(prev) === pathKey(repoPath) ? null : prev));
        setStatus(null);
        clearSelectedRepo(repoPath);
      }
      if (!quiet) setError(msg);
    } finally {
      if (statusGenRef.current === gen) setStatusLoading(false);
    }
  }, [git, scope, setStatus, pathKey, clearSelectedRepo, setSelectedPath, setError, setDetailTab, t]);

  /** Current repo first; patch other rows in cancellable two-repo batches. */
  const refreshBackground = useCallback(async (refreshSelected = true) => {
    const gen = ++backgroundGen.current;
    window.clearTimeout(backgroundTimer.current);
    const listGen = listGenRef.current;
    const valid = () => mounted.current && activeRef.current && windowFocused.current
      && scopeRef.current === scope && backgroundGen.current === gen && listGenRef.current === listGen;
    if (!valid() || !membersRef.current.length) return;
    // Start the selected read first, but a large checkout must not block all
    // smaller repos. Initial selection is already read by the selection effect.
    if (refreshSelected) void refreshStatus(selectedRef.current, true);
    // A prior batch may already have launched Git. Wait for it instead of
    // accumulating more subprocesses when focus/visibility changes rapidly.
    await backgroundFlight.current?.catch(() => undefined);
    if (!valid()) return;
    const pending = membersRef.current.map(r => r.path);
    const pump = async (): Promise<void> => {
      if (!valid()) return;
      const paths: string[] = [];
      while (pending.length && paths.length < 2) {
        const p = pending.shift()!;
        if (pathKey(p) !== pathKey(selectedRef.current ?? '') && membersRef.current.some(r => pathKey(r.path) === pathKey(p))) paths.push(p);
      }
      if (!paths.length) return;
      const flight = git.repoSummaries(paths);
      backgroundFlight.current = flight;
      try {
        const result = await flight;
        if (!valid()) return;
        if (result.workspaceId !== workspaceId || result.rootsRevision !== rootsRevision) throw new Error('workspace repository scope changed');
        const selected = pathKey(selectedRef.current ?? '');
        const updates = new Map(result.repos.filter(r => pathKey(r.path) !== selected).map(r => [pathKey(r.path), r]));
        const failed = new Set(result.issues.filter(i => pathKey(i.path) !== selected).map(i => pathKey(i.path)));
        setRepos(prev => mergeRepoList(prev, prev.map(r => {
          const key = pathKey(r.path);
          if (failed.has(key)) return { ...r, dirty: undefined, branch: undefined, ahead: undefined, behind: undefined };
          const update = updates.get(key);
          return update ? { ...r, ...update } : r;
        }), pathKey));
        setDiscovery(prev => {
          if (prev.scope !== scope) return prev;
          const refreshed = new Set([...updates.keys(), ...failed]);
          const keep = prev.issues.filter(i => i.code !== 'GIT_STATUS' || !refreshed.has(pathKey(i.path)));
          const incoming = result.issues.filter(i => pathKey(i.path) !== selected);
          return { scope, issues: [...keep, ...incoming].slice(0, 100), count: prev.count - (prev.issues.length - keep.length) + incoming.length };
        });
      } catch (error) {
        if (valid()) setError(String(error));
      } finally {
        if (backgroundFlight.current === flight) backgroundFlight.current = null;
      }
      if (valid() && pending.length) backgroundTimer.current = window.setTimeout(() => { void pump(); }, 50);
    };
    await pump();
  }, [git, scope, workspaceId, rootsRevision, refreshStatus, setError]);

  useEffect(() => () => {
    backgroundGen.current++;
    window.clearTimeout(backgroundTimer.current);
  }, [active, scope, refreshBackground]);

  const loadDiff = useCallback(
    async (repoPath: string, filePath: string, staged: boolean, untracked?: boolean) => {
      if (!mounted.current || !activeRef.current || scopeRef.current !== scope) return;
      const gen = ++diffGenRef.current;
      const selection = diffSelectionRef.current;
      setDiffLoading(true);
      try {
        const res = await git.diff(repoPath, filePath, staged, untracked);
        if (diffGenRef.current !== gen || !activeRef.current) return;
        setDiffSnapshot({ scope, selection, value: res.diff });
      } catch (err) {
        if (diffGenRef.current !== gen || !activeRef.current) return;
        setDiffSnapshot(null);
        setError(String(err));
      } finally {
        if (diffGenRef.current === gen) setDiffLoading(false);
      }
    },
    [git, scope, setError]
  );

  const onSelectFile = useCallback((f: GitFileChange, zone: 'unstaged' | 'staged') => {
    setSelectedFile(f.path);
    setDiffStaged(zone === 'staged');
  }, []);

  // 初次 / 切工作区 / 手动刷新列表（等 workspace.json 偏好就绪后再拉）
  useEffect(() => {
    if (!prefsReady || !active) return;
    if (loadedScope !== scope || loadedRequestedKey !== requestedKey) void refreshList();
  }, [refreshList, prefsReady, workspaceId, active, loadedScope, scope, loadedRequestedKey, requestedKey]);

  // 选中仓变化：重置详情 + 拉新 status；selectedRepo 持久化（同步写盘的 patch IPC）防抖 500ms，
  // 快速连续切仓只写最终值，点击路径上纯 setState
  const selectionBaseline = useRef('');
  useEffect(() => {
    // Ref hydration finishes in a microtask without causing a render. Reads must
    // follow ready/selection; otherwise a restored selection can miss status forever.
    if (!prefsReady || !active) return;
    if (selectedPath && selectionAllowed) {
      savedRepoRef.current = selectedPath;
      const identity = JSON.stringify([scope, selectedPath]);
      if (selectionBaseline.current !== identity) {
        selectionBaseline.current = identity;
        setSelectedFile(null); setDiffSnapshot(null); setBranchPopOpen(false); setStatus(null);
      }
      // 立即丢弃旧仓 status：分支条先用列表摘要（branch/dirty 徽标）乐观垫上，status 回来再校正
      setStatusLoading(true);
      void refreshStatus(selectedPath);
      const timer = window.setTimeout(() => {
        if (prefsAppliedRef.current && !fixedRepoPath) void patch({ git: { selectedRepo: selectedPath } });
      }, PATCH_REPO_DEBOUNCE_MS);
      return () => window.clearTimeout(timer);
    }
    setStatus(null); setStatusLoading(false); setDiffSnapshot(null); setDiffLoading(false); setSelectedFile(null);
    if (selectedPath) return;
    savedRepoRef.current = null;
    const timer = window.setTimeout(() => {
      if (prefsAppliedRef.current && !fixedRepoPath) void patch({ git: { selectedRepo: null } });
    }, PATCH_REPO_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [active, prefsReady, selectedPath, selectionAllowed, refreshStatus, patch, savedRepoRef, setStatus, setBranchPopOpen, prefsAppliedRef, scope, fixedRepoPath]);

  // Publish membership/selection before starting the background queue. The tree
  // remains usable while any status request is unresolved.
  useEffect(() => {
    if (active && prefsReady && loadedScope === scope && listPublication.generation) void refreshBackground(listPublication.refreshSelected);
  }, [listPublication, loadedScope, scope, active, prefsReady, refreshBackground]);

  // 选中文件 → diff
  useEffect(() => {
    if (!active) return;
    const file = status?.files.find((f) => f.path === selectedFile);
    if (!selectedPath || !file) {
      diffGenRef.current++;
      setDiffSnapshot(null);
      setDiffLoading(false);
      return;
    }
    const staged = diffStaged && isStaged(file);
    // 渲染层已持有 status，直接判断未跟踪传给主进程，避免主进程再跑一次 status
    const untracked = file.index === '?' || file.working_dir === '?';
    void loadDiff(selectedPath, file.path, staged, untracked);
  }, [active, selectedPath, selectedFile, diffStaged, status, loadDiff]);

  // 切回 Git 先刷选中仓再分批更新；磁盘变更按已有防抖策略刷新。
  useEffect(() => {
    if (active && !prevActive.current) {
      // The selection effect already refreshes the selected repository on activation.
      void refreshBackground(false);
    }
    prevActive.current = active;
    if (!active) return;

    let statusTimer: number | undefined;
    let listTimer: number | undefined;
    const off = window.api.on('fs:changed', (payload: FsChangedPayload) => {
      if (!payload || payload.workspaceId !== workspaceId) return;
      if (payload.rootsRevision !== undefined && payload.rootsRevision !== rootsRevision) return;
      if (payload.error) return;
      const source = payload.rootId === undefined ? workspaceRoots?.length === 1 ? workspaceRoots[0] : undefined
        : workspaceRoots?.find(root => root.id === payload.rootId);
      if (workspaceRoots && !source) return;
      if (!windowFocused.current) return;
      const rels = payload.relativePaths ?? [];
      if (selectedPath && changeTouchesRepo(rels, selectedPath, source?.path ?? workspacePath)) {
        // 1.5s 最小间隔节流：间隔内的触发直接丢弃（主进程已有 status TTL 缓存）
        if (Date.now() - lastFsStatusAtRef.current >= FS_STATUS_MIN_INTERVAL_MS) {
          window.clearTimeout(statusTimer);
          statusTimer = window.setTimeout(() => {
            lastFsStatusAtRef.current = Date.now();
            void refreshStatus(selectedPath, true);
          }, FS_STATUS_DEBOUNCE_MS);
        }
      }
      if (shouldRefreshRepoList(rels.filter(Boolean))) {
        window.clearTimeout(listTimer);
        listTimer = window.setTimeout(() => {
          // Topology changes are applied by the explicit repository refresh button.
          // Watcher noise refreshes summaries only, never starts a deep traversal.
          void refreshList(true, false);
        }, FS_LIST_DEBOUNCE_MS);
      } else if (rels.some((rel) => !rel)) {
        // 空路径信号（watcher filename 为空）不罕见：只做普通刷新 + 10s 冷却，不 forceRescan
        if (Date.now() - lastFsEmptyListAtRef.current >= FS_EMPTY_LIST_COOLDOWN_MS) {
          window.clearTimeout(listTimer);
          listTimer = window.setTimeout(() => {
            lastFsEmptyListAtRef.current = Date.now();
            void refreshList(true, false);
          }, FS_LIST_DEBOUNCE_MS);
        }
      }
    });
    return () => {
      off();
      window.clearTimeout(statusTimer);
      window.clearTimeout(listTimer);
    };
  }, [active, selectedPath, workspaceId, workspacePath, workspaceRoots, rootsRevision, refreshList, refreshStatus, refreshBackground]);

  // Managed worktrees are outside workspace fs.watch (legacy .worktrees is excluded too).
  // Refresh only the visible selected tree; never recursively watch every task copy.
  const selectedWorktree = repos.some((r) => r.worktree && pathKey(r.path) === pathKey(selectedPath ?? ''));
  useEffect(() => {
    if (!active || !selectedPath || !selectedWorktree) return;
    let running = false;
    const timer = window.setInterval(() => {
      if (!windowFocused.current || running) return;
      running = true;
      void refreshStatus(selectedPath, true).finally(() => { running = false; });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [active, selectedPath, selectedWorktree, refreshStatus]);

  // 窗口焦点
  useEffect(() => {
    const onFocus = () => {
      windowFocused.current = true;
      if (active) {
        void refreshBackground();
      }
    };
    const onBlur = () => {
      windowFocused.current = false;
      backgroundGen.current++;
      window.clearTimeout(backgroundTimer.current);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [active, refreshBackground]);

  return {
    repos: currentRepos,
    discoveryIssues: discovery.scope === scope ? discovery.issues : [],
    discoveryIssueCount: discovery.scope === scope ? discovery.count : 0,
    listLoading: listLoading || loadedRequestedKey !== requestedKey || loadedScope !== scope,
    status: selectionAllowed ? status : null,
    statusLoading: selectionAllowed && statusLoading,
    statusError: statusRead.scope === scope && statusRead.repo === selectedPath ? statusRead.error : null,
    statusUpdatedAt: statusRead.scope === scope && statusRead.repo === selectedPath ? statusRead.at : null,
    selectedFile,
    setSelectedFile,
    diffStaged,
    setDiffStaged,
    diffText: selectionAllowed ? visibleDiff?.value ?? '' : '',
    diffLoading: selectionAllowed && diffLoading && !visibleDiff,
    setStatus,
    setStatusLoading,
    pendingChangeRelRef,
    refreshList,
    refreshStatus,
    loadDiff,
    onSelectFile
  };
}
