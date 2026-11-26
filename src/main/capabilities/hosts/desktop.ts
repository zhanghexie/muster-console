import { createHash, randomUUID } from 'node:crypto';
import type { AppContext } from '../../context';
import { currentAgentSessionId } from '../../agent/agentScope';
import { uploadScope } from '../../browser/uploadScope';
import { desktopRuntime, desktopOperationCapabilities, desktopOperationFailure, macPermissionMessage, macScreenLockedMessage,
  unavailableDesktopCapabilities, type DesktopRuntime } from '../../desktop/runtime';
import type { MacDesktopPermission } from '../../desktop/macPermissions';
import { captureIdentity } from '../../desktop/captureIdentity';
import { bindDesktopActorToRun } from '../../desktop/desktopActorRun';
import { desktopCaptureImageRequested, stageDesktopCaptureImage } from '../../desktop/captureImageScope';
import { assertDisplayCaptureOptions, type DisplayCaptureRegion, type DisplayCaptureStability } from '../../desktop/displayCapture';
import { withDesktopActivity } from '../../desktop/guiDesktopInvocation';
import type { DesktopDeliveryLease } from '../../desktop/desktopTurns';
import { PreDispatchFailure } from '../../desktop/preDispatchFailure';
import { normalizeWin32Keys } from '../../desktop/win32KeyNames';
import { CuaWindowCaptureError } from '../../desktop/cuaSemanticSession';
import { CuaDriverUnavailableError } from '../../desktop/cuaDriverPath';

type DesktopLookArgs = { surfaceId?: string; region?: DisplayCaptureRegion; waitForStable?: DisplayCaptureStability; windowOffset?: number;
  mode?: 'image' | 'semantic' | 'both'; windowId?: string; snapshotId?: string; offset?: number };
type DesktopListArgs = { displayOffset?: number; windowOffset?: number; limit?: number; view?: 'metadata' | 'applications' | 'windows';
  query?: string; status?: 'all' | 'running' | 'installed_not_running'; snapshotId?: string; offset?: number };

function operationCapabilities(ctx: AppContext, runtime: DesktopRuntime) {
  return desktopOperationCapabilities(runtime, { capture: !!ctx.desktopMetadata && !!ctx.desktopScreen,
    control: !!ctx.desktopControl || !!ctx.desktopVisibleControl || !!ctx.desktopMac,
    visible: !!ctx.desktopTargets && !!ctx.desktopVisibleControl && !!ctx.desktopTurns,
    semantic: !!(ctx.desktopTargets || ctx.desktopMac || ctx.desktopWindowList) && !!ctx.desktopSemanticControl && !!ctx.desktopTurns,
    windowCapture: !!ctx.desktopWindowList && !!ctx.desktopSemanticControl && !!ctx.desktopTurns && !!ctx.desktopScreen,
    mac: runtime === 'macos' ? ctx.desktopMac?.status() : undefined });
}

function macPreflight(ctx: AppContext, action: string, required: readonly MacDesktopPermission[], signal?: AbortSignal, driver = false) {
  uploadScope(ctx, undefined, 'Desktop').assertCurrent();
  signal?.throwIfAborted();
  const status = ctx.desktopMac?.status();
  if (!status || !ctx.desktopTurns) return desktopOperationFailure('macos', action, 'capability_unsupported',
    ctx.desktopUnavailableReason ?? unavailableDesktopCapabilities('macos').capture.remediation);
  if (driver && status.driverError) return desktopOperationFailure('macos', action, 'dependency_missing', status.driverError);
  if (required.length) {
    if (required.includes('accessibility') && status.targetError) return desktopOperationFailure('macos', action, 'capability_unsupported', status.targetError);
    const permissions = status.permissions;
    if (!permissions) return desktopOperationFailure('macos', action, 'permission_check_failed',
      status.permissionError ?? 'Could not check macOS desktop permissions; restart Muster and try again.');
    const missing = required.filter(permission => !permissions[permission]);
    if (missing.length) return { ...desktopOperationFailure('macos', action, 'permission_required', macPermissionMessage(missing)), permissions: missing };
  }
  if (driver && action !== 'listApplications') {
    if (status.screenLocked) return desktopOperationFailure('macos', action, 'screen_locked', macScreenLockedMessage);
    if (status.sessionError) return desktopOperationFailure('macos', action, 'desktop_session_unavailable', status.sessionError);
  }
}

/** Bind metadata to host state without asking for screen-capture permission. */
async function applicationDiscoveryIdentity(ctx: AppContext, lease: DesktopDeliveryLease, signal?: AbortSignal) {
  if (currentAgentSessionId()) return bindDesktopActorToRun(await captureIdentity(ctx, signal), lease);
  const scope = uploadScope(ctx, undefined, 'Desktop application discovery');
  if (lease.owner !== `orchestrator:${scope.workspaceId}`) throw new Error('Desktop application discovery owner is unavailable');
  const provider = ctx.desktopSchedulerTask, epochs = provider?.();
  const binding = epochs?.currentBinding(lease.owner)?.epoch ?? null;
  // A turn-local identity is sufficient when no desktop task exists; it does not grant capture or input.
  const taskId = binding ?? `discovery:${createHash('sha256').update(JSON.stringify([lease.owner, lease.turnId])).digest('hex')}`;
  const identity = { sessionId: lease.owner, taskId, isCurrent: () => {
    try {
      scope.assertCurrent();
      return !signal?.aborted && ctx.desktopSchedulerTask === provider && (epochs?.currentBinding(lease.owner)?.epoch ?? null) === binding;
    } catch { return false; }
  } };
  return bindDesktopActorToRun(identity, lease);
}

/** Read-only metadata uses an invocation identity, not a claimed desktop task or grant. */
async function listDesktopInternal(ctx: AppContext, args: { displayOffset?: number; windowOffset?: number; limit?: number } = {}, signal?: AbortSignal) {
  const displayOffset = args.displayOffset ?? 0, windowOffset = args.windowOffset ?? 0, limit = args.limit ?? 8;
  if (![displayOffset, windowOffset].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid desktop metadata page');
  const scope = uploadScope(ctx, undefined, 'Desktop metadata');
  const sessionId = currentAgentSessionId() ?? `orchestrator:${scope.workspaceId}`;
  const actor = { sessionId, taskId: `metadata:${randomUUID()}`, isCurrent: () => {
    try { scope.assertCurrent(); return true; } catch { return false; }
  } };
  scope.assertCurrent(); signal?.throwIfAborted();
  if (!ctx.desktopMetadata) throw new Error('Desktop metadata backend is unavailable');
  const result = await ctx.desktopMetadata().list(actor, signal);
  scope.assertCurrent(); signal?.throwIfAborted();
  const runtime = desktopRuntime(process.platform, process.env);
  const hasControls = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);
  const clean = (value: string, max: number): string => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  const surfaces = result.displays.surfaces.slice(displayOffset, displayOffset + limit).map(surface => ({
    ...surface, title: clean(surface.title, 100), titleTruncated: surface.title.length > 100, titleSanitized: hasControls(surface.title)
  }));
  const windowLimitations = result.windows.ok ? result.windows.data.limitations.filter(value => value !== 'metadata_only_not_actionable') : [];
  const windows = result.windows.ok ? { ok: true as const, data: {
    runtime: result.windows.data.runtime, complete: result.windows.data.complete, omitted: result.windows.data.omitted,
    limitations: [...windowLimitations.slice(0, 2).map(item => clean(item, 80)), 'metadata_only_not_actionable'],
    limitationsOmitted: Math.max(0, windowLimitations.length - 2),
    limitationsTruncated: windowLimitations.slice(0, 2).some(value => value.length > 80 || hasControls(value)),
    observations: result.windows.data.observations.slice(windowOffset, windowOffset + limit).map(item => {
      const restrictions = item.limitations.filter(value => value !== 'metadata_only_not_actionable');
      return { ...item, title: item.title === null ? null : clean(item.title, 160), titleTruncated: (item.title?.length ?? 0) > 160,
        titleSanitized: item.title !== null && hasControls(item.title),
        appLabel: item.appLabel === null ? null : clean(item.appLabel, 120), appLabelTruncated: (item.appLabel?.length ?? 0) > 120,
        appLabelSanitized: item.appLabel !== null && hasControls(item.appLabel),
        limitations: [...restrictions.slice(0, 2).map(value => clean(value, 80)), 'metadata_only_not_actionable'],
        limitationsOmitted: Math.max(0, restrictions.length - 2),
        limitationsTruncated: restrictions.slice(0, 2).some(value => value.length > 80 || hasControls(value)) };
    }), nextOffset: null as number | null
  } } : { ok: false as const, error: clean(result.windows.error, 300), errorTruncated: result.windows.error.length > 300,
    errorSanitized: hasControls(result.windows.error) };
  const displays = { surfaces, omitted: result.displays.omitted, nextOffset: null as number | null };
  const response = { runtime, capabilities: operationCapabilities(ctx, runtime), displays, windows };
  const nextOffsets = (): void => {
    displays.nextOffset = displayOffset + displays.surfaces.length < result.displays.surfaces.length ? displayOffset + displays.surfaces.length : null;
    if (windows.ok && result.windows.ok) windows.data.nextOffset = windowOffset + windows.data.observations.length < result.windows.data.observations.length
      ? windowOffset + windows.data.observations.length : null;
  };
  nextOffsets();
  // Preserve valid, useful JSON even with unusually long native labels or many displays.
  while (JSON.stringify({ ok: true, result: response }).length > 10_500) {
    if (windows.ok && windows.data.observations.length > 1) windows.data.observations.pop();
    else if (displays.surfaces.length > 1) displays.surfaces.pop();
    else throw new Error('Desktop metadata page exceeds the response limit');
    nextOffsets();
  }
  return response;
}

export async function listDesktop(ctx: AppContext, args: DesktopListArgs = {}, signal?: AbortSignal) {
  if (!args || (args.view !== undefined && !['metadata', 'applications', 'windows'].includes(args.view))) throw new Error('Invalid desktop list view');
  if (args.view === 'windows') {
    const offset = args.windowOffset ?? 0, limit = args.limit ?? 8;
    if (args.displayOffset !== undefined || args.query !== undefined || args.status !== undefined || args.snapshotId !== undefined || args.offset !== undefined ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error('Invalid desktop window list parameters');
    }
    const runtime = desktopRuntime(process.platform, process.env);
    if (!ctx.desktopWindowList || !ctx.desktopTurns) return unsupported(ctx, 'listWindows', signal, runtime);
    const failure = runtime === 'macos' ? macPreflight(ctx, 'listWindows', ['accessibility'], signal, true) : undefined;
    if (failure) return failure;
    return withDesktopActivity(ctx, false, signal, async (active, lease) => {
      if (!lease) throw new Error('A visible desktop run is required to list selectable windows');
      const scope = uploadScope(ctx, undefined, 'Desktop window list');
      const actor = { sessionId: lease.owner, turnId: lease.turnId, lifetimeSignal: lease.signal, isCurrent: () => {
        try { scope.assertCurrent(); return lease.isCurrent() && !lease.signal.aborted; } catch { return false; }
      } };
      try { return { runtime, ...await ctx.desktopWindowList!().list(actor, offset, limit, active) }; }
      catch (error) {
        if (error instanceof CuaDriverUnavailableError) return desktopOperationFailure(runtime, 'listWindows', error.code, error.message);
        throw error;
      }
    });
  }
  if (args.view !== 'applications') {
    if (args.query !== undefined || args.status !== undefined || args.snapshotId !== undefined || args.offset !== undefined) {
      throw new Error('Application discovery parameters require view=applications');
    }
    return withDesktopActivity(ctx, false, signal, active => listDesktopInternal(ctx, args, active));
  }
  if (args.displayOffset !== undefined || args.windowOffset !== undefined ||
      (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 10)) ||
      (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 128)) ||
      (args.status !== undefined && !['all', 'running', 'installed_not_running'].includes(args.status)) ||
      (args.snapshotId !== undefined && (typeof args.snapshotId !== 'string' || !args.snapshotId.trim() || args.snapshotId.length > 256)) ||
      (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 1_000_000)) ||
      (args.snapshotId === undefined && args.offset !== undefined) ||
      (args.snapshotId !== undefined && (args.query !== undefined || args.status !== undefined))) {
    throw new Error('Invalid application discovery parameters');
  }
  const runtime = desktopRuntime(process.platform, process.env);
  if (!ctx.desktopAppDiscovery || !ctx.desktopTurns) {
    return { ...unsupported(ctx, 'listApplications', signal, runtime),
      message: ctx.desktopUnavailableReason || 'Application discovery requires a configured host backend and a visible desktop activity; update the host or use desktop metadata.' };
  }
  if (runtime === 'macos' && ctx.desktopMac) {
    const failure = macPreflight(ctx, 'listApplications', [], signal, true);
    if (failure) return failure;
  }
  return withDesktopActivity(ctx, false, signal, async (active, lease) => {
    if (!lease) throw new Error('A visible desktop run is required for application discovery');
    const identity = await applicationDiscoveryIdentity(ctx, lease, active);
    const actor = { ...identity, turnId: lease.turnId, lifetimeSignal: lease.signal };
    active?.throwIfAborted();
    try {
      const backend = ctx.desktopAppDiscovery!();
      const applications = args.snapshotId === undefined
        ? await backend.discover(actor, { query: args.query, status: args.status, limit: args.limit ?? 8 }, active)
        : backend.page(actor, args.snapshotId, args.offset ?? 0, args.limit ?? 8, active);
      active?.throwIfAborted();
      if (!actor.isCurrent()) throw new Error('Desktop application discovery run is no longer current');
      return { runtime, applicationDiscovery: { available: true, backend: 'cua' as const }, applications };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'CuaAppDiscoveryError' || !('code' in error) ||
          typeof error.code !== 'string' || !['invalid', 'unsupported_platform', 'dependency_missing', 'driver_error',
            'invalid_driver_response', 'cancelled', 'timeout', 'stale', 'capacity', 'busy', 'closed', 'cleanup_unconfirmed'].includes(error.code)) throw error;
      if (active?.aborted || !actor.isCurrent()) throw error;
      return { ok: false as const, code: error.code, action: 'listApplications', runtime, message: error.message };
    }
  });
}

/** Capture with host-bound identity and a platform-owned window selection. */
export async function lookDesktopInternal(ctx: AppContext, args: { surfaceId: string; region?: DisplayCaptureRegion; waitForStable?: DisplayCaptureStability; windowOffset?: number },
  signal?: AbortSignal, lease?: DesktopDeliveryLease) {
  if (typeof args?.surfaceId !== 'string' || !args.surfaceId.trim()) throw new Error('Display surfaceId is required');
  const ttlMs = 15 * 60 * 1000;
  assertDisplayCaptureOptions(ttlMs, args.region, args.waitForStable);
  if (args.windowOffset !== undefined && (!Number.isSafeInteger(args.windowOffset) || args.windowOffset < 0 || args.windowOffset > 1_000_000)) throw new Error('Invalid desktop window offset');
  const scope = uploadScope(ctx, undefined, 'Desktop capture');
  scope.assertCurrent(); signal?.throwIfAborted();
  if (!ctx.desktopMetadata || !ctx.desktopScreen) throw new Error(ctx.desktopUnavailableReason || 'Desktop capture backend is unavailable');
  // Reject a stale or invented surface before asking the human for task consent.
  ctx.desktopMetadata().displayRegistry().captureTarget('preflight', args.surfaceId);
  const actor = bindDesktopActorToRun(await captureIdentity(ctx, signal), lease);
  scope.assertCurrent(); signal?.throwIfAborted();
  const registry = ctx.desktopMetadata().displayRegistry();
  const target = registry.captureTarget(actor.taskId, args.surfaceId);
  let prepared: ReturnType<ReturnType<NonNullable<AppContext['desktopMac']>['targets']>['prepare']> | undefined;
  let windowsError: string | undefined, windowsCode: string | undefined;
  if (ctx.desktopMac && lease) {
    try {
      if (!ctx.desktopMac.permissions().accessibility) { windowsCode = 'permission_required'; windowsError = macPermissionMessage(['accessibility']); }
      else if (ctx.desktopMac.screenLocked()) { windowsCode = 'screen_locked'; windowsError = macScreenLockedMessage; }
      else prepared = ctx.desktopMac.targets().prepare(actor, target, lease.signal, args.windowOffset);
    } catch (error) { windowsCode = 'window_identity_unavailable'; windowsError = String(error).slice(0, 300); }
  }
  try {
    const { authorizationCurrent, ...result } = await ctx.desktopScreen().look(actor, args.surfaceId, ttlMs, signal, args.region, args.waitForStable);
    const current = () => !signal?.aborted && actor.isCurrent() && authorizationCurrent() && registry.isCurrent(target) &&
      (!ctx.desktopMac || ctx.desktopMac.permissions().screenRecording);
    if (typeof authorizationCurrent !== 'function' || !authorizationCurrent() || (ctx.desktopMac && !current())) {
      throw new Error('Desktop capture authorization changed');
    }
    let response: typeof result | (typeof result & { windows: unknown[]; windowsComplete: boolean; windowsNextOffset?: number | null;
      windowsUnavailable?: number; windowsError?: string; windowsCode?: string }) = result;
    if (windowsError) response = { ...result, windows: [], windowsComplete: false, windowsError, windowsCode };
    else if (prepared || (process.platform === 'win32' && (ctx.desktopTargets || ctx.desktopControl))) {
      try {
        const selection = prepared ? prepared.register(result, () => current() && !ctx.desktopMac!.screenLocked())
          : (ctx.desktopTargets ? ctx.desktopTargets() : ctx.desktopControl!()).register(actor, result, target,
            () => authorizationCurrent() && registry.isCurrent(target), args.windowOffset);
        const identityUnavailable = prepared && selection.unavailable > 0 && !selection.windows.length;
        response = { ...result, windows: selection.windows, windowsComplete: selection.complete, windowsNextOffset: selection.nextOffset,
          windowsUnavailable: selection.unavailable, ...(identityUnavailable ? { windowsCode: 'window_identity_unavailable',
            windowsError: 'macOS did not provide exact Accessibility identities for these windows. Try another window or restart the affected app.' } : {}) };
      } catch (error) {
        prepared?.discard();
        if (!current()) throw error;
        const locked = ctx.desktopMac?.status().screenLocked;
        response = { ...result, windows: [], windowsComplete: false, windowsError: locked ? macScreenLockedMessage : String(error).slice(0, 300),
          ...(prepared ? { windowsCode: locked ? 'screen_locked' : 'window_identity_unavailable' } : {}) };
      }
    }
    if (desktopCaptureImageRequested()) {
      const bytes = await ctx.desktopScreen().imageBytes(actor, result.artifactId, current, signal);
      stageDesktopCaptureImage(bytes, current);
    }
    return response;
  } catch (error) { prepared?.discard(); throw error; }
  finally { prepared?.close(); }
}

function unsupported(ctx: AppContext, action: string, signal?: AbortSignal, runtime = desktopRuntime(process.platform, process.env)) {
  const scope = uploadScope(ctx, undefined, 'Desktop');
  scope.assertCurrent(); signal?.throwIfAborted();
  return { ...desktopOperationFailure(runtime, action, 'capability_unsupported', ctx.desktopUnavailableReason ??
    (runtime === 'macos' && ctx.desktopMac ? `The macOS desktop backend does not provide ${action}.` : unavailableDesktopCapabilities(runtime).capture.remediation)),
    capabilities: operationCapabilities(ctx, runtime) };
}

export async function lookDesktop(ctx: AppContext, args: DesktopLookArgs,
  signal?: AbortSignal, runtime = desktopRuntime(process.platform, process.env)) {
  if (runtime !== 'windows' && (!ctx.desktopTurns || (runtime !== 'macos' && !ctx.desktopWindowList))) return unsupported(ctx, 'look', signal, runtime);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid desktop observation arguments');
  const mode = args?.mode ?? 'image';
  if (!['image', 'semantic', 'both'].includes(mode)) throw new Error('Invalid desktop observation mode');
  if (mode === 'image') {
    const { surfaceId } = args;
    if (typeof surfaceId !== 'string' || !surfaceId.trim()) throw new Error('Display surfaceId is required');
    if (args.windowId !== undefined || args.snapshotId !== undefined || args.offset !== undefined) throw new Error('Window parameters require mode=semantic or mode=both');
    const failure = runtime === 'macos' ? macPreflight(ctx, 'look', ['screenRecording'], signal) : undefined;
    if (failure) return failure;
    try { return await withDesktopActivity(ctx, false, signal, (active, lease) => lookDesktopInternal(ctx, { ...args, surfaceId }, active, lease)); }
    catch (error) {
      if (runtime === 'macos' && !signal?.aborted) {
        const changed = macPreflight(ctx, 'look', ['screenRecording'], signal);
        if (changed) return changed;
      }
      throw error;
    }
  }
  const { surfaceId, windowId } = args;
  if ((surfaceId !== undefined && (typeof surfaceId !== 'string' || !surfaceId.trim())) || typeof windowId !== 'string' || !windowId.trim()) {
    throw new Error('A selected windowId is required for window observation');
  }
  if ((args.snapshotId !== undefined && (typeof args.snapshotId !== 'string' || !args.snapshotId.trim())) ||
      (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0 || args.offset > 1_000_000)) ||
      (args.offset !== undefined && args.snapshotId === undefined) || (mode === 'both' && args.snapshotId !== undefined) ||
      args.region !== undefined || args.waitForStable !== undefined || args.windowOffset !== undefined) {
    throw new Error('Window captures use the whole window. Snapshot paging requires mode=semantic.');
  }
  if (!ctx.desktopSemanticControl || (mode === 'both' && !ctx.desktopScreen)) return unsupported(ctx, mode === 'both' ? 'windowCapture' : 'semanticRead', signal, runtime);
  if (runtime === 'macos') {
    const failure = macPreflight(ctx, 'semanticRead', ['screenRecording', 'accessibility'], signal, true);
    if (failure) return failure;
  }
  return withDesktopActivity(ctx, false, signal, async (active, lease) => {
    if (!lease) throw new Error('A visible desktop run is required for window observation');
    const actor = bindDesktopActorToRun(await captureIdentity(ctx, active), lease);
    const bridge = ctx.desktopSemanticControl!();
    if (mode === 'semantic') {
      if (args.snapshotId !== undefined) return { semantic: await bridge.page(actor, lease, surfaceId, windowId, args.snapshotId, args.offset ?? 0) };
      try {
        const { image: _image, authorizationCurrent: _current, ...semantic } = await bridge.observe(actor, lease, surfaceId, windowId, active);
        return { semantic };
      } catch (error) {
        if (error instanceof CuaDriverUnavailableError) return desktopOperationFailure(runtime, 'look', error.code, error.message);
        throw error;
      }
    }
    const screen = ctx.desktopScreen!();
    try {
      const { authorizationCurrent, ...image } = await screen.lookWindow(actor, windowId,
        () => bridge.observe(actor, lease, surfaceId, windowId, active, true), active);
      const current = () => authorizationCurrent() && (!ctx.desktopMac || ctx.desktopMac.permissions().screenRecording);
      if (!current()) throw new Error('Desktop window capture authorization changed.');
      if (desktopCaptureImageRequested()) stageDesktopCaptureImage(await screen.imageBytes(actor, image.artifactId, current, active), current);
      return image;
    } catch (error) {
      if (error instanceof CuaWindowCaptureError || error instanceof CuaDriverUnavailableError) {
        return desktopOperationFailure(runtime, 'look', error.code, error.message);
      }
      throw error;
    }
  });
}

export async function controlDesktop(ctx: AppContext, action: 'act' | 'focus' | 'launch', args: any, signal?: AbortSignal,
  runtime = desktopRuntime(process.platform, process.env)) {
  const mac = runtime === 'macos' ? ctx.desktopMac : undefined;
  const linux = runtime === 'linux-x11' || runtime === 'linux-wayland';
  if (runtime !== 'windows' && (!ctx.desktopTurns || (!mac && (!linux || !ctx.desktopWindowList || action !== 'act')))) return unsupported(ctx, action, signal, runtime);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid desktop action arguments');
  if (typeof args.requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(args.requestId)) throw new Error('A stable desktop requestId is required');
  if (action === 'focus' && (typeof args.surfaceId !== 'string' || !args.surfaceId.trim())) throw new Error('Window surfaceId is required');
  if (action === 'launch' && (typeof args.appId !== 'string' || !args.appId.trim())) throw new Error('Application ID is required');
  let semantic = false;
  let windowClick = false;
  let normalizedKeys: number[] | undefined;
  if (action === 'act') {
    if (!['click', 'double_click', 'type', 'key', 'scroll', 'move', 'hover', 'drag', 'set_value'].includes(args.action)) throw new Error('Invalid desktop action');
    if (!args.target || typeof args.target !== 'object' || Array.isArray(args.target) || typeof args.target.windowId !== 'string' || !args.target.windowId.trim()) throw new Error('Desktop window target is required');
    if (args.verify === true) throw new Error('Desktop action effect verification is not available');
    semantic = args.action === 'set_value' || args.target.snapshotId !== undefined || args.target.ref !== undefined ||
      args.target.value !== undefined || args.target.delivery !== undefined;
    windowClick = args.target.captureId !== undefined;
    if (!semantic && !windowClick && ['click', 'double_click'].includes(args.action) &&
        (mac || ctx.desktopWindowList || ctx.desktopVisibleControl || args.action === 'double_click')) {
      return desktopOperationFailure(runtime, args.action, 'window_capture_required', 'Use look with mode=both and pass its windowId and captureId with the coordinates.');
    }
    if ((!semantic && !windowClick || args.surfaceId !== undefined) && (typeof args.surfaceId !== 'string' || !args.surfaceId.trim())) {
      throw new Error('Display surfaceId is required for actions in display coordinates');
    }
    if (windowClick) {
      if (semantic || !['click', 'double_click'].includes(args.action) ||
          typeof args.target.captureId !== 'string' || !args.target.captureId.trim() ||
          ![args.target.x, args.target.y].every(value => Number.isFinite(value) && value >= 0) ||
          Object.keys(args.target).some(key => !['windowId', 'captureId', 'x', 'y', 'button'].includes(key)) ||
          (args.target.button !== undefined && !['left', 'middle', 'right'].includes(args.target.button))) throw new Error('Invalid capture-bound window click');
      if (!ctx.desktopSemanticControl) return unsupported(ctx, args.action, signal, runtime);
    } else if (semantic) {
      if (!['click', 'set_value'].includes(args.action) || typeof args.target.snapshotId !== 'string' || !args.target.snapshotId.trim() ||
          typeof args.target.ref !== 'string' || !args.target.ref.trim() ||
          Object.keys(args.target).some(key => !['windowId', 'snapshotId', 'ref', 'value', 'delivery'].includes(key)) ||
          (args.action === 'click' && args.target.value !== undefined) ||
          (args.action === 'set_value' && (typeof args.target.value !== 'string' || args.target.value.length > 4096)) ||
          (args.target.delivery !== undefined && !['foreground', 'background'].includes(args.target.delivery))) {
        throw new Error('Invalid desktop semantic action');
      }
      if (!ctx.desktopSemanticControl) return unsupported(ctx, 'semanticAct', signal, runtime);
    } else if (linux || mac && (args.action === 'move' || args.action === 'hover')) {
      return unsupported(ctx, args.action, signal, runtime);
    } else if (!mac && args.target.axis === 'horizontal' && !ctx.desktopVisibleControl) {
      throw new Error('This desktop input action requires the visible desktop backend');
    }
    if (args.target.axis !== undefined && (args.action !== 'scroll' || !['vertical', 'horizontal'].includes(args.target.axis))) {
      throw new Error('Scroll axis is only available for desktop scroll actions');
    }
    if (args.action === 'key') { if (runtime === 'windows') normalizedKeys = normalizeWin32Keys(args.target.keys); }
    else if (args.target.keys !== undefined) throw new Error('Desktop keys are only available for key actions');
  }
  if (mac) {
    const failure = macPreflight(ctx, action, action === 'launch' ? [] : ['screenRecording', 'accessibility'], signal, true);
    if (failure) return failure;
  } else if (!semantic && !windowClick && !ctx.desktopControl && !ctx.desktopVisibleControl) throw new Error(ctx.desktopUnavailableReason || 'Windows desktop control backend is unavailable');
  return withDesktopActivity(ctx, true, signal, async (active, lease) => {
    let actor: Awaited<ReturnType<typeof captureIdentity>>;
    try { actor = bindDesktopActorToRun(await captureIdentity(ctx, active), lease); active?.throwIfAborted(); }
    catch (error) { throw new PreDispatchFailure(error); }
    if (semantic || windowClick) {
      if (!lease) throw new PreDispatchFailure('A visible desktop run is required');
      let bridge: ReturnType<NonNullable<AppContext['desktopSemanticControl']>>;
      try { bridge = ctx.desktopSemanticControl!(); } catch (error) { throw new PreDispatchFailure(error); }
      if (windowClick) return bridge.act(actor, lease, args.surfaceId, args.target.windowId, {
        snapshotId: args.target.captureId, requestId: args.requestId, action: 'click',
        point: { x: args.target.x, y: args.target.y, count: args.action === 'double_click' ? 2 : 1, button: args.target.button }
      }, active);
      return bridge.act(actor, lease, args.surfaceId, args.target.windowId, { snapshotId: args.target.snapshotId, ref: args.target.ref,
        requestId: args.requestId, action: args.action, ...(args.action === 'set_value' ? { value: args.target.value } : {}),
        ...(args.target.delivery ? { delivery: args.target.delivery } : {}) }, active);
    }
    if (mac) {
      if (!lease) throw new PreDispatchFailure('A visible desktop run is required');
      return mac.control.execute(actor, lease, action === 'launch' ? { action, appId: args.appId }
        : action === 'focus' ? { action, windowId: args.surfaceId }
          : { action: args.action, displayId: args.surfaceId, windowId: args.target.windowId, target: args.target }, args.requestId, active);
    }
    if (ctx.desktopVisibleControl) {
      if (!lease) throw new PreDispatchFailure('A visible desktop run is required');
      let visible: ReturnType<NonNullable<AppContext['desktopVisibleControl']>>;
      try { visible = ctx.desktopVisibleControl(); } catch (error) { throw new PreDispatchFailure(error); }
      if (action === 'launch') return visible.launch(actor, lease, args.appId, args.requestId, active);
      if (action === 'focus') return visible.act(actor, lease, { action: 'focus', windowId: args.surfaceId }, args.requestId, active);
      return visible.act(actor, lease, { ...args.target, ...(normalizedKeys ? { keys: normalizedKeys } : {}), action: args.action, displayId: args.surfaceId }, args.requestId, active);
    }
    if (action === 'launch') return ctx.desktopControl!().launch(actor, args?.appId, args.requestId, active);
    if (action === 'focus') return ctx.desktopControl!().act(actor, { action: 'focus', windowId: args?.surfaceId }, args.requestId, active);
    return ctx.desktopControl!().act(actor, { ...args.target, ...(normalizedKeys ? { keys: normalizedKeys } : {}), action: args.action, displayId: args.surfaceId }, args.requestId, active);
  });
}

export const desktopHost = {
  'desktop.list': (ctx: AppContext, args: DesktopListArgs, options?: { signal?: AbortSignal }) => listDesktop(ctx, args, options?.signal),
  'desktop.look': (ctx: AppContext, args: DesktopLookArgs, options?: { signal?: AbortSignal }) => lookDesktop(ctx, args, options?.signal),
  'desktop.act': (ctx: AppContext, args: unknown, options?: { signal?: AbortSignal }) => controlDesktop(ctx, 'act', args, options?.signal),
  'desktop.focus': (ctx: AppContext, args: unknown, options?: { signal?: AbortSignal }) => controlDesktop(ctx, 'focus', args, options?.signal),
  'desktop.launch': (ctx: AppContext, args: unknown, options?: { signal?: AbortSignal }) => controlDesktop(ctx, 'launch', args, options?.signal)
};
