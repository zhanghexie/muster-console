import React from 'react';
import { HarnessIcon } from '../components/HarnessIcon';

/** Shared mark for status cards and independently rendered free-canvas nodes. */
export function BoardHarnessAvatar({ harnessId, runtimeLabel }: { harnessId?: string; runtimeLabel: string }): React.JSX.Element {
  return <span className={`board-card-avatar${harnessId ? ' is-harness' : ''}`}
    role={harnessId ? 'img' : undefined} aria-label={harnessId ? runtimeLabel : undefined}
    aria-hidden={harnessId ? undefined : true} title={harnessId ? runtimeLabel : undefined}>
    {harnessId ? <HarnessIcon harnessId={harnessId} size={16} /> : runtimeLabel.slice(0, 1).toUpperCase() || 'A'}
  </span>;
}
