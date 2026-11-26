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
  mode: 'trusted-persistent';
  trustedAt: number;
}

interface ExtensionDevelopmentTrustBook {
  schemaVersion: 1;
  entries: ExtensionDevelopmentTrustRecord[];
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

function parseBook(raw: unknown): ExtensionDevelopmentTrustBook {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { schemaVersion: 1, entries: [] };
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || !Array.isArray(value.entries)) return { schemaVersion: 1, entries: [] };
  const entries: ExtensionDevelopmentTrustRecord[] = [];
  for (const item of value.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.extensionId !== 'string' || typeof candidate.scope !== 'string' || typeof candidate.directory !== 'string' || typeof candidate.fingerprint !== 'string' || !Number.isFinite(candidate.trustedAt)) continue;
    try {
      const subject = normalizeSubject({ extensionId: candidate.extensionId, scope: candidate.scope as ExtensionDevelopmentScope, directory: candidate.directory, fingerprint: candidate.fingerprint });
      entries.push({ ...subject, mode: 'trusted-persistent', trustedAt: Math.floor(candidate.trustedAt as number) });
    } catch {
      /* Ignore corrupt entries while preserving the rest of the book. */
    }
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { schemaVersion: 1, entries };
}

/** Explicit development trust. It is a record of intent, not a runtime permission bypass. */
export class ExtensionDevelopmentTrustStore {
  private readonly once = new Set<string>();
  private readonly file: string;

  constructor(userData: string, private readonly releaseTrust?: VerifiedReleaseTrust) {
    if (typeof userData !== 'string' || !userData.trim()) throw new Error('Development trust requires userData');
    this.file = userDataStorage(path.resolve(userData)).manifestPath('extension-development-trust');
  }

  trust(subject: ExtensionDevelopmentTrustSubject, mode: ExtensionDevelopmentTrustMode): void {
    const normalized = normalizeSubject(subject);
    const subjectKey = key(normalized);
    if (mode === 'trusted-once') {
      this.once.add(subjectKey);
      return;
    }
    const book = this.read();
    const existing = book.entries.findIndex(item => persistentKey(item) === persistentKey(normalized));
    const record: ExtensionDevelopmentTrustRecord = { ...normalized, mode: 'trusted-persistent', trustedAt: Date.now() };
    if (existing >= 0) book.entries[existing] = record;
    else {
      if (book.entries.length >= MAX_ENTRIES) throw new Error('Too many development trust entries');
      book.entries.push(record);
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

  canRun(subject: ExtensionDevelopmentTrustSubject): boolean {
    return this.releaseTrust?.isVerifiedRelease(subject) === true || this.isTrusted(subject);
  }

  async ensureCanRun(subject: ExtensionDevelopmentTrustSubject): Promise<boolean> {
    return this.canRun(subject) || (await this.releaseTrust?.verifyInstalledRelease(subject)) === true;
  }

  revoke(subject: ExtensionDevelopmentTrustSubject): void {
    const normalized = normalizeSubject(subject);
    const subjectKey = key(normalized);
    this.once.delete(subjectKey);
    const book = this.read();
    const persistent = persistentKey(normalized);
    const next = book.entries.filter(item => persistentKey(item) !== persistent);
    if (next.length !== book.entries.length) this.write({ schemaVersion: 1, entries: next });
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
      return { schemaVersion: 1, entries: [] };
    }
  }

  private write(book: ExtensionDevelopmentTrustBook): void {
    writeJsonAtomicSync(this.file, book);
  }
}
