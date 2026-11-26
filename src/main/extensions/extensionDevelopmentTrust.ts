import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

export type ExtensionDevelopmentTrustMode = 'trusted-once' | 'trusted-persistent';
export type ExtensionDevelopmentScope = 'global' | 'project';

export interface ExtensionDevelopmentTrustSubject {
  extensionId: string;
  scope: ExtensionDevelopmentScope;
  directory: string;
  fingerprint: string;
}

interface VerifiedReleaseTrust {
  isVerifiedRelease(subject: ExtensionDevelopmentTrustSubject): boolean;
  verifyInstalledRelease(subject: ExtensionDevelopmentTrustSubject): Promise<boolean>;
}

export interface ExtensionDevelopmentTrustRecord extends ExtensionDevelopmentTrustSubject {
  mode: 'trusted-persistent' | 'local-activation';
  trustedAt: number;
  workspaceIds?: string[];
}

interface ExtensionDevelopmentTrustBook {
  schemaVersion: 1;
  entries: ExtensionDevelopmentTrustRecord[];
  activations: ExtensionDevelopmentTrustRecord[];
}

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const FINGERPRINT = /^package-extension:[a-f0-9]{64}$/;
const MAX_ENTRIES = 512;

function normalizeSubject(subject: ExtensionDevelopmentTrustSubject): ExtensionDevelopmentTrustSubject {
    if (!ID.test(subject.extensionId)) throw new Error('Invalid development extension id');
    if (subject.scope !== 'global' && subject.scope !== 'project') throw new Error('Invalid development extension scope');
  if (typeof subject.directory !== 'string' || !subject.directory.trim() || !path.isAbsolute(subject.directory) || subject.directory.includes('\0')) {
    throw new Error('extension development extension directory must be absolute');
  }
    if (!FINGERPRINT.test(subject.fingerprint)) throw new Error('Invalid development extension fingerprint');
  return { extensionId: subject.extensionId, scope: subject.scope, directory: path.resolve(subject.directory), fingerprint: subject.fingerprint };
}

function key(subject: ExtensionDevelopmentTrustSubject): string {
  const normalized = normalizeSubject(subject);
  const directory = process.platform === 'win32' ? normalized.directory.toLowerCase() : normalized.directory;
  return JSON.stringify([normalized.extensionId, normalized.scope, directory, normalized.fingerprint]);
}

function persistentKey(subject: ExtensionDevelopmentTrustSubject): string {
  const normalized = normalizeSubject(subject);
  const directory = process.platform === 'win32' ? normalized.directory.toLowerCase() : normalized.directory;
  return JSON.stringify([normalized.extensionId, normalized.scope, directory]);
}

function parseEntries(raw: unknown, mode: ExtensionDevelopmentTrustRecord['mode']): ExtensionDevelopmentTrustRecord[] {
  if (!Array.isArray(raw)) return [];
  const entries: ExtensionDevelopmentTrustRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.extensionId !== 'string' || typeof candidate.scope !== 'string' || typeof candidate.directory !== 'string' || typeof candidate.fingerprint !== 'string' || !Number.isFinite(candidate.trustedAt)) continue;
    if (candidate.mode !== undefined && candidate.mode !== mode) continue;
    const workspaceIds = mode === 'local-activation' && Array.isArray(candidate.workspaceIds)
      ? candidate.workspaceIds.filter((id): id is string => typeof id === 'string' && id.length > 0) : undefined;
    if (mode === 'local-activation' && !workspaceIds?.length) continue;
    try {
      const subject = normalizeSubject({ extensionId: candidate.extensionId, scope: candidate.scope as ExtensionDevelopmentScope, directory: candidate.directory, fingerprint: candidate.fingerprint });
      entries.push({ ...subject, mode, trustedAt: Math.floor(candidate.trustedAt as number), ...(workspaceIds ? { workspaceIds } : {}) });
    } catch {
      /* Ignore corrupt entries while preserving the rest of the book. */
    }
    if (entries.length >= MAX_ENTRIES) break;
  }
  return entries;
}

function parseBook(raw: unknown): ExtensionDevelopmentTrustBook {
  const value = raw as Partial<ExtensionDevelopmentTrustBook> | null | undefined;
  if (value?.schemaVersion !== 1) return { schemaVersion: 1, entries: [], activations: [] };
  return { schemaVersion: 1, entries: parseEntries(value.entries, 'trusted-persistent'), activations: parseEntries(value.activations, 'local-activation') };
}

/** Runs local packages after activation and preserves explicit legacy consent. */
export class ExtensionDevelopmentTrustStore {
  private readonly once = new Set<string>();
  private readonly file: string;

  constructor(userData: string, private readonly releaseTrust?: VerifiedReleaseTrust, private readonly development = false) {
    if (typeof userData !== 'string' || !userData.trim()) throw new Error('Development trust requires userData');
    this.file = userDataStorage(path.resolve(userData)).manifestPath('extension-development-trust');
  }

  trust(subject: ExtensionDevelopmentTrustSubject, mode: ExtensionDevelopmentTrustMode): void {
    if (mode === 'trusted-once') {
      this.once.add(key(subject));
      return;
    }
    this.persistGrant(subject, mode);
  }

  authorizeActivation(subject: ExtensionDevelopmentTrustSubject, workspaceIds: readonly string[]): void {
    if (workspaceIds.length && !this.releaseTrust?.isVerifiedRelease(subject) && !this.isTrusted(subject)) {
      this.persistGrant(subject, 'local-activation', workspaceIds);
    }
  }

  private persistGrant(subject: ExtensionDevelopmentTrustSubject, mode: ExtensionDevelopmentTrustRecord['mode'], workspaceIds?: readonly string[]): void {
    const normalized = normalizeSubject(subject);
    const book = this.read();
    // Older hosts treat every item in entries as directory trust for MCP.
    const entries = mode === 'local-activation' ? book.activations : book.entries;
    const persistent = persistentKey(normalized);
    const existing = entries.findIndex(item => persistentKey(item) === persistent);
    const record: ExtensionDevelopmentTrustRecord = { ...normalized, mode, trustedAt: Date.now() };
    if (workspaceIds) {
      const previous = entries[existing];
      const earlier = this.development || previous?.fingerprint === normalized.fingerprint ? previous?.workspaceIds ?? [] : [];
      if (previous?.fingerprint === normalized.fingerprint && workspaceIds.every(id => earlier.includes(id))) return;
      record.workspaceIds = [...new Set([...earlier, ...workspaceIds])];
    }
    if (existing >= 0) entries[existing] = record;
    else {
      if (entries.length >= MAX_ENTRIES) throw new Error('Too many extension authorization entries');
      entries.push(record);
    }
    this.write(book);
  }

  isTrusted(subject: ExtensionDevelopmentTrustSubject): boolean {
    const normalized = normalizeSubject(subject);
    const subjectKey = key(normalized);
    if (this.once.has(subjectKey)) return true;
    const persistent = persistentKey(normalized);
    return this.read().entries.some(item => persistentKey(item) === persistent);
  }

  canRun(subject: ExtensionDevelopmentTrustSubject, workspaceId?: string): boolean {
    if (this.releaseTrust?.isVerifiedRelease(subject) || this.once.has(key(subject))) return true;
    const persistent = persistentKey(subject);
    const book = this.read();
    return book.entries.some(item => persistentKey(item) === persistent)
      || !!workspaceId && book.activations.some(item => item.workspaceIds?.includes(workspaceId) && persistentKey(item) === persistent
        && (this.development || item.fingerprint === subject.fingerprint));
  }

  async ensureCanRun(subject: ExtensionDevelopmentTrustSubject, workspaceId?: string): Promise<boolean> {
    return this.canRun(subject, workspaceId) || (await this.releaseTrust?.verifyInstalledRelease(subject)) === true;
  }

  revoke(subject: ExtensionDevelopmentTrustSubject): void {
    const normalized = normalizeSubject(subject);
    const subjectKey = key(normalized);
    this.once.delete(subjectKey);
    const book = this.read();
    const persistent = persistentKey(normalized);
    const next = book.entries.filter(item => persistentKey(item) !== persistent);
    if (next.length !== book.entries.length) this.write({ ...book, entries: next });
  }

  clearOnce(): void {
    this.once.clear();
  }

  listPersistent(): readonly ExtensionDevelopmentTrustRecord[] {
    return this.read().entries.map(item => ({ ...item }));
  }

  filePath(): string {
    return this.file;
  }

  private read(): ExtensionDevelopmentTrustBook {
    try {
      return parseBook(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[extension-development-trust] trust book unreadable, starting empty: ${this.file}`);
      return { schemaVersion: 1, entries: [], activations: [] };
    }
  }

  private write(book: ExtensionDevelopmentTrustBook): void {
    writeJsonAtomicSync(this.file, book);
  }
}
