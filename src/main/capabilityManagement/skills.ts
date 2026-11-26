import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathKey } from '../../shared/pathKey';
import { t } from '../../shared/i18n';
import type {
  CapabilityScope, CapabilityTargetId, CreateSkillRequest, ManagedSkill,
  ManagedSkillSource, SaveSkillRequest, SetPreferredSkillRequest,
  SkillDocument, SkillManagementSnapshot, SkillConsolidationPreview, SkillConsolidationRequest
} from '../../shared/capabilityManagement';
import type { SkillDirectory } from '../../shared/capabilityManagement';
import { MAX_SKILL_BYTES, skillMetadata } from './skillsMetadata';
import { isPiSkillTarget, piSkillRootPaths } from '../agent/piSkillRoots';
import { resolveHostSkillRootDir } from '../metaAgent/hostDomainSkills';
import { consolidateSkillPackages, pendingSkillConsolidation, skillPackageFingerprint } from './skillConsolidation';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.muster']);
const MAX_SCAN_DIRECTORIES = 2_000;
const OBSERVATION_SLICE_MS = 4;
const OBSERVATION_SLICE_STEPS = 32;
const OBSERVATION_RECONCILE_MS = 5 * 60_000;
const WATCH_RETRY_MS = 10_000;

interface PreferenceRecord { scope: CapabilityScope; name: string; skillId: string }
interface Store { version: number; revision: number; preferences: PreferenceRecord[] }
interface ScanDirectory extends SkillDirectory {}
interface ScannedDocument { metadata: ReturnType<typeof skillMetadata>; hash: string; error?: string }
interface DirectoryFacts {
  stat: fs.Stats;
  candidate?: { filePath: string; stat: fs.Stats };
  children: fs.Dirent[];
}
interface ScanContext {
  paths: Map<string, string>;
  pathErrors: Map<string, unknown>;
  documents: Map<string, ScannedDocument>;
  directories: Map<string, { value: DirectoryFacts } | { error: unknown }>;
  exists: Map<string, boolean>;
  allowedPaths: Set<string>;
}
interface ScanResult { assets: Map<string, ManagedSkill>; directories: ScanDirectory[]; errors: string[]; scannedPaths: Set<string> }
interface ObservationResult { fingerprint: string; watchPaths: Set<string>; skillDirectories: Set<string>; watchTargets: Map<string, Set<string>> }
interface ScanOptions { includeGlobal?: boolean; includeFiles?: boolean; directories?: ScanDirectory[] }
export type RuntimeSkillFilter = <T extends { filePath: string; name?: string }>(skills: T[]) => T[];
function scanContext(): ScanContext {
  return { paths: new Map(), pathErrors: new Map(), documents: new Map(), directories: new Map(), exists: new Map(), allowedPaths: new Set() };
}
function relatedPaths(a: string, b: string): boolean {
  const left = lexicalKey(a), right = lexicalKey(b);
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
function drain<T>(steps: Generator<void, T, void>): T {
  for (;;) { const next = steps.next(); if (next.done) return next.value; }
}
export interface SkillsManagementOptions {
  homeDir: string;
  userDataDir: string;
  /** No argument lists workspace scope roots; an argument resolves that workspace's source folders. */
  getProjectPaths?: (projectPath?: string) => string[];
  resolveProjectScope?: (projectPath: string) => string | undefined;
  /** Cheap topology token (no filesystem work); checked after every background yield. */
  getObservationVersion?: () => unknown;
  onChanged?: (revision: number) => void;
  onInvalidate?: () => void;
  /** Tests disable watching; production defaults to watching plus bounded polling. */
  watch?: boolean;
  pollIntervalMs?: number;
  isUsageAllowed?: (skillId: string, runtimeId: string | undefined, projectPaths: string[]) => boolean;
  preserveUsageRestrictions?: (sourceIds: string[], destinationId: string) => void;
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function lexicalKey(value: string): string {
  return pathKey(path.resolve(value));
}
function physicalPath(value: string): string {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
}
function physicalPathFailure(error: unknown): { physicalPathError?: string } {
  if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '')) return {};
  return { physicalPathError: error instanceof Error ? error.message : String(error) };
}
function physicalKey(value: string): string {
  return lexicalKey(physicalPath(value));
}
function scopeKey(scope: CapabilityScope, resolve = physicalKey): string { return scope.kind === 'global' ? 'global' : `project:${resolve(scope.projectPath)}`; }
function sameScope(a: CapabilityScope, b: CapabilityScope, resolve = physicalKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a === b || a.kind === 'global') return true;
  if (b.kind === 'project' && a.projectPath === b.projectPath) return true;
  return scopeKey(a, resolve) === scopeKey(b, resolve);
}
function assertPrivatePath(value: string, resolve = physicalKey): void {
  if (/(?:^|[\\/])\.muster(?:[\\/]|$)/i.test(path.resolve(value))) throw new Error(t('不能登记或访问 .muster 本地存储'));
  if (/(?:^|[\\/])\.muster(?:[\\/]|$)/i.test(resolve(value))) throw new Error(t('链接目标不能位于 .muster 本地存储'));
  // Destinations need not exist yet. Resolve their nearest existing parent so
  // an alias/public-skill/new-directory cannot become a writable private root.
  if (!fs.existsSync(value)) {
    let parent = path.dirname(path.resolve(value));
    for (;;) {
      try {
        const physical = fs.realpathSync.native(parent);
        if (/(?:^|[\\/])\.muster(?:[\\/]|$)/i.test(physical)) throw new Error(t('链接目标不能位于 .muster 本地存储'));
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const next = path.dirname(parent);
        if (next === parent) throw error;
        parent = next;
      }
    }
  }
}
/** Pure lexical boundary, parameterized to cover Windows and POSIX on every host. */
export function isPublicHostSkillPath(value: string, hostSkillRoot: string, paths = path): boolean {
  const relative = paths.relative(hostSkillRoot, value);
  return relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
    && !relative.split(/[\\/]/).some(part => ['.muster', 'local'].includes(part.toLowerCase()));
}
function exists(value: string): boolean { try { fs.lstatSync(value); return true; } catch { return false; } }
function samePhysical(a: string, b: string): boolean { return physicalKey(a) === physicalKey(b); }
function emptyStore(): Store { return { version: 2, revision: 0, preferences: [] }; }
function skillId(filePath: string): string { return `skill:${physicalKey(filePath)}`; }
function safeLinkName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 96 || /[\u0000-\u001f<>:"/\\|?*]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..' || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(t('技能目录名称无效：不能包含路径分隔符、系统保留字符或保留名称'));
  }
  return name;
}
function readSmallFile(filePath: string): string {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(t('SKILL.md 不是普通文件'));
  if (stat.size > MAX_SKILL_BYTES) throw new Error(t('SKILL.md 超过 1 MiB，未读取'));
  return fs.readFileSync(filePath, 'utf8');
}
function sourceFileList(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string, depth: number) => {
    if (depth > 3 || out.length >= 100) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name.toLowerCase()) || out.length >= 100) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative, depth + 1);
      else out.push(relative);
    }
  };
  try { walk(directory, '', 0); } catch { /* Discovery reports read errors separately. */ }
  return out;
}

/** One source file discovered under one of the two universal roots. */
export class SkillsManagementService {
  // The sandbox can redirect user skills without changing the installed host skill root.
  private readonly hostSkillRoot = resolveHostSkillRootDir();
  /** Only the public skill subtree is readable; its links may never escape it. */
  private publicSkillPath(value: string): boolean {
    return isPublicHostSkillPath(value, this.hostSkillRoot);
  }
  private assertAllowedPath(value: string, resolve = physicalKey, depth = 0): void {
    if (depth > 16) throw new Error(t('技能链接层级超过上限'));
    let target: string | undefined;
    try { target = fs.readlinkSync(value); } catch { /* Ordinary paths have no link target. */ }
    if (target) this.assertAllowedPath(path.resolve(path.dirname(value), target), resolve, depth + 1);
    const physical = resolve(value);
    const logicalPublic = this.publicSkillPath(value), physicalPublic = this.publicSkillPath(physical);
    if (logicalPublic && !physicalPublic) throw new Error(t('宿主公共技能链接不能离开技能目录'));
    if (logicalPublic || physicalPublic) {
      if (!logicalPublic) assertPrivatePath(value, v => v);
      return;
    }
    assertPrivatePath(value, resolve);
  }
  private store: Store;
  private storeHash: string | undefined;
  private readonly storePath: string;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly listeners = new Set<(revision: number) => void>();
  private poll?: ReturnType<typeof setTimeout>;
  private debounce?: ReturnType<typeof setTimeout>;
  private observedFingerprint = '';
  private observationRevision = 0;
  private disposed = false;
  private startupError?: string;
  private notificationErrors: string[] = [];
  private readonly documentCache = new Map<string, { version: string; value: ScannedDocument }>();
  private observationEpoch = 0;
  private backgroundScan?: Promise<void>;
  private observationPending = false;
  private observationEmit = false;
  private observedSkillDirectories = new Set<string>();
  // Discovery-only facts. Explicit lists, runtime admission and writes use fresh contexts.
  private observationContext = scanContext();
  private observationScopes = new Map<string, ScanResult>();
  private observationDirtyPaths = new Set<string>();
  private observationFull = true;
  private observationReasons = new Set<string>();
  private rewatchPaths = new Set<string>();
  private rewatchAll = false;
  private watchTargets = new Map<string, Set<string>>();
  private watchFailures = new Map<string, { message: string; attempts: number; retryAt: number }>();
  private nextReconcileAt = 0;
  private observationStats = { runs: 0, fullRuns: 0, lastDurationMs: 0, reasons: [] as string[], directories: 0 };

  constructor(private readonly options: SkillsManagementOptions) {
    this.storePath = path.join(userDataStorage(options.userDataDir).resolve('app', 'capability-management'), 'skills.json');
    assertPrivatePath(options.userDataDir);
    this.store = this.loadStore();
    if (options.watch !== false) {
      this.requestObservation(true, 'startup');
    }
  }

  subscribe(listener: (revision: number) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private loadStore(): Store {
    if (!exists(this.storePath)) { this.storeHash = undefined; return emptyStore(); }
    try {
      const raw = fs.readFileSync(this.storePath, 'utf8');
      this.storeHash = hash(raw);
      const parsed = JSON.parse(raw) as Store & { version?: number; preferences?: PreferenceRecord[] };
      if (parsed.version === 1 && Array.isArray(parsed.preferences)) {
        // Drop retired directory/binding records while retaining same-name preferences.
        return { version: 2, revision: parsed.revision, preferences: parsed.preferences };
      }
      if (parsed.version !== 2 || !Array.isArray(parsed.preferences) || !Number.isSafeInteger(parsed.revision) || parsed.revision < 0) {
        throw new Error(t('技能管理记录格式不兼容'));
      }
      for (const preference of parsed.preferences) {
        if (!preference || typeof preference.name !== 'string' || typeof preference.skillId !== 'string') throw new Error(t('技能偏好记录损坏'));
        this.normalizeScope(preference.scope);
      }
      return parsed;
    } catch (error) {
      this.startupError = t('无法读取技能管理记录：{{message}}；原文件已保留，请修复后重启', { message: (error as Error).message });
      return emptyStore();
    }
  }
  private normalizeScope(scope: CapabilityScope): CapabilityScope {
    if (scope?.kind === 'global') return { kind: 'global' };
    if (scope?.kind !== 'project' || typeof scope.projectPath !== 'string' || !path.isAbsolute(scope.projectPath)) throw new Error(t('项目作用范围无效'));
    assertPrivatePath(scope.projectPath);
    const projectPath = this.options.resolveProjectScope?.(scope.projectPath) ?? scope.projectPath;
    if (!path.isAbsolute(projectPath)) throw new Error(t('项目作用范围解析无效'));
    assertPrivatePath(projectPath);
    return { kind: 'project', projectPath: path.resolve(projectPath) };
  }
  private currentDiskHash(): string | undefined { return exists(this.storePath) ? hash(fs.readFileSync(this.storePath)) : undefined; }
  private assertStoreUnchanged(): void {
    if (this.startupError) throw new Error(this.startupError);
    if (this.currentDiskHash() !== this.storeHash) throw new Error(t('管理记录被另一进程修改，请刷新后重试'));
  }
  private persist(next: Store): void {
    this.assertStoreUnchanged();
    const parent = path.dirname(this.storePath);
    fs.mkdirSync(parent, { recursive: true });
    const raw = JSON.stringify({ ...next, revision: this.store.revision + 1 }, null, 2) + '\n';
    const temp = `${this.storePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      this.assertStoreUnchanged();
      if (exists(this.storePath)) fs.copyFileSync(this.storePath, `${this.storePath}.previous`);
      fs.renameSync(temp, this.storePath);
      this.store = JSON.parse(raw) as Store;
      this.storeHash = hash(raw);
    } finally { if (exists(temp)) fs.unlinkSync(temp); }
    this.notifyChanged();
  }
  private invalidateObservation(): void {
    this.observationEpoch++;
    this.observationFull = true;
    if (this.backgroundScan) { this.observationPending = true; this.observationEmit = true; }
  }
  topologyChanged(): void {
    if (this.disposed) return;
    this.invalidateObservation();
    this.requestObservation(true, 'topology');
  }
  private notifyChanged(invalidateObservation = true): void {
    if (invalidateObservation) this.invalidateObservation();
    this.observationRevision++;
    const notify = (callback: (() => void) | undefined): void => {
      try { callback?.(); } catch (error) {
        const message = t('技能更新通知失败：{{message}}', { message: (error as Error).message });
        if (!this.notificationErrors.includes(message)) this.notificationErrors.push(message);
      }
    };
    notify(this.options.onInvalidate);
    notify(this.options.onChanged ? () => this.options.onChanged!(this.revision) : undefined);
    for (const listener of this.listeners) notify(() => listener(this.revision));
  }
  get revision(): number { return this.store.revision + this.observationRevision; }

  private allDirectories(scope?: CapabilityScope, includeGlobal = true, resolve = physicalKey): ScanDirectory[] {
    return drain(this.directorySteps(scope, includeGlobal, resolve));
  }
  private *directorySteps(scope?: CapabilityScope, includeGlobal = true, resolve = physicalKey,
    hasPath: (value: string) => boolean = fs.existsSync,
    displayPath: (value: string) => { physicalPath?: string; physicalPathError?: string } = () => ({})): Generator<void, ScanDirectory[], void> {
    const scopes: CapabilityScope[] = includeGlobal ? [{ kind: 'global' }] : [];
    const projects = scope ? (scope.kind === 'project' ? [scope.projectPath] : []) : this.options.getProjectPaths?.() ?? [];
    for (const projectPath of projects) { scopes.push(this.normalizeScope({ kind: 'project', projectPath })); yield; }
    const directories: ScanDirectory[] = [];
    const add = (directory: ScanDirectory): void => {
      const key = resolve(directory.path);
      const prior = directories.find(item => sameScope(item.scope, directory.scope, resolve) && resolve(item.path) === key);
      if (prior) {
        return;
      } else {
        directory.id ||= `native:${scopeKey(directory.scope, resolve)}:${hash(key).slice(0, 20)}`;
        directory.exists = hasPath(directory.path);
        directories.push(directory);
      }
    };
    for (const item of scopes) {
      const roots = item.kind === 'global' ? [this.options.homeDir] : this.options.getProjectPaths?.(item.projectPath) ?? [item.projectPath];
      for (const root of roots) add({ id: '', path: path.join(root, '.agents', 'skills'), label: t('通用技能目录'), scope: item, custom: false, exists: false });
      yield;
    }
    return directories;
  }

  private scan(scope: CapabilityScope, options: ScanOptions = {}, context: ScanContext = scanContext()): ScanResult {
    return drain(this.scanSteps(scope, options, context));
  }
  private hasScanPath(value: string, context: ScanContext): boolean {
    const key = lexicalKey(value);
    if (context.exists.has(key)) return context.exists.get(key)!;
    const present = fs.existsSync(value); context.exists.set(key, present); return present;
  }
  /** Physical facts are shared, but each logical origin is still projected into sources. */
  private directoryFacts(directory: string, context: ScanContext): DirectoryFacts {
    const key = lexicalKey(directory);
    const cached = context.directories.get(key);
    if (cached) { if ('error' in cached) throw cached.error; return cached.value; }
    try {
      const stat = fs.statSync(directory);
      let candidate: DirectoryFacts['candidate'];
      if (stat.isDirectory()) {
        const file = path.join(directory, 'SKILL.md');
        let linkStat: fs.Stats | undefined;
        try { linkStat = fs.lstatSync(file); } catch { /* Same missing/inaccessible candidate semantics as existsSync. */ }
        if (linkStat) {
          let filePath = file, fileStat = linkStat;
          if (linkStat.isSymbolicLink()) {
            this.assertAllowedPath(file);
            try { filePath = fs.realpathSync.native(file); }
            catch { filePath = ''; }
            if (filePath) {
              this.assertAllowedPath(filePath, value => value);
              try { fileStat = fs.statSync(filePath); } catch { filePath = ''; }
            }
          }
          if (filePath) candidate = { filePath, stat: fileStat };
        }
      }
      const value: DirectoryFacts = { stat, candidate, children: stat.isDirectory() && !candidate ? fs.readdirSync(directory, { withFileTypes: true }) : [] };
      context.directories.set(key, { value }); return value;
    } catch (error) { context.directories.set(key, { error }); throw error; }
  }
  private *scanSteps(scope: CapabilityScope, options: ScanOptions = {}, context: ScanContext = scanContext()): Generator<void, ScanResult, void> {
    // Reuse physical resolution only within this synchronous scan/observation. A later
    // operation resolves links again, so replacing a Junction cannot keep an old identity.
    const physical = (value: string): string => {
      const key = lexicalKey(value);
      const cached = context.paths.get(key);
      if (cached !== undefined) return cached;
      let resolved: string;
      try { resolved = fs.realpathSync.native(value); context.pathErrors.delete(key); }
      catch (error) { resolved = path.resolve(value); context.pathErrors.set(key, error); }
      context.paths.set(key, resolved); return resolved;
    };
    const identityFor = (value: string): string => lexicalKey(physical(value));
    const displayPath = (value: string): { physicalPath?: string; physicalPathError?: string } => {
      const resolved = physical(value), key = lexicalKey(value);
      return context.pathErrors.has(key) ? physicalPathFailure(context.pathErrors.get(key)) : { physicalPath: resolved };
    };
    const directories = options.directories ?? (yield* this.directorySteps(scope, options.includeGlobal !== false, identityFor, value => this.hasScanPath(value, context), displayPath));
    const errors: string[] = [...this.notificationErrors, ...[...this.watchFailures.values()].map(failure => failure.message), ...(this.startupError ? [this.startupError] : [])];
    const assets = new Map<string, ManagedSkill>();
    const scannedPaths = new Set<string>();
    let visitedCount = 0;
    const service = this;
    const assertAllowed = (value: string): void => {
      const key = lexicalKey(value);
      if (context === service.observationContext && context.allowedPaths.has(key)) return;
      service.assertAllowedPath(value, identityFor);
      if (context === service.observationContext) context.allowedPaths.add(key);
    };
    for (const directory of directories) {
      yield;
      const visited = new Set<string>();
      function *walk(current: string, depth: number): Generator<void, void, void> {
        yield;
        if (depth > 8 || visitedCount >= MAX_SCAN_DIRECTORIES) {
          if (!errors.includes(t('技能目录超过扫描上限，请将深层目录单独登记'))) errors.push(t('技能目录超过扫描上限，请将深层目录单独登记'));
          return;
        }
        assertAllowed(current);
        const identity = identityFor(current);
        if (visited.has(identity)) return;
        visited.add(identity); visitedCount++; scannedPaths.add(current);
        const facts = service.directoryFacts(physical(current), context);
        if (!facts.stat.isDirectory()) return;
        const candidate = path.join(current, 'SKILL.md');
        if (facts.candidate) {
          context.paths.set(lexicalKey(candidate), facts.candidate.filePath);
          context.pathErrors.delete(lexicalKey(candidate));
          assertAllowed(candidate);
          const filePath = physical(candidate);
          const id = `skill:${lexicalKey(filePath)}`;
          const source: ManagedSkillSource = { path: candidate, directoryId: directory.id, scope: directory.scope,
            label: directory.label, managed: true };
          const prior = assets.get(id);
          if (prior) {
            prior.sources.push(source);
            if (directory.scope.kind === 'global') { prior.scope = { kind: 'global' }; prior.filePath = filePath; }
          } else {
            const document = context.documents.get(id) ?? service.scannedDocument(filePath, path.basename(current), facts.candidate.stat);
            context.documents.set(id, document);
            const { metadata, error: readError } = document;
            assets.set(id, { id, name: metadata.name, description: metadata.description, filePath,
              directoryPath: path.dirname(filePath), hash: document.hash, status: readError || metadata.error ? 'invalid' : 'valid',
              ...((readError ?? metadata.error) ? { error: readError ?? metadata.error } : {}), scope: directory.scope,
              inherited: false, hostOwned: service.publicSkillPath(filePath), sources: [source], preferred: false, files: options.includeFiles === false ? [] : sourceFileList(path.dirname(filePath)) });
          }
          // A skill's resources may contain other SKILL.md examples; they are not nested packages.
          return;
        }
        for (const entry of facts.children) {
          if (SKIP_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.skill-consolidation-') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
          try { yield* walk(path.join(current, entry.name), depth + 1); }
          catch (error) { errors.push(t('{{path}}：{{message}}', { path: path.join(current, entry.name), message: (error as Error).message })); }
        }
      }
      if (!directory.exists) continue;
      try { yield* walk(directory.path, 0); } catch (error) { errors.push(t('{{path}}：{{message}}', { path: directory.path, message: (error as Error).message })); }
    }
    return { assets, directories, errors, scannedPaths };
  }

  private scannedDocument(filePath: string, fallbackName: string, knownStat?: fs.Stats): ScannedDocument {
    const key = lexicalKey(filePath);
    try {
      const stat = knownStat ?? fs.statSync(filePath);
      if (!stat.isFile()) throw new Error(t('SKILL.md 不是普通文件'));
      if (stat.size > MAX_SKILL_BYTES) throw new Error(t('SKILL.md 超过 1 MiB，未读取'));
      const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}:${fallbackName}`;
      const cached = this.documentCache.get(key);
      if (cached?.version === version) return cached.value;
      const content = fs.readFileSync(filePath, 'utf8');
      const value = { metadata: skillMetadata(content, fallbackName), hash: hash(content) };
      if (this.documentCache.size >= MAX_SCAN_DIRECTORIES * 2) this.documentCache.delete(this.documentCache.keys().next().value!);
      this.documentCache.set(key, { version, value }); return value;
    } catch (error) {
      this.documentCache.delete(key);
      return { metadata: skillMetadata('', fallbackName), hash: hash(''), error: (error as Error).message };
    }
  }

  list(rawScope: CapabilityScope): SkillManagementSnapshot {
    const scope = this.normalizeScope(rawScope);
    const { assets, directories, errors } = this.scan(scope);
    const pending = pendingSkillConsolidation(path.join(userDataStorage(this.options.userDataDir).resolve('app', 'capability-management'), 'skill-consolidation-backups'));
    if (pending) errors.push(t('技能归并未完成，请检查恢复清单：{{path}}', { path: pending }));
    const groups = new Map<string, ManagedSkill[]>();
    for (const asset of assets.values()) {
      asset.inherited = scope.kind === 'project' && asset.scope.kind === 'global';
      groups.set(asset.name, [...groups.get(asset.name) ?? [], asset]);
    }
    const conflicts: SkillManagementSnapshot['conflicts'] = [];
    for (const [name, group] of groups) {
      if (group.length < 2) continue;
      const preferred = this.store.preferences.find(item => sameScope(item.scope, scope) && item.name === name);
      conflicts.push({ name, skillIds: group.map(asset => asset.id), preferredSkillId: preferred?.skillId });
      for (const asset of group) { asset.conflictGroup = name; asset.preferred = preferred?.skillId === asset.id; }
    }
    for (const preference of this.store.preferences.filter(item => sameScope(item.scope, scope))) {
      if (!assets.has(preference.skillId)) errors.push(t('同名技能 {{name}} 的偏好来源不可用，请重新选择；未自动替换为另一份', { name: preference.name }));
    }
    return { scope, revision: this.revision, skills: [...assets.values()].sort((a, b) => a.name.localeCompare(b.name) || a.filePath.localeCompare(b.filePath)),
      directories, conflicts, errors };
  }
  private findAsset(id: string, scope: CapabilityScope): ManagedSkill {
    const asset = this.list(scope).skills.find(item => item.id === id);
    if (!asset) throw new Error(t('技能已不在当前范围内，请刷新后重试'));
    return asset;
  }
  private assertWritable(asset: ManagedSkill, scope: CapabilityScope, allowMissing = false): void {
    if (asset.inherited || !sameScope(asset.scope, scope)) throw new Error(t('全局继承项只读，请在全局管理中修改'));
    if (asset.status === 'missing' && !allowMissing) throw new Error(t('原技能文件不可用，请恢复来源后重试'));
    assertPrivatePath(asset.filePath);
    if (skillId(asset.filePath) !== asset.id) throw new Error(t('技能源的物理身份已变化，请刷新后重试'));
  }
  readSkill(id: string, scope: CapabilityScope): SkillDocument {
    const asset = this.findAsset(id, this.normalizeScope(scope));
    this.assertAllowedPath(asset.filePath);
    if (skillId(asset.filePath) !== id) throw new Error(t('技能源的物理身份已变化，请刷新后重试'));
    const body = readSmallFile(asset.filePath);
    return { id, filePath: asset.filePath, body, hash: hash(body), files: asset.files, readOnly: asset.inherited || this.publicSkillPath(asset.filePath) };
  }
  saveSkill(input: SaveSkillRequest): SkillManagementSnapshot {
    const scope = this.normalizeScope(input.scope); const asset = this.findAsset(input.id, scope);
    this.assertWritable(asset, scope); this.assertStoreUnchanged();
    if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > MAX_SKILL_BYTES) throw new Error(t('技能内容无效或超过 1 MiB'));
    const meta = skillMetadata(input.body, asset.name);
    if (meta.error) throw new Error(meta.error);
    const previous = readSmallFile(asset.filePath);
    if (hash(previous) !== input.expectedHash) throw new Error(t('技能被外部修改，请重新读取并比较后保存'));
    if (previous === input.body) return this.list(scope);
    const backupDirectory = path.join(userDataStorage(this.options.userDataDir).resolve('app', 'capability-management'), 'skill-backups');
    fs.mkdirSync(backupDirectory, { recursive: true });
    fs.writeFileSync(path.join(backupDirectory, `${hash(asset.id).slice(0, 16)}-${Date.now()}-${hash(previous).slice(0, 8)}.md`), previous, { mode: 0o600 });
    const temp = path.join(asset.directoryPath, `.SKILL.md.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, input.body, { flag: 'wx', mode: fs.statSync(asset.filePath).mode });
      if (hash(readSmallFile(asset.filePath)) !== input.expectedHash || skillId(asset.filePath) !== input.id) throw new Error(t('保存前技能再次变动，请重新读取'));
      fs.renameSync(temp, asset.filePath);
      if (readSmallFile(asset.filePath) !== input.body) throw new Error(t('技能保存后读回不一致'));
    } finally { if (exists(temp)) fs.unlinkSync(temp); }
    this.notifyChanged(); return this.list(scope);
  }

  createSkill(input: CreateSkillRequest): SkillManagementSnapshot {
    const scope = this.normalizeScope(input.scope); const name = safeLinkName(input.name);
    const pending = pendingSkillConsolidation(path.join(userDataStorage(this.options.userDataDir).resolve('app', 'capability-management'), 'skill-consolidation-backups'));
    if (pending) throw new Error(t('技能归并未完成，请先按事务清单恢复后再创建：{{path}}', { path: pending }));
    this.assertStoreUnchanged();
    const roots = scope.kind === 'global' ? [this.options.homeDir] : this.options.getProjectPaths?.(scope.projectPath) ?? [scope.projectPath];
    const base = path.join(roots[0], '.agents', 'skills');
    assertPrivatePath(base);
    const destination = path.join(base, name); assertPrivatePath(destination);
    if (exists(destination)) throw new Error(t('同名技能目录已存在，请使用另一个名称'));
    const supplied = input.body ?? '';
    const body = /^\uFEFF?---\s*\r?\n/.test(supplied) ? supplied :
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(input.description?.trim() || t('{{name}} 技能', { name }))}\n---\n\n${supplied || `# ${name}\n\n${t('在这里编写技能说明。')}\n`}`;
    const metadata = skillMetadata(body, name);
    if (metadata.error || Buffer.byteLength(body) > MAX_SKILL_BYTES) throw new Error(metadata.error ?? t('技能内容超过 1 MiB'));
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(destination);
    let created = false;
    try {
      fs.writeFileSync(path.join(destination, 'SKILL.md'), body, { flag: 'wx', mode: 0o600 }); created = true;
      this.notifyChanged();
    } catch (error) {
      if (created && readSmallFile(path.join(destination, 'SKILL.md')) === body) fs.unlinkSync(path.join(destination, 'SKILL.md'));
      if (fs.readdirSync(destination).length === 0) fs.rmdirSync(destination);
      throw error;
    }
    return this.list(scope);
  }
  /** Preview includes every registered scope; inherited text can still be selected. */
  private consolidationPlan(rawScope: CapabilityScope, rawName: string, selectedId?: string) {
    const scope = this.normalizeScope(rawScope), name = safeLinkName(rawName);
    this.assertStoreUnchanged();
    const scopes: CapabilityScope[] = [{ kind: 'global' }, ...(this.options.getProjectPaths?.() ?? []).map(projectPath => this.normalizeScope({ kind: 'project', projectPath }))];
    if (!scopes.some(item => sameScope(item, scope))) scopes.push(scope);
    const assets = new Map<string, ManagedSkill>();
    const directories = this.allDirectories();
    for (const current of scopes) for (const skill of this.list(current).skills) {
      if (skill.name !== name) continue;
      const prior = assets.get(skill.id);
      if (prior) prior.sources = [...new Map([...prior.sources, ...skill.sources].map(source => [lexicalKey(source.path), source])).values()];
      else assets.set(skill.id, { ...skill, sources: [...skill.sources] });
    }
    if (!assets.size) throw new Error(t('技能来源已变化，请刷新后重试。'));
    const candidates = [...assets.values()].sort((a, b) => a.id.localeCompare(b.id)).map(skill => {
      skill.inherited = scope.kind === 'project' && skill.scope.kind === 'global';
      if (skill.hostOwned || skill.status !== 'valid') throw new Error(t('宿主维护、无效或缺失的技能不能归并：{{path}}', { path: skill.filePath }));
      assertPrivatePath(skill.directoryPath);
      if (directories.some(directory => samePhysical(directory.path, skill.directoryPath))) throw new Error(t('技能位于通用根目录，不能整体删除该目录：{{path}}', { path: skill.directoryPath }));
      const body = readSmallFile(skill.filePath);
      return { skill, document: { id: skill.id, filePath: skill.filePath, body, hash: hash(body), files: skill.files, readOnly: skill.inherited } };
    });
    if (selectedId && !assets.has(selectedId)) throw new Error(t('选中的技能源已变化，请重新选择。'));
    const logicalDestination = path.join(this.options.homeDir, '.agents', 'skills', name);
    assertPrivatePath(logicalDestination);
    // Resolve parent aliases (including macOS /var -> /private/var), but retain a leaf link for replacement.
    let parent = path.dirname(logicalDestination);
    while (!exists(parent)) {
      const next = path.dirname(parent);
      if (next === parent) throw new Error(t('通用技能目录的磁盘不可用，请检查路径和权限。'));
      parent = next;
    }
    const destination = path.join(fs.realpathSync.native(parent), path.relative(parent, logicalDestination));
    const packages = candidates.map(({ skill }) => ({ path: path.resolve(skill.directoryPath), fingerprint: skillPackageFingerprint(skill.directoryPath) }));
    const within = (parent: string, child: string): boolean => { const rel = path.relative(parent, child); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
    for (const item of packages) {
      if (within(item.path, destination) || within(destination, item.path) || packages.some(other => other !== item && (within(item.path, other.path) || within(other.path, item.path)))) throw new Error(t('技能源目录重叠，不能归并。'));
    }
    const destinationAlias = exists(destination) && fs.lstatSync(destination).isSymbolicLink() ? fs.readlinkSync(destination) : undefined;
    if (exists(destination) && !packages.some(item => samePhysical(item.path, destination))) throw new Error(t('通用目录已被其他内容或链接占用：{{path}}', { path: destination }));
    const links = new Map<string, string>();
    for (const item of packages) if (lexicalKey(item.path) !== lexicalKey(destination)) links.set(lexicalKey(item.path), item.path);
    for (const { skill } of candidates) for (const source of skill.sources) if (source.scope.kind === 'project') {
      for (const root of this.options.getProjectPaths?.(source.scope.projectPath) ?? [source.scope.projectPath]) {
        const link = path.join(root, '.agents', 'skills', name); assertPrivatePath(link);
        if (lexicalKey(link) === lexicalKey(destination) || links.has(lexicalKey(link))) continue;
        if (exists(link)) {
          if (!packages.some(item => samePhysical(item.path, link))) throw new Error(t('项目通用目录已被其他内容占用：{{path}}', { path: link }));
        } else links.set(lexicalKey(link), link);
      }
    }
    const linkPaths = [...links.values()].sort();
    for (const link of linkPaths) if (within(destination, link) || within(link, destination) || packages.some(item => within(item.path, link) || within(link, item.path))) throw new Error(t('技能链接与来源目录重叠。'));
    const topology = candidates.map(({ skill }) => skill.sources.map(source => [source.path, physicalKey(source.path)]));
    const fingerprint = hash(JSON.stringify({ name, selectedId, destination, destinationAlias, packages, linkPaths, topology, store: this.storeHash, roots: scopes, version: this.options.getObservationVersion?.() }));
    const preview: SkillConsolidationPreview = { scope, name, selectedId, destination, candidates, removePaths: packages.filter(item => lexicalKey(item.path) !== lexicalKey(destination) || assets.get(selectedId ?? '')?.directoryPath !== destination).map(item => item.path), linkPaths, fingerprint };
    return { preview, packages, destinationAlias };
  }
  previewConsolidation(scope: CapabilityScope, name: string, selectedId?: string): SkillConsolidationPreview {
    return this.consolidationPlan(scope, name, selectedId).preview;
  }
  consolidate(input: SkillConsolidationRequest): { snapshot: SkillManagementSnapshot; backupPath: string } {
    const { preview, packages, destinationAlias } = this.consolidationPlan(input.scope, input.name, input.skillId);
    if (!input.expectedFingerprint || preview.fingerprint !== input.expectedFingerprint) throw new Error(t('归并预览已过期，来源、附件或关联已变化，请重新预览。'));
    const selected = preview.candidates.find(item => item.skill.id === input.skillId)!;
    const ids = new Set(preview.candidates.map(item => item.skill.id));
    const filePath = path.join(preview.destination, 'SKILL.md'), id = `skill:${lexicalKey(filePath)}`;
    const next = { ...this.store, preferences: this.store.preferences.filter(item => !ids.has(item.skillId) && item.name !== input.name) };
    const backupPath = consolidateSkillPackages({ packages, destinationAlias, selectedPath: selected.skill.directoryPath, destination: preview.destination, linkPaths: preview.linkPaths,
      backupRoot: path.join(userDataStorage(this.options.userDataDir).resolve('app', 'capability-management'), 'skill-consolidation-backups'),
      validate: () => { if (this.consolidationPlan(input.scope, input.name, input.skillId).preview.fingerprint !== preview.fingerprint) throw new Error(t('归并预览已过期，请重新预览。')); },
      beforePublish: () => this.options.preserveUsageRestrictions?.([...ids], id), commit: () => this.persist(next) });
    this.observeChanges(false);
    return { snapshot: this.list(preview.scope), backupPath };
  }
  setPreferred(input: SetPreferredSkillRequest): SkillManagementSnapshot {
    const scope = this.normalizeScope(input.scope); const snapshot = this.list(scope);
    const group = snapshot.conflicts.find(item => item.name === input.name);
    if (!group || (input.skillId && !group.skillIds.includes(input.skillId))) throw new Error(t('技能差异已变化，请刷新后重新选择'));
    const preferences = this.store.preferences.filter(item => !(sameScope(item.scope, scope) && item.name === input.name));
    if (input.skillId) preferences.push({ scope, name: input.name, skillId: input.skillId });
    this.persist({ ...this.store, preferences }); return this.list(scope);
  }

  /** Host resourceLoader filtering. Unknown plugin-owned sources retain their native behavior. */
  filterRuntimeSkills<T extends { filePath: string; name?: string }>(skills: T[], target: CapabilityTargetId, projectPaths: string[]): T[] {
    const scopes: CapabilityScope[] = [{ kind: 'global' }, ...projectPaths.map(projectPath => this.normalizeScope({ kind: 'project', projectPath }))];
    return this.runtimeSkillFilter(drain(this.runtimeSkillSteps(scopes, target)), scopes, target, projectPaths)(skills);
  }

  /** Prepare synchronous SDK admission without a multi-second main-thread scan. */
  async prepareRuntimeSkillFilter(target: CapabilityTargetId, projectPaths: string[]): Promise<RuntimeSkillFilter> {
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.yieldObservation();
      if (this.disposed) throw new Error(t('技能服务已关闭，请重新打开会话'));
      const store = this.store, topology = this.observationVersion();
      const current = (): boolean => !this.disposed && store === this.store && topology === this.observationVersion();
      const scopes: CapabilityScope[] = [{ kind: 'global' }, ...projectPaths.map(projectPath => this.normalizeScope({ kind: 'project', projectPath }))];
      const result = await this.drainObservation(this.runtimeSkillSteps(scopes, target), current, current);
      if (!result || !current()) continue;
      const filter = this.runtimeSkillFilter(result.value, scopes, target, projectPaths);
      return skills => {
        if (!current()) throw new Error(t('技能配置在加载期间发生变化，请重试'));
        return filter(skills);
      };
    }
    throw new Error(t('技能配置在加载期间持续变化，请稍后重试'));
  }

  private piSkillDirectories(scope: CapabilityScope, target: CapabilityTargetId, resolve = physicalKey): ScanDirectory[] {
    const roots = scope.kind === 'global' ? piSkillRootPaths(this.options.homeDir, [])
      : (this.options.getProjectPaths?.(scope.projectPath) ?? [scope.projectPath]).map(root => path.join(root, '.agents', 'skills'));
    const hostRoots = scope.kind === 'global' && isPiSkillTarget(target) ? [this.hostSkillRoot] : [];
    return [...new Set([...roots, ...hostRoots])].map(directory => ({ id: `native:${scopeKey(scope, resolve)}:${hash(resolve(directory)).slice(0, 20)}`,
      path: directory, label: hostRoots.includes(directory) ? '~/.muster/skills' : '.agents/skills', scope, custom: false, exists: fs.existsSync(directory) }));
  }

  private *runtimeSkillSteps(scopes: CapabilityScope[], target: CapabilityTargetId): Generator<void, Map<string, ManagedSkill>, void> {
    const assets = new Map<string, ManagedSkill>();
    // Runtime policy does not consume conflict metadata or attached resource files.
    // Share physical facts for this call and scan global sources only once.
    const context = scanContext();
    for (const scope of scopes) {
      const scanned = yield* this.scanSteps(scope, { includeGlobal: scope.kind === 'global', includeFiles: false,
        directories: this.piSkillDirectories(scope, target) }, context);
      for (const asset of scanned.assets.values()) {
        const prior = assets.get(asset.id);
        if (prior) prior.sources.push(...asset.sources);
        else assets.set(asset.id, asset);
      }
    }
    return assets;
  }

  private runtimeSkillFilter(assets: Map<string, ManagedSkill>, scopes: CapabilityScope[], target: CapabilityTargetId,
    projectPaths: string[]): RuntimeSkillFilter {
    const runtimeId = target;
    return skills => {
      // Admission is synchronous inside the SDK. Resolve each directory/file once
      // per invocation, never once per candidate × directory or across reloads.
      const paths = new Map<string, string>();
      const resolve = (value: string): string => {
        const key = lexicalKey(value);
        if (!paths.has(key)) paths.set(key, physicalKey(value));
        return paths.get(key)!;
      };
      return skills.filter(skill => {
        const id = `skill:${resolve(skill.filePath)}`; const asset = assets.get(id);
        if (this.options.isUsageAllowed?.(id, runtimeId, projectPaths) === false) return false;
        if (!asset) return false;
        const applicable = this.store.preferences.filter(preference => preference.name === asset.name && scopes.some(scope => sameScope(scope, preference.scope, resolve)));
        const projectPreference = applicable.find(preference => preference.scope.kind === 'project');
        const preference = projectPreference ?? applicable.find(item => item.scope.kind === 'global');
        if (preference && preference.skillId !== id) return false;
        return asset.status === 'valid';
      });
    };
  }
  additionalSkillPaths(projectPaths: string[], target: CapabilityTargetId): string[] {
    const scopes: CapabilityScope[] = [{ kind: 'global' }, ...projectPaths.map(projectPath => this.normalizeScope({ kind: 'project', projectPath }))];
    const runtimeId = target;
    if (this.options.isUsageAllowed?.('*', runtimeId, projectPaths) === false) return [];
    return [...new Map(scopes.flatMap(scope => this.piSkillDirectories(scope, target))
      .filter(directory => directory.exists).map(directory => [physicalKey(directory.path), directory.path])).values()];
  }
  refresh(scope: CapabilityScope): SkillManagementSnapshot {
    this.invalidateObservation();
    this.documentCache.clear();
    if (this.currentDiskHash() !== this.storeHash) { this.startupError = undefined; this.store = this.loadStore(); this.notifyChanged(); }
    this.observeChanges(); return this.list(scope);
  }
  private observeChanges(emit = true): void {
    if (this.disposed) return;
    this.invalidateObservation();
    this.prepareObservation();
    try { this.publishObservation(drain(this.observationSteps()), emit); }
    catch (error) { this.publishObservationError(error, emit); }
    finally { this.scheduleObservation(); }
  }
  private observationVersion(): unknown {
    if (this.options.getObservationVersion) return this.options.getObservationVersion();
    return JSON.stringify((this.options.getProjectPaths?.() ?? []).map(projectPath => [projectPath, this.options.getProjectPaths?.(projectPath) ?? [projectPath]]));
  }
  /** At most one scan plus one coalesced request. Polls do not invalidate useful in-flight work. */
  private requestObservation(emit = true, reason = 'manual'): void {
    if (this.disposed) return;
    if (reason === 'manual' || reason === 'startup' || reason === 'reconcile') this.observationFull = true;
    this.observationReasons.add(reason);
    this.observationPending = true;
    this.observationEmit ||= emit;
    if (this.backgroundScan) return;
    const pending = this.runObservations();
    this.backgroundScan = pending;
    void pending.then(() => {
      if (this.backgroundScan === pending) this.backgroundScan = undefined;
      if (this.observationPending && !this.disposed) this.requestObservation(this.observationEmit, 'coalesced');
      else this.scheduleObservation();
    }, error => {
      if (this.backgroundScan === pending) this.backgroundScan = undefined;
      if (!this.disposed) this.publishObservationError(error, emit);
      this.scheduleObservation();
    });
  }
  private yieldObservation(background = false): Promise<void> {
    // A setImmediate chain only yields ownership; it can still saturate a core.
    return new Promise(resolve => background ? setTimeout(resolve, 8) : setImmediate(resolve));
  }
  private async drainObservation<T>(steps: Generator<void, T, void>, current: () => boolean,
    topologyCurrent: () => boolean, background = false): Promise<{ value: T } | null> {
    let started = performance.now(), count = 0;
    let finished = false;
    try {
      while (current()) {
        const next = steps.next();
        if (next.done) { finished = true; return topologyCurrent() ? { value: next.value } : null; }
        if (++count >= OBSERVATION_SLICE_STEPS || performance.now() - started >= OBSERVATION_SLICE_MS) {
          // Cheap cached steps only need a turn; spend the rest budget when actual work
          // consumed the slice, so incremental updates do not sleep once per cached row.
          await this.yieldObservation(background && performance.now() - started >= OBSERVATION_SLICE_MS);
          if (!topologyCurrent()) return null;
          started = performance.now(); count = 0;
        }
      }
      return null;
    } finally { if (!finished) steps.return(undefined as T); }
  }
  private async runObservations(): Promise<void> {
    // Do not run the first slice inside construction, mutation notifications or watcher callbacks.
    await this.yieldObservation(true);
    while (this.observationPending && !this.disposed) {
      const emit = this.observationEmit;
      this.observationPending = false; this.observationEmit = false;
      const epoch = this.observationEpoch, store = this.store;
      let version: unknown;
      const current = (): boolean => !this.disposed && epoch === this.observationEpoch && store === this.store;
      const topologyCurrent = (): boolean => current() && this.observationVersion() === version;
      const started = performance.now();
      const full = this.prepareObservation();
      const reasons = [...this.observationReasons]; this.observationReasons.clear();
      try {
        version = this.observationVersion();
        const result = await this.drainObservation(this.observationSteps(), current, topologyCurrent, true);
        if (!result || !topologyCurrent()) {
          this.observationFull = true;
          if (!this.disposed) { this.observationPending = true; this.observationEmit ||= emit; }
          continue;
        }
        this.publishObservation(result.value, emit, false);
        if (this.options.watch !== false) {
          const watched = await this.drainObservation(this.watcherSteps(result.value.watchPaths), current, topologyCurrent, true);
          if (!watched && !this.disposed) { this.observationFull = true; this.observationPending = true; this.observationEmit ||= emit; }
        }
        this.observationStats = { runs: this.observationStats.runs + 1, fullRuns: this.observationStats.fullRuns + Number(full),
          lastDurationMs: performance.now() - started, reasons, directories: this.observationContext.directories.size };
        if (full) this.nextReconcileAt = Date.now() + (this.options.pollIntervalMs ?? Math.max(OBSERVATION_RECONCILE_MS, this.observationStats.lastDurationMs * 20));
      } catch (error) {
        this.observationFull = true;
        if (current()) this.publishObservationError(error, emit);
        else if (!this.disposed) { this.observationPending = true; this.observationEmit ||= emit; }
      }
      // A coalesced poll is a fresh iteration, with an event-loop turn in between.
      if (this.observationPending && !this.disposed) await this.yieldObservation(true);
    }
  }
  private scheduleObservation(): void {
    if (this.poll) clearTimeout(this.poll);
    if (this.disposed || this.options.watch === false) return;
    const now = Date.now();
    if (!this.nextReconcileAt) this.nextReconcileAt = now + (this.options.pollIntervalMs ?? OBSERVATION_RECONCILE_MS);
    const due = Math.min(this.nextReconcileAt, ...[...this.watchFailures.values()].map(failure => failure.retryAt));
    this.poll = setTimeout(() => {
      this.poll = undefined;
      if (this.backgroundScan) return; // Completion reschedules; never enqueue perpetual timer reruns.
      if (Date.now() >= this.nextReconcileAt) this.requestObservation(true, 'reconcile');
      else {
        for (const [watched, failure] of this.watchFailures) if (failure.retryAt <= Date.now()) this.observationDirtyPaths.add(watched);
        this.requestObservation(true, 'watch-retry');
      }
    }, Math.max(1, due - now));
    this.poll.unref();
  }
  private prepareObservation(): boolean {
    if (this.observationFull) {
      this.observationContext = scanContext(); this.observationScopes.clear();
      this.observationDirtyPaths.clear(); this.observationFull = false;
      this.rewatchAll = true;
      return true;
    }
    const dirty = [...this.observationDirtyPaths]; this.observationDirtyPaths.clear();
    const context = this.observationContext;
    // Project events both ways through old aliases before removing mappings. A physical
    // SKILL.md target changing must invalidate its logical package's cached lstat too.
    const aliases: string[] = [];
    for (const [logical, target] of context.paths) for (const changed of dirty) {
      const changedKey = lexicalKey(changed), targetKey = lexicalKey(target);
      if (relatedPaths(logical, changed)) aliases.push(changedKey.startsWith(`${logical}/`) ? path.join(target, path.relative(logical, changedKey)) : target);
      if (relatedPaths(target, changed)) aliases.push(changedKey.startsWith(`${targetKey}/`) ? path.join(logical, path.relative(targetKey, changedKey)) : logical);
    }
    const affected = [...new Set([...dirty, ...aliases])];
    const touches = (value: string): boolean => affected.some(target => relatedPaths(value, target));
    for (const [key, result] of this.observationScopes) {
      if (result.directories.some(directory => touches(directory.path)) || [...result.scannedPaths].some(touches) ||
        [...result.assets.values()].some(asset => touches(asset.filePath))) this.observationScopes.delete(key);
    }
    for (const [logical, target] of context.paths) if (touches(logical) || touches(target)) { context.paths.delete(logical); context.pathErrors.delete(logical); }
    for (const directory of context.directories.keys()) if (touches(directory)) context.directories.delete(directory);
    for (const value of context.exists.keys()) if (touches(value)) context.exists.delete(value);
    for (const value of context.allowedPaths) if (touches(value)) context.allowedPaths.delete(value);
    for (const id of context.documents.keys()) if (touches(id.slice('skill:'.length))) context.documents.delete(id);
    for (const value of this.documentCache.keys()) if (touches(value)) this.documentCache.delete(value);
    return false;
  }
  private *observationSteps(): Generator<void, ObservationResult, void> {
    const scopes: CapabilityScope[] = [{ kind: 'global' }, ...(this.options.getProjectPaths?.() ?? []).map(projectPath => ({ kind: 'project' as const, projectPath }))];
    const signature: string[] = []; const watchPaths = new Set<string>();
    const skillDirectories = new Set<string>();
    const watchTargets = new Map<string, Set<string>>();
    const context = this.observationContext;
    const watch = (watched: string, target = watched): void => {
      const targets = watchTargets.get(watched) ?? new Set<string>();
      targets.add(target); watchTargets.set(watched, targets); watchPaths.add(watched);
    };
      for (const scope of scopes) {
        // A project's public inventory inherits global items; the observer already
        // scanned them once. Resource lists are only needed by inventory/detail reads.
        const key = scope.kind === 'global' ? 'global' : lexicalKey(scope.projectPath);
        let scanned = this.observationScopes.get(key);
        if (!scanned) {
          scanned = yield* this.scanSteps(scope, { includeGlobal: scope.kind === 'global', includeFiles: false }, context);
          this.observationScopes.set(key, scanned);
        }
        for (const asset of scanned.assets.values()) {
          signature.push(`${asset.id}:${asset.hash}:${asset.status}:${asset.sources.map(source => source.path).join('|')}`);
          for (const source of asset.sources) skillDirectories.add(lexicalKey(path.dirname(source.path)));
          // A directory alias watcher already follows its physical package. Only a file
          // link outside that SKILL.md location needs another target-file dependency.
          const regularFile = asset.sources.some(source => {
            const parent = context.paths.get(lexicalKey(path.dirname(source.path))) ?? path.dirname(source.path);
            return lexicalKey(path.join(parent, 'SKILL.md')) === lexicalKey(asset.filePath);
          });
          if (asset.status !== 'missing' && !regularFile) watch(path.dirname(asset.filePath), asset.filePath);
        }
        signature.push(...scanned.errors);
        for (const directory of scanned.directories) {
          signature.push(`${directory.id}:${directory.path}`);
          const paths = [directory.path];
          for (const [index, root] of paths.entries()) {
            // One watcher follows the shared inode; every alias parent detects link replacement.
            if (index === 0) {
              let current = root;
              while (!this.hasScanPath(current, context) && path.dirname(current) !== current) { current = path.dirname(current); yield; }
              if (this.hasScanPath(current, context)) watch(current, root);
            }
            let parent = path.dirname(root);
            while (!this.hasScanPath(parent, context) && path.dirname(parent) !== parent) { parent = path.dirname(parent); yield; }
            if (this.hasScanPath(parent, context)) watch(parent, root);
            yield;
          }
        }
        for (const current of scanned.scannedPaths) watch(current);
      }
    signature.push(...[...this.watchFailures.values()].map(failure => failure.message));
    return { fingerprint: hash(signature.sort().join('\n')), watchPaths, skillDirectories, watchTargets };
  }
  private publishObservation(result: ObservationResult, emit: boolean, updateWatchers = true): void {
    const changed = result.fingerprint !== this.observedFingerprint;
    this.observedFingerprint = result.fingerprint;
    this.observedSkillDirectories = result.skillDirectories;
    this.watchTargets = result.watchTargets;
    // The initial background discovery also invalidates consumers that loaded before it completed.
    if (changed && emit) this.notifyChanged(false);
    if (updateWatchers && this.options.watch !== false) drain(this.watcherSteps(result.watchPaths));
  }
  private publishObservationError(error: unknown, emit: boolean): void {
      const fingerprint = `error:${(error as Error).message}`;
      const message = t('技能目录监视检查失败：{{message}}', { message: (error as Error).message });
      if (!this.notificationErrors.includes(message)) this.notificationErrors.push(message);
      if (this.observedFingerprint !== fingerprint && emit) this.notifyChanged(false);
      this.observedFingerprint = fingerprint;
  }
  private *watcherSteps(paths: Set<string>): Generator<void, void, void> {
    for (const [watched, watcher] of this.watchers) {
      const key = lexicalKey(watched);
      if (!paths.has(watched) || this.rewatchAll || [...this.rewatchPaths].some(value => key === lexicalKey(value) || key.startsWith(`${lexicalKey(value)}/`))) {
        watcher.close(); this.watchers.delete(watched);
      }
      yield;
    }
    this.rewatchPaths.clear(); this.rewatchAll = false;
    for (const watched of this.watchFailures.keys()) if (!paths.has(watched)) this.watchFailures.delete(watched);
    for (const watched of paths) {
      yield;
      if (this.watchers.has(watched)) continue;
      if ((this.watchFailures.get(watched)?.retryAt ?? 0) > Date.now()) continue;
      try {
        const watcher = fs.watch(watched, { persistent: false }, (event, filename) => {
          if (this.watchers.get(watched) === watcher) this.receiveWatch(watched, event, filename);
        });
        watcher.on('error', error => {
          if (this.watchers.get(watched) !== watcher) return;
          watcher.close(); this.watchers.delete(watched); this.watchFailed(watched, error);
          this.scheduleObservation();
        });
        this.watchers.set(watched, watcher);
        if (this.watchFailures.delete(watched)) this.notifyChanged(false);
      } catch (error) { this.watchFailed(watched, error); }
    }
  }
  private watchFailed(watched: string, error: unknown): void {
    const prior = this.watchFailures.get(watched), attempts = (prior?.attempts ?? 0) + 1;
    const message = t('技能目录监视检查失败：{{message}}', { message: `${watched}: ${(error as Error).message}` });
    this.watchFailures.set(watched, { message, attempts, retryAt: Date.now() + Math.min(OBSERVATION_RECONCILE_MS, WATCH_RETRY_MS * 2 ** Math.min(attempts - 1, 5)) });
    if (prior?.message !== message) {
      console.warn('[skills] directory watch failed; retrying with backoff', watched, error);
      this.notifyChanged(false);
    }
  }
  private receiveWatch(watched: string, event: string, filename: string | Buffer | null): void {
    if (this.disposed) return;
    const name = filename == null ? '' : String(filename);
    if (name.split(/[\\/]/).some(part => SKIP_DIRS.has(part.toLowerCase()) || part.startsWith('.skill-consolidation-'))) return;
    const changed = name ? path.resolve(watched, name) : watched;
    const targets = this.watchTargets.get(watched);
    if (name && targets && ![...targets].some(target => relatedPaths(target, changed))) return;
    const documentChanged = !name || path.basename(name).toLowerCase() === 'skill.md';
    const packageDirectory = this.observedSkillDirectories.has(lexicalKey(watched));
    const directDirectory = targets?.has(watched);
    const targetFile = changed !== watched && targets?.has(changed);
    if (name && !documentChanged && packageDirectory && !targetFile) return;
    if (name && !documentChanged && directDirectory && !targetFile) {
      // Structural directories only care about directory/link entries, including deleted ones.
      const knownDirectory = this.watchTargets.has(changed);
      if (event === 'change' && knownDirectory && this.observedSkillDirectories.has(lexicalKey(changed)) && this.watchers.has(changed)) return;
      if (!knownDirectory) {
        try { const stat = fs.lstatSync(changed); if (!stat.isDirectory() && !stat.isSymbolicLink()) return; }
        catch { return; }
      }
    }
    if (this.observationDirtyPaths.size < 256) this.observationDirtyPaths.add(changed);
    else { this.observationFull = true; this.observationDirtyPaths.clear(); }
    if (event === 'rename' && !this.rewatchAll) {
      if (this.rewatchPaths.size < 256) this.rewatchPaths.add(changed);
      else { this.rewatchAll = true; this.rewatchPaths.clear(); }
    }
    if (this.backgroundScan) { this.observationPending = true; this.observationEmit = true; }
    if (!this.debounce) {
      this.debounce = setTimeout(() => { this.debounce = undefined; this.requestObservation(true, 'watch'); }, 100);
      this.debounce.unref();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.observationEpoch++;
    this.observationPending = false; this.observationEmit = false;
    if (this.poll) clearTimeout(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear(); this.listeners.clear();
    this.documentCache.clear();
    this.observedSkillDirectories.clear();
    this.watchTargets.clear(); this.watchFailures.clear();
    this.rewatchPaths.clear();
    this.observationScopes.clear(); this.observationDirtyPaths.clear(); this.observationContext = scanContext();
  }
}
