import { randomUUID } from 'node:crypto';
import { CliError, CLI_TERMINAL_STATES } from '../../shared/cli';
import { CliRunStore, type CliRun, type CliWorker } from './runtime';
import { requireSessionIsolation } from '../../shared/sessionIsolation';

export interface CliRunDeps {
  workspaces: () => Array<{ id: string; name: string }>;
  /** Admission callback must run before starting the model; false keeps the request pending. */
  dispatch: (run: Pick<CliRun, 'runId' | 'workspaceId' | 'taskPath'>, inputPath: string, admit: () => boolean) => Promise<boolean>;
  delegate: (run: CliRun, taskId: string, input: Record<string, unknown>, onQueued: (queueId: string) => void) => Promise<CliWorker>;
  cancelQueued: (queueId: string) => boolean;
  interrupt: (run: CliRun, worker: CliWorker) => Promise<unknown>;
  workerLogs: (run: CliRun, worker: CliWorker) => Promise<string>;
  open: (run: CliRun) => Promise<void>;
}
export class CliRunService {
  private dispatching = new Set<string>();
  private stopping = new Map<string, Promise<unknown>>();
  private lastTails = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private readonly acceptedDispatches = new Set<Promise<void>>();
  constructor(readonly store: CliRunStore, readonly deps: CliRunDeps) {}
  start() { this.timer = setInterval(() => void this.pump().catch(error => console.error('[cli] dispatch failed', error)), 1000); this.timer.unref(); }
  stop() { this.closed = true; if (this.timer) clearInterval(this.timer); }
  async stopAndWait(): Promise<void> {
    this.stop();
    while (this.acceptedDispatches.size) await Promise.allSettled([...this.acceptedDispatches]);
    await Promise.allSettled([...this.stopping.values()]);
  }
  workspace(id: string) { if (!this.deps.workspaces().some(workspace => workspace.id === id)) throw new CliError('workspace_not_found', `Workspace is not open: ${id}`); }
  submit(workspace: string, text: string, key?: string) { this.workspace(workspace); const run = this.store.submit(workspace, text, key); void this.pump().catch(error => console.error('[cli] dispatch failed', error)); return run; }
  async pump() {
    if (this.closed) return;
    for (const run of this.store.pending()) {
      if (this.dispatching.has(run.workspaceId)) continue;
      this.dispatching.add(run.workspaceId);
      const input = run.input;
      const dispatch = (async () => {
        try {
          this.workspace(run.workspaceId);
          await this.deps.dispatch(run, input.path, () => {
            if (this.closed) return false;
            const current = this.store.get(run.runId);
            if (CLI_TERMINAL_STATES.includes(current.state) || current.pending[0]?.id !== input.id) return false;
            this.store.change(run.runId, draft => { draft.pending.shift(); draft.state = draft.question ? 'waiting' : 'running'; }, 'scheduler', 'Instructions admitted to scheduler');
            return true;
          });
        } catch (error) {
          const current = this.store.get(run.runId);
          if (!CLI_TERMINAL_STATES.includes(current.state)) this.store.fail(run.runId, error instanceof Error ? error.message : String(error));
        } finally { this.dispatching.delete(run.workspaceId); }
      })();
      this.acceptedDispatches.add(dispatch);
      void dispatch.then(() => this.acceptedDispatches.delete(dispatch), () => this.acceptedDispatches.delete(dispatch));
    }
  }
  async delegate(id: string, input: Record<string, unknown>) {
    requireSessionIsolation(input);
    const run = this.store.active(id);
    if (run.state === 'waiting' || run.pending.length) throw new CliError('run_not_ready', 'Resolve questions and consume pending instructions before delegating');
    // Stable per-run worker link; the random suffix survives the compact run prefix.
    const taskId = `cli-${id.slice(0, 8)}-${randomUUID()}`;
    this.store.change(id, draft => { draft.workers.push({ taskId, ...(typeof input.runtime === 'string' ? { runtime: input.runtime } : {}) }); }, 'scheduler', `Delegation reserved: ${taskId}`);
    try {
      const worker = await this.deps.delegate(run, taskId, structuredClone(input), queueId => {
        this.store.change(id, draft => { draft.workers.find(item => item.taskId === taskId)!.queueId = queueId; }, 'host', `Worker queued: ${queueId}`);
        if (CLI_TERMINAL_STATES.includes(this.store.get(id).state)) this.deps.cancelQueued(queueId);
      });
      if (this.store.all().some(other => other.runId !== id && worker.sessionId && other.workers.some(item => item.sessionId === worker.sessionId))) throw new CliError('ownership_conflict', 'Worker belongs to another CLI run');
      this.store.change(id, draft => { Object.assign(draft.workers.find(item => item.taskId === taskId)!, worker, { taskId }); }, 'host', `Worker linked: ${worker.sessionId ?? worker.queueId ?? taskId}`);
      if (CLI_TERMINAL_STATES.includes(this.store.get(id).state)) await this.interrupt(this.store.get(id), { ...worker, taskId });
      return worker;
    } catch (error) {
      const orphan = (error as { sessionId?: string })?.sessionId;
      if (orphan) {
        const worker: CliWorker = { taskId, sessionId: orphan, creationFailed: true };
        this.store.change(id, draft => Object.assign(draft.workers.find(item => item.taskId === taskId)!, worker), 'host', `Failed delegation left worker ${orphan}`);
        if (!CLI_TERMINAL_STATES.includes(this.store.get(id).state)) this.store.fail(id, 'Worker creation failed after a session was created; execution was not retried');
        try { await this.interrupt(this.store.get(id), worker); }
        catch (cleanupError) { this.store.change(id, () => {}, 'host', `Failed worker cleanup: ${String(cleanupError)}`); }
      } else {
        this.store.change(id, draft => { draft.workers = draft.workers.filter(item => item.taskId !== taskId || item.sessionId); }, 'host', `Delegation failed; empty reservation removed, linked resources retained: ${taskId}`);
      }
      this.store.change(id, () => {}, 'host', `Delegation failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
  private interrupt(run: CliRun, worker: CliWorker) {
    if (!worker.sessionId) return Promise.resolve();
    const key = `${run.runId}:${worker.sessionId}`;
    const previous = this.stopping.get(key); if (previous) return previous;
    const pending = this.deps.interrupt(run, worker).finally(() => this.stopping.delete(key)); this.stopping.set(key, pending); return pending;
  }
  async cancel(id: string) {
    const previous = this.store.get(id);
    // Failed/interrupted runs can still own live workers. Allow explicit cleanup
    // without rewriting their original outcome or touching delivered work.
    if (previous.state === 'delivered') return { ...this.store.view(id), cancellationErrors: [] };
    this.store.cancel(id);
    const errors: string[] = [];
    for (const worker of this.store.get(id).workers) {
      try { if (worker.queueId) this.deps.cancelQueued(worker.queueId); await this.interrupt(this.store.get(id), worker); }
      catch (error) { errors.push(`${worker.sessionId ?? worker.queueId ?? worker.taskId}: ${String(error)}`); }
    }
    if (errors.length) this.store.change(id, () => {}, 'host', `Cancellation incomplete: ${errors.join('; ')}`);
    return { ...this.store.view(id), cancellationErrors: errors };
  }
  async logs(id: string, after: number, limit: number) {
    const run = this.store.get(id);
    for (const worker of run.workers.filter(item => item.sessionId)) {
      try {
        const tail = await this.deps.workerLogs(run, worker), key = `${id}:${worker.sessionId}`;
        if (tail && this.lastTails.get(key) !== tail) { this.store.change(id, () => {}, `worker:${worker.sessionId}`, tail); this.lastTails.set(key, tail); }
      } catch (error) { const text = `Transcript unavailable: ${String(error)}`, key = `${id}:${worker.sessionId}`; if (this.lastTails.get(key) !== text) { this.store.change(id, () => {}, `worker:${worker.sessionId}`, text); this.lastTails.set(key, text); } }
    }
    return this.store.logs(id, after, limit);
  }
}
