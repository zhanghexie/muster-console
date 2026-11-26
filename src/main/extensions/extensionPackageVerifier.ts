import fs from 'node:fs';
import path from 'node:path';
import type { ExtensionSourceLayout, ExtensionSourcePackage, ExtensionSourceScope } from './extensionSourceLayout';

export interface ExtensionPackageVerifierOptions {
  layout: ExtensionSourceLayout;
  watch?: (directory: string, listener: (event: string, filename?: string | Buffer) => void) => fs.FSWatcher;
  retryBaseMs?: number;
}

type Input = { scope: ExtensionSourceScope; extensionId: string; controlRoot?: string };
type Entry = {
  input: Input;
  package: ExtensionSourcePackage;
  dirty: boolean;
  unwatched: boolean;
  pending?: Promise<ExtensionSourcePackage>;
  watcher?: fs.FSWatcher;
  retryTimer?: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setInterval>;
  polling?: Promise<void>;
  retryMs: number;
};

function sameRoot(value?: string): string {
  const normalized = value ? path.resolve(value) : '';
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function key(input: Input): string {
  return `${input.scope}:${sameRoot(input.controlRoot)}:${input.extensionId}`;
}

/** Async package fingerprint cache for running extension instances. */
export class ExtensionRunningPackageVerifier {
  private readonly entries = new Map<string, Entry>();
  private readonly watchFactory: NonNullable<ExtensionPackageVerifierOptions['watch']>;
  private readonly retryBaseMs: number;

  constructor(private readonly options: ExtensionPackageVerifierOptions) {
    this.watchFactory = options.watch ?? ((directory, listener) => fs.watch(directory, { recursive: true, persistent: false }, (event, filename) => listener(event, filename ?? undefined)));
    this.retryBaseMs = Math.max(100, options.retryBaseMs ?? 10_000);
  }

  async verify(input: Input): Promise<ExtensionSourcePackage> {
    const id = key(input);
    let entry = this.entries.get(id);
    if (!entry) {
      const pkg = await this.options.layout.discover(input);
      entry = { input: { ...input }, package: pkg, dirty: false, unwatched: false, retryMs: this.retryBaseMs };
      this.entries.set(id, entry);
      this.attachWatch(id, entry);
      return pkg;
    }
    // A failed watcher is handled by the polling fallback. Until polling
    // observes a change, keep serving the cached package instead of turning
    // every panel call into a full package hash.
    if (!entry.dirty) return structuredClone(entry.package);
    if (entry.pending) return entry.pending;
    const pending = this.options.layout.discover(entry.input).then(pkg => {
      const current = this.entries.get(id);
      if (!current || current !== entry) return pkg;
      current.package = pkg;
      current.dirty = false;
      if (current.unwatched) {
        current.retryMs = this.retryBaseMs;
        this.attachWatch(id, current);
        current.unwatched = !current.watcher;
      }
      return pkg;
    }).catch(error => {
      if (this.entries.get(id) === entry && (error as NodeJS.ErrnoException)?.code === 'ENOENT') this.remove(id);
      throw error;
    }).finally(() => {
      const current = this.entries.get(id);
      if (current?.pending === pending) current.pending = undefined;
    });
    entry.pending = pending;
    return pending;
  }

  /** Fresh verification is required when opening/reloading/trusting a package. */
  async verifyFresh(input: Input): Promise<ExtensionSourcePackage> {
    const pkg = await this.options.layout.discover(input);
    const id = key(input);
    this.remove(id);
    const entry: Entry = { input: { ...input }, package: pkg, dirty: false, unwatched: false, retryMs: this.retryBaseMs };
    this.entries.set(id, entry);
    this.attachWatch(id, entry);
    return pkg;
  }

  seed(pkg: ExtensionSourcePackage): void {
    const input: Input = { scope: pkg.descriptor.scope, extensionId: pkg.descriptor.extensionId, ...(pkg.descriptor.controlRoot ? { controlRoot: pkg.descriptor.controlRoot } : {}) };
    const id = key(input);
    this.remove(id);
    const entry: Entry = { input, package: pkg, dirty: false, unwatched: false, retryMs: this.retryBaseMs };
    this.entries.set(id, entry);
    this.attachWatch(id, entry);
  }

  markDirty(input: Input): void { const entry = this.entries.get(key(input)); if (entry) entry.dirty = true; }

  close(): void {
    for (const id of [...this.entries.keys()]) this.remove(id);
  }

  private attachWatch(id: string, entry: Entry): void {
    if (entry.watcher || entry.retryTimer) return;
    try {
      const watcher = this.watchFactory(entry.package.descriptor.directory, (_event, filename) => {
        const relative = filename === undefined ? '' : String(filename).replaceAll('\\', '/');
        const first = relative.split('/')[0]?.toLowerCase();
        if (first && ['data', 'cache', '.git'].includes(first)) return;
        const current = this.entries.get(id);
        if (current) current.dirty = true;
      });
      entry.watcher = watcher;
      if (entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = undefined; }
      watcher.on('error', () => this.watchFailed(id, entry));
      watcher.on('close', () => { if (this.entries.get(id) === entry && entry.watcher === watcher) this.watchFailed(id, entry); });
    } catch { this.watchFailed(id, entry); }
  }

  private watchFailed(id: string, entry: Entry): void {
    if (this.entries.get(id) !== entry) return;
    try { entry.watcher?.close(); } catch { /* already closed */ }
    entry.watcher = undefined;
    entry.unwatched = true;
    this.startPolling(id, entry);
    if (entry.retryTimer) return;
    const delay = entry.retryMs;
    entry.retryMs = Math.min(300_000, delay * 2);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (this.entries.get(id) === entry) this.attachWatch(id, entry);
    }, delay);
    entry.retryTimer.unref?.();
  }

  private remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    try { entry.watcher?.close(); } catch { /* already closed */ }
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    if (entry.pollTimer) clearInterval(entry.pollTimer);
    this.entries.delete(id);
  }

  /**
   * Linux filesystems and older Node builds may reject recursive fs.watch.
   * Polling is the correctness fallback: it only marks the entry dirty when a
   * fresh async discover observes a different fingerprint; the next call still
   * performs the authoritative discover before serving the package.
   */
  private startPolling(id: string, entry: Entry): void {
    if (entry.pollTimer) return;
    const interval = Math.max(1000, this.retryBaseMs);
    entry.pollTimer = setInterval(() => {
      if (entry.polling || this.entries.get(id) !== entry) return;
      const poll = this.options.layout.discover(entry.input).then(pkg => {
        if (this.entries.get(id) !== entry) return;
        if (pkg.fingerprint !== entry.package.fingerprint) entry.dirty = true;
      }).catch(() => { /* verify() reports authoritative errors */ }).finally(() => {
        if (entry.polling === poll) entry.polling = undefined;
      });
      entry.polling = poll;
    }, interval);
    entry.pollTimer.unref?.();
  }
}

