import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TurnChangeOwner, TurnChanges } from '../../../shared/turnChanges';

type Message = { id: string; role: string; turnChanges?: TurnChanges };
type Selection = { owner: TurnChangeOwner; id: string | null; messageId: string | null; pendingInitial: boolean; refresh: () => void };
export const TurnSnapshotVisibility = createContext<Selection | null>(null);

/** One host check per conversation, shared by all mounted message cards. */
export function TurnSnapshotVisibilityProvider({ owner, messages, active = true, children }: { owner: TurnChangeOwner; messages: readonly Message[]; active?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  const revision = useMemo(() => messages.flatMap(message => message.role === 'assistant' && message.turnChanges?.state === 'ready' && message.turnChanges.files.length
    ? [`${message.id}:${message.turnChanges.id}`] : []).join('|'), [messages]);
  const key = `${owner.kind}:${owner.id}:${revision}`;
  const [state, setState] = useState<{ key: string; id: string | null; messageId: string | null; error: string }>({ key: '', id: null, messageId: null, error: '' });
  const ownerKey = `${owner.kind}:${owner.id}`;
  const settledOwner = useRef<string | null>(null);
  if ((revision && state.key === key) || (!revision && messages.length > 0)) settledOwner.current = ownerKey;
  const pendingInitial = Boolean(revision && state.key !== key && settledOwner.current !== ownerKey);
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);

  useEffect(() => {
    let live = true;
    if (!active) return () => { live = false; };
    if (!revision) { setState({ key, id: null, messageId: null, error: '' }); return () => { live = false; }; }
    const timeout = window.setTimeout(() => {
      if (!live) return;
      live = false;
      setState({ key, id: null, messageId: null, error: t('本轮改动快照不可用') });
    }, 5000);
    void window.api.turnChanges.list(owner).then(result => {
      if (!live) return;
      window.clearTimeout(timeout);
      if (!result.ok) {
        setState({ key, id: null, messageId: null, error: result.error === t('本轮改动快照不可用') || result.error === t('会话已关闭') ? '' : result.error ?? t('本轮改动快照不可用') });
        return;
      }
      const latest = result.entries.find(entry => entry.summary.state === 'ready' && entry.summary.files.length);
      setState({ key, id: latest?.summary.id ?? null, messageId: latest?.target.messageId ?? null, error: '' });
    }).catch(error => { if (live) { window.clearTimeout(timeout); setState({ key, id: null, messageId: null, error: String(error) }); } });
    return () => { live = false; window.clearTimeout(timeout); };
  }, [owner.kind, owner.id, revision, key, attempt, active, t]);

  useEffect(() => {
    if (!active) return;
    const onFocus = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus); };
  }, [active, refresh]);

  const value = useMemo<Selection>(() => ({ owner, id: state.key === key ? state.id : null, messageId: state.key === key ? state.messageId : null, pendingInitial, refresh }),
    [owner.kind, owner.id, state.key, state.id, state.messageId, key, pendingInitial, refresh]);
  return <TurnSnapshotVisibility.Provider value={value}>{state.key === key && state.error ? <p className="turn-changes-note" role="alert">{state.error}</p> : null}{children}</TurnSnapshotVisibility.Provider>;
}
