import { createHash } from 'node:crypto';
import koffi from 'koffi';
import type { TrustedDisplayActor } from './displayService';
import type { DesktopDeliveryLease } from './desktopTurns';
import type { VisibleActionDispatcher } from './visibleActionDispatcher';
import { VisibleActionPreDispatchFailure, type VisibleAcknowledgementOutcome, type VisibleIndicatorEpoch } from './visibleActionCoordinator';
import { PreDispatchFailure, PreDispatchRecoveryRequired } from './preDispatchFailure';
import { isRecordedGlobalVisibleRequest } from './globalVisibleActionDispatcher';
import { inheritRecordedDesktopOutcome } from './recordedDesktopOutcome';
import { win32CapturePoint, type Win32Targets } from './win32Targets';
import { performWin32Input, type Win32Input } from './win32Input';
import type { TrackedWin32Input } from './trackedWin32Input';
import { focusWin32Window, launchWin32Executable, normalizeWin32Executable, resolveWin32Executable, type Win32WindowApi } from './win32Applications';

type Button = 'left' | 'right' | 'middle';
export type Win32PhysicalPoint = Readonly<{ x: number; y: number }>;
type Point = Win32PhysicalPoint;
type Selection = ReturnType<Win32Targets['resolve']>;
type ActionName = 'move' | 'hover' | 'drag' | 'scroll' | 'type' | 'key' | 'focus';
export type Win32VisibleRequest = Readonly<{ action: ActionName; windowId: string; displayId?: string; x?: number; y?: number;
  toX?: number; toY?: number; button?: Button; delta?: number; axis?: 'vertical' | 'horizontal'; text?: string; keys?: readonly number[] }>;

export type Win32VisibleEffect = Readonly<{ delivery: 'dispatched'; effect: 'unverifiable'; verification: 'not_performed'; pid?: number }>;
export type Win32VisibleResult =
  | { outcome: 'dispatched'; invocationId: string; value: Win32VisibleEffect }
  | { outcome: 'unknown'; invocationId?: string; reason?: string };
type UnknownResult = Extract<Win32VisibleResult, { outcome: 'unknown' }>;
/** The turn identity is supplied by the host, never by model arguments. */
export interface Win32VisibleActor extends TrustedDisplayActor { readonly turnId: string }

export class Win32VisibleUnknownError extends Error {
  constructor(readonly result: UnknownResult, cause: unknown) {
    super('Desktop outcome is unknown and global stop could not be confirmed', { cause });
    this.name = 'Win32VisibleUnknownError';
  }
}

/** All members are bound by the host; the engine must never receive this slot. */
export interface Win32VisibleDeliverySlot {
  lease: DesktopDeliveryLease;
  indicatorEpoch: VisibleIndicatorEpoch;
  isIndicatorCurrent(epoch: VisibleIndicatorEpoch): boolean;
  isTargetCurrent(): boolean;
  /** True only if this physical point currently hits this exact window or a trusted child. */
  isPointOnTarget?(nativeHandle: bigint, generation: string, point: Point): boolean;
  /**
   * Synchronously freeze new desktop writes globally; keep them blocked across
   * tasks and restarts until independently reconciled. Arrange asynchronous
   * cleanup without awaiting this seat. A stop that resets on the next user
   * instruction is insufficient by itself.
   */
  onUnknown(result: Readonly<UnknownResult>): void;
  /**
   * Stage privately only. After act/launch returns, bind the matching invocation
   * to its complete serialized output and a trusted engine delivery event. Only
   * that independent event may invoke acknowledge; staging is not delivery.
   */
  stageDelivery(invocationId: string, value: Win32VisibleEffect,
    acknowledge: (deliveryId: string) => Promise<VisibleAcknowledgementOutcome>): void | Promise<void>;
}

export interface Win32VisibleControlOptions {
  dispatcher: Pick<VisibleActionDispatcher, 'run'>;
  /** Must use the same host-owned selection registry that issued windowId. */
  resolveTarget(actor: TrustedDisplayActor, windowId: string): Selection;
  /** Same tracked input must be wired to the shared desktop seat's releaseAll. */
  input: Pick<TrackedWin32Input, 'move' | 'send' | 'releaseAll'>;
  windowApi: Win32WindowApi;
  dipToPhysical(point: Point): Point;
  resolveExecutable?: typeof resolveWin32Executable;
  launchExecutable?: typeof launchWin32Executable;
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validIdentity = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 1024;
const validSignal = (value: unknown): value is AbortSignal => !!value && typeof value === 'object' &&
  typeof (value as AbortSignal).aborted === 'boolean' && typeof (value as AbortSignal).addEventListener === 'function' &&
  typeof (value as AbortSignal).throwIfAborted === 'function';
const validPoint = (point: Point): boolean => [point.x, point.y].every(value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647);
const releaseEvent = (event: Parameters<Win32Input['send']>[0][number]): boolean => event.kind === 'key'
  ? !!((event.flags ?? 0) & 2) : [4, 16, 64].includes(event.flags);

export interface Win32PointHitTestApi {
  setDpiContext(context: number | bigint): number | bigint | null;
  windowFromPoint(point: Point): number | bigint | null;
  rootWindow(handle: bigint): number | bigint | null;
}

/**
 * Verify the top-level HWND underneath a physical screen point. The caller
 * must separately revalidate the selected window's process and generation.
 * DPI context, capture by another thread and OS-level races remain important
 * limitations; failure to establish the physical context is not a hit.
 */
export function createWin32PointHitTest(api?: Win32PointHitTestApi): NonNullable<Win32VisibleDeliverySlot['isPointOnTarget']> {
  if (!api) {
    if (process.platform !== 'win32') throw new Error('Windows point hit testing is unavailable on this platform');
    const user = koffi.load('user32.dll');
    const point = koffi.struct({ x: 'int32', y: 'int32' });
    const setDpi = user.func('__stdcall', 'SetThreadDpiAwarenessContext', 'intptr_t', ['intptr_t']);
    const windowFromPoint = user.func('__stdcall', 'WindowFromPoint', 'intptr_t', [point]);
    const ancestor = user.func('__stdcall', 'GetAncestor', 'intptr_t', ['intptr_t', 'uint32']);
    api = { setDpiContext: setDpi, windowFromPoint, rootWindow: handle => ancestor(handle, 2) };
  }
  const native = api;
  if (typeof native.setDpiContext !== 'function' || typeof native.windowFromPoint !== 'function' || typeof native.rootWindow !== 'function') {
    throw new Error('Windows point hit testing dependencies are required');
  }
  return (handle, generation, point) => {
    if (typeof handle !== 'bigint' || handle <= 0n || !validIdentity(generation) || !point || !validPoint(point)) {
      throw new Error('Invalid Windows point hit test');
    }
    const previous = native.setDpiContext(-4); // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    if (!previous) throw new Error('Could not enter per-monitor DPI awareness for point hit testing');
    try {
      const hit = BigInt(native.windowFromPoint(point) ?? 0);
      return hit > 0n && BigInt(native.rootWindow(hit) ?? 0) === handle; // GA_ROOT
    } finally {
      if (!native.setDpiContext(previous)) throw new Error('Could not restore DPI awareness after point hit testing');
    }
  };
}

function normalizeRequest(raw: Win32VisibleRequest): Win32VisibleRequest {
  if (!raw || typeof raw !== 'object' || !validIdentity(raw.windowId) ||
      (raw.displayId !== undefined && !validIdentity(raw.displayId))) throw new Error('Invalid desktop action target');
  const base = { action: raw.action, windowId: raw.windowId, ...(raw.displayId === undefined ? {} : { displayId: raw.displayId }) };
  const xy = (): { x: number; y: number } => {
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number' || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
      throw new Error('Desktop action requires capture pixel coordinates');
    }
    return { x: raw.x, y: raw.y };
  };
  const button = (): Button => {
    const value = raw.button ?? 'left';
    if (!['left', 'right', 'middle'].includes(value)) throw new Error('Invalid desktop mouse button');
    return value;
  };
  switch (raw.action) {
    case 'move': case 'hover': return Object.freeze({ ...base, ...xy() });
    case 'drag':
      if (typeof raw.toX !== 'number' || typeof raw.toY !== 'number' || !Number.isFinite(raw.toX) || !Number.isFinite(raw.toY)) throw new Error('Invalid desktop drag destination');
      return Object.freeze({ ...base, ...xy(), toX: raw.toX, toY: raw.toY, button: button() });
    case 'scroll':
      if (!Number.isSafeInteger(raw.delta) || !raw.delta || Math.abs(raw.delta) > 12000 ||
          (raw.axis !== undefined && raw.axis !== 'vertical' && raw.axis !== 'horizontal')) throw new Error('Invalid desktop scroll');
      return Object.freeze({ ...base, ...xy(), delta: raw.delta, axis: raw.axis ?? 'vertical' });
    case 'type':
      if (typeof raw.text !== 'string' || !raw.text.length || raw.text.length > 1024) throw new Error('Invalid desktop text');
      return Object.freeze({ ...base, text: raw.text });
    case 'key':
      if (!Array.isArray(raw.keys) || !raw.keys.length || raw.keys.length > 8 ||
          raw.keys.some(key => !Number.isInteger(key) || key < 1 || key > 255) || new Set(raw.keys).size !== raw.keys.length) throw new Error('Invalid desktop key chord');
      return Object.freeze({ ...base, keys: Object.freeze([...raw.keys]) });
    case 'focus': return Object.freeze(base);
    default: throw new Error('Unsupported desktop action');
  }
}

/** Preserve AbortSignal's native methods while checking host validity inside launch's last pre-spawn check. */
function checkedSignal(signal: AbortSignal, check: () => void): AbortSignal {
  return new Proxy(signal, { get(target, key) {
    if (key === 'throwIfAborted') return () => { target.throwIfAborted(); check(); target.throwIfAborted(); };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** Windows-only host composition; platform selection and the shared seat remain host responsibilities. */
export class Win32VisibleControl {
  constructor(private readonly options: Win32VisibleControlOptions) {
    if (!options || typeof options.dispatcher?.run !== 'function' || typeof options.resolveTarget !== 'function' ||
        typeof options.dipToPhysical !== 'function' || typeof options.input?.move !== 'function' ||
        typeof options.input?.send !== 'function' || typeof options.input?.releaseAll !== 'function' ||
        typeof options.windowApi?.valid !== 'function' || typeof options.windowApi?.minimized !== 'function' ||
        typeof options.windowApi?.restore !== 'function' || typeof options.windowApi?.activate !== 'function' ||
        typeof options.windowApi?.foreground !== 'function') throw new Error('Windows visible control dependencies are required');
  }

  /** Called by the one shared desktop seat on cancellation and after each action. */
  releaseAll(): Promise<void> { return this.options.input.releaseAll(); }

  async act(actor: Win32VisibleActor, raw: Win32VisibleRequest, requestId: string, slot: Win32VisibleDeliverySlot,
    seatSignal?: AbortSignal): Promise<Win32VisibleResult> {
    let request: Win32VisibleRequest, selection: Selection, handle: bigint, point: Point | undefined, destination: Point | undefined;
    let host: ReturnType<Win32VisibleControl['captureHost']>;
    try {
      request = normalizeRequest(raw);
      host = this.captureHost(actor, requestId, slot, seatSignal);
      host.check();
      const resolvedActor = Object.freeze({ sessionId: host.sessionId, taskId: host.taskId, isCurrent: host.current });
      selection = this.options.resolveTarget(resolvedActor, request.windowId);
      if (!selection || typeof selection.isCurrent !== 'function' || selection.isCurrent() !== true ||
          !selection.window || !/^0x[0-9a-f]+$/i.test(selection.window.nativeHandle) || !validIdentity(selection.generation)) {
        throw new Error('Desktop window selection is unavailable');
      }
      handle = BigInt(selection.window.nativeHandle);
      if (handle <= 0n || (request.displayId !== undefined && request.displayId !== selection.frame.surfaceId)) throw new Error('Desktop target does not match the capture');
      const map = (x: number, y: number): Point => {
        const dip = win32CapturePoint(selection.frame, x, y), bounds = selection.window.bounds;
        if (dip.x < bounds.x || dip.y < bounds.y || dip.x >= bounds.x + bounds.width || dip.y >= bounds.y + bounds.height) {
          throw new Error('Desktop point is outside the selected window');
        }
        const physical = this.options.dipToPhysical(dip);
        if (!physical || !validPoint(physical)) throw new Error('Invalid physical desktop point');
        return Object.freeze({ x: physical.x, y: physical.y });
      };
      if (request.x !== undefined && request.y !== undefined) {
        if (!host.pointCurrent) throw new Error('Desktop point hit verification is unavailable');
        point = map(request.x, request.y);
      }
      if (request.action === 'drag') {
        destination = map(request.toX!, request.toY!);
      }
      if (selection.isCurrent() !== true) throw new Error('Desktop window selection changed');
      host.check();
    } catch (error) { throw new PreDispatchFailure(error); }

    const current = (): boolean => {
      try { return host.current() && selection.isCurrent() === true; } catch { return false; }
    };
    const fingerprint = hash(['win32-visible-v1', request, selection.generation, selection.frame.captureId,
      selection.frame.surfaceId, selection.frame.geometryRevision, point ?? null, destination ?? null]);
    return this.dispatch(host, current, request.windowId, `win32.${request.action}`, requestId, fingerprint, seatSignal, async signal => {
      const check = (): void => { signal.throwIfAborted(); if (!current() || host.indicatorCurrent(host.epoch) !== true) throw new Error('Desktop target or indicator changed'); signal.throwIfAborted(); };
      const foreground = (): void => {
        check();
        if (BigInt(this.options.windowApi.foreground() ?? 0) !== handle) throw new Error('Desktop target lost foreground');
      };
      let lastPoint: Point | undefined;
      const verifyPoint = (p: Point): void => {
        foreground();
        if (!host.pointCurrent || host.pointCurrent(handle, selection.generation, p) !== true) throw new Error('Desktop point no longer hits the selected target');
        foreground();
      };
      const input: Pick<Win32Input, 'move' | 'send'> = {
        move: (x, y) => { const p = Object.freeze({ x, y }); verifyPoint(p); this.options.input.move(x, y); lastPoint = p; },
        send: events => {
          if (!Array.isArray(events) || events.length !== 1) throw new Error('Windows visible input requires one event');
          const event = events[0]!;
          if (!releaseEvent(event)) {
            foreground();
            if (event.kind === 'mouse') {
              if (!lastPoint) throw new Error('Desktop pointer position is unavailable');
              verifyPoint(lastPoint);
            }
          }
          this.options.input.send(events);
        }
      };
      try {
        check();
        focusWin32Window(this.options.windowApi, handle, () => {
          try { check(); return true; } catch { return false; }
        });
        foreground();
        if (request.action === 'move' || request.action === 'hover') {
          await performWin32Input(input, { action: request.action, ...point! }, signal);
        } else if (request.action === 'drag') {
          await performWin32Input(input, { action: 'drag', ...point!, toX: destination!.x, toY: destination!.y, button: request.button }, signal);
        } else if (request.action === 'scroll' && request.axis === 'horizontal') {
          input.move(point!.x, point!.y);
          input.send([{ kind: 'mouse', flags: 0x1000, data: request.delta }]); // MOUSEEVENTF_HWHEEL
        } else if (request.action === 'scroll') {
          await performWin32Input(input, { action: 'scroll', ...point!, delta: request.delta! }, signal);
        } else if (request.action === 'type') {
          await performWin32Input(input, { action: 'type', text: request.text! }, signal);
        } else if (request.action === 'key') {
          await performWin32Input(input, { action: 'key', keys: [...request.keys!] }, signal);
        }
        foreground();
        return { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed' } satisfies Win32VisibleEffect;
      } finally { await this.options.input.releaseAll(); }
    });
  }

  async launch(actor: Win32VisibleActor, appId: string, requestId: string, slot: Win32VisibleDeliverySlot,
    seatSignal?: AbortSignal): Promise<Win32VisibleResult> {
    let host: ReturnType<Win32VisibleControl['captureHost']>, normalized: string;
    try {
      host = this.captureHost(actor, requestId, slot, seatSignal);
      host.check();
      normalized = normalizeWin32Executable(appId);
      const resolved = await (this.options.resolveExecutable ?? resolveWin32Executable)(normalized);
      if (normalizeWin32Executable(resolved) !== normalized) throw new Error('Windows executable identity changed');
      host.check();
    } catch (error) { throw new PreDispatchFailure(error); }
    const fingerprint = hash(['win32-launch-v1', normalized]);
    return this.dispatch(host, host.current, `launch:${hash(normalized)}`, 'win32.launch', requestId, fingerprint, seatSignal, async signal => {
      const check = (): void => { signal.throwIfAborted(); if (!host.current() || host.indicatorCurrent(host.epoch) !== true) throw new Error('Desktop launch context changed'); signal.throwIfAborted(); };
      check();
      const started = await (this.options.launchExecutable ?? launchWin32Executable)(normalized, checkedSignal(signal, check));
      check();
      if (!started || !Number.isSafeInteger(started.pid) || started.pid <= 0) throw new Error('Windows launch result is unavailable');
      return { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed', pid: started.pid } satisfies Win32VisibleEffect;
    });
  }

  private captureHost(actor: Win32VisibleActor, requestId: string, slot: Win32VisibleDeliverySlot, seatSignal?: AbortSignal) {
    if (!actor || !validIdentity(actor.sessionId) || !validIdentity(actor.taskId) || !validIdentity(actor.turnId) || typeof actor.isCurrent !== 'function' ||
        typeof requestId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(requestId) || !slot ||
        !slot.lease || !validSignal(slot.lease.signal) || typeof slot.lease.isCurrent !== 'function' ||
        slot.lease.owner !== actor.sessionId || slot.lease.turnId !== actor.turnId ||
        typeof slot.isIndicatorCurrent !== 'function' || typeof slot.isTargetCurrent !== 'function' ||
        typeof slot.stageDelivery !== 'function' || typeof slot.onUnknown !== 'function' ||
        (slot.isPointOnTarget !== undefined && typeof slot.isPointOnTarget !== 'function') ||
        !((typeof slot.indicatorEpoch === 'string' && validIdentity(slot.indicatorEpoch)) ||
          (typeof slot.indicatorEpoch === 'number' && Number.isSafeInteger(slot.indicatorEpoch) && slot.indicatorEpoch >= 0)) ||
        (seatSignal !== undefined && !validSignal(seatSignal))) throw new Error('Windows visible delivery context is unavailable');
    const sessionId = actor.sessionId, taskId = actor.taskId, actorCurrent = actor.isCurrent.bind(actor);
    const leaseCurrent = slot.lease.isCurrent.bind(slot.lease), leaseSignal = slot.lease.signal;
    const targetCurrent = slot.isTargetCurrent.bind(slot), indicatorCurrent = slot.isIndicatorCurrent.bind(slot), epoch = slot.indicatorEpoch;
    const pointCurrent = slot.isPointOnTarget?.bind(slot), stage = slot.stageDelivery.bind(slot), onUnknown = slot.onUnknown.bind(slot);
    const current = (): boolean => {
      try { return !leaseSignal.aborted && actorCurrent() === true && leaseCurrent() === true && targetCurrent() === true; }
      catch { return false; }
    };
    const check = (): void => {
      seatSignal?.throwIfAborted();
      if (!current() || indicatorCurrent(epoch) !== true) throw new Error('Windows visible delivery context is unavailable');
      seatSignal?.throwIfAborted();
    };
    return Object.freeze({ sessionId, taskId, leaseSignal, epoch, current, check, indicatorCurrent, pointCurrent, stage, onUnknown });
  }

  private unknown(host: ReturnType<Win32VisibleControl['captureHost']>, raw: UnknownResult): UnknownResult {
    const result = Object.freeze({ ...raw });
    try {
      const response: unknown = host.onUnknown(result);
      if (response !== undefined) {
        if (response && typeof (response as PromiseLike<unknown>).then === 'function') void Promise.resolve(response).catch(() => undefined);
        throw new Error('Desktop unknown handler must synchronously freeze writes');
      }
    } catch (error) { throw new Win32VisibleUnknownError(result, error); }
    return result;
  }

  private async dispatch(host: ReturnType<Win32VisibleControl['captureHost']>, current: () => boolean, target: string,
    action: string, requestId: string, fingerprint: string, seatSignal: AbortSignal | undefined,
    backend: (signal: AbortSignal) => Promise<Win32VisibleEffect>): Promise<Win32VisibleResult> {
    let result: Awaited<ReturnType<VisibleActionDispatcher['run']>>;
    let backendEntered = false;
    try {
      result = await this.options.dispatcher.run({ sessionId: host.sessionId, taskId: host.taskId, target, action,
        indicatorEpoch: host.epoch, isCurrent: current, isIndicatorCurrent: host.indicatorCurrent, signal: host.leaseSignal },
      requestId, fingerprint, signal => {
        backendEntered = true;
        return backend(AbortSignal.any([host.leaseSignal, ...(signal ? [signal] : []), ...(seatSignal ? [seatSignal] : [])]));
      });
    } catch (error) {
      if (backendEntered) return this.unknown(host, { outcome: 'unknown', reason: 'dispatch-or-persistence-failed' });
      if (error instanceof VisibleActionPreDispatchFailure) {
        if (error.recoveryRequired === false) throw new PreDispatchFailure(error);
        throw new PreDispatchRecoveryRequired(error);
      }
      throw error;
    }
    if (result.reply.outcome === 'unknown') {
      if (isRecordedGlobalVisibleRequest(result)) {
        return inheritRecordedDesktopOutcome(result, Object.freeze({ ...result.reply }));
      }
      return this.unknown(host, result.reply);
    }
    if (!('acknowledge' in result) || typeof result.acknowledge !== 'function') {
      return this.unknown(host, { outcome: 'unknown', invocationId: result.reply.invocationId, reason: 'delivery-receipt-unavailable' });
    }
    const value = result.reply.value;
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.delivery !== 'dispatched' || value.effect !== 'unverifiable' ||
        value.verification !== 'not_performed' || Object.keys(value).some(key => !['delivery', 'effect', 'verification', 'pid'].includes(key)) ||
        (value.pid !== undefined && (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0))) {
      return this.unknown(host, { outcome: 'unknown', invocationId: result.reply.invocationId, reason: 'invalid-persisted-result' });
    }
    const effect = Object.freeze({ ...value }) as Win32VisibleEffect;
    let resultReady = false;
    const acknowledge = result.acknowledge.bind(result);
    const stagedAcknowledge = (deliveryId: string): Promise<VisibleAcknowledgementOutcome> => resultReady
      ? acknowledge(deliveryId) : Promise.resolve({ outcome: 'unknown', reason: 'acknowledgement-failed' });
    try {
      if (seatSignal?.aborted || !current() || host.indicatorCurrent(host.epoch) !== true) throw new Error('Desktop delivery context changed');
      await host.stage(result.reply.invocationId, effect, stagedAcknowledge);
      if (seatSignal?.aborted || !current() || host.indicatorCurrent(host.epoch) !== true) throw new Error('Desktop delivery context changed');
    } catch { return this.unknown(host, { outcome: 'unknown', invocationId: result.reply.invocationId, reason: 'delivery-unavailable' }); }
    const reply: Win32VisibleResult = { outcome: 'dispatched', invocationId: result.reply.invocationId, value: effect };
    resultReady = true;
    return reply;
  }
}
