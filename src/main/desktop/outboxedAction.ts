import type { DesktopActionGate } from './actionGate';
import type { DesktopGrantRequest } from './grants';
import type { UnknownActionBoundary } from './unknownActionChain';
import type { WriteOutbox } from './writeOutbox';

type Outcome<T> = { outcome: 'dispatched'; value: T; invocationId: string } |
  { outcome: 'unknown'; invocationId?: string; persistence?: 'failed' };
type GateOutcome<T> = { outcome: 'dispatched'; value: T } | { outcome: 'unknown' };

/** Staged composition: all callers must bind host session identity and share the same gate, task lock and outbox. */
export class OutboxedDesktopAction {
  constructor(private readonly gate: DesktopActionGate, private readonly outbox: WriteOutbox,
    /** Host-bound turn/epoch check; reject conflict, expiry or a mismatched task. */
    private readonly assertEpoch: (sessionId: string, taskId: string) => void) {
    if (typeof assertEpoch !== 'function') throw new Error('Desktop epoch verifier is required');
  }

  runKnown<T>(sessionId: string, request: DesktopGrantRequest, isCurrent: () => boolean,
    dispatch: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<Outcome<T>> {
    const snapshot = { ...request, target: { ...request.target }, effect: { ...request.effect } };
    return this.run(sessionId, snapshot, dispatch,
      (wrapped, preflight) => this.gate.runKnown(snapshot, isCurrent, wrapped, signal, preflight));
  }

  runUnknown<T>(sessionId: string, request: Omit<DesktopGrantRequest, 'effect'>, boundary: UnknownActionBoundary,
    isCurrent: () => boolean, dispatch: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<Outcome<T>> {
    const snapshot = { ...request, target: { ...request.target } };
    return this.run(sessionId, snapshot, dispatch,
      (wrapped, preflight) => this.gate.runUnknown(snapshot, boundary, isCurrent, wrapped, signal, preflight));
  }

  private async run<T>(sessionId: string, request: Omit<DesktopGrantRequest, 'effect'>,
    dispatch: (signal?: AbortSignal) => Promise<T>, execute: (wrapped: (signal?: AbortSignal, isAuthorized?: () => boolean) => Promise<T>, preflight: () => void) => Promise<GateOutcome<T>>): Promise<Outcome<T>> {
    let invocationId: string | undefined;
    let proof: (() => boolean) | undefined;
    let result: GateOutcome<T>;
    try {
      result = await execute(async (signal, isAuthorized) => {
        // The action gate invokes this callback only after approval and inside
        // its shared task lock. No pending/unknown invocation may be replayed.
        if (this.outbox.isTaskBlocked(sessionId, request.taskId)) throw new Error('Previous write outcome requires reconciliation');
        invocationId = this.outbox.create({ sessionId, taskId: request.taskId, source: 'desktop', action: request.action, target: request.target.appId });
        this.outbox.markDispatched(sessionId, invocationId);
        proof = () => { this.assertEpoch(sessionId, request.taskId); return isAuthorized?.() === true; };
        if (signal?.aborted || proof() !== true) throw new Error('Desktop authorization changed before dispatch');
        return dispatch(signal);
      }, () => {
        this.assertEpoch(sessionId, request.taskId);
        if (this.outbox.isTaskBlocked(sessionId, request.taskId)) throw new Error('Previous write outcome requires delivery or reconciliation');
      });
    } catch (error) {
      if (!invocationId) throw error;
      result = { outcome: 'unknown' };
    }
    if (!invocationId) {
      if (result.outcome === 'dispatched') throw new Error('Desktop action completed without an outbox invocation');
      return { outcome: 'unknown' };
    }
    const authorized = (): boolean => { try { return proof?.() === true; } catch { return false; } };
    if (result.outcome === 'dispatched' && !authorized()) result = { outcome: 'unknown' };
    try {
      this.outbox.complete(sessionId, invocationId, result.outcome === 'dispatched'
        ? { outcome: 'known', value: result.value } : { outcome: 'unknown' });
    } catch {
      // A failed result write leaves the durable invocation unresolved. Never
      // disclose a value whose durable receipt cannot be confirmed.
      return { outcome: 'unknown', invocationId, persistence: 'failed' };
    }
    // A result that became unauthorized during the durable write stays
    // undelivered and blocks further writes; recovery must reauthorize it.
    if (result.outcome === 'dispatched' && !authorized()) return { outcome: 'unknown', invocationId };
    return result.outcome === 'dispatched' ? { outcome: 'dispatched', value: result.value, invocationId }
      : { outcome: 'unknown', invocationId };
  }
}
