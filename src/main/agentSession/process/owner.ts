import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { boundedAcpRequest } from '../processReclamation';
import { assertWindowsJobProtocol, WindowsJob } from './windowsJob';
import { registerOwnedProcess, unregisterOwnedProcess } from '../../processMonitor';

export type OwnedProcessState = 'starting' | 'ready' | 'start_failed' | 'exited' | 'reclaiming' | 'reclaim_failed' | 'released';
export type OwnedProcessCoverage = 'windows-job' | 'windows-taskkill' | 'posix-process-group';
export type WindowsProcessPolicy = { kind: 'job'; jobPath: string } | { kind: 'taskkill' };
export type OwnedProcessExit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
export type OwnedProcessObserver = (state: OwnedProcessState, error?: Error) => void;

export interface OwnedProcess<T extends ChildProcess = ChildProcess> {
  readonly child: T;
  /** Platform ownership is established and reclamation has not begun. */
  readonly ready: Promise<void>;
  readonly exited: Promise<OwnedProcessExit>;
  /** Resolves only when the process and its owned container are confirmed gone. */
  readonly reclaimed: Promise<void>;
  readonly state: OwnedProcessState;
  /** taskkill is best-effort process-tree discovery, not Windows Job ownership. */
  readonly coverage: OwnedProcessCoverage;
  reclaim(): Promise<void>;
  onState(observer: OwnedProcessObserver): () => void;
}

export interface OwnedProcessOptions<T extends ChildProcess = ChildProcess> {
  command: string;
  args: string[];
  spawnOptions: SpawnOptions;
  /** Explicit policy; a failed Job must never silently fall back to taskkill. */
  windows: WindowsProcessPolicy;
  /** Private bootstrap challenge; required for a Windows Job, never third-party adapter code. */
  identityChallenge?: (child: T, nonce: string, signal: AbortSignal) => Promise<string>;
  reclaimTimeoutMs?: number;
  /** Protocol-specific graceful stop or injected failure; the owner then reclaims the tree. */
  beforeReclaim?: (child: T) => void | Promise<void>;
  /** Optional business identity shown by the in-app process monitor. */
  monitor?: {
    businessLabel?: string;
    role?: string;
    workspaceId?: string;
    workspaceName?: string;
    sessionId?: string;
    sessionName?: string;
    taskId?: string;
    taskLabel?: string;
  };
  spawnProcess?: typeof spawn;
}

/**
 * Own one controlled worker and its platform resource container. The caller
 * must not activate the SDK until ready and must recheck state after any await.
 * This owner does not interpret the worker protocol or close its streams.
 */
export function spawnOwnedProcess<T extends ChildProcess = ChildProcess>(options: OwnedProcessOptions<T>): OwnedProcess<T> {
  if (process.platform === 'win32' && options.windows.kind === 'job' && !options.windows.jobPath) throw new Error('缺少 Windows 进程守护脚本');
  if (process.platform === 'win32' && options.windows.kind === 'job' && !options.identityChallenge) throw new Error('缺少 Windows 受控工作进程身份校验');
  if (process.platform === 'win32' && options.windows.kind === 'job') assertWindowsJobProtocol(options.windows.jobPath);
  const coverage: OwnedProcessCoverage = process.platform !== 'win32' ? 'posix-process-group'
    : options.windows.kind === 'job' ? 'windows-job' : 'windows-taskkill';
  const timeoutMs = options.reclaimTimeoutMs ?? 7000;
  const child = (options.spawnProcess ?? spawn)(options.command, options.args, {
    ...options.spawnOptions, windowsHide: true, detached: process.platform !== 'win32'
  }) as T;
  let state: OwnedProcessState = 'starting';
  let retiring = false;
  let assignmentError: Error | undefined;
  let job: WindowsJob | undefined;
  let jobAssigned = false;
  let identityAbort: AbortController | undefined;
  let operation: Promise<void> | undefined;
  let waiting: Promise<void> | undefined;
  let resolveReclaimed!: () => void;
  const reclaimed = new Promise<void>(resolve => { resolveReclaimed = resolve; });
  const observers = new Set<OwnedProcessObserver>();
  const setState = (next: OwnedProcessState, error?: Error): void => {
    state = next;
    for (const observer of observers) {
      try { observer(next, error); }
      catch { console.warn('[agentSession] process owner observer failed'); }
    }
  };
  const exited = new Promise<OwnedProcessExit>(resolve => {
    child.once('exit', (code, signal) => {
      if (child.pid) unregisterOwnedProcess(child.pid);
      if (state === 'starting' || state === 'ready') setState('exited');
      resolve({ code, signal });
    });
    child.once('error', error => {
      if (!child.pid) {
        if (state === 'starting' || state === 'ready') setState('start_failed', error);
        resolve({ code: null, signal: null, error });
      }
    });
  });
  const spawned = new Promise<void>((resolve, reject) => {
    const register = (): void => {
      if (child.pid) registerOwnedProcess(child.pid, {
        name: options.command.split(/[\\/]/).pop() || options.command,
        type: 'External',
        ...(options.monitor?.businessLabel ? { businessLabel: options.monitor.businessLabel } : {}),
        serviceName: '受管工作进程',
        ...(options.monitor?.role ? { role: options.monitor.role } : {}),
        ...(options.monitor?.workspaceId ? { workspaceId: options.monitor.workspaceId } : {}),
        ...(options.monitor?.workspaceName ? { workspaceName: options.monitor.workspaceName } : {}),
        ...(options.monitor?.sessionId ? { sessionId: options.monitor.sessionId } : {}),
        ...(options.monitor?.sessionName ? { sessionName: options.monitor.sessionName } : {}),
        ...(options.monitor?.taskId ? { taskId: options.monitor.taskId } : {}),
        ...(options.monitor?.taskLabel ? { taskLabel: options.monitor.taskLabel } : {}),
        startedAt: Date.now()
      });
    };
    if (child.pid) { register(); resolve(); return; }
    const onSpawn = (): void => { child.removeListener('error', onError); register(); resolve(); };
    const onError = (error: Error): void => { child.removeListener('spawn', onSpawn); reject(error); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  const assignment = (async (): Promise<void> => {
    await spawned;
    if (process.platform !== 'win32' || options.windows.kind !== 'job') return;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('工作进程在 Windows Job 赋值前退出，无法确认其后代状态');
    }
    job = new WindowsJob(options.windows.jobPath, child.pid);
    await job.opened;
    if (retiring || state !== 'starting') throw new Error('进程已退出或开始回收，不能校验身份');
    const controller = new AbortController();
    identityAbort = controller;
    try {
      const nonce = randomBytes(32).toString('base64url');
      const challenge = Promise.resolve().then(() => options.identityChallenge!(child, nonce, controller.signal));
      // ready is rejected if the guardian fails while the child challenge is pending.
      const guardianFailure = job.ready.then(() => { throw new Error('Windows Job 在身份校验前已赋值'); });
      const response = await boundedAcpRequest(Promise.race([challenge, guardianFailure]), 10_000, '工作进程身份校验', controller.signal);
      if (response !== nonce) throw new Error('工作进程身份校验失败');
      if (retiring || state !== 'starting') throw new Error('进程已退出或开始回收，不能赋值 Job');
      await job.assign();
      jobAssigned = true;
    } finally {
      controller.abort();
      if (identityAbort === controller) identityAbort = undefined;
    }
  })();
  const ready = assignment.then(() => {
    if (retiring || state !== 'starting') throw new Error('进程已退出或开始回收，不能启动引擎');
    setState('ready');
  }, error => {
    assignmentError = error instanceof Error ? error : new Error(String(error));
    if (!retiring && state !== 'exited') setState('start_failed', assignmentError);
    throw assignmentError;
  });
  // A caller can start reclaiming before it awaits startup.
  void ready.catch(() => {});

  const performReclaim = async (): Promise<void> => {
    await options.beforeReclaim?.(child);
    try { await spawned; }
    catch (error) {
      if (!child.pid) { await exited; return; }
      throw error;
    }
    if (process.platform === 'win32') {
      if (options.windows.kind === 'taskkill') {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
          throw new Error('工作进程已先退出，无法确认 Windows 子进程树已回收');
        }
        await new Promise<void>((resolve, reject) => {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 3000 }, error => {
            if (!error) { resolve(); return; }
            try { child.kill(); } catch { /* return the original failure */ }
            reject(new Error(`无法确认 Windows 子进程树已退出：${error.message}`));
          });
        });
        await exited;
        return;
      }
      try { await assignment; }
      catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error));
        if (job) {
          // Ending stdin is a request, not proof that assignment stopped. Wait
          // for the guardian before considering any action against this PID.
          job.abandon();
          await job.waitForExit();
        }
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        throw new Error(`无法确认 Windows 进程组的归属与回收：${reason.message}`);
      }
      if (!job || !jobAssigned) throw assignmentError ?? new Error('无法确认 Windows Job 归属');
      await job.reclaim();
      await exited;
      return;
    }
    if (child.pid) {
      // A vanished process group ID can be reused. Once the root's exit is
      // known, never signal the old numeric group as if ownership were proven.
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('工作进程已先退出，无法安全确认或回收原进程组');
      }
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new Error('无法确认工作进程组全部退出：' + (error as Error).message, { cause: error });
        }
      }
      await boundedAcpRequest(exited, timeoutMs, '工作进程退出');
      const deadline = Date.now() + timeoutMs;
      while (true) {
        try { process.kill(-child.pid, 0); }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') break;
          // kill(0) can report a still-present group as EPERM while its killed
          // children are being reaped. Only ESRCH confirms the group is gone.
          if (code !== 'EPERM') throw error;
        }
        if (Date.now() >= deadline) throw new Error('无法确认工作进程组全部退出');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } else await exited;
  };
  const reclaim = (): Promise<void> => {
    if (state === 'released') return Promise.resolve();
    if (waiting) return waiting;
    retiring = true;
    identityAbort?.abort();
    setState('reclaiming');
    if (!operation) {
      const attempt = performReclaim();
      operation = attempt;
      void attempt.then(() => {
        if (operation !== attempt) return;
        setState('released');
        resolveReclaimed();
      }, error => {
        if (operation !== attempt) return;
        operation = undefined;
        setState('reclaim_failed', error instanceof Error ? error : new Error(String(error)));
      });
    }
    const current = operation;
    const attempt = boundedAcpRequest(current, timeoutMs, '进程回收').catch(error => {
      if (state !== 'released') setState('reclaim_failed', error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    waiting = attempt;
    void attempt.then(
      () => { if (waiting === attempt) waiting = undefined; },
      () => { if (waiting === attempt) waiting = undefined; }
    );
    return attempt;
  };
  return {
    child, ready, exited, reclaimed, reclaim, coverage,
    get state() { return state; },
    onState(observer) { observers.add(observer); return () => observers.delete(observer); }
  };
}
