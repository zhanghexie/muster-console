import type { TrustedDisplayActor } from './displayService';
import type { DesktopDeliveryLease } from './desktopTurns';
import { runWithDesktopDeliveryInvocation } from './desktopDeliveryInvocation';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';
import { CuaSemanticRuntimeError, type CuaSemanticActor, type CuaSemanticRuntime } from './cuaSemanticRuntime';
import { isRecordedDesktopOutcome } from './recordedDesktopOutcome';

type Page = Awaited<ReturnType<CuaSemanticRuntime['observe']>>;
type Action = Parameters<CuaSemanticRuntime['act']>[1];
type ActionResult = Awaited<ReturnType<CuaSemanticRuntime['act']>>;
type Snapshot = { sessionId: string; taskId: string; turnId: string; surfaceId?: string; windowId: string; expiresAt: number;
  click?: { request: string; result?: ActionResult } };
interface Options {
  runtime: Pick<CuaSemanticRuntime, 'observe' | 'page' | 'act' | 'closeActor'>;
  activity: { visibilityEpoch(): number | undefined; stop(): Promise<void> };
  resolveTarget(actor: CuaSemanticActor, windowId: string): { surfaceId?: string; isCurrent(): boolean };
  reportStopError(error: unknown): void;
}

/** Host-only Cua bridge; model refs never become native window identifiers. */
export class CuaVisibleBridge {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly options: Options) {
    if (!options || typeof options.runtime?.observe !== 'function' || typeof options.runtime?.page !== 'function' ||
        typeof options.runtime?.act !== 'function' || typeof options.runtime?.closeActor !== 'function' ||
        typeof options.activity?.visibilityEpoch !== 'function' || typeof options.activity?.stop !== 'function' ||
        typeof options.resolveTarget !== 'function' || typeof options.reportStopError !== 'function') {
      throw new Error('Cua visible desktop bridge dependencies are unavailable');
    }
  }

  async observe(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, surfaceId: string | undefined, windowId: string,
    signal?: AbortSignal, withImage = false) {
    const { owner, current } = this.prepare(actor, lease, surfaceId, windowId, signal);
    const page: Page = await this.options.runtime.observe(owner, windowId, signal, withImage);
    if (!page || typeof page.snapshotId !== 'string' || !page.snapshotId.trim() ||
        !Number.isSafeInteger(page.expiresAt) || page.expiresAt <= Date.now() || !current()) {
      await this.options.runtime.closeActor(owner);
      throw new Error('Desktop semantic observation changed');
    }
    this.prune();
    for (const [id, value] of this.snapshots) if (value.sessionId === owner.sessionId && value.taskId === owner.taskId && value.turnId === owner.turnId) {
      this.snapshots.delete(id);
    }
    if (this.snapshots.size >= 128) this.snapshots.delete(this.snapshots.keys().next().value!);
    this.snapshots.set(page.snapshotId, { sessionId: owner.sessionId, taskId: owner.taskId, turnId: owner.turnId, surfaceId, windowId, expiresAt: page.expiresAt });
    return { ...page, ...(withImage ? { authorizationCurrent: () => current() && this.snapshots.has(page.snapshotId) && page.expiresAt > Date.now() } : {}) };
  }

  async page(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, surfaceId: string | undefined, windowId: string, snapshotId: string, offset: number) {
    const snapshot = this.snapshot(actor, lease, snapshotId);
    if (snapshot.windowId !== windowId || snapshot.surfaceId !== surfaceId) throw new Error('Desktop semantic snapshot belongs to a different window or display');
    const { owner, current } = this.prepare(actor, lease, surfaceId, snapshot.windowId);
    const page = await this.options.runtime.page(owner, snapshotId, offset);
    if (!current()) throw new Error('Desktop semantic observation changed');
    return page;
  }

  async act(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, surfaceId: string | undefined, windowId: string, request: Action, signal?: AbortSignal) {
    let prepared: ReturnType<CuaVisibleBridge['prepare']>;
    let snapshot: Snapshot;
    try {
      snapshot = this.snapshot(actor, lease, request?.snapshotId);
      if (snapshot.windowId !== windowId || snapshot.surfaceId !== surfaceId) throw new Error('Desktop semantic snapshot belongs to a different window or display');
      prepared = this.prepare(actor, lease, surfaceId, windowId, signal);
    } catch (error) { throw new PreDispatchFailure(error); }
    const { owner, current, epoch } = prepared;
    if ('point' in request) {
      const { x, y, count, button } = request.point;
      const key = JSON.stringify([request.requestId, x, y, count, button]);
      if (snapshot.click) {
        if (snapshot.click.request === key && snapshot.click.result) return { ...snapshot.click.result };
        throw new PreDispatchFailure('This window capture was already used. Look at the window again.');
      }
      snapshot.click = { request: key };
    } else {
      if (snapshot.click) throw new PreDispatchFailure('This window capture was already used. Look at the window again.');
      this.snapshots.delete(request.snapshotId);
    }
    let runtimeEntered = false;
    try {
      return await runWithDesktopDeliveryInvocation({ actor: owner, lease, indicatorEpoch: epoch, targetWindowId: windowId,
        isIndicatorCurrent: value => this.options.activity.visibilityEpoch() === value,
        isTargetCurrent: current, onUnknown: () => this.stopUnknown() }, async () => {
        runtimeEntered = true;
        const result = await this.options.runtime.act(owner, request, signal);
        if (snapshot.click && result.outcome === 'dispatched') snapshot.click.result = { ...result };
        if (result.outcome === 'unknown' && !isRecordedDesktopOutcome(result)) this.stopUnknown();
        return result;
      });
    } catch (error) {
      this.snapshots.delete(request.snapshotId);
      try { await this.options.runtime.closeActor(owner); }
      catch (cleanupError) {
        if (!runtimeEntered || error instanceof PreDispatchFailure) throw new PreDispatchRecoveryRequired(cleanupError);
        throw new Error('Cua cleanup failed; the desktop action outcome may be unknown', { cause: cleanupError });
      }
      if (error instanceof PreDispatchFailure || error instanceof PreDispatchRecoveryRequired) throw error;
      if (!runtimeEntered) throw new PreDispatchFailure(error);
      if (error instanceof CuaSemanticRuntimeError && error.outcome !== 'unknown') {
        if (error.code === 'cleanup_unconfirmed') throw new PreDispatchRecoveryRequired(error);
        throw new PreDispatchFailure(error);
      }
      throw error;
    }
  }

  private snapshot(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, snapshotId: string): Snapshot {
    this.prune();
    const value = this.snapshots.get(snapshotId);
    if (!value || value.sessionId !== actor?.sessionId || value.taskId !== actor?.taskId || value.turnId !== lease?.turnId) {
      throw new Error('Desktop semantic snapshot is unavailable');
    }
    return value;
  }

  private prepare(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, surfaceId: string | undefined, windowId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!actor || !lease || typeof actor.isCurrent !== 'function' || !actor.isCurrent() || actor.sessionId !== lease.owner ||
        typeof lease.turnId !== 'string' || !lease.turnId || typeof lease.isCurrent !== 'function' || !lease.isCurrent() ||
        !lease.signal || lease.signal.aborted || (surfaceId !== undefined && (typeof surfaceId !== 'string' || !surfaceId.trim())) ||
        typeof windowId !== 'string' || !windowId.trim()) throw new Error('Desktop semantic caller is unavailable');
    const epoch = this.options.activity.visibilityEpoch();
    if (epoch === undefined) throw new Error('Desktop indicator is not visible');
    const owner: CuaSemanticActor = Object.freeze({ sessionId: actor.sessionId, taskId: actor.taskId, turnId: lease.turnId,
      lifetimeSignal: lease.signal, isCurrent: () => actor.isCurrent() && lease.isCurrent() && !lease.signal.aborted });
    const target = this.options.resolveTarget(owner, windowId);
    if (!target || (surfaceId !== undefined && target.surfaceId !== surfaceId) || typeof target.isCurrent !== 'function' || target.isCurrent() !== true) throw new Error('Desktop semantic target changed');
    const current = () => owner.isCurrent() && target.isCurrent() === true &&
      this.options.activity.visibilityEpoch() === epoch && !signal?.aborted;
    if (!current()) throw new Error('Desktop semantic target or indicator changed');
    return { owner, current, epoch };
  }

  private prune(): void { for (const [id, value] of this.snapshots) if (value.expiresAt <= Date.now()) this.snapshots.delete(id); }
  private stopUnknown(): void {
    void this.options.activity.stop().catch(error => {
      try { this.options.reportStopError(error); }
      catch (reportError) { console.error('[desktop] Failed to report desktop stop error', reportError); }
    });
  }
}
