import { createHash } from 'node:crypto';
import type { CuaConnection, CuaTool } from './cuaTransport';
import { isMacBundleId } from './cuaAppDiscovery';
import { projectCuaActionResult } from './cuaSemanticSession';
import type { DesktopDeliveryLease } from './desktopTurns';
import type { TrustedDisplayActor } from './displayService';
import type { MacDesktopPermission } from './macPermissions';
import { macCapturePoint, sameMacBounds, type MacTargetRegistry } from './macTargetRegistry';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';
import { desktopOperationFailure, macPermissionMessage, macScreenLockedMessage } from './runtime';
import { VisibleActionPreDispatchFailure } from './visibleActionCoordinator';
import type { VisibleActionDispatcher } from './visibleActionDispatcher';

type InputAction = 'drag' | 'scroll' | 'type' | 'key';
type ControlRequest = { action: 'launch'; appId: string } | { action: 'focus'; windowId: string } |
  { action: InputAction; displayId: string; windowId: string; target: Record<string, unknown> };
type Point = { x: number; y: number };
type Selection = ReturnType<MacTargetRegistry['resolve']>;
type Call = { name: CuaTool; args: Record<string, unknown>; points?: Point[] };
type Effect = ReturnType<typeof projectCuaActionResult>;

const aliases = new Map([
  ['command', 'cmd'], ['meta', 'cmd'], ['control', 'ctrl'], ['alt', 'option'], ['enter', 'return'], ['esc', 'escape'],
  ['backspace', 'delete'], ['arrowleft', 'left'], ['arrowright', 'right'], ['arrowup', 'up'], ['arrowdown', 'down']
]);
const modifiers = new Set(['cmd', 'ctrl', 'option', 'shift', 'fn']);
const namedKey = /^(?:[a-z0-9]|f(?:[1-9]|1[0-2])|return|tab|escape|up|down|left|right|space|delete|home|end|pageup|pagedown)$/;

function keyCommand(raw: unknown): Call {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6) throw new Error('Use a macOS key name or modifiers followed by a key');
  const keys = raw.map(key => {
    if (typeof key !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(key)) throw new Error('macOS desktop input requires named keys');
    const name = key.toLowerCase().replace(/^(?:key(?=[a-z]$)|digit(?=[0-9]$))/, '');
    return aliases.get(name) ?? name;
  });
  if (new Set(keys).size !== keys.length || !namedKey.test(keys.at(-1)!) || keys.slice(0, -1).some(key => !modifiers.has(key))) {
    throw new Error('Use one macOS key, with any distinct modifiers before it');
  }
  return keys.length > 1 ? { name: 'hotkey', args: { keys } } : { name: 'press_key', args: { key: keys[0] } };
}

function actionCall(request: ControlRequest, selection?: Selection): Call {
  if (request.action === 'launch') {
    if (!isMacBundleId(request.appId)) throw new Error('Use the installed application bundle identifier from desktop.list applications');
    return { name: 'launch_app', args: { bundle_id: request.appId } };
  }
  if (!selection) throw new Error('A captured macOS window is required');
  const window = { pid: selection.window.pid, window_id: selection.window.windowId };
  if (request.action === 'focus') return { name: 'bring_to_front', args: window };
  if (selection.frame.surfaceId !== request.displayId) throw new Error('Window selection belongs to another display capture');
  const { target, action } = request;
  const allowed: Record<InputAction, string[]> = {
    key: ['keys'], type: ['text'],
    drag: ['x', 'y', 'toX', 'toY', 'button'], scroll: ['x', 'y', 'delta', 'axis']
  };
  if (Object.keys(target).some(key => key !== 'windowId' && !allowed[action].includes(key))) throw new Error('Invalid macOS desktop action parameters');
  const common = { ...window, delivery_mode: 'foreground' };
  if (action === 'key') {
    const call = keyCommand(target.keys);
    return { ...call, args: { ...common, ...call.args } };
  }
  if (action === 'type') {
    if (typeof target.text !== 'string' || !target.text.length || target.text.length > 1024 || target.text.includes('\0')) throw new Error('Invalid desktop text');
    return { name: 'type_text', args: { ...common, text: target.text } };
  }
  const point = (x: unknown, y: unknown): Point => {
    if (typeof x !== 'number' || typeof y !== 'number') throw new Error('A desktop capture point is required');
    return macCapturePoint(selection, x, y);
  };
  const first = point(target.x, target.y);
  if (action === 'scroll') {
    const delta = target.delta;
    if (typeof delta !== 'number' || !Number.isSafeInteger(delta) || !delta || Math.abs(delta) > 12000 ||
        (target.axis !== undefined && target.axis !== 'vertical' && target.axis !== 'horizontal')) throw new Error('Invalid desktop scroll');
    const direction = target.axis === 'horizontal' ? (delta > 0 ? 'right' : 'left') : (delta > 0 ? 'up' : 'down');
    return { name: 'scroll', args: { ...common, direction, amount: Math.min(50, Math.ceil(Math.abs(delta) / 120)) }, points: [first] };
  }
  const button = target.button ?? 'left';
  if (button !== 'left' && button !== 'right' && button !== 'middle') throw new Error('Invalid desktop mouse button');
  return { name: 'drag', args: { ...common, button }, points: [first, point(target.toX, target.toY)] };
}

function structured(raw: unknown): { isError?: boolean; data: Record<string, unknown> } {
  const result = raw as { isError?: boolean; structuredContent?: Record<string, unknown> } | undefined;
  if (!result || (result.isError !== undefined && typeof result.isError !== 'boolean') ||
      !result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) {
    throw new Error('Cua returned no structured macOS desktop result');
  }
  return { isError: result.isError, data: result.structuredContent };
}

async function frameCall(driver: CuaConnection, call: Call, target: Selection, signal: AbortSignal) {
  const { data, isError } = structured(await driver.call('get_window_state', { pid: target.window.pid, window_id: target.window.windowId,
    include_accessibility_tree: false, include_screenshot: true, max_image_dimension: 0 }, signal));
  const bounds = data.window_bounds as Selection['window']['bounds'] | undefined;
  const scale = data.screenshot_scale;
  if (isError || data.pid !== target.window.pid || data.window_id !== target.window.windowId || data.screenshot_frame_valid !== true ||
      !bounds || !sameMacBounds(bounds, target.window.bounds) || typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0 ||
      typeof data.screenshot_width !== 'number' || typeof data.screenshot_height !== 'number') {
    throw new Error('Cua could not match a window screenshot to the macOS capture; capture the display again');
  }
  const points = call.points!.map(point => ({ x: (point.x - bounds.x) * scale, y: (point.y - bounds.y) * scale }));
  if (points.some(point => point.x < 0 || point.y < 0 || point.x >= (data.screenshot_width as number) || point.y >= (data.screenshot_height as number))) {
    throw new Error('Point is outside the captured macOS window');
  }
  const [first, last] = points;
  return { ...call.args, ...(last ? { from_x: first!.x, from_y: first!.y, to_x: last.x, to_y: last.y } : first) };
}

function macEffect(call: Call, raw: unknown): Effect {
  const { data, isError } = structured(raw);
  if (call.name === 'bring_to_front' && !isError && data.pid === call.args.pid && data.window_id === call.args.window_id &&
      data.activated === true && data.status === 'activated') {
    return { ok: true, delivery: 'unknown', effect: 'confirmed', verification: 'not_performed' };
  }
  if (call.name === 'launch_app' && !isError && data.bundle_id === call.args.bundle_id && Number.isSafeInteger(data.pid) &&
      (data.pid as number) > 0 && (data.launch_state as { process_running?: unknown } | undefined)?.process_running === true) {
    return { ok: true, delivery: 'unknown', effect: 'confirmed', verification: 'not_performed' };
  }
  if (call.name === 'launch_app' && isError && data.error === 'APP_NOT_INSTALLED' && data.bundle_id === call.args.bundle_id) {
    return { ok: false, delivery: 'unknown', effect: 'refused', verification: 'not_performed', code: 'app_not_installed' };
  }
  if (!data.effect) throw new Error('Cua could not confirm the macOS desktop dispatch outcome');
  return projectCuaActionResult(raw);
}

/** A private, foreground Cua call with the same visible seat and durable request receipts as Windows. */
export class MacVisibleControl {
  private cleanupFailure?: unknown;

  constructor(private readonly targets: () => MacTargetRegistry, private readonly connect: () => CuaConnection,
    private readonly visibilityEpoch: () => number | undefined, private readonly dispatcher: Pick<VisibleActionDispatcher, 'run'>,
    private readonly screenLocked: () => boolean) {}

  async execute(actor: TrustedDisplayActor, lease: DesktopDeliveryLease, request: ControlRequest, requestId: string, signal?: AbortSignal) {
    const active = AbortSignal.any([lease.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    const epoch = this.visibilityEpoch();
    const current = () => !active.aborted && actor.sessionId === lease.owner && actor.isCurrent() && lease.isCurrent();
    let selection: Selection | undefined, call: Call, driver: CuaConnection;
    try {
      if (this.cleanupFailure) throw new PreDispatchRecoveryRequired(this.cleanupFailure);
      if (!current() || epoch === undefined) throw new Error('Desktop indicator or caller is unavailable');
      if (this.screenLocked()) return desktopOperationFailure('macos', request.action, 'screen_locked', macScreenLockedMessage);
      if (request.action !== 'launch') selection = this.targets().resolve(actor, request.windowId);
      call = actionCall(request, selection);
      driver = this.connect();
    } catch (error) {
      if (error instanceof PreDispatchRecoveryRequired) throw error;
      throw new PreDispatchFailure(error);
    }
    const closeOnAbort = () => { void driver.close().catch(() => {}); };
    active.addEventListener('abort', closeOnAbort, { once: true });
    let backendEntered = false;
    try {
      active.throwIfAborted();
      await driver.connect();
      if (request.action !== 'launch') {
        const permissions = structured(await driver.call('check_permissions', {}, active));
        if (permissions.isError || typeof permissions.data.accessibility !== 'boolean' || typeof permissions.data.screen_recording !== 'boolean') {
          return desktopOperationFailure('macos', request.action, 'permission_check_failed', 'Cua could not check macOS desktop permissions; restart Muster and try again.');
        }
        const missing: MacDesktopPermission[] = [];
        if (!permissions.data.screen_recording) missing.push('screenRecording');
        if (!permissions.data.accessibility) missing.push('accessibility');
        if (missing.length) return { ...desktopOperationFailure('macos', request.action, 'permission_required', macPermissionMessage(missing)), permissions: missing };
      }
      const scopeCurrent = () => current() && this.visibilityEpoch() === epoch && !this.screenLocked();
      const targetCurrent = () => scopeCurrent() && (!selection || selection.isCurrent());
      const check = () => {
        active.throwIfAborted();
        if (!targetCurrent()) throw new Error('macOS window or desktop state changed; capture the display again');
        if (selection && call.points && !this.targets().pointsOnTarget(selection, call.points)) throw new Error('macOS target point is covered or outside the window; capture the display again');
      };
      check();
      const args = call.points ? await frameCall(driver, call, selection!, active) : call.args;
      check();
      const target = request.action === 'launch' ? request.appId : request.windowId;
      const fingerprint = createHash('sha256').update(JSON.stringify([call.name, call.args, call.points ?? null, selection?.frame.captureId ?? null])).digest('hex');
      let focusConfirmed = false;
      const dispatch = await this.dispatcher.run({ sessionId: actor.sessionId, taskId: actor.taskId, target, action: `macos.${request.action}`,
        indicatorEpoch: epoch, isIndicatorCurrent: value => this.visibilityEpoch() === value,
        isCurrent: () => focusConfirmed ? scopeCurrent() && selection!.isIdentityCurrent() : targetCurrent(), signal: active },
        requestId, fingerprint, async () => {
          backendEntered = true;
          check();
          const effect = macEffect(call, await driver.call(call.name, args, active));
          // Activation can move an exact window between Stage Manager positions.
          // Its acknowledged focus does not renew the old pixel geometry.
          focusConfirmed = request.action === 'focus' && effect.ok && effect.effect === 'confirmed';
          return effect;
        });
      if (dispatch.reply.outcome === 'unknown') {
        backendEntered = true;
        throw new Error(`macOS desktop action outcome is unknown (${dispatch.reply.reason ?? 'receipt-unavailable'}); inspect the target before retrying`);
      }
      const effect = dispatch.reply.value as Effect;
      return effect.ok ? { outcome: 'dispatched' as const, invocationId: dispatch.reply.invocationId, ...effect }
        : { ...desktopOperationFailure('macos', request.action, effect.code ?? 'action_refused', effect.code === 'app_not_installed'
          ? 'This macOS bundle identifier is not installed; refresh the desktop application list.'
          : 'Cua refused or could not apply the macOS desktop action.'),
          effect: effect.effect, invocationId: dispatch.reply.invocationId };
    } catch (error) {
      if (backendEntered) throw error;
      if (error instanceof VisibleActionPreDispatchFailure && error.recoveryRequired) throw new PreDispatchRecoveryRequired(error);
      throw new PreDispatchFailure(error);
    } finally {
      active.removeEventListener('abort', closeOnAbort);
      try { await driver.close(); }
      catch (error) {
        this.cleanupFailure = error;
        throw new Error('macOS desktop driver exit is unconfirmed; restart Muster before continuing', { cause: error });
      }
    }
  }

  assertClean(): void {
    if (this.cleanupFailure) throw new Error('macOS desktop driver exit is unconfirmed', { cause: this.cleanupFailure });
  }
}
