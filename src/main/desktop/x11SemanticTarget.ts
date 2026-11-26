import type { CuaSemanticActor, CuaSemanticTarget } from './cuaSemanticRuntime';
import { assertX11Session, x11WindowId } from './x11WindowGeneration';

/**
 * Host-only evidence. The owner provider must query XRes local client PID on
 * the SAME X server, verify its own connection's PID/namespace, exclude remote
 * or forwarded clients, and verify the owner's /proc start time and actual
 * semantic app. EWMH _NET_WM_PID alone is client asserted and is not this
 * proof. The capture provider must establish the marker before capture, then
 * bind and revalidate it after capture. Both must invalidate when their
 * connection, process, geometry or capture is lost. The host must start Cua
 * with the exact same session environment passed to this resolver.
 */
export interface TrustedX11Selection {
  window: { nativeHandle: string; pid: number };
  generation: string;
  owner: { nativeHandle: string; pid: number; processStart: string; source: 'xres-local'; isCurrent(): boolean };
  capture: { nativeHandle: string; generation: string; markerEstablishedBeforeCapture: true; isCurrent(): boolean };
  isCurrent(): boolean;
}

export interface TrustedX11Selections {
  resolve(sessionId: string, taskId: string, hostWindowId: string): TrustedX11Selection;
}

/** Inventory rows and native XIDs are not operation authority. */
export function resolveX11SemanticTarget(targets: TrustedX11Selections,
  generations: { current(nativeId: string, generation: string): boolean; sameSession(env: NodeJS.ProcessEnv): boolean },
  actor: CuaSemanticActor, hostWindowId: string,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): CuaSemanticTarget {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env;
  assertX11Session(platform, env);
  if (!actor || typeof actor.isCurrent !== 'function' || actor.isCurrent() !== true ||
      typeof actor.sessionId !== 'string' || !actor.sessionId.trim() || typeof actor.taskId !== 'string' || !actor.taskId.trim()) {
    throw new Error('Desktop actor is no longer current');
  }
  if (!targets || typeof targets.resolve !== 'function' || !generations || typeof generations.current !== 'function' ||
      typeof generations.sameSession !== 'function' ||
      typeof hostWindowId !== 'string' || !hostWindowId.trim() || hostWindowId.length > 256) {
    throw new Error('A host-owned X11 window selection is required');
  }
  const selected = targets.resolve(actor.sessionId, actor.taskId, hostWindowId);
  if (!selected || !selected.window || !selected.owner || !selected.capture || typeof selected.isCurrent !== 'function' ||
      typeof selected.owner.isCurrent !== 'function' || typeof selected.capture.isCurrent !== 'function') {
    throw new Error('Verified X11 window, process and capture proofs are required');
  }
  const id = x11WindowId(selected.window.nativeHandle);
  const pid = selected.window.pid, generation = selected.generation;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff ||
      typeof generation !== 'string' || !/^[0-9a-f]{48}$/.test(generation) ||
      selected.owner.source !== 'xres-local' || selected.owner.pid !== pid ||
      x11WindowId(selected.owner.nativeHandle) !== id || !/^\d{1,32}$/.test(selected.owner.processStart) ||
      x11WindowId(selected.capture.nativeHandle) !== id || selected.capture.generation !== generation ||
      selected.capture.markerEstablishedBeforeCapture !== true) {
    throw new Error('X11 window, local process or capture identity is unverified');
  }
  const actorCurrent = actor.isCurrent.bind(actor);
  const ownerCurrent = selected.owner.isCurrent.bind(selected.owner);
  const captureCurrent = selected.capture.isCurrent.bind(selected.capture);
  const selectionCurrent = selected.isCurrent.bind(selected);
  const generationCurrent = generations.current.bind(generations);
  const sessionCurrent = generations.sameSession.bind(generations);
  let valid = true;
  const current = (): boolean => {
    if (!valid) return false;
    try {
      assertX11Session(platform, env);
      if (actorCurrent() === true && sessionCurrent(env) === true && generationCurrent(id, generation) === true &&
          ownerCurrent() === true && captureCurrent() === true && selectionCurrent() === true &&
          ownerCurrent() === true && generationCurrent(id, generation) === true) return true;
    } catch { /* A failed proof is permanently stale. */ }
    valid = false;
    return false;
  };
  if (!current()) throw new Error('X11 window selection changed; capture again');
  return Object.freeze({ pid, windowId: Number.parseInt(id.slice(2), 16), generation, isCurrent: current });
}
