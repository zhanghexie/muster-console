import type { SessionMeta } from './types';
import { hasRunningExecution, isFreshActive } from './sessionActivity';
import { sessionSubtreePostOrder } from './sessionTree';

export function sessionMayInterrupt(session: SessionMeta, now = Date.now()): boolean {
  if (session.archived || session.runtimePresence === 'dormant' || session.status === 'exited') return false;
  return session.status === 'starting' || session.lifecycle === 'starting' || session.lifecycle === 'working' ||
    session.lifecycle === 'quiet' || session.lifecycle === 'blocked' || session.activity?.kind === 'waiting_input' ||
    session.activity?.kind === 'blocked' || hasRunningExecution(session.activity) || isFreshActive(session.activity, now) ||
    (session.status === 'running' && (session.lastOutputAt ?? 0) > now - 2_000);
}

export function archiveAffectedSessions(sessions: readonly SessionMeta[], id: string): SessionMeta[] {
  return sessionSubtreePostOrder(sessions, id).filter(session => !session.archived);
}

export interface SessionDeletePreview {
  fingerprint: string;
  name: string;
  descendants: number;
  active: number;
  worktrees: Array<{ path: string; branch?: string; borrowed?: boolean;
    disposition?: 'keep' | 'remove-directory' | 'remove-directory-and-branch' | 'verify' }>;
}

export interface SessionDeleteOptions {
  fingerprint: string;
  keepWorktrees?: boolean;
  forceWorktrees?: boolean;
}
