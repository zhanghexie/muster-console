import { PreDispatchFailure } from './preDispatchFailure';
import { DesktopGrantStore, MAX_DESKTOP_GRANT_TTL_MS, type DesktopGrantRequest } from './grants';
import type { DesktopDispatchJournal, PendingDesktopDispatch } from './dispatchJournal';
import type { DesktopUnknownState } from './unknownState';

type Audit = (entry: { taskId: string; appId: string; surfaceId: string; action: string;
  stage: 'application-approval' | 'object-approval' | 'dispatch-intent' | 'dispatch-result' | 'reconciliation' | 'reconsideration';
  result: 'allowed' | 'denied' | 'dispatched' | 'unknown'; objectFingerprint?: string;
  resolution?: 'confirmed-applied' | 'confirmed-not-applied' | 'abandoned' }) => Promise<void>;

/** The host derives identity and effect classification; model arguments are never authority. */
export interface DesktopAuthorityDependencies {
  actions: readonly string[];
  grantTtlMs: number;
  confirmApplication: (request: DesktopGrantRequest) => Promise<boolean>;
  confirmObject: (request: DesktopGrantRequest) => Promise<boolean>;
  audit: Audit;
  journal: DesktopDispatchJournal;
  unknownState: DesktopUnknownState;
  now?: () => number;
  turnGranted?: (taskId: string) => boolean;
}

/** A staging gate: adapters and all mediated channels must be wired here before exposure. */
export class DesktopAuthority {
  private readonly store: DesktopGrantStore;
  private readonly grants = new Map<string, string>();
  private readonly approvedObjects = new Map<string, Set<string>>();
  private readonly deniedApplications = new Set<string>();
  private readonly deniedObjects = new Map<string, Set<string>>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly revokedTasks = new Set<string>();
  private readonly unknownTasks: DesktopUnknownState;
  private readonly inFlightTasks = new Set<string>();
  private readonly actions: readonly string[];
  private readonly grantTtlMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: DesktopAuthorityDependencies) {
    if (!deps.actions.length || deps.actions.some(action => typeof action !== 'string' || !action.trim()) ||
        !Number.isSafeInteger(deps.grantTtlMs) || deps.grantTtlMs < 1 || deps.grantTtlMs > MAX_DESKTOP_GRANT_TTL_MS || typeof deps.audit !== 'function' ||
        typeof deps.confirmApplication !== 'function' || typeof deps.confirmObject !== 'function' ||
        !deps.unknownState || typeof deps.unknownState.has !== 'function' || typeof deps.unknownState.mark !== 'function' || typeof deps.unknownState.clear !== 'function' ||
        !deps.journal || typeof deps.journal.read !== 'function' || typeof deps.journal.begin !== 'function' ||
        typeof deps.journal.finish !== 'function' || typeof deps.journal.hasRefusal !== 'function' ||
        typeof deps.journal.recordRefusal !== 'function' || typeof deps.journal.clearRefusal !== 'function') throw new Error('Invalid desktop authority policy');
    // Grants live in memory, so a monotonic clock avoids extending them when wall time moves backwards.
    this.now = deps.now ?? (() => performance.now());
    this.unknownTasks = deps.unknownState;
    this.store = new DesktopGrantStore(this.now);
    this.actions = Object.freeze([...deps.actions]);
    this.grantTtlMs = deps.grantTtlMs;
  }

  revokeTask(taskId: string): void {
    this.revokedTasks.add(taskId);
    this.store.revokeTask(taskId);
    for (const key of this.grants.keys()) if (JSON.parse(key)[0] === taskId) {
      this.grants.delete(key); this.approvedObjects.delete(key);
    }
  }

  /** A coordinator failure without a durable marker requires manual recovery. */
  markCoordinationUnknown(taskId: string, recordId: string | null = null): void {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid desktop task identity');
    this.unknownTasks.mark(taskId, recordId);
  }

  /** Called only by the host coordinator after its task lock has been released. */
  async finishCoordinatedDispatch(taskId: string, recordId: string): Promise<void> {
    await this.deps.journal.finish(taskId, recordId);
  }

  /** Synchronous proof used by the coordinator immediately before releasing output. */
  isGrantCurrent(request: DesktopGrantRequest): boolean {
    if (this.revokedTasks.has(request.taskId)) return false;
    if (this.deps.turnGranted?.(request.taskId) === true) return true;
    const key = JSON.stringify([request.taskId, request.target.appId, request.target.processInstance]);
    const grant = this.grants.get(key);
    if (!grant || !this.store.check(grant, { ...request, effect: { kind: 'reversible' } }).allowed) return false;
    return request.effect.kind !== 'irreversible' ||
      this.approvedObjects.get(key)?.has(JSON.stringify([request.action, request.effect.objectFingerprint])) === true;
  }

  /** Fail before asking for further approval if an earlier action needs reconciliation. */
  async assertTaskAvailable(taskId: string): Promise<void> {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid desktop task identity');
    if (this.revokedTasks.has(taskId)) throw new Error('Desktop task ended');
    if (this.inFlightTasks.has(taskId) || this.unknownTasks.has(taskId)) throw new Error('Previous desktop action outcome is unknown or in flight; reconcile before continuing');
    const record = await this.deps.journal.read(taskId);
    if (record) {
      this.unknownTasks.mark(taskId, record.id);
      throw new Error('Previous desktop action outcome is unknown; reconcile before continuing');
    }
    if (this.revokedTasks.has(taskId) || this.inFlightTasks.has(taskId)) throw new Error('Desktop task changed');
  }

  /** Host-only: call after independent verification or explicit human disposition, never as an automatic retry. */
  async resolveUnknown(taskId: string, resolution: 'confirmed-applied' | 'confirmed-not-applied' | 'abandoned'): Promise<void> {
    if (this.inFlightTasks.has(taskId)) throw new Error('Desktop action is still in flight');
    const record = await this.deps.journal.read(taskId);
    const pending = record ? this.pendingFromRecord(taskId, record) : undefined;
    if (!pending || !['confirmed-applied', 'confirmed-not-applied', 'abandoned'].includes(resolution)) throw new Error('No unresolved desktop action or invalid resolution');
    if (record?.appId === 'builtin-browser') throw new Error('Browser action requires browser reconciliation');
    if (this.inFlightTasks.has(taskId)) throw new Error('Desktop action is still in flight');
    await this.deps.audit({ ...pending.audit, stage: 'reconciliation', result: 'allowed', resolution });
    await this.deps.journal.finish(taskId, pending.recordId);
    this.unknownTasks.clear(taskId, pending.recordId);
  }

  /** Host-only: invoke solely after the human explicitly requests reconsideration of this scope. */
  async clearRefusalAfterUserRequest(request: DesktopGrantRequest): Promise<void> {
    const target = request?.target;
    if (typeof request?.taskId !== 'string' || !request.taskId.trim() || typeof target?.appId !== 'string' || !target.appId.trim() ||
        typeof target.processInstance !== 'string' || !target.processInstance.trim() || typeof target.surfaceId !== 'string' || !target.surfaceId.trim() ||
        !this.actions.includes(request.action) || (request.effect?.kind !== 'reversible' && request.effect?.kind !== 'irreversible') ||
        (request.effect.kind === 'irreversible' && (typeof request.effect.objectFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(request.effect.objectFingerprint)))) throw new Error('Invalid desktop refusal scope');
    const key = JSON.stringify([request.taskId, target.appId, target.processInstance]);
    const objectKey = request.effect?.kind === 'irreversible' ? JSON.stringify([request.action, request.effect.objectFingerprint]) : undefined;
    const appScope = JSON.stringify(['application', key]), objectScope = objectKey ? JSON.stringify(['object', key, objectKey]) : undefined;
    const appDenied = this.deniedApplications.has(key) || await this.deps.journal.hasRefusal(request.taskId, appScope);
    const objectDenied = !!objectKey && (this.deniedObjects.get(key)?.has(objectKey) || await this.deps.journal.hasRefusal(request.taskId, objectScope!));
    if (!appDenied && !objectDenied) throw new Error('No matching desktop refusal');
    if (this.inFlightTasks.has(request.taskId)) throw new Error('Desktop action is still in flight');
    await this.deps.audit({ taskId: request.taskId, appId: target.appId, surfaceId: target.surfaceId,
      action: request.action, stage: 'reconsideration', result: 'allowed',
      ...(request.effect?.kind === 'irreversible' ? { objectFingerprint: request.effect.objectFingerprint } : {}) });
    if (appDenied && await this.deps.journal.hasRefusal(request.taskId, appScope)) await this.deps.journal.clearRefusal(request.taskId, appScope);
    if (objectDenied && objectScope && await this.deps.journal.hasRefusal(request.taskId, objectScope)) await this.deps.journal.clearRefusal(request.taskId, objectScope);
    if (appDenied) this.deniedApplications.delete(key);
    if (objectDenied && objectKey) this.deniedObjects.get(key)?.delete(objectKey);
  }

  private pendingFromRecord(taskId: string, record: PendingDesktopDispatch): { audit: Parameters<Audit>[0]; recordId: string } {
    return { recordId: record.id, audit: { taskId, appId: record.appId, surfaceId: record.surfaceId,
      action: record.action, stage: 'dispatch-result', result: 'unknown',
      ...(record.objectFingerprint ? { objectFingerprint: record.objectFingerprint } : {}) } };
  }

  /** Once dispatch starts, every failure or failed result audit is explicitly unknown and must not be replayed. */
  run<T>(request: DesktopGrantRequest, isCurrent: () => boolean, dispatch: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal,
    deferFinish = false, prepareDispatch?: (signal?: AbortSignal) => void): Promise<{ outcome: 'dispatched'; value: T; recordId?: string } | { outcome: 'unknown' }> {
    if (typeof request?.taskId !== 'string' || !request.taskId.trim() || typeof request.target?.appId !== 'string' || !request.target.appId.trim() ||
        typeof request.target.processInstance !== 'string' || !request.target.processInstance.trim() ||
        typeof request.target.surfaceId !== 'string' || !request.target.surfaceId.trim() ||
        typeof request.target.surfaceGeneration !== 'string' || !request.target.surfaceGeneration.trim() ||
        !this.actions.includes(request.action) || typeof request.foreground !== 'boolean' ||
        (request.effect?.kind !== 'reversible' && request.effect?.kind !== 'irreversible') ||
        (request.effect.kind === 'irreversible' && (typeof request.effect.objectFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(request.effect.objectFingerprint)))) return Promise.reject(new Error('Invalid desktop action request'));
    request = Object.freeze({ ...request, target: Object.freeze({ ...request.target }), effect: Object.freeze({ ...request.effect }) });
    const key = JSON.stringify([request.taskId, request.target.appId, request.target.processInstance]);
    // Serialize the entire task, not just an application: unknown writes block every later dispatch.
    const previous = this.tails.get(request.taskId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const assertCurrent = (): void => {
        signal?.throwIfAborted();
        if (this.unknownTasks.has(request.taskId)) throw new Error('Previous desktop action outcome is unknown; reconcile before continuing');
        if (this.revokedTasks.has(request.taskId) || !isCurrent()) throw new Error('Desktop target or task changed');
      };
      const audit = (stage: Parameters<Audit>[0]['stage'], result: Parameters<Audit>[0]['result']) => this.deps.audit({
        taskId: request.taskId, appId: request.target.appId, surfaceId: request.target.surfaceId, action: request.action, stage, result,
        ...(request.effect.kind === 'irreversible' ? { objectFingerprint: request.effect.objectFingerprint } : {})
      });
      assertCurrent();
      const persisted = await this.deps.journal.read(request.taskId);
      if (persisted) {
        this.unknownTasks.mark(request.taskId, persisted.id);
        throw new Error('Previous desktop action outcome is unknown; reconcile before continuing');
      }
      assertCurrent();
      let grant = this.grants.get(key);
      const appScope = JSON.stringify(['application', key]);
      // Object approvals bind the exact operation and object within this grant's lifetime.
      const reversible = { ...request, effect: { kind: 'reversible' as const } };
      if (!this.deps.turnGranted?.(request.taskId) && (this.deniedApplications.has(key) || await this.deps.journal.hasRefusal(request.taskId, appScope))) throw new Error('Desktop application authorization was previously declined');
      assertCurrent();
      if (!this.deps.turnGranted?.(request.taskId) && (!grant || !this.store.check(grant, reversible).allowed)) {
        const approved = await this.deps.confirmApplication(request) === true;
        if (!approved) { this.deniedApplications.add(key); await this.deps.journal.recordRefusal(request.taskId, appScope); }
        await audit('application-approval', approved ? 'allowed' : 'denied');
        assertCurrent();
        if (!approved) throw new Error('Desktop application authorization declined');
        grant = this.store.issue({ taskId: request.taskId, appId: request.target.appId, processInstance: request.target.processInstance,
          surfaces: null, actions: this.actions, expiresAt: this.now() + this.grantTtlMs, foreground: true, irreversibleObjects: [] });
        this.grants.set(key, grant);
        this.approvedObjects.delete(key);
      }
      if (request.effect.kind === 'irreversible' && !this.deps.turnGranted?.(request.taskId)) {
        const objectKey = JSON.stringify([request.action, request.effect.objectFingerprint]);
        const objectScope = JSON.stringify(['object', key, objectKey]);
        const objects = this.approvedObjects.get(key) ?? new Set<string>();
        if (this.deniedObjects.get(key)?.has(objectKey) || await this.deps.journal.hasRefusal(request.taskId, objectScope)) throw new Error('Desktop object authorization was previously declined');
        assertCurrent();
        if (!objects.has(objectKey)) {
          const approved = await this.deps.confirmObject(request) === true;
          if (!approved) {
            const denied = this.deniedObjects.get(key) ?? new Set<string>();
            denied.add(objectKey); this.deniedObjects.set(key, denied);
            await this.deps.journal.recordRefusal(request.taskId, objectScope);
          }
          await audit('object-approval', approved ? 'allowed' : 'denied');
          assertCurrent();
          if (!approved) throw new Error('Desktop irreversible action declined');
          objects.add(objectKey); this.approvedObjects.set(key, objects);
        }
      }
      await audit('dispatch-intent', 'allowed');
      assertCurrent();
      if (!this.deps.turnGranted?.(request.taskId) && (!grant || !this.store.check(grant, reversible).allowed)) throw new Error('Desktop authorization expired or revoked');
      if (request.effect.kind === 'irreversible' && !this.deps.turnGranted?.(request.taskId) && !this.approvedObjects.get(key)?.has(JSON.stringify([request.action, request.effect.objectFingerprint]))) {
        throw new Error('Desktop object authorization expired or revoked');
      }
      this.inFlightTasks.add(request.taskId);
      let marker: PendingDesktopDispatch;
      try {
        marker = await this.deps.journal.begin(request.taskId, { appId: request.target.appId,
          surfaceId: request.target.surfaceId, action: request.action,
          ...(request.effect.kind === 'irreversible' ? { objectFingerprint: request.effect.objectFingerprint } : {}) });
      } catch (error) { this.inFlightTasks.delete(request.taskId); throw error; }
      let dispatchStarted = false;
      try {
        assertCurrent();
        if (!this.deps.turnGranted?.(request.taskId) && (!grant || !this.store.check(grant, reversible).allowed)) throw new Error('Desktop authorization expired or revoked');
        prepareDispatch?.(signal);
        dispatchStarted = true;
        const value = await dispatch(signal);
        assertCurrent();
        await audit('dispatch-result', 'dispatched');
        assertCurrent();
        if (!this.deps.turnGranted?.(request.taskId) && (!grant || !this.store.check(grant, reversible).allowed)) throw new Error('Desktop authorization expired or revoked');
        if (!deferFinish) await this.deps.journal.finish(request.taskId, marker.id);
        return { outcome: 'dispatched' as const, value, ...(deferFinish ? { recordId: marker.id } : {}) };
      } catch (error) {
        if (!dispatchStarted) {
          try {
            await this.deps.journal.finish(request.taskId, marker.id);
          } catch {
            this.unknownTasks.mark(request.taskId, marker.id);
            try { await audit('dispatch-result', 'unknown'); } catch { /* Still unknown; never replay. */ }
            return { outcome: 'unknown' as const };
          }
          throw new PreDispatchFailure(error);
        }
        this.unknownTasks.mark(request.taskId, marker.id);
        try { await audit('dispatch-result', 'unknown'); } catch { /* Still unknown; never replay. */ }
        return { outcome: 'unknown' as const };
      } finally { this.inFlightTasks.delete(request.taskId); }
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(request.taskId, tail);
    void tail.then(() => { if (this.tails.get(request.taskId) === tail) this.tails.delete(request.taskId); });
    return operation;
  }
}
