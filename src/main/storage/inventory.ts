import { safeScopedKey, userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { SessionMeta } from '../../shared/types';
import type { AppSnapshot } from '../../shared/agentApps';
import type { ThemeMetaInfo } from '../../shared/theme';
import type { LocalStorageAction, LocalStorageCategory, LocalStorageCleanupJob, LocalStorageCleanupResult, LocalStorageDependency, LocalStorageItem, LocalStoragePathStatus, LocalStorageReason, LocalStorageSelection, LocalStorageSnapshot } from '../../shared/localStorage';
import { MAX_LOCAL_STORAGE_SELECTION } from '../../shared/localStorage';
import { planLocalStorageCleanup } from '../../shared/localStoragePlan';
import { hasRegisteredWorktreeCleanupIdentity } from '../../shared/sessionWorktrees';
import { pathKey } from '../pathKey';
import { t } from '../../shared/i18n';
import { sessionWorktreePaths, storageSessionDependencies, worktreeSessionReferences } from './sessionDependencies';
import { MAIN_LOG_NAME } from '../../shared/mainLog';
import { RENDERER_ERROR_LOG_NAME } from '../../shared/rendererErrorLog';
import { LLM_STREAM_LOG_NAME } from '../agent/llmStreamTrace';
import { storageMaintenanceCopy, type StorageMaintenanceId } from '../../shared/storageMaintenance';
import type { StartupStorageMaintenance } from './startupMaintenance';

type Target = { kind: LocalStorageAction; sessionId?: string; scope?: string; themeId?: string; workspaceId?: string; appId?: string; fingerprint?: string; path?: string; stat?: string; downloadIdentity?: string; roots?: { path: string; stat: string | null }[]; artifactRoot?: string; extensionId?: string; maintenanceId?: StorageMaintenanceId };
type Entry = { item: LocalStorageItem; target?: Target };
interface StorageExtensionPackage {
  id: string;
  name: string;
  directory: string;
  fingerprint: string;
  builtin: boolean;
  enabledWorkspaceIds: string[];
}
export interface StorageInventoryDependencies {
  userData: string;
  maintenance?: StartupStorageMaintenance;
  browserStoragePath?: string | null;
  clearBrowserData?(): Promise<void>;
  downloadStatus?(file: string): 'active' | 'verified' | 'unknown';
  downloadIdentity?(file: string): string;
  removeDownload?(file: string, expected: string): void;
  workspaces(): { id: string; name: string }[];
  sessions(): SessionMeta[];
  themes(): ThemeMetaInfo[];
  extensions(workspaceId: string): { id: string; name: string; scope?: 'global' | 'project' }[];
  extensionPackages?(): StorageExtensionPackage[];
  verifyExtension?(id: string, fingerprint: string): Promise<void>;
  disableExtension?(workspaceId: string, id: string, fingerprint: string): Promise<void>;
  uninstallExtension?(id: string, fingerprint: string): Promise<void>;
  apps(workspaceId: string): Promise<AppSnapshot>;
  builtinAppIds: ReadonlySet<string>;
  removeSession(id: string): Promise<void>;
  preflightWorktree?(id: string, dependents: ReadonlySet<string>, discard: boolean): Promise<{ ok: boolean; message?: string }>;
  cleanupWorktree(id: string, discard: boolean): Promise<{ ok: boolean; message?: string }>;
  removeTheme(id: string): { ok: boolean; error?: string };
  clearAttachments(scope: string): void;
  removeHandover(id: string): Promise<void>;
  uninstallApp(workspaceId: string, appId: string, deleteData: boolean): Promise<unknown>;
}

const rootCategories: Record<string, LocalStorageCategory> = {
  'agent-sessions': 'sessions', 'agent-session-events': 'sessions', 'agent-fork-pending': 'sessions', 'agent-fork-points': 'sessions',
  'agent-fork-context': 'sessions', 'agent-inputs': 'sessions',
  'sessions.json': 'sessions', 'pi-sessions': 'sessions', 'conversation-attachments': 'attachments',
  'session-handovers': 'handovers', 'extension': 'extensions', 'extensions': 'extensions', 'agent-apps': 'apps',
  'agent-app-library': 'apps', 'agent-app-assets': 'apps', 'browser-downloads': 'browser',
  'browser-captures': 'browser', Partitions: 'browser', themes: 'themes'
};
const categoryFor = (name: string): LocalStorageCategory => rootCategories[name] ?? (name.startsWith('chat-history-') ? 'sessions' : 'other');
const diagnosticLogs = [MAIN_LOG_NAME, RENDERER_ERROR_LOG_NAME, LLM_STREAM_LOG_NAME, 'skill-inject.ndjson'];
/** Producers already tolerate rotation/expiration of these individual files. */
const standaloneArtifacts = new Map<string, (name: string) => boolean>([
  ['browser-captures', name => /^(?:shot|turn)-\d+-[0-9a-z]+\.png$|^(?:rec|render)-\d+-[0-9a-f]+\.webm$/i.test(name)],
  ['terminal-captures', name => /^capture-\d+-[\w-]+\.png$/.test(name)],
  ['logs', name => diagnosticLogs.some(log => name === log || name === `${log}.old`)]
]);
const sessionFiles = new Map<string, RegExp>([
  ['agent-sessions', /(?:\.trace)?\.json(?:\.ranges|\.timeline)?$/],
  ['agent-session-events', /\.ndjson(?:\.index\.json)?$/],
  ['agent-fork-pending', /\.json$/],
  ['agent-fork-points', /$/],
  ['agent-fork-context', /\.seeds\.ndjson$/],
  ['agent-inputs', /$/]
]);
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const identity = (s: fs.Stats) => [s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs].join(':');
const inside = (child: string, parent: string) => { const rel = path.relative(parent, child); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); };
const stopped = (s: SessionMeta) => !!s.archived && !s.hidden && s.status !== 'running' && s.status !== 'starting' && s.runtimePresence !== 'running' && s.runtimePresence !== 'starting';
const worktreeFingerprint = (s: SessionMeta) => JSON.stringify([s.createdAt, s.workspaceId, s.cwd, s.sourceRoot, s.worktreePath, s.worktreeSource, s.worktreeBranch, s.worktreeBaseBranch, s.worktreeRepoSet, s.worktreeGroups]);
const sessionFingerprint = (s: SessionMeta) => JSON.stringify([worktreeFingerprint(s), s.parentSessionId, !!s.archived, s.runtime, s.externalSessionId, s.terminalResumeScope]);
const sessionReason = (s: SessionMeta): LocalStorageReason | undefined =>
  s.hidden || s.type !== 'terminal' || !s.workspaceId ? 'shared' : s.worktreeCleanupPending ? 'processing'
    : s.meta?.worktreeGroupsError ? 'unavailable' : undefined;
const worktreeReason = (s: SessionMeta): LocalStorageReason | undefined => s.type === 'terminal' && s.workspaceId ? sessionReason(s) : 'shared';

/** Traverses no symlinks or mount boundaries; the cap makes a scan bounded and visibly partial. */
export async function measureStorage(paths: string[], options: { seen: Set<string>; budget: { remaining: number; deadline?: number }; limit?: number; device?: number }): Promise<{ bytes: number; partial: boolean; modifiedAt?: number }> {
  let bytes = 0, visited = 0, partial = false, modifiedAt = 0;
  const stack = [...paths];
  let device = options.device;
  while (stack.length) {
    if (visited >= (options.limit ?? 20000) || options.budget.remaining <= 0 || (options.budget.deadline !== undefined && Date.now() >= options.budget.deadline)) { partial = true; break; }
    const current = stack.pop()!;
    visited++; options.budget.remaining--;
    if (path.basename(current).toLowerCase() === '.muster') { partial = true; continue; }
    try {
      const stat = await fs.promises.lstat(current);
      if (device === undefined) device = stat.dev;
      if (stat.isSymbolicLink() || stat.dev !== device) { partial = true; continue; }
      modifiedAt = Math.max(modifiedAt, stat.mtimeMs);
      if (stat.isDirectory()) {
        const dir = await fs.promises.opendir(current);
        for await (const child of dir) {
          if (stack.length + visited >= Math.min(options.limit ?? 20000, options.budget.remaining + visited)) { partial = true; break; }
          stack.push(path.join(current, child.name));
        }
      } else if (stat.isFile()) {
        const key = stat.nlink > 1 && stat.ino ? `${stat.dev}:${stat.ino}` : '';
        if (!key || !options.seen.has(key)) { bytes += stat.size; if (key) options.seen.add(key); }
        else partial = true;
      } else partial = true;
    } catch { partial = true; }
  }
  return { bytes, partial, ...(modifiedAt ? { modifiedAt } : {}) };
}

async function children(root: string): Promise<string[] | null> {
  try {
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return (await fs.promises.readdir(root)).sort();
  } catch { return null; }
}

/** Bound partition discovery; fall back to one partial shared item on a large or unreadable root. */
async function partitionChildren(root: string, deadline: number): Promise<string[] | null> {
  try {
    const stat = await fs.promises.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const entries: string[] = [];
    const dir = await fs.promises.opendir(root);
    for await (const child of dir) {
      if (entries.length >= 20000 || Date.now() >= deadline) return null;
      entries.push(child.name);
    }
    return entries.sort();
  } catch { return null; }
}

/** Missing roots remain reviewable; unreadable, redirected or non-directory roots do not. */
async function inspectWorktreeRoots(paths: string[]): Promise<{ statuses: Array<{ path: string; status: LocalStoragePathStatus }>; roots: Array<{ path: string; stat: string | null }> }> {
  type CheckedRoot = { path: string; status: 'available'; stat: string } | { path: string; status: 'missing' | 'unavailable' };
  const checked = await Promise.all(paths.map(async (file): Promise<CheckedRoot> => {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { path: file, status: 'unavailable' as const };
      return { path: file, status: 'available' as const, stat: identity(stat) };
    } catch (error) {
      return { path: file, status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' as const : 'unavailable' as const };
    }
  }));
  const roots: Array<{ path: string; stat: string | null }> = [];
  for (const entry of checked) {
    if (entry.status === 'available') roots.push({ path: entry.path, stat: entry.stat });
    else if (entry.status === 'missing') roots.push({ path: entry.path, stat: null });
  }
  return { statuses: checked.map(({ path: file, status }) => ({ path: file, status })), roots };
}

async function beforeDeadline<T>(operation: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(t('扫描已达到时间上限。'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(t('扫描已达到时间上限。'))), remaining); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Refuse changed, redirected or substituted managed targets before invoking a domain deletion. */
function assertManagedDirectory(userData: string, subdir: string, allowMissing = false): void {
  if (!fs.lstatSync(userData).isDirectory()) throw new Error(t('无法访问工作台数据目录。'));
  const userRoot = fs.realpathSync(userData);
  const root = path.join(userData, subdir);
  const rootStat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!rootStat && allowMissing) return;
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink() || pathKey(fs.realpathSync(root)) !== pathKey(path.join(userRoot, subdir))) throw new Error(t('存储目录已变化或被重定向，请重新扫描。'));
}

function assertManagedTarget(userData: string, subdir: string, target: Target): void {
  if (!target.path || !target.stat) throw new Error(t('存储项目不可用，请重新扫描。'));
  assertManagedDirectory(userData, subdir);
  const root = path.join(userData, subdir);
  const stat = fs.lstatSync(target.path);
  if (stat.isSymbolicLink() || identity(stat) !== target.stat || pathKey(path.dirname(fs.realpathSync(target.path))) !== pathKey(fs.realpathSync(root))) throw new Error(t('存储项目已变化，请重新扫描。'));
}

function assertWorktreeRoots(target: Target): void {
  for (const root of target.roots ?? []) {
    const stat = fs.lstatSync(root.path, { throwIfNoEntry: false });
    if (root.stat === null && !stat) continue;
    if (!stat?.isDirectory() || stat.isSymbolicLink() || identity(stat) !== root.stat) {
      throw new Error(t('存储项目已变化，请重新扫描。'));
    }
  }
}

function assertSessionTarget(target: Target, rows: SessionMeta[]): SessionMeta {
  const row = rows.find(session => session.id === target.sessionId);
  if (row) {
    if (target.kind === 'session' && !row.retainedWorktreeOnly && !sessionReason(row) && sessionFingerprint(row) === target.fingerprint) return row;
    if (target.kind === 'worktree' && !worktreeReason(row) && worktreeFingerprint(row) === target.fingerprint) return row;
    if ((target.kind === 'attachment' || target.kind === 'handover') && stopped(row) && !row.retainedWorktreeOnly) return row;
  }
  throw new Error(t('会话状态已变化，请重新扫描。'));
}

function liveDependents(target: Target, owner: SessionMeta, rows: SessionMeta[]): SessionMeta[] {
  if (target.kind === 'worktree') return worktreeSessionReferences(owner, rows);
  return rows.filter(row => !row.retainedWorktreeOnly && row.parentSessionId === owner.id);
}

function assertDependencyIds(current: string[], expected: Set<string | undefined>): void {
  if (current.length !== expected.size || current.some(id => !expected.has(id))) {
    throw new Error(t('清理依赖已变化，请重新扫描并确认。'));
  }
}

/** The renderer receives opaque IDs only; paths and deletion targets come from a recent scan. */
export class StorageInventory {
  private snapshots = new Map<string, { at: number; entries: Map<string, Entry>; dependencies: LocalStorageDependency[] }>();
  private jobs = new Map<string, LocalStorageCleanupJob & { finishedAt?: number }>();
  private reserved = new Set<string>();
  constructor(private deps: StorageInventoryDependencies) { userDataStorage(deps.userData).assertWritable(deps.userData); }

  async scan(): Promise<LocalStorageSnapshot> {
    const { userData } = this.deps;
    const sessions = this.deps.sessions();
    const workspaces = this.deps.workspaces();
    const workspaceByHash = new Map(workspaces.map(ws => [digest(ws.id), ws.id]));
    const themes = this.deps.themes();
    const sessionById = new Map(sessions.map(s => [s.id, s]));
    const sessionsByStorageKey = new Map<string, SessionMeta | null>();
    for (const row of sessions) {
      if (row.retainedWorktreeOnly || !row.id.trim()) continue;
      for (const key of new Set([row.id, safeScopedKey(row.id)])) {
        sessionsByStorageKey.set(key, sessionsByStorageKey.has(key) ? null : row);
      }
    }
    const pathsBySession = new Map<string, string[]>();
    const entries: Entry[] = [];
    const extensionDependencies: LocalStorageDependency[] = [];
    const seen = new Set<string>(), budget = { remaining: 200000, deadline: Date.now() + 20000 };
    const rootStat = await fs.promises.lstat(userData);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(t('无法访问工作台数据目录。'));
    const add = async (category: LocalStorageCategory, name: string, paths: string[], opts: Partial<LocalStorageItem> = {}, target?: Target, external = false) => {
      const measured = paths.length ? (external ? await Promise.all(paths.map(file => measureStorage([file], { seen, budget }))) : [await measureStorage(paths, { seen, budget, device: rootStat.dev })]) : [];
      const result = { bytes: measured.reduce((sum, value) => sum + value.bytes, 0), partial: measured.some(value => value.partial), modifiedAt: Math.max(0, ...measured.map(value => value.modifiedAt ?? 0)) || undefined };
      const item: LocalStorageItem = { id: randomUUID(), category, name, paths, bytes: paths.length ? result.bytes : null, partial: result.partial, ...(result.modifiedAt ? { modifiedAt: result.modifiedAt } : {}), ...opts };
      if (target && (!result.partial || target.kind === 'worktree' || target.kind === 'browserData' || target.kind === 'startupCleanup')) {
        if (target.path) {
          try {
            const stat = await fs.promises.lstat(target.path);
            const fileOnly = target.kind === 'theme' || target.kind === 'download' || target.kind === 'artifact';
            if (stat.isSymbolicLink() || (fileOnly ? !stat.isFile() : !stat.isDirectory())) throw new Error('Invalid target');
            target.stat = identity(stat);
            if (target.kind === 'download') target.downloadIdentity = this.deps.downloadIdentity?.(target.path);
            if (target.kind === 'download' && !target.downloadIdentity) throw new Error('Missing download identity');
          }
          catch { item.partial = true; item.reason = 'unavailable'; target = undefined; }
        }
        if (target) item.action = target.kind;
      } else if (target) item.reason = 'unavailable';
      entries.push({ item, target: item.action ? target : undefined });
      return item;
    };
    const addSession = (s: SessionMeta, paths: string[], unavailable = false) => {
      const reason = unavailable ? 'unavailable' : sessionReason(s);
      return add('sessions', s.name || s.id, paths, {
        sessionId: s.id, owner: s.name, workspaceId: s.workspaceId, reason, stopsSession: !s.archived,
        ...(!paths.length ? { sizeKind: 'shared' as const } : {})
      }, reason ? undefined : { kind: 'session', sessionId: s.id, fingerprint: sessionFingerprint(s) });
    };
    const names = await children(userData);
    if (!names) throw new Error(t('无法读取工作台数据目录。'));
    const maintenance = this.deps.maintenance;
    const maintenanceAssets = maintenance?.inspect(new Set(names)) ?? [];
    const maintenanceNames = new Set(maintenance?.rules.flatMap(rule => rule.members.map(member => member.name)));
    const attachments = new Map<string, { session?: SessionMeta; scope: string }[]>();
    let sessionFilesUnavailable = false;
    const rememberScope = (scope: string, session?: SessionMeta) => {
      const hash = digest(scope);
      for (const name of [hash, hash.slice(0, 20)]) attachments.set(name, [...(attachments.get(name) ?? []), { session, scope }]);
    };
    for (const s of sessions) { rememberScope(`gui:${s.id}`, s); rememberScope(`cli:${s.id}`, s); }
    for (const ws of workspaces) rememberScope(`scheduler:${ws.id}`);

    for (const name of names) {
      const root = path.join(userData, name);
      if (maintenanceNames.has(name) || root === maintenance?.directory) continue;
      const matchesArtifact = standaloneArtifacts.get(name);
      if (matchesArtifact) {
        const parts = await partitionChildren(root, budget.deadline);
        if (!parts) { await add(categoryFor(name), name, [root], { reason: 'unavailable' }); continue; }
        for (const part of parts) {
          const file = path.join(root, part);
          const target: Target | undefined = matchesArtifact(part) ? { kind: 'artifact', path: file, artifactRoot: name } : undefined;
          await add(categoryFor(name), part, [file], target ? {} : { reason: 'unknown' }, target);
        }
        continue;
      }
      if (name === 'Partitions' && this.deps.browserStoragePath && this.deps.clearBrowserData) {
        const parts = await partitionChildren(root, budget.deadline);
        if (!parts) { await add('browser', name, [root], { reason: 'unavailable' }); continue; }
        for (const part of parts) {
          const folder = path.join(root, part);
          const isBrowser = pathKey(path.resolve(folder)) === pathKey(path.resolve(this.deps.browserStoragePath));
          await add('browser', isBrowser ? 'browser-site-data' : part, [folder], isBrowser ? {} : { reason: 'shared' }, isBrowser ? { kind: 'browserData' } : undefined);
        }
        continue;
      }
      if (name === 'extension') {
        const parts = await partitionChildren(root, budget.deadline);
        if (!parts) { await add('extensions', name, [root], { reason: 'unavailable' }); continue; }
        const shared = parts.filter(part => part !== 'data').map(part => path.join(root, part));
        const grouped = new Map<string, string[]>();
        if (parts.includes('data')) {
          const data = path.join(root, 'data'), dataParts = await partitionChildren(data, budget.deadline);
          if (!dataParts) shared.push(data);
          else {
            shared.push(...dataParts.filter(part => part !== 'workspaces').map(part => path.join(data, part)));
            if (dataParts.includes('workspaces')) {
              const workspaceRoot = path.join(data, 'workspaces'), workspaceParts = await partitionChildren(workspaceRoot, budget.deadline);
              if (!workspaceParts) shared.push(workspaceRoot);
              else for (const part of workspaceParts) {
                const workspaceId = workspaceByHash.get(part.toLowerCase());
                if (workspaceId) grouped.set(workspaceId, [...(grouped.get(workspaceId) ?? []), path.join(workspaceRoot, part)]);
                else shared.push(path.join(workspaceRoot, part));
              }
            }
          }
        }
        if (shared.length) await add('extensions', name, shared, { reason: 'shared' });
        for (const [workspaceId, paths] of grouped) await add('extensions', name, paths, { workspaceId, reason: 'shared' });
        continue;
      }
      if (name === 'extensions' && this.deps.extensionPackages) {
        const global = userDataStorage(userData).manifestPath('extension-source');
        const parts = await partitionChildren(root, budget.deadline);
        if (!parts) { await add('extensions', name, [root], { reason: 'unavailable' }); continue; }
        const packages = new Map(this.deps.extensionPackages().map(pkg => [pathKey(pkg.directory), pkg]));
        for (const part of parts) {
          const folder = path.join(root, part);
          if (pathKey(folder) !== pathKey(global)) { await add('extensions', part, [folder], { reason: 'shared' }); continue; }
          const installed = await partitionChildren(global, budget.deadline);
          if (!installed) { await add('extensions', part, [global], { reason: 'unavailable' }); continue; }
          for (const leaf of installed) {
            const directory = path.join(global, leaf);
            const pkg = packages.get(pathKey(directory));
            if (!pkg) { await add('extensions', leaf, [directory], { reason: 'unknown' }); continue; }
            const info = { extensionId: pkg.id, fingerprint: pkg.fingerprint };
            const asset = await add('extensions', pkg.name, [directory], { reason: pkg.builtin ? 'builtin' : undefined },
              pkg.builtin ? undefined : { kind: 'extension', ...info, path: directory });
            for (const workspaceId of pkg.enabledWorkspaceIds) {
              const activation = await add('extensions', pkg.name, [], { workspaceId, sizeKind: 'shared' },
                { kind: 'extensionActivation', workspaceId, ...info });
              extensionDependencies.push({ dependentId: activation.id, prerequisiteId: asset.id });
            }
          }
        }
        continue;
      }
      if (name === 'agent-apps' || name === 'agent-app-assets') {
        const parts = await partitionChildren(root, budget.deadline);
        if (!parts) { await add('apps', name, [root], { reason: 'unavailable' }); continue; }
        const grouped = new Map<string, string[]>();
        for (const part of parts) {
          const match = name === 'agent-apps' ? /^([a-f0-9]{64})\.sqlite(?:-(?:wal|shm|journal))?$/i.exec(part) : /^([a-f0-9]{64})$/i.exec(part);
          const workspaceId = match ? workspaceByHash.get(match[1].toLowerCase()) : undefined;
          const key = workspaceId ?? '';
          grouped.set(key, [...(grouped.get(key) ?? []), path.join(root, part)]);
        }
        for (const [workspaceId, paths] of grouped) await add('apps', name, paths, { ...(workspaceId ? { workspaceId } : {}), reason: 'shared' });
        continue;
      }
      const suffix = sessionFiles.get(name);
      if (suffix) {
        const parts = await partitionChildren(root, budget.deadline);
        if (!parts) { sessionFilesUnavailable = true; await add('sessions', name, [root], { reason: 'unavailable' }); continue; }
        for (const part of parts) {
          const row = sessionsByStorageKey.get(part.replace(suffix, ''));
          if (row) {
            const paths = pathsBySession.get(row.id) ?? [];
            paths.push(path.join(root, part));
            pathsBySession.set(row.id, paths);
          } else await add('sessions', part, [path.join(root, part)], { reason: 'unknown' });
        }
        continue;
      }
      if (name === 'conversation-attachments' || name === 'session-handovers' || name === 'themes' || name === 'browser-downloads') {
        const parts = await children(root);
        if (!parts) { await add(categoryFor(name), name, [root], { reason: 'unavailable' }); continue; }
        for (const part of parts) {
          const folder = path.join(root, part);
          if (name === 'conversation-attachments') {
            const matches = attachments.get(part) ?? [], match = matches.length === 1 ? matches[0] : undefined, s = match?.session;
            const legacy = match && part.length === 20 && parts.includes(digest(match.scope));
            const reason: LocalStorageReason | undefined = !s ? 'unknown' : !stopped(s) ? 'active' : legacy ? 'duplicate' : undefined;
            await add('attachments', s?.name || part, [folder], { sessionId: s?.id, owner: s?.name, workspaceId: s?.workspaceId, reason }, !reason && match ? { kind: 'attachment', sessionId: s!.id, scope: match.scope, path: folder } : undefined);
          } else if (name === 'session-handovers') {
            const s = sessionById.get(part), reason: LocalStorageReason | undefined = !s ? 'unknown' : !stopped(s) ? 'active' : undefined;
            await add('handovers', s?.name || part, [folder], { sessionId: s?.id, owner: s?.name, workspaceId: s?.workspaceId, reason }, !reason && s ? { kind: 'handover', sessionId: s.id, path: folder } : undefined);
          } else if (name === 'themes') {
            const theme = themes.find(t => !t.builtin && `${t.id}.json` === part);
            await add('themes', theme?.name || part, [folder], { reason: theme ? undefined : 'unknown' }, theme ? { kind: 'theme', themeId: theme.id, path: folder } : undefined);
          } else {
            const status = this.deps.downloadStatus?.(folder) ?? 'unknown';
            const reason = status === 'active' ? 'active' : status === 'unknown' ? 'unknownDownload' : undefined;
            await add('browser', part, [folder], { reason }, reason ? undefined : { kind: 'download', path: folder });
          }
        }
        continue;
      }
      await add(categoryFor(name), name, [root], { reason: 'shared' });
    }
    // Some sessions only have metadata in the shared sessions.json, or the directory has not been created yet.
    for (const s of sessions) if (!s.retainedWorktreeOnly) await addSession(s, pathsBySession.get(s.id) ?? [], sessionFilesUnavailable);

    const roots: string[] = [];
    for (const s of sessions) {
      const paths = s.worktreeGroups?.borrowedFrom ? [] : sessionWorktreePaths(s);
      if (!paths.length) continue;
      const overlap = paths.some((resolved, index) => inside(resolved, userData) || inside(userData, resolved) || roots.some(previous => inside(resolved, previous) || inside(previous, resolved)) || paths.slice(0, index).some(previous => inside(resolved, previous) || inside(previous, resolved)));
      roots.push(...paths);
      const { statuses, roots: inspectedRoots } = await inspectWorktreeRoots(paths);
      const unavailable = statuses.some(item => item.status === 'unavailable');
      const reason: LocalStorageReason | undefined = overlap ? 'duplicate' : unavailable ? 'unavailable' : worktreeReason(s);
      const measuredPaths = overlap ? [] : statuses.filter(item => item.status === 'available').map(item => item.path);
      await add('worktrees', s.name || s.id, measuredPaths,
        { paths, pathStatuses: statuses, sessionId: s.id, owner: s.name, workspaceId: s.workspaceId, reason,
          issue: s.meta?.worktreeCleanupIssue, canDiscardWorktree: hasRegisteredWorktreeCleanupIdentity(s), ...(overlap || unavailable ? { partial: true } : {}) },
        reason ? undefined : { kind: 'worktree', sessionId: s.id, fingerprint: worktreeFingerprint(s), roots: inspectedRoots }, true);
    }

    // The coordinator already owns extension discovery; source copies are inside workspaces and are not measured here.
    for (const ws of workspaces) {
      try {
        for (const extension of this.deps.extensions(ws.id)) {
          if (extension.scope === 'global' && this.deps.extensionPackages) continue;
          await add('extensions', extension.name || extension.id, [], { workspaceId: ws.id, reason: 'shared', sizeKind: 'shared' });
        }
      } catch (error) {
        await add('extensions', ws.name, [], { workspaceId: ws.id, reason: 'unavailable', partial: true, issue: (error as Error)?.message || String(error) });
      }
    }

    // Ask the app service only for already existing workspace databases: reading a new workspace seeds data.
    for (const ws of workspaces) {
      const db = userDataStorage(userData).scopedPath('workspace', 'agent-apps', ws.id, id => `${digest(id)}.sqlite`);
      try {
        const parentStat = await fs.promises.lstat(path.dirname(db));
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) continue;
        const dbStat = await fs.promises.lstat(db);
        if (!dbStat.isFile() || dbStat.isSymbolicLink()) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await add('apps', ws.name, [], { workspaceId: ws.id, reason: 'unavailable', partial: true, issue: (error as Error).message });
        continue;
      }
      try {
        if (Date.now() >= budget.deadline) throw new Error(t('扫描已达到时间上限。'));
        const snapshot = await beforeDeadline(this.deps.apps(ws.id), budget.deadline);
        for (const installation of snapshot.apps) {
          const app = installation.definition;
          if (this.deps.builtinAppIds.has(app.id)) continue;
          const busy = snapshot.operations.some(op => op.appId === app.id && op.phase === 'running');
          await add('apps', app.name, [], { workspaceId: ws.id, reason: busy ? 'active' : undefined, sizeKind: 'shared' }, busy ? undefined : { kind: 'app', workspaceId: ws.id, appId: app.id, fingerprint: JSON.stringify(installation) });
        }
      } catch (error) {
        await add('apps', ws.name, [], { workspaceId: ws.id, reason: 'unavailable', partial: true, issue: (error as Error)?.message || String(error) });
      }
    }
    for (const asset of maintenanceAssets) {
      const reason = asset.canQueue ? undefined
        : asset.phase === 'queued' || (asset.phase === 'detached' && asset.issue) ? 'restartPending'
          : asset.phase === 'detached' ? 'processing' : 'unavailable';
      await add('other', storageMaintenanceCopy[asset.id].name, asset.paths,
        { reason, maintenanceId: asset.id, issue: asset.issue },
        asset.canQueue ? { kind: 'startupCleanup', maintenanceId: asset.id } : undefined);
    }
    const id = randomUUID();
    const items = entries.map(entry => entry.item);
    const dependencies = [...storageSessionDependencies(items, sessions), ...extensionDependencies];
    this.snapshots.set(id, { at: Date.now(), entries: new Map(entries.map(entry => [entry.item.id, entry])), dependencies });
    for (const [key, value] of this.snapshots) if (Date.now() - value.at > 10 * 60_000 || this.snapshots.size > 8) this.snapshots.delete(key);
    return { id, items, workspaces, partial: items.some(item => item.partial), dependencies };
  }

  startCleanup(snapshotId: string, selections: LocalStorageSelection[]): { id: string } {
    for (const [id, job] of this.jobs) if (job.done && job.finishedAt && Date.now() - job.finishedAt > 10 * 60_000) this.jobs.delete(id);
    if ([...this.jobs.values()].some(job => !job.done)) throw new Error(t('已有存储清理正在进行，请稍后再试。'));
    const id = randomUUID();
    const job: LocalStorageCleanupJob & { finishedAt?: number } = { id, total: Array.isArray(selections) ? selections.length : 0, done: false, results: [] };
    this.jobs.set(id, job);
    void this.clean(snapshotId, selections, result => job.results.push(result)).then(() => { job.done = true; job.finishedAt = Date.now(); }, error => {
      job.error = (error as Error)?.message || String(error); job.done = true; job.finishedAt = Date.now();
    });
    return { id };
  }

  cleanupStatus(id: string): LocalStorageCleanupJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(t('清理任务不存在，请重新扫描。'));
    return { id: job.id, total: job.total, done: job.done, results: structuredClone(job.results), ...(job.error ? { error: job.error } : {}) };
  }

  async clean(snapshotId: string, selections: LocalStorageSelection[], onResult?: (result: LocalStorageCleanupResult) => void): Promise<LocalStorageCleanupResult[]> {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot || Date.now() - snapshot.at > 10 * 60_000) throw new Error(t('存储扫描已过期，请重新扫描。'));
    if (!Array.isArray(selections) || selections.length === 0 || selections.length > MAX_LOCAL_STORAGE_SELECTION ||
      selections.some(s => !s || typeof s.id !== 'string') || new Set(selections.map(s => s.id)).size !== selections.length) {
      throw new Error(t('存储项目选择无效。'));
    }
    const chosen = new Map(selections.map(selection => [selection.id, selection]));
    const targets = new Map(selections.map(({ id }) => [id, this.reserved.has(id) ? undefined : snapshot.entries.get(id)?.target]));
    // Session assets are handled by the session lifecycle when its deletion starts successfully.
    const roots = [...chosen.keys()].sort((a, b) => Number(targets.get(b)?.kind === 'session') - Number(targets.get(a)?.kind === 'session'));
    const plan = planLocalStorageCleanup([...snapshot.entries.values()].map(entry => entry.item), snapshot.dependencies, roots);
    if (plan.required.length || plan.cycle) throw new Error(t('清理清单缺少必删项目或存在循环依赖，请重新检查。'));
    const neighbors = new Map<string, string[]>();
    const connect = (from: string, to: string) => {
      const adjacent = neighbors.get(from);
      if (adjacent) adjacent.push(to);
      else neighbors.set(from, [to]);
    };
    for (const [id, users] of plan.dependents) {
      if (!chosen.has(id)) continue;
      for (const user of users) { connect(id, user); connect(user, id); }
    }
    const failed = new Map<string, string>();
    const block = (id: string, error: unknown) => {
      const pending = [id];
      while (pending.length) {
        const current = pending.pop()!;
        if (failed.has(current)) continue;
        failed.set(current, (error as Error)?.message || String(error));
        pending.push(...(neighbors.get(current) ?? []));
      }
    };
    for (const [id, target] of targets) if (target) this.reserved.add(id);
    const checkSessionScope = (id: string, target: Target, rows: SessionMeta[], afterDependents = false): Set<string> => {
      const row = assertSessionTarget(target, rows);
      const expected = new Set(afterDependents ? [] : (plan.dependents.get(id) ?? []).map(dep => targets.get(dep)?.sessionId));
      const current = liveDependents(target, row, rows).map(dep => dep.id);
      assertDependencyIds(current, expected);
      return new Set(current);
    };
    const checkExtensionScope = (id: string, target: Target, packages: StorageExtensionPackage[], afterDependents = false): void => {
      const current = packages.find(pkg => pkg.id === target.extensionId);
      if (!current || current.fingerprint !== target.fingerprint) throw new Error(t('扩展状态已变化，请重新扫描。'));
      if (target.kind === 'extensionActivation') {
        if (!current.enabledWorkspaceIds.includes(target.workspaceId!)) throw new Error(t('扩展状态已变化，请重新扫描。'));
      } else {
        if (current.builtin) throw new Error(t('内置内容不可删除。'));
        const expected = new Set(afterDependents ? [] : (plan.dependents.get(id) ?? []).map(dep => targets.get(dep)?.workspaceId));
        assertDependencyIds(current.enabledWorkspaceIds, expected);
        assertManagedTarget(this.deps.userData, path.join('extensions', 'global'), target);
      }
    };
    const isExtension = (target: Target) => target.kind === 'extension' || target.kind === 'extensionActivation';
    try {
      const rows = this.deps.sessions();
      const packages = this.deps.extensionPackages?.() ?? [];
      for (const id of plan.ordered) {
        const target = targets.get(id);
        if (!target) { block(id, t('存储项目不可用，请重新扫描。')); continue; }
        if (failed.has(id)) continue;
        try {
          if (target.kind === 'worktree' || target.kind === 'session') checkSessionScope(id, target, rows);
          if (isExtension(target)) checkExtensionScope(id, target, packages);
          if (target.kind === 'worktree') {
            assertWorktreeRoots(target);
            if (chosen.get(id)?.discardWorktree && !snapshot.entries.get(id)?.item.canDiscardWorktree) throw new Error(t('无法核验此 worktree 的强制清理身份。'));
          }
        } catch (error) { block(id, error); }
      }
      for (const [id, target] of targets) {
        if (!target || failed.has(id)) continue;
        try {
          if (target.kind === 'worktree' && this.deps.preflightWorktree) {
            const expected = checkSessionScope(id, target, this.deps.sessions());
            const result = await this.deps.preflightWorktree(target.sessionId!, expected, chosen.get(id)?.discardWorktree === true);
            if (!result.ok) throw new Error(result.message || t('未通过 worktree 安全检查，已保留。'));
          } else if (target.kind === 'extension') {
            if (!this.deps.verifyExtension || !this.deps.uninstallExtension) throw new Error(t('扩展清理服务不可用。'));
            await this.deps.verifyExtension(target.extensionId!, target.fingerprint!);
          }
        } catch (error) { block(id, error); }
      }
      // New dependents during an asynchronous preflight require a new confirmation.
      const current = this.deps.sessions();
      const currentPackages = this.deps.extensionPackages?.() ?? [];
      for (const [id, target] of targets) {
        if (!target || failed.has(id)) continue;
        try {
          if (target.kind === 'worktree' || target.kind === 'session') checkSessionScope(id, target, current);
          if (target.kind === 'worktree') assertWorktreeRoots(target);
          if (isExtension(target)) checkExtensionScope(id, target, currentPackages);
        }
        catch (error) { block(id, error); }
      }
      const validateLiveTarget = (id: string, target: Target): void => {
        if (target.sessionId) {
          const rows = this.deps.sessions();
          if (target.kind === 'session' || target.kind === 'worktree') checkSessionScope(id, target, rows, true);
          else assertSessionTarget(target, rows);
        }
        if (isExtension(target)) checkExtensionScope(id, target, this.deps.extensionPackages?.() ?? [], true);
      };
      return await this.executeCleanup(snapshot.entries, plan.ordered, plan.dependents, chosen, targets, failed, validateLiveTarget, onResult);
    } finally {
      for (const [id, target] of targets) if (target) this.reserved.delete(id);
    }
  }

  private async executeCleanup(
    entries: Map<string, Entry>, ordered: string[], dependents: Map<string, string[]>,
    chosen: Map<string, LocalStorageSelection>, targets: Map<string, Target | undefined>, failed: Map<string, string>,
    validateLiveTarget: (id: string, target: Target) => void,
    onResult?: (result: LocalStorageCleanupResult) => void
  ): Promise<LocalStorageCleanupResult[]> {
    const startedSessions = new Set<string>();
    const results: LocalStorageCleanupResult[] = [];
    const record = (result: LocalStorageCleanupResult) => {
      if (targets.get(result.id)) {
        if (result.status === 'failed') {
          const entry = entries.get(result.id);
          if (entry) { delete entry.target; delete entry.item.action; }
        } else entries.delete(result.id);
      }
      results.push(result); onResult?.(result);
    };
    for (const id of ordered) {
      const selection = chosen.get(id)!;
      const target = targets.get(id);
      if (!target || failed.has(id)) {
        record({ id, status: 'failed', error: failed.get(id) ?? t('存储项目不可用，请重新扫描。') });
        continue;
      }
      if ((target.kind === 'attachment' || target.kind === 'handover') && target.sessionId && startedSessions.has(target.sessionId)) {
        record({ id, status: 'skipped' }); continue;
      }
      try {
        if ((dependents.get(id) ?? []).some(dependent => failed.has(dependent))) {
          throw new Error(t('必删项目未能清理，已保留此项目。'));
        }
        validateLiveTarget(id, target);
        if (target.kind === 'session') {
          for (const root of [...sessionFiles.keys(), 'conversation-attachments', 'session-handovers', 'turn-changes']) {
            assertManagedDirectory(this.deps.userData, root, true);
          }
          await this.deps.removeSession(target.sessionId!);
          startedSessions.add(target.sessionId!);
          // These paths are now owned by the session's background cleanup.
          for (const [relatedId, entry] of entries) {
            const related = entry.target;
            if (related && related.sessionId === target.sessionId && (related.kind === 'attachment' || related.kind === 'handover')) entries.delete(relatedId);
          }
          record({ id, status: 'started' }); continue;
        }
        if (target.kind === 'worktree') {
          assertWorktreeRoots(target);
          const result = await this.deps.cleanupWorktree(target.sessionId!, selection.discardWorktree === true);
          if (!result.ok) throw new Error(result.message || t('未通过 worktree 安全检查，已保留。'));
        } else if (target.kind === 'download') {
          if (!this.deps.removeDownload || !target.downloadIdentity) throw new Error(t('下载记录不可用。'));
          this.deps.removeDownload(target.path!, target.downloadIdentity);
        } else if (target.kind === 'artifact') {
          assertManagedTarget(this.deps.userData, target.artifactRoot!, target);
          fs.unlinkSync(target.path!);
        } else if (target.kind === 'startupCleanup') {
          if (!this.deps.maintenance || !target.maintenanceId) throw new Error(t('存储项目不可用，请重新扫描。'));
          this.deps.maintenance.queue(target.maintenanceId);
          record({ id, status: 'scheduled' });
          continue;
        } else if (target.kind === 'extensionActivation') {
          if (!this.deps.disableExtension) throw new Error(t('扩展清理服务不可用。'));
          await this.deps.disableExtension(target.workspaceId!, target.extensionId!, target.fingerprint!);
        } else if (target.kind === 'extension') {
          if (!this.deps.uninstallExtension) throw new Error(t('扩展清理服务不可用。'));
          await this.deps.uninstallExtension(target.extensionId!, target.fingerprint!);
        } else if (target.kind === 'browserData') {
          if (!this.deps.clearBrowserData) throw new Error(t('浏览器数据清理服务不可用。'));
          await this.deps.clearBrowserData();
        } else if (target.kind === 'attachment') {
          assertManagedTarget(this.deps.userData, 'conversation-attachments', target);
          this.deps.clearAttachments(target.scope!);
        } else if (target.kind === 'handover') {
          assertManagedTarget(this.deps.userData, 'session-handovers', target);
          await this.deps.removeHandover(target.sessionId!);
        } else if (target.kind === 'theme') {
          assertManagedTarget(this.deps.userData, 'themes', target);
          if (!this.deps.themes().some(theme => theme.id === target.themeId && !theme.builtin)) throw new Error(t('主题已变化，请重新扫描。'));
          const result = this.deps.removeTheme(target.themeId!); if (!result.ok) throw new Error(result.error || t('删除主题失败。'));
        } else if (target.kind === 'app') {
          const current = await this.deps.apps(target.workspaceId!);
          const app = current.apps.find(a => a.definition.id === target.appId);
          if (!app || this.deps.builtinAppIds.has(app.definition.id) || JSON.stringify(app) !== target.fingerprint || current.operations.some(op => op.appId === target.appId && op.phase === 'running')) throw new Error(t('应用状态已变化，请重新扫描。'));
          await this.deps.uninstallApp(target.workspaceId!, target.appId!, selection.deleteAppData === true);
        } else throw new Error(t('此存储操作不受支持。'));
        record({ id, status: 'completed' });
      } catch (error) {
        const message = (error as Error)?.message || String(error);
        failed.set(id, message);
        record({ id, status: 'failed', error: message });
      }
    }
    return results;
  }
}
