import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toUnpackedAsarPath } from '../asarPaths';
import type { DesktopActionIdempotency } from './actionIdempotency';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';
import { desktopRuntime } from './runtime';
import { LINUX_GIO_LAUNCH_WORKER_SOURCE } from './linuxGioLaunchWorker';

/** Supplied by the host's current visible desktop run, never by tool arguments. */
export interface LinuxLaunchActor {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly lifetimeSignal: AbortSignal;
  isCurrent(): boolean;
}

/** Private discovery proof. filePath is the canonical selected desktop file, not an app executable. */
export interface LinuxDiscoveredApp {
  readonly desktopFileId: string;
  readonly filePath: string;
  readonly sha256: string;
  isCurrent(): boolean;
}

export type LinuxLaunchResult =
  | { outcome: 'dispatched'; delivery: 'dispatched'; effect: 'unverifiable'; verification: 'not_performed' }
  | { outcome: 'unknown'; reason: 'previous-unknown' | 'cancelled' | 'timeout' | 'session-changed' | 'gio-failed' | 'cleanup-unconfirmed' | 'receipt-unavailable' };

export type LinuxLaunchErrorCode = 'invalid' | 'unsupported_platform' | 'session_unavailable' | 'stale_reference' |
  'dependency_missing' | 'cancelled' | 'timeout' | 'busy' | 'closed' | 'cleanup_unconfirmed' | 'receipt_unavailable' | 'stop_unconfirmed';
export class LinuxLaunchError extends Error {
  constructor(readonly code: LinuxLaunchErrorCode, readonly outcome: 'not_dispatched' | 'unknown', message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause }); this.name = 'LinuxLaunchError';
  }
}

export interface LinuxGioLaunchWorker {
  prepare(proof: Readonly<Pick<LinuxDiscoveredApp, 'desktopFileId' | 'filePath' | 'sha256'>>): Promise<void>;
  launch(): Promise<boolean>;
  /** Reaps the helper only; an application already launched must not be killed. */
  close(): Promise<void>;
}
type WorkerFactory = (environment: Readonly<NodeJS.ProcessEnv>) => LinuxGioLaunchWorker;
export interface LinuxDesktopLauncherOptions {
  /** Must resolve only a host-owned, actor-bound discovery reference. */
  resolveReference(actor: LinuxLaunchActor, reference: string): LinuxDiscoveredApp;
  receipts: Pick<DesktopActionIdempotency, 'run'>;
  /** Synchronously stop the host's visible desktop run on an uncertain result. */
  onUnknown(result: Readonly<Extract<LinuxLaunchResult, { outcome: 'unknown' }>>): void;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Host-only test seam; production uses the isolated GIO worker. */
  createWorker?: WorkerFactory;
}

const ENVIRONMENT_KEYS = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY',
  'XDG_SESSION_TYPE', 'XDG_RUNTIME_DIR', 'XDG_CURRENT_DESKTOP', 'XDG_DATA_HOME', 'XDG_DATA_DIRS', 'XDG_CONFIG_HOME',
  'XDG_CONFIG_DIRS', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES'] as const;
const moduleFile = typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url);
const requireForWorker = createRequire(moduleFile);
const token = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256;
const live = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };

function preError(code: LinuxLaunchErrorCode, message: string, cause?: unknown): LinuxLaunchError {
  return new LinuxLaunchError(code, 'not_dispatched', message, cause);
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.endsWith('.desktop') && value.length > 8 && Buffer.byteLength(value) <= 255 &&
    !/[\/\\\u0000-\u001f\u007f-\u009f]/.test(value) && value !== '..desktop';
}
function validateProof(value: LinuxDiscoveredApp): LinuxDiscoveredApp {
  if (!value || !validId(value.desktopFileId) || typeof value.filePath !== 'string' || !path.posix.isAbsolute(value.filePath) ||
      value.filePath !== path.posix.normalize(value.filePath) || value.filePath.includes('\0') || value.filePath.length > 4096 ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256) || typeof value.isCurrent !== 'function') {
    throw preError('stale_reference', 'The discovered application reference is unavailable; discover it again');
  }
  return Object.freeze({ desktopFileId: value.desktopFileId, filePath: value.filePath, sha256: value.sha256.toLowerCase(),
    isCurrent: value.isCurrent.bind(value) });
}
function awaitAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return; settled = true; signal.removeEventListener('abort', abort); callback();
    };
    const abort = (): void => finish(() => reject(new Error('Linux desktop launch interrupted')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Linux GIO helper cleanup timed out')), timeoutMs);
    void operation.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

/** A single helper is killed by PID, never by process group: the launched app must survive. */
class LinuxGioChildWorker implements LinuxGioLaunchWorker {
  private readonly child: ChildProcess;
  private readonly spawned: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly koffiPath: string;
  private closing?: Promise<void>;
  private pending = false;

  constructor(environment: Readonly<NodeJS.ProcessEnv>, private readonly cleanupTimeout: number) {
    try { this.koffiPath = toUnpackedAsarPath(requireForWorker.resolve('koffi')); }
    catch { throw preError('dependency_missing', 'The GIO launcher requires the packaged Koffi dependency; rebuild or reinstall the application'); }
    const child = spawn(process.execPath, ['-e', LINUX_GIO_LAUNCH_WORKER_SOURCE], {
      env: { ...environment, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false, windowsHide: true
    });
    this.child = child;
    // Retain an error listener even between requests; a late IPC/process error
    // must not become an unhandled EventEmitter error in the main process.
    child.on('error', () => undefined);
    this.spawned = new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    this.exited = new Promise(resolve => {
      child.once('exit', () => resolve());
      child.once('error', () => { if (!child.pid) resolve(); });
    });
    void this.spawned.catch(() => undefined);
  }

  async prepare(proof: Readonly<Pick<LinuxDiscoveredApp, 'desktopFileId' | 'filePath' | 'sha256'>>): Promise<void> {
    const reply = await this.exchange({ type: 'prepare', desktopId: proof.desktopFileId, filePath: proof.filePath,
      sha256: proof.sha256, koffiPath: this.koffiPath });
    if (reply.type === 'prepared') return;
    if (reply.code === 'TARGET_CHANGED' || reply.code === 'APP_UNAVAILABLE') {
      throw preError('stale_reference', 'The selected desktop entry changed or is unavailable; discover the application again');
    }
    throw preError('dependency_missing', 'GIO could not prepare the application; check GLib/GIO and the desktop entry');
  }

  async launch(): Promise<boolean> {
    const reply = await this.exchange({ type: 'launch' });
    if (reply.type !== 'result' || typeof reply.accepted !== 'boolean') throw new Error('GIO launch result is unavailable');
    return reply.accepted;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try { await this.spawned; } catch { /* a failed spawn has no process to terminate */ }
      if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid) {
        try { this.child.kill('SIGKILL'); } catch { /* waiting for exit decides whether cleanup succeeded */ }
      }
      await bounded(this.exited, this.cleanupTimeout);
    })();
    return this.closing;
  }

  private async exchange(message: object): Promise<Record<string, unknown>> {
    await this.spawned;
    if (this.pending || this.closing || !this.child.connected || typeof this.child.send !== 'function') throw new Error('GIO helper is unavailable');
    this.pending = true;
    try {
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: Record<string, unknown>): void => {
          if (settled) return; settled = true;
          this.child.off('message', onMessage); this.child.off('exit', onExit); this.child.off('error', onError); this.child.off('disconnect', onExit);
          if (error) reject(error); else resolve(value!);
        };
        const onMessage = (raw: unknown): void => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return finish(new Error('Invalid GIO helper response'));
          const value = raw as Record<string, unknown>;
          if (typeof value.type !== 'string' || !['prepared', 'failure', 'result'].includes(value.type)) return finish(new Error('Invalid GIO helper response'));
          finish(undefined, value);
        };
        const onExit = (): void => finish(new Error('GIO helper exited before responding'));
        const onError = (): void => finish(new Error('GIO helper failed'));
        this.child.on('message', onMessage); this.child.once('exit', onExit); this.child.once('error', onError); this.child.once('disconnect', onExit);
        try { this.child.send!(message, error => { if (error) finish(new Error('GIO helper communication failed')); }); }
        catch { finish(new Error('GIO helper communication failed')); }
      });
    } finally { this.pending = false; }
  }
}

/**
 * Host-only Linux desktop-entry launcher. The caller must bind resolveReference
 * to a current trusted discovery snapshot and use the shared visible seat.
 * Discovery currently exposes no such reference; this class is not a product route.
 * Extra command arguments, file paths and URIs are intentionally unsupported.
 */
export class LinuxDesktopLauncher {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pinned: Record<string, string | undefined>;
  private readonly environmentFingerprint: string;
  private readonly timeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly createWorker: WorkerFactory;
  private active?: { abort: AbortController; finished: Promise<void>; finish(): void };
  private cleanupFailure?: LinuxLaunchError;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly options: LinuxDesktopLauncherOptions) {
    if (!options || typeof options.resolveReference !== 'function' || typeof options.receipts?.run !== 'function' ||
        typeof options.onUnknown !== 'function' || (options.createWorker !== undefined && typeof options.createWorker !== 'function')) {
      throw preError('invalid', 'Trusted discovery, durable receipts and a desktop stop handler are required');
    }
    if ((options.platform ?? process.platform) !== 'linux') throw preError('unsupported_platform', 'The GIO desktop launcher is available only on Linux');
    this.environment = options.env ?? process.env;
    this.pinned = Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, this.environment[key]]));
    for (const key of ENVIRONMENT_KEYS) {
      const value = this.pinned[key];
      if (value !== undefined && (typeof value !== 'string' || value.includes('\0') || value.length > 32768)) throw preError('invalid', 'Invalid Linux desktop environment');
    }
    this.environmentFingerprint = createHash('sha256')
      .update(JSON.stringify(ENVIRONMENT_KEYS.map(key => [key, this.pinned[key] ?? null])))
      .digest('hex');
    const runtime = desktopRuntime('linux', this.pinned);
    if (!path.posix.isAbsolute(this.pinned.HOME ?? '') || (runtime === 'linux-x11' && !this.pinned.DISPLAY?.trim()) ||
        (runtime === 'linux-wayland' && (!this.pinned.WAYLAND_DISPLAY?.trim() || !path.posix.isAbsolute(this.pinned.XDG_RUNTIME_DIR ?? ''))) ||
        !['linux-x11', 'linux-wayland'].includes(runtime)) {
      throw preError('session_unavailable', 'Start a supported X11 or native Wayland session with a valid HOME and display');
    }
    for (const key of ['XDG_DATA_HOME', 'XDG_CONFIG_HOME'] as const) {
      if (this.pinned[key] && !path.posix.isAbsolute(this.pinned[key]!)) throw preError('invalid', 'XDG home directories must be absolute');
    }
    for (const key of ['XDG_DATA_DIRS', 'XDG_CONFIG_DIRS'] as const) {
      if (this.pinned[key] && this.pinned[key]!.split(':').some(dir => !path.posix.isAbsolute(dir))) throw preError('invalid', 'XDG search directories must be absolute');
    }
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 20 || this.timeoutMs > 60000 ||
        !Number.isSafeInteger(this.cleanupTimeoutMs) || this.cleanupTimeoutMs < 20 || this.cleanupTimeoutMs > 30000) throw preError('invalid', 'Invalid Linux launch timeout');
    this.createWorker = options.createWorker ?? (environment => new LinuxGioChildWorker(environment, this.cleanupTimeoutMs));
  }

  async launch(rawActor: LinuxLaunchActor, request: { reference: string; requestId: string }, signal?: AbortSignal): Promise<LinuxLaunchResult> {
    this.assertOpen();
    if (this.active) throw preError('busy', 'Another Linux application launch is still being cleaned up');
    if (!rawActor || !token(rawActor.sessionId) || !token(rawActor.taskId) || !token(rawActor.turnId) ||
        !(rawActor.lifetimeSignal instanceof AbortSignal) || typeof rawActor.isCurrent !== 'function' ||
        !request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => key !== 'reference' && key !== 'requestId') || !token(request.reference) ||
        typeof request.requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(request.requestId) ||
        (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw preError('invalid', 'A trusted actor, discovery reference and request ID are required; extra launch arguments are unsupported');
    }
    const actor: LinuxLaunchActor = Object.freeze({ sessionId: rawActor.sessionId, taskId: rawActor.taskId, turnId: rawActor.turnId,
      lifetimeSignal: rawActor.lifetimeSignal, isCurrent: rawActor.isCurrent.bind(rawActor) });
    if (!this.environmentCurrent()) throw preError('session_unavailable', 'The Linux desktop environment changed; recreate the launcher and discover again');
    if (actor.lifetimeSignal.aborted || signal?.aborted || !live(actor.isCurrent)) throw preError('cancelled', 'Linux application launch was cancelled before dispatch');
    let proof: LinuxDiscoveredApp;
    try { proof = validateProof(this.options.resolveReference(actor, request.reference)); }
    catch (error) { if (error instanceof LinuxLaunchError) throw error; throw preError('stale_reference', 'The discovered application reference is unavailable; discover it again'); }
    if (!live(proof.isCurrent)) throw preError('stale_reference', 'The discovered application changed; discover it again');

    let finish!: () => void;
    const operation = { abort: new AbortController(), finished: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    this.active = operation;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const watch = setInterval(() => { if (!this.environmentCurrent() || !live(actor.isCurrent) || !live(proof.isCurrent)) operation.abort.abort(); }, 100); watch.unref?.();
    const combined = AbortSignal.any([operation.abort.signal, timeout.signal, actor.lifetimeSignal, ...(signal ? [signal] : [])]);
    const current = (): boolean => !combined.aborted && !this.closed && this.environmentCurrent() && live(actor.isCurrent) && live(proof.isCurrent);
    const reason = (): Extract<LinuxLaunchResult, { outcome: 'unknown' }>['reason'] =>
      timeout.signal.aborted ? 'timeout' : !this.environmentCurrent() || !live(actor.isCurrent) || !live(proof.isCurrent) ? 'session-changed' : 'cancelled';
    const beforeDispatchFailure = (): LinuxLaunchError => timeout.signal.aborted
      ? preError('timeout', 'GIO preparation timed out before dispatch')
      : !this.environmentCurrent() ? preError('session_unavailable', 'The Linux desktop environment changed; discover the application again')
        : !live(proof.isCurrent) ? preError('stale_reference', 'The discovered application changed; discover it again')
          : preError('cancelled', 'Linux application launch was cancelled before dispatch');
    let dispatched = false, marking = false;
    try {
      const result = await this.options.receipts.run<LinuxLaunchResult>(actor.sessionId, actor.taskId, request.requestId,
        { version: 1, action: 'linux.gio.launch', desktopFileId: proof.desktopFileId, filePath: proof.filePath, sha256: proof.sha256,
          sessionFingerprint: this.environmentFingerprint },
        current, async markDispatch => {
          let worker: LinuxGioLaunchWorker | undefined, failure: unknown, accepted = false, cleanupFailed = false;
          try {
            if (!current()) throw preError('cancelled', 'Linux application launch was cancelled before dispatch');
            worker = this.createWorker(Object.freeze({ ...this.pinned }));
            if (!worker || typeof worker.prepare !== 'function' || typeof worker.launch !== 'function' || typeof worker.close !== 'function') {
              throw preError('invalid', 'The Linux GIO worker is unavailable');
            }
            await awaitAbort(Promise.resolve().then(() => worker!.prepare(proof)), combined);
            if (!current()) throw preError('cancelled', 'Linux application launch was cancelled before dispatch');
            marking = true; markDispatch(); dispatched = true;
            accepted = await awaitAbort(Promise.resolve().then(() => worker!.launch()), combined);
          } catch (error) { failure = error; }
          if (worker) {
            try { await bounded(Promise.resolve().then(() => worker!.close()), this.cleanupTimeoutMs); }
            catch (error) {
              cleanupFailed = true;
              this.cleanupFailure = new LinuxLaunchError('cleanup_unconfirmed', dispatched ? 'unknown' : 'not_dispatched',
                'The GIO helper could not be confirmed stopped; inspect it before another launch', error);
            }
          }
          if (cleanupFailed) {
            if (dispatched) return { outcome: 'unknown', reason: 'cleanup-unconfirmed' };
            throw new PreDispatchRecoveryRequired(this.cleanupFailure);
          }
          if (failure) {
            if (dispatched) return { outcome: 'unknown', reason: combined.aborted || !current() ? reason() : 'gio-failed' };
            if (marking) throw new PreDispatchRecoveryRequired(failure);
            if (combined.aborted || !current()) throw new PreDispatchFailure(beforeDispatchFailure());
            throw new PreDispatchFailure(failure instanceof LinuxLaunchError ? failure : preError('dependency_missing', 'GIO could not prepare the application; check Linux desktop dependencies'));
          }
          if (accepted !== true) return { outcome: 'unknown', reason: 'gio-failed' };
          return { outcome: 'dispatched', delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' };
        }, combined);
      if (result.outcome === 'unknown') return this.unknown({ outcome: 'unknown', reason: 'reason' in result &&
        ['previous-unknown', 'cancelled', 'timeout', 'session-changed', 'gio-failed', 'cleanup-unconfirmed', 'receipt-unavailable'].includes(String(result.reason))
        ? result.reason as Extract<LinuxLaunchResult, { outcome: 'unknown' }>['reason'] : 'previous-unknown' });
      if (result.outcome !== 'dispatched' || !('delivery' in result) || result.delivery !== 'dispatched' || result.effect !== 'unverifiable' ||
          result.verification !== 'not_performed' || Object.keys(result).some(key => !['outcome', 'delivery', 'effect', 'verification'].includes(key))) {
        return this.unknown({ outcome: 'unknown', reason: 'receipt-unavailable' });
      }
      return result;
    } catch (error) {
      if (error instanceof LinuxLaunchError && error.code === 'stop_unconfirmed') throw error;
      if (dispatched) return this.unknown({ outcome: 'unknown', reason: this.cleanupFailure ? 'cleanup-unconfirmed' : !current() ? reason() : 'receipt-unavailable' });
      if (error instanceof PreDispatchRecoveryRequired || this.cleanupFailure) throw this.cleanupFailure ?? preError('receipt_unavailable', 'The action was not dispatched; its receipt may need inspection', error);
      if (error instanceof PreDispatchFailure && error.cause instanceof LinuxLaunchError) throw error.cause;
      if (combined.aborted || !current()) throw beforeDispatchFailure();
      throw preError('receipt_unavailable', 'This action was not dispatched; an earlier action with the same request ID may have an unknown outcome', error);
    } finally {
      clearTimeout(timer); clearInterval(watch);
      if (this.active === operation) this.active = undefined;
      operation.finish();
    }
  }

  async stopAll(): Promise<void> {
    const active = this.active;
    active?.abort.abort();
    if (active) await active.finished;
    if (this.cleanupFailure) throw this.cleanupFailure;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.stopAll();
    return this.closePromise;
  }
  private environmentCurrent(): boolean { return ENVIRONMENT_KEYS.every(key => this.environment[key] === this.pinned[key]); }
  private assertOpen(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed) throw preError('closed', 'The Linux desktop launcher is closed');
  }
  private unknown(result: Extract<LinuxLaunchResult, { outcome: 'unknown' }>): LinuxLaunchResult {
    const frozen = Object.freeze({ ...result });
    try {
      const response: unknown = this.options.onUnknown(frozen);
      if (response !== undefined) {
        if (response && typeof (response as PromiseLike<unknown>).then === 'function') void Promise.resolve(response).catch(() => undefined);
        throw new Error('The desktop stop handler must be synchronous');
      }
    } catch (error) { throw new LinuxLaunchError('stop_unconfirmed', 'unknown', 'The application outcome is unknown and desktop stop could not be confirmed', error); }
    return frozen;
  }
}
