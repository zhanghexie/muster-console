import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { SessionMeta } from '../../../shared/types';
import { sessionWorktreeGroups } from '../../../shared/sessionWorktrees';
import { AppConfirmDialog } from './AppConfirmDialog';

export function hasRetainedWorktree(session: SessionMeta): boolean {
  return !!session.archived && (!!session.worktreePath || !!session.worktreeGroups?.groups.length);
}

export function archivedWorktreeLabel(session: SessionMeta, t: TFunction): string | undefined {
  if (!session.archived) return undefined;
  if (hasRetainedWorktree(session)) return session.worktreeCleanupPending ? t('worktree 清理中') : t('worktree 有保留项');
  return session.meta?.archiveWorktreeCleaned ? t('worktree 已清理') : undefined;
}

export function useSessionWorktreeFlow(sessions: readonly SessionMeta[], reportError: (error: unknown, id?: string) => void) {
  const { t } = useTranslation();
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const session = sessions.find(row => row.id === id);
  const groups = session && sessionWorktreeGroups(session)?.groups;
  const lines = groups?.flatMap(group => [group.path, ...(group.cleanup ?? []).map(entry =>
    `${entry.repo || '.'} (${entry.branch}) · ${entry.treeRemoved ? t('目录已清理') : t('目录已保留')}${entry.message ? ` · ${entry.message}` : ''}`)]);
  const path = groups?.[0]?.path ?? session?.worktreePath;
  const blocked = !session || !hasRetainedWorktree(session) || session.worktreeCleanupPending || busy;
  function close(): void { setId(null); setResult(''); }
  return { showWorktree: (sessionId: string) => { setResult(''); setId(sessionId); }, worktreeFlowNode: <AppConfirmDialog
    open={!!session} title={t('worktree 清理详情')} detail={[session?.name, ...(lines?.length ? lines : path ? [path] : []),
      session && archivedWorktreeLabel(session, t), session?.meta?.worktreeCleanupIssue, result].filter(Boolean).join('\n')}
    cancelLabel={t('关闭')} confirmLabel={blocked ? t('知道了') : t('重试安全清理')}
    alternate={path ? { label: t('打开目录'), onClick: () => void window.api.shell.openPath(path).then(response => {
      if (!response.ok) setResult(response.error ?? t('目录不存在'));
    }).catch(error => setResult(String(error))) } : undefined}
    onCancel={close} onConfirm={() => {
      if (busy) return;
      if (blocked || !session) { close(); return; }
      setBusy(true);
      void window.api.sessions.cleanupArchivedWorktree(session.id).then(response => {
        setResult(response.message ?? (response.ok ? t('worktree 已清理') : t('清理 worktree 失败')));
      }).catch(error => reportError(error, session.id)).finally(() => setBusy(false));
    }} /> };
}
