import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePresence } from './motion';
import { showTip } from '../tips';

export type PermissionConfigurationControl = { enabled: boolean; disabled?: boolean; onChange: (enabled: boolean) => void };

export function PermissionConfigurationSwitch({ enabled, disabled, onChange }: PermissionConfigurationControl) {
  const { t } = useTranslation();
  return <button type="button" className="permission-config-switch" role="switch" aria-checked={enabled}
    disabled={disabled} title={enabled ? undefined : t('关闭时使用最高权限')} onClick={() => onChange(!enabled)}>
    <span className="permission-config-track" aria-hidden="true"><span /></span>
    <span>{t('配置权限')}</span>
  </button>;
}

export function PermissionConfigurationBody({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const presence = usePresence(enabled);
  return presence.mounted ? <div className={`acc permission-config-body${enabled && presence.stage === 'in' ? ' is-open' : ''}`}
    {...presence.spread} ref={node => { if (node) node.inert = !enabled; }} aria-hidden={!enabled}>
    <div className="acc-body">{children}</div>
  </div> : null;
}

export function PermissionConfiguration({ children, className = '', ...props }: PermissionConfigurationControl & { children: React.ReactNode; className?: string }) {
  return <div className={`permission-config ${className}`}>
    <PermissionConfigurationSwitch {...props} />
    <PermissionConfigurationBody enabled={props.enabled}>{children}</PermissionConfigurationBody>
  </div>;
}

/** Only acknowledge a persisted change; late replies from another session are ignored. */
export function useSessionPermissionConfiguration(sessionId: string | undefined, configured: boolean | undefined) {
  const { t } = useTranslation();
  const [state, setState] = useState({ sessionId, enabled: configured === true, saving: false });
  const current = useRef({ sessionId, live: true, request: 0 });
  const lock = useRef(false);
  if (current.current.sessionId !== sessionId) {
    current.current = { sessionId, live: true, request: current.current.request + 1 };
    lock.current = false;
  }
  useEffect(() => {
    setState(previous => ({ sessionId, enabled: configured === true,
      saving: previous.sessionId === sessionId && previous.saving }));
  }, [sessionId, configured]);
  useEffect(() => {
    current.current.live = true;
    return () => { current.current.live = false; current.current.request++; };
  }, []);
  const change = async (enabled: boolean) => {
    if (!sessionId || lock.current) return;
    lock.current = true;
    const request = ++current.current.request;
    const isCurrent = () => current.current.live && current.current.sessionId === sessionId && current.current.request === request;
    setState(previous => ({ ...previous, saving: true }));
    try {
      const result = await window.api.sessions.setConfigurePermissions(sessionId, enabled);
      if (!isCurrent()) return;
      setState(previous => ({ ...previous, enabled: result.ok ? enabled : previous.enabled, saving: false }));
      if (!result.ok) showTip(result.error || t('权限配置未保存，请重试'), { tone: 'error' });
    } catch (error) {
      if (isCurrent()) {
        setState(previous => ({ ...previous, saving: false }));
        showTip(error instanceof Error ? error.message : t('权限配置未保存，请重试'), { tone: 'error' });
      }
    } finally { if (isCurrent()) lock.current = false; }
  };
  return { ...(state.sessionId === sessionId ? state : { enabled: configured === true, saving: false }), change };
}
