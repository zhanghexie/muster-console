import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXTENSION_ID_RE } from '../../shared/extensions';
import { isValidExtensionIcon } from '../../shared/extensionIcons';
import { ExtensionSourceLayout, type ExtensionSourcePackage, type ExtensionSourceScope } from './extensionSourceLayout';

const FINGERPRINT = /^package-extension:[a-f0-9]{64}$/;
const CATALOG_VERSION = 1;

export interface ExtensionPackageCatalogOptions {
  layout: ExtensionSourceLayout;
  file?: string;
  onChanged?: () => void;
}

export interface ExtensionCatalogRecord {
  scope: ExtensionSourceScope;
  extensionId: string;
  controlRoot?: string;
  name: string;
  icon?: string;
  surfaceKind: 'toolbar' | 'sidebar';
  directory: string;
  fingerprint: string;
  enabled: boolean;
  menu?: Array<{ id: string; label: string }>;
  version?: string;
  downloaded?: true;
  officialRelease?: { minHostVersion?: string };
  updatedAt: string;
}

export interface ExtensionCatalogScan {
  packages: ExtensionSourcePackage[];
  errors: Array<{ extensionId: string; error: string }>;
}

export interface ExtensionInstanceBinding {
  workspaceId: string;
  extensionId: string;
  extensionInstanceId: string;
  surfaceId: string;
  scope: ExtensionSourceScope;
  sourceRootId?: string;
  controlRoot?: string;
  packageFingerprint: string;
  directory: string;
}

type StoredCatalog = { version: 1; records: ExtensionCatalogRecord[] };

function validId(value: string): boolean {
  return EXTENSION_ID_RE.test(value) && !value.startsWith('__');
}

function catalogFile(layout: ExtensionSourceLayout, file?: string): string {
  return path.resolve(file ?? path.join(path.dirname(layout.globalRoot), 'registry.json'));
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.extension-catalog-${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function readStored(file: string): StoredCatalog {
  if (!fs.existsSync(file)) return { version: CATALOG_VERSION, records: [] };
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('extension package catalog is not a regular file');
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('extension package catalog is invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('extension package catalog is invalid');
  const record = value as Record<string, unknown>;
  if (record.version !== CATALOG_VERSION || !Array.isArray(record.records)) throw new Error('extension package catalog version is unsupported');
  const records = record.records.filter((item): item is ExtensionCatalogRecord => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const row = item as Record<string, unknown>;
    return (row.scope === 'global' || row.scope === 'project') && typeof row.extensionId === 'string' && validId(row.extensionId)
      && typeof row.name === 'string' && !!row.name.trim() && (row.surfaceKind === 'toolbar' || row.surfaceKind === 'sidebar') && (row.scope === 'global' ? row.controlRoot === undefined : typeof row.controlRoot === 'string' && path.isAbsolute(row.controlRoot)) && typeof row.directory === 'string' && path.isAbsolute(row.directory) && typeof row.fingerprint === 'string' && FINGERPRINT.test(row.fingerprint)
      && (row.icon === undefined || isValidExtensionIcon(row.icon))
      && (row.downloaded === undefined || (row.scope === 'global' && row.downloaded === true))
      && (row.officialRelease === undefined || (row.scope === 'global' && validOfficialRelease(row.officialRelease)))
      && typeof row.updatedAt === 'string' && (row.enabled === undefined || typeof row.enabled === 'boolean') && (row.version === undefined || typeof row.version === 'string')
      && (row.menu === undefined || Array.isArray(row.menu) && row.menu.every(item => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).label === 'string'));
  });
  if (records.length !== record.records.length) throw new Error('extension package catalog contains an invalid record');
  return { version: CATALOG_VERSION, records: records.map(record => ({ ...record, enabled: record.enabled !== false })) };
}

function validOfficialRelease(value: unknown): value is NonNullable<ExtensionCatalogRecord['officialRelease']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { minHostVersion } = value as Record<string, unknown>;
  return minHostVersion === undefined || typeof minHostVersion === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(minHostVersion);
}

/** File-backed extension package catalog with fingerprint-bound release provenance. */
export class ExtensionPackageCatalog {
  readonly file: string;
  readonly layout: ExtensionSourceLayout;
  private writes: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, ExtensionCatalogRecord>();
  private readonly bindings = new Map<string, ExtensionInstanceBinding>();
  private readonly projectSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly projectSyncs = new Map<string, Promise<ExtensionCatalogScan>>();
  private globalSyncTimer?: ReturnType<typeof setTimeout>;
  private globalSync?: Promise<ExtensionCatalogScan>;

  constructor(private readonly options: ExtensionPackageCatalogOptions) {
    this.layout = options.layout;
    this.file = catalogFile(options.layout, options.file);
    for (const record of readStored(this.file).records) this.records.set(this.key(record.scope, record.extensionId, record.controlRoot), record);
  }

  async scanGlobal(): Promise<ExtensionCatalogScan> {
    return this.scan({ scope: 'global' });
  }

  /** Capture valid global package bytes into the registry without copying source. */
  async syncGlobal(): Promise<ExtensionCatalogScan> {
    const scan = await this.scanGlobal();
    const discovered = new Set(scan.packages.map(pkg => pkg.descriptor.extensionId));
    let changed = false;
    for (const key of [...this.records.keys()]) {
      const [scope, ...idParts] = key.split(':');
      if (scope === 'global' && !discovered.has(idParts.at(-1) ?? '')) { this.records.delete(key); changed = true; }
    }
    for (const pkg of scan.packages) {
      const previous = this.get(pkg.descriptor.scope, pkg.descriptor.extensionId, pkg.descriptor.controlRoot);
      await this.register(pkg, false);
      changed = !previous || previous.fingerprint !== pkg.fingerprint || previous.name !== pkg.manifest.name || previous.icon !== pkg.manifest.icon || previous.version !== pkg.manifest.version || JSON.stringify(previous.menu) !== JSON.stringify(pkg.manifest.surface.menu?.map(item => ({ id: item.id, label: item.label }))) || changed;
    }
    if (changed) { await this.persist(); this.options.onChanged?.(); }
    return scan;
  }

  async scanProject(controlRoot: string): Promise<ExtensionCatalogScan> {
    return this.scan({ scope: 'project', controlRoot });
  }

  /**
   * Synchronize one project's extension source root and remove records for packages
   * that no longer exist in that project. Records from other projects remain
   * isolated by their control root.
   */
  async syncProject(controlRoot: string): Promise<ExtensionCatalogScan> {
    const normalizedRoot = path.resolve(controlRoot);
    const scan = await this.scanProject(normalizedRoot);
    const discovered = new Set(scan.packages.map(pkg => pkg.descriptor.extensionId));
    let changed = false;
    for (const [key, record] of this.records) {
      if (record.scope !== 'project' || !record.controlRoot || !samePath(record.controlRoot, normalizedRoot)) continue;
      if (!discovered.has(record.extensionId)) {
        this.records.delete(key);
        changed = true;
      }
    }
    for (const pkg of scan.packages) {
      const previous = this.get(pkg.descriptor.scope, pkg.descriptor.extensionId, pkg.descriptor.controlRoot);
      await this.register(pkg, false);
      changed = !previous || previous.fingerprint !== pkg.fingerprint || previous.name !== pkg.manifest.name || previous.icon !== pkg.manifest.icon || previous.version !== pkg.manifest.version || JSON.stringify(previous.menu) !== JSON.stringify(pkg.manifest.surface.menu?.map(item => ({ id: item.id, label: item.label }))) || changed;
    }
    if (changed) { await this.persist(); this.options.onChanged?.(); }
    return scan;
  }

  discover(input: { scope: ExtensionSourceScope; extensionId: string; controlRoot?: string }): Promise<ExtensionSourcePackage> {
    return this.options.layout.discover(input);
  }

  async register(pkg: ExtensionSourcePackage, persist = true, centerInstall?: { officialRelease?: ExtensionCatalogRecord['officialRelease'] }): Promise<ExtensionCatalogRecord> {
    if (!FINGERPRINT.test(pkg.fingerprint)) throw new Error('Invalid extension package fingerprint');
    const key = this.key(pkg.descriptor.scope, pkg.descriptor.extensionId, pkg.descriptor.controlRoot);
    const previous = this.records.get(key);
    const samePackage = previous?.fingerprint === pkg.fingerprint && samePath(previous.directory, pkg.descriptor.directory);
    const officialRelease = pkg.descriptor.scope === 'global' ? centerInstall?.officialRelease ?? (samePackage ? previous.officialRelease : undefined) : undefined;
    const downloaded = pkg.descriptor.scope === 'global' && Boolean(centerInstall || officialRelease || (samePackage && previous.downloaded));
    const record: ExtensionCatalogRecord = {
      scope: pkg.descriptor.scope,
      extensionId: pkg.descriptor.extensionId,
      ...(pkg.descriptor.controlRoot ? { controlRoot: pkg.descriptor.controlRoot } : {}),
      name: pkg.manifest.name,
      ...(pkg.manifest.icon ? { icon: pkg.manifest.icon } : {}),
      surfaceKind: pkg.manifest.surface.kind,
      directory: pkg.descriptor.directory,
      fingerprint: pkg.fingerprint,
      enabled: previous?.enabled ?? true,
      ...(pkg.manifest.surface.menu ? { menu: pkg.manifest.surface.menu.map(item => ({ id: item.id, label: item.label })) } : {}),
      ...(pkg.manifest.version ? { version: pkg.manifest.version } : {}),
      ...(downloaded ? { downloaded: true } : {}),
      ...(officialRelease ? { officialRelease } : {}),
      updatedAt: new Date().toISOString()
    };
    const changed = !previous || previous.name !== record.name || previous.icon !== record.icon || previous.surfaceKind !== record.surfaceKind || previous.directory !== record.directory || previous.fingerprint !== record.fingerprint || previous.version !== record.version || previous.enabled !== record.enabled || JSON.stringify(previous.menu) !== JSON.stringify(record.menu)
      || Boolean(previous.downloaded) !== downloaded || Boolean(previous.officialRelease) !== Boolean(officialRelease) || previous.officialRelease?.minHostVersion !== officialRelease?.minHostVersion;
    this.records.set(key, changed ? record : previous);
    if (persist && changed) { await this.persist(); this.options.onChanged?.(); }
    return structuredClone((changed ? record : previous)!);
  }

  get(scope: ExtensionSourceScope, extensionId: string, controlRoot?: string): ExtensionCatalogRecord | undefined {
    const record = this.records.get(this.key(scope, extensionId, controlRoot));
    return record ? structuredClone(record) : undefined;
  }

  list(scope?: ExtensionSourceScope): ExtensionCatalogRecord[] {
    return [...this.records.values()].filter(record => !scope || record.scope === scope).map(record => structuredClone(record));
  }

  async setEnabled(input: { scope: ExtensionSourceScope; extensionId: string; controlRoot?: string; enabled: boolean }): Promise<ExtensionCatalogRecord> {
    const key = this.key(input.scope, input.extensionId, input.controlRoot);
    const record = this.records.get(key);
    if (!record) throw new Error('extension package is not registered');
    if (record.enabled === input.enabled) return structuredClone(record);
    const next = { ...record, enabled: input.enabled };
    this.records.set(key, next);
    await this.persist();
    this.options.onChanged?.();
    return structuredClone(next);
  }

  /** Stale-while-revalidate navigation refresh; repeated calls coalesce. */
  queueProjectSync(controlRoot: string): void {
    const normalized = path.resolve(controlRoot);
    const previous = this.projectSyncTimers.get(normalized);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.projectSyncTimers.delete(normalized);
      const run = this.projectSyncs.get(normalized) ?? this.syncProject(normalized);
      this.projectSyncs.set(normalized, run);
      void run.catch(error => console.error('[extension extension] project catalog refresh failed:', error)).finally(() => {
        if (this.projectSyncs.get(normalized) === run) this.projectSyncs.delete(normalized);
      });
    }, 300);
    timer.unref?.();
    this.projectSyncTimers.set(normalized, timer);
  }

  queueGlobalSync(): void {
    if (this.globalSyncTimer) clearTimeout(this.globalSyncTimer);
    this.globalSyncTimer = setTimeout(() => {
      this.globalSyncTimer = undefined;
      const run = this.globalSync ?? this.syncGlobal();
      this.globalSync = run;
      void run.catch(error => console.error('[extension extension] global catalog refresh failed:', error)).finally(() => {
        if (this.globalSync === run) this.globalSync = undefined;
      });
    }, 300);
    this.globalSyncTimer.unref?.();
  }

  close(): void {
    for (const timer of this.projectSyncTimers.values()) clearTimeout(timer);
    this.projectSyncTimers.clear();
    if (this.globalSyncTimer) clearTimeout(this.globalSyncTimer);
    this.globalSyncTimer = undefined;
  }

  /** Bind one running workspace instance to a registered package fingerprint without copying source. */
  bindInstance(input: {
    workspaceId: string;
    extensionId: string;
    extensionInstanceId: string;
    surfaceId: string;
    scope: ExtensionSourceScope;
    sourceRootId?: string;
    controlRoot?: string;
    packageFingerprint: string;
  }): ExtensionInstanceBinding {
    if (!input.workspaceId || !input.extensionInstanceId || !input.surfaceId || !FINGERPRINT.test(input.packageFingerprint)) throw new Error('Invalid extension extension instance binding');
    const record = this.records.get(this.key(input.scope, input.extensionId, input.scope === 'project' ? input.controlRoot : undefined));
    if (!record || record.fingerprint !== input.packageFingerprint) throw new Error('extension package fingerprint is not registered');
    const binding: ExtensionInstanceBinding = { ...input, directory: record.directory };
    this.bindings.set(this.bindingKey(binding), binding);
    return structuredClone(binding);
  }

  getBinding(input: Pick<ExtensionInstanceBinding, 'workspaceId' | 'extensionId' | 'extensionInstanceId' | 'surfaceId'>): ExtensionInstanceBinding | undefined {
    const binding = this.bindings.get(this.bindingKey(input));
    return binding ? structuredClone(binding) : undefined;
  }

  unbind(input: Pick<ExtensionInstanceBinding, 'workspaceId' | 'extensionId' | 'extensionInstanceId' | 'surfaceId'>): void {
    this.bindings.delete(this.bindingKey(input));
  }

  private async scan(input: { scope: ExtensionSourceScope; controlRoot?: string }): Promise<ExtensionCatalogScan> {
    const root = input.scope === 'global'
      ? this.options.layout.globalRoot
      : path.join(path.resolve(input.controlRoot ?? ''), '.muster', 'extensions');
    try { await fs.promises.lstat(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { packages: [], errors: [] };
      throw error;
    }
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('extension extension source root must be a real directory');
    const packages: ExtensionSourcePackage[] = [];
    const errors: Array<{ extensionId: string; error: string }> = [];
    for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !validId(entry.name)) continue;
      try {
        packages.push(await this.discover({ scope: input.scope, extensionId: entry.name, ...(input.controlRoot ? { controlRoot: input.controlRoot } : {}) }));
      } catch (error) {
        errors.push({ extensionId: entry.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { packages, errors };
  }

  private persist(): Promise<void> {
    const write = () => writeJsonAtomic(this.file, { version: CATALOG_VERSION, records: [...this.records.values()] } satisfies StoredCatalog);
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  private key(scope: ExtensionSourceScope, extensionId: string, controlRoot?: string): string {
    const root = controlRoot ? path.resolve(controlRoot) : '';
    return `${scope}:${process.platform === 'win32' ? root.toLowerCase() : root}:${extensionId}`;
  }

  private bindingKey(input: Pick<ExtensionInstanceBinding, 'workspaceId' | 'extensionId' | 'extensionInstanceId' | 'surfaceId'>): string {
    return `${input.workspaceId}:${input.extensionId}:${input.extensionInstanceId}:${input.surfaceId}`;
  }
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
