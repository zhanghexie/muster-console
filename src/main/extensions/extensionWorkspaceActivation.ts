import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExtensionSourceScope } from './extensionSourceLayout';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';

const STORAGE_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;

export function extensionStorageRoot(userData: string): string {
  return userDataStorage(userData).resolve('app', 'extension');
}

export function extensionWorkspaceActivationPath(userData: string): string {
  return path.join(extensionStorageRoot(userData), 'workspace-activation.json');
}

/** Recover the pre-fix profile collision where the extension root was written as a file. */
export function ensureExtensionStorageRoot(userData: string): string {
  const root = extensionStorageRoot(userData);
  try {
    fs.mkdirSync(root, { recursive: true });
    return root;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(root);
    if (stat.isDirectory()) return root;
    if (stat.isSymbolicLink() || !stat.isFile()) throw error;
    const legacy = `${root}.legacy-file-${Date.now()}-${randomUUID()}`;
    fs.renameSync(root, legacy);
    fs.mkdirSync(root, { recursive: true });
    try { fs.copyFileSync(legacy, extensionWorkspaceActivationPath(userData), fs.constants.COPYFILE_EXCL); }
    catch { /* invalid or already migrated content is handled by readStored */ }
    return root;
  }
}

export interface ExtensionWorkspaceActivationKey {
  workspaceId: string;
  extensionId: string;
  scope: ExtensionSourceScope;
  controlRoot?: string;
}

export interface ExtensionWorkspaceActivationRecord extends ExtensionWorkspaceActivationKey {
  enabled: boolean;
  updatedAt: string;
}

type StoredActivation = { version: 1; records: ExtensionWorkspaceActivationRecord[] };

function normalizeRoot(value?: string): string {
  const resolved = value ? path.resolve(value) : '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function key(input: ExtensionWorkspaceActivationKey): string {
  return `${input.workspaceId}:${input.scope}:${normalizeRoot(input.controlRoot)}:${input.extensionId}`;
}

async function writeJsonAtomic(file: string, value: StoredActivation): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.extension-activation-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function validRecord(value: unknown): value is ExtensionWorkspaceActivationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.workspaceId === 'string' && !!record.workspaceId && record.workspaceId.length <= 256
    && typeof record.extensionId === 'string' && !!record.extensionId && record.extensionId.length <= 128
    && (record.scope === 'global' || record.scope === 'project')
    && (record.controlRoot === undefined || typeof record.controlRoot === 'string' && path.isAbsolute(record.controlRoot))
    && typeof record.enabled === 'boolean'
    && typeof record.updatedAt === 'string' && !!record.updatedAt;
}

function readStored(file: string): StoredActivation {
  if (!fs.existsSync(file)) return { version: STORAGE_VERSION, records: [] };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('extension workspace activation is not a regular file');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('extension workspace activation is invalid');
    const stored = parsed as Record<string, unknown>;
    if (stored.version !== STORAGE_VERSION || !Array.isArray(stored.records) || !stored.records.every(validRecord)) throw new Error('extension workspace activation is invalid');
    return { version: STORAGE_VERSION, records: stored.records as ExtensionWorkspaceActivationRecord[] };
  } catch (error) {
    const corrupt = `${file}.corrupt-${Date.now()}`;
    try { fs.renameSync(file, corrupt); } catch { /* preserve the original failure for the next explicit write */ }
    console.error('[extension] workspace activation store recovered from invalid metadata:', error);
    return { version: STORAGE_VERSION, records: [] };
  }
}

/** Profile-level, per-workspace extension activation state. */
export class ExtensionWorkspaceActivationStore {
  private readonly records = new Map<string, ExtensionWorkspaceActivationRecord>();
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {
    for (const record of readStored(file).records) this.records.set(key(record), { ...record, ...(record.controlRoot ? { controlRoot: path.resolve(record.controlRoot) } : {}) });
  }

  get(input: ExtensionWorkspaceActivationKey): ExtensionWorkspaceActivationRecord | undefined {
    const record = this.records.get(key(input));
    return record ? structuredClone(record) : undefined;
  }

  isEnabled(input: ExtensionWorkspaceActivationKey, fallback = true): boolean {
    return this.get(input)?.enabled ?? fallback;
  }

  list(workspaceId?: string): ExtensionWorkspaceActivationRecord[] {
    return [...this.records.values()]
      .filter(record => workspaceId === undefined || record.workspaceId === workspaceId)
      .map(record => structuredClone(record));
  }

  async set(input: ExtensionWorkspaceActivationKey, enabled: boolean): Promise<ExtensionWorkspaceActivationRecord> {
    if (!input.workspaceId || !input.extensionId) throw new Error('Workspace and extension are required');
    if (input.scope === 'project' && !input.controlRoot) throw new Error('Project activation requires a control root');
    const record: ExtensionWorkspaceActivationRecord = {
      workspaceId: input.workspaceId,
      extensionId: input.extensionId,
      scope: input.scope,
      ...(input.controlRoot ? { controlRoot: path.resolve(input.controlRoot) } : {}),
      enabled,
      updatedAt: new Date().toISOString()
    };
    const previous = this.records.get(key(record));
    if (previous && previous.enabled === enabled) return structuredClone(previous);
    this.records.set(key(record), record);
    await this.persist();
    return structuredClone(record);
  }

  async ensure(inputs: readonly ExtensionWorkspaceActivationKey[], enabled: boolean): Promise<void> {
    let changed = false;
    for (const input of inputs) {
      if (input.scope === 'project' && !input.controlRoot) throw new Error('Project activation requires a control root');
      const record: ExtensionWorkspaceActivationRecord = {
        workspaceId: input.workspaceId,
        extensionId: input.extensionId,
        scope: input.scope,
        ...(input.controlRoot ? { controlRoot: path.resolve(input.controlRoot) } : {}),
        enabled,
        updatedAt: new Date().toISOString()
      };
      if (this.records.has(key(record))) continue;
      this.records.set(key(record), record);
      changed = true;
    }
    if (changed) await this.persist();
  }

  async setAll(workspaceIds: readonly string[], input: Omit<ExtensionWorkspaceActivationKey, 'workspaceId'>, enabled: boolean): Promise<ExtensionWorkspaceActivationRecord[]> {
    if (input.scope === 'project' && !input.controlRoot) throw new Error('Project activation requires a control root');
    const records: ExtensionWorkspaceActivationRecord[] = [];
    const now = new Date().toISOString();
    for (const workspaceId of workspaceIds) {
      const record: ExtensionWorkspaceActivationRecord = {
        workspaceId,
        extensionId: input.extensionId,
        scope: input.scope,
        ...(input.controlRoot ? { controlRoot: path.resolve(input.controlRoot) } : {}),
        enabled,
        updatedAt: now
      };
      this.records.set(key(record), record);
      records.push(structuredClone(record));
    }
    if (records.length) await this.persist();
    return records;
  }

  private persist(): Promise<void> {
    const write = () => writeJsonAtomic(this.file, { version: STORAGE_VERSION, records: [...this.records.values()] });
    this.writes = this.writes.then(write, write);
    return this.writes;
  }
}
