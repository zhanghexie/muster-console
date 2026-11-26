import React, { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getTipSnapshot, subscribeTips } from '../tips';
import { MOTION, usePresenceValue } from './motion';
import { IconInfo } from './icons';
import { ErrorTip } from './ErrorTip';
import { getWebGatewayStatus, subscribeWebGatewayStatus } from '../webGatewayStatus';
import './app-tip.css';

export function AppTipHost(): React.JSX.Element {
  const current = useSyncExternalStore(subscribeTips, getTipSnapshot, getTipSnapshot);
  const gateway = useSyncExternalStore(subscribeWebGatewayStatus, getWebGatewayStatus);
  const { value, presence } = usePresenceValue(current, MOTION.menuMs);
  // A native modal makes live regions behind it inert, regardless of their z-index.
  const host = document.querySelector('dialog[open][aria-modal="true"]:not([inert])') ?? document.body;
  return <>
    <ErrorTip message={gateway.error} />
    {createPortal(<div className="app-tip-region" role="status" aria-atomic="true">
      {presence.mounted && value && <div className={`app-tip mp-pop${value.tone === 'error' ? ' is-error' : ''}`} {...presence.spread}
        aria-hidden={!current}>
        <IconInfo size={15} />
        <span>{value.text}</span>
      </div>}
    </div>, host)}
  </>;
}
