import { randomUUID } from 'node:crypto';

export const MAX_DESKTOP_GRANT_TTL_MS = 24 * 60 * 60 * 1000;

/** Trusted host identities, never values copied from a model's arguments. */
export interface DesktopTargetIdentity {
  appId: string;
  processInstance: string;
  surfaceId: string;
  surfaceGeneration: string;
}

export interface DesktopGrantScope {
  taskId: string;
  appId: string;
  processInstance: string;
  /** null means all current surfaces of the same process instance. */
  surfaces: readonly { surfaceId: string; generation: string }[] | null;
  actions: readonly string[];
  expiresAt: number;
  foreground: boolean;
  /** Host-generated fingerprint of the exact irreversible object and operation. */
  irreversibleObjects: readonly string[];
}

export interface DesktopGrantRequest {
  taskId: string;
  target: DesktopTargetIdentity;
  action: string;
  foreground: boolean;
  /** The host classifies the effect; a model-supplied classification is not authority. */
  effect: { kind: 'reversible' } | { kind: 'irreversible'; objectFingerprint: string };
}

export type DesktopGrantDecision =
  | { allowed: true }
  | { allowed: false; reason: 'missing' | 'revoked' | 'expired' | 'out_of_scope' | 'object_confirmation_required' };

interface StoredGrant { scope: DesktopGrantScope; revoked: boolean }

/** In-memory task grants. The caller must obtain actual approval before issuing one. */
export class DesktopGrantStore {
  private readonly grants = new Map<string, StoredGrant>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  issue(scope: DesktopGrantScope): string {
    const now = this.now();
    if (!scope.taskId || !scope.appId || !scope.processInstance || !Number.isFinite(scope.expiresAt) ||
        !Number.isFinite(now) || scope.expiresAt <= now || scope.expiresAt - now > MAX_DESKTOP_GRANT_TTL_MS ||
        !scope.actions.length || scope.actions.some(action => !action) ||
        scope.irreversibleObjects.some(object => !object) ||
        scope.surfaces?.some(surface => !surface.surfaceId || !surface.generation)) {
      throw new Error('Invalid desktop grant scope');
    }
    const id = randomUUID();
    this.grants.set(id, { revoked: false, scope: {
      ...scope,
      actions: [...scope.actions],
      irreversibleObjects: [...scope.irreversibleObjects],
      surfaces: scope.surfaces?.map(surface => ({ ...surface })) ?? null
    } });
    return id;
  }

  check(id: string, request: DesktopGrantRequest): DesktopGrantDecision {
    const grant = this.grants.get(id);
    if (!grant) return { allowed: false, reason: 'missing' };
    if (grant.revoked) return { allowed: false, reason: 'revoked' };
    const s = grant.scope;
    if (s.expiresAt <= this.now()) return { allowed: false, reason: 'expired' };
    if (!request.taskId || !request.action || !request.target.appId || !request.target.processInstance ||
        !request.target.surfaceId || !request.target.surfaceGeneration ||
        s.taskId !== request.taskId || s.appId !== request.target.appId ||
        s.processInstance !== request.target.processInstance || !s.actions.includes(request.action) ||
        (request.foreground && !s.foreground) ||
        (s.surfaces !== null && !s.surfaces.some(surface => surface.surfaceId === request.target.surfaceId &&
          surface.generation === request.target.surfaceGeneration))) return { allowed: false, reason: 'out_of_scope' };
    if (!request.effect || !['reversible', 'irreversible'].includes(request.effect.kind)) {
      return { allowed: false, reason: 'out_of_scope' };
    }
    if (request.effect.kind === 'irreversible' &&
        (!request.effect.objectFingerprint || !s.irreversibleObjects.includes(request.effect.objectFingerprint))) {
      return { allowed: false, reason: 'object_confirmation_required' };
    }
    return { allowed: true };
  }

  revoke(id: string): void {
    const grant = this.grants.get(id);
    if (grant) grant.revoked = true;
  }

  revokeTask(taskId: string): void {
    for (const grant of this.grants.values()) if (grant.scope.taskId === taskId) grant.revoked = true;
  }
}
