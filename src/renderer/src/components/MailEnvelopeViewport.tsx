import { MarkdownBody } from './MarkdownBody';
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { MAIL_COLLECT_MS } from '../../../shared/mailActivity';
import { MOTION, prefersReducedMotion, usePresence } from './motion';
import { subscribeInteractionPreferences } from '../interactionPreferences';
import { isWebGateway } from '../webGatewayEnvironment';
import { EnvelopePaper, envelopeTimingVars } from './envelope/EnvelopePaper';
import { emptyMailEnvelopeState, mailEnvelopeReducer, mailPreviewDeadline, type MailEnvelopeAction } from './envelope/mailEnvelopeQueue';
import { useEnvelopeMotion } from './envelope/useEnvelopeMotion';

function documentForeground(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Outgoing previews release their pending writes at launch. Incoming previews follow stored mail. */
export function MailEnvelopeViewport({ mailboxId, enabled = true, style }: {
  mailboxId: string; enabled?: boolean; style?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const viewportId = useId();
  const [state, setState] = useState(emptyMailEnvelopeState);
  const latest = useRef(state);
  const dispatch = useCallback((action: MailEnvelopeAction) => {
    const next = mailEnvelopeReducer(latest.current, action);
    if (next === latest.current) return false;
    latest.current = next;
    setState(next);
    return true;
  }, []);
  const scene = useRef<HTMLDivElement>(null);
  const reduced = useSyncExternalStore(subscribeInteractionPreferences, prefersReducedMotion, () => false);
  const active = state.active;
  const presence = usePresence(enabled && !!active && active.phase !== 'exit', MOTION.exitMs);
  const seen = useRef(new Set<string>());
  const done = useCallback((played: boolean) => {
    dispatch(played ? { type: 'motionDone', now: Date.now() } : { type: 'dismiss' });
  }, [dispatch]);
  const commit = useCallback((ids: string[]) => window.api.mailPresentation?.depart(viewportId, ids)
    .then(result => result?.ok === true)
    .catch(error => {
      console.warn('[mailbox] departure could not be confirmed', error);
      return false;
    }) ?? Promise.resolve(false), [viewportId]);
  const departureIds = active?.departureIds;
  const depart = useCallback(() => commit(departureIds ?? []), [commit, departureIds]);
  useEnvelopeMotion(scene, enabled && active?.phase === 'motion', active?.direction ?? 'send', reduced, done,
    departureIds?.length ? depart : undefined);

  useLayoutEffect(() => {
    dispatch({ type: 'reset' });
    seen.current.clear();
    if (!enabled) return;
    const api = isWebGateway() ? undefined : window.api.mailPresentation;
    let registered = false;
    const register = (value: boolean) => {
      if (!api || value === registered) return;
      registered = value;
      void api.setViewport(viewportId, mailboxId, value)
        .then(result => { if (result?.ok === false) console.warn('[mailbox] viewport registration failed', result.error); })
        .catch(error => console.warn('[mailbox] viewport registration failed', error));
    };
    const syncVisibility = () => {
      const visible = documentForeground(), motionReduced = prefersReducedMotion();
      register(visible && !motionReduced);
      if (!visible || (motionReduced && latest.current.active?.departureIds.length)) dispatch({ type: 'reset' });
    };
    const blur = () => { register(false); dispatch({ type: 'reset' }); };
    const offActivity = window.api.on('messages:activity', letter => {
      if (!documentForeground() || letter.from === letter.to) return;
      const direction = letter.to === mailboxId ? 'receive'
        : letter.from === mailboxId && prefersReducedMotion() ? 'send' : null;
      if (!direction) return;
      const key = `${letter.mailboxWorkspaceId}:${letter.id}`;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      if (seen.current.size > 512) seen.current.delete(seen.current.values().next().value!);
      dispatch({ type: 'arrive', direction, letter, now: Date.now() });
    });
    const offDeparture = api && window.api.on('messages:departure', ({ requestId, viewportId: target, letter }) => {
      if (target !== viewportId) return;
      const accepted = letter.from === mailboxId && documentForeground() && !prefersReducedMotion() &&
        dispatch({ type: 'arrive', direction: 'send', letter, departureId: requestId, now: Date.now() });
      if (!accepted) void commit([requestId]);
    });
    const offPreferences = subscribeInteractionPreferences(syncVisibility);
    window.addEventListener('focus', syncVisibility);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', syncVisibility);
    syncVisibility();
    return () => {
      offActivity();
      offDeparture?.();
      offPreferences();
      window.removeEventListener('focus', syncVisibility);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', syncVisibility);
      register(false);
    };
  }, [enabled, mailboxId, viewportId, commit, dispatch]);

  useEffect(() => {
    if (!active || !enabled) return;
    const { phase, direction } = active;
    if (phase !== 'preview' && phase !== 'collect') return;
    const deadline = phase === 'collect' ? active.firstAt + MAIL_COLLECT_MS : mailPreviewDeadline(active);
    const timer = setTimeout(() => {
      if (latest.current.active !== active) return;
      if (phase === 'collect' && reduced) dispatch({ type: 'motionDone', now: Date.now() });
      else if (phase === 'preview' && (direction === 'receive' || reduced)) dispatch({ type: 'dismiss' });
      else dispatch({ type: 'begin' });
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [active, enabled, reduced, dispatch]);
  useEffect(() => {
    if (active?.phase === 'exit' && !presence.mounted) dispatch({ type: 'next', now: Date.now() });
  }, [active, presence.mounted, dispatch]);

  if (!enabled || !active || !presence.mounted) return null;
  const first = active.letters[0]!;
  const other = active.direction === 'send' ? first.toName : first.fromName;
  const label = active.direction === 'send'
    ? t('寄信给 {{name}} · {{count}} 封', { name: other, count: active.count })
    : t('收到 {{name}} 的来信 · {{count}} 封', { name: other, count: active.count });
  return <div className="mail-envelope-viewport" style={{ ...style, zIndex: 20 }} data-mailbox-id={mailboxId}>
    <div className="mail-envelope-presence mp-panel" {...presence.spread}>
      <div ref={scene} className="mail-envelope-scene" style={envelopeTimingVars}
        data-direction={active.direction} data-phase={active.phase} data-count={active.count}
        data-running={active.phase === 'motion'} data-playing={active.phase === 'collect' ? 'true' : active.phase === 'preview' ? 'false' : undefined}
        data-paper-layer={active.phase === 'collect' ? 'inside' : undefined}>
        <div className="mail-envelope-caption" role="status" aria-live="polite">{label}</div>
        {[...active.letters].reverse().map((letter, i) => <div className="mail-envelope-page" key={letter.id}
          style={{ '--mail-depth': active.letters.length - i - 1 } as React.CSSProperties}>
          <EnvelopePaper>
            <div className="mail-letter">
              <div className="mail-letter-route"><span>{letter.fromName}</span><span aria-hidden="true">→</span><span>{letter.toName}</span></div>
              {letter.subject ? <div className="mail-letter-subject">{letter.subject}</div> : null}
              <MarkdownBody className="mail-letter-body" text={letter.text} displayOnly />
              <div className="mail-letter-footer">{letter.totalChars > letter.text.length ? t('信件节选') : t('代理间通信')}
                {active.count > 1 ? <span>{t('共 {{count}} 封', { count: active.count })}</span> : null}</div>
            </div>
          </EnvelopePaper>
        </div>)}
      </div>
    </div>
  </div>;
}
