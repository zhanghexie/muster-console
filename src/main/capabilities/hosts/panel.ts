import type { AppContext } from '../../context';
import { currentAgentSessionId, isSchedulerInvocation } from '../../agent/agentScope';
import { requestRendererOnce } from '../../ipc/rendererRequest';
import type { PanelSnapshot, PanelSnapshotResponse } from '../../../shared/panelState';
import type { PanelAxisFocusResponse, PanelCenterCloseResponse, PanelCenterFocusResponse, PanelCloseResponse, PanelFocusResponse, PanelOpenContent, PanelOpenResponse, PanelRightLayoutResponse, PanelSplitResponse } from '../../../shared/panelState';
import type { CenterFileBinding, CenterNavigationIdentity } from '../../../shared/panelState';
import { CENTER_SNAP_LAYOUTS, samePaneRef, type CenterSnapLayoutId, type SplitPaneRef } from '../../../shared/centerSplit';
import {
  normalizeRightPanelSplit, removeRightPanelSlot, rightPanelLayoutTabIds, sameRightPanelLayout, validateRightPanelSplit, type RightPanelLayout
} from '../../../shared/rightPanelLayout';
import type { BrowserWindow } from 'electron';
import type { WorkspaceFileRef } from '../../../shared/types';
import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadScope } from '../../browser/uploadScope';
import { withWorkspaceFileTarget } from '../../workspaceFileAccess';
import { pathInExecutionDirectories } from '../../workspaceExecutionContext';
import { requireSourceRoot, requireWorkspace, resolveRealPathInsideRoot } from '../../workspacePaths';
import { previewKindForPath } from '../../../shared/filePreview';
import { pathKey } from '../../pathKey';
import { RIGHT_UTILITY_IDS, RIGHT_UTILITY_TITLES, type RightUtilityId } from '../../../shared/rightWorkspace';
import type { TurnChangeOwner } from '../../../shared/turnChanges';
import { captureSchedulerWorkspaceContext } from '../../agent/schedulerWorkspaceContext';
import { MUSTER_EXT_SCHEME } from '../../../shared/protocolSchemes';

type PanelScope = ReturnType<typeof uploadScope>;

/** Navigation nodes require scope and instance binding across the renderer commit.
 * Until that bridge exists, do not let a raw nav id bypass extension checks. */
function assertCenterUtilityAvailable(sel: string): void {
  if (typeof sel !== 'string' || !sel.trim()) throw new Error('Utility target is required');
  if (sel.startsWith('nav:')) throw new Error('Center navigation authorization is not implemented');
  if (!(RIGHT_UTILITY_IDS as readonly string[]).includes(sel) && sel !== 'settings') throw new Error('Utility target is unavailable');
}

function assertCenterNavigationReadable(ctx: AppContext, scope: PanelScope, sel: string): void {
  if (!sel.startsWith('nav:')) return;
  const system = ctx.extensionSystem;
  if (!system) throw new Error('Center navigation is unavailable in the caller read scope');
  const nav = system.workbench.peek(scope.workspaceId);
  const root = requireSourceRoot(requireWorkspace(ctx.config.get(), scope.workspaceId), nav.sourceRootId);
  if (!pathInExecutionDirectories(root.path, scope.cwd, scope.dirs) ||
      !nav.nodes.some(node => node.id === sel.slice(4) && node.kind !== 'web')) {
    throw new Error('Center navigation is unavailable in the caller read scope');
  }
  scope.assertCurrent();
}

function centerNavigationIdentity(ctx: AppContext, scope: PanelScope, sel: string): { identity: CenterNavigationIdentity; current(): boolean } {
  assertCenterNavigationReadable(ctx, scope, sel);
  const system = ctx.extensionSystem!;
  const nav = system.workbench.peek(scope.workspaceId);
  const node = nav.nodes.find(item => item.id === sel.slice(4) && item.kind !== 'web');
  if (!node) throw new Error('Center navigation is unavailable');
  const identity = { sourceRootId: nav.sourceRootId, selectionRevision: nav.selectionRevision, revision: nav.revision, node: JSON.stringify(node) };
  return { identity, current: () => {
    assertCenterNavigationReadable(ctx, scope, sel);
    const next = ctx.extensionSystem === system ? system.workbench.peek(scope.workspaceId) : undefined;
    return !!next && next.sourceRootId === identity.sourceRootId && next.selectionRevision === identity.selectionRevision &&
      next.revision === identity.revision && JSON.stringify(next.nodes.find(item => item.id === sel.slice(4))) === identity.node;
  } };
}

function scopedExtension(ctx: AppContext, scope: PanelScope, nodeId: string, placement: 'tab' | 'any' = 'tab') {
  const system = ctx.extensionSystem;
  if (!system) throw new Error('Extension workbench is unavailable');
  const nav = system.workbench.peek(scope.workspaceId);
  const root = requireSourceRoot(requireWorkspace(ctx.config.get(), scope.workspaceId), nav.sourceRootId);
  if (!pathInExecutionDirectories(root.path, scope.cwd, scope.dirs)) throw new Error('Extension project is outside the caller read scope');
  const node = nav.nodes.find(item => item.id === nodeId && item.kind === 'extension');
  if (!node || node.kind !== 'extension' || (placement === 'tab' && node.placement !== 'tab')) throw new Error(placement === 'tab' ? 'Extension is not available as a right tab' : 'Extension is not available in the requested placement');
  scope.assertCurrent();
  return { system, nav, node };
}

async function assertCenterFileReadable(ctx: AppContext, scope: PanelScope, binding: CenterFileBinding): Promise<void> {
  if (!binding || typeof binding.tabId !== 'string' || !binding.tabId || binding.tabId.length > 256 || binding.sel !== `center-file:${binding.tabId}` ||
      typeof binding.content !== 'string' || binding.content.length > 16384 || typeof binding.pinned !== 'boolean' || typeof binding.centerOnly !== 'boolean') {
    throw new Error('Invalid center file identity');
  }
  let content: { kind?: unknown; path?: unknown; fileRef?: WorkspaceFileRef; external?: unknown; directory?: unknown };
  try { content = JSON.parse(binding.content); } catch { throw new Error('Invalid center file identity'); }
  if (!content || (content.kind !== 'file' && content.kind !== 'image') || typeof content.path !== 'string' || !content.fileRef ||
      content.fileRef.workspaceId !== scope.workspaceId || content.fileRef.relativePath !== content.path || content.external || content.directory) {
    throw new Error('Invalid center file identity');
  }
  await withWorkspaceFileTarget(() => ctx.config.get(), content.fileRef, '', async (_root, _ref, absolute) => {
    if (!pathInExecutionDirectories(absolute, scope.cwd, scope.dirs)) throw new Error('Center file is outside the caller read scope');
  });
  scope.assertCurrent();
}

function boundCenterFiles(snapshot: PanelSnapshot, panes: readonly SplitPaneRef[]): CenterFileBinding[] {
  return panes.flatMap(pane => {
    if (pane.kind !== 'utility' || !pane.sel.startsWith('center-file:')) return [];
    const matches = (snapshot.center.fileViews ?? []).filter(item => item.sel === pane.sel);
    if (matches.length !== 1) throw new Error('Center file identity is unavailable');
    return [{ ...matches[0]! }];
  });
}

/** File names are workspace data too: redact paths outside the caller's captured read scope. */
export async function redactPanelSnapshot(ctx: AppContext, snapshot: PanelSnapshot, scope: PanelScope): Promise<PanelSnapshot> {
  const fileViews = snapshot.center.fileViews ?? [];
  if (!Array.isArray(fileViews) || new Set(fileViews.map(item => item?.sel)).size !== fileViews.length) throw new Error('Invalid center file snapshot');
  for (const binding of fileViews) await assertCenterFileReadable(ctx, scope, binding);
  for (const pane of snapshot.center.panes) if (pane.kind === 'utility') assertCenterNavigationReadable(ctx, scope, pane.sel);
  for (const pane of snapshot.center.panes) if (pane.kind === 'utility' && pane.sel.startsWith('center-file:') && !fileViews.some(item => item.sel === pane.sel)) {
    throw new Error('Center file identity is unavailable');
  }
  if (snapshot.center.background !== undefined) {
    if (!Array.isArray(snapshot.center.background)) throw new Error('Invalid center background snapshot');
    const ids = new Set<string>();
    for (const item of snapshot.center.background) {
      if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !item.target) throw new Error('Invalid center background snapshot');
      ids.add(item.id);
      if (item.target.kind === 'utility') {
        if (!item.target.sel || typeof item.target.sel !== 'string') throw new Error('Invalid center background snapshot');
        if (item.target.sel.startsWith('nav:')) {
          const bound = centerNavigationIdentity(ctx, scope, item.target.sel);
          if (!item.navigation || JSON.stringify(bound.identity) !== JSON.stringify(item.navigation)) throw new Error('Center background navigation changed');
        } else if (item.target.sel.startsWith('center-file:')) {
          const sel = item.target.sel;
          if (item.navigation || !fileViews.some(binding => binding.sel === sel)) throw new Error('Center file identity is unavailable');
        } else {
          if (item.navigation) throw new Error('Invalid center background snapshot');
          assertCenterUtilityAvailable(item.target.sel);
        }
      } else if (item.target.kind === 'session') {
        if (item.navigation) throw new Error('Invalid center background snapshot');
        const session = ctx.sessions.get(item.target.sessionId);
        if (!session || session.type !== 'terminal' || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Center background session is unavailable');
      } else throw new Error('Invalid center background snapshot');
    }
  }
  const allowed = async (raw: string, ref?: WorkspaceFileRef): Promise<boolean> => {
    try {
      if (ref && ref.workspaceId !== scope.workspaceId) return false;
      if (!ref && (!raw || !path.isAbsolute(raw))) return false;
      return await withWorkspaceFileTarget(() => ctx.config.get(), ref ?? scope.workspaceId, raw,
        async (_root, _ref, absolute) => pathInExecutionDirectories(absolute, scope.cwd, scope.dirs));
    } catch { return false; }
  };
  const tabs = await Promise.all(snapshot.right.tabs.map(async tab => {
    const content = tab.content;
    let visible = true;
    if (content.kind === 'file' || content.kind === 'image') visible = await allowed(content.path, content.fileRef);
    else if (content.kind === 'git') visible = await allowed(content.repoPath);
    else if (content.kind === 'diff') visible = await allowed(content.repoPath) &&
      await allowed(path.resolve(content.repoPath, content.filePath));
    else if (content.kind === 'review') {
      const owner = content.owner;
      const session = owner.kind === 'gui' ? ctx.sessions.get(owner.id) : undefined;
      const entry = owner.kind === 'gui' ? ctx.agentSessions?.entries.get(owner.id) : undefined;
      const bucket = owner.kind === 'dispatch' ? ctx.orchestrator?.buckets.get(owner.id) : undefined;
      visible = owner.kind === 'gui'
        ? !!session && !session.archived && session.workspaceId === scope.workspaceId && !!entry && !entry.closed && entry.workspaceId === scope.workspaceId
        : owner.kind === 'dispatch' && owner.id === scope.workspaceId && !!bucket;
      if (visible && content.repoPath) visible = await allowed(content.repoPath);
      if (visible && content.filePath) {
        try {
          const cwd = entry?.cwd ?? (bucket ? captureSchedulerWorkspaceContext(ctx.config.get(), owner.id, bucket.piSession, bucket.piSessionFile, false, undefined, false).cwd : '');
          visible = !!cwd && !path.isAbsolute(content.filePath) && await allowed(path.resolve(cwd, content.filePath));
        } catch { visible = false; }
      }
    }
    else if (content.kind === 'extension') {
      try { scopedExtension(ctx, scope, content.nodeId); } catch { visible = false; }
    } else if (content.kind === 'web' && (/^file:/i.test(content.url) || content.url.toLowerCase().startsWith(`${MUSTER_EXT_SCHEME}:`))) visible = false;
    return visible ? tab : { ...tab, content: { kind: 'redacted' as const } };
  }));
  const editors = await Promise.all(snapshot.right.editors.map(async editor => {
    if (await allowed(editor.path, editor.fileRef)) return editor;
    const { fileRef: _fileRef, ...rest } = editor;
    return { ...rest, path: '[outside caller read scope]' };
  }));
  scope.assertCurrent();
  return { ...snapshot, right: { ...snapshot.right, tabs, editors } };
}

function requestPanelOpen(win: BrowserWindow, workspaceId: string, rootsRevision: number, content: PanelOpenContent, focus: boolean, signal?: AbortSignal): Promise<PanelOpenResponse> {
  return requestRendererOnce<PanelOpenResponse>(win, {
    requestChannel: 'panel:open-content-request', prefix: 'panel:open-content', timeoutMs: 5000, signal, requireSource: true,
    closedChannel: 'panel:open-content-closed',
    payload: { workspaceId, rootsRevision, focus, content },
    onTimeout: () => ({ ok: false, outcome: 'unknown', error: 'Panel open outcome is unknown; inspect the panel before retrying' }),
    map: raw => {
      const response = raw as Partial<PanelOpenResponse> | null;
      if (response?.ok === false && typeof response.error === 'string') return response as PanelOpenResponse;
      if (response?.ok === true && typeof response.tabId === 'string' && typeof response.existing === 'boolean' && typeof response.selected === 'boolean') return response as PanelOpenResponse;
      return { ok: false, outcome: 'unknown', error: 'Invalid panel open response; inspect the panel before retrying' };
    }
  });
}

/** Internal read-only bridge. Tool projection and mutation actions are not registered yet. */
export async function readPanelSnapshot(ctx: AppContext, signal?: AbortSignal): Promise<PanelSnapshotResponse> {
  const actorId = currentAgentSessionId();
  const session = actorId ? ctx.sessions.get(actorId) : undefined;
  const workspaceId = isSchedulerInvocation() ? ctx.resolveBubbleWorkspaceId() :
    session && !session.archived ? session.workspaceId : undefined;
  if (!workspaceId) throw new Error('Panel snapshot requires an authenticated workspace');
  const scope = uploadScope(ctx, workspaceId, 'Panel snapshot');
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  const result = await requestRendererOnce<PanelSnapshotResponse>(win, {
    requestChannel: 'panel:snapshot-request', prefix: 'panel:snapshot', payload: { workspaceId },
    timeoutMs: 5000, signal, requireSource: true,
    onTimeout: () => ({ ok: false, error: 'Panel snapshot unavailable or timed out' }),
    map: raw => {
      const payload = raw as Partial<PanelSnapshotResponse> | null;
      if (payload?.ok === false && typeof payload.error === 'string') return { ok: false, error: payload.error };
      if (payload?.ok !== true || !payload.snapshot || payload.snapshot.workspaceId !== workspaceId ||
          payload.snapshot.right?.workspaceId !== workspaceId || !Array.isArray(payload.snapshot.center?.panes) ||
          !Array.isArray(payload.snapshot.right?.tabs) || !Array.isArray(payload.snapshot.right?.editors)) {
        return { ok: false, error: 'Invalid panel snapshot or workspace changed' };
      }
      const right = payload.snapshot.right;
      if (right.split != null) {
        try {
          validateRightPanelSplit(right.split);
          if (!right.selectedTabId || !right.split.tabIds.includes(right.selectedTabId) ||
              right.split.tabIds.some(id => id !== null && right.tabs.filter(tab => tab.id === id).length !== 1)) {
            throw new Error('Invalid right split tab binding');
          }
        } catch {
          return { ok: false, error: 'Invalid right split snapshot' };
        }
      }
      if (actorId && (!ctx.sessions.get(actorId) || ctx.sessions.get(actorId)?.archived || ctx.sessions.get(actorId)?.workspaceId !== workspaceId)) {
        return { ok: false, error: 'Panel caller identity or workspace changed' };
      }
      return { ok: true, snapshot: payload.snapshot };
    }
  });
  if (!result.ok) return result;
  return { ok: true, snapshot: await redactPanelSnapshot(ctx, result.snapshot, scope) };
}

export async function openPanelFile(ctx: AppContext, args: { workspaceId?: string; fileRef?: WorkspaceFileRef; path?: string; line?: number; focus?: boolean; placement?: 'center' | 'right' }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (args?.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('focus must be a boolean');
  if (args?.placement !== undefined && args.placement !== 'center' && args.placement !== 'right') throw new Error('Invalid panel placement');
  if (args?.line !== undefined && (!Number.isSafeInteger(args.line) || args.line < 1)) throw new Error('line must be a positive integer');
  if (args?.fileRef && args.fileRef.workspaceId !== scope.workspaceId) throw new Error('File reference is outside the caller workspace');
  if (!args?.fileRef && (typeof args?.path !== 'string' || !args.path.trim())) throw new Error('File path or fileRef is required');
  if (args?.fileRef && args?.path !== undefined) throw new Error('Specify either path or fileRef, not both');
  signal?.throwIfAborted();
  const workspace = requireWorkspace(ctx.config.get(), scope.workspaceId);
  const rootsRevision = workspace.rootsRevision ?? 0;
  const legacyPath = args.fileRef ? '' : path.resolve(scope.cwd, args.path!);
  let dispatched = false;
  try {
    return await withWorkspaceFileTarget(() => ctx.config.get(), args.fileRef ?? scope.workspaceId, legacyPath,
      async (_root, ref, absolutePath) => {
        scope.assertCurrent();
        if (!pathInExecutionDirectories(absolutePath, scope.cwd, scope.dirs)) throw new Error('Panel file is outside the caller read scope');
        if (!(await fs.stat(absolutePath)).isFile()) throw new Error('Panel file is not a regular file');
        scope.assertCurrent(); signal?.throwIfAborted();
        const win = ctx.getWindow();
        if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
        dispatched = true;
        const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision,
          { kind: previewKindForPath(ref.relativePath) === 'image' ? 'image' : 'file', path: ref.relativePath, fileRef: ref,
            ...(args.line === undefined ? {} : { line: args.line }), ...(args.placement === 'center' ? { placement: 'center' as const } : {}) }, args.focus === true, signal);
        scope.assertCurrent();
        return result;
      });
  } catch (error) {
    if (dispatched) return { ok: false, outcome: 'unknown', error: `File open outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
    throw error;
  }
}

export async function openPanelSettings(ctx: AppContext, args: { workspaceId?: string; focus?: boolean; placement?: 'center' | 'right' }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (args?.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('focus must be a boolean');
  if (args?.placement !== undefined && args.placement !== 'center' && args.placement !== 'right') throw new Error('Invalid panel placement');
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'settings', ...(args.placement === 'right' ? { placement: 'right' } : {}) }, args.focus === true, signal);
    scope.assertCurrent();
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Settings open outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
  }
}

export async function openPanelUtility(ctx: AppContext, args: { workspaceId?: string; sel: string; focus?: boolean; placement?: 'center' | 'right' }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (args.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('focus must be a boolean');
  if (args.placement !== undefined && args.placement !== 'center' && args.placement !== 'right') throw new Error('Invalid panel placement');
  // Settings needs the dedicated preparation/dirty-state bridge; a generic
  // utility request must not produce an empty or unguarded settings tab.
  if (args.sel === 'settings' || !(RIGHT_UTILITY_IDS as readonly string[]).includes(args.sel)) throw new Error('Utility is not available');
  const sel = args.sel as RightUtilityId;
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'utility', sel, title: RIGHT_UTILITY_TITLES[sel], ...(args.placement === 'center' ? { placement: 'center' } : {}) }, args.focus === true, signal);
    scope.assertCurrent(); return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Utility open outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

export async function openPanelSession(ctx: AppContext, args: { workspaceId?: string; sessionId: string; focus?: boolean; placement?: 'center' | 'right' }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (args.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('focus must be a boolean');
  if (args.placement !== undefined && args.placement !== 'center' && args.placement !== 'right') throw new Error('Invalid panel placement');
  if (typeof args.sessionId !== 'string' || !args.sessionId.trim()) throw new Error('sessionId is required');
  const id = ctx.sessions.resolveSessionRef({ sessionId: args.sessionId }).id;
  const session = ctx.sessions.get(id);
  if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Session is not available in the caller workspace');
  if (args.placement === 'center' && session.type !== 'terminal') throw new Error('Session cannot be placed in the center');
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'session', sessionId: id, title: session.name, ...(args.placement === 'center' ? { placement: 'center' } : {}) }, args.focus === true, signal);
    scope.assertCurrent();
    const current = ctx.sessions.get(id);
    if (!current || current.archived || current.workspaceId !== scope.workspaceId || (args.placement === 'center' && current.type !== 'terminal')) throw new Error('Session target is no longer current');
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Session open outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

async function resolvePanelRepo(ctx: AppContext, scope: PanelScope, repoPath: string): Promise<string> {
  if (typeof repoPath !== 'string' || !repoPath.trim()) throw new Error('repoPath is required');
  const requested = path.resolve(scope.cwd, repoPath);
  if (!pathInExecutionDirectories(requested, scope.cwd, scope.dirs)) throw new Error('Repository is outside the caller read scope');
  const physical = await fs.realpath(requested);
  if (!pathInExecutionDirectories(physical, scope.cwd, scope.dirs) || !(await fs.stat(physical)).isDirectory()) {
    throw new Error('Repository is outside the caller read scope or is not a directory');
  }
  const repositories = await ctx.git.listRepos(false, [], scope.workspaceId);
  const matched = repositories.find(repo => pathKey(repo.path) === pathKey(requested));
  if (!matched || pathKey(await fs.realpath(matched.path)) !== pathKey(physical)) throw new Error('Repository is not registered in this workspace');
  scope.assertCurrent();
  return matched.path;
}

export async function openPanelGit(ctx: AppContext, args: { workspaceId?: string; repoPath: string; focus?: boolean }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (args.focus !== undefined && typeof args.focus !== 'boolean') throw new Error('focus must be a boolean');
  const repoPath = await resolvePanelRepo(ctx, scope, args?.repoPath);
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'git', repoPath }, args.focus === true, signal);
    scope.assertCurrent();
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Panel open outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
  }
}

export async function openPanelDiff(ctx: AppContext, args: { workspaceId?: string; repoPath: string; filePath: string; staged: boolean; untracked?: boolean; focus?: boolean }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (typeof args?.filePath !== 'string' || !args.filePath.trim() || path.isAbsolute(args.filePath) ||
      typeof args.staged !== 'boolean' || (args.untracked !== undefined && typeof args.untracked !== 'boolean') ||
      (args.focus !== undefined && typeof args.focus !== 'boolean')) throw new Error('Invalid diff target');
  const repoPath = await resolvePanelRepo(ctx, scope, args.repoPath);
  const absolute = path.resolve(repoPath, args.filePath), relative = path.relative(repoPath, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      !pathInExecutionDirectories(absolute, scope.cwd, scope.dirs)) throw new Error('Diff file is outside the repository or caller read scope');
  await resolveRealPathInsideRoot(repoPath, absolute);
  await withWorkspaceFileTarget(() => ctx.config.get(), scope.workspaceId, absolute, async (_root, _ref, target) => {
    if (!pathInExecutionDirectories(target, scope.cwd, scope.dirs)) throw new Error('Diff file is outside the caller read scope');
  });
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'diff', repoPath,
      filePath: relative.split(path.sep).join('/'), staged: args.staged, ...(args.untracked === undefined ? {} : { untracked: args.untracked }) }, args.focus === true, signal);
    scope.assertCurrent(); return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Panel open outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

export async function openPanelReview(ctx: AppContext, args: { workspaceId?: string; owner: TurnChangeOwner; messageId?: string; repoPath?: string; filePath?: string; focus?: boolean }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  const owner = args?.owner;
  if (!owner || (owner.kind !== 'gui' && owner.kind !== 'dispatch') || typeof owner.id !== 'string' || !owner.id.trim() ||
      (args.messageId !== undefined && (typeof args.messageId !== 'string' || !args.messageId.trim())) ||
      (args.filePath !== undefined && (typeof args.filePath !== 'string' || !args.filePath.trim())) ||
      (args.focus !== undefined && typeof args.focus !== 'boolean')) throw new Error('Invalid review target');
  const host = ctx.agentSessions;
  const session = owner.kind === 'gui' ? ctx.sessions.get(owner.id) : undefined;
  const entry = owner.kind === 'gui' ? host?.entries.get(owner.id) : undefined;
  const orchestrator = ctx.orchestrator;
  const bucket = owner.kind === 'dispatch' ? orchestrator?.buckets.get(owner.id) : undefined;
  if (owner.kind === 'gui' && (!session || session.archived || session.workspaceId !== scope.workspaceId || !entry || entry.closed || entry.workspaceId !== scope.workspaceId) ||
      owner.kind === 'dispatch' && (owner.id !== scope.workspaceId || !bucket)) throw new Error('Review owner is not available in the caller workspace');
  const messages = entry?.messages ?? bucket?.display ?? [];
  const selected = args.messageId ? messages.find(m => m.id === args.messageId && m.role === 'assistant' && m.turnChanges)
    : [...messages].reverse().find(m => m.role === 'assistant' && m.turnChanges);
  const selectedChanges = selected?.turnChanges;
  const selectedSnapshotId = selectedChanges?.id;
  if (args.messageId && !selected) throw new Error('Review message is unavailable');
  if (args.filePath && (!selected?.turnChanges || !selected.turnChanges.files.some(file => file.path === args.filePath))) throw new Error('Review file is unavailable in this turn');
  const isCurrent = (): boolean => {
    scope.assertCurrent();
    if (owner.kind === 'gui' && (ctx.agentSessions !== host || host?.entries.get(owner.id) !== entry || entry?.closed ||
        ctx.sessions.get(owner.id) !== session || session?.archived || session?.workspaceId !== scope.workspaceId) ||
        owner.kind === 'dispatch' && (ctx.orchestrator !== orchestrator || orchestrator?.buckets.get(owner.id) !== bucket)) return false;
    const current = entry?.messages ?? bucket?.display ?? [];
    const sameChanges = !selected || selected.turnChanges === selectedChanges && selectedChanges?.id === selectedSnapshotId &&
      (!args.filePath || !!selectedChanges?.files.some(file => file.path === args.filePath));
    if (!sameChanges) return false;
    if (args.messageId) return !!selected && current.includes(selected as never);
    return [...current].reverse().find(m => m.role === 'assistant' && m.turnChanges) === selected;
  };
  const repoPath = args.repoPath === undefined ? undefined : await resolvePanelRepo(ctx, scope, args.repoPath);
  if (repoPath && selected?.turnChanges?.repository?.root && pathKey(repoPath) !== pathKey(selected.turnChanges.repository.root)) {
    throw new Error('Review repository does not match the selected turn');
  }
  if (args.filePath) {
    const ownerCwd = entry?.cwd ?? (bucket ? captureSchedulerWorkspaceContext(ctx.config.get(), owner.id, bucket.piSession, bucket.piSessionFile, false, undefined, false).cwd : '');
    if (!ownerCwd || path.isAbsolute(args.filePath)) throw new Error('Invalid review file path');
    const absolute = path.resolve(ownerCwd, args.filePath);
    if (!pathInExecutionDirectories(absolute, scope.cwd, scope.dirs)) throw new Error('Review file is outside the caller read scope');
    await withWorkspaceFileTarget(() => ctx.config.get(), scope.workspaceId, absolute, async (_root, _ref, target) => {
      if (!pathInExecutionDirectories(target, scope.cwd, scope.dirs)) throw new Error('Review file is outside the caller read scope');
    });
  }
  if (!isCurrent()) throw new Error('Review owner or turn changed');
  signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'review', owner: { ...owner },
      ...(args.messageId ? { messageId: args.messageId } : {}), ...(repoPath ? { repoPath } : {}),
      ...(args.filePath ? { filePath: args.filePath } : {}) }, args.focus === true, signal);
    if (!isCurrent()) throw new Error('Review owner or turn changed');
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Review open outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
  }
}

/** Present an already projected browser tab; never create, navigate, mount or close its guest. */
export async function openPanelBrowser(ctx: AppContext, args: { workspaceId?: string; browserId: string; focus?: boolean }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (typeof args?.browserId !== 'string' || !args.browserId.trim() || (args.focus !== undefined && typeof args.focus !== 'boolean')) {
    throw new Error('Invalid browser target');
  }
  const browser = ctx.browser;
  const tab = browser?.inspectExistingTab(args.browserId);
  if (!browser || !tab || tab.workspaceId !== scope.workspaceId || (tab.scope !== 'workspace' && tab.scope !== 'session') ||
      tab.scope === 'session' && !tab.sessionId) throw new Error('Browser tab is not available in the caller workspace');
  const current = (): boolean => {
    scope.assertCurrent();
    const next = ctx.browser === browser ? browser.inspectExistingTab(args.browserId) : null;
    return !!next && next.workspaceId === tab.workspaceId && next.sessionId === tab.sessionId && next.scope === tab.scope && next.url === tab.url;
  };
  signal?.throwIfAborted();
  if (args.focus === true && tab.scope === 'session' && tab.sessionId && tab.sessionId === currentAgentSessionId() && /^https?:/i.test(tab.url)) {
    const win = ctx.getWindow();
    if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
    const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
    try {
      const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'web', browserId: tab.id,
        url: tab.url, title: tab.title, ownerSessionId: tab.sessionId }, true, signal);
      scope.assertCurrent();
      const next = browser.inspectExistingTab(tab.id);
      if (ctx.browser !== browser || !next || next.workspaceId !== tab.workspaceId || next.sessionId !== tab.sessionId || next.url !== tab.url ||
          (next.scope !== 'session' && next.scope !== 'workspace')) throw new Error('Browser tab changed');
      return result;
    } catch (error) {
      return { ok: false, outcome: 'unknown', error: `Browser presentation outcome may be unknown; inspect before retrying: ${String(error)}` };
    }
  }
  const snapshot = await readPanelSnapshot(ctx, signal);
  if (!snapshot.ok) throw new Error(snapshot.error);
  const matches = snapshot.snapshot.right.tabs.filter(item => item.content.kind === 'web' && item.content.browserId === args.browserId);
  if (matches.length !== 1 || matches[0].content.kind !== 'web' || matches[0].content.url !== tab.url || !current()) {
    throw new Error('Browser tab is not visible or its identity changed');
  }
  const view = matches[0];
  if (!args.focus) return { ok: true, tabId: view.id, existing: true, selected: snapshot.snapshot.right.selectedTabId === view.id };
  try {
    const result = await focusPanelTab(ctx, { workspaceId: scope.workspaceId, tabId: view.id }, signal);
    if (!current()) throw new Error('Browser tab changed');
    if (!result.ok) return result;
    return { ok: true, tabId: view.id, existing: true, selected: true };
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Browser focus outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
  }
}

/** Reuse the existing surface; opening a new placement would move the user's only instance. */
export async function openPanelExtension(ctx: AppContext, args: { workspaceId?: string; nodeId: string; focus?: boolean; placement?: 'center' | 'right' }, signal?: AbortSignal): Promise<PanelOpenResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (typeof args?.nodeId !== 'string' || !args.nodeId.trim() || (args.focus !== undefined && typeof args.focus !== 'boolean')) {
    throw new Error('Invalid extension target');
  }
  if (args.placement !== undefined && args.placement !== 'center' && args.placement !== 'right') throw new Error('Invalid panel placement');
  const initial = scopedExtension(ctx, scope, args.nodeId, args.placement === 'center' ? 'any' : 'tab');
  if (args.placement === 'center') {
    if (args.focus && (initial.node.placement === 'tab' || initial.node.placement === 'window')) throw new Error('Extension must be moved to the center by the user first');
    const navigation = centerNavigationIdentity(ctx, scope, `nav:${args.nodeId}`);
    const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
    const win = ctx.getWindow();
    if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
    scope.assertCurrent(); signal?.throwIfAborted();
    try {
      const result = await requestPanelOpen(win, scope.workspaceId, rootsRevision, { kind: 'extension', nodeId: args.nodeId,
        title: initial.node.title, placement: 'center', navigation: navigation.identity }, args.focus === true, signal);
      scope.assertCurrent();
      if (!navigation.current()) throw new Error('Extension navigation changed');
      return result;
    } catch (error) {
      return { ok: false, outcome: 'unknown', error: `Extension open outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
    }
  }
  const current = (): boolean => {
    const next = scopedExtension(ctx, scope, args.nodeId);
    return next.system === initial.system && next.nav.sourceRootId === initial.nav.sourceRootId &&
      next.nav.selectionRevision === initial.nav.selectionRevision && next.nav.revision === initial.nav.revision &&
      next.node.extensionId === initial.node.extensionId && next.node.viewId === initial.node.viewId && next.node.title === initial.node.title;
  };
  signal?.throwIfAborted();
  const snapshot = await readPanelSnapshot(ctx, signal);
  if (!snapshot.ok) throw new Error(snapshot.error);
  const matches = snapshot.snapshot.right.tabs.filter(item => item.content.kind === 'extension' && item.content.nodeId === args.nodeId);
  if (matches.length !== 1 || matches[0].content.kind !== 'extension' || matches[0].content.title !== initial.node.title || !current()) {
    throw new Error('Extension tab is not visible or its identity changed');
  }
  const view = matches[0];
  if (!args.focus) return { ok: true, tabId: view.id, existing: true, selected: snapshot.snapshot.right.selectedTabId === view.id };
  try {
    const result = await focusPanelTab(ctx, { workspaceId: scope.workspaceId, tabId: view.id }, signal);
    if (!current()) throw new Error('Extension tab changed');
    if (!result.ok) return result;
    return { ok: true, tabId: view.id, existing: true, selected: true };
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Extension focus outcome may be unknown; inspect the panel before retrying: ${String(error)}` };
  }
}

type PanelTabResult = PanelCloseResponse | PanelFocusResponse;
async function panelTabAction(ctx: AppContext, args: { workspaceId?: string; tabId: string }, action: 'close' | 'focus', signal?: AbortSignal): Promise<PanelTabResult> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (typeof args?.tabId !== 'string' || !args.tabId.trim()) throw new Error('tabId is required');
  scope.assertCurrent(); signal?.throwIfAborted();
  const snapshot = await readPanelSnapshot(ctx, signal);
  if (!snapshot.ok) throw new Error(snapshot.error);
  const tab = snapshot.snapshot.right.tabs.find(item => item.id === args.tabId);
  const background = snapshot.snapshot.center.background?.find(item => item.id === args.tabId);
  const settings = args.tabId === 'settings' && snapshot.snapshot.settings?.prepared;
  if ([!!settings, !!tab, !!background].filter(Boolean).length > 1) throw new Error('Panel tab identity is ambiguous');
  if (!settings && !background && (!tab || tab.content.kind === 'redacted')) throw new Error('Panel tab is unavailable in the caller read scope');
  let backgroundNavigation: ReturnType<typeof centerNavigationIdentity> | undefined;
  let backgroundFile: CenterFileBinding | undefined;
  if (background?.target.kind === 'utility') {
    if (background.target.sel.startsWith('nav:')) {
      backgroundNavigation = centerNavigationIdentity(ctx, scope, background.target.sel);
      if (!background.navigation || JSON.stringify(backgroundNavigation.identity) !== JSON.stringify(background.navigation)) throw new Error('Center background navigation changed');
    } else if (background.target.sel.startsWith('center-file:')) {
      backgroundFile = boundCenterFiles(snapshot.snapshot, [background.target])[0];
      if (action === 'focus' && backgroundFile?.pinned) throw new Error('Pinned file cannot be moved from the right panel');
    } else assertCenterUtilityAvailable(background.target.sel);
  }
  if (settings && action === 'close' && snapshot.snapshot.settings?.dirty) throw new Error('Cannot close settings with unsaved changes');
  if (tab?.content.kind === 'utility' && tab.content.sel === 'settings' && action === 'close' && snapshot.snapshot.settings?.dirty) {
    throw new Error('Cannot close settings with unsaved changes');
  }
  if (settings && action === 'focus') {
    const result = await openPanelSettings(ctx, { workspaceId: scope.workspaceId, focus: true }, signal);
    if (!result.ok) return result;
    return result.tabId === 'settings' && result.selected ? { ok: true, tabId: 'settings', selected: true }
      : { ok: false, outcome: 'unknown', error: 'Settings focus was not confirmed; inspect before retrying' };
  }
  const expectedContent = settings ? JSON.stringify({ kind: 'settings' }) : background
    ? JSON.stringify({ kind: 'center-background', target: background.target, ...(background.navigation ? { navigation: background.navigation } : {}), ...(backgroundFile ? { file: backgroundFile } : {}) }) : JSON.stringify(tab!.content);
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  const unknown = (message: string): PanelTabResult => ({ ok: false, outcome: 'unknown', error: message });
  try {
    const result = await requestRendererOnce<PanelTabResult>(win, {
      requestChannel: `panel:${action}-tab-request`, prefix: `panel:${action}-tab`, timeoutMs: 5000, signal, requireSource: true,
      closedChannel: `panel:${action}-tab-closed`,
      payload: { workspaceId: scope.workspaceId, rootsRevision, tabId: args.tabId, expectedContent },
      onTimeout: () => unknown(`Panel ${action} outcome is unknown; inspect before retrying`),
      map: raw => {
        const response = raw as { ok?: boolean; error?: unknown; tabId?: unknown; closed?: unknown; selected?: unknown } | null;
        if (response?.ok === false && typeof response.error === 'string') return response as PanelTabResult;
        if (response?.ok === true && response.tabId === args.tabId &&
            (action === 'close' ? response.closed === true : response.selected === true)) return response as PanelTabResult;
        return unknown(`Invalid panel ${action} response; inspect before retrying`);
      }
    });
    scope.assertCurrent();
    if (backgroundNavigation && !backgroundNavigation.current()) throw new Error('Center background navigation changed');
    if (backgroundFile) await assertCenterFileReadable(ctx, scope, backgroundFile);
    if (background?.target.kind === 'session') {
      const session = ctx.sessions.get(background.target.sessionId);
      if (!session || session.type !== 'terminal' || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Center background session is no longer current');
    }
    return result;
  } catch (error) {
    return unknown(`Panel ${action} outcome may be unknown; inspect before retrying: ${String(error)}`);
  }
}

export async function closePanelTab(ctx: AppContext, args: { workspaceId?: string; tabId: string }, signal?: AbortSignal): Promise<PanelCloseResponse> {
  return await panelTabAction(ctx, args, 'close', signal) as PanelCloseResponse;
}
export async function focusPanelTab(ctx: AppContext, args: { workspaceId?: string; tabId: string }, signal?: AbortSignal): Promise<PanelFocusResponse> {
  return await panelTabAction(ctx, args, 'focus', signal) as PanelFocusResponse;
}

export async function closePanelCenter(ctx: AppContext, args: { workspaceId?: string; slot?: number; target?: Exclude<SplitPaneRef, { kind: 'empty' }> }, signal?: AbortSignal): Promise<PanelCenterCloseResponse> {
  if (!args || typeof args !== 'object') throw new Error('Center close parameters are required');
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if ((args.slot === undefined) === (args.target === undefined)) throw new Error('Choose exactly one center slot or target');
  if (args.slot !== undefined && (!Number.isInteger(args.slot) || args.slot < 0 || args.slot > 2)) throw new Error('Invalid center slot');
  let target = args.target;
  if (target?.kind === 'session') {
    const id = ctx.sessions.resolveSessionRef({ sessionId: target.sessionId }).id;
    const session = ctx.sessions.get(id);
    if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Session is not available in the caller workspace');
    target = { kind: 'session', sessionId: id };
  } else if (target) {
    if (target.kind !== 'utility') throw new Error('Invalid center target');
    if (typeof target.sel !== 'string' || !target.sel.trim()) throw new Error('Utility target is required');
    if (!target.sel.startsWith('nav:') && !target.sel.startsWith('center-file:')) assertCenterUtilityAvailable(target.sel);
  }
  const snapshot = await readPanelSnapshot(ctx, signal);
  if (!snapshot.ok) return snapshot;
  if (snapshot.snapshot.workspaceId !== scope.workspaceId) throw new Error('Panel workspace changed');
  const panes = snapshot.snapshot.center.panes;
  const slot = args.slot ?? panes.findIndex(pane => target && samePaneRef(pane, target));
  if (slot < 0 || slot > 2 || !panes[slot] || panes[slot].kind === 'empty') throw new Error('Center target is not visible');
  if (panes.filter(pane => pane.kind !== 'empty').length < 2) throw new Error('The final center view cannot be closed');
  const expected = panes[slot] as Exclude<SplitPaneRef, { kind: 'empty' }>;
  if (expected.kind === 'utility' && !expected.sel.startsWith('nav:') && !expected.sel.startsWith('center-file:')) assertCenterUtilityAvailable(expected.sel);
  const files = boundCenterFiles(snapshot.snapshot, panes);
  const navigation = panes.flatMap(pane => pane.kind === 'utility' && pane.sel.startsWith('nav:')
    ? [{ sel: pane.sel, ...centerNavigationIdentity(ctx, scope, pane.sel) }] : []);
  const assertTargetCurrent = (): void => {
    if (expected.kind !== 'session') return;
    const session = ctx.sessions.get(expected.sessionId);
    if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Center session is no longer available');
  };
  assertTargetCurrent();
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestRendererOnce<PanelCenterCloseResponse>(win, {
      requestChannel: 'panel:close-center-request', prefix: 'panel:close-center', timeoutMs: 5000, signal, requireSource: true,
      closedChannel: 'panel:close-center-closed', payload: { workspaceId: scope.workspaceId, rootsRevision, slot, panes,
        ...(navigation.length ? { navigation: navigation.map(item => ({ sel: item.sel, ...item.identity })) } : {}), ...(files.length ? { files } : {}) },
      onTimeout: () => ({ ok: false, outcome: 'unknown', error: 'Center close outcome is unknown; inspect before retrying' }),
      map: raw => {
        const response = raw as Partial<PanelCenterCloseResponse> | null;
        if (response?.ok === false && typeof response.error === 'string') return response as PanelCenterCloseResponse;
        if (response?.ok === true && response.closed === true && response.target && samePaneRef(response.target, expected)) return response as PanelCenterCloseResponse;
        return { ok: false, outcome: 'unknown', error: 'Invalid center close response; inspect before retrying' };
      }
    });
    scope.assertCurrent();
    assertTargetCurrent();
    if (navigation.some(item => !item.current())) throw new Error('Center navigation changed');
    for (const file of files) await assertCenterFileReadable(ctx, scope, file);
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Center close outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

export async function focusPanelAxis(ctx: AppContext, args: { workspaceId?: string; page: 'terminal' | 'git' }, signal?: AbortSignal): Promise<PanelAxisFocusResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  if (args?.page !== 'terminal' && args?.page !== 'git') throw new Error('page must be terminal or git');
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestRendererOnce<PanelAxisFocusResponse>(win, {
      requestChannel: 'panel:focus-axis-request', prefix: 'panel:focus-axis', timeoutMs: 5000, signal, requireSource: true,
      closedChannel: 'panel:focus-axis-closed',
      payload: { workspaceId: scope.workspaceId, rootsRevision, page: args.page },
      onTimeout: () => ({ ok: false, outcome: 'unknown', error: 'Page selection outcome is unknown; inspect before retrying' }),
      map: raw => {
        const response = raw as Partial<PanelAxisFocusResponse> | null;
        if (response?.ok === false && typeof response.error === 'string') return response as PanelAxisFocusResponse;
        if (response?.ok === true && response.page === args.page) return response as PanelAxisFocusResponse;
        return { ok: false, outcome: 'unknown', error: 'Invalid page selection response; inspect before retrying' };
      }
    });
    scope.assertCurrent();
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Page selection outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

export async function focusPanelCenter(ctx: AppContext, args: { workspaceId?: string; target: Exclude<SplitPaneRef, { kind: 'empty' }> }, signal?: AbortSignal): Promise<PanelCenterFocusResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  const target = args?.target;
  if (!target || (target.kind !== 'session' && target.kind !== 'utility')) throw new Error('Invalid center target');
  let normalized: Exclude<SplitPaneRef, { kind: 'empty' }>;
  let navigation: ReturnType<typeof centerNavigationIdentity> | undefined;
  if (target.kind === 'session') {
    if (typeof target.sessionId !== 'string' || !target.sessionId.trim()) throw new Error('sessionId is required');
    const id = ctx.sessions.resolveSessionRef({ sessionId: target.sessionId }).id;
    const session = ctx.sessions.get(id);
    if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Session is not available in the caller workspace');
    normalized = { kind: 'session', sessionId: id };
  } else {
    if (typeof target.sel !== 'string' || !target.sel.trim()) throw new Error('Utility target is required');
    if (target.sel.startsWith('nav:')) navigation = centerNavigationIdentity(ctx, scope, target.sel);
    else if (!target.sel.startsWith('center-file:')) assertCenterUtilityAvailable(target.sel);
    normalized = { kind: 'utility', sel: target.sel };
  }
  const before = await readPanelSnapshot(ctx, signal);
  if (!before.ok) return before;
  if (!before.snapshot.center.panes.some(pane => samePaneRef(pane, normalized))) throw new Error('Requested center pane is not visible');
  const files = boundCenterFiles(before.snapshot, [normalized]);
  if (files.some(file => file.pinned)) throw new Error('Pinned file cannot be moved from the right panel');
  if (before.snapshot.settings?.visible && before.snapshot.settings.dirty && !(normalized.kind === 'utility' && normalized.sel === 'settings')) {
    throw new Error('Cannot change the visible panel while settings have unsaved changes');
  }
  if (before.snapshot.right.tabs.some(tab => tab.deferredDock !== true && (tab.content.kind === 'session' && normalized.kind === 'session' && tab.content.sessionId === normalized.sessionId ||
      tab.content.kind === 'utility' && normalized.kind === 'utility' && tab.content.sel === normalized.sel) ||
      tab.content.kind === 'extension' && normalized.kind === 'utility' && normalized.sel === `nav:${tab.content.nodeId}`)) {
    throw new Error('Center target may be docked in the right panel; inspect or release it first');
  }
  try {
    const axis = await focusPanelAxis(ctx, { workspaceId: scope.workspaceId, page: 'terminal' }, signal);
    if (!axis.ok) return axis;
    scope.assertCurrent(); signal?.throwIfAborted();
    if (navigation && !navigation.current()) throw new Error('Center navigation changed');
    for (const file of files) await assertCenterFileReadable(ctx, scope, file);
    const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
    const win = ctx.getWindow();
    if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
    const result = await requestRendererOnce<PanelCenterFocusResponse>(win, {
      requestChannel: 'panel:focus-center-request', prefix: 'panel:focus-center', timeoutMs: 5000, signal, requireSource: true,
      closedChannel: 'panel:focus-center-closed',
      payload: { workspaceId: scope.workspaceId, rootsRevision, target: normalized, ...(navigation ? { navigation: navigation.identity } : {}), ...(files.length ? { file: files[0] } : {}) },
      onTimeout: () => ({ ok: false, outcome: 'unknown', error: 'Center focus outcome is unknown; inspect before retrying' }),
      map: raw => {
        const response = raw as Partial<PanelCenterFocusResponse> | null;
        if (response?.ok === false && typeof response.error === 'string') return response as PanelCenterFocusResponse;
        if (response?.ok === true && JSON.stringify(response.target) === JSON.stringify(normalized) &&
            (response.slot === 0 || response.slot === 1 || response.slot === 2)) return response as PanelCenterFocusResponse;
        return { ok: false, outcome: 'unknown', error: 'Invalid center focus response; inspect before retrying' };
      }
    });
    scope.assertCurrent();
    if (navigation && !navigation.current()) throw new Error('Center navigation changed');
    for (const file of files) await assertCenterFileReadable(ctx, scope, file);
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Center focus outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

export async function splitPanel(ctx: AppContext, args: { workspaceId?: string; panes: Exclude<SplitPaneRef, { kind: 'empty' }>[]; layoutId: CenterSnapLayoutId }, signal?: AbortSignal): Promise<PanelSplitResponse> {
  const scope = uploadScope(ctx, args?.workspaceId, 'Panel');
  const layout = CENTER_SNAP_LAYOUTS.find(item => item.id === args?.layoutId);
  if (!layout || !Array.isArray(args?.panes) || args.panes.length !== layout.cells.length) throw new Error('Invalid split layout or pane count');
  const panes = args.panes.map(target => {
    if (!target || (target.kind !== 'session' && target.kind !== 'utility')) throw new Error('Invalid split target');
    if (target.kind === 'utility') {
      if (typeof target.sel !== 'string' || !target.sel.trim()) throw new Error('Utility target is required');
      if (!target.sel.startsWith('nav:') && !target.sel.startsWith('center-file:')) assertCenterUtilityAvailable(target.sel);
      return { kind: 'utility' as const, sel: target.sel };
    }
    if (typeof target.sessionId !== 'string' || !target.sessionId.trim()) throw new Error('sessionId is required');
    const id = ctx.sessions.resolveSessionRef({ sessionId: target.sessionId }).id;
    const session = ctx.sessions.get(id);
    if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Session is not available in the caller workspace');
    return { kind: 'session' as const, sessionId: id };
  });
  if (panes.some((target, index) => panes.slice(0, index).some(other => samePaneRef(target, other)))) throw new Error('Duplicate split target');
  let files: CenterFileBinding[] = [];
  if (panes.some(pane => pane.kind === 'utility' && pane.sel.startsWith('center-file:'))) {
    const snapshot = await readPanelSnapshot(ctx, signal);
    if (!snapshot.ok) return snapshot;
    files = boundCenterFiles(snapshot.snapshot, panes);
    if (files.some(file => file.pinned)) throw new Error('Pinned file cannot be moved from the right panel');
  }
  const navigation = panes.flatMap(pane => pane.kind === 'utility' && pane.sel.startsWith('nav:')
    ? [{ sel: pane.sel, ...centerNavigationIdentity(ctx, scope, pane.sel) }] : []);
  scope.assertCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  try {
    const result = await requestRendererOnce<PanelSplitResponse>(win, {
      requestChannel: 'panel:split-request', prefix: 'panel:split', timeoutMs: 5000, signal, requireSource: true,
      payload: { workspaceId: scope.workspaceId, rootsRevision, panes, layoutId: layout.id,
        ...(navigation.length ? { navigation: navigation.map(item => ({ sel: item.sel, ...item.identity })) } : {}), ...(files.length ? { files } : {}) },
      onTimeout: () => ({ ok: false, outcome: 'unknown', error: 'Panel split outcome is unknown; inspect before retrying' }),
      map: raw => {
        const response = raw as Partial<PanelSplitResponse> | null;
        if (response?.ok === false && typeof response.error === 'string') return response as PanelSplitResponse;
        if (response?.ok === true && response.layoutId === layout.id && Array.isArray(response.panes) &&
            response.panes.length === panes.length && response.panes.every((target, index) => samePaneRef(target, panes[index]))) return response as PanelSplitResponse;
        return { ok: false, outcome: 'unknown', error: 'Invalid panel split response; inspect before retrying' };
      }
    });
    scope.assertCurrent();
    if (navigation.some(item => !item.current())) throw new Error('Center navigation changed');
    for (const file of files) await assertCenterFileReadable(ctx, scope, file);
    for (const pane of panes) {
      if (pane.kind === 'session') {
        const session = ctx.sessions.get(pane.sessionId);
        if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('Split target is no longer current');
      }
    }
    return result;
  } catch (error) {
    return { ok: false, outcome: 'unknown', error: `Panel split outcome may be unknown; inspect before retrying: ${String(error)}` };
  }
}

type RightSplitArgs = { placement: 'right'; workspaceId?: string; layoutId: CenterSnapLayoutId; tabIds: string[]; ratio?: number; ratios?: [number, number] };
type RightLayoutAction = ({ type: 'split' } & RightSplitArgs) | { type: 'close'; workspaceId?: string; slot?: number };

export async function changePanelRightLayout(ctx: AppContext, action: RightLayoutAction, signal?: AbortSignal): Promise<PanelRightLayoutResponse> {
  const scope = uploadScope(ctx, action.workspaceId, 'Panel');
  const requestedSplit = action.type === 'split' ? normalizeRightPanelSplit({
    layoutId: action.layoutId, tabIds: action.tabIds, ratio: action.ratio, ratios: action.ratios
  }) : null;
  if (requestedSplit?.tabIds.includes(null)) throw new Error('Provide a tab ID for every requested right split slot');
  signal?.throwIfAborted();
  const before = await readPanelSnapshot(ctx, signal);
  if (!before.ok) throw new Error(before.error);
  const { right } = before.snapshot;
  if (right.split === undefined || !right.selectedTabId) throw new Error('Right split state is unavailable');
  const expected: RightPanelLayout = { selectedTabId: right.selectedTabId, split: right.split };
  let next: RightPanelLayout;
  if (requestedSplit) {
    const selectedTabId = requestedSplit.tabIds.includes(right.selectedTabId) ? right.selectedTabId : requestedSplit.tabIds[0];
    next = { selectedTabId, split: requestedSplit };
  } else {
    if (!right.split || action.type !== 'close') throw new Error('No right split is open');
    next = action.slot === undefined ? { selectedTabId: right.selectedTabId, split: null } : removeRightPanelSlot(right.split, right.selectedTabId, action.slot);
  }

  const ids = new Set([...rightPanelLayoutTabIds(expected), ...rightPanelLayoutTabIds(next)]);
  const involved = [...ids].map(id => {
    const matches = right.tabs.filter(tab => tab.id === id);
    const tab = matches[0];
    if (matches.length !== 1 || tab.content.kind === 'redacted' || tab.deferredDock) {
      throw new Error('A right split tab is unavailable in the caller read scope');
    }
    return tab;
  });
  const checkSessionTabs = () => {
    for (const { content } of involved) {
      if (content.kind !== 'session') continue;
      const session = ctx.sessions.get(content.sessionId);
      if (!session || session.archived || session.workspaceId !== scope.workspaceId) throw new Error('A right split session is no longer current');
    }
  };
  const extensions = involved.flatMap(({ content }) => {
    if (content.kind !== 'extension') return [];
    const sel = `nav:${content.nodeId}`;
    return [{ sel, ...centerNavigationIdentity(ctx, scope, sel) }];
  });
  const checkCurrent = () => {
    scope.assertCurrent();
    checkSessionTabs();
    if (extensions.some(extension => !extension.current())) throw new Error('A right split extension changed');
  };
  checkCurrent(); signal?.throwIfAborted();
  const rootsRevision = requireWorkspace(ctx.config.get(), scope.workspaceId).rootsRevision ?? 0;
  const win = ctx.getWindow();
  if (!win || win.isDestroyed()) throw new Error('Workbench window is unavailable');
  const unknown = (error: string): PanelRightLayoutResponse => ({ ok: false, outcome: 'unknown', error });
  try {
    const result = await requestRendererOnce<PanelRightLayoutResponse>(win, {
      requestChannel: 'panel:right-layout-request', prefix: 'panel:right-layout', timeoutMs: 5000, signal, requireSource: true, requireMainFrame: true,
      closedChannel: 'panel:right-layout-closed',
      payload: { workspaceId: scope.workspaceId, rootsRevision, reveal: action.type === 'split',
        change: { sessionId: right.sessionId, expected, next, tabs: involved.map(tab => ({ id: tab.id, content: JSON.stringify(tab.content) })),
          ...(extensions.length ? { navigation: extensions.map(({ sel, identity }) => ({ sel, ...identity })) } : {}) } },
      onTimeout: () => unknown('Right split outcome is unknown; inspect before retrying'),
      map: raw => {
        const response = raw as PanelRightLayoutResponse | null;
        if (response?.ok === false && typeof response.error === 'string') return response;
        if (response?.ok === true && response.placement === 'right' && sameRightPanelLayout(response, next)) {
          return { ok: true, placement: 'right', ...next };
        }
        return unknown('Invalid right split response; inspect before retrying');
      }
    });
    checkCurrent();
    return result;
  } catch (error) {
    return unknown(`Right split outcome may be unknown; inspect before retrying: ${String(error)}`);
  }
}

export const panelHost = {
  'host.panel.list': (ctx: AppContext, _args: unknown, options?: { signal?: AbortSignal }) => readPanelSnapshot(ctx, options?.signal),
  'host.panel.open': (ctx: AppContext, args: Parameters<typeof openPanelFile>[1] & { kind?: string; placement?: 'right' | 'center'; repoPath?: string; filePath?: string; staged?: boolean; untracked?: boolean; sessionId?: string; sel?: string; owner?: TurnChangeOwner; messageId?: string; browserId?: string; nodeId?: string }, options?: { signal?: AbortSignal }) => {
    if (args?.placement !== undefined && args.placement !== 'right' && args.placement !== 'center') throw new Error('Invalid panel placement');
    if (args?.placement === 'center' && args.kind !== undefined && args.kind !== 'file' && args.kind !== 'settings' && args.kind !== 'utility' && args.kind !== 'session' && args.kind !== 'extension') {
      throw new Error('The requested panel placement is not implemented');
    }
    if (args?.kind === 'settings') return openPanelSettings(ctx, { workspaceId: args.workspaceId, focus: args.focus, placement: args.placement }, options?.signal);
    if (args?.kind === 'utility') return openPanelUtility(ctx, { workspaceId: args.workspaceId, sel: args.sel ?? '', focus: args.focus, placement: args.placement }, options?.signal);
    if (args?.kind === 'session') return openPanelSession(ctx, { workspaceId: args.workspaceId, sessionId: args.sessionId ?? '', focus: args.focus, placement: args.placement }, options?.signal);
    if (args?.kind === 'git') return openPanelGit(ctx, { workspaceId: args.workspaceId, repoPath: args.repoPath ?? '', focus: args.focus }, options?.signal);
    if (args?.kind === 'diff') return openPanelDiff(ctx, { workspaceId: args.workspaceId, repoPath: args.repoPath ?? '', filePath: args.filePath ?? '', staged: args.staged as boolean, untracked: args.untracked, focus: args.focus }, options?.signal);
    if (args?.kind === 'review') return openPanelReview(ctx, { workspaceId: args.workspaceId, owner: args.owner!, messageId: args.messageId, repoPath: args.repoPath, filePath: args.filePath, focus: args.focus }, options?.signal);
    if (args?.kind === 'browser') return openPanelBrowser(ctx, { workspaceId: args.workspaceId, browserId: args.browserId ?? '', focus: args.focus }, options?.signal);
    if (args?.kind === 'extension') return openPanelExtension(ctx, { workspaceId: args.workspaceId, nodeId: args.nodeId ?? '', focus: args.focus, placement: args.placement }, options?.signal);
    if (args?.kind === 'file' || args?.kind === undefined) return openPanelFile(ctx, args, options?.signal);
    throw new Error('This panel content kind is not implemented');
  },
  'host.panel.close': (ctx: AppContext, args: { workspaceId?: string; tabId?: string; placement?: 'center' | 'right'; slot?: number; target?: Exclude<SplitPaneRef, { kind: 'empty' }> }, options?: { signal?: AbortSignal }) => {
    if (args?.tabId !== undefined && args.placement === undefined && args.slot === undefined && args.target === undefined) return closePanelTab(ctx, { workspaceId: args.workspaceId, tabId: args.tabId }, options?.signal);
    if (args?.placement === 'right' && args.tabId === undefined && args.target === undefined) {
      return changePanelRightLayout(ctx, { type: 'close', workspaceId: args.workspaceId, slot: args.slot }, options?.signal);
    }
    if (args?.tabId !== undefined || (args?.placement !== undefined && args.placement !== 'center') || (args?.placement === 'center') !== (args?.slot !== undefined)) throw new Error('Invalid panel close target');
    return closePanelCenter(ctx, args, options?.signal);
  },
  'host.panel.split': (ctx: AppContext, args: (Parameters<typeof splitPanel>[1] & { placement?: 'center' }) | RightSplitArgs, options?: { signal?: AbortSignal }) =>
    args.placement === 'right' ? changePanelRightLayout(ctx, { ...args, type: 'split' }, options?.signal) : splitPanel(ctx, args, options?.signal),
  'host.panel.focus': (ctx: AppContext, args: { workspaceId?: string; tabId?: string; page?: 'terminal' | 'git'; target?: Exclude<SplitPaneRef, { kind: 'empty' }> }, options?: { signal?: AbortSignal }) => {
    if ([args?.page, args?.tabId, args?.target].filter(value => value !== undefined).length !== 1) throw new Error('Choose exactly one tabId, page or center target');
    return args?.page !== undefined ? focusPanelAxis(ctx, { workspaceId: args.workspaceId, page: args.page }, options?.signal)
      : args?.target !== undefined ? focusPanelCenter(ctx, { workspaceId: args.workspaceId, target: args.target }, options?.signal)
      : focusPanelTab(ctx, { workspaceId: args?.workspaceId, tabId: args?.tabId ?? '' }, options?.signal);
  }
};
