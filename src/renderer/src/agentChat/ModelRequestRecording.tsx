import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MOTION, usePresence } from '../components/motion';

type RecordingStatus = {
  sessionId: string;
  enabled?: boolean;
  error?: 'read' | 'write';
};

export type ModelRequestRecording = Pick<RecordingStatus, 'enabled' | 'error'> & {
  pending: boolean;
  change(enabled: boolean): void;
};

export function useModelRequestViewer(sessionId: string | undefined) {
  const [openId, setOpenId] = useState<string>();
  const [status, setStatus] = useState<RecordingStatus>();
  const [savingId, setSavingId] = useState<string>();
  const revision = useRef(0);
  const mutation = useRef<{ sessionId: string }>();

  useEffect(() => {
    setOpenId(undefined);
    setStatus(undefined);
    if (!sessionId) return;
    const query = ++revision.current;
    const off = window.api.on('modelRequests:recordingChanged', event => {
      if (event.sessionId !== sessionId) return;
      revision.current++;
      setStatus(event);
    });
    void window.api.agentSession.modelRequestRecording(sessionId).then(enabled => {
      if (query === revision.current) setStatus({ sessionId, enabled });
    }, () => {
      if (query === revision.current) setStatus({ sessionId, error: 'read' });
    });
    return () => { revision.current++; off(); };
  }, [sessionId]);

  const change = useCallback(async (enabled: boolean) => {
    if (!sessionId || mutation.current?.sessionId === sessionId) return;
    const operation = { sessionId };
    mutation.current = operation;
    const query = ++revision.current;
    setSavingId(sessionId);
    setStatus(previous => previous?.sessionId === sessionId ? { ...previous, error: undefined } : previous);
    try {
      const current = await window.api.agentSession.setModelRequestRecording(sessionId, enabled);
      if (query === revision.current) setStatus({ sessionId, enabled: current,
        error: current === enabled ? undefined : 'write' });
    } catch {
      if (query === revision.current) setStatus(previous => ({ sessionId, enabled: previous?.sessionId === sessionId ? previous.enabled : undefined,
        error: 'write' }));
    } finally {
      if (mutation.current === operation) {
        mutation.current = undefined;
        setSavingId(undefined);
      }
    }
  }, [sessionId]);

  const open = useCallback((intent: 'start' | 'view') => {
    if (!sessionId) return;
    setOpenId(sessionId);
    if (intent === 'start') void change(true);
  }, [sessionId, change]);
  const show = useCallback(() => open('view'), [open]);
  const close = useCallback(() => setOpenId(undefined), []);
  const current = status?.sessionId === sessionId ? status : undefined;
  const recording: ModelRequestRecording = { enabled: current?.enabled, error: current?.error, pending: !!sessionId && savingId === sessionId, change };
  return { open, show, close, isOpen: !!sessionId && openId === sessionId, recording };
}

export function ModelRequestRecordingShortcut({ visible, onOpen }: { visible: boolean; onOpen(): void }): React.JSX.Element | null {
  const { t } = useTranslation();
  const presence = usePresence(visible, MOTION.microMs);
  if (!presence.mounted) return null;
  return <div className="model-request-shortcut-wrap" {...(!visible ? { inert: '' } : {})} aria-hidden={!visible}>
    <button type="button" className="ui-btn ghost compact model-request-shortcut mp-pop" {...presence.spread}
      disabled={!visible} aria-haspopup="dialog" aria-label={t('录制中，打开模型请求')} title={t('打开模型请求')} onClick={onOpen}>
      <span aria-hidden="true" className="model-request-recording-dot" />{t('录制中')}
    </button>
  </div>;
}
