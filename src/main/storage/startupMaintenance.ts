import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { StorageMaintenanceId } from '../../shared/storageMaintenance';
import { t } from '../../shared/i18n';
import { writeJsonAtomicSync } from '../atomicJson';
import { pathKey } from '../pathKey';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { maintenanceCatalog, type MaintenanceRule } from './maintenanceCatalog';

type Request = {
  version: 1;
  profile: string;
  recipe: string;
  phase: 'queued' | 'detached' | 'failed';
  error?: string;
};

interface MaintenanceItem {
  id: StorageMaintenanceId;
  paths: string[];
  phase?: Request['phase'];
  issue?: string;
  canQueue: boolean;
}

export class StorageMaintenanceRecoveryError extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4000);
const identity = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}`;
const recipeFingerprint = (rule: MaintenanceRule) => createHash('sha256').update(JSON.stringify(rule.members)).digest('hex');

/** Remove only isolated data. An interrupted purge resumes from the remaining leaves. */
async function purgeIsolated(file: string, device: bigint, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const stat = await fs.promises.lstat(file, { bigint: true });
  if (stat.dev !== device || path.basename(file).toLowerCase() === '.muster') {
    throw new Error(t('清理范围内存在受保护的目录或挂载点。'));
  }
  if (stat.isSymbolicLink() || stat.isFile()) {
    await fs.promises.unlink(file);
    return;
  }
  if (!stat.isDirectory()) throw new Error(t('存储项目无法核验，请检查其类型和权限。'));
  const dir = await fs.promises.opendir(file);
  for await (const entry of dir) await purgeIsolated(path.join(file, entry.name), device, signal);
  await fs.promises.rmdir(file);
}

/** Recipes are compiled inside the host. A request authorizes a recipe for one physical profile. */
export class StartupStorageMaintenance {
  readonly rules: MaintenanceRule[];
  readonly directory: string;

  constructor(readonly userData: string, sessionData: string) {
    const storage = userDataStorage(userData);
    this.directory = storage.manifestPath('storage-maintenance');
    this.rules = maintenanceCatalog(userData, pathKey(userData) === pathKey(sessionData));
  }

  private profile() {
    const stat = fs.lstatSync(this.userData, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(t('无法访问工作台数据目录。'));
    if (!stat.ino) throw new Error(t('工作台数据目录的磁盘无法提供可核验的文件身份。'));
    const directory = fs.realpathSync(this.userData);
    return { key: `${pathKey(directory)}:${identity(stat)}`, directory, device: stat.dev };
  }

  /** Check directory entries themselves, including Windows reparse points, before opening them. */
  private safeEntry(file: string, kind: 'file' | 'directory', expected: string, device: bigint): fs.BigIntStats | undefined {
    const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || stat.dev !== device || (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) ||
      pathKey(fs.realpathSync(file)) !== pathKey(expected)) {
      throw new Error(t('存储项目无法核验，请检查其类型和权限。') + ` ${file}`);
    }
    return stat;
  }

  private requestPath(rule: MaintenanceRule) { return path.join(this.directory, `${rule.id}.json`); }
  private stagingPath(rule: MaintenanceRule) { return path.join(this.directory, `${rule.id}.data`); }

  private read(rule: MaintenanceRule, profile: ReturnType<StartupStorageMaintenance['profile']>): Request | undefined {
    const directory = path.join(profile.directory, path.basename(this.directory));
    if (!this.safeEntry(this.directory, 'directory', directory, profile.device)) return;
    const file = this.requestPath(rule);
    const stat = this.safeEntry(file, 'file', path.join(directory, path.basename(file)), profile.device);
    if (!stat) return;
    if (stat.size > 16_384n) throw new Error(t('重启清理记录无法核验。'));
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Request | null;
    if (value?.version !== 1 || value.profile !== profile.key || value.recipe !== recipeFingerprint(rule) ||
      !['queued', 'detached', 'failed'].includes(value.phase) || (value.error !== undefined && typeof value.error !== 'string')) {
      throw new Error(t('重启清理记录无法核验。'));
    }
    return value;
  }

  private write(rule: MaintenanceRule, profile: ReturnType<StartupStorageMaintenance['profile']>, request: Request): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = path.join(profile.directory, path.basename(this.directory));
    this.safeEntry(this.directory, 'directory', directory, profile.device);
    const file = this.requestPath(rule);
    this.safeEntry(file, 'file', path.join(directory, path.basename(file)), profile.device);
    writeJsonAtomicSync(file, request);
  }

  private members(rule: MaintenanceRule, directory: string, physical: string, device: bigint, existing?: ReadonlySet<string>): string[] {
    // Use directory entry names so Cache and cache do not alias each other on some filesystems.
    const names = existing ?? new Set(fs.readdirSync(directory));
    return rule.members.filter(member => names.has(member.name)).flatMap(member => {
      const file = path.join(directory, member.name);
      return this.safeEntry(file, member.kind, path.join(physical, member.name), device) ? [file] : [];
    });
  }

  private staging(rule: MaintenanceRule, profile: ReturnType<StartupStorageMaintenance['profile']>): string {
    const staging = this.stagingPath(rule);
    if (this.safeEntry(staging, 'directory', path.join(profile.directory, path.relative(this.userData, staging)), profile.device)) {
      const allowed = new Set(rule.members.map(member => member.name));
      if (fs.readdirSync(staging).some(name => !allowed.has(name))) throw new Error(t('重启清理记录无法核验。'));
    }
    return staging;
  }

  inspect(names: ReadonlySet<string>): MaintenanceItem[] {
    const candidates = this.rules.map(rule => ({ rule,
      paths: rule.members.filter(member => names.has(member.name)).map(member => path.join(this.userData, member.name)) }));
    let profile: ReturnType<StartupStorageMaintenance['profile']>;
    try { profile = this.profile(); }
    catch (error) {
      return candidates.filter(({ paths }) => paths.length).map(({ rule, paths }) => ({ id: rule.id, paths, issue: message(error), canQueue: false }));
    }
    return candidates.flatMap<MaintenanceItem>(({ rule, paths }) => {
      try {
        const request = this.read(rule, profile);
        const staging = this.staging(rule, profile);
        const staged = fs.existsSync(staging) && fs.readdirSync(staging).length > 0;
        if (!paths.length && !request && !staged) return [];
        this.members(rule, this.userData, profile.directory, profile.device, names);
        return [{
          id: rule.id,
          paths: staged ? [...paths, staging] : paths,
          phase: request?.phase,
          issue: request?.error,
          canQueue: !!paths.length && !staged && (!request || request.phase === 'failed')
        }];
      } catch (error) { return paths.length ? [{ id: rule.id, paths, issue: message(error), canQueue: false }] : []; }
    });
  }

  queue(id: StorageMaintenanceId): void {
    const rule = this.rules.find(rule => rule.id === id);
    if (!rule) throw new Error(t('存储项目不可用，请重新扫描。'));
    const profile = this.profile();
    const request = this.read(rule, profile);
    if (request?.phase === 'queued') return;
    const staging = this.staging(rule, profile);
    if (request?.phase === 'detached' || (fs.existsSync(staging) && fs.readdirSync(staging).length)) {
      throw new Error(t('此项目已在等待重启清理。'));
    }
    if (!this.members(rule, this.userData, profile.directory, profile.device).length) {
      throw new Error(t('存储项目已变化，请重新扫描。'));
    }
    this.write(rule, profile, { version: 1, profile: profile.key, recipe: recipeFingerprint(rule), phase: 'queued' });
  }

  private restore(staged: string[]): string[] {
    const failures: string[] = [];
    for (const file of staged.reverse()) {
      const destination = path.join(this.userData, path.basename(file));
      try {
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw new Error(t('清理目标和隔离区同时存在文件，请检查后再试。'));
        fs.renameSync(file, destination);
      } catch (error) { failures.push(`${file} · ${message(error)}`); }
    }
    return failures;
  }

  /** Run after the single-instance lock and before any profile consumers start. */
  detachQueued(): string[] {
    if (!fs.existsSync(this.directory)) return [];
    const profile = this.profile();
    const failures: string[] = [];
    for (const rule of this.rules) {
      try {
        const request = this.read(rule, profile);
        if (!request || request.phase === 'detached') continue;
        const staging = this.staging(rule, profile);
        const stagedPhysical = path.join(profile.directory, path.relative(this.userData, staging));
        const moved = fs.existsSync(staging) ? this.members(rule, staging, stagedPhysical, profile.device) : [];
        if (request.phase === 'failed') {
          const recoveryErrors = this.restore(moved);
          if (recoveryErrors.length) throw new StorageMaintenanceRecoveryError(recoveryErrors.join('\n'));
          continue;
        }
        try {
          if (!fs.existsSync(staging)) fs.mkdirSync(staging, { mode: 0o700 });
          // Staged entries from an interrupted startup still belong to this request.
          const sources = this.members(rule, this.userData, profile.directory, profile.device);
          const occupied = new Set(moved.map(file => pathKey(path.basename(file))));
          if (sources.some(file => occupied.has(pathKey(path.basename(file))))) throw new Error(t('清理目标和隔离区同时存在文件，请检查后再试。'));
          for (const source of sources) {
            const destination = path.join(staging, path.basename(source));
            fs.renameSync(source, destination);
            moved.push(destination);
          }
          this.write(rule, profile, { ...request, phase: 'detached' });
        } catch (error) {
          const recoveryErrors = this.restore(moved);
          const issue = [message(error), ...recoveryErrors].join('\n').slice(0, 4000);
          try { this.write(rule, profile, { ...request, phase: 'failed', error: issue }); }
          finally {
            if (recoveryErrors.length) throw new StorageMaintenanceRecoveryError(issue);
          }
          failures.push(`${rule.id}: ${issue}`);
        }
      } catch (error) {
        if (error instanceof StorageMaintenanceRecoveryError) throw error;
        failures.push(`${rule.id}: ${message(error)}`);
      }
    }
    return failures;
  }

  /** Background reclamation touches only paths removed from live storage before startup. */
  async purgeDetached(signal: AbortSignal): Promise<string[]> {
    if (!fs.existsSync(this.directory)) return [];
    const profile = this.profile();
    const failures: string[] = [];
    for (const rule of this.rules) {
      if (signal.aborted) break;
      try {
        const request = this.read(rule, profile);
        if (request?.phase !== 'detached') continue;
        const staging = this.staging(rule, profile);
        try {
          if (fs.existsSync(staging)) await purgeIsolated(staging, profile.device, signal);
          fs.unlinkSync(this.requestPath(rule));
        } catch (error) {
          if (signal.aborted) break;
          const detail = `${staging} · ${message(error)}`;
          this.write(rule, profile, { ...request, error: detail.slice(0, 4000) });
          failures.push(detail);
        }
      } catch (error) { failures.push(`${rule.id}: ${message(error)}`); }
    }
    return failures;
  }
}
