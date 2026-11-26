import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, SessionMeta } from '../../shared/types';
import type { PiSessionHandle } from '../../shared/piEvents';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import { captureWorkspaceExecutionContext, assertWorkspaceExecutionContextCurrent } from '../workspaceExecutionContext';
import { requireWorkspace, defaultCwdFor, sourcePathKey } from '../workspacePaths';
import { workspaceRootUsesFor } from '../workspaceRootUses';
import { t } from '../../shared/i18n';
import { withSessionCaptureReadAccess } from '../desktop/sessionCaptureAccess';

export const SCHEDULER_SOURCE_ENTRY = 'muster-workspace-source';
type Config = Pick<AppConfig, 'workspaces' | 'activeWorkspaceId'>;
interface PinnedSource {
  workspaceId: string;
  sourceRoot: NonNullable<SessionMeta['sourceRoot']>;
  controlPhysicalPath: string;
}
const connections = new WeakMap<object, WorkspaceExecutionContext>();
const operations = new WeakMap<object, Map<string, WorkspaceExecutionContext>>();
let captureUserData: string | undefined;

/** Set once by the host after its per-instance userData path has been resolved. */
export function setSchedulerCaptureUserData(value: string | undefined): void {
  if (value !== undefined && !path.isAbsolute(value)) throw new Error('Scheduler capture user data must be absolute');
  captureUserData = value;
}

/** Read only the first JSONL record to pin cwd before SDK/model/recall awaits. */
function sessionFileCwd(file?: string): string | undefined {
  if (!file) return undefined;
  if (!fs.existsSync(file)) throw new Error(`scheduler session file is unavailable: ${file}`);
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(16 * 1024); const chunks: Buffer[] = [];
    for (;;) {
      const count = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (!count) break;
      const end = bytes.subarray(0, count).indexOf(10);
      chunks.push(Buffer.from(bytes.subarray(0, end < 0 ? count : end)));
      if (end >= 0) break;
    }
    const header = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    if (header?.type !== 'session' || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw new Error('invalid scheduler session cwd');
    return header.cwd;
  } finally { fs.closeSync(fd); }
}

function pinnedSource(manager?: PiSessionHandle['sessionManager']): PinnedSource | undefined {
  const entry = manager?.getEntries?.().slice().reverse().find((entry: unknown) => {
    const item = entry as { type?: string; customType?: string };
    return item?.type === 'custom' && item.customType === SCHEDULER_SOURCE_ENTRY;
  }) as { data?: PinnedSource } | undefined;
  if (!entry) return undefined;
  const data = entry.data;
  if (!data || typeof data.workspaceId !== 'string' || typeof data.controlPhysicalPath !== 'string' ||
      typeof data.sourceRoot?.rootId !== 'string' || typeof data.sourceRoot.path !== 'string' ||
      typeof data.sourceRoot.cwd !== 'string' || typeof data.sourceRoot.physicalPath !== 'string') throw new Error('invalid scheduler source identity');
  return data;
}

export function getSchedulerConnectionContext(session?: PiSessionHandle | null): WorkspaceExecutionContext | undefined {
  return session ? connections.get(session) : undefined;
}

export function getActiveSchedulerContext(config: object, workspaceId: string): WorkspaceExecutionContext | undefined {
  return operations.get(config)?.get(workspaceId);
}

/** Read-only previews expose a broken source without breaking the settings/status response. */
export function schedulerWorkspacePromptScope(config: { get(): Config }, workspaceId?: string,
  session?: PiSessionHandle | null, sessionFile?: string, forceNew = false
): { workspaceContext?: WorkspaceExecutionContext; workspaceContextError?: string } {
  try {
    const id = requireWorkspace(config.get(), workspaceId).id;
    return { workspaceContext: getActiveSchedulerContext(config, id) ??
      captureSchedulerWorkspaceContext(config.get(), id, session, sessionFile, forceNew, undefined, false) };
  } catch (error) { return { workspaceContextError: (error as Error).message }; }
}

export function captureSchedulerWorkspaceContext(
  config: Config, workspaceId?: string, session?: PiSessionHandle | null, sessionFile?: string, forceNew = false,
  sourceOverride?: SessionMeta['sourceRoot'], provisionCapture = true
): WorkspaceExecutionContext {
  const workspace = requireWorkspace(config, workspaceId);
  const previous = forceNew ? undefined : getSchedulerConnectionContext(session);
  const pinned = forceNew ? undefined : pinnedSource(session?.sessionManager);
  const source = sourceOverride ?? pinned?.sourceRoot ?? (previous ? sourceForContext(previous) : undefined);
  if (pinned && pinned.workspaceId !== workspace.id) throw new Error('scheduler source belongs to another workspace');
  const cwd = source?.cwd ?? (!forceNew ? session?.sessionManager?.getCwd?.() ?? sessionFileCwd(sessionFile) : undefined) ?? defaultCwdFor(workspace);
  const meta: SessionMeta = { id: `orchestrator:${workspace.id}`, name: t('调度'), type: 'terminal', createdAt: 0,
    workspaceId: workspace.id, cwd, ...(source ? { sourceRoot: source } : {}) };
  const captured = captureWorkspaceExecutionContext(config, meta)!;
  const context = captureUserData ? withSessionCaptureReadAccess(captured, captureUserData, meta.id, provisionCapture)! : captured;
  if (pinned && pinned.controlPhysicalPath !== context.controlPhysicalPath) throw new Error('scheduler management folder changed');
  return context;
}

function sourceForContext(context: WorkspaceExecutionContext): NonNullable<SessionMeta['sourceRoot']> {
  const root = context.roots.find(root => root.rootId === context.sourceRootId);
  const physical = context.readableDirectories.find(dir => path.resolve(dir.path) === path.resolve(root?.path ?? ''));
  if (!root || !physical) throw new Error('scheduler source folder is unavailable');
  return { rootId: root.rootId, path: root.path, cwd: context.cwd, physicalPath: physical.physicalPath };
}

/** Validate disk metadata against the already-held directory set, without admitting new roots. */
export function bindSchedulerSessionContext(
  config: Config, manager: NonNullable<PiSessionHandle['sessionManager']>, captured: WorkspaceExecutionContext,
  options: { persistSource?: boolean } = {}
): WorkspaceExecutionContext {
  assertWorkspaceExecutionContextCurrent(config, captured);
  if (manager.getCwd && sourcePathKey(manager.getCwd()) !== sourcePathKey(captured.cwd)) throw new Error('scheduler session cwd changed');
  const pinned = pinnedSource(manager);
  let context = captured;
  if (pinned) {
    const root = captured.roots.find(root => root.rootId === pinned.sourceRoot.rootId);
    const physical = captured.readableDirectories.find(dir => path.resolve(dir.path) === path.resolve(root?.path ?? ''));
    if (pinned.workspaceId !== captured.workspaceId || !root || !physical ||
        path.resolve(pinned.sourceRoot.path) !== path.resolve(root.path) ||
        pinned.sourceRoot.physicalPath !== physical.physicalPath ||
        sourcePathKey(pinned.sourceRoot.cwd) !== sourcePathKey(captured.cwd) ||
        pinned.controlPhysicalPath !== captured.controlPhysicalPath) throw new Error('scheduler source identity changed');
    context = Object.freeze({ ...captured, sourceRootId: root.rootId });
  } else if (options.persistSource !== false) {
    if (!manager.appendCustomEntry) throw new Error('Pi session manager cannot persist scheduler source identity');
    manager.appendCustomEntry(SCHEDULER_SOURCE_ENTRY, { workspaceId: context.workspaceId, sourceRoot: sourceForContext(context), controlPhysicalPath: context.controlPhysicalPath });
  }
  return context;
}

export function rememberSchedulerConnectionContext(session: PiSessionHandle, context: WorkspaceExecutionContext): void {
  connections.set(session, context);
}

/** Keep every referenced root through recall, SDK loading, model execution and compaction. */
export function beginSchedulerWorkspaceContext(config: { get(): Config }, context: WorkspaceExecutionContext,
  options: { publish?: boolean; id?: string } = {}): () => void {
  assertWorkspaceExecutionContextCurrent(config.get(), context);
  const releases = context.roots.map(root => workspaceRootUsesFor(config).acquire({ workspaceId: context.workspaceId,
    rootId: root.rootId, kind: 'launch', id: options.id ?? `orchestrator:${context.workspaceId}`, label: t('调度') }));
  const current = operations.get(config) ?? new Map<string, WorkspaceExecutionContext>();
  if (options.publish !== false) { current.set(context.workspaceId, context); operations.set(config, current); }
  return () => {
    for (const release of releases.splice(0)) release();
    if (options.publish !== false && current.get(context.workspaceId) === context) current.delete(context.workspaceId);
  };
}
