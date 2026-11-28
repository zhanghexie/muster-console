import { scopedGlobalVisibleRequestId, type GlobalVisibleRequest } from './globalVisibleActionDispatcher';
import type { GlobalDesktopBackendResult } from './globalDesktopWriteBarrier';

const windowsActions = new Set(['win32.click', 'win32.double_click', 'win32.move', 'win32.hover', 'win32.drag',
  'win32.scroll', 'win32.type', 'win32.key', 'win32.focus', 'win32.launch']);
const macActions = new Set(['macos.click', 'macos.double_click', 'macos.drag', 'macos.scroll', 'macos.type', 'macos.key', 'macos.focus', 'macos.launch']);

/** Host-owned request scope; model-supplied IDs never become global identities directly. */
export function desktopLogicalOperationId(request: GlobalVisibleRequest): string {
  return scopedGlobalVisibleRequestId(request.sessionId, request.taskId, request.requestId);
}

function validMacLaunchObservation(value: unknown, effect: unknown): boolean {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 2) return false;
  const status = Object.getOwnPropertyDescriptor(value, 'status');
  const active = Object.getOwnPropertyDescriptor(value, 'active');
  if (!status?.enumerable || !active?.enumerable || !Object.hasOwn(status, 'value') || !Object.hasOwn(active, 'value')) return false;
  if (active.value === null) return status.value === 'unknown' && effect === 'unverifiable';
  return typeof active.value === 'boolean' && effect === 'confirmed' && ['started', 'already_running', 'unknown'].includes(status.value);
}

/** Classify only the exact projections emitted by the supported desktop backends. */
export function classifyDesktopActionResult(request: GlobalVisibleRequest, value: unknown): GlobalDesktopBackendResult {
  if (!request || typeof request.action !== 'string' || !value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return { outcome: 'unknown' };
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) {
    return { outcome: 'unknown' };
  }
  const item = value as Record<string, unknown>;
  if (windowsActions.has(request.action)) {
    const validPid = request.action === 'win32.launch'
      ? Number.isSafeInteger(item.pid) && (item.pid as number) > 0 : item.pid === undefined;
    if (item.delivery === 'dispatched' && item.effect === 'unverifiable' && item.verification === 'not_performed' && validPid &&
        Object.keys(item).every(key => ['delivery', 'effect', 'verification', 'pid'].includes(key))) return { outcome: 'known', value };
  } else if (request.action === 'cua.click' || request.action === 'cua.set_value' || macActions.has(request.action)) {
    const knownEffect = (item.ok === true && (item.effect === 'confirmed' || item.effect === 'unverifiable')) ||
      (item.ok === false && (item.effect === 'refused' || item.effect === 'not_applied'));
    const validLaunch = request.action === 'macos.launch' && item.ok === true && validMacLaunchObservation(item.launch, item.effect);
    if (knownEffect && item.delivery === 'unknown' && item.verification === 'not_performed' &&
        (item.code === undefined || (typeof item.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(item.code))) &&
        Object.keys(item).every(key => ['ok', 'delivery', 'effect', 'verification', 'code'].includes(key) ||
          (key === 'launch' && validLaunch))) return { outcome: 'known', value };
  }
  return { outcome: 'unknown' };
}
