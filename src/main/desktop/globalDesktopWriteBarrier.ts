import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DesktopTaskLock, DesktopTaskLockCleanupError, DesktopTaskLockContendedError } from './taskLock';
import { transitionFromLegacyDesktop } from './legacyDesktopMigration';
import { assertGlobalTransition, readLegacyActionReceipts, legacyReceiptPreview, assertLegacyOutboxesClear,
  type GlobalDesktopTransitionFence, type GlobalLegacyReceipt, type GlobalLegacyPreview } from './globalDesktopLegacy';
import { GlobalDesktopWriteStore, GlobalDesktopWriteRejected, globalWriteDigest, type GlobalWriteMarker, type GlobalLegacyEpoch } from './globalDesktopWriteStore';
import { boundedVisibleActionResult, type VisibleActionJson } from './visibleActionJson';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';

const LOCK_KEY = 'muster-global-desktop-write-v1';
const DB_NAME = 'global-desktop-write.sqlite';

export interface GlobalDesktopWriteContext {
  /**
   * Host-owned durable logical-operation identity, never a raw model request ID.
   * Distinct operations in different tasks need distinct IDs even if their public
   * request IDs coincide. Retries of the same operation must reuse its original
   * ID, including when a trusted continuation moves it to another task/session.
   */
  requestId: string;
  /** Host-captured public request ID, needed for old receipt deduplication after migration. */
  publicRequestId?: string;
  sessionId: string;
  taskId: string;
  action: string;
  target: string;
  fingerprint: string;
  isCurrent(): boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GlobalDesktopAuthority {
  /** Durable host policy: old desktop writers cannot start or dispatch outside this barrier. */
  legacyWritersExcluded(): boolean;
  /** Old automatic continuations cannot dispatch through any new writer, including with an empty old receipt store. */
  legacyAutomaticContinuationsExcluded(): boolean;
  /** Must consult a host-owned receipt proving delivery of this exact operation, not model-supplied claims. */
  verifyDelivery(input: Readonly<{ marker: GlobalWriteMarker; evidenceId: string }>): boolean;
  /** Must establish the original executor is stopped, not just inspect PID or elapsed time. */
  executorStopped(marker: GlobalWriteMarker): boolean;
  /** Must independently verify both the exact operation and the recorded outcome/audit evidence. */
  verifyRecovery(input: Readonly<{ marker: GlobalWriteMarker; evidenceId: string;
    resolution: 'confirmed-applied' | 'confirmed-not-applied' }>): boolean;
  /**
   * Host-only proof of a real user event for this exact marker. The verifier must
   * independently establish that the user was told the outcome is unknown and
   * explicitly chose to continue. Bind the event to all marker identity, phase
   * and result fields, not just its operation ID. Return the stable host event ID
   * only for an authentic, current proof, never for model text or arguments. The
   * check must be synchronous and repeatable; SQLite consumes the event hash.
   */
  verifyUnknownContinuation?(input: Readonly<{ marker: GlobalWriteMarker; authorization: object }>): string | null;
  /**
   * Hold a host-owned exclusive migration fence: every v1 barrier executor has
   * stopped and no v1 executor can start, including after this callback returns.
   */
  verifyStorageUpgrade?(input: Readonly<{ from: 1; to: 2 }>): boolean;
  /** Must independently verify the abandoned lock while the separate host exclusion fence is held. */
  verifyAbandonedLock(input: Readonly<{ lockHash: string; lockRecordValid: boolean; marker: GlobalWriteMarker | null; evidenceId: string }>): boolean;
  onBackgroundCleanupError?(error: Error): void;
}

export interface GlobalDesktopRecoveryFence {
  /** Covers every desktop writer, prevents restart and remains held throughout lock inspection/removal. */
  isQuiescent(): boolean;
  holdsExclusiveFence(): boolean;
}

export type GlobalDesktopWriteOutcome =
  | { outcome: 'known'; operationId: string; value: VisibleActionJson;
      /** Host-private; never disclose the token to a model. */
      deliveryToken: string }
  | { outcome: 'unknown'; operationId: string; reason: 'request-already-recorded'; recordedRequest: true }
  | { outcome: 'unknown'; operationId: string; reason: 'backend-failed' | 'backend-uncertain' | 'interrupted' | 'timeout' |
      'result-persistence-failed' | 'current-changed' | 'lock-release-failed' };

/** A backend must explicitly classify uncertain effects; a returned object is not proof of success. */
export type GlobalDesktopBackendResult = { outcome: 'known'; value: unknown } | { outcome: 'unknown' };

export type GlobalDesktopFinalizeOutcome = { outcome: 'confirmed' | 'resolved' } |
  { outcome: 'unknown'; reason: 'lock-release-failed' | 'current-changed' | 'barrier-finalization-failed' };
export type GlobalDesktopUnknownContinueOutcome = { outcome: 'acknowledged-unknown' } |
  { outcome: 'unknown'; reason: 'lock-release-failed' | 'current-changed' | 'barrier-finalization-failed' };

/** No backend was entered, but a marker or lock may still need explicit recovery. */
export class GlobalDesktopPreDispatchRecoveryRequired extends PreDispatchRecoveryRequired {
  constructor(cause: unknown, readonly operationId?: string) {
    super(cause);
    this.name = 'GlobalDesktopPreDispatchRecoveryRequired';
  }
}

function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new Error('Invalid global desktop identity');
}

function checkAuthority(authority: GlobalDesktopAuthority): void {
  if (!authority || ['legacyWritersExcluded', 'legacyAutomaticContinuationsExcluded', 'verifyDelivery', 'executorStopped', 'verifyRecovery', 'verifyAbandonedLock']
    .some(name => typeof authority[name as keyof GlobalDesktopAuthority] !== 'function') ||
    (authority.onBackgroundCleanupError !== undefined && typeof authority.onBackgroundCleanupError !== 'function') ||
    (authority.verifyUnknownContinuation !== undefined && typeof authority.verifyUnknownContinuation !== 'function') ||
    (authority.verifyStorageUpgrade !== undefined && typeof authority.verifyStorageUpgrade !== 'function')) {
    throw new Error('Trusted global desktop authority callbacks are required');
  }
}

function excluded(authority: GlobalDesktopAuthority): void {
  try { if (authority.legacyWritersExcluded() === true && authority.legacyAutomaticContinuationsExcluded() === true) return; } catch { /* fail closed */ }
  throw new Error('Legacy desktop writers or automatic continuations are not durably excluded');
}

type CapturedContext = Readonly<GlobalDesktopWriteContext & { timeoutMs: number }>;
function snapshot(raw: GlobalDesktopWriteContext): CapturedContext {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid global desktop request');
  const { requestId, publicRequestId, sessionId, taskId, action, target, fingerprint, signal } = raw;
  for (const value of [requestId, sessionId, taskId, action, target]) identity(value);
  if ((publicRequestId !== undefined && (typeof publicRequestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(publicRequestId))) ||
      typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint) || typeof raw.isCurrent !== 'function' ||
      (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) ||
      !Number.isSafeInteger(raw.timeoutMs ?? 30000) || (raw.timeoutMs ?? 30000) < 1 || (raw.timeoutMs ?? 30000) > 60000) {
    throw new Error('Invalid global desktop request');
  }
  return Object.freeze({ requestId, publicRequestId, sessionId, taskId, action, target, fingerprint: fingerprint.toLowerCase(),
    isCurrent: raw.isCurrent.bind(raw), signal, timeoutMs: raw.timeoutMs ?? 30000 });
}

function assertCurrent(context: CapturedContext, authority: GlobalDesktopAuthority): void {
  excluded(authority);
  if (context.signal?.aborted || context.isCurrent() !== true || context.signal?.aborted) throw new Error('Global desktop request is no longer current');
}

function hashes(context: CapturedContext) {
  return { request: globalWriteDigest(context.requestId),
    context: globalWriteDigest(JSON.stringify([context.sessionId, context.taskId, context.action, context.target, context.publicRequestId ?? null])),
    legacyRequest: context.publicRequestId === undefined ? undefined : globalWriteDigest(JSON.stringify([context.sessionId, context.taskId, context.publicRequestId])),
    fingerprint: globalWriteDigest(context.fingerprint) };
}

function matches(marker: GlobalWriteMarker, context: CapturedContext, operationId: string): boolean {
  const value = hashes(context);
  return marker.operationId === operationId && marker.requestHash === value.request &&
    marker.contextHash === value.context && marker.fingerprintHash === value.fingerprint;
}

function captureBackendResult(raw: unknown): { outcome: 'known'; value: VisibleActionJson } | { outcome: 'unknown' } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('Invalid global desktop backend result');
  const descriptors = Object.getOwnPropertyDescriptors(raw), keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value')) ||
      !descriptors.outcome || !Object.hasOwn(descriptors.outcome, 'value')) throw new Error('Invalid global desktop backend result');
  if (descriptors.outcome.value === 'unknown' && keys.length === 1) return { outcome: 'unknown' };
  if (descriptors.outcome.value === 'known' && keys.length === 2 && descriptors.value && Object.hasOwn(descriptors.value, 'value')) {
    return { outcome: 'known', value: boundedVisibleActionResult(descriptors.value.value) };
  }
  throw new Error('Invalid global desktop backend result');
}

function rootPath(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('Global desktop storage directory must be absolute');
  const info = fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Global desktop storage directory is invalid');
  return fs.realpathSync.native(root);
}

interface GlobalLegacyTransitionOptions {
  root: string;
  legacyRoots: readonly string[];
  legacyOutboxes: readonly string[];
  fence: GlobalDesktopTransitionFence;
}

function captureTransitionOptions(raw: GlobalLegacyTransitionOptions): GlobalLegacyTransitionOptions {
  if (!raw || !Array.isArray(raw.legacyRoots) || !Array.isArray(raw.legacyOutboxes)) throw new Error('Invalid legacy desktop transition options');
  return Object.freeze({ root: raw.root, legacyRoots: Object.freeze([...raw.legacyRoots]),
    legacyOutboxes: Object.freeze([...raw.legacyOutboxes]), fence: raw.fence });
}

async function transitionRoots(options: GlobalLegacyTransitionOptions): Promise<{ root: string; legacyRoots: string[] }> {
  if (!options || typeof options.root !== 'string' || !path.isAbsolute(options.root)) throw new Error('Global desktop storage directory must be absolute');
  if (!Array.isArray(options.legacyRoots) || options.legacyRoots.length > 64 ||
      options.legacyRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new Error('Absolute paths for all legacy desktop roots are required');
  const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const uniqueRoots = new Set(options.legacyRoots.map(key));
  if (uniqueRoots.size !== options.legacyRoots.length) throw new Error('Duplicate legacy desktop root');
  await fsp.mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = rootPath(options.root), legacyRoots = [...options.legacyRoots];
  if (!uniqueRoots.has(key(root))) legacyRoots.unshift(root);
  return { root, legacyRoots };
}

/** Hold the same host fence while scanning every root and outbox. */
async function inspectLegacy(root: string, roots: readonly string[], outboxes: readonly string[], fence: GlobalDesktopTransitionFence): Promise<GlobalLegacyReceipt[]> {
  const receipts: GlobalLegacyReceipt[] = [];
  const visit = async (index: number): Promise<void> => {
    if (index < roots.length) {
      const transition = await transitionFromLegacyDesktop(roots[index], fence, () => visit(index + 1));
      if (transition.status !== 'activated') throw new Error(`Legacy desktop transition is blocked: ${transition.issues.map(item => item.code).join(', ')}`);
      return;
    }
    for (const legacyRoot of roots) receipts.push(...await readLegacyActionReceipts(legacyRoot, fence));
    legacyReceiptPreview(receipts);
    await assertLegacyOutboxesClear(root, outboxes, fence);
    assertGlobalTransition(fence);
  };
  await visit(0);
  return receipts;
}

/**
 * All desktop writers, in every process and task, must use one canonical host
 * root and this coordinator. Callers cannot safely mix old and new writers.
 */
export class GlobalDesktopWriteBarrier {
  private readonly lock: DesktopTaskLock;
  private readonly pendingCleanup = new Set<Promise<void>>();
  private active = 0;
  private closed = false;
  private backgroundFailure?: Error;
  private constructor(private readonly root: string, private readonly store: GlobalDesktopWriteStore,
    private readonly authority: GlobalDesktopAuthority) {
    this.lock = new DesktopTaskLock(path.join(root, 'global-write-locks'));
  }

  /** Read-only inspection of old receipts; activation performs a fresh scan. */
  static async previewLegacy(options: GlobalLegacyTransitionOptions): Promise<GlobalLegacyPreview> {
    const captured = captureTransitionOptions(options);
    const { root, legacyRoots } = await transitionRoots(captured);
    assertGlobalTransition(captured.fence);
    const lock = new DesktopTaskLock(path.join(root, 'global-write-locks'));
    const release = await lock.acquire(LOCK_KEY);
    try { return legacyReceiptPreview(await inspectLegacy(root, legacyRoots, captured.legacyOutboxes, captured.fence)); }
    finally { await release(); }
  }

  /** Import strictly completed legacy receipts under the host fence without claiming delivery. */
  static async activate(options: GlobalLegacyTransitionOptions & { authority: GlobalDesktopAuthority }): Promise<GlobalDesktopWriteBarrier> {
    const captured = captureTransitionOptions(options), authority = options.authority;
    checkAuthority(authority);
    const { root, legacyRoots } = await transitionRoots(captured);
    assertGlobalTransition(captured.fence); excluded(authority);
    const lock = new DesktopTaskLock(path.join(root, 'global-write-locks'));
    const release = await lock.acquire(LOCK_KEY);
    let store: GlobalDesktopWriteStore | undefined;
    let failure: unknown;
    const assertActivation = () => { assertGlobalTransition(captured.fence); excluded(authority); };
    try {
      const receipts = await inspectLegacy(root, legacyRoots, captured.legacyOutboxes, captured.fence);
      assertActivation();
      const file = path.join(root, DB_NAME);
      const handle = await fsp.open(file, 'wx', 0o600);
      await handle.close();
      store = new GlobalDesktopWriteStore(file, true);
      store.importLegacyReceipts(receipts, assertActivation);
      assertActivation();
    } catch (error) { failure = error; }
    try { await release(); } catch (error) { failure = failure ? new AggregateError([failure, error], 'Global desktop activation and lock release failed') : error; }
    if (!failure && store) {
      try { store.seal(assertActivation); }
      catch (error) { failure = error; }
    }
    if (failure || !store) {
      try { store?.close(); } catch (error) { failure = new AggregateError([failure, error], 'Global desktop activation cleanup failed'); }
      throw failure ?? new Error('Global desktop activation failed');
    }
    return new GlobalDesktopWriteBarrier(root, store, authority);
  }

  /** Ordinary startup never recreates a missing or incomplete store. */
  static open(root: string, authority: GlobalDesktopAuthority): GlobalDesktopWriteBarrier {
    checkAuthority(authority); excluded(authority);
    const canonical = rootPath(root);
    const assertMigration = () => {
      excluded(authority);
      if (authority.verifyStorageUpgrade?.(Object.freeze({ from: 1, to: 2 })) !== true) {
        throw new Error('An exclusive host fence excluding all v1 desktop executors is required for storage migration');
      }
    };
    return new GlobalDesktopWriteBarrier(canonical, new GlobalDesktopWriteStore(path.join(canonical, DB_NAME), false, assertMigration), authority);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Global desktop barrier is closed');
    if (this.backgroundFailure) throw new Error('Global desktop lock cleanup failed; independent recovery is required', { cause: this.backgroundFailure });
    excluded(this.authority);
  }

  inspect(): GlobalWriteMarker | null { this.assertOpen(); return this.store.read(); }

  /** The imported legacy receipts remain explicitly unverified for delivery. */
  inspectLegacyEpoch(): GlobalLegacyEpoch | null { this.assertOpen(); return this.store.legacyEpoch(); }

  private assertContext(context: CapturedContext): void {
    assertCurrent(context, this.authority);
  }

  async run(raw: GlobalDesktopWriteContext, backend: (signal: AbortSignal) => Promise<GlobalDesktopBackendResult>): Promise<GlobalDesktopWriteOutcome> {
    this.assertOpen();
    const context = snapshot(raw);
    if (typeof backend !== 'function') throw new Error('A global desktop backend is required');
    this.assertContext(context);
    const value = hashes(context);
    this.active++;
    let release: (() => Promise<void>) | undefined;
    let marker: GlobalWriteMarker | undefined;
    let dispatched = false, handedOff = false, persistenceAttempted = false, lookupAttempted = false, acquiring = false;
    let backendSettled = false, backendCompletion: Promise<unknown> | undefined, backendController: AbortController | undefined;
    const deferRelease = (): void => {
      if (!release || !backendCompletion) throw new Error('Global desktop backend cleanup is unavailable');
      const deferredRelease = release;
      const cleanup = backendCompletion.then(async () => { await deferredRelease(); }).catch(error => {
        this.backgroundFailure = error instanceof Error ? error : new Error(String(error));
        try { this.authority.onBackgroundCleanupError?.(this.backgroundFailure); } catch { /* retain failure locally */ }
      }).finally(() => { this.pendingCleanup.delete(cleanup); this.active--; });
      this.pendingCleanup.add(cleanup);
      release = undefined;
      handedOff = true;
    };
    try {
      // A committed record can be safely inspected without waiting for an
      // executing backend to relinquish the cross-process write lock. Never
      // recreate a result or delivery token from its digest.
      lookupAttempted = true;
      const previous = this.store.lookup(value.request, value.context, value.fingerprint, value.legacyRequest);
      lookupAttempted = false;
      if (previous) {
        this.assertContext(context);
        return { outcome: 'unknown', operationId: previous.operationId, reason: 'request-already-recorded', recordedRequest: true };
      }
      acquiring = true;
      release = await this.lock.acquire(LOCK_KEY);
      acquiring = false;
      this.assertOpen(); this.assertContext(context);
      persistenceAttempted = true;
      const begun = this.store.begin(value.request, value.context, value.fingerprint, value.legacyRequest, () => this.assertContext(context));
      if (begun.kind === 'recorded') {
        try { await release(); } catch (error) {
          release = undefined;
          throw new GlobalDesktopPreDispatchRecoveryRequired(error);
        }
        release = undefined;
        this.assertContext(context);
        return { outcome: 'unknown', operationId: begun.request.operationId, reason: 'request-already-recorded', recordedRequest: true };
      }
      marker = begun.marker;
      this.assertContext(context);
      const controller = new AbortController();
      backendController = controller;
      dispatched = true; // Marker is durable before this callback can run.
      const settled = Promise.resolve().then(() => {
        this.assertContext(context);
        controller.signal.throwIfAborted();
        return backend(controller.signal);
      }).then(
        value => ({ type: 'result' as const, value }), () => ({ type: 'failed' as const })).finally(() => { backendSettled = true; });
      backendCompletion = settled;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      const interrupted = new Promise<{ type: 'timeout' } | { type: 'interrupted' }>(resolve => {
        timer = setTimeout(() => resolve({ type: 'timeout' }), context.timeoutMs);
        if (context.signal) {
          stop = () => resolve({ type: 'interrupted' });
          if (context.signal.aborted) stop(); else context.signal.addEventListener('abort', stop, { once: true });
        }
      });
      const event = await Promise.race([settled, interrupted]);
      if (timer) clearTimeout(timer);
      if (stop) context.signal?.removeEventListener('abort', stop);
      if (event.type === 'timeout' || event.type === 'interrupted') {
        controller.abort();
        let reason: GlobalDesktopWriteOutcome & { outcome: 'unknown' } = { outcome: 'unknown', operationId: marker.operationId, reason: event.type };
        try { this.store.outcome(marker, 'unknown', null, null); }
        catch { reason = { ...reason, reason: 'result-persistence-failed' }; }
        // An uncooperative backend still holds the shared lock. Never release it
        // merely because its caller timed out; no subsequent action may run.
        deferRelease();
        return reason;
      }
      let outcome: GlobalDesktopWriteOutcome;
      const unknown = (reason: 'backend-failed' | 'backend-uncertain' | 'current-changed'): GlobalDesktopWriteOutcome => {
        try { this.store.outcome(marker!, 'unknown', null, null); return { outcome: 'unknown', operationId: marker!.operationId, reason }; }
        catch { return { outcome: 'unknown', operationId: marker!.operationId, reason: 'result-persistence-failed' }; }
      };
      let current = true;
      try { this.assertContext(context); } catch { current = false; }
      if (!current) outcome = unknown('current-changed');
      else if (event.type === 'failed') outcome = unknown('backend-failed');
      else {
        let result: ReturnType<typeof captureBackendResult> | undefined;
        try { result = captureBackendResult(event.value); } catch { /* malformed output is uncertain */ }
        if (!result || result.outcome === 'unknown') outcome = unknown('backend-uncertain');
        else {
          try {
            const resultHash = globalWriteDigest(JSON.stringify(result.value)), token = randomBytes(32).toString('base64url');
            this.store.outcome(marker, 'known', resultHash, GlobalDesktopWriteStore.tokenHash(marker, token, resultHash));
            outcome = { outcome: 'known', operationId: marker.operationId, value: result.value, deliveryToken: token };
          } catch { outcome = { outcome: 'unknown', operationId: marker.operationId, reason: 'result-persistence-failed' }; }
        }
      }
      try { await release(); release = undefined; }
      catch { release = undefined; return { outcome: 'unknown', operationId: marker.operationId, reason: 'lock-release-failed' }; }
      try { this.assertContext(context); }
      catch { return { outcome: 'unknown', operationId: marker.operationId, reason: 'current-changed' }; }
      return outcome;
    } catch (error) {
      if (acquiring && error instanceof DesktopTaskLockContendedError) {
        // The other writer may have committed between our initial lookup and
        // the EEXIST result. Contention alone proves nothing about identity.
        try { this.assertContext(context); } catch (currentError) { throw new PreDispatchFailure(currentError); }
        let previous: ReturnType<GlobalDesktopWriteStore['lookup']>;
        try { previous = this.store.lookup(value.request, value.context, value.fingerprint, value.legacyRequest); }
        catch (lookupError) {
          if (lookupError instanceof GlobalDesktopWriteRejected) throw new PreDispatchFailure(lookupError);
          throw new GlobalDesktopPreDispatchRecoveryRequired(lookupError);
        }
        try { this.assertContext(context); } catch (currentError) { throw new PreDispatchFailure(currentError); }
        if (previous) return { outcome: 'unknown', operationId: previous.operationId, reason: 'request-already-recorded', recordedRequest: true };
      }
      if (dispatched && marker && !backendSettled && backendCompletion && release) {
        backendController?.abort();
        let reason: 'backend-failed' | 'result-persistence-failed' = 'backend-failed';
        try { this.store.outcome(marker, 'unknown', null, null); } catch { reason = 'result-persistence-failed'; }
        deferRelease();
        return { outcome: 'unknown', operationId: marker.operationId, reason };
      }
      if (release) {
        try { await release(); release = undefined; }
        catch (cleanup) {
          release = undefined;
          if (dispatched && marker) return { outcome: 'unknown', operationId: marker.operationId, reason: 'lock-release-failed' };
          throw new GlobalDesktopPreDispatchRecoveryRequired(new AggregateError([error, cleanup], 'Desktop action was not dispatched; global lock release failed'), marker?.operationId);
        }
      }
      if (dispatched && marker) return { outcome: 'unknown', operationId: marker.operationId, reason: 'backend-failed' };
      // begin() rejected before inserting this request and its SQLite rollback
      // succeeded. A prior marker still blocks writes, but this request must not
      // stop the live run that is trying to acknowledge that earlier result.
      if (!marker && error instanceof GlobalDesktopWriteRejected) throw new PreDispatchFailure(error);
      // A lock-creation cleanup error means acquire() may have left
      // its own lock file behind. Ordinary EEXIST contention is not this case.
      if (persistenceAttempted || lookupAttempted || (acquiring && error instanceof DesktopTaskLockCleanupError)) {
        throw new GlobalDesktopPreDispatchRecoveryRequired(error, marker?.operationId);
      }
      throw new PreDispatchFailure(error);
    } finally {
      if (!handedOff) {
        if (release) {
          try { await release(); }
          catch (error) { this.backgroundFailure = error instanceof Error ? error : new Error(String(error)); }
        }
        this.active--;
      }
    }
  }

  /** Only the host may supply delivery evidence; a matching token alone is insufficient. */
  async acknowledge(raw: GlobalDesktopWriteContext, operationId: string, token: string, evidenceId: string): Promise<GlobalDesktopFinalizeOutcome> {
    this.assertOpen();
    const context = snapshot(raw);
    identity(operationId); identity(evidenceId);
    this.active++;
    try {
      const release = await this.lock.acquire(LOCK_KEY);
      let marker: GlobalWriteMarker | null = null, failure: unknown;
      const authorize = () => {
        this.assertContext(context);
        if (!marker || !matches(marker, context, operationId) || !GlobalDesktopWriteStore.tokenMatches(marker, token) ||
            this.authority.verifyDelivery(Object.freeze({ marker, evidenceId })) !== true) throw new Error('Desktop delivery evidence does not match');
      };
      try { marker = this.store.read(); authorize(); } catch (error) { failure = error; }
      try { await release(); } catch { return { outcome: 'unknown', reason: 'lock-release-failed' }; }
      if (failure || !marker) throw failure ?? new Error('Global desktop marker is missing');
      try { authorize(); } catch { return { outcome: 'unknown', reason: 'current-changed' }; }
      try { this.store.finish(marker, 'confirmed', globalWriteDigest(evidenceId), null, authorize); }
      catch { return { outcome: 'unknown', reason: 'barrier-finalization-failed' }; }
      return { outcome: 'confirmed' };
    } finally { this.active--; }
  }

  /** Explicit host recovery is never an instruction to dispatch again. */
  async recover(operationId: string, evidenceId: string, resolution: 'confirmed-applied' | 'confirmed-not-applied',
    isCurrent: () => boolean): Promise<GlobalDesktopFinalizeOutcome> {
    this.assertOpen(); identity(operationId); identity(evidenceId);
    if (!['confirmed-applied', 'confirmed-not-applied'].includes(resolution) || typeof isCurrent !== 'function') throw new Error('Invalid global desktop recovery');
    this.active++;
    try {
      const release = await this.lock.acquire(LOCK_KEY);
      let marker: GlobalWriteMarker | null = null, failure: unknown;
      const authorize = () => {
        this.assertOpen();
        if (!marker || marker.operationId !== operationId || isCurrent() !== true || this.authority.executorStopped(marker) !== true ||
            this.authority.verifyRecovery(Object.freeze({ marker, evidenceId, resolution })) !== true) {
          throw new Error('Independent desktop recovery evidence is required');
        }
      };
      try { marker = this.store.read(); authorize(); } catch (error) { failure = error; }
      try { await release(); } catch { return { outcome: 'unknown', reason: 'lock-release-failed' }; }
      if (failure || !marker) throw failure ?? new Error('Global desktop marker is missing');
      try { authorize(); } catch { return { outcome: 'unknown', reason: 'current-changed' }; }
      try { this.store.finish(marker, 'resolved', globalWriteDigest(evidenceId), resolution, authorize); }
      catch { return { outcome: 'unknown', reason: 'barrier-finalization-failed' }; }
      return { outcome: 'resolved' };
    } finally { this.active--; }
  }

  /**
   * The trusted host may record an explicit user decision to continue without
   * resolving the old effect. The opaque proof is never accepted on its own;
   * the host verifier must bind a real user event to this exact marker.
   */
  async acknowledgeUnknown(operationId: string, authorization: object,
    isCurrent: () => boolean): Promise<GlobalDesktopUnknownContinueOutcome> {
    this.assertOpen(); identity(operationId);
    if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization) || typeof isCurrent !== 'function') {
      throw new Error('A trusted user continuation proof is required');
    }
    if (!this.authority.verifyUnknownContinuation) throw new Error('Trusted user continuation verification is unavailable');
    if (this.pendingCleanup.size) throw new Error('The original desktop executor has not finished cleanup');
    this.active++;
    try {
      const release = await this.lock.acquire(LOCK_KEY);
      let marker: GlobalWriteMarker | null = null, eventId: string | undefined, failure: unknown;
      const authorize = () => {
        this.assertOpen();
        if (!marker || marker.operationId !== operationId || isCurrent() !== true || this.pendingCleanup.size ||
            this.authority.executorStopped(marker) !== true) throw new Error('The original desktop executor must be stopped');
        const verified = this.authority.verifyUnknownContinuation!(Object.freeze({ marker, authorization }));
        if (typeof verified !== 'string' || !verified.trim() || verified.length > 1024 ||
            (eventId !== undefined && eventId !== verified) || isCurrent() !== true) {
          throw new Error('A matching trusted user continuation event is required');
        }
        eventId = verified;
      };
      try { marker = this.store.read(); authorize(); } catch (error) { failure = error; }
      try { await release(); } catch { return { outcome: 'unknown', reason: 'lock-release-failed' }; }
      if (failure || !marker) throw failure ?? new Error('Global desktop marker is missing');
      try { authorize(); } catch { return { outcome: 'unknown', reason: 'current-changed' }; }
      try {
        const eventHash = globalWriteDigest(JSON.stringify(['global-desktop-unknown-continuation-v1', eventId]));
        this.store.finish(marker, 'acknowledged-unknown', eventHash, null, authorize);
      } catch { return { outcome: 'unknown', reason: 'barrier-finalization-failed' }; }
      return { outcome: 'acknowledged-unknown' };
    } finally { this.active--; }
  }

  /**
   * A stale file lock has no safe PID/age timeout. This only removes the lock;
   * any marker still needs a separate independently verified recovery.
   */
  async recoverAbandonedLock(evidenceId: string, fence: GlobalDesktopRecoveryFence): Promise<void> {
    this.assertOpen(); identity(evidenceId);
    if (!fence || typeof fence.isQuiescent !== 'function' || typeof fence.holdsExclusiveFence !== 'function' || this.active || this.pendingCleanup.size) {
      throw new Error('A quiescent exclusive host recovery fence is required');
    }
    this.active++;
    try {
      const assertFence = () => {
        this.assertOpen();
        if (fence.isQuiescent() !== true || fence.holdsExclusiveFence() !== true) throw new Error('Global desktop recovery fence was lost');
      };
      assertFence();
      const directory = path.join(this.root, 'global-write-locks');
      const directoryInfo = await fsp.lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Global desktop lock directory is invalid');
      const file = path.join(directory, `${globalWriteDigest(LOCK_KEY)}.lock`);
      const before = await fsp.lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 1024) throw new Error('Global desktop lock is invalid');
      const data = await fsp.readFile(file);
      let record: unknown;
      try { record = JSON.parse(data.toString('utf8')); } catch { /* a crash can leave a partial lock */ }
      const value = record as { version?: unknown; owner?: unknown; pid?: unknown; createdAt?: unknown };
      const lockRecordValid = !!value && value.version === 1 && typeof value.owner === 'string' && /^[0-9a-f-]{36}$/i.test(value.owner) &&
        Number.isSafeInteger(value.pid) && (value.pid as number) >= 1 && Number.isSafeInteger(value.createdAt) && (value.createdAt as number) >= 0;
      const marker = this.store.read(), lockHash = globalWriteDigest(data.toString('base64'));
      const authorize = () => {
        assertFence();
        if (this.authority.verifyAbandonedLock(Object.freeze({ lockHash, lockRecordValid, marker, evidenceId })) !== true) throw new Error('Independent abandoned-lock evidence is required');
      };
      authorize();
      const after = await fsp.lstat(file), again = await fsp.readFile(file);
      if (!after.isFile() || after.isSymbolicLink() || before.ino !== after.ino || before.size !== after.size || !data.equals(again)) {
        throw new Error('Global desktop lock changed during recovery');
      }
      authorize();
      await fsp.unlink(file);
      authorize();
    } finally { this.active--; }
  }

  /** Wait for timed-out backends to settle; this does not clear their marker. */
  async drain(): Promise<void> {
    await Promise.all([...this.pendingCleanup]);
    if (this.backgroundFailure) throw new Error('Global desktop lock cleanup failed', { cause: this.backgroundFailure });
  }

  close(): void {
    if (this.closed) return;
    if (this.active || this.pendingCleanup.size) throw new Error('Global desktop backend is still running');
    this.closed = true;
    this.store.close();
    if (this.backgroundFailure) throw new Error('Global desktop lock cleanup failed', { cause: this.backgroundFailure });
  }
}
