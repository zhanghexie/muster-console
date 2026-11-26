import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawnOwnedProcess, type OwnedProcess, type OwnedProcessOptions } from '../agentSession/process/owner';
import { toUnpackedAsarPath } from '../asarPaths';

type Owner = OwnedProcess<ChildProcessWithoutNullStreams>;
type Factory = (options: OwnedProcessOptions<ChildProcessWithoutNullStreams>) => Owner;

export function windowsEscapeScript(mainDir: string): string {
  if (!path.isAbsolute(mainDir)) throw new Error('Desktop asset directory must be absolute');
  return toUnpackedAsarPath(path.join(mainDir, 'desktop', 'windows-escape-monitor.ps1'));
}

/** The helper reports only non-injected Escape, never the user's other keys. */
export class WindowsEscapeMonitor {
  private owner?: Owner;
  private state: 'new' | 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed' = 'new';
  private startup?: { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private stopping?: Promise<void>;
  private buffer = '';
  private failureReason?: string;

  constructor(private readonly script: string, private readonly onEscape: () => void, private readonly onFailure: (reason: string) => void,
    private readonly env: NodeJS.ProcessEnv = process.env, private readonly factory: Factory = spawnOwnedProcess,
    private readonly platform: NodeJS.Platform = process.platform) {}

  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error('Escape monitor already started');
    if (this.platform !== 'win32') throw new Error('Windows Escape monitor is unavailable on this platform');
    const systemRoot = this.env.SystemRoot || this.env.SYSTEMROOT || this.env.WINDIR;
    if (!systemRoot || !path.win32.isAbsolute(systemRoot) || !path.isAbsolute(this.script)) throw new Error('Windows Escape monitor path is unavailable');
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path', 'USERPROFILE', 'HOME']) {
      if (typeof this.env[key] === 'string') env[key] = this.env[key]!;
    }
    this.state = 'starting';
    const owner = this.factory({ command: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script],
      spawnOptions: { env, stdio: 'pipe' }, windows: { kind: 'taskkill' } });
    this.owner = owner;
    owner.child.stderr.resume();
    owner.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk.toString('utf8')));
    owner.child.stdout.on('error', () => this.fail('Windows Escape monitor output failed'));
    owner.child.stdout.on('end', () => this.fail('Windows Escape monitor output ended'));
    owner.child.stdout.on('close', () => this.fail('Windows Escape monitor output closed'));
    owner.child.stderr.on('error', () => this.fail('Windows Escape monitor error output failed'));
    void owner.exited.then(() => {
      if (this.state !== 'stopping' && this.state !== 'stopped') this.fail('Windows Escape monitor exited');
    });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Windows Escape monitor did not become ready'), 5000);
      timer.unref?.();
      this.startup = { resolve, reject, timer };
    });
    void ready.catch(() => undefined);
    try {
      await owner.ready;
      await ready;
      // READY and a failure can arrive in the same chunk before this await
      // resumes. Never report a live hook after it has already failed.
      if ((this.state as string) !== 'ready') throw new Error(this.failureReason || 'Windows Escape monitor stopped during startup');
    }
    catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      try { await this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Escape monitor startup failed and cleanup is unconfirmed'); }
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state = 'stopping';
    if (this.startup) { clearTimeout(this.startup.timer); this.startup.reject(new Error('Escape monitor stopped')); this.startup = undefined; }
    const owner = this.owner;
    this.stopping = (async () => {
      if (owner) await owner.reclaim();
      this.state = 'stopped';
    })();
    return this.stopping;
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > 1024) { this.fail('Windows Escape monitor output exceeded its limit'); return; }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line === 'READY' && this.state === 'starting' && this.startup) {
        this.state = 'ready';
        const pending = this.startup; this.startup = undefined;
        clearTimeout(pending.timer); pending.resolve();
      } else if (line === 'ESC' && this.state === 'ready') {
        try { this.onEscape(); } catch { this.fail('Windows Escape stop callback failed'); }
      } else { this.fail('Windows Escape monitor sent an invalid message'); return; }
    }
  }

  private fail(reason: string): void {
    if (this.state === 'failed' || this.state === 'stopping' || this.state === 'stopped') return;
    const wasReady = this.state === 'ready';
    this.state = 'failed';
    this.failureReason = reason;
    if (this.startup) { clearTimeout(this.startup.timer); this.startup.reject(new Error(reason)); this.startup = undefined; }
    try { this.onFailure(reason); } catch { /* failing to notify cannot resurrect the monitor */ }
    if (wasReady) void this.stop().catch(() => undefined);
  }
}
