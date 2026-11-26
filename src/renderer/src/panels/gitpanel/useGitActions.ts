import { useScopedGit } from './GitWorkspaceScope';
/**
 * 本地 Git 动作：完成后只刷新当前仓，动作错误独立于数据读取错误保存。
 * busy 由面板协调；丢弃确认冻结仓路径、范围与文件清单，未暂存区保留 index。
 * 远端命令及共享回执由 useGitRemote 管理。
 */
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitFileChange, GitActionResult, GitDiscardMode } from '../../../../shared/types';
import type { ContextMenuPoint } from '../../components/ContextMenu';
import type { GitChangeContextTarget } from '../GitChangeTree';
import { joinRepoRel } from './gitPanelPure';

export type ChangeCtxMenuState = (ContextMenuPoint & {
  zone: 'unstaged' | 'staged';
  paths: string[];
  revealAbsPath: string;
}) | null;

export type GitActionApi = {
  actionError: string | null;
  reportWarning: (message: string) => void;
  runAction: (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<void>;
  commitWithMessage: (msg: string) => Promise<boolean>;
  stagePaths: (paths: string[]) => void;
  unstagePaths: (paths: string[]) => void;
  changeCtxMenu: ChangeCtxMenuState;
  setChangeCtxMenu: React.Dispatch<React.SetStateAction<ChangeCtxMenuState>>;
  openChangeCtxMenu: (e: React.MouseEvent, target: GitChangeContextTarget) => void;
  onChangeCtxSelect: (id: string) => void;
  changeCtxItems: { id: string; label: string; danger?: boolean }[];
  discardConfirm: DiscardConfirmation | null;
  setDiscardConfirm: React.Dispatch<React.SetStateAction<DiscardConfirmation | null>>;
};

export type DiscardConfirmation = { repoPath: string; paths: string[]; mode: GitDiscardMode; newFiles: number };

export function useGitActions({
  selectedPath,
  busy,
  setBusy,
  setError,
  refreshStatus,
  onSelectFile,
  files = []
}: {
  selectedPath: string | null;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  refreshStatus: (repoPath: string | null, quiet?: boolean) => Promise<void>;
  onSelectFile: (f: GitFileChange, zone: 'unstaged' | 'staged') => void;
  files?: GitFileChange[];
}): GitActionApi {
  const { t } = useTranslation();
  const git = useScopedGit();
  const [changeCtxMenu, setChangeCtxMenu] = useState<ChangeCtxMenuState>(null);
  const [discardConfirm, setDiscardConfirm] = useState<DiscardConfirmation | null>(null);
  const [actionFailure, setActionFailure] = useState<{ repo: string | null; message: string } | null>(null);
  const setActionError = useCallback((message: string | null) => setActionFailure(message ? { repo: selectedPath, message } : null), [selectedPath]);

  const runAction = useCallback(
    async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
      if (!selectedPath || busy) return;
      setBusy(true);
      setActionError(null);
      try {
        const res = await fn();
        if (!res.ok || (res as GitActionResult).warning) setActionError(res.message ?? t('操作失败'));
        // 单仓操作（stage/commit/pull/push 等）只刷当前仓 status；
        // refreshStatus 内部会 patch repos 数组对应项，无需全量 listRepos。
        await refreshStatus(selectedPath);
      } catch (err) {
        setActionError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [selectedPath, busy, refreshStatus, setBusy, setActionError, t]
  );

  /** 提交：CommitBar 只拿布尔结果（commit IPC 一返回即清输入），busy/错误仍由 runAction 管 */
  const commitWithMessage = useCallback(
    (msg: string): Promise<boolean> => {
      if (!selectedPath) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        void runAction(async () => {
          const res = await git.commit(selectedPath, msg);
          settled = true;
          resolve(res.ok);
          return res;
        }).then(() => {
          // runAction 因 busy 被跳过时也要放行
          if (!settled) resolve(false);
        });
      });
    },
    [git, selectedPath, runAction]
  );

  const stagePaths = useCallback(
    (paths: string[]) => {
      if (!selectedPath) return;
      void runAction(() => git.stage(selectedPath, paths));
    },
    [git, selectedPath, runAction]
  );

  const unstagePaths = useCallback(
    (paths: string[]) => {
      if (!selectedPath) return;
      void runAction(() => git.unstage(selectedPath, paths));
    },
    [git, selectedPath, runAction]
  );

  const openChangeCtxMenu = useCallback(
    (e: React.MouseEvent, target: GitChangeContextTarget) => {
      if (busy || !selectedPath) return;
      if (target.kind === 'file' && target.file) {
        onSelectFile(target.file, target.zone);
      }
      setChangeCtxMenu({
        x: e.clientX,
        y: e.clientY,
        anchor: e.currentTarget,
        zone: target.zone,
        paths: target.paths,
        revealAbsPath: joinRepoRel(selectedPath, target.revealRelPath)
      });
    },
    [busy, selectedPath, onSelectFile]
  );

  const onChangeCtxSelect = useCallback(
    (id: string) => {
      if (!changeCtxMenu || !selectedPath) return;
      const { paths, revealAbsPath } = changeCtxMenu;
      if (id === 'stage') {
        stagePaths(paths);
        return;
      }
      if (id === 'unstage') {
        unstagePaths(paths);
        return;
      }
      if (id === 'reveal') {
        void (async () => {
          setError(null);
          const res = await window.api.shell.revealPath(revealAbsPath);
          if (!res.ok) setError(res.error ?? t('无法打开路径'));
        })();
        return;
      }
      if (id === 'discard') {
        const mode = changeCtxMenu.zone === 'unstaged' ? 'unstaged' : 'all';
        setDiscardConfirm({ repoPath: selectedPath, paths: [...paths], mode,
          newFiles: files.filter(f => paths.includes(f.path) && (f.index === '?' || f.working_dir === '?' || (mode === 'all' && f.index === 'A'))).length });
      }
    },
    [changeCtxMenu, selectedPath, stagePaths, unstagePaths, runAction, setError, files, t]
  );

  const changeCtxItems = useMemo(() => {
    if (!changeCtxMenu) return [];
    // 多选聚合操作时标签带计数；reveal 逐项开窗口会炸屏，仅单项提供
    const n = changeCtxMenu.paths.length;
    const withCount = (single: string): string =>
      n > 1 ? t('{{action}}（{{n}} 项）', { action: single, n }) : single;
    const items: { id: string; label: string; danger?: boolean }[] = [
      changeCtxMenu.zone === 'unstaged'
        ? { id: 'stage', label: withCount(t('暂存')) }
        : { id: 'unstage', label: withCount(t('取消暂存')) }
    ];
    if (n <= 1) {
      items.push({ id: 'reveal', label: t('在资源管理器中打开') });
    }
    items.push({
      id: 'discard',
      label: withCount(
        changeCtxMenu.zone === 'unstaged' ? t('丢弃未暂存改动') : t('丢弃全部改动')
      ),
      danger: true
    });
    return items;
  }, [changeCtxMenu, t]);

  return {
    actionError: actionFailure?.repo === selectedPath ? actionFailure?.message ?? null : null,
    reportWarning: setActionError,
    runAction,
    commitWithMessage,
    stagePaths,
    unstagePaths,
    changeCtxMenu,
    setChangeCtxMenu,
    openChangeCtxMenu,
    onChangeCtxSelect,
    changeCtxItems,
    discardConfirm,
    setDiscardConfirm
  };
}
