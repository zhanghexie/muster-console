import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import path from 'node:path';
import type { AppContext } from '../context';
import type { UiBridge } from '../uiBridge';
import { DesktopAuditStore, type DesktopAuditEntry } from './auditStore';
import { DesktopCaptureArtifacts } from './captureArtifacts';
import { DesktopDispatchJournal } from './dispatchJournal';
import { DesktopDisplayService, type TrustedDisplayActor, type ScreenCaptureGuard } from './displayService';
import type { ElectronDisplayRegistry } from './displayRegistry';
import type { DisplayCaptureDependencies, DisplayCaptureRegion, DisplayCaptureStability } from './displayCapture';
import { decodeDesktopPng } from './pngDecoder';
import { ScreenReadAuthority } from './screenReadAuthority';
import { makeScreenReadConfirmation } from './screenReadUi';
import { prepareSessionCaptureDirectory } from './sessionCaptureAccess';
import { VisibleScreenGuard } from './visibleScreenGuard';

/** Host composition for authorized display captures, audit and scoped PNG artifacts. */
export class DesktopScreenRuntime {
  private readonly audit: DesktopAuditStore;
  private readonly service: DesktopDisplayService;
  private readonly lifetime = new AbortController();
  constructor(ctx: AppContext, private readonly userData: string, registry: ElectronDisplayRegistry, ui: Pick<UiBridge, 'confirm'>,
    getSources: DisplayCaptureDependencies['getSources'], normalizePng: DisplayCaptureDependencies['normalizePng'],
    private readonly visibilityEpoch?: () => number | undefined) {
    if (!path.isAbsolute(userData)) throw new Error('Desktop capture path must be absolute');
    this.audit = new DesktopAuditStore(path.join(userDataStorage(userData).resolve('app', 'desktop'), 'audit.sqlite'));
    try {
      const journal = new DesktopDispatchJournal(path.join(userDataStorage(userData).resolve('app', 'desktop'), 'dispatch'));
      const confirmWorker = makeScreenReadConfirmation(ui, id => ctx.sessions.get(id)?.name ?? '');
      const audit = (sessionId: string, taskId: string, stage: DesktopAuditEntry['stage'], result: DesktopAuditEntry['result'], surfaceId?: string): void => {
        this.audit.append({ sessionId, taskId, source: 'desktop', action: 'look', stage, result, ...(surfaceId ? { surfaceId } : {}) });
      };
      const legacyAuthority = (): ScreenReadAuthority => new ScreenReadAuthority(journal, async (owner, target, signal, isCurrent) => {
        if (!owner.startsWith('orchestrator:')) return confirmWorker(owner, target, signal);
        if (typeof isCurrent !== 'function' || !ctx.desktopSchedulerTask) throw new Error('Scheduler capture authorization is unavailable');
        const task = ctx.desktopSchedulerTask();
        if (task.currentBinding(owner)?.epoch !== target.taskId || !isCurrent()) throw new Error('Scheduler capture task changed');
        if (task.consumeCaptureApproval(owner, target.taskId)) return true;
        return task.extendCapture(owner, isCurrent, signal);
      }, async (owner, target, result) => {
        audit(owner, target?.taskId ?? 'authorization-lifecycle', result === 'reconsidered' ? 'reconsideration' : 'approval',
          result === 'approved' || result === 'reconsidered' ? 'allowed' : result === 'revoked' ? 'revoked' : 'denied', target?.surfaceId);
      });
      const authority: ScreenCaptureGuard = visibilityEpoch ? new VisibleScreenGuard(visibilityEpoch) : legacyAuthority();
      this.service = new DesktopDisplayService(registry, authority, getSources,
        actor => this.artifacts(actor),
        async (actor, target, stage) => {
          // The visible-use mode has no approval decision to audit.
          if (visibilityEpoch && (stage === 'approved' || stage === 'denied')) return;
          const auditStage: DesktopAuditEntry['stage'] = stage === 'approved' || stage === 'denied' ? 'approval' :
            stage === 'capture-start' ? 'capture-start' : 'capture-result';
          const auditResult: DesktopAuditEntry['result'] = stage === 'denied' ? 'denied' : stage === 'capture-failed' ? 'failed' :
            stage === 'capture-start' ? 'dispatched' : 'allowed';
          audit(actor.sessionId, actor.taskId, auditStage, auditResult, target.surfaceId);
        }, normalizePng);
    } catch (error) { this.audit.close(); throw error; }
  }
  async look(actor: TrustedDisplayActor, surfaceId: string, ttlMs: number, signal?: AbortSignal,
    region?: DisplayCaptureRegion, waitForStable?: DisplayCaptureStability) {
    const active = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    return this.service.look(actor, surfaceId, ttlMs, active, region, waitForStable);
  }
  /** Window pixels come from the same observation the driver will use for input. */
  async lookWindow<T extends { snapshotId: string; expiresAt: number; treeAvailable: boolean; image?: { png: Buffer }; authorizationCurrent?: () => boolean }>(
    actor: TrustedDisplayActor, windowId: string, observe: () => Promise<T>, signal?: AbortSignal) {
    const epoch = this.visibilityEpoch?.();
    const current = () => !signal?.aborted && !this.lifetime.signal.aborted && actor.isCurrent() &&
      epoch !== undefined && this.visibilityEpoch?.() === epoch;
    if (!current()) throw new Error('A visible desktop run is required to capture a window.');
    const append = (stage: 'capture-start' | 'capture-result', result: 'dispatched' | 'allowed' | 'failed') =>
      this.audit.append({ sessionId: actor.sessionId, taskId: actor.taskId, source: 'desktop', action: 'look', stage, result, surfaceId: windowId });
    append('capture-start', 'dispatched');
    const artifacts = this.artifacts(actor);
    let artifact: Awaited<ReturnType<DesktopCaptureArtifacts['create']>> | undefined;
    try {
      const { image, authorizationCurrent, ...observation } = await observe();
      const authorized = () => current() && authorizationCurrent?.() === true;
      if (!image || !authorized()) throw new Error('The window screenshot is no longer available.');
      artifact = await artifacts.create(actor.taskId, image.png, observation.expiresAt - Date.now(), observation.snapshotId);
      if (!authorized()) throw new Error('Desktop window capture authorization changed.');
      append('capture-result', 'allowed');
      return { ...artifact, expiresAt: Math.min(artifact.expiresAt, observation.expiresAt), captureId: artifact.artifactId,
        coordinateSpace: 'window-pixel-v1' as const, windowId, semanticStatus: observation.treeAvailable ? 'available' as const : 'unsupported' as const, semantic: observation,
        authorizationCurrent: authorized };
    } catch (error) {
      if (artifact) await artifacts.remove(actor.taskId, artifact.artifactId);
      append('capture-result', 'failed');
      throw error;
    }
  }
  /** Read only the checked bytes of the same still-authorized capture for this tool reply. */
  async imageBytes(actor: TrustedDisplayActor, artifactId: string, current: () => boolean, signal?: AbortSignal): Promise<Buffer> {
    const check = () => {
      signal?.throwIfAborted();
      this.lifetime.signal.throwIfAborted();
      if (!actor.isCurrent() || !current()) throw new Error('Desktop capture authorization changed');
    };
    check();
    const result = await this.artifacts(actor).readBytes(actor.taskId, artifactId);
    check();
    return result.data;
  }
  private artifacts(actor: TrustedDisplayActor) {
    return new DesktopCaptureArtifacts(prepareSessionCaptureDirectory(this.userData, actor.sessionId), decodeDesktopPng);
  }
  close(): void { this.lifetime.abort(); this.audit.close(); }
}
