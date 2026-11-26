import React from 'react';
import type { BoardStatus } from '../../../shared/boardStatus';
import { HarnessIcon } from './HarnessIcon';
import { SessionStatusIcon } from './StatusIcon';
import { SessionRailContent } from './SessionRailContent';

/** The shared session row; selection, editing, actions and optional tree control belong to its host. */
export function SessionRowContent({ name, status, statusLabel, capsule, capsuleClassName, harness,
  grayed = false, dimState = false, editing = false, treeControl, stateAdornment, trailing, children }: {
  name: string; status: BoardStatus; statusLabel: string; capsule: string; capsuleClassName: string;
  harness?: { id: string; name: string }; grayed?: boolean; dimState?: boolean; editing?: boolean;
  treeControl?: React.ReactNode; stateAdornment?: React.ReactNode; trailing?: React.ReactNode; children: React.ReactNode;
}): React.JSX.Element {
  return <span className="session-row-content">
    <span className="session-state-slot">
      <span className={`session-state${grayed ? ' is-exited' : ''}`} aria-label={statusLabel || undefined}>
        <span className={dimState ? 'session-state-idle' : undefined}><SessionStatusIcon status={status} size={14} /></span>
      </span>
      {harness ? <span className="session-harness-icon" role="img" aria-label={harness.name} title={harness.name}>
        <HarnessIcon harnessId={harness.id} size={14} />
      </span> : null}
      {stateAdornment}
      {treeControl}
    </span>
    <SessionRailContent name={name} status={capsule} statusClassName={capsuleClassName} editing={editing}>{children}</SessionRailContent>
    {trailing}
  </span>;
}
