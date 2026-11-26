import { DesktopActivity, type DesktopActivityHandle, type DesktopActivityTurn, type DesktopUserInstruction } from './desktopActivity';
import type { HostDesktopContinuation, HostDesktopContinuationOrigin } from '../../shared/hostNotification';
import { PreDispatchFailure } from './preDispatchFailure';

type TurnEntry = { turnId: string; token: DesktopActivityTurn; ended: boolean; alive: { current: boolean }; current(): boolean;
  ready: Promise<void>; starting?: Promise<DesktopActivityHandle>; handle?: DesktopActivityHandle;
  continuation?: HostDesktopContinuation; workspaceId?: string;
  restrictions: Array<{ continuation: HostDesktopContinuation; workspaceId: string }>;
  blocked: boolean; pendingRestrictions: number; inFlight: number };

/** Host-only lifetime for acknowledging a result after its seat operation returns. */
export interface DesktopDeliveryLease { readonly owner: string; readonly turnId: string; readonly signal: AbortSignal; isCurrent(): boolean }

/** Host-owned association of tool calls with a turn created before its first desktop use. */
export class DesktopTurns {
  private readonly turns = new Map<string, TurnEntry>();
  private readonly instructions = new Map<string, Map<string, DesktopUserInstruction>>();
  private serial = 0;
  constructor(private readonly activity: DesktopActivity) {}

  /** Only the trusted host may record a real user message at acceptance time. */
  noteUserInstruction(owner: string, messageId: string): void {
    if (!owner || !messageId) throw new Error('Desktop instruction identity is required');
    let messages = this.instructions.get(owner);
    if (!messages) {
      if (this.instructions.size >= 512) this.instructions.delete(this.instructions.keys().next().value!);
      messages = new Map(); this.instructions.set(owner, messages);
    }
    if (messages.size >= 64) messages.delete(messages.keys().next().value!);
    messages.set(messageId, this.activity.noteUserInstruction(owner));
  }

  begin(owner: string, turnId: string, isCurrent: () => boolean, userInstruction = false, messageId?: string,
    options?: { continuation?: HostDesktopContinuation; workspaceId: string }): void {
    const messages = this.instructions.get(owner);
    const instruction = userInstruction && messageId ? messages?.get(messageId) : undefined;
    const prior = this.turns.get(owner);
    if (prior) this.end(owner, prior.turnId);
    const alive = { current: true };
    const current = (): boolean => { try { return alive.current && isCurrent() === true; } catch { return false; } };
    if (messageId) messages?.delete(messageId);
    if (messages && messages.size === 0) this.instructions.delete(owner);
    // Losing an old acceptance token blocks only desktop use; the surrounding
    // agent turn may still answer text and perform unrelated work.
    let ready = userInstruction && !instruction
      ? Promise.reject(new Error('Desktop user instruction was not accepted in the current host lifetime'))
      : instruction ? this.activity.resumeForUserInstruction(owner, instruction) : Promise.resolve();
    const continuation = options?.continuation;
    if (continuation) ready = ready.then(() => continuation.ready?.()).then(() => {
      this.activity.assertContinuation(owner, options!.workspaceId, continuation);
    });
    void ready.catch(() => undefined);
    this.turns.set(owner, { turnId, token: this.activity.createTurn(owner, `${turnId}:${++this.serial}`, current, instruction,
      options?.continuation, options?.workspaceId), ended: false, alive, current, ready,
      ...(continuation ? { continuation } : {}), ...(options?.workspaceId ? { workspaceId: options.workspaceId } : {}),
      restrictions: [], blocked: false, pendingRestrictions: 0, inFlight: 0 });
  }

  /** Capture the exact authenticated tool turn before waitFor yields or creates its record. */
  captureContinuation(owner: string, turnId: string, workspaceId: string, sourceCurrent: () => boolean): Promise<HostDesktopContinuationOrigin | undefined> | undefined {
    const entry = this.turns.get(owner);
    if (!entry || entry.ended || entry.turnId !== turnId || entry.workspaceId !== workspaceId || entry.blocked || !entry.current()) return undefined;
    try { if (sourceCurrent() !== true) return undefined; } catch { return undefined; }
    const complete = this.activity.captureContinuationOrigin(entry.token, workspaceId);
    if (!complete) return undefined;
    const ready = entry.ready;
    const restrictions = [...entry.restrictions];
    return ready.then(() => {
      for (const item of restrictions) this.activity.assertContinuation(owner, item.workspaceId, item.continuation);
      return complete();
    });
  }

  /** Intersect a native host interjection before its content reaches the engine. */
  intersectContinuation(owner: string, turnId: string, workspaceId: string, continuation?: HostDesktopContinuation): void {
    const entry = this.turns.get(owner);
    if (!entry || entry.ended) return;
    if (entry.turnId !== turnId) { this.blockCurrent(owner); return; }
    const deny = () => { entry.blocked = true; if (entry.handle) this.activity.cancel(entry.handle); };
    if (!continuation || !workspaceId || entry.blocked) { deny(); return; }
    let pending: boolean;
    try { pending = continuation.pending?.() === true; }
    catch { deny(); return; }
    if (!pending) {
      if (!this.activity.continuationCurrent(owner, workspaceId, continuation)) { deny(); return; }
      entry.restrictions.push({ continuation, workspaceId });
      return;
    }
    // Never let a potentially stale message coexist with an active input call.
    if (entry.inFlight > 0) { deny(); return; }
    entry.pendingRestrictions++;
    entry.restrictions.push({ continuation, workspaceId });
    const prior = entry.ready;
    const ready = prior.then(() => continuation.ready?.()).then(() => {
      this.activity.assertContinuation(owner, workspaceId, continuation);
    }).finally(() => { entry.pendingRestrictions--; });
    entry.ready = ready;
    void ready.catch(deny);
  }

  async use<T>(owner: string, turnId: string, target: string,
    action: (signal: AbortSignal, delivery: DesktopDeliveryLease) => Promise<T>, mutation = true): Promise<T> {
    const entry = this.turns.get(owner);
    if (!entry || entry.ended || entry.turnId !== turnId) throw new Error('Desktop turn is unavailable');
    if (entry.blocked) throw new Error('Desktop continuation source is unavailable or was stopped');
    if (!entry.starting) {
      entry.starting = entry.ready.then(() => {
        if (entry.ended || entry.blocked || this.turns.get(owner) !== entry) throw new Error('Desktop turn ended before use');
        return this.activity.start(entry.token, target);
      });
      void entry.starting.then(handle => {
        entry.handle = handle;
        if (entry.ended || entry.blocked || this.turns.get(owner) !== entry) this.activity.cancel(handle);
      }, () => undefined);
    }
    const handle = await entry.starting;
    await entry.ready;
    if (entry.ended || this.turns.get(owner) !== entry) throw new Error('Desktop turn ended before use');
    if (entry.blocked) throw new Error('Desktop continuation source is unavailable or was stopped');
    for (const item of entry.restrictions) this.activity.assertContinuation(owner, item.workspaceId, item.continuation);
    const delivery: DesktopDeliveryLease = Object.freeze({ owner, turnId, signal: handle.run.signal, isCurrent: () =>
      !entry.ended && entry.current() && this.turns.get(owner) === entry && entry.handle === handle &&
      !entry.blocked && entry.pendingRestrictions === 0 &&
      (!entry.continuation || this.activity.continuationCurrent(owner, entry.workspaceId ?? '', entry.continuation)) &&
      entry.restrictions.every(item => this.activity.continuationCurrent(owner, item.workspaceId, item.continuation)) &&
      handle.run.status === 'active' && !handle.run.signal.aborted });
    entry.inFlight++;
    let result: T;
    try { result = await this.activity.execute(handle, signal => {
      // A continuation may have been revoked while this call waited for the input seat.
      // No backend has been invoked here, so do not report an unknown dispatch.
      if (!delivery.isCurrent()) throw new PreDispatchFailure('Desktop continuation source is no longer current');
      return action(signal, delivery);
    }, mutation); }
    finally { entry.inFlight--; }
    if (entry.ended || this.turns.get(owner) !== entry) throw new Error('Desktop turn ended after dispatch; outcome may be unknown');
    if (!delivery.isCurrent()) {
      this.activity.cancel(handle);
      throw new Error('Desktop continuation changed during dispatch; outcome may be unknown');
    }
    return result;
  }

  end(owner: string, turnId: string): void {
    const entry = this.turns.get(owner);
    if (!entry || entry.turnId !== turnId || entry.ended) return;
    entry.ended = true;
    entry.alive.current = false;
    if (entry.handle) this.activity.cancel(entry.handle);
    this.turns.delete(owner);
  }

  /** Fail closed if an interjection has no trustworthy active turn identity. */
  blockCurrent(owner: string): void {
    const entry = this.turns.get(owner);
    if (!entry || entry.ended) return;
    entry.blocked = true;
    if (entry.handle) this.activity.cancel(entry.handle);
  }

  stop(persist = true): Promise<void> { return this.activity.stop(persist); }
}
