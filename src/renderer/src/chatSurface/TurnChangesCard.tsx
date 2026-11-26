import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnChanges, TurnChangeTarget } from '../../../shared/turnChanges';
import { turnChangeDisplayText, turnChangeFileStatus, turnChangeKindLabel } from '../turnChangeDisplay';
import { MOTION, usePresence } from '../components/motion';
import { IconDiff, IconInfo, IconChevronDown, IconChevronUp } from '../components/icons';
import { TurnDiffPreview, type TurnDiffAnchor } from './TurnDiffPreview';
import { TurnRevertControl } from './TurnRevertControl';
import { openTurnReview } from './turnReviewNavigation';
import { TurnSnapshotVisibility } from './TurnSnapshotVisibility';

export function TurnChangesCard({ summary, target }: { summary: TurnChanges; target: TurnChangeTarget }) {
  const { t } = useTranslation();
  const visibility = useContext(TurnSnapshotVisibility);
  const [local, setLocal] = useState(summary);
  const [hover, setHover] = useState<TurnDiffAnchor | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const expanded = expandedId === local.id;
  const extraPresence = usePresence(expanded, MOTION.exitMs);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelTimer = useCallback(() => clearTimeout(timer.current), []);
  const close = useCallback(() => { cancelTimer(); setHover(null); }, [cancelTimer]);
  const leave = useCallback(() => { cancelTimer(); timer.current = setTimeout(close, MOTION.microMs); }, [cancelTimer, close]);
  useEffect(() => { setLocal(summary); }, [summary]);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (local.state !== 'ready' || !local.files.length || (visibility &&
    (visibility.owner.kind !== target.kind || visibility.owner.id !== target.id || visibility.id !== local.id || visibility.messageId !== target.messageId))) {
    return null;
  }
  const totals = local.files.every(file => !file.diffOmitted) && local.files.reduce((sum, file) =>
    ({ added: sum.added + (file.added ?? 0), removed: sum.removed + (file.removed ?? 0) }), { added: 0, removed: 0 });
  const rows = local.files.map(file => <button key={file.path} type="button" className="turn-changes-file"
        onMouseEnter={e => { cancelTimer(); const element = e.currentTarget; timer.current = setTimeout(() => setHover({ file: file.path, diffOmitted: file.diffOmitted, element }), MOTION.menuMs); }}
        onMouseLeave={leave} onFocus={e => { cancelTimer(); setHover({ file: file.path, diffOmitted: file.diffOmitted, element: e.currentTarget }); }} onBlur={leave}
        onClick={() => { close(); openTurnReview(target, file.path); }}>
        <span className="turn-changes-path">{file.path}</span>
        <span className="turn-changes-count">{file.diffOmitted ? t(turnChangeKindLabel(file.kind)) : <><span className="turn-added">+{file.added}</span> <span className="turn-removed">−{file.removed}</span></>}</span>
        <span className="turn-changes-state">{t(turnChangeFileStatus(file))}</span>
      </button>);
  return <section className="turn-changes-card" aria-label={t('本轮文件改动')}>
    <div className="turn-changes-header chat-card-header">
      <div className="turn-changes-summary">
        <span className="turn-changes-icon chat-card-header-icon" aria-hidden="true"><IconDiff size={18}/></span>
        <div className="turn-changes-heading">
          <strong>{t('本轮改动')} <span className="turn-changes-badge">{local.files.length}</span></strong>
          {totals && <span className="turn-changes-totals"><span className="turn-added" title={t('新增')}>+{totals.added}</span><span className="turn-removed" title={t('删除')}>−{totals.removed}</span></span>}
        </div>
      </div>
      <div className="turn-changes-actions">
        <TurnRevertControl key={local.id} summary={local} target={target} onSummary={setLocal}/>
        <button type="button" className="btn small turn-changes-review" disabled={!local.files.length} onClick={() => { close(); openTurnReview(target); }}>{t('审阅改动')}</button>
      </div>
    </div>
    <div className="turn-changes-files">
      {rows.slice(0, 3)}
      {extraPresence.mounted && <div className={`acc${expanded && extraPresence.stage === 'in' ? ' is-open' : ''}`} aria-hidden={!expanded} {...(!expanded ? { inert: '' } : {})}>
        <div className="acc-body">{rows.slice(3)}</div>
      </div>}
    </div>
    <TurnDiffPreview anchor={hover} target={target} onClose={close} onEnter={cancelTimer} onLeave={leave} onDiffError={visibility?.refresh}/>
    <div className="turn-changes-footer">
      {local.files.length > 3 && <button type="button" className="turn-changes-toggle" aria-expanded={expanded}
        onClick={() => { close(); setExpandedId(expanded ? null : local.id); }}>
        {expanded ? t('收起文件') : t('再显示 {{count}} 个文件', { count: local.files.length - 3 })}
        {expanded ? <IconChevronUp size={14}/> : <IconChevronDown size={14}/>}
      </button>}
      <button type="button" className="turn-changes-info" aria-label={t('改动说明')}
        title={[t('后续已修改或来源未确认的文件会保留。'), ...local.warnings.map(w => turnChangeDisplayText(w, t, true))].join('\n')}><IconInfo size={16}/></button>
    </div>
  </section>;
}
