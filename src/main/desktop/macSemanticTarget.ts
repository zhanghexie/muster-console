import type { CuaSemanticActor, CuaSemanticTarget } from './cuaSemanticRuntime';
import { MacWindowIdentity, type MacWindowIdentityNative } from './macWindowIdentity';

/**
 * A host-owned selection produced before capture. The generation must change
 * when the native window is destroyed/recreated. isCurrent must include the
 * host's capture proof, so checks before/after screenshot and actions are
 * performed against the same selection. It is never populated from tool input.
 */
export interface TrustedMacSelection {
  readonly pid: number;
  readonly windowId: number;
  readonly generation: string;
  isCurrent(): boolean;
}

export interface TrustedMacSelections {
  resolve(sessionId: string, taskId: string, hostWindowId: string): TrustedMacSelection;
}

export interface MacSemanticTarget extends CuaSemanticTarget {
  /** Release retained NSRunningApplication/AXWindow references. */
  close(): void;
  /** Numeric Cua dispatch is still a separate process and is not atomic. */
  readonly limitations: readonly string[];
}

const opaque = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const validPid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0x7fffffff;
const validWindowId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffffffff;

/**
 * Resolve a host-owned macOS selection into a Cua target. This adapter keeps
 * retained process/AX references and rechecks them on every target liveness
 * call. It deliberately does not claim an atomic hand-off to Cua: the driver
 * receives numeric pid/window_id values in another process, so a final
 * destroy/recreate race remains possible and must be reported as a limitation.
 */
export function resolveMacSemanticTarget(native: MacWindowIdentityNative,
  selections: TrustedMacSelections, actor: CuaSemanticActor, hostWindowId: string): MacSemanticTarget {
  if (!native || !selections || typeof selections.resolve !== 'function' || !actor ||
      typeof actor.isCurrent !== 'function' || typeof actor.sessionId !== 'string' || !actor.sessionId.trim() ||
      typeof actor.taskId !== 'string' || !actor.taskId.trim() || typeof hostWindowId !== 'string' ||
      !hostWindowId.trim() || hostWindowId.length > 256) {
    throw new Error('macOS semantic window identity is unavailable: a host-owned selection and native identity adapter are required');
  }
  if (actor.isCurrent() !== true) throw new Error('Desktop actor is no longer current');
  const selected = selections.resolve(actor.sessionId, actor.taskId, hostWindowId);
  if (!selected || !validPid(selected.pid) || !validWindowId(selected.windowId) || !opaque(selected.generation) ||
      typeof selected.isCurrent !== 'function') {
    throw new Error('macOS semantic window, generation and capture proof are required');
  }
  const selectionCurrent = selected.isCurrent.bind(selected);
  if (selectionCurrent() !== true) throw new Error('macOS capture selection is no longer current');
  const identity = MacWindowIdentity.acquire(native, selected.pid, selected.windowId);
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    identity.close();
  };
  const current = (): boolean => {
    if (closed) return false;
    try {
      if (actor.isCurrent() !== true || selectionCurrent() !== true || identity.current() !== true) {
        try { close(); } catch { /* liveness is already false; cleanup remains host-visible */ }
        return false;
      }
      return true;
    } catch {
      try { close(); } catch { /* fail closed even when native cleanup is uncertain */ }
      return false;
    }
  };
  if (!current()) {
    try { close(); } catch { /* preserve stale error */ }
    throw new Error('macOS semantic window changed before capture');
  }
  return Object.freeze({
    pid: selected.pid,
    windowId: selected.windowId,
    generation: selected.generation,
    isCurrent: current,
    close,
    limitations: Object.freeze([
      'numeric_driver_identity_not_atomic',
      'macos_native_adapter_requires_real_macos_validation'
    ])
  });
}
