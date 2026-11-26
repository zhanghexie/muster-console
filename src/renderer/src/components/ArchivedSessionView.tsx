import React, { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GuiWorkerHistoryPage } from '../../../shared/guiWorker';
import type { SessionMeta } from '../../../shared/types';

const ArchivedGuiTranscript = React.lazy(() => import('./ArchivedGuiTranscript'));

export function ArchivedSessionView({ session, chat, style }: {
  session: SessionMeta; chat: boolean; style?: React.CSSProperties;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [history, setHistory] = useState<GuiWorkerHistoryPage | null>(null);
  const [terminal, setTerminal] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    const load = chat ? window.api.agentSession.historyRange(session.id, undefined, 80)
      : window.api.sessions.archivedTerminalHistory(session.id);
    void load.then(value => {
      if (!current) return;
      if (typeof value === 'string') setTerminal(value); else setHistory(value);
    }).catch(cause => { if (current) setError(String(cause)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [chat, session.id]);

  function run(action: () => Promise<unknown>): void {
    if (busy) return;
    setBusy(true);
    setError('');
    void action().catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
  }

  return <section className="archived-session-view" style={style}>
    <header className="archived-session-header">
      <span>{t('归档历史 · 只读')}</span>
      <button className="btn small" disabled={busy || session.worktreeCleanupPending}
        onClick={() => run(() => window.api.sessions.continueArchived(session.id))}>{t('继续会话')}</button>
    </header>
    <div className="archived-session-history">
      {session.meta?.archiveWorktreeCleaned && <p>{t('隔离环境已清理。继续会话将在来源目录 {{path}} 中执行。', { path: session.cwd })}</p>}
      {session.worktreeGroups?.groups.some(group => group.cleanup?.some(entry => entry.treeRemoved)) &&
        <p>{t('原隔离环境不完整，请先处理 worktree 保留项。')}</p>}
      {error && <p role="alert">{error}</p>}
      {terminal && <pre>{terminal}</pre>}
      {history && (history.messages.length > 0 || history.hasEarlier) && <Suspense fallback={<p role="status">{t('加载中…')}</p>}>
        <ArchivedGuiTranscript session={session} history={history} onLoadEarlier={() => run(async () => {
          const previous = await window.api.agentSession.historyRange(session.id, history.before, 80);
          if (previous) setHistory({ ...previous, messages: [...previous.messages, ...history.messages] });
        })} />
      </Suspense>}
      {loading && <p role="status">{t('加载中…')}</p>}
      {!loading && !history?.messages.length && !history?.hasEarlier && !terminal && !error && <p>{t('没有可显示的归档记录')}</p>}
    </div>
  </section>;
}
