import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';

type Pending = { resolve: () => void; reject: (error: Error) => void };
type Phase = 'opening' | 'opened' | 'assigning' | 'ready' | 'reclaiming' | 'released' | 'failed';
const PROTOCOL_MARKER = '# MUSTER_WINDOWS_JOB_PROTOCOL=opened-challenge-v1';

/** Reject a stale packaged guardian before PowerShell can execute it. */
export function assertWindowsJobProtocol(script: string): void {
  try {
    if (fs.statSync(script).size > 128 * 1024) throw new Error('文件超出大小限制');
    const firstLine = fs.readFileSync(script, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0];
    if (firstLine !== PROTOCOL_MARKER) throw new Error('协议版本不匹配');
  } catch (error) {
    throw new Error(`Windows 进程守护文件不可用或版本不匹配，请重新构建或安装工作台：${(error as Error).message}`);
  }
}

/**
 * The guardian first opens a process handle without assigning it to a Job.
 * The owner must prove that handle's PID is still its original child before
 * calling assign(); closing stdin before assign never acts on that handle.
 */
export class WindowsJob {
  readonly opened: Promise<void>;
  readonly ready: Promise<void>;
  private openedPending!: Pending;
  private readyPending!: Pending;
  private reclaimPending?: Pending;
  private phase: Phase = 'opening';
  private failure?: Error;
  private reclaiming?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly guardian;
  private readonly exited: Promise<void>;

  constructor(script: string, pid: number) {
    assertWindowsJobProtocol(script);
    this.guardian = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-WorkerPid', String(pid)], { windowsHide: true, stdio: 'pipe' });
    this.exited = new Promise(resolve => {
      this.guardian.once('exit', () => resolve());
      // A failed spawn has no exit event and no guardian process to wait for.
      this.guardian.once('error', () => { if (!this.guardian.pid) resolve(); });
    });
    this.opened = new Promise((resolve, reject) => { this.openedPending = { resolve, reject }; });
    this.ready = new Promise((resolve, reject) => { this.readyPending = { resolve, reject }; });
    void this.opened.catch(() => {});
    void this.ready.catch(() => {});
    this.timer = setTimeout(() => this.fail(new Error('Windows Job handle open timed out')), 10_000);
    let stderr = '';
    this.guardian.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-2000); });
    const lines = createInterface({ input: this.guardian.stdout });
    lines.on('line', line => {
      let message: { type?: unknown; message?: unknown };
      try { message = JSON.parse(line) as { type?: unknown; message?: unknown }; }
      catch { this.fail(new Error('Invalid Windows Job response')); return; }
      if (message.type === 'opened' && this.phase === 'opening') {
        this.clearTimer(); this.phase = 'opened'; this.openedPending.resolve(); return;
      }
      if (message.type === 'ready' && this.phase === 'assigning') {
        this.clearTimer(); this.phase = 'ready'; this.readyPending.resolve(); return;
      }
      if (message.type === 'released' && this.phase === 'reclaiming') {
        this.phase = 'released'; this.reclaimPending?.resolve(); this.reclaimPending = undefined; return;
      }
      if (message.type === 'failure') {
        const error = new Error(typeof message.message === 'string' ? message.message : 'Windows Job operation failed');
        if (this.phase === 'reclaiming') {
          this.phase = 'ready'; this.reclaimPending?.reject(error); this.reclaimPending = undefined;
        } else this.fail(error);
        return;
      }
      this.fail(new Error('Unexpected Windows Job response'));
    });
    this.guardian.stdin.on('error', error => this.fail(error));
    this.guardian.on('error', error => this.fail(error));
    this.guardian.on('exit', () => this.fail(new Error(`Windows Job guardian exited without release confirmation: ${stderr}`)));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fail(error: Error): void {
    if (this.phase === 'released' || this.phase === 'failed') return;
    this.failure = error;
    this.phase = 'failed';
    this.clearTimer();
    this.openedPending.reject(error);
    this.readyPending.reject(error);
    this.reclaimPending?.reject(error);
    this.reclaimPending = undefined;
  }

  /** Call only after the original child responded to the owner's fresh nonce. */
  assign(): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.phase !== 'opened') return Promise.reject(new Error('Windows Job handle is not awaiting assignment'));
    this.phase = 'assigning';
    this.timer = setTimeout(() => this.fail(new Error('Windows Job assignment timed out')), 10_000);
    try { this.guardian.stdin.write('assign\n', error => { if (error) this.fail(error); }); }
    catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    return this.ready;
  }

  reclaim(): Promise<void> {
    if (this.reclaiming) return this.reclaiming;
    if (this.phase === 'released') return Promise.resolve();
    if (this.failure) return Promise.reject(this.failure);
    if (this.phase !== 'ready') return Promise.reject(new Error('Windows Job is not ready for reclamation'));
    this.phase = 'reclaiming';
    const attempt = (async () => {
      await new Promise<void>((resolve, reject) => {
        this.reclaimPending = { resolve, reject };
        try { this.guardian.stdin.write('reclaim\n', error => { if (error) this.fail(error); }); }
        catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
      });
      await this.exited;
    })();
    this.reclaiming = attempt;
    void attempt.then(
      () => { if (this.reclaiming === attempt) this.reclaiming = undefined; },
      () => { if (this.reclaiming === attempt) this.reclaiming = undefined; }
    );
    return attempt;
  }

  abandon(): void { this.guardian.stdin.end(); }
  waitForExit(): Promise<void> { return this.exited; }
}
