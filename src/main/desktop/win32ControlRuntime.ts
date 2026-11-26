import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UiBridge } from '../uiBridge';
import type { TrustedDisplayActor } from './displayService';
import type { DisplayCaptureTarget } from './displayCapture';
import { DesktopActionEvidence } from './actionEvidence';
import { DesktopActionGate } from './actionGate';
import { DesktopAuthority } from './authority';
import { DesktopAuditStore, type DesktopAuditEntry } from './auditStore';
import { DesktopDispatchJournal } from './dispatchJournal';
import { DesktopTaskLock } from './taskLock';
import { DesktopUnknownState } from './unknownState';
import { UnknownActionChains, type UnknownActionBoundary } from './unknownActionChain';
import { confirmationRefusalReason, makeUnknownActionConfirmation } from './unknownActionUi';
import { decodeDesktopPng } from './pngDecoder';
import { DesktopCaptureArtifacts } from './captureArtifacts';
import { prepareSessionCaptureDirectory } from './sessionCaptureAccess';
import { win32CapturePoint } from './win32Targets';
import { Win32TargetRegistry } from './win32TargetRegistry';
import { createWin32Input, performWin32Input, type Win32InputAction } from './win32Input';
import { TrackedWin32Input } from './trackedWin32Input';
import { createWin32WindowApi, focusWin32Window, launchWin32Executable, normalizeWin32Executable, resolveWin32Executable } from './win32Applications';
import { createWin32WindowGeneration } from './win32WindowGeneration';
import { DesktopActionIdempotency } from './actionIdempotency';
import { t } from '../../shared/i18n';
import { desktopTurnGrants } from './turnGrant';
import type { CuaSemanticActor } from './cuaSemanticRuntime';

type Point = { x: number; y: number };
type FrameResult = { captureId: string; surfaceId: string; surfaceGeneration: string; geometryRevision: string; expiresAt: number;
  width: number; height: number; sourceSize: { width: number; height: number }; region: { x: number; y: number; width: number; height: number } };
type ControlRequest = { action: Win32InputAction['action'] | 'focus'; windowId: string; displayId?: string; x?: number; y?: number; toX?: number; toY?: number;
  button?: 'left' | 'right' | 'middle'; delta?: number; text?: string; keys?: number[] };

/** Host-owned composition. Only authorized screenshots may produce actionable window references. */
export class Win32ControlRuntime {
  private readonly audit: DesktopAuditStore;
  private readonly targets: Win32TargetRegistry;
  private readonly evidence = new DesktopActionEvidence(decodeDesktopPng);
  private readonly taskSessions = new Map<string, string>();
  private readonly gate: DesktopActionGate;
  private readonly receipts: DesktopActionIdempotency;
  private readonly confirmedEvidence = new Map<string, UnknownActionBoundary>();
  private input?: TrackedWin32Input;
  private readonly ui: Pick<UiBridge, 'confirm' | 'confirmWithReceipt'>;
  constructor(private readonly userData: string, ui: Pick<UiBridge, 'confirm' | 'confirmWithReceipt'>,
    private readonly dipToPhysical: (point: Point) => Point, physicalToDip: (point: Point) => Point,
    private readonly resolveExecutable = resolveWin32Executable, createGenerations = createWin32WindowGeneration) {
    this.ui = ui;
    const root = userDataStorage(userData).resolve('app', 'desktop');
    this.audit = new DesktopAuditStore(path.join(root, 'audit.sqlite'));
    this.receipts = new DesktopActionIdempotency(root);
    const journal = new DesktopDispatchJournal(path.join(root, 'dispatch'));
    const auditEntry = (taskId: string, action: DesktopAuditEntry['action'], stage: DesktopAuditEntry['stage'], result: DesktopAuditEntry['result'], appId?: string, surfaceId?: string, evidenceSha256?: string) => {
      const sessionId = this.taskSessions.get(taskId);
      if (!sessionId) throw new Error('Desktop task owner is unavailable');
      this.audit.append({ sessionId, taskId, source: 'desktop', action, stage, result, ...(appId ? { appId } : {}),
        ...(surfaceId ? { surfaceId } : {}), ...(evidenceSha256 ? { evidenceSha256 } : {}) });
    };
    const actions = ['click', 'type', 'key', 'scroll', 'move', 'hover', 'drag', 'focus', 'launch'] as const;
    const confirm = async (name: string) => {
      const decision = await ui.confirm(t('允许桌面操作？'), t('允许当前任务操作应用“{{app}}”。', { app: name.slice(0, 160) }),
        { dangerous: true, localOnly: true, confirmLabel: t('允许'), cancelLabel: t('拒绝') });
      return decision.confirmed === true && !decision.cancelledBy && (decision.kind === 'allowOnce' || decision.kind === 'allowAlways');
    };
    const turnGranted = (taskId: string) => { const session = this.taskSessions.get(taskId); return !!session && desktopTurnGrants.current(session); };
    const authority = new DesktopAuthority({ turnGranted, actions, grantTtlMs: 24 * 60 * 60 * 1000, journal, unknownState: new DesktopUnknownState(),
      confirmApplication: request => confirm(request.target.appId), confirmObject: request => confirm(request.target.appId),
      audit: async row => auditEntry(row.taskId, row.action as DesktopAuditEntry['action'], row.stage === 'application-approval' || row.stage === 'object-approval' ? 'approval' : row.stage,
        row.result, row.appId, row.surfaceId) });
    const chain = new UnknownActionChains(journal);
    this.gate = new DesktopActionGate(authority, chain, async (boundary, signal) => {
      const session = this.taskSessions.get(boundary.taskId);
      if (!session) throw new Error('Desktop task owner is unavailable');
      return makeUnknownActionConfirmation(ui, this.evidence.bind(session).preview, signal)(boundary);
    }, async (boundary, decision) => auditEntry(boundary.taskId, boundary.actionClass as DesktopAuditEntry['action'],
      decision === 'attempt' ? 'dispatch-intent' : 'approval', decision === 'denied' ? 'denied' : 'allowed', boundary.appId, boundary.surfaceId, boundary.evidenceSha256),
    new DesktopTaskLock(path.join(root, 'locks')), async (boundary, signal) => {
      const session = this.taskSessions.get(boundary.taskId);
      if (!session) throw new Error('Desktop task owner is unavailable');
      return this.evidence.bind(session).verify(boundary, signal);
    }, turnGranted);
    this.targets = new Win32TargetRegistry(physicalToDip, createGenerations);
  }

  register(actor: TrustedDisplayActor, capture: FrameResult, display: DisplayCaptureTarget, isCurrent: () => boolean, offset = 0) {
    const selection = this.targets.register(actor, capture, display, isCurrent, offset);
    this.taskSessions.set(actor.taskId, actor.sessionId);
    return selection;
  }

  /** Host-only bridge from an existing validated capture selection to Cua. */
  semanticTarget(actor: CuaSemanticActor, windowId: string) {
    return this.targets.semanticTarget(actor, windowId);
  }

  /** Host-only: resolve an existing capture-bound selection for the visible executor. */
  visibleTarget(actor: TrustedDisplayActor, windowId: string) {
    return this.targets.visibleTarget(actor, windowId);
  }

  async act(actor: TrustedDisplayActor, request: ControlRequest, requestId: string, signal?: AbortSignal) {
    if (!request || typeof request.windowId !== 'string' || !['click', 'type', 'key', 'scroll', 'move', 'hover', 'drag', 'focus'].includes(request.action)) throw new Error('Invalid desktop action');
    const turn = desktopTurnGrants.capture(actor.sessionId);
    const boundActor = { ...actor, isCurrent: () => actor.isCurrent() && turn() };
    return this.receipts.run(actor.sessionId, actor.taskId, requestId, request, boundActor.isCurrent,
      markDispatch => this.actOnce(boundActor, request, markDispatch, signal), signal);
  }

  private async actOnce(actor: TrustedDisplayActor, request: ControlRequest, markDispatch: () => void, signal?: AbortSignal) {
    const selected = this.targets.resolve(actor.sessionId, actor.taskId, request.windowId), { frame, window } = selected;
    if (request.displayId !== undefined && request.displayId !== frame.surfaceId) throw new Error('Desktop window does not belong to the requested display');
    const current = () => actor.isCurrent() && selected.isCurrent();
    const appId = window.processImage!, processInstance = `${window.pid}:${window.processCreated}`;
    const target = { appId, processInstance, surfaceId: request.windowId, surfaceGeneration: frame.surfaceGeneration };
    let boundary = this.confirmedEvidence.get(request.windowId);
    if (!boundary) {
      const store = new DesktopCaptureArtifacts(prepareSessionCaptureDirectory(this.userData, actor.sessionId), decodeDesktopPng);
      const artifact = await store.get(actor.taskId, frame.captureId);
      const png = await fs.readFile(artifact.path), captureId = randomUUID();
      const identity = { taskId: actor.taskId, appId, processInstance, surfaceId: request.windowId, surfaceGeneration: frame.surfaceGeneration,
        geometryRevision: frame.geometryRevision, captureId, region: { x: 0, y: 0, width: frame.width, height: frame.height } };
      const sha = await this.evidence.register(actor.sessionId, identity, png, frame.expiresAt, current, signal);
      boundary = { ...identity, actionClass: request.action, evidenceSha256: sha };
      this.confirmedEvidence.set(request.windowId, boundary);
    }
    const actionBoundary = { ...boundary, actionClass: request.action };
    const point = (x: unknown, y: unknown) => {
      if (typeof x !== 'number' || typeof y !== 'number') throw new Error('Desktop action requires capture pixel coordinates');
      const dip = win32CapturePoint(frame, x, y), b = window.bounds;
      if (dip.x < b.x || dip.y < b.y || dip.x >= b.x + b.width || dip.y >= b.y + b.height) throw new Error('Desktop point is outside the selected window');
      return this.dipToPhysical(dip);
    };
    let action: Win32InputAction | undefined;
    if (request.action === 'click' || request.action === 'move' || request.action === 'hover') action = { action: request.action, ...point(request.x, request.y), ...(request.action === 'click' ? { button: request.button } : {}) };
    else if (request.action === 'drag') { const from = point(request.x, request.y), to = point(request.toX, request.toY); action = { action: 'drag', ...from, toX: to.x, toY: to.y, button: request.button }; }
    else if (request.action === 'scroll') action = { action: 'scroll', ...point(request.x, request.y), delta: request.delta! };
    else if (request.action === 'type') action = { action: 'type', text: request.text! };
    else if (request.action === 'key') action = { action: 'key', keys: request.keys! };
    if (action) await performWin32Input({ move(x, y) {
      if (![x, y].every(value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647)) throw new Error('Invalid desktop point');
    }, send(events) { if (!events.length) throw new Error('Invalid desktop input'); } }, action, signal);
    let refusalReason: DesktopAuditEntry['refusalReason'];
    const turnCurrent = await desktopTurnGrants.authorize(actor.sessionId, current,
      () => makeUnknownActionConfirmation(this.ui, this.evidence.bind(actor.sessionId).preview, signal, receipt => { refusalReason = confirmationRefusalReason(receipt); })(actionBoundary),
      approved => {
        this.audit.append({ sessionId: actor.sessionId, taskId: actor.taskId, source: 'desktop', action: request.action,
          stage: 'approval', result: approved ? 'allowed' : 'denied', appId, surfaceId: request.windowId, evidenceSha256: actionBoundary.evidenceSha256,
          ...(!approved && refusalReason ? { refusalReason } : {}) });
        if (!approved && refusalReason && refusalReason !== 'user-declined') throw new Error(`Desktop confirmation unavailable or interrupted; retry when the workbench is available (${refusalReason})`);
      });
    return this.gate.runUnknown({ taskId: actor.taskId, target, action: request.action, foreground: true }, actionBoundary, () => current() && turnCurrent(), async (active, authorized) => {
      if (!authorized?.()) throw new Error('Desktop authorization changed');
      try { focusWin32Window(createWin32WindowApi(), BigInt(window.nativeHandle), () => current() && !!authorized?.()); }
      catch (error) { console.error('[desktop] window activation failed', error); throw error; }
      if (action) await performWin32Input(this.trackedInput(), action, active);
      return { dispatched: true };
    }, signal, undefined, (_active, authorized) => {
      if (!authorized?.()) throw new Error('Desktop authorization changed');
      markDispatch();
    });
  }

  async launch(actor: TrustedDisplayActor, appId: string, requestId: string, signal?: AbortSignal) {
    appId = normalizeWin32Executable(appId);
    const originalActor = actor, turn = desktopTurnGrants.capture(actor.sessionId);
    actor = { ...actor, isCurrent: () => originalActor.isCurrent() && turn() };
    if (!actor.isCurrent()) throw new Error('Desktop caller is no longer current');
    this.taskSessions.set(actor.taskId, actor.sessionId);
    return this.receipts.run(actor.sessionId, actor.taskId, requestId, { action: 'launch', appId }, () => actor.isCurrent(), async markDispatch => {
    appId = await this.resolveExecutable(appId);
    const target = { appId, processInstance: `launch:${appId}`, surfaceId: `launch:${appId}`, surfaceGeneration: 'launch' };
    let refusalReason: DesktopAuditEntry['refusalReason'];
    const turnCurrent = await desktopTurnGrants.authorize(actor.sessionId, () => actor.isCurrent() && !signal?.aborted, async () => {
      const result = await this.ui.confirmWithReceipt(t('允许桌面操作？'), t('允许本回合使用电脑。本回合内后续桌面操作不再询问。'),
        { dangerous: true, localOnly: true, confirmLabel: t('允许'), cancelLabel: t('拒绝'), signal });
      refusalReason = signal?.aborted ? 'confirmation-interrupted' : confirmationRefusalReason(result);
      return !signal?.aborted && !!result.approvalId && result.decision.confirmed === true && !result.decision.cancelledBy &&
        (result.decision.kind === 'allowOnce' || result.decision.kind === 'allowAlways');
    }, approved => {
      this.audit.append({ sessionId: actor.sessionId, taskId: actor.taskId, source: 'desktop', action: 'launch',
        stage: 'approval', result: approved ? 'allowed' : 'denied', appId, ...(!approved && refusalReason ? { refusalReason } : {}) });
      if (!approved && refusalReason && refusalReason !== 'user-declined') throw new Error(`Desktop confirmation unavailable or interrupted; retry when the workbench is available (${refusalReason})`);
    });
    return this.gate.runKnown({ taskId: actor.taskId, target, action: 'launch', foreground: true, effect: { kind: 'reversible' } },
      () => actor.isCurrent() && turnCurrent(), async (active, authorized) => {
        return launchWin32Executable(appId, active);
      }, signal, undefined, (_active, authorized) => {
        if (!authorized?.()) throw new Error('Desktop authorization changed');
        markDispatch();
      });
    }, signal);
  }

  /** Called by the shared desktop seat on cancellation and after each action. */
  async releaseAll(): Promise<void> { await this.input?.releaseAll(); }

  private trackedInput(): TrackedWin32Input {
    return this.input ??= new TrackedWin32Input(createWin32Input());
  }

  close(): void { try { this.targets.close(); } finally { try { this.receipts.close(); } finally { this.audit.close(); } } }
}
