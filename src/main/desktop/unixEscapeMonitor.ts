import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { spawnOwnedProcess, type OwnedProcess, type OwnedProcessOptions } from '../agentSession/process/owner';
import { toUnpackedAsarPath } from '../asarPaths';
import type { X11EscapePeer } from './unixEscapeTypes';

type Factory = (options: OwnedProcessOptions<ChildProcess>) => OwnedProcess<ChildProcess>;
type Status = 'new' | 'starting' | 'ready' | 'failed' | 'stopping' | 'stopped';
export function unixEscapeWorkerPath(mainDir: string): string {
  if (!path.isAbsolute(mainDir)) throw new Error('Desktop asset directory must be absolute');
  return toUnpackedAsarPath(path.join(mainDir, 'desktop', 'unix-escape-worker.cjs'));
}
export interface UnixEscapeOptions {
  /** Absolute path of a host-owned bundled worker; never accept a model-supplied executable. */
  workerFile: string;
  onEscape(): void;
  onFailure(reason: string): void;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Nonblocking host proof binding the listener's actual peer to this native X11 session. */
  verifyNativeX11?: (peer: Readonly<X11EscapePeer>) => boolean;
  startupTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  /** Tests only; production uses the existing supervised process owner. */
  spawn?: Factory;
}

const pinnedKeys = ['DISPLAY', 'XAUTHORITY', 'HOME', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'] as const;

/**
 * A global Escape signal, not a physical-input detector. Synthetic Escape can
 * stop an action. A separately managed Stop control remains mandatory; no
 * event observer can promise delivery in every system state.
 */
export class UnixEscapeMonitor {
  /** Expose to the host UI/diagnostics: this listener does not establish physical origin. */
  readonly provenance = 'unknown' as const;
  readonly syntheticEscape = 'may-stop' as const;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pinned: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  private readonly startupTimeout: number;
  private readonly heartbeatTimeout: number;
  private owner?: OwnedProcess<ChildProcess>;
  private state: Status = 'new';
  private startup?: { resolve(): void; reject(error: Error): void };
  private watchdog?: ReturnType<typeof setInterval>;
  private lastHeartbeat = 0;
  private stopping?: Promise<void>;
  private failureReason?: string;
  private escaped = false;
  private workerReady = false;
  private cancelStartup?: (error: Error) => void;
  private peer?: Readonly<X11EscapePeer>;

  constructor(private readonly options: UnixEscapeOptions) {
    if (!options || !path.isAbsolute(options.workerFile) || options.workerFile.includes('\0') ||
        typeof options.onEscape !== 'function' || typeof options.onFailure !== 'function' ||
        (options.spawn !== undefined && typeof options.spawn !== 'function')) throw new Error('A host-owned Escape worker and callbacks are required');
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.pinned = Object.fromEntries(pinnedKeys.map(key => [key, this.env[key]]));
    this.startupTimeout = options.startupTimeoutMs ?? 5000;
    this.heartbeatTimeout = options.heartbeatTimeoutMs ?? 2000;
    if (!Number.isSafeInteger(this.startupTimeout) || this.startupTimeout < 20 || this.startupTimeout > 30000 ||
        !Number.isSafeInteger(this.heartbeatTimeout) || this.heartbeatTimeout < 100 || this.heartbeatTimeout > 30000) throw new Error('Invalid Escape listener time limits');
  }

  async start(): Promise<void> {
    if (this.state !== 'new') throw new Error('Escape listener already started');
    this.assertSession();
    this.state = 'starting';
    const ready = new Promise<void>((resolve, reject) => { this.startup = { resolve, reject }; });
    void ready.catch(() => undefined);
    let deadlineTimer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        const error = new Error('Escape listener did not become ready; use the visible Stop button');
        this.fail(error.message); reject(error);
      }, this.startupTimeout);
    });
    const cancelled = new Promise<never>((_, reject) => { this.cancelStartup = reject; });
    try {
      const allowed = [...pinnedKeys, 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'USER', 'LOGNAME'];
      const env: NodeJS.ProcessEnv = Object.fromEntries(allowed.flatMap(key => typeof this.env[key] === 'string' ? [[key, this.env[key]!]] : []));
      env.ELECTRON_RUN_AS_NODE = '1'; env.MUSTER_UNIX_ESCAPE_WORKER = '1';
      const owner = (this.options.spawn ?? spawnOwnedProcess)({ command: process.execPath, args: [this.options.workerFile],
        spawnOptions: { env, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }, windows: { kind: 'taskkill' } });
      this.owner = owner;
      const child = owner.child;
      child.on('message', message => this.receive(message));
      child.once('error', () => this.fail('Escape listener process failed; use the visible Stop button'));
      child.once('disconnect', () => this.fail('Escape listener IPC disconnected; use the visible Stop button'));
      child.once('close', () => this.fail('Escape listener process exited; use the visible Stop button'));
      await Promise.race([Promise.all([owner.ready, ready]), deadline, cancelled]);
      if (this.state !== 'starting' || owner.state !== 'ready' || !child.connected) throw new Error(this.failureReason || 'Escape listener stopped during startup');
      this.assertSession();
      this.state = 'ready';
      this.lastHeartbeat = performance.now();
      this.watchdog = setInterval(() => {
        try {
          this.assertSession();
          if (!child.connected || performance.now() - this.lastHeartbeat > this.heartbeatTimeout) throw new Error('Escape listener stopped responding; use the visible Stop button');
        } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
      }, Math.max(50, Math.min(500, Math.floor(this.heartbeatTimeout / 3))));
      this.watchdog.unref?.();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      try { await this.stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Escape listener startup failed and cleanup is unconfirmed'); }
      throw error;
    } finally { clearTimeout(deadlineTimer); this.cancelStartup = undefined; }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.state = 'stopping';
    this.cancelStartup?.(new Error('Escape listener stopped'));
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; }
    if (this.startup) { this.startup.reject(new Error('Escape listener stopped')); this.startup = undefined; }
    const owner = this.owner;
    this.stopping = Promise.resolve().then(() => owner?.reclaim()).then(() => { this.state = 'stopped'; });
    return this.stopping;
  }

  private assertSession(): void {
    if (this.platform === 'darwin') return;
    if (this.platform !== 'linux') throw new Error('Unix Escape listener requires macOS or native X11');
    const type = this.env.XDG_SESSION_TYPE?.trim().toLowerCase();
    if (type === 'wayland' || this.env.WAYLAND_DISPLAY?.trim()) {
      throw new Error('Native Wayland global Escape monitoring is unavailable; use the Stop button when the desktop provides it');
    }
    if (type !== 'x11' || !this.env.DISPLAY?.trim()) throw new Error('Start a native X11 session with XDG_SESSION_TYPE=x11 and DISPLAY, then retry');
    if (pinnedKeys.some(key => this.env[key] !== this.pinned[key])) throw new Error('The X11 session changed; restart the Escape listener');
    if (typeof this.options.verifyNativeX11 !== 'function') throw new Error('A current host proof of the native X11 display is required; XWayland is not supported');
    if (this.peer) {
      let trusted = false;
      try { trusted = this.options.verifyNativeX11(this.peer) === true; } catch { /* No trusted proof means unavailable. */ }
      if (!trusted) throw new Error('A current host proof of the native X11 display is required; XWayland is not supported');
    }
  }

  private receive(value: unknown): void {
    if (this.state === 'failed' || this.state === 'stopping' || this.state === 'stopped') return;
    try {
      if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 2048) throw new Error('Invalid Escape listener message');
      const message = value as Record<string, unknown>;
      if (message.kind === 'failure' && typeof message.reason === 'string' && message.reason.length <= 500) throw new Error(message.reason || 'Escape listener failed');
      if (message.kind === 'ready' && this.state === 'starting' && this.startup && !this.workerReady) {
        if (this.platform === 'linux') {
          const peer = message.peer as X11EscapePeer | undefined;
          if (!peer || !Number.isSafeInteger(peer.workerPid) || peer.workerPid !== this.owner?.child.pid ||
              !Number.isSafeInteger(peer.serverPid) || peer.serverPid < 1 || peer.serverPid > 0x7fffffff || peer.serverPid === peer.workerPid ||
              typeof peer.workerStart !== 'string' || !/^\d{1,32}$/.test(peer.workerStart) || typeof peer.serverStart !== 'string' || !/^\d{1,32}$/.test(peer.serverStart) ||
              typeof peer.namespace !== 'string' || !/^\d+:\d+$/.test(peer.namespace) || typeof peer.serverExecutable !== 'string' ||
              peer.serverExecutable.length > 4096 || peer.serverExecutable.includes('\0') || !path.posix.isAbsolute(peer.serverExecutable) ||
              /(?:^|\/)xwayland(?:\s|$)/i.test(peer.serverExecutable)) throw new Error('The X11 Escape listener did not prove its local native server peer');
          this.peer = Object.freeze({ workerPid: peer.workerPid, workerStart: peer.workerStart, serverPid: peer.serverPid,
            serverStart: peer.serverStart, namespace: peer.namespace, serverExecutable: peer.serverExecutable });
          this.assertSession();
        } else if (message.peer !== undefined) throw new Error('Unexpected macOS Escape listener peer');
        this.workerReady = true; this.lastHeartbeat = performance.now();
        const pending = this.startup; this.startup = undefined; pending.resolve(); return;
      }
      if (message.kind === 'heartbeat' && (this.state === 'ready' || (this.state === 'starting' && this.workerReady))) { this.lastHeartbeat = performance.now(); return; }
      if (message.kind === 'escape' && (this.state === 'ready' || (this.state === 'starting' && this.workerReady)) && !this.escaped) {
        this.assertSession(); this.escaped = true; this.options.onEscape(); return;
      }
      throw new Error('Unexpected Escape listener message');
    } catch (error) { this.fail(error instanceof Error ? error.message : String(error)); }
  }

  private fail(reason: string): void {
    if (this.state === 'failed' || this.state === 'stopping' || this.state === 'stopped') return;
    const active = this.state === 'ready';
    this.state = 'failed'; this.failureReason = reason;
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = undefined; }
    if (this.startup) { this.startup.reject(new Error(reason)); this.startup = undefined; }
    try { this.options.onFailure(reason); } catch { /* Diagnostics cannot restore a failed monitor. */ }
    if (active) void this.stop().catch(error => {
      try { this.options.onFailure(`Escape listener cleanup is unconfirmed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* diagnostic only */ }
    });
  }
}
