import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { spawnOwnedProcess, type OwnedProcess, type OwnedProcessOptions } from '../agentSession/process/owner';
import { assertX11Session, x11WindowId } from './x11WindowGeneration';
import type { X11OwnerObservation } from './x11OwnerNative';

type Factory = (options: OwnedProcessOptions<ChildProcess>) => OwnedProcess<ChildProcess>;
export interface X11ServerEvidence { readonly serverPid: number; readonly serverStart: string; isCurrent(): boolean }
export interface X11SemanticAppEvidence { readonly pid: number; readonly processStart: string; isCurrent(): boolean }
export interface X11OwnerProof {
  readonly nativeHandle: string; readonly pid: number; readonly processStart: string; readonly source: 'xres-local';
  isCurrent(): boolean;
}
export interface X11OwnerOptions {
  /** The host supplies a build-owned worker, never a model-provided path. */
  workerFile: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  freshnessMs?: number;
  signal?: AbortSignal;
  /** Prove the Unix peer really is a current native X11 server, not XWayland. */
  verifyNativeX11(observation: Readonly<X11OwnerObservation>, signal: AbortSignal): Promise<X11ServerEvidence>;
  /** Independently bind the XRes PID to the actual local accessibility application, excluding proxies. */
  verifySemanticApp(observation: Readonly<X11OwnerObservation>, signal: AbortSignal): Promise<X11SemanticAppEvidence>;
  /** Test injection; production uses the supervised process owner. */
  spawn?: Factory;
  now?: () => number;
  /** A background reclamation failure must be surfaced to host diagnostics. */
  onCleanupError?: (error: Error) => void;
}
type State = { valid: boolean; observation: Readonly<X11OwnerObservation>; server: X11ServerEvidence; app: X11SemanticAppEvidence;
  epoch: number; expires: number; proof: X11OwnerProof };
type Pending = { nativeHandle: string; resolve(value: X11OwnerObservation): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; abort?: () => void };

const keys = ['DISPLAY', 'XAUTHORITY', 'HOME', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS'] as const;
const validPid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0 && (n as number) <= 0x7fffffff;
const validStart = (v: unknown): v is string => typeof v === 'string' && /^\d{1,32}$/.test(v);
const current = (fn: () => boolean): boolean => { try { return fn() === true; } catch { return false; } };
const sameObservation = (a: X11OwnerObservation, b: X11OwnerObservation): boolean =>
  (['nativeHandle', 'pid', 'processStart', 'workerPid', 'serverPid', 'serverStart', 'serverExecutable', 'namespace'] as const).every(key => a[key] === b[key]);

/**
 * Host-only, fail-closed observations. isCurrent is a bounded local lease, not
 * a synchronous X11 round trip. Production MUST await revalidate at each
 * observation/dispatch boundary and combine this with capture/window proofs.
 */
export class X11OwnerProvider {
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pinned: Record<string, string | undefined>;
  private readonly platform: NodeJS.Platform;
  private readonly timeout: number;
  private readonly freshness: number;
  private readonly now: () => number;
  private readonly states = new Set<State>();
  private readonly owned = new WeakMap<X11OwnerProof, State>();
  private readonly epochs = new Map<string, number>();
  private readonly pending = new Map<number, Pending>();
  private owner?: OwnedProcess<ChildProcess>;
  private counter = 0;
  private ready = false;
  private gotReady = false;
  private failed?: Error;
  private closing?: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly readySignal: Promise<void>;

  private constructor(private readonly options: X11OwnerOptions) {
    if (!options || !path.isAbsolute(options.workerFile) || options.workerFile.includes('\0') || !options.env ||
        typeof options.verifyNativeX11 !== 'function' || typeof options.verifySemanticApp !== 'function' ||
        (options.spawn !== undefined && typeof options.spawn !== 'function') || (options.now !== undefined && typeof options.now !== 'function') ||
        (options.onCleanupError !== undefined && typeof options.onCleanupError !== 'function')) {
      throw new Error('A host-owned X11 worker and independent server/application proofs are required');
    }
    this.platform = options.platform ?? process.platform;
    this.sourceEnv = options.env;
    assertX11Session(this.platform, this.sourceEnv);
    this.pinned = Object.fromEntries(keys.map(key => [key, this.sourceEnv[key]]));
    this.env = Object.fromEntries([...keys, 'PATH', 'LANG', 'LC_ALL'].flatMap(key => typeof this.sourceEnv[key] === 'string' ? [[key, this.sourceEnv[key]!]] : []));
    this.env.ELECTRON_RUN_AS_NODE = '1';
    this.env.MUSTER_X11_OWNER_WORKER = '1';
    this.timeout = options.timeoutMs ?? 3000;
    this.freshness = options.freshnessMs ?? 1000;
    this.now = options.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 30000 ||
        !Number.isSafeInteger(this.freshness) || this.freshness < 10 || this.freshness > 5000) throw new Error('Invalid X11 owner time limits');
    this.readySignal = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.readySignal.catch(() => undefined);
  }

  static async open(options: X11OwnerOptions): Promise<X11OwnerProvider> {
    const provider = new X11OwnerProvider(options);
    await provider.start();
    return provider;
  }

  /** The driver must use the exact pinned display and accessibility session. */
  sameSession(env: NodeJS.ProcessEnv): boolean {
    try { this.assertAvailable(); assertX11Session(this.platform, env); return keys.every(key => env[key] === this.pinned[key]); }
    catch { return false; }
  }

  async prove(rawId: string, signal?: AbortSignal): Promise<X11OwnerProof> {
    this.assertAvailable();
    const id = x11WindowId(rawId);
    signal?.throwIfAborted();
    this.sweep();
    if (this.states.size >= 128) throw new Error('X11 owner proof capacity reached');
    if (!this.epochs.has(id)) {
      if (this.epochs.size >= 128) throw new Error('X11 owner watch capacity reached; start a new capture session');
      this.epochs.set(id, 0);
    }
    const epoch = this.epochs.get(id) ?? 0;
    const started = this.now();
    if (!Number.isFinite(started)) throw new Error('X11 owner clock is unavailable');
    const observed = await this.request(id, signal);
    this.assertAvailable();
    if ((this.epochs.get(id) ?? 0) !== epoch) throw new Error('X11 window was invalidated during ownership verification');
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error('X11 owner verification timed out')), this.timeout);
    try {
      const verify = async <T>(work: Promise<T>): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => {
        if (controller.signal.aborted) reject(controller.signal.reason);
        else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      })]);
      const [server, app] = await verify(Promise.all([this.options.verifyNativeX11(observed, controller.signal), this.options.verifySemanticApp(observed, controller.signal)]));
      this.assertAvailable(); controller.signal.throwIfAborted();
      if ((this.epochs.get(id) ?? 0) !== epoch || !server || server.serverPid !== observed.serverPid || server.serverStart !== observed.serverStart ||
          typeof server.isCurrent !== 'function' || !current(() => server.isCurrent()) || !app || app.pid !== observed.pid ||
          app.processStart !== observed.processStart || typeof app.isCurrent !== 'function' || !current(() => app.isCurrent())) {
        throw new Error('Independent X11 server or semantic application proof is unavailable');
      }
      const serverCurrent = server.isCurrent.bind(server), appCurrent = app.isCurrent.bind(app);
      const frozenServer = Object.freeze({ serverPid: server.serverPid, serverStart: server.serverStart, isCurrent: serverCurrent });
      const frozenApp = Object.freeze({ pid: app.pid, processStart: app.processStart, isCurrent: appCurrent });
      let state!: State;
      const proof = Object.freeze({ nativeHandle: id, pid: observed.pid, processStart: observed.processStart, source: 'xres-local' as const,
        isCurrent: () => this.stateCurrent(state) });
      state = { valid: true, observation: observed, server: frozenServer, app: frozenApp, epoch, expires: started + this.freshness, proof };
      this.states.add(state); this.owned.set(proof, state);
      if (!proof.isCurrent()) throw new Error('X11 owner proof became stale');
      return proof;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
  }

  /** Invalidates the old lease before asynchronously issuing a matching new one. */
  async revalidate(proof: X11OwnerProof, signal?: AbortSignal): Promise<X11OwnerProof> {
    const state = this.owned.get(proof);
    if (!state || !this.stateCurrent(state)) throw new Error('X11 owner proof is unavailable or expired');
    state.valid = false; this.states.delete(state);
    const next = await this.prove(state.observation.nativeHandle, signal);
    const refreshed = this.owned.get(next)!;
    if (!sameObservation(state.observation, refreshed.observation)) {
      refreshed.valid = false; this.states.delete(refreshed);
      throw new Error('X11 window, server or process identity changed');
    }
    return next;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolveClose!: () => void, rejectClose!: (error: unknown) => void;
    const closing = new Promise<void>((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    this.closing = closing;
    this.ready = false;
    for (const state of this.states) state.valid = false;
    this.states.clear();
    for (const [id, entry] of this.pending) { clearTimeout(entry.timer); entry.abort?.(); entry.reject(new Error('X11 owner provider closed')); this.pending.delete(id); }
    this.rejectReady(new Error('X11 owner provider closed'));
    const owner = this.owner;
    void Promise.resolve().then(() => owner?.reclaim()).then(() => resolveClose(), rejectClose);
    return closing;
  }

  private stateCurrent(state: State): boolean {
    if (!state?.valid) return false;
    try {
      this.assertAvailable();
      if ((this.epochs.get(state.observation.nativeHandle) ?? 0) === state.epoch && this.now() < state.expires &&
          state.server.isCurrent() === true && state.app.isCurrent() === true) return true;
    } catch { /* Any failure permanently revokes this lease. */ }
    state.valid = false; this.states.delete(state);
    return false;
  }

  private sweep(): void { for (const state of this.states) this.stateCurrent(state); }
  private assertAvailable(): void {
    if (this.failed) throw this.failed;
    if (!this.ready || this.closing || !this.owner || this.owner.state !== 'ready' || !this.owner.child.connected) throw new Error('X11 owner worker is unavailable');
    assertX11Session(this.platform, this.sourceEnv);
    if (keys.some(key => this.sourceEnv[key] !== this.pinned[key])) throw new Error('X11 session environment changed');
  }

  private async start(): Promise<void> {
    this.options.signal?.throwIfAborted();
    const factory = this.options.spawn ?? spawnOwnedProcess;
    const owner = factory({ command: process.execPath, args: [this.options.workerFile],
      spawnOptions: { env: this.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false }, windows: { kind: 'taskkill' } });
    this.owner = owner;
    const child = owner.child;
    child.on('message', message => this.receive(message));
    child.once('error', error => this.poison(new Error(`X11 owner worker failed: ${error.message}`)));
    child.once('disconnect', () => { if (!this.closing) this.poison(new Error('X11 owner worker IPC disconnected')); });
    child.once('close', () => { if (!this.closing) this.poison(new Error('X11 owner worker exited')); });
    const timeout = setTimeout(() => this.poison(new Error('X11 owner worker startup timed out')), this.timeout);
    const abort = (): void => this.poison(new Error('X11 owner worker startup cancelled'));
    this.options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.all([owner.ready, this.readySignal]);
      if (this.failed || this.closing || owner.state !== 'ready') throw this.failed ?? new Error('X11 owner worker stopped while starting');
      this.ready = true;
      this.assertAvailable();
    } catch (error) {
      try { await this.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'X11 owner startup failed and cleanup is unconfirmed'); }
      throw error;
    } finally { clearTimeout(timeout); this.options.signal?.removeEventListener('abort', abort); }
  }

  private poison(error: Error): void {
    if (this.failed || this.closing) return;
    this.failed = error;
    this.ready = false;
    for (const state of this.states) state.valid = false;
    this.states.clear();
    this.rejectReady(error);
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.abort?.(); pending.reject(error); this.pending.delete(id); }
    void this.close().catch(cleanup => {
      const failure = cleanup instanceof Error ? cleanup : new Error(String(cleanup));
      try { if (this.options.onCleanupError) this.options.onCleanupError(failure); else console.error('[desktop] X11 owner worker cleanup unconfirmed:', failure.message); }
      catch { console.error('[desktop] X11 owner worker cleanup reporting failed'); }
    });
  }

  private request(nativeHandle: string, signal?: AbortSignal): Promise<X11OwnerObservation> {
    this.assertAvailable();
    if (this.pending.size >= 32 || this.counter >= Number.MAX_SAFE_INTEGER) throw new Error('X11 owner request capacity reached');
    const child = this.owner!.child, id = ++this.counter;
    if (!child.connected || typeof child.send !== 'function') throw new Error('X11 owner worker IPC is unavailable');
    return new Promise((resolve, reject) => {
      const fail = (reason: string): void => this.poison(new Error(reason));
      const timer = setTimeout(() => fail('X11 owner request timed out'), this.timeout);
      const abort = () => fail('X11 owner request cancelled');
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.pending.set(id, { nativeHandle, resolve, reject, timer, abort: cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try { child.send!({ id, op: 'probe', nativeHandle }, error => { if (error) fail(`X11 owner request failed: ${error.message}`); }); }
      catch (error) { fail(`X11 owner request failed: ${String(error)}`); }
    });
  }

  private receive(value: unknown): void {
    if (this.failed || this.closing) return;
    try {
      if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value)) > 8192) throw new Error('Invalid X11 owner worker message');
      const message = value as Record<string, unknown>;
      if (message.kind === 'ready') {
        if (this.gotReady) throw new Error('Duplicate X11 owner worker ready');
        this.gotReady = true; this.resolveReady(); return;
      }
      if (message.kind === 'failure' && typeof message.error === 'string') throw new Error(message.error.slice(0, 500));
      if (message.kind === 'invalidated') {
        const id = x11WindowId(message.nativeHandle as string);
        if (!this.epochs.has(id)) throw new Error('Unexpected X11 owner invalidation');
        this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
        for (const state of this.states) if (state.observation.nativeHandle === id) { state.valid = false; this.states.delete(state); }
        return;
      }
      if (message.kind !== 'result' || !Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean') throw new Error('Invalid X11 owner worker message');
      const pending = this.pending.get(message.id as number);
      if (!pending) throw new Error('Unexpected X11 owner worker response');
      if (!message.ok) {
        this.pending.delete(message.id as number); clearTimeout(pending.timer); pending.abort?.();
        pending.reject(new Error(typeof message.error === 'string' ? message.error.slice(0, 500) : 'X11 owner query failed')); return;
      }
      const observation = message.observation as X11OwnerObservation;
      if (!observation || x11WindowId(observation.nativeHandle) !== observation.nativeHandle || observation.nativeHandle !== pending.nativeHandle || !validPid(observation.pid) ||
          !validPid(observation.serverPid) || observation.workerPid !== this.owner?.child.pid || !validStart(observation.processStart) ||
          !validStart(observation.serverStart) || typeof observation.namespace !== 'string' || !/^\d+:\d+$/.test(observation.namespace) ||
          typeof observation.serverExecutable !== 'string' || observation.serverExecutable.length > 4096 || observation.serverExecutable.includes('\0') || !path.posix.isAbsolute(observation.serverExecutable) ||
          /(?:^|\/)xwayland(?:\s|$)/i.test(observation.serverExecutable)) throw new Error('Invalid X11 owner observation');
      this.pending.delete(message.id as number); clearTimeout(pending.timer); pending.abort?.();
      pending.resolve(Object.freeze({ ...observation }));
    } catch (error) { this.poison(error instanceof Error ? error : new Error(String(error))); }
  }
}
