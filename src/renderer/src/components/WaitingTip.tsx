import React from 'react';
import { useTranslation } from 'react-i18next';
import { pickNextWaitingTip, useWaitingTips, waitingTipKey } from '../waitingTips';
import { WaitingActivityIcon } from './ActivityIcons';

/** Display-only: never added to the message or model context. */
export function WaitingTip(): React.JSX.Element {
  const { i18n, t } = useTranslation();
  const { enabled, tips } = useWaitingTips();
  const [tipKey, setTipKey] = React.useState<string | null>(null);
  const currentKey = React.useRef<string | null>(null);
  const choose = React.useCallback(() => {
    const next = pickNextWaitingTip(tips, currentKey.current);
    const key = next ? waitingTipKey(next) : null;
    currentKey.current = key;
    setTipKey(key);
  }, [tips]);
  React.useEffect(() => {
    if (!enabled || !tips.length) {
      currentKey.current = null;
      setTipKey(null);
      return;
    }
    if (!tips.some(tip => waitingTipKey(tip) === currentKey.current)) choose();
  }, [enabled, tips, choose]);
  React.useEffect(() => {
    if (!enabled || tips.length < 2) return;
    const timer = setInterval(choose, 5000);
    return () => clearInterval(timer);
  }, [enabled, tips, choose]);
  const tip = enabled ? tips.find(item => waitingTipKey(item) === tipKey) : undefined;
  const text = tip ? (i18n.resolvedLanguage?.startsWith('en') ? tip.en : tip['zh-CN']) : '';
  const label = t('努力工作中');
  return <div className="chat-pending-lite waiting-tip" role="status" aria-live="off" aria-label={text ? `${label} · Tips：${text}` : label}>
    <WaitingActivityIcon />
    <span className="waiting-tip-working" aria-hidden="true">{label}</span>
    {text ? <><span className="waiting-tip-separator" aria-hidden="true">·</span><span className="waiting-tip-label" aria-hidden="true">Tips</span><span className="waiting-tip-text" title={text} aria-hidden="true">{text}</span></> : null}
  </div>;
}
