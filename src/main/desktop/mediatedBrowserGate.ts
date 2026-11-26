import { browserAuditAction, classifyMediatedBrowserOperation, type BrowserMediationPlan } from './mediatedBrowserPolicy';
import { isDesktopAuditAction, type DesktopAuditEntry } from './auditStore';
import type { DesktopDispatchJournal } from './dispatchJournal';
import type { DesktopTaskLock } from './taskLock';
import type { DesktopUnknownState } from './unknownState';

export interface TrustedBrowserActor { sessionId: string; taskId: string; isCurrent(): boolean }
export interface TrustedBrowserTarget { identity: string; isCurrent(): boolean }
type AuditStage = 'approval' | 'dispatch-intent' | 'dispatch-result' | 'reconciliation';
type AuditResult = 'allowed' | 'denied' | 'dispatched' | 'unknown';
type Resolution = 'confirmed-applied' | 'confirmed-not-applied' | 'abandoned';
type GateOutcome<T> = { outcome: 'completed'; value: T } | { outcome: 'unknown'; cleanup?: 'completed' | 'failed'; audit?: 'failed' } | { outcome: 'cleaned'; disclosed: false };

function snapshotArguments(args: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid browser arguments');
  const encoded = JSON.stringify(args, (_key, value: unknown) => {
    if ((typeof value === 'number' && !Number.isFinite(value)) || typeof value === 'function' ||
        typeof value === 'symbol' || typeof value === 'bigint') throw new Error('Invalid browser argument value');
    return value;
  });
  if (typeof encoded !== 'string') throw new Error('Invalid browser arguments');
  const copy: unknown = JSON.parse(encoded);
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('Invalid browser arguments');
  const stack: object[] = [copy];
  while (stack.length) {
    const value = stack.pop()!;
    for (const item of Object.values(value)) if (item && typeof item === 'object') stack.push(item);
    Object.freeze(value);
  }
  return copy as Readonly<Record<string, unknown>>;
}

/** Staging composition: every caller must bind identity and use the same host authority. */
export class MediatedBrowserGate {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly unknownTasks: DesktopUnknownState;
  constructor(private readonly resolveTarget: (actor: Readonly<TrustedBrowserActor>, plan: Readonly<BrowserMediationPlan>,
    name: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<TrustedBrowserTarget>,
    private readonly authorize: (actor: Readonly<TrustedBrowserActor>, target: Readonly<TrustedBrowserTarget>,
      plan: Readonly<BrowserMediationPlan>, signal?: AbortSignal) => Promise<() => boolean>,
    private readonly audit: (entry: { actor: Readonly<TrustedBrowserActor>; target: Readonly<TrustedBrowserTarget>;
      action: DesktopAuditEntry['action']; stage: AuditStage; result: AuditResult; resolution?: Resolution }) => Promise<void>,
    private readonly journal: Pick<DesktopDispatchJournal, 'read' | 'begin' | 'finish'>,
    private readonly lock: Pick<DesktopTaskLock, 'run'>, unknownState: DesktopUnknownState) {
    this.unknownTasks = unknownState;
    if (typeof resolveTarget !== 'function' || typeof authorize !== 'function' || typeof audit !== 'function' ||
        !journal || typeof journal.read !== 'function' || typeof journal.begin !== 'function' || typeof journal.finish !== 'function' ||
        !lock || typeof lock.run !== 'function' || !unknownState || typeof unknownState.has !== 'function' ||
        typeof unknownState.mark !== 'function' || typeof unknownState.clear !== 'function') throw new Error('Invalid browser mediation gate');
  }

  /** Host-only reconciliation after independent verification or an explicit human decision. */
  async reconcile(raw: TrustedBrowserActor,
    verify: (pending: Readonly<NonNullable<Awaited<ReturnType<DesktopDispatchJournal['read']>>>>) => Promise<Resolution | undefined>): Promise<Resolution> {
    if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || typeof raw.taskId !== 'string' || !raw.taskId.trim() ||
        typeof raw.isCurrent !== 'function' || typeof verify !== 'function') throw new Error('Invalid browser reconciliation');
    const actor = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, isCurrent: raw.isCurrent.bind(raw) });
    const current = (): void => { if (actor.isCurrent() !== true) throw new Error('Browser caller changed'); };
    const previous = this.tails.get(actor.taskId) ?? Promise.resolve();
    const operation = previous.then(() => this.lock.run(actor.taskId, async () => {
      current();
      const pending = await this.journal.read(actor.taskId);
      if (!pending) throw new Error('No durable browser dispatch record; manual recovery is required');
      if (pending.appId !== 'builtin-browser') throw new Error('Pending dispatch belongs to another desktop surface');
      if (!isDesktopAuditAction(pending.action)) throw new Error('Pending browser action is invalid');
      current();
      const resolution = await verify(Object.freeze({ ...pending }));
      if (resolution !== 'confirmed-applied' && resolution !== 'confirmed-not-applied' && resolution !== 'abandoned') throw new Error('Browser reconciliation was not confirmed');
      current();
      const target = Object.freeze({ identity: pending.surfaceId, isCurrent: () => actor.isCurrent() });
      await this.audit({ actor, target, action: pending.action, stage: 'reconciliation', result: 'allowed', resolution });
      current();
      await this.journal.finish(actor.taskId, pending.id);
      this.unknownTasks.clear(actor.taskId, pending.id);
      return resolution;
    }));
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(actor.taskId, tail);
    void tail.then(() => { if (this.tails.get(actor.taskId) === tail) this.tails.delete(actor.taskId); });
    return operation;
  }

  async run<T>(raw: TrustedBrowserActor, name: string, args: Readonly<Record<string, unknown>>,
    dispatch: (args: Readonly<Record<string, unknown>>, signal?: AbortSignal) => Promise<T>,
    /** Must stop the bound recording and discard undisclosed output, even after a failed stop. */
    cleanup?: (args: Readonly<Record<string, unknown>>) => Promise<void>, signal?: AbortSignal): Promise<GateOutcome<T>> {
    if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId.trim() || typeof raw.taskId !== 'string' || !raw.taskId.trim() ||
        typeof raw.isCurrent !== 'function' || typeof dispatch !== 'function') throw new Error('Invalid browser actor');
    const actor = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, isCurrent: raw.isCurrent.bind(raw) });
    const snapshot = snapshotArguments(args);
    const plan = Object.freeze(classifyMediatedBrowserOperation(name, snapshot)), action = browserAuditAction(name, snapshot);
    if (plan.cleanup && typeof cleanup !== 'function') throw new Error('Recording cleanup is required');
    const identityCurrent = (): void => { if (actor.isCurrent() !== true) throw new Error('Browser caller changed'); };
    const actorCurrent = (): void => { signal?.throwIfAborted(); identityCurrent(); };
    identityCurrent();
    if (!plan.cleanup) signal?.throwIfAborted();
    const resolved = await this.resolveTarget(actor, plan, name, snapshot, plan.cleanup ? undefined : signal);
    if (!resolved || typeof resolved.identity !== 'string' || !resolved.identity.trim() || typeof resolved.isCurrent !== 'function') throw new Error('Invalid browser target');
    const target = Object.freeze({ identity: resolved.identity, isCurrent: resolved.isCurrent.bind(resolved) });
    const current = (): void => { actorCurrent(); if (target.isCurrent() !== true) throw new Error('Browser target changed'); };
    const writeAudit = (stage: AuditStage, result: AuditResult) => this.audit({ actor, target, action, stage, result });
    const cleanAfter = async (reason: unknown, failedMessage: string): Promise<void> => {
      try { await cleanup!(snapshot); }
      catch (cleanupError) { throw new AggregateError([reason, cleanupError], failedMessage); }
      try { await writeAudit('dispatch-result', 'dispatched'); }
      catch (auditError) { throw new AggregateError([reason, auditError], 'Browser cleanup completed but audit failed'); }
    };
    // Explicit cancellation is cleanup only; never block it on disclosure approval or audit availability.
    if (plan.cleanup && !plan.pixelRead && !plan.contentRead && !plan.unknownEffect) {
      identityCurrent();
      if (target.isCurrent() !== true) throw new Error('Browser target changed');
      await cleanup!(snapshot);
      try { await writeAudit('dispatch-result', 'dispatched'); }
      catch (error) { throw new Error(`Browser cleanup completed but audit failed: ${String(error)}`); }
      return { outcome: 'cleaned', disclosed: false };
    }
    const needsJournal = plan.unknownEffect || name === 'browser.recording' && (snapshot.action === 'start' || snapshot.action === 'stop');
    let completedMarker: string | undefined;
    let completedProof: (() => boolean) | undefined;
    const execute = async (): Promise<GateOutcome<T>> => {
    try {
      if (needsJournal && (this.unknownTasks.has(actor.taskId) || await this.journal.read(actor.taskId))) {
        throw new Error('Previous desktop or browser action outcome is unknown; reconcile before continuing');
      }
    } catch (error) {
      if (plan.cleanup) {
        await cleanAfter(error, 'Browser journal check and cleanup failed');
      }
      throw error;
    }
    let proof: () => boolean;
    try {
      current();
      proof = await this.authorize(actor, target, plan, signal);
      current();
      if (typeof proof !== 'function' || proof() !== true) throw new Error('Browser authorization is unavailable');
      await writeAudit('approval', 'allowed');
      current();
      if (proof() !== true) throw new Error('Browser authorization changed');
    } catch (error) {
      // Stop an owned recording even when permission to disclose its output is denied.
      if (plan.cleanup) {
        await cleanAfter(error, 'Browser authorization and cleanup failed');
      }
      try { await writeAudit('approval', 'denied'); }
      catch (auditError) { throw new AggregateError([error, auditError], 'Browser authorization failed and denial audit failed'); }
      throw error;
    }
    let marker: Awaited<ReturnType<DesktopDispatchJournal['begin']>> | undefined;
    try {
      await writeAudit('dispatch-intent', 'allowed');
      current();
      if (proof() !== true) throw new Error('Browser authorization changed');
      if (needsJournal) marker = await this.journal.begin(actor.taskId, { appId: 'builtin-browser', surfaceId: target.identity, action });
    } catch (error) {
      if (plan.cleanup) {
        await cleanAfter(error, 'Browser dispatch was blocked and cleanup failed');
      }
      throw error;
    }
    try {
      current();
      if (proof() !== true) throw new Error('Browser authorization changed');
      const value = await dispatch(snapshot, signal);
      current();
      if (proof() !== true) throw new Error('Browser authorization changed');
      await writeAudit('dispatch-result', 'dispatched');
      current();
      if (proof() !== true) throw new Error('Browser authorization changed');
      if (marker) { completedMarker = marker.id; completedProof = proof; }
      return { outcome: 'completed', value };
    } catch {
      if (needsJournal) this.unknownTasks.mark(actor.taskId, marker?.id ?? null);
      let cleanupStatus: 'completed' | 'failed' | undefined;
      if (plan.cleanup) {
        try { await cleanup!(snapshot); cleanupStatus = 'completed'; }
        catch { cleanupStatus = 'failed'; }
      }
      let auditFailed = false;
      try { await writeAudit('dispatch-result', 'unknown'); } catch { auditFailed = true; }
      return { outcome: 'unknown', ...(cleanupStatus ? { cleanup: cleanupStatus } : {}), ...(auditFailed ? { audit: 'failed' as const } : {}) };
    }
    };
    if (!needsJournal) return execute();
    const previous = this.tails.get(actor.taskId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      let result: GateOutcome<T> | undefined;
      let entered = false;
      try {
        const lockedResult = await this.lock.run(actor.taskId, async () => { entered = true; result = await execute(); return result; });
        if (completedMarker) {
          current();
          if (completedProof?.() !== true) throw new Error('Browser authorization changed');
          await this.journal.finish(actor.taskId, completedMarker);
          current();
          if (completedProof?.() !== true) throw new Error('Browser authorization changed');
        }
        return lockedResult;
      }
      catch (error) {
        if (result) {
          if (!this.unknownTasks.has(actor.taskId)) this.unknownTasks.mark(actor.taskId, completedMarker ?? null);
          let cleanupStatus: 'completed' | 'failed' | undefined = result.outcome === 'unknown' ? result.cleanup : undefined;
          if (plan.cleanup && !cleanupStatus) { try { await cleanup!(snapshot); cleanupStatus = 'completed'; } catch { cleanupStatus = 'failed'; } }
          let auditFailed = false;
          try { await writeAudit('dispatch-result', 'unknown'); } catch { auditFailed = true; }
          return { outcome: 'unknown' as const, ...(cleanupStatus ? { cleanup: cleanupStatus } : {}), ...(auditFailed ? { audit: 'failed' as const } : {}) };
        }
        if (!entered && plan.cleanup) {
          try { await cleanup!(snapshot); }
          catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser coordination and cleanup failed'); }
          try { await writeAudit('dispatch-result', 'dispatched'); }
          catch (auditError) { throw new AggregateError([error, auditError], 'Browser cleanup completed but audit failed'); }
        }
        throw error;
      }
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(actor.taskId, tail);
    void tail.then(() => { if (this.tails.get(actor.taskId) === tail) this.tails.delete(actor.taskId); });
    return operation;
  }
}
