import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NATIVE_SESSION_HISTORY_ERROR_NAME, type SessionDeletePreview } from '../../../shared/sessionLifecycle';
import { AppConfirmDialog } from './AppConfirmDialog';
import { IconSpinner } from './icons';

type DeleteFailure = { id: string; fingerprint: string; name: string; message: string; canForce: boolean };

function deleteFailureDetail(error: unknown): { message: string; native: boolean } {
  const prefix = NATIVE_SESSION_HISTORY_ERROR_NAME + ': ';
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
  const native = message.startsWith(prefix);
  return { message: native ? message.slice(prefix.length) : message, native };
}

export function useSessionDeleteFlow(onFailure: (error: unknown, id?: string, intent?: 'delete') => void): {
  requestDelete: (ids: string[]) => void; deleteFlowNode: React.JSX.Element;
} {
  const { t } = useTranslation();
  const [pending, setPending] = useState<Array<SessionDeletePreview & { id: string }> | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [failure, setFailure] = useState<DeleteFailure | null>(null);
  const [results, setResults] = useState<string[] | null>(null);
  const inFlight = useRef(false);

  const requestDelete = useCallback((ids: string[]): void => {
    if (!ids.length || inFlight.current) return;
    inFlight.current = true;
    setPreviewing(true); setPending(null); setFailure(null);
    const preview = async () => {
      const targets: Array<SessionDeletePreview & { id: string }> = [];
      for (const id of ids) targets.push({ id, ...await window.api.sessions.deletePreview(id) });
      return targets;
    };
    void preview().then(setPending).catch(error => onFailure(error)).finally(() => {
      setPreviewing(false); inFlight.current = false;
    });
  }, [onFailure]);

  const applyForce = useCallback((): void => {
    const target = failure;
    if (!target?.canForce || inFlight.current) return;
    inFlight.current = true; setDeleting(true);
    void window.api.sessions.close(target.id, { fingerprint: target.fingerprint, forceWorktrees: true })
      .then(() => {
        setFailure(null);
        setResults([t('已删除「{{name}}」，worktree 和分支已强制清理', { name: target.name })]);
      })
      .catch(error => {
        const { message, native } = deleteFailureDetail(error);
        setFailure(current => current ? { ...current, message, canForce: current.canForce && !native } : current);
      })
      .finally(() => { setDeleting(false); inFlight.current = false; });
  }, [failure, t]);

  function apply(keepWorktrees: boolean): void {
    if (!pending || inFlight.current) return;
    const targets = pending;
    inFlight.current = true; setDeleting(true);
    void (async () => {
      const report: string[] = [];
      for (const target of targets) {
        try {
          await window.api.sessions.close(target.id, { fingerprint: target.fingerprint, keepWorktrees });
          report.push(t('已删除「{{name}}」', { name: target.name }));
        } catch (error) {
          const { message, native } = deleteFailureDetail(error);
          if (targets.length === 1 && (!keepWorktrees || native)) {
            setPending(null);
            setFailure({ id: target.id, fingerprint: target.fingerprint, name: target.name, message,
              canForce: !native && !!target.worktrees?.some(tree => !tree.borrowed) });
          } else if (targets.length === 1) {
            onFailure(error, target.id, 'delete');
          } else {
            report.push(t('保留「{{name}}」：{{error}}', { name: target.name, error: message }));
          }
        }
      }
      setPending(null);
      if (report.length && (targets.length > 1 || keepWorktrees)) setResults(report);
    })().finally(() => { setDeleting(false); inFlight.current = false; });
  }

  const disposition = (tree: SessionDeletePreview['worktrees'][number]): string => {
    if (tree.borrowed) return t('仅解除引用');
    switch (tree.disposition) {
      case 'keep': return t('当前需保留');
      case 'remove-directory': return t('预计删除目录并保留分支');
      case 'remove-directory-and-branch': return t('预计清理目录及已合入分支');
      default: return t('执行时复核');
    }
  };
  const detail = pending?.flatMap(target => [
    t('「{{name}}」，包含 {{n}} 个子会话', { name: target.name, n: target.descendants }),
    ...(target.active ? [t('将中断 {{n}} 个正在执行的会话。', { n: target.active })] : []),
    ...(target.nativeHistory ?? []).flatMap(scope => [
      scope.permanent
        ? t('同时永久删除 {{provider}} 中的 {{n}} 条会话记录。', { provider: scope.provider, n: scope.count })
        : t('同时从 {{provider}} 的列表移除 {{n}} 条会话记录。', { provider: scope.provider, n: scope.count }),
      ...(scope.deletesNativeChildSessions ? [t('关联的原生子会话也会删除。')] : [])
    ]),
    ...(target.worktrees ?? []).map(tree => `${tree.path}${tree.branch ? ` (${tree.branch})` : ''} · ${disposition(tree)}`)
  ]).join('\n');
  const hasOwnedTrees = pending?.some(target => (target.worktrees ?? []).some(tree => !tree.borrowed));
  const busyContent = (label: string): React.JSX.Element => (
    <div className="confirm-progress" role="status" aria-live="polite"><IconSpinner size={14} /> <span>{label}</span></div>
  );

  return { requestDelete, deleteFlowNode: <>
    <AppConfirmDialog open={previewing} title={t('检查删除范围')} detail={t('正在检查会话、worktree 和分支，请等待检查完成。')}
      confirmLabel={t('检查中')} hideCancel busy content={busyContent(t('正在读取删除范围…'))}
      onCancel={() => {}} onConfirm={() => {}} />
    <AppConfirmDialog open={!!pending} title={t('永久删除')} confirmLabel={t('永久删除')} className="session-delete-confirm" danger focusCancel
      busy={deleting}
      detail={detail && [detail, hasOwnedTrees && t('将安全清理可移除的目录，未合入分支会保留。遇到无法安全清理的目录时，会话保留。'), t('删除后无法恢复会话历史。')].filter(Boolean).join('\n\n')}
      content={deleting ? busyContent(t('正在删除会话并清理 worktree，请等待…')) : undefined}
      alternate={!deleting && hasOwnedTrees ? { label: t('删除会话，保留 worktree'), onClick: () => apply(true) } : undefined}
      onCancel={() => { if (!deleting) setPending(null); }} onConfirm={() => apply(false)} />
    <AppConfirmDialog open={!!failure} title={t('删除失败')} className="session-delete-confirm" danger={failure?.canForce}
      focusCancel={failure?.canForce} busy={deleting}
      detail={failure ? [t('「{{name}}」没有删除成功。', { name: failure.name }), failure.message,
        ...(failure.canForce ? [t('可以强制删除 worktree 和分支。此操作会永久删除目录、未提交改动和未合入提交。')] : [])].join('\n\n') : undefined}
      confirmLabel={failure?.canForce ? t('强制删除 worktree 和分支') : t('知道了')} cancelLabel={t('关闭')} hideCancel={!failure?.canForce}
      content={deleting ? busyContent(t('正在强制删除 worktree 和分支，请等待…')) : undefined}
      onCancel={() => { if (!deleting) setFailure(null); }} onConfirm={failure?.canForce ? applyForce : () => setFailure(null)} />
    <AppConfirmDialog open={!!results} title={t('删除结果')} detail={results?.join('\n')}
      confirmLabel={t('知道了')} hideCancel onConfirm={() => setResults(null)} onCancel={() => setResults(null)} />
  </> };
}
