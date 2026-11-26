import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getTipSnapshot, showTip } from '../tips';

/** Publish a committed error state without occupying space in its source view. */
export function ErrorTip({ message, active = true }: { message?: string | null; active?: boolean }): null {
  const text = message?.trim();
  const reported = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!text) {
      reported.current = undefined;
      return;
    }
    if (!active || reported.current === text) return;
    reported.current = text;
    const current = getTipSnapshot();
    if (current?.tone === 'error' && current.text === text) return;
    showTip(text, { tone: 'error' });
  }, [active, text]);
  return null;
}

/** Historical failures stay available on demand without replaying on mount. */
export function ErrorTipDetails({ message }: { message: string }): React.JSX.Element {
  const { t } = useTranslation();
  return <button type="button" className="ui-btn tiny" onClick={() => showTip(message, { tone: 'error' })}>
    {t('查看详情')}
  </button>;
}
