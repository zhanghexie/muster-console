import { showTip } from '../tips';
import React, { useRef, useState } from 'react';
import { BrandLoading } from './BrandLoader';

/** Pending belongs to this click, not a surrounding panel's shared busy flag. */
export function OperationButton({ onAction, children, iconOnly = false, disabled, ...props }:
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
    onAction: () => Promise<unknown>; iconOnly?: boolean;
  }): React.JSX.Element {
  const flight = useRef(false);
  const [pending, setPending] = useState(false);
  return <button {...props} disabled={disabled || pending} aria-busy={pending || undefined} onClick={async () => {
    if (flight.current) return;
    flight.current = true; setPending(true);
    try { await onAction(); }
    catch (error) { showTip(String(error), { tone: 'error' }); }
    finally { flight.current = false; setPending(false); }
  }}>{pending ? <BrandLoading size={18}>{iconOnly ? null : children}</BrandLoading> : children}</button>;
}
