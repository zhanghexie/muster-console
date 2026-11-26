import '../styles/desktop-indicator.css';

export interface DesktopIndicatorProps {
  state: 'active' | 'stopping' | 'unknown';
  target?: string;
  escapeAvailable: boolean;
  labels: { active: string; stopping: string; unknown: string; escape: string; stop: string; escapeUnavailable: string };
  onStop(): void;
}

/** Presentation only; the main process owns the run state and stop authority. */
export function DesktopIndicator({ state, target, escapeAvailable, labels, onStop }: DesktopIndicatorProps) {
  const status = state === 'active' ? labels.active : state === 'stopping' ? labels.stopping : labels.unknown;
  return <section className="desktop-indicator" aria-live="polite" aria-label={labels.active}>
    <span className="desktop-indicator__status" role="status">{status}</span>
    {target && <span className="desktop-indicator__target" title={target}>{target}</span>}
    {state === 'active' && <span className="desktop-indicator__hint">{escapeAvailable ? labels.escape : labels.escapeUnavailable}</span>}
    <button type="button" onClick={onStop} disabled={state !== 'active'}>{labels.stop}</button>
  </section>;
}
