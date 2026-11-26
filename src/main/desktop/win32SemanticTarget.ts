import type { CuaSemanticActor, CuaSemanticTarget } from './cuaSemanticRuntime';
import type { Win32Targets } from './win32Targets';

/** Convert an existing host-selected window, never a model-provided native handle. */
export function resolveWin32SemanticTarget(targets: Pick<Win32Targets, 'resolve'>,
  actor: CuaSemanticActor, hostWindowId: string): CuaSemanticTarget {
  if (!actor || typeof actor.isCurrent !== 'function' || !actor.isCurrent()) throw new Error('Desktop actor is no longer current');
  if (typeof hostWindowId !== 'string' || !hostWindowId.trim()) throw new Error('Desktop window selection is required');
  const selected = targets.resolve(actor.sessionId, actor.taskId, hostWindowId);
  const { window, generation } = selected;
  if (!/^0x[0-9a-f]+$/i.test(window.nativeHandle) || !Number.isSafeInteger(window.pid) || window.pid <= 0 ||
      typeof generation !== 'string' || !generation.trim()) throw new Error('Desktop semantic target is unavailable');
  const nativeHandle = BigInt(window.nativeHandle);
  if (nativeHandle <= 0n || nativeHandle > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Desktop window handle cannot be represented safely by the semantic driver');
  }
  const current = (): boolean => {
    try { return actor.isCurrent() === true && selected.isCurrent() === true; } catch { return false; }
  };
  if (!current()) throw new Error('Desktop semantic target is no longer current');
  return Object.freeze({ pid: window.pid, windowId: Number(nativeHandle), generation, isCurrent: current });
}
