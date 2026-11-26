import { ErrorTip } from '../components/ErrorTip';
import { turnChangesStatusText } from '../../../shared/turnChanges';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { ChatSurface } from '../../../shared/chatSurface';
import type { TurnChanges, TurnChangeTarget, TurnRevertResult } from '../../../shared/turnChanges';
import { locateAbortedTurn } from '../../../shared/chatTurnRail';
import { usePresenceValue } from '../components/motion';
import { useOverlayDismiss } from '../keybindings/KeybindingHost';
import { turnChangeDisplayText } from '../turnChangeDisplay';

interface PendingEdit { target: TurnChangeTarget; snapshotId: string; resolve: (allow: boolean) => void }

function InterruptedTurnDialog({ pending, summary, onDecide }: { pending: PendingEdit | null; summary?: TurnChanges; onDecide: (allow: boolean) => void }) {
  const { t } = useTranslation();
  const { value, presence } = usePresenceValue(pending);
  const [result, setResult] = useState<TurnRevertResult | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const current = useRef(pending); current.current = pending;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef(summary); if (pending) summaryRef.current = summary;
  const shownSummary = pending ? summary : summaryRef.current;
  useEffect(() => { if (pending) { setResult(null); setBusy(false); busyRef.current = false; } }, [pending]);
  useEffect(() => {
    if (!pending || !presence.mounted) return;
    const previous = document.activeElement;
    cancelRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [pending, presence.mounted]);
  const close = () => { if (!busyRef.current) onDecide(false); };
  useOverlayDismiss(!!pending, close);
  const revert = async () => {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true); setResult(null);
    try {
      const next = await window.api.turnChanges.revert(pending.target);
      if (current.current !== pending) return;
      if (next.ok && !next.conflicts.length && !next.error) onDecide(true);
      else setResult(next);
    } catch (error) { if (current.current === pending) setResult({ ok: false, restored: [], conflicts: [], error: String(error) }); }
    finally { if (current.current === pending) { busyRef.current = false; setBusy(false); } }
  };
  if (!value || !presence.mounted) return null;
  const canRevert = shownSummary?.state === 'ready' && shownSummary.files.some(f => f.revertible && !f.reverted);
  return createPortal(<div className="modal-mask app-confirm-mask mp-scrim" {...presence.spread} data-overlay-root onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <div className="modal confirm-modal interrupted-turn-dialog mp-panel" {...presence.spread} role="dialog" aria-modal="true" aria-labelledby="interrupted-turn-title" aria-busy={busy} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="modal-head"><h3 id="interrupted-turn-title">{t('要回退已中断轮次的文件改动吗？')}</h3><button type="button" className="modal-close" aria-label={t('关闭')} disabled={busy} onClick={close}>×</button></div>
      <div className="interrupted-turn-body"><p>{t('重新编辑或发送前，可以先回退上一轮改动。后续修改及来源未确认的文件会保留。')}</p>
        {shownSummary?.state === 'collecting' ? <p role="status">{t(turnChangesStatusText(shownSummary))}</p> : null}
        {!canRevert && shownSummary?.state !== 'collecting' ? <p>{t('当前没有可安全回退的文件，可以保留改动后继续。')}</p> : null}
        {shownSummary?.warnings.map(w => <p key={w}>{turnChangeDisplayText(w, t)}</p>)}
        {result ? <>
          <p>{t('部分文件未回退。请选择保留当前文件后继续，或取消。')}</p>
          <ErrorTip message={[result.error ? turnChangeDisplayText(result.error, t) : '', ...result.conflicts.map(c => c.path + '：' + turnChangeDisplayText(c.reason, t))].filter(Boolean).join('\n')} />
        </> : null}
      </div>
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={close}>{t('取消')}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => { if (!busyRef.current) onDecide(true); }}>{t('保留改动并继续')}</button>
        <button type="button" className="btn primary" disabled={busy || !canRevert} onClick={revert}>{busy ? t('正在回退…') : t('回退后继续')}</button>
      </div>
    </div>
  </div>, document.body);
}

/** One gate for both surfaces, before destructive recall or a new send after stop. */
export function useInterruptedTurnGuard(surface: ChatSurface, enabled: boolean) {
  const [pending, setPending] = useState<PendingEdit | null>(null);
  const pendingRef = useRef<PendingEdit | null>(null);
  const decide = useCallback((allow: boolean) => {
    const request = pendingRef.current; pendingRef.current = null; setPending(null); request?.resolve(allow);
  }, []);
  useEffect(() => () => { const p = pendingRef.current; pendingRef.current = null; p?.resolve(false); }, [surface]);
  const busy = surface.getSnapshot().busy;
  useEffect(() => { if (!enabled || busy) decide(false); }, [enabled, surface, busy, decide]);
  const confirm = useCallback((userMessageId?: string): Promise<boolean> => {
    if (!enabled || pendingRef.current) return Promise.resolve(false);
    const snap = surface.getSnapshot();
    if (snap.busy) return Promise.resolve(true);
    const messages = snap.messages as readonly { id: string; role: 'user' | 'assistant'; aborted?: boolean; turnChanges?: TurnChanges }[];
    const loc = locateAbortedTurn(messages, userMessageId);
    const summary = loc ? messages[loc.assistantIdx]?.turnChanges : undefined;
    // 审阅尚未就绪或没有可安全回退的文件时，保留当前文件直接继续。
    if (!loc || !summary || summary.state !== 'ready' || !summary.files.some(f => f.revertible && !f.reverted)) return Promise.resolve(true);
    return new Promise(resolve => {
      const request: PendingEdit = { target: { kind: surface.caps.surfaceKind === 'dispatch' ? 'dispatch' : 'gui', id: surface.sessionId, messageId: loc.assistantMessageId }, snapshotId: summary.id, resolve };
      pendingRef.current = request; setPending(request);
    });
  }, [surface, enabled]);
  const snap = surface.getSnapshot();
  const messages = snap.messages as readonly { id: string; turnChanges?: TurnChanges }[];
  const summary = pending ? messages.find(m => m.id === pending.target.messageId)?.turnChanges : undefined;
  useEffect(() => {
    if (pending && (!summary || summary.id !== pending.snapshotId)) decide(false);
  }, [pending, summary, decide]);
  return { confirm, dialog: <InterruptedTurnDialog pending={pending} summary={summary} onDecide={decide}/> };
}
