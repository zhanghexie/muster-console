import { ErrorTip } from '../components/ErrorTip';
import { isTurnFileCollision, TURN_DIFF_OMITTED, turnChangesStatusText } from '../../../shared/turnChanges';
import { turnChangeDisplayText, turnChangeFileStatus, turnChangeKindLabel } from '../turnChangeDisplay';
import { memo, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { RightContent } from '../../../shared/rightWorkspace';
import type { TurnReviewEntry } from '../../../shared/turnChanges';
import { useRightWorkspace } from '../rightWorkspace';
import { CustomSelect } from '../components/CustomSelect';
import { IconEye, IconBranch, IconRefresh } from '../components/icons';
import { TurnDiffView } from '../chatSurface/TurnDiffView';
import { TurnRevertControl } from '../chatSurface/TurnRevertControl';

type ReviewContent = Extract<RightContent, { kind: 'review' }>;
export const TurnReviewPanel = memo(function TurnReviewPanel({ content, active, onSelect }: { content: ReviewContent; active: boolean; onSelect?: (content: ReviewContent) => void }) {
  const { t } = useTranslation(), bridge = useRightWorkspace();
  const [entries, setEntries] = useState<TurnReviewEntry[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  // Hidden tabs retain selection/scroll but stop requesting data. Each effect owns its responses.
  useEffect(() => {
    if (!active) return;
    let live = true, sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const result = await window.api.turnChanges.list(content.owner);
        if (!live || request !== sequence) return;
        setEntries(result.ok ? result.entries : []); setError(result.ok ? '' : result.error ?? t('本轮改动快照不可用')); setLoading(false);
      } catch (error) { if (live && request === sequence) { setEntries([]); setError(String(error)); setLoading(false); } }
    };
    setLoading(true); void load();
    const off = content.owner.kind === 'gui'
      ? window.api.on('agentSession:event', p => { if (p.sessionId === content.owner.id && p.kind === 'sync') void load(); })
      : window.api.on('agent:message', p => { if (p.workspaceId === content.owner.id && p.turnChanges) void load(); });
    const offHistory = window.api.on('agent:history', p => { if (content.owner.kind === 'dispatch' && !Array.isArray(p) && p.workspaceId === content.owner.id) void load(); });
    return () => { live = false; off(); offHistory(); };
  }, [active, content.owner.kind, content.owner.id, refresh, t]);
  const entry = content.messageId ? entries.find(e => e.target.messageId === content.messageId) : entries[0];
  const file = entry?.summary.files.find(f => f.path === content.filePath) ?? entry?.summary.files[0];
  const select = (messageId: string, filePath?: string) => {
    const next = { ...content, messageId, filePath };
    if (onSelect) onSelect(next); else bridge?.open(next, 'keep', bridge.current?.scope ?? 'session');
  };
  const shown = bridge?.current?.content === content;
  return <section className="turn-review-panel" aria-label={t('轮次审阅')}>
    {shown && bridge?.location ? createPortal(<div className="right-git-location"><IconEye size={14}/><span className="right-full-path">{t('轮次审阅')}</span></div>, bridge.location) : null}
    {shown && bridge?.toolbar ? createPortal(<>
      <div className="right-tool-group right-mode-tools">{content.repoPath ? <button type="button" className="right-icon" title={t('工作区')} aria-label={t('工作区')} onClick={() => bridge.open({ kind: 'git', repoPath: content.repoPath! }, 'keep', bridge.current?.scope ?? 'session')}><IconBranch size={14}/></button> : null}<button type="button" className="right-icon is-on" aria-label={t('审阅')} title={t('审阅')} aria-pressed="true"><IconEye size={14}/></button></div>
      <button type="button" className="right-icon" title={t('刷新')} aria-label={t('刷新')} onClick={() => setRefresh(n => n + 1)}><IconRefresh size={14}/></button>
    </>, bridge.toolbar) : null}
    <div className="turn-review-header">
      <CustomSelect ariaLabel={t('选择审阅轮次')} value={entry?.target.messageId ?? ''} options={entries.map((e, index) => ({ value: e.target.messageId, label: `${t('轮次')} ${entries.length - index} · ${e.label || new Date(e.createdAt).toLocaleTimeString()}` }))} onChange={id => select(id)} disabled={!entries.length}/>
      {entry ? <TurnRevertControl key={entry.summary.id} summary={entry.summary} target={entry.target} onSummary={summary => setEntries(prev => prev.map(e => e.target.messageId === entry.target.messageId ? { ...e, summary } : e))}/> : null}
    </div>
    <div className="turn-review-note">{t('仅包含已捕获的工具改动，其他变化可能未记录。')}</div>
    {error ? <ErrorTip message={turnChangeDisplayText(error, t)} /> : null}
    {loading && !entries.length ? <p role="status" className="empty-hint">{t('正在读取 Diff…')}</p> : !entry ? <p className="empty-hint">{content.messageId ? t('本轮改动快照不可用') : t('该会话暂无可审阅的轮次')}</p> : <>
      {entry.summary.warnings.map(w => <p key={w} role={entry.summary.state === 'error' ? 'alert' : 'status'} className="turn-review-note">{turnChangeDisplayText(w, t, true)}</p>)}
      {entry.summary.state === 'collecting' ? <p role="status" className="empty-hint">{t(turnChangesStatusText(entry.summary))}</p> : entry.summary.state === 'error' ? <p className="empty-hint">{t('本轮改动快照不可用')}</p> : <div className="turn-review-body">
        <div className="turn-review-files" role="navigation" aria-label={t('本轮文件改动')}>{entry.summary.files.map(f => <button key={f.path} type="button" className={`turn-changes-file${file?.path === f.path ? ' is-selected' : ''}`} aria-current={file?.path === f.path ? 'true' : undefined} onClick={() => select(entry.target.messageId, f.path)} title={f.path}>
          <span className="turn-changes-path">{f.path}</span><span className="turn-changes-count">{f.diffOmitted ? t(turnChangeKindLabel(f.kind)) : <><span className="turn-added">+{f.added}</span> <span className="turn-removed">−{f.removed}</span></>}</span>{f.reverted ? <span className="turn-changes-state">{t('已回退')}</span> : null}
        </button>)}</div>
        <div className="turn-review-diff">{file ? <>
          <div className="turn-review-file-title"><strong title={file.path}>{file.path}</strong><span>{t(turnChangeFileStatus(file))}</span></div>
          {file.diffOmitted ? <p className="turn-review-note">{t(TURN_DIFF_OMITTED)}</p> : <>
            {!file.revertible && file.reason && !isTurnFileCollision(entry.summary, file) ? <p className="turn-review-note">{turnChangeDisplayText(file.reason, t)}</p> : null}
            <TurnDiffView key={`${entry.target.messageId}:${file.path}`} target={entry.target} file={file.path}/>
          </>}
        </> : <p className="empty-hint">{t('本轮没有捕获到文件改动')}</p>}</div>
      </div>}
    </>}
  </section>;
});
