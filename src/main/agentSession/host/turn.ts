import { desktopTurnGrants } from '../../desktop/turnGrant';
/**
 * AgentSessionHost 回合编排：回合发起（startTurn）、插话切分、失败续作
 * （网络中断指数退避 resume/重发）与统一收口（finishTurn）。
 * 时序纪律：收口顺序（审批/提问终态化 → 工具卡兜底 → 计划流 → 用量/推送 → 队列派发）
 * 与事件顺序即行为合同，不可调整。
 */
import { randomUUID } from 'node:crypto';
import { hasConfiguredModelParameterDefault } from '../../../shared/modelParameters';
import { app } from 'electron';
import { uiWidgetTurnContext } from '../../uiWidgetContext';
import { finalizeRunningToolParts } from '../../../shared/guiWorker';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { t } from '../../../shared/i18n';
import type { GuiSendImage } from '../types';
import type { GuiRuntimeConnection } from '../types';
import { GuiDeliveryError } from '../types';
import { formatGuiHostContext } from '../prompt';
import { normalizeGuiTurnRetryConfig, planGuiTurnRetry, guiTurnHasProgress } from '../../agent/turnRetry';
import { createPromptAuthorityScope } from '../../agent/turnScope';
import { isMessagingUserMessageId } from '../../messaging/sessionAuthority';
import { prepareEngineSkillText, skillTurnBook } from '../../agent/skillInject';
import type { HostCore, SessionEntry } from './internal';
import {FORK_TRANSCRIPT_MAX} from './internal';
import { applyInjectQueueChange, applySignal, cancelStreamingPersist, log, persistEntry, push, syncEntry } from './base';
import { pushContext } from './usage';
import { cancelPlanApproval, resolveUserQuestionInternal, takePlanApprovedFeedback } from './approvals';
import { updatePlanAfterTurn } from './plan';
import { assertConnectionConfigurationCurrent, ensureConnection } from './connection';
import { parameterSnapshot } from './modelParameters';
import { maybeAutoCompact } from './messaging';
import { takeReadStateHint } from './readStateTrack';
import { beginWorkspaceContext, endWorkspaceContext } from './workspaceContext';
import { captureTurnShots } from '../../browser/turnShotCapture';
import { guiSkillTargetForRuntime } from '../../../shared/capabilityManagement';
import { beginFileChanges, finishFileChanges, liveTurnRepository, markFileChangeExecution } from './fileChanges';
import {getMemoryService,resolveMemoryWorkspaceRoot} from '../../memory/runtime';
import { completeForkGuardTurn, markForkDelivered, markForkGuardUncertain, markForkNotSubmitted, markForkUncertain, startForkDelivery, startForkGuardTurn } from './forkDelivery';
import { retireConnection, connectionRetirementBarrier } from './retirement';
import {prepareRecall,clearRecall,finishRecall} from '../../memory/recallDedup';
import { reserveInitialAssignment } from '../../messages/assignment';
import { assertWorkerRouteCurrent, prepareWorkerModelMentions, validateWorkerReference } from '../../tasks/workerRouting';
import { hasWorkerModelMentions } from '../../../shared/workerModelMention';
import { resolveSessionTarget } from '../../sessions/targets';
import { assertWorkspaceExecutionContextCurrent } from '../../workspaceExecutionContext';
import { classifyWorkerRuntimeFailure, type WorkerRuntimeFailure } from '../../tasks/workerRoutingPolicy';
import { handleWorkerRouteFailure, rejectWorkerAssignment, type WorkerFailureBoundary } from './workerRoute';

function sendEngineTurn(entry: SessionEntry, conn: GuiRuntimeConnection, text: string, images: GuiSendImage[] | undefined,
  authority: Parameters<GuiRuntimeConnection['send']>[3]): Promise<void> {
  entry.memoryAuthority?.close();
  entry.memoryAuthority = createPromptAuthorityScope(authority?.userText);
  return conn.send(text, images, entry.turnModelParameters?.values, authority);
}

function forkContextFailure(entry: SessionEntry): string | undefined {
  return entry.forkPendingError ?? (entry.forkDeliveryState === 'unknown'
    ? '分叉上下文的引擎状态未知，请检查原生历史后新建会话'
    : undefined);
}

/** Stop requested while a connection was being created, before a prompt was sent. */
export async function stopBeforeDispatch(host: HostCore, entry: SessionEntry, conn?: GuiRuntimeConnection): Promise<void> {
  if (entry.setupStop) return entry.setupStop;
  entry.abortPreparing = true;
  const candidate = conn ?? entry.connection;
  if (candidate && entry.connection === candidate) retireConnection(host, entry);
  const attempt = (async () => {
    try {
      await connectionRetirementBarrier(host, entry.sessionId);
      if (entry.closed) return;
      entry.abortPreparing = false;
      if (entry.execution) {
        entry.execution = undefined;
        push(host, { kind: 'execution', sessionId: entry.sessionId });
      }
      finishTurn(host, entry);
    } catch (error) {
      const message = `停止时无法确认引擎资源已回收：${(error as Error).message}`;
      entry.abortError = message;
      if (entry.assistant) entry.assistant.error = message;
      log(host, entry, 'error', message);
      persistEntry(host, entry, [entry.assistant]);
      syncEntry(host, entry);
      push(host, { kind: 'error', sessionId: entry.sessionId, message });
      // Keep the turn occupied. A later stop can recheck a pending barrier.
    }
  })();
  entry.setupStop = attempt;
  try { await attempt; }
  finally { if (entry.setupStop === attempt) entry.setupStop = undefined; }
}

export async function startTurn(
  host: HostCore,
  entry: SessionEntry,
  input: { text: string; images?: GuiSendImage[]; insertAt?: number; userText?: string; userMessageId?: string; desktopUserInstruction?: boolean;
    desktopContinuation?: import('../../../shared/hostNotification').HostDesktopContinuation; messagingAssistantId?: string }
): Promise<void> {
  if (entry.closed || entry.busy || entry.clearing || entry.forking || entry.workerSwitch) return;
  if (entry.forkPendingError || entry.forkDeliveryState === 'unknown') {
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError ?? '分叉上下文的上次投递状态未知，请检查引擎历史后新建会话' });
    return;
  }
  const messagingInput = isMessagingUserMessageId(input.userMessageId);
  const originalUserText = messagingInput ? undefined : input.userText;
  if (originalUserText !== undefined || messagingInput) desktopTurnGrants.nextUserMessage(entry.sessionId);
  const assistant: GuiChatMessage = {
    id: input.messagingAssistantId ?? randomUUID(),
    role: 'assistant',
    parts: [],
    ts: Date.now()
  };
  entry.assistant = assistant;
  entry.busy = true;
  entry.activeExecutionTurnId = randomUUID();
  entry.preparedBgDigest = undefined;
  entry.activeDesktopTurnId = messagingInput ? undefined : randomUUID();
  entry.execution = undefined;
  entry.abortRequested = false;
  entry.abortError = undefined;
  entry.holdQueueAfterTurn = false;
  entry.openWorkerNativeTools = undefined;
  entry.assignmentDelivery = undefined;
  entry.lastSteeredTexts = [];
  entry.turnRetryAttempt = 0;
  cancelTurnRetry(entry);
  entry.lastTurnInput = {
    text: input.text,
    userText: originalUserText,
    ...(messagingInput ? { literalText: true } : {}),
    userMessageId: input.userMessageId,
    assistantMessageId: assistant.id,
    ...(input.images ? { images: input.images } : {})
  };
  // busy 置位后的簿记（消息入列/落盘/广播）也在 try 内：任一环节抛错都走统一
  // 收口（标错误 + finishTurn），否则 busy 卡死而调用方的 .catch 静默无感
  try {
    const desktopTurnId = entry.activeDesktopTurnId;
    const workspaceId = host.ctx.sessions.get(entry.sessionId)?.workspaceId ?? '';
    if (desktopTurnId) host.ctx.desktopTurns?.().begin(entry.sessionId, desktopTurnId, () =>
      entry.busy && !entry.closed && !entry.clearing && !entry.abortRequested && entry.activeDesktopTurnId === desktopTurnId,
    input.desktopUserInstruction === true, input.userMessageId,
    workspaceId || input.desktopContinuation
      ? { workspaceId, ...(input.desktopContinuation ? { continuation: input.desktopContinuation } : {}) }
      : undefined);
    push(host, { kind: 'execution', sessionId: entry.sessionId });
    beginWorkspaceContext(host, entry);
    const insertAt = input.insertAt;
    if (insertAt != null && insertAt >= 0 && insertAt <= entry.messages.length) {
      entry.messages.splice(insertAt, 0, assistant);
    } else {
      entry.messages.push(assistant);
    }
    entry.turnStartedAt = Date.now();
    entry.activeTurnStartedAt = entry.turnStartedAt;
    applySignal(host, entry, 'active', 'gui-turn-start');
    persistEntry(host, entry, insertAt != null && insertAt < entry.messages.length - 1 ? 'replace' : [entry.messages.find(message => message.id === input.userMessageId), assistant]);
    syncEntry(host, entry);
    push(host, { kind: 'busy', sessionId: entry.sessionId, busy: true, queued: entry.queue.length });
    // Review registration is synchronous and never delays the connection;
    // its background preparation cannot fail this turn.
    beginFileChanges(host, entry, assistant);
    if (entry.closed || entry.assistant !== assistant || entry.abortRequested) {
      finishFileChanges(host, entry, assistant);
      if (entry.abortRequested && entry.assistant === assistant) await stopBeforeDispatch(host, entry);
      return;
    }

    const source = host.ctx.sessions.get(entry.sessionId);
    const route = source?.workerRouting;
    const routeTarget = route && route.phase === 'starting' ? await resolveSessionTarget(host.ctx.config.get(), route.plan.scope) : undefined;
    if (route && routeTarget) {
      assertWorkerRouteCurrent(host.ctx, routeTarget, route.plan);
      if ('targetRef' in route.plan.requested) await validateWorkerReference(host.ctx, routeTarget, route.plan.requested.targetRef);
    }
    if (originalUserText !== undefined && !source?.workspaceId && hasWorkerModelMentions(input.text)) throw new Error('Worker model references need a registered source folder.');
    const preparedText = originalUserText !== undefined && source?.workspaceId ? await prepareWorkerModelMentions(host.ctx,
      { workspaceId: source.workspaceId, rootId: source.sourceRoot?.rootId, cwd: source.sourceRoot?.cwd ?? entry.cwd, capturedSource: source.sourceRoot }, input.text) : input.text;
    const parameters = await parameterSnapshot(host, entry.sessionId);
    if (entry.closed || entry.assistant !== assistant) return;
    if (entry.abortRequested) {
      assistant.aborted = true;
      await stopBeforeDispatch(host, entry);
      return;
    }
    if (parameters.unavailable) {
      const session = host.ctx.sessions.get(entry.sessionId);
      const hasOverrides = !!session?.thinkingLevel || Object.keys(session?.modelParameters ?? {}).length > 0;
      const hasProfiles = hasConfiguredModelParameterDefault(parameters, host.ctx.config.get().modelParameterProfiles ?? []);
      if (hasOverrides || hasProfiles) throw new Error(t('模型参数尚未读取，请手动刷新模型目录后重试'));
    }
    entry.turnModelParameters = parameters;
    Object.freeze(parameters.values);
    if (parameters.warning) {
      log(host, entry, 'warn', parameters.warning);
      push(host, { kind: 'parameters', sessionId: entry.sessionId, controls: parameters.controls, warning: parameters.warning, providerId: parameters.providerId, modelId: parameters.modelId });
    }
    const preparationForkError = forkContextFailure(entry);
    if (preparationForkError) throw new Error(preparationForkError);
    // The parameter checks above are local and cannot change engine state.
    // Persist the guard immediately before connection reuse/replacement or
    // startup, the first step that can touch the engine.
    startForkGuardTurn(host, entry);
    const conn = await ensureConnection(host, entry);
    if (entry.closed) return;
    if (entry.assistant !== assistant) return; // 期间被 abort/close
    const connectionForkError = forkContextFailure(entry);
    if (connectionForkError) throw new Error(connectionForkError);
    if (entry.abortRequested) {
      // A connection established after stop must be reclaimed before the next
      // writer or queued message is allowed to start.
      entry.assistant.aborted = true;
      await stopBeforeDispatch(host, entry, conn);
      return;
    }
    // skill 正文装配只进引擎（转写仍是 token）：/skill:name 显式加载 + 点名即加载
    // （A2；单回合 20k 预算，超限拒自动注入；详见 shared/skillInject.ts）
    const skillPrep = messagingInput ? { text: preparedText, injectedIds: [] } : await prepareEngineSkillText(preparedText, {
      target: guiSkillTargetForRuntime(entry.runtimeId, host.ctx.runtimes.list()),
      cwd: entry.turnWorkspaceContext?.cwd ?? entry.cwd,
      workspaceContext: entry.turnWorkspaceContext,
      sessionId: entry.sessionId,
      budget: skillTurnBook().beginTurn(entry.sessionId),
      alreadyInjected: skillTurnBook().injectedOf(entry.sessionId)
    });
    skillTurnBook().noteInjected(entry.sessionId, skillPrep.injectedIds);
    // fork transcript 前缀（引擎无种子回放能力时的降级）：只进引擎，不进 UI 历史
    const pendingForkTranscript = entry.forkTranscript ?? (entry.forkTranscriptSource ? host.store.readForkTranscript(entry.sessionId,entry.forkTranscriptSource,FORK_TRANSCRIPT_MAX) : null);
    entry.forkTranscript=pendingForkTranscript;
    // 后台任务静默结果摘要（同样只进引擎不进 UI；置前不影响用户消息正文）
    const includedTaskId = input.userMessageId?.startsWith('background-wake-') ? input.userMessageId.slice('background-wake-'.length) : undefined;
    const bgDigest = host.ctx.bgTasks?.prepareDigest(entry.sessionId, includedTaskId) ?? null;
    if (bgDigest) {
      entry.preparedBgDigest = { turnId: entry.activeExecutionTurnId!, prepared: bgDigest };
    }
    // C2 计划批准回灌：Approved Plan + 预授权清单进下一回合前缀（取走即清）
    const planFeedback = takePlanApprovedFeedback(entry);
    // A1 read-state 过期提示：上一回合读过的文件被写改，本轮前缀提醒重读
    //（同回合多文件合并一条；取走即清，不重复提示）
    const staleHint = takeReadStateHint(entry);
    let widgetContext: string | undefined;
    try {
      widgetContext = await uiWidgetTurnContext(app.getPath('userData'), entry.sessionId);
    } catch (error) {
      log(host, entry, 'warn', `交互选择读取失败：${String((error as Error).message)}`);
    }
    if (entry.closed || entry.assistant !== assistant || entry.abortRequested) {
      if (entry.abortRequested && entry.assistant === assistant) { entry.assistant.aborted = true; await stopBeforeDispatch(host, entry, conn); }
      return;
    }
    let knowledgeContext = '';
    if (!messagingInput) try {
      const root=resolveMemoryWorkspaceRoot(host.ctx,entry.workspaceId,entry.workspaceId?undefined:entry.cwd);
      const scope=liveTurnRepository(entry)??assistant.turnChanges?.repository;
      const recall=root?await getMemoryService()?.recallKnowledge(root,input.text,'worker',scope?.scopeStable?{root:scope.root,branch:scope.branch}:undefined):'';
      knowledgeContext = formatGuiHostContext(prepareRecall(entry,conn,String(entry.compactionSeq),assistant.id,recall??''));
    }catch(error){clearRecall(entry);log(host,entry,'warn',`知识检索失败：${String(error)}`);}
    if(entry.closed||entry.assistant!==assistant||entry.abortRequested){
      if(entry.abortRequested&&entry.assistant===assistant){assistant.aborted=true;await stopBeforeDispatch(host,entry,conn);}
      return;
    }
    const sendForkError = forkContextFailure(entry);
    if (sendForkError) throw new Error(sendForkError);
    host.modelAdmission.assert(entry.runtimeId, host.ctx.sessions.get(entry.sessionId)?.piModeId, entry.connectionAdmissionModel);
    if (route && !['starting', 'completed'].includes(route.phase)) {
      const checkpoint = structuredClone(route);
      const attempt = checkpoint.attempts.at(-1);
      if (attempt) {
        checkpoint.phase = 'starting';
        attempt.state = 'starting';
        await host.ctx.sessions.commitWorkerRoute(entry.sessionId, attempt.attempt, checkpoint, undefined, () => {
          if (entry.closed || entry.assistant !== assistant || entry.abortRequested) throw new Error('Worker turn stopped before dispatch.');
        });
      }
    }
    const assignment = await reserveInitialAssignment(host.ctx, entry.sessionId, input.userMessageId);
    if (entry.closed || entry.assistant !== assistant || entry.abortRequested) {
      await assignment?.rejectBeforeSubmission();
      if (entry.abortRequested && entry.assistant === assistant) { assistant.aborted = true; await stopBeforeDispatch(host, entry, conn); }
      return;
    }
    if (!assignment && input.userMessageId?.startsWith('assignment-start-')) {
      assistant.aborted = true;
      finishTurn(host, entry);
      return;
    }
    try {
      assertWorkspaceExecutionContextCurrent(host.ctx.config.get(), entry.turnWorkspaceContext);
      assertConnectionConfigurationCurrent(conn);
      if (route && routeTarget) assertWorkerRouteCurrent(host.ctx, routeTarget, route.plan);
      host.modelAdmission.assert(entry.runtimeId, host.ctx.sessions.get(entry.sessionId)?.piModeId, entry.connectionAdmissionModel);
    } catch (error) {
      await assignment?.rejectBeforeSubmission();
      throw error;
    }
    const context = [widgetContext, staleHint, planFeedback, bgDigest?.text, pendingForkTranscript];
    const userInput = knowledgeContext ? `${skillPrep.text}\n\n${knowledgeContext}` : skillPrep.text;
    const prependContext = (prefix: string) => prefix ? `${prefix}\n\n${userInput}` : userInput;
    // Assignment and handoff delivery have their own acknowledgement state.
    entry.lastSentPayload = prependContext(formatGuiHostContext(...context));
    startForkDelivery(host, entry);
    // 只发起、不等待：回合收口由事件泵负责（turn-complete / error / 流结束兜底）。
    // driver 若以 reject 报告运行期失败（cursor 走 error 事件不会 reject），此处与泵
    // 等价兜底收口；assistant 已被替换说明本回合早已收口（abort/重发），直接放过
    markFileChangeExecution(entry);
    if (assignment) {
      entry.assignmentDelivery = { executionTurnId: entry.activeExecutionTurnId!, userMessageId: input.userMessageId, handle: assignment };
    }
    const engineText = assignment || entry.workerRouteHandoff
      ? prependContext(formatGuiHostContext(assignment?.prefix, entry.workerRouteHandoff, ...context)) : entry.lastSentPayload;
    void sendEngineTurn(entry, conn, engineText, input.images, {
      userText: originalUserText,
      ...(messagingInput ? { literalText: true } : {}),
      forkIdentity: { userMessageId: input.userMessageId, assistantMessageId: assistant.id }
    }).catch((e) => {
      if (e instanceof GuiDeliveryError && e.reportedByStream) return;
      if (pendingForkTranscript && entry.forkTranscript === pendingForkTranscript) {
        if (e instanceof GuiDeliveryError && e.delivery === 'not-submitted') markForkNotSubmitted(host, entry);
        else markForkUncertain(host, entry);
      }
      if (entry.assistant !== assistant) return;
      const delivery = e instanceof GuiDeliveryError ? e.delivery : undefined;
      handleTurnFailure(host, entry, (e as Error).message, delivery, classifyWorkerRuntimeFailure(e), delivery ?? 'unknown');
    });
  } catch (e) {
    if (entry.assistant === assistant) {
      if (entry.abortRequested) await stopBeforeDispatch(host, entry);
      else handleTurnFailure(host, entry, (e as Error).message, undefined, classifyWorkerRuntimeFailure(e), 'not-submitted');
    }
    // A stopped/replaced turn owns only its assistant. Its late failure must
    // never settle the replacement turn or discard that turn's pending connection.
    // Review-capture problems cannot reach here: they are absorbed by the tracker
    // and surface on the file card, not as an engine error.
  }
}

/** /skill:name 展开（与 messaging.send 的 busy 分支同源；独立包装便于阅读） */

/**
 * steer 已注入引擎：切开转写回合。旧 assistant 不再接 delta（闭合旧回合），
 * 插话用户消息入流，其后新开 assistant 承接后续输出（新回合）。
 * 不 abort、不定稿 aborted——投递本身是对的，只改渲染分段。
 */
export function splitSteeredTurn(host: HostCore, entry: SessionEntry, userMsg: GuiChatMessage,
  userInstruction = !userMsg.host && !userMsg.source && userMsg.steering !== 'host'): void {
  if (entry.activeExecutionTurnId && userInstruction) {
    entry.memoryAuthority?.close();
    entry.memoryAuthority = createPromptAuthorityScope(undefined);
    const previousDesktopTurn = entry.activeDesktopTurnId;
    if (previousDesktopTurn) host.ctx.desktopTurns?.().end(entry.sessionId, previousDesktopTurn);
    const desktopTurnId = entry.activeDesktopTurnId = randomUUID();
    // A steer keeps the engine's original workspace snapshot; a session move
    // during the turn must not let old work borrow its new workspace identity.
    const workspaceId = entry.turnWorkspaceContext?.workspaceId ?? '';
    host.ctx.desktopTurns?.().begin(entry.sessionId, desktopTurnId, () =>
      entry.busy && !entry.closed && !entry.clearing && !entry.abortRequested && entry.activeDesktopTurnId === desktopTurnId, true, userMsg.id,
      workspaceId ? { workspaceId } : undefined);
  }
  const prev = entry.assistant;
  if (prev) {
    const note = t('回合结束仍未收到该工具的结果');
    finalizeRunningToolParts(prev, note);
  }
  entry.assistant = null;
  entry.messages.push(userMsg);
  const next: GuiChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    parts: [],
    ts: Date.now()
  };
  entry.assistant = next;
  entry.messages.push(next);
  persistEntry(host, entry, [prev, userMsg, next]);
  syncEntry(host, entry);
}

export function cancelTurnRetry(entry: SessionEntry): void {
  if (!entry.turnRetryTimer) return;
  clearTimeout(entry.turnRetryTimer);
  entry.turnRetryTimer = null;
}

/**
 * 回合失败：网络/传输中止则指数退避后续作（保持 busy，不上报调度）；
 * 用尽或非网络错误才 finishTurn。用户点停止走 abortRequested，不进续作。
 */
export function handleTurnFailure(host: HostCore, entry: SessionEntry, message: string, delivery?: GuiDeliveryError['delivery'],
  workerFailure?: WorkerRuntimeFailure, workerBoundary: WorkerFailureBoundary = delivery ?? 'unknown'): void {
  if (!entry.busy) return;
  if (entry.turnRetryTimer) {
    if (delivery !== 'unknown') return;
    cancelTurnRetry(entry);
  }
  markForkGuardUncertain(entry);
  if (entry.forkDeliveryState === 'sending') {
    if (delivery === 'not-submitted') markForkNotSubmitted(host, entry);
    else markForkUncertain(host, entry);
  }
  // 用户停止 / 插话中止：不要当网络错误续作，也不要弹错误横幅
  if (entry.abortRequested) {
    if (delivery === 'unknown') {
      entry.abortError = `${message}；消息投递状态未知，请检查引擎历史`;
      entry.holdQueueAfterTurn = true;
    }
    void stopBeforeDispatch(host, entry);
    return;
  }
  if (handleWorkerRouteFailure(host, entry, message, workerFailure, workerBoundary)) return;
  if (entry.assignmentDelivery) {
    if (workerBoundary === 'not-submitted') void rejectWorkerAssignment(host, entry);
    else {
      const error = `${message} Initial assignment delivery is unconfirmed. Inspect the mailbox before resending.`;
      if (entry.assistant) entry.assistant.error = error;
      push(host, { kind: 'error', sessionId: entry.sessionId, message: error });
      finishTurn(host, entry, { holdQueue: true });
      return;
    }
  }
  log(host, entry, 'error', `回合失败: ${message}`);
  if (entry.forkDeliveryState === 'unknown') {
    const reason = entry.forkPendingError ? `${message}；${entry.forkPendingError}` : `${message}；分叉上下文投递状态未知，已停止自动续作，请检查引擎历史`;
    if (entry.assistant) entry.assistant.error = reason;
    push(host, { kind: 'error', sessionId: entry.sessionId, message: reason });
    finishTurn(host, entry);
    return;
  }
  if (delivery === 'unknown') {
    const reason = `${message}；消息投递状态未知，已停止自动重发，请检查引擎历史后再决定如何继续`;
    entry.holdQueueAfterTurn = true;
    if (entry.assistant) entry.assistant.error = reason;
    push(host, { kind: 'error', sessionId: entry.sessionId, message: reason });
    finishTurn(host, entry, { holdQueue: true });
    return;
  }
  if ((entry.forkTranscriptSource || entry.forkTranscript) && entry.forkDeliveryState === 'pending') {
    // Delivery was rejected before submission (or local preparation failed).
    // Keep the durable prefix for an explicit retry; do not resend on a timer.
    if (entry.assistant) entry.assistant.error = message;
    push(host, { kind: 'error', sessionId: entry.sessionId, message });
    finishTurn(host, entry);
    return;
  }
  if (entry.assistant) entry.assistant.error = message;
  const cfg = normalizeGuiTurnRetryConfig(host.ctx.config.get().guiTurnRetry);
  const plan = planGuiTurnRetry({
    errorMessage: message,
    userAborted: entry.abortRequested,
    nextAttempt: entry.turnRetryAttempt + 1,
    hasProgress: guiTurnHasProgress(entry.assistant),
    config: cfg
  });
  if (plan.action === 'retry') {
    entry.turnRetryAttempt = plan.attempt;
    const delayLabel =
      plan.delayMs < 1000 ? `${plan.delayMs}ms` : `${Math.round(plan.delayMs / 1000)}s`;
    if (entry.assistant) {
      entry.assistant.retryHint = t(
        '⏳ 网络中断（{{error}}），{{delay}}后自动续作 {{attempt}}/{{max}}…',
        {
          error: message.slice(0, 80),
          delay: delayLabel,
          attempt: plan.attempt,
          max: plan.max
        }
      );
    }
    syncEntry(host, entry);
    log(
      host,
      entry,
      'warn',
      `网络中断，${delayLabel} 后自动续作 ${plan.attempt}/${plan.max}（${plan.mode}）：${message.slice(0, 200)}`
    );
    const timer = setTimeout(() => {
      entry.turnRetryTimer = null;
      void resumeFailedTurn(host, entry, plan, message);
    }, plan.delayMs);
    timer.unref?.();
    entry.turnRetryTimer = timer;
    return;
  }
  if (entry.assistant) delete entry.assistant.retryHint;
  if (plan.report === 'network_error') {
    push(host, { kind: 'error', sessionId: entry.sessionId, message });
    finishTurn(host, entry, { outcome: 'network_error' });
    return;
  }
  push(host, { kind: 'error', sessionId: entry.sessionId, message });
  finishTurn(host, entry);
}

export async function resumeFailedTurn(
  host: HostCore,
  entry: SessionEntry,
  plan: Extract<ReturnType<typeof planGuiTurnRetry>, { action: 'retry' }>,
  errorMessage: string
): Promise<void> {
  if (entry.closed || entry.clearing || !entry.busy) return;
  if (entry.abortRequested) {
    await stopBeforeDispatch(host, entry);
    return;
  }
  const assistant = entry.assistant;
  if (assistant) {
    delete assistant.error;
    delete assistant.retryHint;
  }
  syncEntry(host, entry);
  let conn: GuiRuntimeConnection;
  try {
    conn = await ensureConnection(host, entry);
  } catch (e) {
    if (entry.abortRequested) await stopBeforeDispatch(host, entry);
    else handleTurnFailure(host, entry, (e as Error).message);
    return;
  }
  if (entry.closed || entry.assistant !== assistant) return;
  if (entry.abortRequested) {
    await stopBeforeDispatch(host, entry, conn);
    return;
  }
  const input = entry.lastTurnInput;
  const clipped = errorMessage.replace(/\s+/g, ' ').slice(0, 120);
  const text =
    plan.mode === 'continue'
      ? formatGuiHostContext(t('上一回合因网络中断（{{error}}）被掐断，请从中断处继续，不要重复已完成的步骤。', {
          error: clipped
        }))
      : // resend：发 startTurn 存档的最终 payload（skill 展开/fork 前缀/digest 已含）。
        // 引擎从未收到首发（发前失败才可能 null），回落原文与旧行为一致
        (entry.lastSentPayload ?? input?.text ?? '');
  if (!text && !(plan.mode === 'resend' && input?.images?.length)) {
    handleTurnFailure(host, entry, errorMessage);
    return;
  }
  try {
    assertConnectionConfigurationCurrent(conn);
    host.modelAdmission.assert(entry.runtimeId, host.ctx.sessions.get(entry.sessionId)?.piModeId, entry.connectionAdmissionModel);
  }
  catch (error) { handleTurnFailure(host, entry, (error as Error).message); return; }
  entry.execution = undefined;
  push(host, { kind: 'execution', sessionId: entry.sessionId });
  markFileChangeExecution(entry);
  // A continuation is a new native user prompt without a matching GUI user
  // message. Associate only its assistant with the existing displayed reply.
  // A resend can associate the original user only while its original assistant
  // still owns the turn; steering may have split the displayed conversation.
  const resendOwnsAssistant = plan.mode === 'resend' && input?.assistantMessageId === assistant?.id;
  const forkIdentity = assistant && (plan.mode === 'continue' || resendOwnsAssistant)
    ? {
        assistantMessageId: assistant.id,
        ...(resendOwnsAssistant && input?.userMessageId ? { userMessageId: input.userMessageId } : {})
      }
    : undefined;
  void sendEngineTurn(entry, conn, text, plan.mode === 'resend' ? input?.images : undefined, {
    userText: plan.mode === 'resend' ? input?.userText : undefined,
    literalText: input?.literalText,
    forkIdentity
  }).catch((e) => {
    if (e instanceof GuiDeliveryError && e.reportedByStream) return;
    if (entry.assistant !== assistant) return;
    handleTurnFailure(host, entry, (e as Error).message, e instanceof GuiDeliveryError ? e.delivery : undefined);
  });
}

export function finishTurn(host: HostCore, entry: SessionEntry, opts?: { outcome?: 'network_error'; holdQueue?: boolean; confirmed?: boolean }): void {
  if (entry.abortPreparing) return;
  if (entry.execution && entry.execution.process !== 'released') {
    log(host, entry, 'warn', '拒绝提前收口：执行资源尚未释放');
    return;
  }
  if (entry.forkSettlement) {
    if (opts?.confirmed) return;
    entry.forkSettlement = undefined;
  }
  const guarded = !!opts?.confirmed && (!!entry.forkGuardInFlight || !!(entry.forkTranscriptSource || entry.forkTranscript) && entry.forkDeliveryState === 'sending');
  const settlement = guarded ? Symbol('fork-settlement') : undefined;
  if (settlement) entry.forkSettlement = settlement;
  else {
    markForkGuardUncertain(entry);
    if (entry.forkDeliveryState === 'sending') markForkUncertain(host, entry);
  }
  if (!entry.busy) return;
  if (entry.activeDesktopTurnId) host.ctx.desktopTurns?.().end(entry.sessionId, entry.activeDesktopTurnId);
  // If a compact operation is interrupted by a stream/stop event, its late
  // promise must not release a newer turn or settle that turn's fork guard.
  entry.compactOperation = undefined;
  const holdQueue = !!entry.holdQueueAfterTurn || !!opts?.holdQueue;
  entry.holdQueueAfterTurn = false;
  cancelTurnRetry(entry);
  // skill 正文回合预算随回合收口清零（下次 startTurn 重建）
  skillTurnBook().endTurn(entry.sessionId);
  // 回合收口时悬挂的审批/提问必须终态化：引擎异常/流中断路径下 promise 无人
  // resolve、消息上的卡字段删不掉（assistant 已换人）——不结会永远挂着可点的
  // 僵尸卡，看板也停在 blocked（finishTurn 的 idle 信号被 active 卡拦住）
  cancelPlanApproval(entry);
  if (entry.activeApproval) {
    const ap = entry.activeApproval;
    entry.activeApproval = null;
    if (entry.assistant) entry.assistant.approval = undefined;
    ap.resolve({ approved: false, reason: t('回合已结束，审批自动取消') });
  }
  if (entry.activeUserQuestion) {
    resolveUserQuestionInternal(host, entry, entry.activeUserQuestion.questionId, {
      kind: 'aborted'
    });
  }
  if (entry.abortRequested && entry.assistant && entry.execution?.result !== 'completed') {
    entry.assistant.aborted = true;
    if (entry.abortError) entry.assistant.error = entry.abortError;
    else delete entry.assistant.error;
  }
  // 收口兜底：仍 running 的工具卡必须终态化。事件丢了就再也不会来（Cursor 服务端
  // 对并行工具偶发不发完成事件，中止/引擎异常/worker 崩溃同理）——不收口则工具卡
  // 与轨迹页的进行中动画永远转，且随消息持久化在重启后复活。轨迹账本同步补合成的
  // tool-call-end，行才能停转。
  const finishedAssistant = entry.assistant;
  finishFileChanges(host, entry);
  if (finishedAssistant) {
    delete finishedAssistant.retryHint;
    // 空转回合守卫（2026-09-25 诊断）：引擎进程秒退/未登录断连时事件流静默结束，
    // 兜底 finish 会留一条空 assistant——用户只看到「空回复+回合结束」，不知差什么。
    // 有 error/aborted 标记或已产出内容（工具/正文）的回合不算空转。
    if (
      !finishedAssistant.aborted &&
      !finishedAssistant.error &&
      !guiTurnHasProgress(finishedAssistant)
    ) {
      finishedAssistant.error = t(
        '引擎未产生任何输出即结束回合（runtime 可能未安装/未登录，或连接立即断开）。可在设置 → Worker 终端找到该 runtime 点「检测」排查'
      );
    }
    const note = finishedAssistant.aborted
      ? t('回合已中止，未收到该工具的结果')
      : t('回合结束仍未收到该工具的结果');
    finalizeRunningToolParts(finishedAssistant, note);
    finishedAssistant.finishedAt = Date.now();
    if (entry.turnRetryAttempt > 0) finishedAssistant.retryAttempts = entry.turnRetryAttempt;
  }
  // An empty turn is marked as an error above. Fork deliveries remain uncertain until
  // their strict snapshot settles, so conservatively resend the full context next time.
  finishRecall(entry,entry.connection,String(entry.compactionSeq),finishedAssistant?.id??'',
    !!opts?.confirmed&&!settlement&&!!finishedAssistant&&!finishedAssistant.error&&!finishedAssistant.aborted);
  const preparedDigest = entry.preparedBgDigest;
  if (preparedDigest && preparedDigest.turnId === entry.activeExecutionTurnId && opts?.confirmed && !settlement &&
      finishedAssistant && !finishedAssistant.error && !finishedAssistant.aborted) {
    try { host.ctx.bgTasks?.ackDigest(preparedDigest.prepared); }
    catch (error) {
      log(host, entry, 'error', `后台结果确认保存失败，已保留待重试摘要: ${String(error)}`);
      host.ctx.ui?.notify?.(t('后台任务'), '结果确认保存失败，已保留待重试摘要');
    }
  }
  const retryAttempts = entry.turnRetryAttempt;
  entry.memoryAuthority?.close();
  entry.memoryAuthority = undefined;
  const releaseTurn = (): void => {
    entry.assistant = null;
    entry.busy = false;
    entry.activeExecutionTurnId = undefined;
    entry.preparedBgDigest = undefined;
    entry.assignmentDelivery = undefined;
    entry.activeDesktopTurnId = undefined;
    endWorkspaceContext(entry);
    entry.abortRequested = false;
    entry.abortError = undefined;
    entry.lastSteeredTexts = [];
    entry.activeTurnStartedAt = undefined;
    entry.turnRetryAttempt = 0;
    entry.lastTurnInput = null;
    entry.lastSentPayload = null;
  };
  if (settlement) { entry.activeExecutionTurnId = undefined; entry.activeDesktopTurnId = undefined; }
  else releaseTurn();
  // 流式节流落盘的尾款：回合收口即写终态
  cancelStreamingPersist(host, entry.sessionId);

  // 执行态的中止/出错收口：复位执行标志并让卡退回待确认（保留已勾进度）——
  // 否则卡面永远停在「执行中」且无任何按钮，pi 还会每回合注入「继续执行」上下文、
  // cursor 保持 agent 档，与用户「停下」的意图相反。abortRequested 在上方已复位，
  // 中止意图读 finishedAssistant.aborted（上方收口时已写在卡上）
  let planExecutionReset = false;
  if (
    entry.planExecuting &&
    entry.modeController.executing &&
    (finishedAssistant?.aborted || finishedAssistant?.error)
  ) {
    entry.planExecuting = false;
    entry.modeController.executing = false;
    planExecutionReset = true;
    const planMsg = entry.messages.find((m) => m.id === entry.planMessageId);
    if (planMsg?.plan && planMsg.plan.status === 'executing') {
      planMsg.plan = { ...planMsg.plan, status: 'pending' };
    }
  }

  // 计划流引擎无关：工具捕获（cursor createPlan 等）在 tool-start 即时挂卡，
  // 正文提取（pi 约定）在收口兜底——两条路径共用同一张 PlanCard。
  // 执行态被中止/出错的回合跳过正文提取：半截正文提不出可靠计划，卡已退回待确认
  if (!planExecutionReset) updatePlanAfterTurn(host, entry, finishedAssistant);
  // 第一回合收口：解除 fork 占位禁写，允许把真实 usage 落入 lastUsage
  entry.skipUsagePersistUntilTurn = false;
  pushContext(host, entry);
  // 回合截图证据（任务 D）：本回合用过浏览器才截，fire-and-forget，任何失败不影响收口
  void captureTurnShots(host.ctx, entry.sessionId, finishedAssistant?.id);

  persistEntry(host, entry, [finishedAssistant, entry.messages.find(message => message.id === entry.planMessageId)]);
  syncEntry(host, entry);
  const publishFinishedTurn = (): void => {
  const routePhase = host.ctx.sessions.get(entry.sessionId)?.workerRouting?.phase;
  const routePaused = routePhase === 'blocked' || routePhase === 'cancelled';
  push(host, {
    kind: 'busy',
    sessionId: entry.sessionId,
    busy: false,
    queued: entry.queue.length,
    ...(opts?.outcome === 'network_error'
      ? {
          outcome: 'network_error' as const,
          ...(finishedAssistant?.error ? { error: finishedAssistant.error } : {}),
          retryAttempts
        }
      : {})
  });
  if (!entry.activeApproval && !entry.activeUserQuestion && !entry.workerSwitch && !routePaused) {
    applySignal(host, entry, 'idle', 'gui-turn-end');
  }

  if (routePaused) return;

  // 网络死亡用尽续作：不把排队消息打到刚断连的会话上，留给调度处置
  if (opts?.outcome === 'network_error' || holdQueue || entry.forkDeliveryState === 'pending' || entry.forkDeliveryState === 'unknown' || entry.forkPendingError) {
    if (!entry.closed && !entry.clearing && !entry.forkDeliveryState && !entry.forkPendingError && !entry.workerSwitch) maybeAutoCompact(host, entry);
    return;
  }

  const next = entry.queue.shift();
  if (next && !entry.closed && !entry.clearing) {
    // 派发即不再是「排队中」：清掉消息上的标记（渲染层的排队框/胶囊从消息派生）
    const queuedMsg = entry.messages.find((m) => m.id === next.messageId);
    if (queuedMsg) delete queuedMsg.queued;
    applyInjectQueueChange(host, entry);
    // 排队期间带的图片一并发出（对齐调度 drainQueue）
    void startTurn(host, entry, {
      text: next.text,
      userText: queuedMsg && !queuedMsg.host && !queuedMsg.source && queuedMsg.steering !== 'host' ? next.text : undefined,
      desktopUserInstruction: !next.fromInject && !!queuedMsg && !queuedMsg.host && !queuedMsg.source && queuedMsg.steering !== 'host',
      userMessageId: queuedMsg?.id,
      images: next.images
    });
  } else if (!entry.closed && !entry.clearing) {
    // 空闲收口：transcript 占比超阈值则走与 /compact 同一条 compactSession
    maybeAutoCompact(host, entry);
  }
  };
  if (!settlement) {
    publishFinishedTurn();
    return;
  }

  const ownsSettlement = (): boolean => host.entries.get(entry.sessionId) === entry && entry.forkSettlement === settlement &&
    entry.busy && entry.assistant === finishedAssistant && !entry.closed && !entry.clearing &&
    !entry.abortRequested && !entry.abortPreparing && (!entry.execution || entry.execution.process === 'released');
  void host.store.saveSnapshotStrict(entry.sessionId, () => {
    if (!ownsSettlement()) throw new Error('回合已停止或被替代');
    return { messages: entry.messages, lastUsage: entry.lastUsage, injections: entry.injections, compactions: entry.compactions };
  }, () => {
    if (!ownsSettlement()) throw new Error('回合已停止或被替代');
    markForkDelivered(host, entry);
    completeForkGuardTurn(host, entry);
    if (entry.forkPendingError || entry.forkDeliveryState === 'unknown') {
      throw new Error(entry.forkPendingError ?? '分叉上下文的引擎状态未知');
    }
  }).then(() => {
    if (!ownsSettlement()) return;
    entry.forkSettlement = undefined;
    releaseTurn();
    publishFinishedTurn();
  }).catch((error: unknown) => {
    if (entry.forkSettlement !== settlement) return;
    entry.forkSettlement = undefined;
    markForkGuardUncertain(entry);
    if (entry.forkDeliveryState === 'sending') markForkUncertain(host, entry);
    entry.forkPendingError ??= `分叉会话历史无法可靠保存：${(error as Error).message}；请检查本地历史后新建会话`;
    log(host, entry, 'error', entry.forkPendingError);
    push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
    if (entry.assistant === finishedAssistant && finishedAssistant) finishedAssistant.error = entry.forkPendingError;
    if (entry.closed || entry.clearing || entry.abortRequested || entry.abortPreparing || host.entries.get(entry.sessionId) !== entry) return;
    releaseTurn();
    persistEntry(host, entry, [finishedAssistant]);
    syncEntry(host, entry);
    publishFinishedTurn();
  });
}
