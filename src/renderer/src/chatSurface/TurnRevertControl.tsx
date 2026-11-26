import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnChanges, TurnChangeTarget, TurnRevertResult } from '../../../shared/turnChanges';
import { isTurnFileCollision } from '../../../shared/turnChanges';
import { turnChangeDisplayText } from '../turnChangeDisplay';

export function TurnRevertControl({ summary, target, onSummary }: { summary: TurnChanges; target: TurnChangeTarget; onSummary: (summary: TurnChanges) => void }) {
  const { t } = useTranslation();
  const pending = useRef(false);
  const [reverting, setReverting] = useState(false);
  const [result, setResult] = useState<TurnRevertResult | null>(null);
  const canRequestRevert = summary.state === 'ready' && summary.files.some(f => !f.reverted && (f.revertible || isTurnFileCollision(summary, f)));
  const revert = async () => {
    if (pending.current || !canRequestRevert) return;
    pending.current = true; setReverting(true); setResult(null);
    try {
      const next = await window.api.turnChanges.revert(target);
      setResult(next); if (next.summary) onSummary(next.summary);
    } catch (error) { setResult({ ok: false, restored: [], conflicts: [], error: String(error) }); }
    finally { pending.current = false; setReverting(false); }
  };
  return <div className="turn-revert-control">
    <button type="button" className="btn small" disabled={!canRequestRevert || reverting} onClick={revert}
      title={t('只回退归属已确认且后续未变化的文件')}>{reverting ? t('正在回退…') : t('回退本轮')}</button>
    {result && <div className="turn-changes-result" role={result.error || result.conflicts.length ? 'alert' : 'status'}>
      {!!result.restored.length && <p>{t('已回退 {{count}} 个文件', { count: result.restored.length })}</p>}
      {result.error && <p>{turnChangeDisplayText(result.error, t)}</p>}
      {result.conflicts.map(c => <p key={c.path}>{c.path}：{turnChangeDisplayText(c.reason, t)}</p>)}
    </div>}
  </div>;
}
