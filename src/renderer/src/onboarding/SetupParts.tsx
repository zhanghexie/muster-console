import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconChevronLeft, IconChevronRight } from '../components/icons';

export function SetupActions({ back, busy, children }: {
  back?: () => void;
  busy?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <div className="setup-actions">
    {back && <button type="button" className="btn ghost setup-back" disabled={busy} onClick={back}>
      <IconChevronLeft />{t('上一步')}
    </button>}
    <div className="setup-actions-end">{children}</div>
  </div>;
}

export function SetupNext({ onClick, label, disabled }: {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return <button type="button" className="btn primary" onClick={onClick} disabled={disabled}>
    {label ?? t('继续')}<IconChevronRight />
  </button>;
}

export function useSetupAction() {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(operation: () => Promise<void>): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return { busy, error, run, clearError: () => setError('') };
}
