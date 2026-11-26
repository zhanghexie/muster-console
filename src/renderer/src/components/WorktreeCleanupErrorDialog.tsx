import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionMeta } from '../../../shared/types';
import { AppConfirmDialog } from './AppConfirmDialog';

const UNKNOWN_DIRECTORY = 'unregistered directory at the task path; ownership is unknown';
export type WorktreeCleanupFailure = { message: string; sessionId?: string; path?: string; intent?: 'delete' };
const normalized = (value: string) => value.replaceAll('\\', '/').toLowerCase();

export function worktreeCleanupFailure(error: unknown, session?: SessionMeta, intent?: 'delete'): WorktreeCleanupFailure {
  const message = error instanceof Error ? error.message : String(error);
  const paths = session?.worktreeGroups?.groups.map(group => group.path) ?? (session?.worktreePath ? [session.worktreePath] : []);
  const path = message.includes(UNKNOWN_DIRECTORY) ? paths.find(candidate => normalized(message).includes(normalized(candidate))) : undefined;
  return { message, intent, ...(session ? { sessionId: session.id } : {}), ...(path ? { path } : {}) };
}

export function WorktreeCleanupErrorDialog({ failure, onClose, onFailure, onRetryDelete }: {
  failure: WorktreeCleanupFailure | null;
  onClose: () => void;
  onFailure: (error: unknown) => void;
  onRetryDelete?: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [force, setForce] = useState<{ sessionId: string; token: string; path: string; branch: string; intent?: 'delete' } | null>(null);
  const canForce = !!failure?.sessionId && !!failure.path;
  const detail = (failure?.message ?? '').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(UNKNOWN_DIRECTORY, t('该目录未登记为 Git worktree，无法确认归属'));
  return <>
    <AppConfirmDialog open={!!failure} className="worktree-cleanup-error" title={t('删除或清理失败')} detail={detail}
      confirmLabel={canForce ? t('强制删除目录') : t('知道了')} cancelLabel={t('知道了')} hideCancel={!canForce} danger={canForce}
      onCancel={onClose} onConfirm={() => {
        if (!failure?.sessionId || !failure.path) { onClose(); return; }
        const { sessionId, path } = failure;
        onClose();
        void window.api.sessions.previewForceRemoveUnregistered(sessionId, path)
          .then(result => setForce({ sessionId, ...result, intent: failure.intent })).catch(onFailure);
      }} />
    <AppConfirmDialog open={!!force} className="worktree-cleanup-error" title={t('强制删除遗留目录')}
      detail={t('将永久删除以下目录及其中所有文件，包括未提交和被忽略的文件：\n{{path}}\n\n分支 {{branch}} 将保留。此操作不可撤销。', { path: force?.path ?? '', branch: force?.branch ?? '' })}
      confirmLabel={t('强制删除目录')} danger onCancel={() => setForce(null)} onConfirm={() => {
        if (!force) return;
        const { sessionId, token, intent } = force;
        setForce(null);
        void window.api.sessions.forceRemoveUnregistered(sessionId, token).then(result => {
          if (!result.ok) throw new Error(result.message || t('清理 worktree 失败'));
          if (intent === 'delete') onRetryDelete?.(sessionId);
        }).catch(onFailure);
      }} />
  </>;
}
