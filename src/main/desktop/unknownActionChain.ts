import { MAX_DESKTOP_GRANT_TTL_MS } from './grants';

/** Host-owned boundary for actions whose effect cannot be classified reliably.
 * This is staging logic: native input must not be exposed until the host wires
 * takeover, task lifecycle, evidence capture, confirmation and audit to it. */
export interface UnknownActionBoundary {
  taskId: string;
  appId: string;
  processInstance: string;
  surfaceId: string;
  surfaceGeneration: string;
  captureId: string;
  geometryRevision: string;
  region: { x: number; y: number; width: number; height: number };
  actionClass: string;
  /** SHA-256 of the captured, user-visible evidence presented in the confirmation. */
  evidenceSha256: string;
}

type RefusalJournal = Pick<import('./dispatchJournal').DesktopDispatchJournal, 'hasRefusal' | 'recordRefusal' | 'clearRefusal'>;

export class UnknownActionChains {
  private readonly current = new Map<string, { appId: string; actionClass: string; evidenceScope: string; token: number; expiresAt: number }>();
  private serial = 0;
  private readonly generation = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly refused = new Set<string>();

  constructor(private readonly journal: RefusalJournal, private readonly now: () => number = () => performance.now()) {
    if (!journal || typeof journal.hasRefusal !== 'function' || typeof journal.recordRefusal !== 'function' ||
      typeof journal.clearRefusal !== 'function') throw new Error('Invalid desktop refusal journal');
  }

  private enqueue<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(taskId) ?? Promise.resolve();
    const operation = prior.then(run);
    const tail = operation.then(() => undefined, () => undefined);
    this.tails.set(taskId, tail);
    void tail.then(() => { if (this.tails.get(taskId) === tail) this.tails.delete(taskId); });
    return operation;
  }

  /** Host calls this when the user takes over or the task ends. */
  invalidate(taskId: string): void {
    if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('Invalid task');
    this.current.delete(taskId);
    this.generation.set(taskId, (this.generation.get(taskId) ?? 0) + 1);
  }

  /** Recheck immediately before every dispatch; a prior confirmation is not a capability by itself. */
  isAuthorized(taskId: string, appId: string, actionClass: string, generation: number): boolean {
    const current = this.current.get(taskId);
    return current?.token === generation && current.appId === appId && current.actionClass === actionClass && current.expiresAt > this.now();
  }

  /** Only after an explicit human request to reconsider, not after an automatic retry. */
  clearRefusalAfterUserRequest(taskId: string, appId: string, actionClass: string, audit: () => Promise<void>): Promise<void> {
    if (![taskId, appId, actionClass].every(v => typeof v === 'string' && !!v.trim()) || typeof audit !== 'function') return Promise.reject(new Error('Invalid refusal scope'));
    const scope = JSON.stringify(['unknown-chain', taskId, appId, actionClass]);
    return this.enqueue(taskId, async () => {
      const persisted = await this.journal.hasRefusal(taskId, scope);
      if (!persisted && !this.refused.has(scope)) throw new Error('No matching desktop chain refusal');
      await audit();
      if (persisted) await this.journal.clearRefusal(taskId, scope);
      this.refused.delete(scope);
    });
  }

  /** The host supplies classification and evidence; neither is accepted as model authority. */
  authorize(request: UnknownActionBoundary, confirm: (request: Readonly<UnknownActionBoundary>) => Promise<boolean>,
    audit: (request: Readonly<UnknownActionBoundary>, decision: 'allowed' | 'denied') => Promise<void>, turnGranted: () => boolean = () => false): Promise<number> {
    if (!request || [request.taskId, request.appId, request.processInstance, request.surfaceId, request.surfaceGeneration,
      request.captureId, request.geometryRevision, request.actionClass].some(v => typeof v !== 'string' || !v.trim()) ||
      !request.region || ![request.region.x, request.region.y, request.region.width, request.region.height].every(Number.isSafeInteger) ||
      request.region.x < 0 || request.region.y < 0 || request.region.width < 1 || request.region.height < 1 ||
      !Number.isSafeInteger(request.region.x + request.region.width) || !Number.isSafeInteger(request.region.y + request.region.height) ||
      typeof request.evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(request.evidenceSha256) ||
      typeof confirm !== 'function' || typeof audit !== 'function') return Promise.reject(new Error('Invalid unknown action boundary'));
    const snapshot = Object.freeze({ ...request, region: Object.freeze({ ...request.region }) });
    const evidenceScope = JSON.stringify([snapshot.processInstance, snapshot.surfaceId, snapshot.surfaceGeneration,
      snapshot.geometryRevision, snapshot.region.x, snapshot.region.y, snapshot.region.width, snapshot.region.height]);
    const startGeneration = this.generation.get(snapshot.taskId) ?? 0;
    return this.enqueue(snapshot.taskId, async () => {
      const assertCurrent = (): void => {
        if ((this.generation.get(snapshot.taskId) ?? 0) !== startGeneration) throw new Error('Desktop action chain invalidated');
      };
      assertCurrent();
      const scope = JSON.stringify(['unknown-chain', snapshot.taskId, snapshot.appId, snapshot.actionClass]);
      if (!turnGranted() && (this.refused.has(scope) || await this.journal.hasRefusal(snapshot.taskId, scope))) throw new Error('Desktop action chain previously declined');
      assertCurrent();
      const current = this.current.get(snapshot.taskId);
      if (current?.appId === snapshot.appId && current.actionClass === snapshot.actionClass &&
          current.evidenceScope === evidenceScope && current.expiresAt > this.now()) return current.token;
      // A switch or upgrade destroys the previous approval before prompting.
      this.current.delete(snapshot.taskId);
      const approved = turnGranted() || await confirm(snapshot) === true;
      if (!approved) {
        this.refused.add(scope);
        await this.journal.recordRefusal(snapshot.taskId, scope);
      }
      assertCurrent();
      await audit(snapshot, approved ? 'allowed' : 'denied');
      assertCurrent();
      if (!approved) throw new Error('Desktop action chain declined');
      const token = ++this.serial;
      this.current.set(snapshot.taskId, { appId: snapshot.appId, actionClass: snapshot.actionClass, evidenceScope,
        token, expiresAt: this.now() + MAX_DESKTOP_GRANT_TTL_MS });
      return token;
    });
  }
}
