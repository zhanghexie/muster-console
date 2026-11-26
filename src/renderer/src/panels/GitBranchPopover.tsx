import { ErrorTip } from '../components/ErrorTip';
import { BrandLoading } from '../components/BrandLoader';
import { useScopedGit } from './gitpanel/GitWorkspaceScope';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GitBranchInfo,
  GitBranchList,
  GitCheckoutStashMode, GitActionResult
} from '../../../shared/types';
import { useListKeyboardNav } from '../hooks/useListKeyboardNav';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { usePresence, MOTION } from '../components/motion';
import { IconRefresh } from '../components/icons';

type Tab = 'local' | 'remote';

function branchItemId(b: GitBranchInfo, tab: Tab): string {
  return tab === 'remote' ? (b.remote ?? b.ref) : b.name;
}

export function GitBranchPopover({
  repoPath,
  currentBranch,
  dirty,
  open,
  onClose,
  onChanged
}: {
  repoPath: string;
  currentBranch?: string;
  dirty: boolean;
  open: boolean;
  onClose: () => void;
  /** 操作成功回调；worktree 创建时带新 repo 路径（调用方自动选中） */
  onChanged: (newRepoPath?: string, result?: GitActionResult) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const git = useScopedGit();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>('local');
  const [query, setQuery] = useState('');
  const [list, setList] = useState<GitBranchList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    name: string;
    startPoint?: string;
    create?: boolean;
  } | null>(null);
  const [wtOpen, setWtOpen] = useState(false);
  const [wtName, setWtName] = useState('');
  const [wtBusy, setWtBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setList(await git.listBranches(repoPath));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [git, repoPath]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCreating(false);
    setNewName('');
    setPending(null);
    setTab('local');
    setActiveName(null);
    setWtOpen(false);
    setWtName('');
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (pending) return;
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [open, onClose, pending]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const src = tab === 'local' ? list?.local ?? [] : list?.remote ?? [];
    if (!q) return src;
    return src.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        b.ref.toLowerCase().includes(q) ||
        (b.remote ?? '').toLowerCase().includes(q)
    );
  }, [list, tab, query]);

  const branchIds = useMemo(
    () => filtered.map((b) => branchItemId(b, tab)),
    [filtered, tab]
  );

  useEffect(() => {
    if (branchIds.length === 0) {
      setActiveName(null);
      return;
    }
    setActiveName((prev) => {
      if (prev && branchIds.includes(prev)) return prev;
      const current = filtered.find((b) => b.current);
      return current ? branchItemId(current, tab) : branchIds[0];
    });
  }, [branchIds, filtered, tab]);

  const { onListKeyDown: onBranchNavKeyDown, getItemProps: getBranchItemProps } =
    useListKeyboardNav({
      items: branchIds,
      selectedId: activeName,
      onSelect: setActiveName,
      disabled: busy || !!pending
    });

  const runCheckout = async (
    target: { name: string; startPoint?: string; create?: boolean },
    stashMode: GitCheckoutStashMode
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await git.checkout(repoPath, {
        name: target.name,
        startPoint: target.startPoint,
        create: target.create,
        stashMode
      });
      if (res.warning) {
        const detail = [res.message, res.stashRef ? t('临时保存记录：{{ref}}', { ref: res.stashRef }) : '',
          res.conflicts?.length ? t('冲突文件：{{files}}', { files: res.conflicts.join(', ') }) : ''].filter(Boolean).join('\n');
        setPending(null);
        setError(detail);
        onChanged(undefined, { ...res, message: detail });
        return;
      }
      if (!res.ok) {
        setError(res.message ?? t('切换失败'));
        return;
      }
      setPending(null);
      onChanged();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const requestSwitch = (target: {
    name: string;
    startPoint?: string;
    create?: boolean;
  }) => {
    if (target.name === currentBranch && !target.create && !target.startPoint) {
      onClose();
      return;
    }
    if (dirty) {
      setPending(target);
      return;
    }
    void runCheckout(target, 'none');
  };

  const checkoutById = (id: string) => {
    const b = filtered.find((x) => branchItemId(x, tab) === id);
    if (!b) return;
    if (tab === 'local') {
      requestSwitch({ name: b.name });
    } else {
      requestSwitch({
        name: b.name,
        startPoint: b.remote,
        create: true
      });
    }
  };

  const onBranchListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && activeName && !busy) {
      e.preventDefault();
      checkoutById(activeName);
      return;
    }
    onBranchNavKeyDown(e);
  };

  const submitCreate = () => {
    const name = newName.trim();
    if (!name) return;
    requestSwitch({ name, create: true });
  };

  /** 在高亮分支（缺省当前分支）上新建 worktree（P3.5） */
  const submitWorktree = async () => {
    const name = wtName.trim();
    const branch =
      (tab === 'local' && activeName && list?.local.some((b) => b.name === activeName)
        ? activeName
        : null) ?? currentBranch;
    if (!name || !branch || wtBusy) return;
    setWtBusy(true);
    setError(null);
    try {
      const res = await git.worktreeAdd(repoPath, {
        dirName: `${branch}-${name}`.replace(/[\\/:*?"<>|\s]+/g, '-'),
        branch
      });
      if (!res.ok || !res.path) {
        setError(res.message ?? t('worktree 创建失败'));
        return;
      }
      setPending(null);
      onChanged(res.path);
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setWtBusy(false);
    }
  };

  // presence 进出场（mp-pop）：open 驱动，退场期间内容保留（props 在父级不变）
  const presence = usePresence(open, MOTION.menuMs);
  useOverlayDismiss(presence.mounted && presence.stage !== 'out', () => {
    if (pending) setPending(null);
    else onClose();
  });

  if (!presence.mounted) return null;

  return (
    <div
      className="git-branch-pop mp-pop"
      data-mp-stage={presence.stage}
      ref={rootRef}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {pending ? (
        <div className="git-branch-dirty">
          <div className="git-branch-dirty-title">{t('工作区有未提交更改')}</div>
          <div className="git-branch-dirty-desc">
            {t('切换到')} <code>{pending.name}</code> {t('前如何处理？')}
          </div>
          <button
            type="button"
            className="git-btn primary"
            disabled={busy}
            onClick={() => void runCheckout(pending, 'stash-reapply')}
          >
            {t('临时保存并切换后恢复')}
          </button>
          <button
            type="button"
            className="git-btn"
            disabled={busy}
            onClick={() => void runCheckout(pending, 'stash')}
          >
            {t('仅临时保存后切换')}
          </button>
          <button
            type="button"
            className="git-btn ghost"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            {t('取消')}
          </button>
          {error ? <ErrorTip message={error} /> : null}
        </div>
      ) : (
        <>
          <div className="git-branch-tabs">
            <button
              type="button"
              className={`git-btn ghost tiny${tab === 'local' ? ' is-on' : ''}`}
              onClick={() => setTab('local')}
            >
              {t('本地')}
            </button>
            <button
              type="button"
              className={`git-btn ghost tiny${tab === 'remote' ? ' is-on' : ''}`}
              onClick={() => setTab('remote')}
            >
              {t('远程')}
            </button>
            <button
              type="button"
              className="git-btn ghost tiny"
              aria-label={t('刷新')}
              disabled={loading || busy}
              onClick={() => void reload()}
            >
              {loading ? <BrandLoading size={18} /> : <IconRefresh />}
            </button>
          </div>

          {busy || wtBusy ? <BrandLoading>{t('处理中…')}</BrandLoading> : null}
          <input
            className="git-branch-search"
            type="search"
            placeholder={tab === 'local' ? t('搜索本地分支…') : t('搜索远程分支…')}
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />

          {tab === 'local' ? (
            <div className="git-branch-create">
              {creating ? (
                <>
                  <input
                    className="git-branch-search"
                    placeholder={t('基于 {{base}} 新建…', { base: currentBranch ?? t('当前') })}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submitCreate();
                      }
                      if (e.key === 'Escape') setCreating(false);
                    }}
                  />
                  <button
                    type="button"
                    className="git-btn tiny primary"
                    disabled={busy || !newName.trim()}
                    onClick={submitCreate}
                  >
                    {t('创建')}
                  </button>
                </>
              ) : wtOpen ? (
                <>
                  <input
                    className="git-branch-search"
                    placeholder={t('在分支 {{branch}} 上建 worktree，名字…', {
                      branch: activeName ?? currentBranch ?? ''
                    })}
                    value={wtName}
                    autoFocus
                    onChange={(e) => setWtName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void submitWorktree();
                      }
                      if (e.key === 'Escape') setWtOpen(false);
                    }}
                  />
                  <button
                    type="button"
                    className="git-btn tiny primary"
                    disabled={wtBusy || !wtName.trim()}
                      onClick={() => void submitWorktree()}
                    >
                      {t('建树')}
                    </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="git-btn ghost tiny"
                    onClick={() => setCreating(true)}
                  >
                    {t('＋ 基于当前分支新建')}
                  </button>
                  <button
                    type="button"
                    className="git-btn ghost tiny"
                    title={t('在选中分支上新建 worktree（不影响当前检出）')}
                      onClick={() => setWtOpen(true)}
                    >
                      {t('⎇ 在分支新建 worktree')}
                    </button>
                </>
              )}
            </div>
          ) : (
            <div className="git-branch-hint">{t('双击远程分支 → 检出为同名本地分支')}</div>
          )}

          <div
            className="git-branch-list"
            tabIndex={0}
            onKeyDown={onBranchListKeyDown}
          >
            {loading && !list ? (
              <div className="empty-hint">{t('加载中…')}</div>
            ) : filtered.length === 0 ? (
              <div className="empty-hint">{t('无匹配分支')}</div>
            ) : (
              filtered.map((b: GitBranchInfo) => {
                const id = branchItemId(b, tab);
                const label = tab === 'remote' ? (b.remote ?? b.name) : b.name;
                const isCurrent = tab === 'local' && !!b.current;
                const isActive = activeName === id;
                return (
                  <button
                    key={b.ref}
                    type="button"
                    {...getBranchItemProps(id)}
                    className={`git-branch-item${isCurrent ? ' is-current' : ''}${
                      isActive ? ' is-active' : ''
                    }`}
                    title={
                      tab === 'remote'
                        ? t('双击检出为本地「{{name}}」', { name: b.name })
                        : t('双击切换到此分支')
                    }
                    disabled={busy}
                    onDoubleClick={() => {
                      checkoutById(id);
                    }}
                  >
                    <span className="git-branch-item-name">{label}</span>
                    {isCurrent ? <span className="git-branch-badge">{t('当前')}</span> : null}
                  </button>
                );
              })
            )}
          </div>

          {error ? <ErrorTip message={error} /> : null}
          <div className="git-branch-foot">{t('↑↓ 高亮 · Enter/双击切换 · Esc 关闭')}</div>
        </>
      )}
    </div>
  );
}
