import { currentToolInvocation } from './toolInvocation';
import { userDataStorage } from './storageRootResolver';
import { createHash, randomUUID } from 'node:crypto';
import type { EventEnvelope } from './contracts';
import { SessionEventLog } from './sessionEventLog';
import type { SessionLogFactory, SessionLogHandle } from './sessionManager';

type Phase = 'dispatching' | 'committed' | 'retryable' | 'unknown';
type Operation = { operationId: string; kind: string; phase: Phase; causes: string[]; result?: unknown; at: number };
export class SemanticOutcomeUnknownError extends Error {
  readonly deliveryUncertain = true;
  constructor(readonly operationId: string) {
    super(`投递 ${operationId} 的结果未知，未自动重发。请检查原生会话历史和邮箱回执后处理。`);
    this.name = 'SemanticOutcomeUnknownError';
  }
}

/** Durable admission facts, separate from transcript projections and UI events. */
export class SemanticOperations {
  private readonly log: SessionLogHandle;
  private readonly states = new Map<string, Operation>();
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly lanes = new Map<string, Promise<unknown>>();
  constructor(readonly targetSessionId: string, root: string, factory?: SessionLogFactory) {
    const id = `semantic-${createHash('sha256').update(targetSessionId).digest('hex')}`;
    this.log = factory?.openSync('plugin', id) ?? new SessionEventLog(userDataStorage(root).resolve('app', 'sessions'), id);
    this.log.loadSync();
    for (let fromSeq = 1;;) {
      const batch = this.log.readRangeSync({ fromSeq, limit: 512 });
      if (!batch.length) break;
      for (const event of batch) {
        if (event.type.startsWith('semantic.')) {
          const operation = event.payload as Operation;
          this.states.set(this.key(operation.kind, operation.operationId), operation);
        }
      }
      fromSeq = batch[batch.length - 1].seq + 1;
    }
  }
  private key(kind: string, id: string): string { return `${kind}\0${id}`; }

  /** Serialize one recipient's batch planning as well as its actual admission. */
  serial<T>(lane: string, action: () => Promise<T>): Promise<T> {
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.lanes.set(lane, next);
    void next.finally(() => { if (this.lanes.get(lane) === next) this.lanes.delete(lane); }).catch(() => {});
    return next;
  }

  run<T>(kind: string, operationId: string, causes: readonly string[], effect: () => Promise<T>,
    accepted: (result: T) => boolean): Promise<T> {
    const key = this.key(kind, operationId);
    const active = this.running.get(key);
    if (active) return active as Promise<T>;
    const previous = this.states.get(key);
    if (previous?.phase === 'committed') return Promise.resolve(structuredClone(previous.result) as T);
    if (previous?.phase === 'dispatching' || previous?.phase === 'unknown') return Promise.reject(new SemanticOutcomeUnknownError(operationId));
    const task = this.dispatch(kind, operationId, [...causes], effect, accepted);
    this.running.set(key, task);
    void task.finally(() => { if (this.running.get(key) === task) this.running.delete(key); }).catch(() => {});
    return task;
  }

  private async dispatch<T>(kind: string, operationId: string, causes: string[], effect: () => Promise<T>, accepted: (result: T) => boolean): Promise<T> {
    try { await this.record({ kind, operationId, causes, phase: 'dispatching', at: Date.now() }); }
    catch (error) {
      // No external call has happened. This process may safely retry after the
      // storage failure is repaired; never dispatch without durable admission.
      this.states.set(this.key(kind, operationId), { kind, operationId, causes, phase: 'retryable', at: Date.now() });
      throw error;
    }
    let result: T;
    try { result = await effect(); }
    catch (error) {
      const unknown = (error as { deliveryUncertain?: boolean })?.deliveryUncertain === true;
      try { await this.record({ kind, operationId, causes, phase: unknown ? 'unknown' : 'retryable', at: Date.now() }); }
      catch (recordError) { if (!unknown) throw recordError; }
      if (unknown) throw Object.assign(new SemanticOutcomeUnknownError(operationId), { cause: error });
      throw error;
    }
    const committed = accepted(result);
    try {
      await this.record({ kind, operationId, causes, phase: committed ? 'committed' : 'retryable',
        result: structuredClone(result), at: Date.now() });
    } catch (error) {
      if (!committed) {
        this.states.set(this.key(kind, operationId), { kind, operationId, causes, phase: 'retryable', at: Date.now() });
        throw error;
      }
      // The effect may already have succeeded; a failed commit is never a
      // license to send it again, even if the mailbox receipt still says pending.
      this.states.set(this.key(kind, operationId), { kind, operationId, causes, phase: 'unknown', at: Date.now() });
      throw new SemanticOutcomeUnknownError(operationId);
    }
    return result;
  }

  acceptedCauses(kind: string): Map<string, { at: number; result: unknown }> {
    const accepted = new Map<string, { at: number; result: unknown }>();
    for (const state of this.states.values()) if (state.kind === kind && state.phase === 'committed')
      for (const cause of state.causes) accepted.set(cause, { at: state.at, result: state.result });
    return accepted;
  }
  uncertainCauses(kind: string): Set<string> {
    const causes = new Set<string>();
    for (const state of this.states.values()) if (state.kind === kind && ['dispatching', 'unknown'].includes(state.phase))
      for (const cause of state.causes) causes.add(cause);
    return causes;
  }

  /** Facts describe real committed business outcomes, not renderer state. */
  fact(kind: string, operationId: string, causes: readonly string[], result: unknown): Promise<void> {
    const key = this.key(kind, operationId);
    const active = this.running.get(key);
    if (active) return active as Promise<void>;
    if (this.states.get(key)?.phase === 'committed') return Promise.resolve();
    const factId = `fact-${createHash('sha256').update(key).digest('hex')}`;
    const task = this.record({ kind, operationId, causes: [...causes], phase: 'committed', result: structuredClone(result), at: Date.now() }, factId)
      .catch(error => { this.states.delete(key); throw error; });
    this.running.set(key, task);
    void task.finally(() => { if (this.running.get(key) === task) this.running.delete(key); }).catch(() => {});
    return task;
  }

  private async record(operation: Operation, eventId: string = randomUUID()): Promise<void> {
    const invocation = currentToolInvocation();
    const event: EventEnvelope<Operation & { targetSessionId: string; invocation?: typeof invocation }> = {
      eventId, sessionId: this.log.sessionId, seq: 0,
      type: `semantic.${operation.kind}.${operation.phase}`, schemaVersion: 1,
      createdAt: operation.at, causationId: invocation?.toolCallId ?? operation.causes[0] ?? operation.operationId,
      correlationId: invocation ? `${invocation.sessionId}:${invocation.turnId ?? invocation.toolCallId}` : operation.operationId,
      payload: { ...operation, targetSessionId: this.targetSessionId, ...(invocation ? { invocation } : {}) }
    };
    this.log.appendSync(event);
    this.states.set(this.key(operation.kind, operation.operationId), operation);
    await this.log.flush('semantic-operation');
  }
}

const owners = new WeakMap<object, Map<string, SemanticOperations>>();
export function semanticOperationsFor(owner: object, target: string, root: string, factory?: SessionLogFactory): SemanticOperations {
  let sessions = owners.get(owner);
  if (!sessions) { sessions = new Map(); owners.set(owner, sessions); }
  let journal = sessions.get(target);
  if (!journal) { journal = new SemanticOperations(target, root, factory); sessions.set(target, journal); }
  return journal;
}
