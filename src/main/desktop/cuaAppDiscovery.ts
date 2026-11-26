import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CuaTransport, type CuaConnection } from './cuaTransport';
import { desktopRuntime } from './runtime';

/** Values are supplied by the trusted host, never constructed from model input. */
export interface CuaDiscoveryActor {
  readonly sessionId: string;
  readonly taskId: string;
  readonly turnId: string;
  readonly lifetimeSignal?: AbortSignal;
  isCurrent(): boolean;
}

export type CuaDiscoveryErrorCode = 'invalid' | 'unsupported_platform' | 'dependency_missing' | 'driver_error' |
  'invalid_driver_response' | 'cancelled' | 'timeout' | 'stale' | 'capacity' | 'busy' | 'closed' | 'cleanup_unconfirmed';

export class CuaAppDiscoveryError extends Error {
  constructor(readonly code: CuaDiscoveryErrorCode, message: string) { super(message); this.name = 'CuaAppDiscoveryError'; }
}

export interface CuaAppDiscoveryOptions {
  /** The host must resolve the pinned binary; callers must not choose it. */
  binary?: string;
  createConnection?: () => CuaConnection;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  ttlMs?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  maxSnapshots?: number;
  maxConcurrent?: number;
  /** Timer/abort cleanup failures cannot be silently ignored. */
  onCleanupError?: (error: CuaAppDiscoveryError) => void;
}

type Platform = 'win32' | 'darwin' | 'linux';
type Session = 'windows' | 'macos' | 'x11' | 'wayland' | 'unknown';
export interface CuaObservedApp {
  readonly name: string;
  /** Only macOS bundle identifiers are exposed for launch. */
  readonly appId?: string;
  readonly running: boolean;
  /** True means listed as installed-but-not-running; running rows are ambiguous. */
  readonly installed: true | null;
  /** Cua reserves active=false on Linux, which is not an observation. */
  readonly active: boolean | null;
  readonly kind: 'desktop' | 'uwp' | 'unknown';
}
export interface CuaDiscoveryQuery {
  query?: string;
  status?: 'all' | 'running' | 'installed_not_running';
  limit?: number;
}
export interface CuaDiscoveryPage {
  snapshotId: string;
  expiresAt: number;
  apps: CuaObservedApp[];
  /** Count in this bounded snapshot, never a count of all installed apps. */
  total: number;
  nextOffset: number | null;
  coverage: {
    platform: Platform;
    session: Session;
    completeness: 'unverified';
    sourceTruncated: boolean;
    snapshotTruncated: boolean;
    limitations: string[];
  };
}

type Snapshot = {
  id: string; key: string; actor: CuaDiscoveryActor; apps: CuaObservedApp[]; expiresAt: number;
  sourceTruncated: boolean; snapshotTruncated: boolean; timer?: ReturnType<typeof setTimeout>; detach: () => void;
};
type Operation = {
  key: string; abort: AbortController; driver?: CuaConnection; closing?: Promise<void>;
  finished: Promise<void>; finish(): void;
};

const MAX_SOURCE_ROWS = 5000;
const MAX_SNAPSHOT_ROWS = 2000;
const MAX_NAME = 160;
const MAX_QUERY = 128;
const MAX_PAGE_ROWS = 50;
const MAX_PAGE_BYTES = 8000;
const LINUX_SESSION_KEYS = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_RUNTIME_DIR', 'HOME', 'XDG_DATA_HOME', 'XDG_DATA_DIRS'] as const;
export const isMacBundleId = (value: unknown): value is string => typeof value === 'string' && value.length <= 255 &&
  /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+$/.test(value);
const validToken = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const current = (actor: CuaDiscoveryActor): boolean => {
  try { return !actor.lifetimeSignal?.aborted && actor.isCurrent() === true; } catch { return false; }
};
const snapshotKey = (actor: CuaDiscoveryActor): string => JSON.stringify([actor.sessionId, actor.taskId, actor.turnId]);
const safeName = (raw: string): string => {
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').trim();
  // Array.from avoids cutting a surrogate pair in half.
  return Array.from(text).slice(0, MAX_NAME).join('') || '(unnamed)';
};

function actorFromHost(actor: CuaDiscoveryActor): CuaDiscoveryActor {
  if (!actor || !validToken(actor.sessionId) || !validToken(actor.taskId) || !validToken(actor.turnId) || typeof actor.isCurrent !== 'function' ||
      (actor.lifetimeSignal !== undefined && !(actor.lifetimeSignal instanceof AbortSignal))) {
    throw new CuaAppDiscoveryError('invalid', 'A trusted desktop actor is required');
  }
  const isCurrent = actor.isCurrent.bind(actor);
  return Object.freeze({ sessionId: actor.sessionId, taskId: actor.taskId, turnId: actor.turnId,
    ...(actor.lifetimeSignal ? { lifetimeSignal: actor.lifetimeSignal } : {}), isCurrent });
}

function missingExecutable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ('code' in error && error.code === 'ENOENT') return true;
  return error instanceof AggregateError && error.errors.some(missingExecutable);
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(new Error('cancelled')); }
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void): void => {
      if (done) return; done = true; signal.removeEventListener('abort', abort); callback();
    };
    const abort = (): void => finish(() => reject(new Error('cancelled')));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

/** Host-only, bounded metadata discovery; no returned field grants action authority. */
export class CuaAppDiscovery {
  private readonly createConnection: () => CuaConnection;
  private readonly platform: Platform;
  private readonly session: Session;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly pinnedSession: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly requestTimeout: number;
  private readonly cleanupTimeout: number;
  private readonly maxSnapshots: number;
  private readonly maxConcurrent: number;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly operations = new Map<string, Operation>();
  private stopped = false;
  private closed = false;
  private cleanupFailure?: CuaAppDiscoveryError;
  private stopPromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(private readonly options: CuaAppDiscoveryOptions) {
    if (!options || (options.createConnection !== undefined && typeof options.createConnection !== 'function') ||
        (options.onCleanupError !== undefined && typeof options.onCleanupError !== 'function')) {
      throw new CuaAppDiscoveryError('invalid', 'Invalid discovery configuration');
    }
    const platform = options.platform ?? process.platform;
    if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
      throw new CuaAppDiscoveryError('unsupported_platform', 'Application discovery requires Windows, macOS or Linux');
    }
    this.platform = platform;
    const env = options.env ?? process.env;
    this.environment = env;
    this.pinnedSession = Object.fromEntries(LINUX_SESSION_KEYS.map(key => [key, env[key]]));
    const runtime = desktopRuntime(platform, env);
    this.session = runtime === 'windows' ? 'windows' : runtime === 'macos' ? 'macos'
      : runtime === 'linux-x11' && !!env.DISPLAY?.trim() ? 'x11' : runtime === 'linux-wayland' ? 'wayland' : 'unknown';
    this.now = options.now ?? Date.now;
    this.ttl = options.ttlMs ?? 30_000;
    this.requestTimeout = options.requestTimeoutMs ?? 15_000;
    this.cleanupTimeout = options.cleanupTimeoutMs ?? 10_000;
    this.maxSnapshots = options.maxSnapshots ?? 8;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    if (typeof this.now !== 'function' || !Number.isSafeInteger(this.ttl) || this.ttl < 1 || this.ttl > 60_000 ||
        !Number.isSafeInteger(this.requestTimeout) || this.requestTimeout < 20 || this.requestTimeout > 60_000 ||
        !Number.isSafeInteger(this.cleanupTimeout) || this.cleanupTimeout < 20 || this.cleanupTimeout > 30_000 ||
        !Number.isSafeInteger(this.maxSnapshots) || this.maxSnapshots < 1 || this.maxSnapshots > 32 ||
        !Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 8) {
      throw new CuaAppDiscoveryError('invalid', 'Invalid application discovery limits');
    }
    if (options.createConnection) this.createConnection = options.createConnection;
    else {
      if (!options.binary) throw new CuaAppDiscoveryError('dependency_missing', 'Prepare the pinned Cua desktop driver before listing applications');
      if (typeof options.binary !== 'string' || !path.isAbsolute(options.binary) || options.binary.includes('\0')) {
        throw new CuaAppDiscoveryError('invalid', 'The host Cua driver path must be absolute');
      }
      this.createConnection = () => new CuaTransport(options.binary!, env);
    }
  }

  async discover(actorInput: CuaDiscoveryActor, query: CuaDiscoveryQuery = {}, signal?: AbortSignal): Promise<CuaDiscoveryPage> {
    this.assertOpen();
    const actor = actorFromHost(actorInput), key = snapshotKey(actor), request = this.validateQuery(query);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new CuaAppDiscoveryError('invalid', 'A valid cancellation signal is required');
    if (!current(actor)) throw new CuaAppDiscoveryError('stale', 'The desktop actor is no longer current');
    if (signal?.aborted) throw new CuaAppDiscoveryError('cancelled', 'Application discovery was cancelled');
    this.sweep();
    if (this.operations.has(key)) throw new CuaAppDiscoveryError('busy', 'Application discovery is already running for this actor');
    if (this.operations.size >= this.maxConcurrent) throw new CuaAppDiscoveryError('capacity', 'Application discovery is busy; retry later');
    for (const item of [...this.snapshots.values()]) if (item.key === key) this.forget(item);
    if (this.snapshots.size + this.operations.size >= this.maxSnapshots) throw new CuaAppDiscoveryError('capacity', 'Application discovery snapshot capacity reached');

    let finish!: () => void;
    const op: Operation = { key, abort: new AbortController(), finished: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish() };
    this.operations.set(key, op);
    const timeout = new AbortController();
    const timeoutTimer = setTimeout(() => timeout.abort(), this.requestTimeout); timeoutTimer.unref?.();
    const actorTimer = setInterval(() => { if (!current(actor) || !this.environmentCurrent()) op.abort.abort(); }, 100); actorTimer.unref?.();
    const signals = [op.abort.signal, timeout.signal, ...(signal ? [signal] : []), ...(actor.lifetimeSignal ? [actor.lifetimeSignal] : [])];
    const combined = AbortSignal.any(signals);
    const onAbort = (): void => { if (op.driver) void this.reclaim(op).catch(() => undefined); };
    combined.addEventListener('abort', onAbort, { once: true });
    let response: unknown, failure: unknown;
    try {
      if (combined.aborted) throw new Error('cancelled');
      op.driver = this.createConnection();
      if (!op.driver || typeof op.driver.connect !== 'function' || typeof op.driver.call !== 'function' || typeof op.driver.close !== 'function') {
        throw new CuaAppDiscoveryError('invalid', 'Invalid host Cua connection');
      }
      if (combined.aborted) throw new Error('cancelled');
      await abortable(Promise.resolve().then(() => op.driver!.connect()), combined);
      if (!current(actor) || combined.aborted) throw new Error('cancelled');
      response = await abortable(Promise.resolve().then(() => op.driver!.call('list_apps', {}, combined)), combined);
      if (!current(actor) || combined.aborted) throw new Error('cancelled');
    } catch (error) { failure = error; }

    try { await this.reclaim(op); }
    catch { failure = this.cleanupFailure ?? new CuaAppDiscoveryError('cleanup_unconfirmed', 'Cua driver exit could not be confirmed'); }
    clearTimeout(timeoutTimer);
    clearInterval(actorTimer);
    combined.removeEventListener('abort', onAbort);
    this.operations.delete(key); op.finish();
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (timeout.signal.aborted) throw new CuaAppDiscoveryError('timeout', 'Application discovery timed out; check the desktop session and Cua driver');
    if (!this.environmentCurrent()) throw new CuaAppDiscoveryError('stale', 'The Linux desktop session changed; repeat application discovery');
    if (combined.aborted || !current(actor)) throw new CuaAppDiscoveryError('cancelled', 'Application discovery was cancelled');
    this.assertOpen();
    if (failure) {
      if (failure instanceof CuaAppDiscoveryError) throw failure;
      if (missingExecutable(failure)) throw new CuaAppDiscoveryError('dependency_missing', 'Cua driver or a required executable is missing; prepare the pinned driver and check system dependencies');
      throw new CuaAppDiscoveryError('driver_error', 'Cua could not list applications; check driver dependencies, session and permissions');
    }

    const result = this.project(response, request.query, request.status);
    if (!current(actor) || signal?.aborted) throw new CuaAppDiscoveryError('cancelled', 'Application discovery was cancelled');
    const id = randomUUID(), expiresAt = this.now() + this.ttl;
    const item: Snapshot = { id, key, actor, apps: result.apps, expiresAt,
      sourceTruncated: result.sourceTruncated, snapshotTruncated: result.snapshotTruncated, detach: () => {} };
    const invalidate = (): void => this.forget(item);
    const retainedSignals = [actor.lifetimeSignal, signal].filter((value): value is AbortSignal => !!value);
    for (const retained of retainedSignals) retained.addEventListener('abort', invalidate, { once: true });
    item.detach = () => { for (const retained of retainedSignals) retained.removeEventListener('abort', invalidate); };
    item.timer = setTimeout(invalidate, this.ttl); item.timer.unref?.();
    this.snapshots.set(id, item);
    if (retainedSignals.some(retained => retained.aborted) || !current(actor)) {
      this.forget(item); throw new CuaAppDiscoveryError('cancelled', 'Application discovery was cancelled');
    }
    return this.makePage(item, 0, request.limit);
  }

  page(actorInput: CuaDiscoveryActor, snapshotId: string, offset: number, limit = 25, signal?: AbortSignal): CuaDiscoveryPage {
    this.assertOpen();
    const actor = actorFromHost(actorInput);
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new CuaAppDiscoveryError('invalid', 'A valid cancellation signal is required');
    if (signal?.aborted) throw new CuaAppDiscoveryError('cancelled', 'Application discovery was cancelled');
    if (!validToken(snapshotId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_ROWS) {
      throw new CuaAppDiscoveryError('invalid', 'Invalid application discovery page');
    }
    this.sweep();
    const item = this.snapshots.get(snapshotId);
    if (!item || item.key !== snapshotKey(actor) || !current(actor) || !current(item.actor)) {
      throw new CuaAppDiscoveryError('stale', 'Application discovery snapshot is unavailable');
    }
    if (offset > item.apps.length) throw new CuaAppDiscoveryError('invalid', 'Invalid application discovery offset');
    return this.makePage(item, offset, limit);
  }

  /** Abort all driver sessions, forget snapshots, and wait for confirmed process cleanup. */
  stopAll(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    for (const item of [...this.snapshots.values()]) this.forget(item);
    const operations = [...this.operations.values()];
    for (const op of operations) op.abort.abort();
    const stopping = Promise.all(operations.map(op => op.finished)).then(() => {
      if (this.cleanupFailure) throw this.cleanupFailure;
    }).finally(() => { if (!this.closed) this.stopped = false; if (this.stopPromise === stopping) this.stopPromise = undefined; });
    this.stopPromise = stopping;
    return stopping;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.stopAll();
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.cleanupFailure) throw this.cleanupFailure;
    if (this.closed) throw new CuaAppDiscoveryError('closed', 'Application discovery is closed');
    if (this.stopped) throw new CuaAppDiscoveryError('busy', 'Application discovery is stopping');
    if (!this.environmentCurrent()) {
      for (const item of [...this.snapshots.values()]) this.forget(item);
      throw new CuaAppDiscoveryError('stale', 'The Linux desktop session changed; repeat application discovery');
    }
  }

  private environmentCurrent(): boolean {
    return this.platform !== 'linux' || LINUX_SESSION_KEYS.every(key => this.pinnedSession[key] === this.environment[key]);
  }

  private validateQuery(input: CuaDiscoveryQuery): Required<CuaDiscoveryQuery> {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > MAX_QUERY)) ||
        (input.status !== undefined && !['all', 'running', 'installed_not_running'].includes(input.status)) ||
        (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_ROWS))) {
      throw new CuaAppDiscoveryError('invalid', 'Invalid application discovery query');
    }
    return { query: (input.query ?? '').trim().normalize('NFKC').toLowerCase(), status: input.status ?? 'all', limit: input.limit ?? 25 };
  }

  private project(value: unknown, query: string, status: Required<CuaDiscoveryQuery>['status']) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CuaAppDiscoveryError('invalid_driver_response', 'Cua returned an invalid application list');
    const result = value as { isError?: unknown; structuredContent?: unknown };
    if (result.isError === true) throw new CuaAppDiscoveryError('driver_error', 'Cua could not list applications; check driver dependencies, session and permissions');
    if ((result.isError !== undefined && typeof result.isError !== 'boolean') || !result.structuredContent ||
        typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) {
      throw new CuaAppDiscoveryError('invalid_driver_response', 'Cua returned an invalid application list');
    }
    const rows = (result.structuredContent as { apps?: unknown }).apps;
    if (!Array.isArray(rows)) throw new CuaAppDiscoveryError('invalid_driver_response', 'Cua returned no structured application list');
    const apps: CuaObservedApp[] = [];
    let snapshotTruncated = false;
    for (const raw of rows.slice(0, MAX_SOURCE_ROWS)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CuaAppDiscoveryError('invalid_driver_response', 'Cua returned an invalid application record');
      const row = raw as { name?: unknown; pid?: unknown; running?: unknown; active?: unknown; kind?: unknown; bundle_id?: unknown };
      if (typeof row.name !== 'string' || row.name.length > 16_384 || typeof row.running !== 'boolean' || typeof row.active !== 'boolean' ||
          !Number.isSafeInteger(row.pid) || (row.pid as number) < 0 || (row.running ? row.pid === 0 : row.pid !== 0) || (!row.running && row.active)) {
        throw new CuaAppDiscoveryError('invalid_driver_response', 'Cua returned an invalid application record');
      }
      const name = safeName(row.name);
      if (query && !name.normalize('NFKC').toLowerCase().includes(query)) continue;
      if (status === 'running' && !row.running) continue;
      if (status === 'installed_not_running' && row.running) continue;
      if (apps.length >= MAX_SNAPSHOT_ROWS) { snapshotTruncated = true; continue; }
      apps.push(Object.freeze({ name, running: row.running, installed: row.running ? null : true,
        ...(this.platform === 'darwin' && isMacBundleId(row.bundle_id) ? { appId: row.bundle_id } : {}),
        active: this.platform === 'linux' ? null : row.active, kind: row.kind === 'desktop' || row.kind === 'uwp' ? row.kind : 'unknown' }));
    }
    apps.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), 'en') || Number(b.running) - Number(a.running));
    return { apps, sourceTruncated: rows.length > MAX_SOURCE_ROWS, snapshotTruncated };
  }

  private makePage(item: Snapshot, offset: number, limit: number): CuaDiscoveryPage {
    const platformLimits = this.platform === 'win32'
      ? ['running_from_visible_windows_and_foreground', 'installed_from_start_menu_shortcuts_and_uwp', 'running_installed_match_is_heuristic']
      : this.platform === 'darwin'
        ? ['running_user_facing_apps_only', 'installed_from_selected_application_directories', 'running_installed_match_is_heuristic']
        : ['running_from_proc_may_include_non_apps', 'installed_from_xdg_desktop_entries',
          'running_installed_match_is_heuristic', 'active_status_unavailable', ...(this.session === 'wayland' ? ['wayland_windows_depend_on_compositor'] : []),
          ...(this.session === 'unknown' ? ['desktop_display_unavailable_or_unverified'] : [])];
    const page: CuaDiscoveryPage = { snapshotId: item.id, expiresAt: item.expiresAt, apps: [], total: item.apps.length, nextOffset: null,
      coverage: { platform: this.platform, session: this.session, completeness: 'unverified', sourceTruncated: item.sourceTruncated,
        snapshotTruncated: item.snapshotTruncated, limitations: ['best_effort_source_may_silently_omit_results',
          this.platform === 'darwin' ? 'app_id_for_launch_only' : 'no_actionable_identity',
          'running_rows_installed_status_unknown', 'driver_has_no_server_pagination', 'search_uses_bounded_sanitized_names', ...platformLimits] } };
    for (const app of item.apps.slice(offset, offset + limit)) {
      const candidate = [...page.apps, app];
      if (Buffer.byteLength(JSON.stringify({ ...page, apps: candidate, nextOffset: offset + candidate.length })) > MAX_PAGE_BYTES) break;
      page.apps = candidate;
    }
    if (!page.apps.length && offset < item.apps.length) throw new CuaAppDiscoveryError('invalid_driver_response', 'An application record exceeds the page size limit');
    page.nextOffset = offset + page.apps.length < item.apps.length ? offset + page.apps.length : null;
    return page;
  }

  private reclaim(op: Operation): Promise<void> {
    if (op.closing) return op.closing;
    if (!op.driver) return Promise.resolve();
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('cleanup timeout')), this.cleanupTimeout); timer.unref?.(); });
    op.closing = Promise.race([Promise.resolve().then(() => op.driver!.close()), timeout]).catch(() => {
      this.cleanupFailure ??= new CuaAppDiscoveryError('cleanup_unconfirmed', 'Cua driver exit could not be confirmed; stop discovery and recover the host');
      try { this.options.onCleanupError?.(this.cleanupFailure); } catch { /* must remain latched */ }
      throw this.cleanupFailure;
    }).finally(() => clearTimeout(timer));
    return op.closing;
  }

  private forget(item: Snapshot): void {
    if (this.snapshots.get(item.id) !== item) return;
    this.snapshots.delete(item.id); if (item.timer) clearTimeout(item.timer); item.detach(); item.apps.length = 0;
  }
  private sweep(): void {
    const now = this.now();
    for (const item of [...this.snapshots.values()]) if (item.expiresAt <= now || !current(item.actor)) this.forget(item);
  }
}
