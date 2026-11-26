import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { desktopRuntime } from './runtime';

/** X11 properties follow the window, not its recyclable XID. They are not a security boundary against X clients. */
export interface X11WindowPropertyApi {
  sameSession(env: NodeJS.ProcessEnv): boolean;
  read(windowId: string, property: string): string | null;
  write(windowId: string, property: string, value: string): void;
  remove(windowId: string, property: string): void;
}

export function x11WindowId(value: string): string {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,8}$/i.test(value)) throw new Error('Invalid X11 window ID');
  const id = Number.parseInt(value.slice(2), 16);
  if (!Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff) throw new Error('Invalid X11 window ID');
  return `0x${id.toString(16)}`;
}

export function assertX11Session(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  const runtime = desktopRuntime(platform, env);
  if (runtime === 'linux-wayland') throw new Error('Native Wayland window identity is unavailable; XWayland is not a substitute');
  if (runtime !== 'linux-x11' || env.XDG_SESSION_TYPE?.trim().toLowerCase() !== 'x11' || !env.DISPLAY?.trim()) {
    throw new Error('Window identity requires XDG_SESSION_TYPE=x11 and an active X11 DISPLAY');
  }
}

type Runner = (executable: string, args: string[], options: {
  env: NodeJS.ProcessEnv; encoding: 'utf8'; timeout: number; maxBuffer: number; windowsHide: true; shell: false;
}) => { status: number | null; stdout?: string | null; stderr?: string | null; error?: NodeJS.ErrnoException };

/** Isolated xprop calls avoid Xlib's process-global error handler; all arguments are fixed/validated, without a shell. */
export function createX11PropertyApi(options: {
  platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; executable?: string; timeoutMs?: number; run?: Runner;
  /** Host proof that this DISPLAY names a native X11 server, not XWayland; environment variables alone cannot establish it. */
  verifyNativeX11?: (env: Readonly<NodeJS.ProcessEnv>) => boolean;
} = {}): X11WindowPropertyApi {
  const platform = options.platform ?? process.platform;
  const sourceEnv = options.env ?? process.env;
  assertX11Session(platform, sourceEnv);
  // The eventual Cua process must use this same X11/AT-SPI session.
  const sessionKeys = ['DISPLAY', 'XAUTHORITY', 'HOME', 'XDG_SESSION_TYPE', 'WAYLAND_DISPLAY',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS'] as const;
  const pinned = Object.fromEntries(sessionKeys.map(key => [key, sourceEnv[key]]));
  const executable = options.executable ?? '/usr/bin/xprop';
  const timeout = options.timeoutMs ?? 500;
  if (!executable.startsWith('/') || executable.includes('\0')) throw new Error('xprop executable must be an absolute path');
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2000) throw new Error('Invalid xprop timeout');
  const verifyNativeX11 = options.verifyNativeX11;
  if (typeof verifyNativeX11 !== 'function') throw new Error('A trusted native X11 display proof is required; XWayland is not a substitute');
  const run: Runner = options.run ?? ((file, args, settings) => spawnSync(file, args, settings));
  const env: NodeJS.ProcessEnv = { ...sourceEnv, LC_ALL: 'C', LANG: 'C' };
  delete env.XPROPFORMATS;
  const proofEnv = Object.freeze({ ...sourceEnv });
  let invalidated = false;
  const assertSource = (): void => {
    if (invalidated) throw new Error('X11 display identity has changed; create a new adapter');
    try {
      assertX11Session(platform, sourceEnv);
      if (sessionKeys.some(key => sourceEnv[key] !== pinned[key])) throw new Error('X11 display identity has changed');
      if (verifyNativeX11(proofEnv) !== true) throw new Error('Native X11 display proof is unavailable or expired');
    } catch (error) { invalidated = true; throw error; }
  };
  assertSource();
  const call = (id: string, property: string, args: string[]): string => {
    assertSource();
    if (!/^_MUSTER_WINDOW_[0-9A-F]{32}$/.test(property)) throw new Error('Invalid X11 window property');
    const result = run(executable, ['-id', x11WindowId(id), ...args],
      { env, encoding: 'utf8', timeout, maxBuffer: 8192, windowsHide: true, shell: false });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' || result.stderr.trim()) {
      if (result.error?.code === 'ENOENT') throw new Error('xprop is unavailable; install x11-utils or configure its absolute path');
      if (result.error?.code === 'ETIMEDOUT') throw new Error('xprop timed out while checking X11 window identity');
      throw new Error('xprop could not verify X11 window identity; check the display and X11 permissions');
    }
    return result.stdout.trim();
  };
  return {
    sameSession(driverEnv) {
      try {
        assertSource();
        assertX11Session(platform, driverEnv);
        return sessionKeys.every(key => driverEnv[key] === pinned[key]);
      } catch { return false; }
    },
    read(id, property) {
      const output = call(id, property, ['-notype', '-len', '128', '-f', property, '8s', property]);
      if (output === `${property}:  not found.` || output === `${property}: not found.` || output === `${property} = not defined`) return null;
      const prefix = `${property} = "`;
      if (!output.startsWith(prefix) || !output.endsWith('"')) throw new Error('Unexpected xprop window identity response');
      const value = output.slice(prefix.length, -1);
      if (!/^[0-9a-f]{48}$/.test(value)) throw new Error('Invalid xprop window identity value');
      return value;
    },
    write(id, property, value) {
      if (!/^[0-9a-f]{48}$/.test(value)) throw new Error('Invalid X11 window generation');
      call(id, property, ['-f', property, '8s', '-set', property, value]);
    },
    remove(id, property) { call(id, property, ['-remove', property]); }
  };
}

/**
 * Share one registry across actors of a runtime. Mark BEFORE capture and verify
 * again after capture. Process ownership, capture binding and geometry need a
 * separate trusted proof: neither an XID nor this marker supplies them.
 */
export class X11WindowGeneration {
  private readonly property = `_MUSTER_WINDOW_${randomBytes(16).toString('hex').toUpperCase()}`;
  private readonly live = new Map<string, string>();
  // A timed-out write may have succeeded. Remember candidates for later cleanup.
  private readonly cleanup = new Map<string, Set<string>>();
  private closed = false;
  constructor(private readonly api: X11WindowPropertyApi) {
    if (!api || typeof api.sameSession !== 'function' || typeof api.read !== 'function' || typeof api.write !== 'function' || typeof api.remove !== 'function') {
      throw new Error('A trusted X11 property adapter is required');
    }
  }
  sameSession(env: NodeJS.ProcessEnv): boolean {
    try { return !this.closed && this.api.sameSession(env) === true; } catch { return false; }
  }
  observe(rawId: string): string {
    if (this.closed) throw new Error('X11 window identity adapter is closed');
    const id = x11WindowId(rawId), prior = this.live.get(id);
    if (prior) {
      try { if (this.api.read(id, this.property) === prior) return prior; }
      catch (error) { this.live.delete(id); throw error; }
      this.live.delete(id);
    }
    if (!this.cleanup.has(id) && this.cleanup.size >= 512) throw new Error('X11 window identity capacity reached');
    const candidates = this.cleanup.get(id) ?? new Set<string>();
    if (candidates.size >= 64) throw new Error('X11 window marker cleanup is required');
    const generation = randomBytes(24).toString('hex');
    candidates.add(generation);
    this.cleanup.set(id, candidates);
    this.api.write(id, this.property, generation);
    if (this.api.read(id, this.property) !== generation) {
      candidates.delete(generation);
      if (!candidates.size) this.cleanup.delete(id);
      throw new Error('X11 window identity marker could not be verified');
    }
    this.live.set(id, generation);
    return generation;
  }
  current(rawId: string, generation: string): boolean {
    if (this.closed) return false;
    try {
      const id = x11WindowId(rawId);
      if (this.live.get(id) !== generation || !/^[0-9a-f]{48}$/.test(generation)) return false;
      if (this.api.read(id, this.property) === generation) return true;
      this.live.delete(id);
      return false;
    } catch {
      try { this.live.delete(x11WindowId(rawId)); } catch { /* Invalid IDs cannot name a live entry. */ }
      return false;
    }
  }
  release(rawId: string, generation: string): void {
    const id = x11WindowId(rawId);
    if (this.live.get(id) !== generation) return;
    this.live.delete(id); // Never revive a proof after a failed cleanup.
    if (this.api.read(id, this.property) === generation) this.api.remove(id, this.property);
    const candidates = this.cleanup.get(id);
    candidates?.delete(generation);
    if (!candidates?.size) this.cleanup.delete(id);
  }
  close(): void {
    if (this.closed && this.cleanup.size === 0) return;
    this.closed = true;
    this.live.clear();
    const failures: unknown[] = [];
    for (const [id, candidates] of [...this.cleanup]) {
      try {
        const actual = this.api.read(id, this.property);
        if (actual && candidates.has(actual)) this.api.remove(id, this.property);
        this.cleanup.delete(id);
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Could not remove X11 window identity markers');
  }
}

export function createX11WindowGeneration(options: Parameters<typeof createX11PropertyApi>[0] = {}): X11WindowGeneration {
  return new X11WindowGeneration(createX11PropertyApi(options));
}
