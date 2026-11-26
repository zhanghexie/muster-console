import type { SessionMeta } from '../../shared/types';

type Target = Pick<SessionMeta, 'id'> & Partial<Pick<SessionMeta,
  'parentSessionId' | 'workspaceId' | 'runtime' | 'piModeId' | 'cwd' | 'sourceRoot'>>;

/** get() returns fresh presentation objects. The host's raw row is only an opaque lifetime token. */
export function captureProjectedSessionTarget(ref: string, resolve: (ref: string) => Target | undefined,
  identity: (id: string) => object | undefined): { target: Target; isCurrent(): boolean } {
  const resolved = resolve(ref);
  if (!resolved) throw new Error('Session not found');
  const token = identity(resolved.id);
  if (!token) throw new Error('Session update target is unavailable');
  // Capture values, not aliases to mutable rows. Requested field updates deliberately
  // do not change this binding; each gateway separately revalidates caller permissions.
  const binding = (row: Target) => JSON.stringify([row.id, row.parentSessionId, row.workspaceId,
    row.runtime, row.piModeId, row.cwd, row.sourceRoot?.rootId, row.sourceRoot?.path,
    row.sourceRoot?.cwd, row.sourceRoot?.physicalPath]);
  const expected = binding(resolved);
  const target = Object.freeze({ id: resolved.id, parentSessionId: resolved.parentSessionId });
  return { target, isCurrent() {
    try {
      const current = resolve(target.id);
      return !!current && identity(target.id) === token && binding(current) === expected;
    } catch { return false; }
  } };
}
