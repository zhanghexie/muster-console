import { useGitWorkspaceScope, useScopedGit } from './GitWorkspaceScope';
/**
 * GitPanel 部分采纳 + diff 评论 + 开 PR 流程层（2026-09-26 GitPanel.tsx → gitpanel/ 拆分，行为保持）：
 * - 部分采纳（T5.5）：worktree diff 按 hunk 勾选 → 原子落主仓；
 * - diff 评论（T1.7）：勾行草稿 → buildPrReviewBrief → 注入 Worker 会话；
 * - 开 PR：先定位 GitHub 目标和推送仓，创单后打开工作台详情。
 * 原面板文件内的对应片段原样迁出；切仓自动退出采纳/评论的 effect 时序保持。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GitAdoptPreviewResult, GitRepoStatus } from '../../../../shared/types';
import type { PrRef, PrRepository } from '../../../../shared/githubPr';
import type { GitAdoptHunkKey } from '../../../../shared/types';
import { adoptHunkKeyId } from '../../../../shared/gitAdopt';
import {
  buildPrReviewBrief,
  matchWorkerSessionForRepo,
  type PrReviewComment
} from '../../../../shared/prReviewBrief';
import { useUiStore } from '../../store';
import type { DetailTab } from './gitPanelPure';

type SessionLike = Parameters<typeof matchWorkerSessionForRepo>[0][number];

export type GitAdoptCommentsApi = {
  // ---------- 部分采纳（T5.5）----------
  /** 采纳模式开启（diff 区切换为 worktree 全量 diff 勾选视图） */
  adoptOpen: boolean;
  adoptPreview: GitAdoptPreviewResult | null;
  /** 勾选中的 hunk：id → 键对象（采纳时直接取 values，免反序列化） */
  adoptSel: Map<string, GitAdoptHunkKey>;
  adoptSelIds: Set<string>;
  adoptLoading: boolean;
  adoptConfirmOpen: boolean;
  setAdoptConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggleAdoptMode: () => void;
  toggleAdoptHunk: (k: GitAdoptHunkKey, checked: boolean) => void;
  toggleAdoptFile: (keys: GitAdoptHunkKey[], checked: boolean) => void;
  doAdopt: () => void;
  // ---------- T1.7：diff 评论模式 ----------
  commentMode: boolean;
  setCommentMode: React.Dispatch<React.SetStateAction<boolean>>;
  diffComments: PrReviewComment[];
  setDiffComments: React.Dispatch<React.SetStateAction<PrReviewComment[]>>;
  commentSending: boolean;
  commentWorker: SessionLike | null;
  pickDiffLine: (pick: { file: string; line: number; original: string }) => void;
  sendDiffComments: () => void;
  // ---------- 开 PR（T1.6）----------
  prDialogOpen: boolean;
  setPrDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  prDetecting: boolean;
  prRepository: PrRepository | null;
  createdPr: PrRef | null;
  openPrFlow: () => void;
  onPrCreated: (pr: PrRef) => void;
};

export function useGitAdoptComments({
  selectedPath,
  visibleSessions,
  status,
  busy,
  setBusy,
  setError,
  refreshList,
  setSelectedPath,
  setDetailTab
}: {
  selectedPath: string | null;
  visibleSessions: SessionLike[];
  status: GitRepoStatus | null;
  busy: boolean;
  setBusy: React.Dispatch<React.SetStateAction<boolean>>;
  setError: (e: string | null) => void;
  refreshList: (quiet?: boolean, forceRescan?: boolean) => Promise<void>;
  setSelectedPath: React.Dispatch<React.SetStateAction<string | null>>;
  setDetailTab: (tab: DetailTab) => void;
}): GitAdoptCommentsApi {
  const { t } = useTranslation();
  const git = useScopedGit();
  const workspace = useGitWorkspaceScope();
  const { flashTip } = useUiStore();
  const [adoptOpen, setAdoptOpen] = useState(false);
  const [adoptPreview, setAdoptPreview] = useState<GitAdoptPreviewResult | null>(null);
  /** 勾选中的 hunk：id → 键对象（采纳时直接取 values，免反序列化） */
  const [adoptSel, setAdoptSel] = useState<Map<string, GitAdoptHunkKey>>(new Map());
  const [adoptLoading, setAdoptLoading] = useState(false);
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false);
  const adoptGenRef = useRef(0);
  // ---------- T1.7：diff 评论模式 ----------
  const [commentMode, setCommentMode] = useState(false);
  const [diffComments, setDiffComments] = useState<PrReviewComment[]>([]);
  const [commentSending, setCommentSending] = useState(false);
  const commentIdRef = useRef(0);
  const [prDialogOpen, setPrDialogOpen] = useState(false);
  const [prDetecting, setPrDetecting] = useState(false);
  const [prRepository, setPrRepository] = useState<PrRepository | null>(null);
  const [createdPr, setCreatedPr] = useState<PrRef | null>(null);
  const prKey = JSON.stringify([workspace.workspaceId, workspace.rootsRevision, selectedPath, status?.branch]);
  const prOwner = useRef(prKey);
  prOwner.current = prKey;
  useEffect(() => {
    setPrDialogOpen(false);
    setPrDetecting(false);
    setPrRepository(null);
    setCreatedPr(null);
  }, [prKey]);

  const loadAdoptPreview = useCallback(async (wtPath: string) => {
    const gen = ++adoptGenRef.current;
    setAdoptLoading(true);
    try {
      const res = await git.adoptPreview(wtPath);
      if (adoptGenRef.current !== gen) return;
      if (!res.ok) {
        setError(res.message ?? t('读取采纳预览失败'));
        setAdoptOpen(false);
        setAdoptPreview(null);
        return;
      }
      setAdoptPreview(res);
      setAdoptSel(new Map());
    } catch (err) {
      if (adoptGenRef.current !== gen) return;
      setError(String(err));
      setAdoptOpen(false);
    } finally {
      if (adoptGenRef.current === gen) setAdoptLoading(false);
    }
  }, [git, t, setError]);

  const toggleAdoptMode = useCallback(() => {
    if (adoptOpen) {
      setAdoptOpen(false);
      setAdoptPreview(null);
      setAdoptSel(new Map());
      return;
    }
    if (!selectedPath) return;
    setAdoptOpen(true);
    void loadAdoptPreview(selectedPath);
  }, [adoptOpen, selectedPath, loadAdoptPreview]);

  // 切仓自动退出采纳模式（含采纳成功后切到主仓）
  useEffect(() => {
    setAdoptOpen(false);
    setAdoptPreview(null);
    setAdoptSel(new Map());
    adoptGenRef.current += 1;
    setAdoptLoading(false);
  }, [selectedPath]);

  const toggleAdoptHunk = useCallback((k: GitAdoptHunkKey, checked: boolean) => {
    const id = adoptHunkKeyId(k);
    setAdoptSel((prev) => {
      const next = new Map(prev);
      if (checked) next.set(id, k);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleAdoptFile = useCallback((keys: GitAdoptHunkKey[], checked: boolean) => {
    setAdoptSel((prev) => {
      const next = new Map(prev);
      for (const k of keys) {
        if (checked) next.set(adoptHunkKeyId(k), k);
        else next.delete(adoptHunkKeyId(k));
      }
      return next;
    });
  }, []);

  /** 采纳执行：成功后退出模式、切到主仓看 staged 结果（不自动 commit） */
  const doAdopt = useCallback(() => {
    setAdoptConfirmOpen(false);
    const wt = selectedPath;
    if (!wt || adoptSel.size === 0 || busy) return;
    const keys = [...adoptSel.values()];
    const gen = adoptGenRef.current;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await git.adoptHunks(wt, keys);
        if (adoptGenRef.current !== gen) return;
        if (!res.ok) {
          setError(res.message);
          return;
        }
        setAdoptOpen(false);
        setAdoptPreview(null);
        setAdoptSel(new Map());
        await refreshList(true);
        if (adoptGenRef.current !== gen) return;
        if (res.targetRepo) setSelectedPath(res.targetRepo);
      } catch (err) {
        if (adoptGenRef.current !== gen) return;
        setError(String(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [git, selectedPath, adoptSel, busy, refreshList, setBusy, setError, setSelectedPath]);

  /** Map keys → Set（AdoptDiffView 勾选态 prop），只在勾选集真变时重建 */
  const adoptSelIds = useMemo(() => new Set(adoptSel.keys()), [adoptSel]);

  const commentWorker = useMemo(() => {
    if (!selectedPath) return null;
    return matchWorkerSessionForRepo(visibleSessions, selectedPath);
  }, [visibleSessions, selectedPath]);

  const commentKey = JSON.stringify([selectedPath, commentWorker]);
  const commentOwnerRef = useRef({ key: commentKey });
  if (commentOwnerRef.current.key !== commentKey) commentOwnerRef.current = { key: commentKey };
  const commentMounted = useRef(true);
  useEffect(() => { commentMounted.current = true; return () => { commentMounted.current = false; }; }, []);

  useEffect(() => {
    setCommentMode(false);
    setDiffComments([]);
    setCommentSending(false);
  }, [commentKey]);

  const pickDiffLine = useCallback(
    (pick: { file: string; line: number; original: string }) => {
      setCommentMode(true);
      setDiffComments((prev) => [
        ...prev,
        {
          id: `c${++commentIdRef.current}`,
          file: pick.file,
          line: pick.line,
          original: pick.original,
          body: '',
          status: 'draft'
        }
      ]);
    },
    []
  );

  const sendDiffComments = useCallback((): void => {
    if (!selectedPath || commentSending) return;
    const worker = matchWorkerSessionForRepo(visibleSessions, selectedPath);
    if (!worker) {
      flashTip(t('当前仓库没有对应的 Worker 会话（需隔离 worktree 或 cwd 匹配）'));
      return;
    }
    const pending = diffComments.filter((c) => c.status === 'draft' && c.body.trim());
    const task = buildPrReviewBrief(pending, worker);
    if (!task) {
      flashTip(t('没有可发送的评论'));
      return;
    }
    setCommentSending(true);
    const owner = commentOwnerRef.current;
    const isCurrent = () => commentMounted.current && commentOwnerRef.current === owner;
    void (async () => {
      try {
        const res = await window.api.sessions.sendMessage({ sessionId: worker.id, text: task });
        if (!isCurrent()) return;
        if (!res.ok) {
          flashTip(res.message);
          return;
        }
        const ids = new Set(pending.map((c) => c.id));
        setDiffComments((prev) =>
          prev.map((c) => (ids.has(c.id) ? { ...c, status: 'sent' as const } : c))
        );
        flashTip(t('评论已发给 {{name}}', { name: worker.name ?? worker.id }));
      } catch (err) {
        if (!isCurrent()) return;
        flashTip(String(err));
      } finally {
        if (isCurrent()) setCommentSending(false);
      }
    })();
  }, [selectedPath, diffComments, commentSending, visibleSessions, flashTip, t]);

  const openPrFlow = useCallback((): void => {
    if (!selectedPath || busy || prDetecting) return;
    // 目标分支只能用选中仓的当前分支（worktree 仓的 status 即隔离分支）
    if (!status?.branch) {
      setError(t('当前仓库还没有可推送的分支'));
      return;
    }
    setPrDetecting(true);
    void (async () => {
      try {
        const target = await window.api.pr.repository({ ...workspace, repoPath: selectedPath });
        if (prOwner.current !== prKey) return;
        if (!target.ok) {
          flashTip(target.message);
          setDetailTab('pr');
          return;
        }
        if (!target.value.pushRepository) {
          flashTip(t('当前仓库没有唯一的 GitHub 推送目标'));
          return;
        }
        setPrRepository(target.value);
        setPrDialogOpen(true);
      } catch (err) {
        if (prOwner.current === prKey) flashTip(String(err));
      } finally {
        if (prOwner.current === prKey) setPrDetecting(false);
      }
    })();
  }, [selectedPath, busy, prDetecting, status?.branch, flashTip, t, setError, setDetailTab, workspace, prKey]);

  const onPrCreated = useCallback(
    (pr: PrRef): void => {
      if (prOwner.current !== prKey) return;
      setPrDialogOpen(false);
      flashTip(t('已创建 PR #{{n}}', { n: pr.number }));
      setCreatedPr(pr);
      setDetailTab('pr');
    },
    [flashTip, t, setDetailTab, prKey]
  );

  return {
    adoptOpen,
    adoptPreview,
    adoptSel,
    adoptSelIds,
    adoptLoading,
    adoptConfirmOpen,
    setAdoptConfirmOpen,
    toggleAdoptMode,
    toggleAdoptHunk,
    toggleAdoptFile,
    doAdopt,
    commentMode,
    setCommentMode,
    diffComments,
    setDiffComments,
    commentSending,
    commentWorker,
    pickDiffLine,
    sendDiffComments,
    prDialogOpen,
    setPrDialogOpen,
    prDetecting,
    prRepository,
    createdPr,
    openPrFlow,
    onPrCreated
  };
}
