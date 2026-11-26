import type { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ExecutionLifecycle } from '../../../../shared/executionLifecycle';
import type { OwnedProcess, OwnedProcessState } from '../../process/owner';

export interface ProcessLimits {
  completionMs?: number;
  abortMs?: number;
  spawnProcess?: typeof spawn;
  /** Test seam: OS denial must leave the writer owned and expose retryable failure. */
  terminate?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}

/** Maps Codex result/EOF state; process and container ownership belong to OwnedProcess. */
export class CodexProcessSupervisor {
  readonly child: ChildProcessWithoutNullStreams;
  state: ExecutionLifecycle = { id: randomUUID(), revision: 0, at: Date.now(), result: 'pending', process: 'starting' };
  error?: Error;
  private deadline?: ReturnType<typeof setTimeout>;
  private released = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly owner: OwnedProcess<ChildProcessWithoutNullStreams>,
    private readonly publish: (state: ExecutionLifecycle) => void, private readonly limits: ProcessLimits = {}) {
    this.child = owner.child;
    this.update('starting');
    this.unsubscribe = owner.onState((state, error) => this.onOwnerState(state, error));
    void owner.exited.then(({ error }) => {
      if (error) this.error ??= error;
      this.state = { ...this.state, exitedAt: Date.now() };
      this.update(this.state.process, this.state.message);
      if (['reclaim_failed', 'reclaiming', 'stopping'].includes(this.state.process)) this.detachPipes();
      else this.armDrain();
    });
    this.child.on('error', error => { this.error ??= error; });
    this.child.stdin.on('error', error => {
      this.error ??= error;
      void this.owner.reclaim().catch(() => { /* owner publishes the failure and retains ownership */ });
    });
    this.state = { ...this.state, pid: this.child.pid };
  }

  private onOwnerState(state: OwnedProcessState, error?: Error): void {
    if (state === 'ready' && this.state.process === 'starting') this.update('running');
    else if (state === 'reclaiming') this.update('reclaiming', '正在停止并回收执行进程');
    else if (state === 'reclaim_failed') this.update('reclaim_failed', `回收失败：${error?.message ?? '未知错误'}。原会话仍被占用，请重试停止。`);
    // A released OS container is necessary but not sufficient: the Codex
    // iterator and thread writer are released only after the stream drains.
  }

  private update(process: ExecutionLifecycle['process'], message?: string): void {
    if (this.released) return;
    this.state = { ...this.state, process, message, revision: this.state.revision + 1, at: Date.now() };
    this.publish(this.state);
  }

  markResult(result: ExecutionLifecycle['result']): void {
    if (this.state.result !== 'pending') return;
    this.state = { ...this.state, result, terminalAt: Date.now() };
    if (this.state.process === 'running') this.update('draining');
    else this.update(this.state.process, this.state.message);
    this.armDrain();
  }

  private armDrain(): void {
    if (this.deadline || this.released || ['stopping', 'reclaiming', 'reclaim_failed'].includes(this.state.process)) return;
    this.deadline = setTimeout(() => { void this.owner.reclaim().catch(() => {}); }, this.limits.completionMs ?? 10000);
  }

  stop(): Promise<void> {
    if (this.released) return Promise.resolve();
    this.state = { ...this.state, stopRequestedAt: Date.now() };
    if (this.state.result === 'pending') this.state = { ...this.state, result: 'aborted' };
    this.update('stopping');
    clearTimeout(this.deadline);
    return this.owner.reclaim();
  }

  private detachPipes(): void {
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }

  /** Reader cleanup waits for real reclamation, including a later explicit retry. */
  async release(): Promise<void> {
    if (this.owner.state !== 'reclaim_failed') {
      try { await this.owner.reclaim(); }
      catch { /* Keep the writer until a successful owner operation is confirmed. */ }
    }
    await this.owner.reclaimed;
    clearTimeout(this.deadline);
    this.detachPipes();
    this.update('released');
    this.released = true;
    this.unsubscribe();
  }
}
