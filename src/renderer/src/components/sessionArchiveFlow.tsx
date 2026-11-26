import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMeta } from '../../../shared/types';
import type { ArchiveSelectionHint } from '../../../shared/workspaceActiveSession';
import { AppConfirmDialog } from './AppConfirmDialog';
import { archiveAffectedSessions, sessionMayInterrupt } from '../../../shared/sessionLifecycle';

/** Desktop archive entry points share the interruption and worktree confirmation. */
export function useArchiveFlow(sessions: readonly SessionMeta[] = []): {
  requestArchive: (s: SessionMeta, archived: boolean, selectionHint?: ArchiveSelectionHint, processed?: boolean) => void;
  /** 挂在组件任意位置的确认框节点 */
  archiveFlowNode: React.JSX.Element | null;
} {
  const [pending, setPending] = useState<{ session: SessionMeta; selectionHint?: ArchiveSelectionHint; active: string[]; hasWorktree: boolean; processed?: boolean } | null>(null);
  const [failures, setFailures] = useState<Array<{ archived: boolean; message: string }>>([]);
  const { t } = useTranslation();
  const apply = useCallback((session: SessionMeta, archived: boolean, selectionHint?: ArchiveSelectionHint, active?: string[], processed?: boolean, hasWorktree = false): void => {
    const report = (error: unknown): void => {
      const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
      setFailures(items => [...items, { archived, message }]);
    };
    try {
      const result = processed ? (active?.length ? window.api.sessions.markProcessed(session.id, active) : window.api.sessions.markProcessed(session.id))
        : active?.length ? window.api.sessions.setArchived(session.id, archived, selectionHint, active)
          : selectionHint ? window.api.sessions.setArchived(session.id, archived, selectionHint)
            : window.api.sessions.setArchived(session.id, archived);
      void Promise.resolve(result).then(value => {
        if (Array.isArray(value?.archiveConfirmation)) setPending({ session, selectionHint, active: value.archiveConfirmation, processed, hasWorktree });
      }).catch(report);
    } catch (error) { report(error); }
  }, []);
  const requestArchive = useCallback((s: SessionMeta, archived: boolean, selectionHint?: ArchiveSelectionHint, processed?: boolean): void => {
    const affected = archiveAffectedSessions(sessions.some(row => row.id === s.id) ? sessions : [...sessions, s], s.id);
    const active = affected.filter(row => sessionMayInterrupt(row)).map(row => row.id);
    const hasWorktree = affected.some(row => row.worktreePath || row.worktreeGroups?.groups.length);
    if (!archived || (!active.length && !hasWorktree)) {
      apply(s, archived, selectionHint, undefined, processed);
      return;
    }
    setPending({ session: s, selectionHint, active, processed, hasWorktree });
  }, [apply, sessions]);
  const failure = failures[0];
  const dismissFailure = (): void => setFailures(items => items.slice(1));
  const archiveFlowNode = (
    <AppConfirmDialog
      open={!!failure || !!pending}
      title={failure ? failure.archived ? t('会话归档失败') : t('会话恢复失败') : pending?.active.length ? t('停止并归档？') : t('归档隔离会话')}
      detail={failure?.message ?? (pending ? [
        pending.active.length ? t('归档「{{name}}」会中断 {{n}} 个正在执行的会话。', { name: pending.session.name, n: pending.active.length }) : '',
        pending.hasWorktree ? t('归档保留聊天历史。隔离目录会按 Git 状态安全清理，未提交改动和未合入分支会保留。') : t('归档会保留聊天历史。')
      ].filter(Boolean).join('\n') : undefined)}
      confirmLabel={failure ? t('知道了') : pending?.active.length ? t('停止并归档') : t('归档')}
      hideCancel={!!failure}
      danger={!failure}
      focusCancel
      onCancel={() => { if (failure) dismissFailure(); else setPending(null); }}
      onConfirm={() => {
        if (failure) { dismissFailure(); return; }
        if (!pending) return;
        const { session, selectionHint, active, processed, hasWorktree } = pending;
        setPending(null);
        apply(session, true, selectionHint, active, processed, hasWorktree);
      }}
    />
  );
  return { requestArchive, archiveFlowNode };
}
