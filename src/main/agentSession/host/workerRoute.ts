import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createGuiUserMessage, guiMessageText } from '../../../shared/guiWorker';
import type { WorkerRouteReason } from '../../../shared/workerRouting';
import { guiPermissionOptions, supportsGuiPermissionMode } from '../../../shared/guiPermissionOptions';
import { resolveSessionTarget } from '../../sessions/targets';
import { assertWorkerRouteCurrent, workerCrossHarnessSnapshot } from '../../tasks/workerRouting';
import { validateWorkerConfig } from '../../tasks/workerRoutingCatalog';
import { cooldownFor, recordWorkerCooldown, type WorkerRuntimeFailure } from '../../tasks/workerRoutingPolicy';
import { readAgentMessageBody, readAgentMessageLedger } from '../../metaAgent/messageStore';
import { isPendingInitialAssignment } from '../../../shared/agentMessage';
import { preflightRuntime } from '../../runtime/preflight';
import { getDriver, log, push } from './base';
import type { HostCore, SessionEntry } from './internal';
import { retireConnection, retirementBarrier } from './retirement';
import { finishTurn, startTurn } from './turn';
import { nativeConfigIdentity } from './nativeConfigState';
import { sameNativeConfigIdentity } from '../../../shared/nativeSessionConfig';

export type WorkerFailureBoundary = 'settled' | 'not-submitted' | 'unknown';

export function confirmWorkerAssignment(host: HostCore, entry: SessionEntry, userMessageId?: string): void {
  const receipt = entry.assignmentDelivery;
  if (!receipt || receipt.executionTurnId !== entry.activeExecutionTurnId || (userMessageId !== undefined && receipt.userMessageId !== userMessageId)) return;
  entry.assignmentDelivery = undefined;
  void receipt.handle.confirm().catch(error => log(host, entry, 'error', `Initial assignment receipt could not be saved: ${String(error)}`));
}

export function rejectWorkerAssignment(host: HostCore, entry: SessionEntry): Promise<void> {
  const receipt = entry.assignmentDelivery;
  entry.assignmentDelivery = undefined;
  return receipt?.handle.rejectBeforeSubmission().catch(error => log(host, entry, 'error', `Initial assignment reservation could not be released: ${String(error)}`)) ?? Promise.resolve();
}

function routeSource(host: HostCore, entry: SessionEntry) {
  const session = host.ctx.sessions.get(entry.sessionId);
  const route = session?.workerRouting;
  return route && { route, session, attempt: route.attempts.at(-1)! };
}

export function noteWorkerNativeStart(host: HostCore, entry: SessionEntry): void {
  const state = routeSource(host, entry);
  if (state?.attempt && !entry.workerSwitch && (state.route.phase === 'starting' || state.route.phase === 'idle')) host.ctx.sessions.noteWorkerRoute?.(entry.sessionId, state.attempt.attempt, 'running');
}

export function noteWorkerNativeEnd(host: HostCore, entry: SessionEntry, model?: string): void {
  const state = routeSource(host, entry);
  if (!state?.attempt || entry.workerSwitch) return;
  if (entry.assignmentDelivery) host.ctx.sessions.noteWorkerRoute?.(entry.sessionId, state.attempt.attempt, 'blocked', 'delivery-unknown');
  else host.ctx.sessions.noteWorkerRoute?.(entry.sessionId, state.attempt.attempt, 'idle', undefined, model);
}

function boundedHandoff(host: HostCore, entry: SessionEntry, reason: WorkerRouteReason): string {
  const state = routeSource(host, entry);
  const workspace = state && host.ctx.workspaces?.list().find(item => item.id === state.session?.workspaceId);
  const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max)}…`;
  const lines = [
    '[Host Worker continuation]',
    `Logical task ${entry.sessionId}; the prior engine stopped (${reason}). Work remains in the same task directory ${JSON.stringify(entry.cwd)}.`,
    'The following is recorded context. Inspect existing files and results before acting. Continue unfinished work and do not replay completed operations.',
    'For all earlier user instructions, tool results, and longer text, use host.workers.context({}) and follow nextBefore. Read a full message by messageId and follow nextOffset. For older supplementary mail use host.mail.read and follow its pages.',
  ];
  if (workspace) {
    const mail = readAgentMessageLedger(workspace.path, workspace.id).messages.filter(message => message.to === entry.sessionId);
    const initial = mail.find(message => message.meta?.initialAssignment);
    if (initial) {
      if (!isPendingInitialAssignment(initial)) {
        const body = readAgentMessageBody(workspace.path, workspace.id, initial);
        lines.push(`Initial assignment ${initial.id}: ${JSON.stringify(clip(body, 1800))}`);
      }
      lines.push(`Full assignment: host.mail.read({messageId:${JSON.stringify(initial.id)},bodyOffset:0}).`);
    }
    for (const message of mail.filter(item => item !== initial).slice(-3)) {
      lines.push(`Mailbox ${message.id} (${message.read ? 'read' : 'unread'}): ${JSON.stringify(clip(message.text, 400))}`);
    }
  }
  const messages = entry.messages.filter(message => !message.queued && (message.role === 'assistant' || message.role === 'user'));
  const changedFiles = [...new Set(messages.flatMap(message => message.turnChanges?.files.filter(file => !file.reverted).map(file => file.path) ?? []))];
  if (changedFiles.length) lines.push(`Observed changed paths (${changedFiles.length} total): ${JSON.stringify(changedFiles.slice(-16))}`);
  for (const message of messages.slice(-8)) {
    const text = guiMessageText(message);
    if (text) lines.push(`${message.role === 'user' ? 'Prior input' : 'Prior reply'} ${message.id}: ${JSON.stringify(clip(text, 700))}`);
    for (const part of message.parts.filter(part => part.kind === 'tool').slice(-4)) {
      if (part.kind === 'tool' && ['ok', 'error'].includes(part.tool.status)) lines.push(`Tool ${JSON.stringify(part.tool.name)} ${part.tool.status}: ${JSON.stringify(clip(part.tool.output ?? '', 280))}`);
    }
  }
  return clip(lines.join('\n'), 9800) + '\n[End host Worker continuation]';
}

/** Owns exactly one recovery per observed turn. Unknown delivery and in-flight tools are held for the user. */
export function handleWorkerRouteFailure(host: HostCore, entry: SessionEntry, message: string,
  failure: WorkerRuntimeFailure | undefined, boundary: WorkerFailureBoundary): boolean {
  const state = routeSource(host, entry);
  if (!state?.attempt || entry.abortRequested) return false;
  if (entry.workerSwitch) return true;
  const { route, attempt } = state;
  const originalCwd = state.session?.cwd;
  const originalWorktree = state.session?.worktreePath;
  const originalGroups = JSON.stringify(state.session?.worktreeGroups ?? null);
  let expectedNativeConfig = JSON.stringify(state.session?.nativeConfig ?? null);
  const originalNativeConfigRevision = entry.nativeConfig?.revision;
  const mode = entry.mode;
  const planExecuting = entry.planExecuting;
  const uncertain = boundary === 'unknown' || !!entry.nativeDeliveryInFlight || !!entry.activeWorkerHostTools ||
    !!entry.openWorkerNativeTools?.size || !!entry.activeApproval || !!entry.activeUserQuestion ||
    (entry.execution !== undefined && entry.execution.process !== 'released');
  const reason = uncertain ? 'delivery-unknown' : failure?.reason ?? 'invalid-choice';
  const observedProgress = entry.assistant?.parts.some(part => part.kind === 'tool' || part.kind === 'text' || part.kind === 'thinking');
  const releaseAssignment = boundary === 'not-submitted' ? rejectWorkerAssignment(host, entry) : Promise.resolve();
  const block = (why: WorkerRouteReason, detail: string): void => {
    const latestAttempt = host.ctx.sessions.get(entry.sessionId)?.workerRouting?.attempts.at(-1)?.attempt ?? attempt.attempt;
    host.ctx.sessions.noteWorkerRoute?.(entry.sessionId, latestAttempt, 'blocked', why);
    host.ctx.sessions.applyActivitySignal(entry.sessionId, 'blocked', `worker-route:${why}`);
    log(host, entry, 'warn', `Worker route paused: ${why}. ${detail}`);
    try {
      host.ctx.eventRouter?.publish({ source: 'fact', type: 'worker.route.blocked', scope: entry.sessionId, workspaceId: state.session?.workspaceId,
        deliveryId: `worker-route:${entry.sessionId}:${attempt.attempt}:${why}`, receivedAt: Date.now(), summary: `Worker route paused (${why})`,
        payload: JSON.stringify({ sessionId: entry.sessionId, attempt: attempt.attempt, reason: why }) });
    } catch (error) { log(host, entry, 'warn', `Worker route event could not be saved: ${String(error)}`); }
    push(host, { kind: 'error', sessionId: entry.sessionId, message: detail });
  };
  if (entry.assistant) entry.assistant.error = message;
  if (uncertain || !failure || !('tierId' in route.plan.requested) || entry.forkDeliveryState || entry.forkResumeGuard) {
    if (!uncertain && failure) void resolveSessionTarget(host.ctx.config.get(), route.plan.scope).then(target => {
      assertWorkerRouteCurrent(host.ctx, target, route.plan);
      recordWorkerCooldown(host.ctx, target, attempt.config, failure);
    }).catch(error => log(host, entry, 'warn', `Worker cooldown source unavailable: ${String(error)}`));
    block(reason, uncertain ? `${message} Delivery or tool settlement is uncertain. Check existing results before continuing.` : message);
    finishTurn(host, entry, { holdQueue: true });
    return true;
  }

  const owner = Symbol('worker-attempt');
  const cancellation = new AbortController();
  entry.workerSwitch = owner;
  entry.workerSwitchAbort = cancellation;
  const current = (): boolean => {
    const session = host.ctx.sessions.get(entry.sessionId);
    return entry.workerSwitch === owner && !entry.closed && !entry.clearing && !entry.abortRequested &&
      host.entries.get(entry.sessionId) === entry && !!session && !session.archived && session.phase?.value !== 'done' &&
      session.cwd === originalCwd && session.worktreePath === originalWorktree && JSON.stringify(session.worktreeGroups ?? null) === originalGroups &&
      JSON.stringify(session.nativeConfig ?? null) === expectedNativeConfig &&
      entry.nativeConfig?.revision === originalNativeConfigRevision && !entry.nativeConfigPending &&
      entry.mode === mode && entry.planExecuting === planExecuting;
  };
  const assertCurrent = (): void => { if (!current()) throw new Error('Worker route was cancelled.'); };
  // Detach before finishTurn, revoking this connection's host tool authority.
  // The next engine cannot connect until the old driver confirms retirement.
  retireConnection(host, entry);
  finishTurn(host, entry, { holdQueue: true });
  void (async () => {
    await releaseAssignment;
    const target = await resolveSessionTarget(host.ctx.config.get(), route.plan.scope);
    assertCurrent();
    assertWorkerRouteCurrent(host.ctx, target, route.plan);
    recordWorkerCooldown(host.ctx, target, attempt.config, failure);
    const switching = structuredClone(route);
    switching.phase = 'switching'; switching.reason = failure.reason;
    Object.assign(switching.attempts.at(-1)!, { state: 'failed', reason: failure.reason });
    await host.ctx.sessions.commitWorkerRoute(entry.sessionId, attempt.attempt, switching, undefined, assertCurrent);
    await retirementBarrier(host, entry.sessionId);
    assertCurrent();
    const context = boundedHandoff(host, entry, failure.reason);
    const attempted = new Set(switching.attempts.map(item => JSON.stringify(item.config)));
    const retrySame = !observedProgress && ['rate-limit', 'temporary-service'].includes(failure.reason) && failure.retryAfterMs !== undefined && failure.retryAfterMs <= 5000 &&
      switching.attempts.filter(item => JSON.stringify(item.config) === JSON.stringify(attempt.config)).length === 1;
    if (retrySame) await delay(Math.max(250, failure.retryAfterMs!), undefined, { signal: cancellation.signal, ref: false });
    for (const candidate of [...(retrySame ? [attempt] : []), ...route.plan.candidates]) {
      const id = JSON.stringify(candidate.config);
      if (candidate !== attempt && (attempted.has(id) || cooldownFor(host.ctx, target, candidate.config))) continue;
      assertCurrent();
      assertWorkerRouteCurrent(host.ctx, target, route.plan);
      // A PTY inherits independent native permissions. Preserve the current GUI
      // policy and keep surface changes for pre-start routing or explicit user action.
      if (candidate.config.surface !== 'gui') continue;
      const changedHarness = candidate.config.harnessId !== attempt.config.harnessId || candidate.config.runtimeId !== attempt.config.runtimeId ||
        candidate.config.acpPresetId !== attempt.config.acpPresetId;
      const hasWorkbenchMode = guiPermissionOptions(candidate.config.runtimeId, mode).length > 0;
      if (hasWorkbenchMode && !supportsGuiPermissionMode(candidate.config.runtimeId, mode)) continue;
      const requiresConsent = changedHarness || !!attempt.crossHarness;
      if (requiresConsent && (route.crossHarnessRestricted || state.session?.parentSessionId || mode === 'plan' || planExecuting ||
          !candidate.crossHarness?.binding || !getDriver(host, candidate.config.runtimeId)?.captureWorkerPermission)) continue;
      const nextMode = hasWorkbenchMode ? mode : 'default';
      let checked: Awaited<ReturnType<typeof validateWorkerConfig>>;
      try {
        checked = await validateWorkerConfig(host.ctx, target, candidate.config, true);
        const availability = await preflightRuntime(host.ctx, candidate.config.runtimeId, { piModeId: candidate.config.acpPresetId, modelOverride: candidate.config.model });
        if (!availability.ok) continue;
      } catch (error) {
        log(host, entry, 'warn', `Worker candidate validation failed: ${String(error)}`);
        continue;
      }
      const consent = requiresConsent ? candidate.crossHarness : undefined;
      if (requiresConsent && (!consent || !workerCrossHarnessSnapshot(target, candidate, checked.fingerprint) || !sameNativeConfigIdentity(consent.nativeConfig.identity,
        nativeConfigIdentity(host, { runtime: candidate.config.runtimeId, piModeId: candidate.config.acpPresetId,
          workspaceId: target.workspaceId, sourceRoot: target.sourceRoot, cwd: target.sourceRoot.cwd })))) continue;
      attempted.add(id);
      const next = structuredClone(switching);
      next.phase = 'starting';
      next.attempts.push({ tierId: candidate.tierId, tierName: candidate.tierName, memberId: candidate.memberId,
        config: candidate.config, attempt: attempt.attempt + 1, startedAt: Date.now(), state: 'starting', ...(consent ? { crossHarness: consent } : {}) });
      const recheck = () => { assertCurrent(); assertWorkerRouteCurrent(host.ctx, target, route.plan); };
      await host.ctx.sessions.commitWorkerRoute(entry.sessionId, attempt.attempt, next, { runtime: candidate.config.runtimeId,
        meta: { configurePermissions: consent ? true : state.session?.configurePermissions, piModeId: candidate.config.acpPresetId, guiMode: hasWorkbenchMode ? mode : undefined, modelOverride: checked.config.model,
          modelParameters: checked.launchParameters, ...(consent ? { nativeConfig: consent.nativeConfig } : {}) } }, recheck);
      if (consent) expectedNativeConfig = JSON.stringify(consent.nativeConfig);
      entry.runtimeId = candidate.config.runtimeId;
      entry.connectionModelKey = null;
      entry.connectionAdmissionModel = undefined;
      entry.turnModelParameters = undefined;
      entry.slashCommands = [];
      entry.engineMode = null;
      recheck();
      entry.nativeConfig = undefined;
      entry.nativeConfigIdentity = undefined;
      entry.mode = nextMode;
      entry.modeController.setMode(nextMode === 'ask' || nextMode === 'plan' ? nextMode : 'default');
      entry.planAllowedPrompts = [];
      entry.planApprovedFeedback = null;
      entry.workerRouteHandoff = context;
      entry.workerSwitch = undefined;
      entry.workerSwitchAbort = undefined;
      const user = createGuiUserMessage({ id: `worker-route-${randomUUID()}`, text: 'Continue the existing Worker task.', host: true, ts: Date.now() });
      entry.messages.push(user);
      await startTurn(host, entry, { text: 'Continue the existing Worker task.', userMessageId: user.id });
      return;
    }
    if (current()) block(failure.reason, 'Worker route exhausted. Check model cooldowns and compatible Harness permissions in Settings before continuing.');
  })().catch(error => {
    const session = host.ctx.sessions.get(entry.sessionId);
    if (entry.workerSwitch === owner && !entry.closed && !entry.clearing && session && !session.archived && session.phase?.value !== 'done') {
      block('source-changed', `Worker handoff stopped: ${String(error)}`);
    }
  }).finally(() => {
    if (entry.workerSwitch === owner) { entry.workerSwitch = undefined; entry.workerSwitchAbort = undefined; }
  });
  return true;
}

export function cancelWorkerHandoff(host: HostCore, entry: SessionEntry): void {
  const state = routeSource(host, entry);
  if (entry.workerSwitch && state?.attempt) {
    entry.workerSwitch = undefined;
    entry.workerSwitchAbort?.abort();
    entry.workerSwitchAbort = undefined;
    host.ctx.sessions.noteWorkerRoute?.(entry.sessionId, state.attempt.attempt, 'cancelled');
  }
}
