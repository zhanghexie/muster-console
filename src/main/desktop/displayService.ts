import { captureDisplay, type DisplayCaptureDependencies, type DisplayCaptureRegion, type DisplayCaptureStability, type DisplayCaptureTarget } from './displayCapture';
import type { ElectronDisplayRegistry } from './displayRegistry';
import type { ScreenReadAuthority } from './screenReadAuthority';

/** The read proof can come from either the legacy confirmation or the visible-use lifecycle. */
export type ScreenCaptureGuard = Pick<ScreenReadAuthority, 'authorize' | 'isAuthorized'>;

/** Construct from host execution context, never from model-supplied identity fields. */
export interface TrustedDisplayActor {
  sessionId: string;
  taskId: string;
  isCurrent(): boolean;
}

/** Internal composition; public registration and Worker-readable paths are not wired yet. */
export class DesktopDisplayService {
  constructor(private readonly registry: ElectronDisplayRegistry, private readonly authority: ScreenCaptureGuard,
    private readonly getSources: DisplayCaptureDependencies['getSources'],
    private readonly artifactsFor: (actor: Readonly<TrustedDisplayActor>) => DisplayCaptureDependencies['artifacts'],
    private readonly audit: (actor: Readonly<TrustedDisplayActor>, target: Readonly<DisplayCaptureTarget>,
      stage: 'approved' | 'denied' | 'capture-start' | 'capture-ready' | 'capture-failed') => Promise<void>,
    private readonly normalizePng: DisplayCaptureDependencies['normalizePng']) {}

  list(actor: TrustedDisplayActor): ReturnType<ElectronDisplayRegistry['refresh']> {
    this.validateActor(actor);
    if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current');
    return this.registry.refresh();
  }

  async look(raw: TrustedDisplayActor, surfaceId: string, ttlMs: number, signal?: AbortSignal, region?: DisplayCaptureRegion, waitForStable?: DisplayCaptureStability) {
    this.validateActor(raw);
    const actor = Object.freeze({ sessionId: raw.sessionId, taskId: raw.taskId, isCurrent: raw.isCurrent.bind(raw) });
    if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current');
    const target = this.registry.captureTarget(actor.taskId, surfaceId);
    let grant: number | undefined;
    const current = (): boolean => actor.isCurrent() && this.registry.isCurrent(target) &&
      (grant === undefined || this.authority.isAuthorized(actor.sessionId, actor.taskId, grant));
    const result = await captureDisplay({
      getSources: this.getSources,
      normalizePng: this.normalizePng,
      confirmAllDisplays: async (_target, confirmSignal) => {
        grant = await this.authority.authorize(actor.sessionId, target, current, confirmSignal);
        return true;
      },
      audit: (value, stage) => this.audit(actor, value, stage),
      artifacts: this.artifactsFor(actor)
    }, target, current, ttlMs, signal, region, waitForStable);
    // Host-only proof: desktop actions must not outlive the screenshot authorization.
    return { ...result, semanticStatus: 'unsupported' as const, authorizationCurrent: current };
  }

  private validateActor(actor: TrustedDisplayActor): void {
    if (!actor || typeof actor.sessionId !== 'string' || !actor.sessionId.trim() || typeof actor.taskId !== 'string' || !actor.taskId.trim() ||
      typeof actor.isCurrent !== 'function') throw new Error('Invalid desktop caller');
  }
}
