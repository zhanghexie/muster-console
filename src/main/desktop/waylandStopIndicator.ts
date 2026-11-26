import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';
import type { DesktopIndicatorSnapshot } from '../../shared/desktopIndicator';
import { spawnOwnedProcess, type OwnedProcess, type OwnedProcessOptions } from '../agentSession/process/owner';
import { toUnpackedAsarPath } from '../asarPaths';

export function waylandStopHelperPath(mainDir: string): string {
  if (!path.isAbsolute(mainDir)) throw new Error('Desktop asset directory must be absolute');
  return toUnpackedAsarPath(path.join(mainDir, 'desktop', 'waylandStopHelper.py'));
}

/** A mapped layer-shell surface does not guarantee absence of occlusion. */
export interface WaylandStopReceipt {
  readonly pid: number;
  readonly namespace: string;
  readonly outputs: number;
  readonly revision: number;
}
export interface WaylandVisibilityLease {
  /** Optional, compositor-specific additional visibility check. */
  isCurrent(): boolean;
  release(): void;
}
export interface WaylandStopOptions {
  /** Host-controlled absolute paths; never accept paths chosen by an agent/model. */
  pythonPath: string;
  helperPath: string;
  stop(): Promise<void>;
  unavailable(reason: string): void;
  /** Optional additional compositor-specific check, independent of the helper. */
  verifyVisible?(receipt: Readonly<WaylandStopReceipt>, invalidated: () => void): Promise<WaylandVisibilityLease>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  /** Tests only. */
  spawn?: (options: OwnedProcessOptions<ChildProcess>) => OwnedProcess<ChildProcess>;
}

const sessionKeys = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP'] as const;
const MAX_BUFFER = 16384;

/**
 * Native Wayland-only Stop button. GTK requests an overlay without keyboard
 * interactivity; this class never registers or intercepts Escape. The helper
 * checks each output's mapped, sensitive Stop control and reports health.
 * A compositor or another surface can still obscure it. Production consults
 * isCurrent() synchronously at each dispatch.
 */
export class WaylandStopIndicator {
  private readonly env: NodeJS.ProcessEnv;
  private readonly pinned: Record<string, string | undefined>;
  private readonly startupTimeout: number;
  private readonly heartbeatTimeout: number;
  private owner?: OwnedProcess<ChildProcess>;
  private lease?: WaylandVisibilityLease;
  private mapped = false;
  private retireLease?: () => void;
  private watchdog?: ReturnType<typeof setInterval>;
  private cleanup: Promise<void> = Promise.resolve();
  private cleanupFailure?: Error;
  private generation = 0;
  private namespace = '';
  private output = '';
  private lastHeartbeat = 0;
  private lastRevision = -1;
  private stopRequested = false;
  private pending?: { revision: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; verifying: boolean };

  constructor(private readonly options: WaylandStopOptions) {
    if (!options || !path.posix.isAbsolute(options.pythonPath) || !path.posix.isAbsolute(options.helperPath) ||
        options.pythonPath.includes('\0') || options.helperPath.includes('\0') || typeof options.stop !== 'function' ||
        typeof options.unavailable !== 'function' || (options.spawn !== undefined && typeof options.spawn !== 'function')) {
      throw new Error('Host-owned absolute Python/helper paths and Stop callbacks are required');
    }
    this.env = options.env ?? process.env;
    this.pinned = Object.fromEntries(sessionKeys.map(key => [key, this.env[key]]));
    this.startupTimeout = options.startupTimeoutMs ?? 5000;
    this.heartbeatTimeout = options.heartbeatTimeoutMs ?? 2000;
    if (!Number.isSafeInteger(this.startupTimeout) || this.startupTimeout < 20 || this.startupTimeout > 30000 ||
        !Number.isSafeInteger(this.heartbeatTimeout) || this.heartbeatTimeout < 100 || this.heartbeatTimeout > 30000) {
      throw new Error('Invalid Wayland Stop control time limits');
    }
  }

  async show(snapshot: DesktopIndicatorSnapshot): Promise<void> {
    this.assertSession();
    if (!snapshot || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.revision <= this.lastRevision) {
      throw new Error('Wayland Stop control revision must increase');
    }
    if (this.pending) throw new Error('A Wayland Stop control update is already pending');
    const generation = this.generation;
    await this.cleanup;
    if (generation !== this.generation) throw new Error('Wayland Stop control was closed');
    if (this.cleanupFailure) throw this.cleanupFailure;
    this.assertSession();
    if (!this.owner) this.launch(generation);
    const owner = this.owner!;
    this.lastRevision = snapshot.revision;
    const message = JSON.stringify({ kind: 'render', namespace: this.namespace, revision: snapshot.revision,
      state: snapshot.state, target: snapshot.target, escapeAvailable: snapshot.escapeAvailable, labels: snapshot.labels });
    if (Buffer.byteLength(message) > MAX_BUFFER - 1) { this.fail(generation, 'Wayland Stop control update is too large'); throw new Error('Wayland Stop control update is too large'); }
    const mounted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(generation, 'Wayland Stop control or visibility check timed out'), this.startupTimeout);
      timer.unref?.();
      this.pending = { revision: snapshot.revision, resolve, reject, timer, verifying: false };
    });
    void mounted.catch(() => undefined);
    try {
      await Promise.race([owner.ready, mounted]);
      if (generation !== this.generation || owner !== this.owner || owner.state !== 'ready' || !owner.child.stdin) throw new Error('Wayland Stop control process is unavailable');
      owner.child.stdin.write(`${message}\n`, error => { if (error) this.fail(generation, 'Wayland Stop control IPC failed'); });
      await mounted;
      if (generation !== this.generation || !this.isCurrent()) throw new Error('Wayland Stop control is unavailable');
    } catch (error) {
      this.fail(generation, error instanceof Error ? error.message : String(error));
      try { await this.whenClosed(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'Wayland Stop control failed and helper cleanup is unconfirmed'); }
      throw error;
    }
  }

  /** Must be checked together with the host activity epoch before each input dispatch. */
  isCurrent(): boolean {
    try {
      this.assertSession();
      return !!this.owner && this.owner.state === 'ready' && this.mapped && (!this.lease || this.lease.isCurrent() === true) &&
        performance.now() - this.lastHeartbeat <= this.heartbeatTimeout;
    } catch { return false; }
  }

  close(): void {
    ++this.generation;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = undefined;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('Wayland Stop control closed'));
      this.pending = undefined;
    }
    const retire = this.retireLease; this.retireLease = undefined; this.lease = undefined; this.mapped = false;
    try { retire?.(); } catch { /* The proof is no longer current. */ }
    const owner = this.owner; this.owner = undefined;
    this.lastRevision = -1; this.stopRequested = false; this.output = '';
    if (owner) this.cleanup = this.cleanup.then(() => owner.reclaim()).catch(error => {
      this.cleanupFailure = new Error(`Wayland Stop helper cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`);
      try { this.options.unavailable(this.cleanupFailure.message); } catch { /* cannot restore visibility */ }
    });
  }

  /** Host disposal must await this before claiming the helper was reclaimed. */
  async whenClosed(): Promise<void> {
    await this.cleanup;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }

  private assertSession(): void {
    if ((this.options.platform ?? process.platform) !== 'linux') throw new Error('Native Wayland Stop control requires Linux');
    if (this.env.XDG_SESSION_TYPE?.toLowerCase() !== 'wayland' || !this.env.WAYLAND_DISPLAY?.trim() ||
        !this.env.XDG_RUNTIME_DIR || !path.posix.isAbsolute(this.env.XDG_RUNTIME_DIR)) {
      throw new Error('Start a native Wayland session with WAYLAND_DISPLAY and XDG_RUNTIME_DIR; XWayland is not supported');
    }
    if (sessionKeys.some(key => this.pinned[key] !== this.env[key])) throw new Error('The Wayland session changed; restart desktop control');
  }

  private launch(generation: number): void {
    this.namespace = `muster-stop-${randomBytes(16).toString('hex')}`;
    const allowed = [...sessionKeys, 'HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'XDG_DATA_DIRS', 'XDG_CONFIG_DIRS'];
    const env: NodeJS.ProcessEnv = Object.fromEntries(allowed.flatMap(key => typeof this.env[key] === 'string' ? [[key, this.env[key]!]] : []));
    env.GDK_BACKEND = 'wayland'; env.PYTHONUNBUFFERED = '1';
    const owner = (this.options.spawn ?? spawnOwnedProcess)({ command: this.options.pythonPath, args: ['-I', this.options.helperPath],
      spawnOptions: { env, shell: false, stdio: ['pipe', 'pipe', 'ignore'] }, windows: { kind: 'taskkill' } });
    this.owner = owner; this.lastHeartbeat = performance.now();
    owner.child.stdout?.on('data', chunk => this.receive(generation, chunk));
    owner.child.once('error', () => this.fail(generation, 'Could not launch the Wayland Stop helper; install Python 3 and its GTK dependencies'));
    owner.child.once('close', () => this.fail(generation, 'Wayland Stop helper exited'));
    owner.child.stdin?.on('error', () => this.fail(generation, 'Wayland Stop control IPC failed'));
    this.watchdog = setInterval(() => {
      try {
        this.assertSession();
        if (performance.now() - this.lastHeartbeat > this.heartbeatTimeout) throw new Error('Wayland Stop helper stopped responding');
        if (this.lease && !this.lease.isCurrent()) throw new Error('Wayland Stop control visibility can no longer be verified');
      } catch (error) { this.fail(generation, error instanceof Error ? error.message : String(error)); }
    }, Math.max(50, Math.min(500, Math.floor(this.heartbeatTimeout / 3))));
    this.watchdog.unref?.();
  }

  private receive(generation: number, chunk: Buffer | string): void {
    if (generation !== this.generation) return;
    this.output += chunk.toString();
    if (Buffer.byteLength(this.output) > MAX_BUFFER) { this.fail(generation, 'Invalid Wayland Stop helper output'); return; }
    let end: number;
    while ((end = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, end); this.output = this.output.slice(end + 1);
      try {
        const message: unknown = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid Wayland Stop helper message');
        const value = message as Record<string, unknown>;
        if (value.kind === 'heartbeat') { this.lastHeartbeat = performance.now(); continue; }
        if (value.kind === 'failure' && typeof value.reason === 'string') throw new Error(value.reason.slice(0, 500));
        if (value.kind === 'stop') {
          if (!this.stopRequested) {
            this.stopRequested = true;
            try { void Promise.resolve(this.options.stop()).catch(() => this.fail(generation, 'Stopping desktop control failed')); }
            catch { this.fail(generation, 'Stopping desktop control failed'); }
          }
          continue;
        }
        if (value.kind === 'mapped') { this.verifyMapped(generation, value); continue; }
        throw new Error('Unexpected Wayland Stop helper message');
      } catch (error) { this.fail(generation, error instanceof Error ? error.message : String(error)); return; }
    }
  }

  private verifyMapped(generation: number, value: Record<string, unknown>): void {
    const pending = this.pending;
    if (!pending || pending.verifying || value.revision !== pending.revision || value.pid !== this.owner?.child.pid ||
        value.namespace !== this.namespace || !Number.isSafeInteger(value.outputs) || (value.outputs as number) < 1 || (value.outputs as number) > 64) {
      throw new Error('Invalid Wayland Stop surface receipt');
    }
    pending.verifying = true;
    const receipt: WaylandStopReceipt = Object.freeze({ pid: value.pid as number, namespace: this.namespace,
      outputs: value.outputs as number, revision: pending.revision });
    if (!this.options.verifyVisible) {
      this.mapped = true;
      clearTimeout(pending.timer); this.pending = undefined; pending.resolve();
      return;
    }
    let retired = false;
    const invalidated = (): void => { if (!retired) this.fail(generation, 'Wayland Stop control visibility can no longer be verified'); };
    void Promise.resolve().then(() => this.options.verifyVisible!(receipt, invalidated)).then(lease => {
      if (generation !== this.generation || this.pending !== pending) { try { lease?.release(); } catch { /* stale */ } return; }
      try {
        if (!lease || typeof lease.isCurrent !== 'function' || typeof lease.release !== 'function' || lease.isCurrent() !== true) {
          throw new Error('Independent Wayland Stop visibility proof is unavailable');
        }
      } catch (error) {
        retired = true;
        try { lease?.release?.(); } catch { /* preserve the proof failure */ }
        throw error;
      }
      const old = this.retireLease; this.lease = lease; this.mapped = true;
      this.retireLease = () => { retired = true; lease.release(); };
      try { old?.(); } catch { /* previous proof was retired */ }
      clearTimeout(pending.timer); this.pending = undefined; pending.resolve();
    }).catch(error => this.fail(generation, error instanceof Error ? error.message : String(error)));
  }

  private fail(generation: number, reason: string): void {
    if (generation !== this.generation) return;
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new Error(reason)); this.pending = undefined; }
    try { this.options.unavailable(reason); } catch { /* cannot restore visibility */ }
    this.close();
  }
}
