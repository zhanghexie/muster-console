/**
 * Native operations are supplied by a host-owned macOS adapter, never by model
 * arguments. Each returned application/element reference is independently
 * retained and must remain alive until its matching release call. A window-list
 * snapshot owns its borrowed elements until close(). Implementations must use
 * NSRunningApplication.isEqual, CFEqual and the AX-to-CG mapping, not PID or a
 * title alone. Failure, missing permission and unsupported AX calls must throw
 * or return false rather than inventing an identity.
 *
 * Retaining an AX reference and checking it around an operation does not make a separate
 * driver's numeric window-id dispatch atomic with those checks.
 */
export interface MacWindowIdentityNative {
  accessibilityTrusted(): boolean;
  screenCaptureTrusted(): boolean;
  retainRunningApplication(pid: number): unknown | null;
  applicationTerminated(application: unknown): boolean;
  sameApplication(left: unknown, right: unknown): boolean;
  releaseApplication(application: unknown): void;
  openAxWindows(pid: number): { readonly windows: readonly unknown[]; close(): void };
  axWindowPid(window: unknown): number | null;
  axWindowId(window: unknown): number | null;
  sameAxWindow(left: unknown, right: unknown): boolean;
  retainAxWindow(window: unknown): unknown | null;
  releaseAxWindow(window: unknown): void;
  isWindowOwnedBy(pid: number, windowId: number): boolean;
}

const present = (value: unknown): boolean => value !== null && value !== undefined;
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0x7fffffff;
const validWindowId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffffffff;

function findWindow(native: MacWindowIdentityNative, pid: number, windowId: number,
  accept: (window: unknown) => void): void {
  const snapshot = native.openAxWindows(pid);
  if (!snapshot || !Array.isArray(snapshot.windows) || typeof snapshot.close !== 'function') {
    throw new Error('macOS Accessibility window snapshot is unavailable');
  }
  try {
    if (snapshot.windows.length > 1024) throw new Error('macOS Accessibility window list is too large');
    let found: unknown;
    let matched = false;
    for (const window of snapshot.windows) {
      if (!present(window)) throw new Error('Invalid macOS Accessibility window reference');
      if (native.axWindowPid(window) !== pid || native.axWindowId(window) !== windowId) continue;
      if (matched && native.sameAxWindow(found, window) !== true) throw new Error('Ambiguous macOS Accessibility window mapping');
      if (!matched) { found = window; matched = true; }
    }
    if (!matched) throw new Error('macOS Accessibility window mapping is unavailable');
    accept(found);
  } finally { snapshot.close(); }
}

/** Owns the retained process and AX window from before a screenshot. */
export class MacWindowIdentity {
  private valid = true;
  private closed = false;
  private constructor(private readonly native: MacWindowIdentityNative, readonly pid: number,
    readonly windowId: number, private readonly application: unknown, private readonly window: unknown) {}

  static acquire(native: MacWindowIdentityNative, pid: number, windowId: number): MacWindowIdentity {
    if (!native || !validPid(pid) || !validWindowId(windowId)) throw new Error('Invalid macOS window identity request');
    let application: unknown, window: unknown;
    try {
      if (native.accessibilityTrusted() !== true || native.screenCaptureTrusted() !== true) {
        throw new Error('macOS Accessibility and Screen Recording permissions are required');
      }
      if (native.isWindowOwnedBy(pid, windowId) !== true) throw new Error('macOS window owner is unavailable');
      application = native.retainRunningApplication(pid);
      if (!present(application) || native.applicationTerminated(application) !== false) {
        throw new Error('macOS running application is unavailable');
      }
      findWindow(native, pid, windowId, candidate => {
        window = native.retainAxWindow(candidate);
        if (!present(window)) throw new Error('Could not retain macOS Accessibility window');
      });
      const identity = new MacWindowIdentity(native, pid, windowId, application, window);
      if (!identity.current()) throw new Error('macOS window changed before capture');
      return identity;
    } catch (error) {
      const failures: unknown[] = [error];
      if (present(window)) try { native.releaseAxWindow(window); } catch (cleanup) { failures.push(cleanup); }
      if (present(application)) try { native.releaseApplication(application); } catch (cleanup) { failures.push(cleanup); }
      if (failures.length > 1) throw new AggregateError(failures, 'macOS window identity acquisition and cleanup failed');
      throw error;
    }
  }

  /** A failed check permanently invalidates this identity, even if access returns. */
  current(): boolean {
    if (!this.valid || this.closed) return false;
    try {
      if (this.native.accessibilityTrusted() !== true || this.native.screenCaptureTrusted() !== true ||
          this.native.applicationTerminated(this.application) !== false ||
          this.native.isWindowOwnedBy(this.pid, this.windowId) !== true) throw new Error('stale');
      this.checkApplication();
      findWindow(this.native, this.pid, this.windowId, candidate => {
        if (this.native.sameAxWindow(this.window, candidate) !== true) throw new Error('stale');
      });
      this.checkApplication();
      if (this.native.isWindowOwnedBy(this.pid, this.windowId) !== true ||
          this.native.accessibilityTrusted() !== true || this.native.screenCaptureTrusted() !== true ||
          this.native.applicationTerminated(this.application) !== false) throw new Error('stale');
      return true;
    } catch { this.valid = false; return false; }
  }

  private checkApplication(): void {
    const current = this.native.retainRunningApplication(this.pid);
    if (!present(current)) throw new Error('macOS application is unavailable');
    try {
      if (this.native.applicationTerminated(current) !== false || this.native.sameApplication(this.application, current) !== true) {
        throw new Error('macOS application changed');
      }
    } finally { this.native.releaseApplication(current); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true; this.valid = false;
    const failures: unknown[] = [];
    try { this.native.releaseAxWindow(this.window); } catch (error) { failures.push(error); }
    try { this.native.releaseApplication(this.application); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Could not release macOS window identity references');
  }
}
