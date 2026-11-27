import { commitDisplayEdit } from './eventBus';
import { app } from 'electron';
import { semanticOperationsFor } from '../../runtimeKernel/semanticOperations';
import { desktopTurnGrants } from '../../desktop/turnGrant';
/**
 * 回合执行核心：assistant 占位 → runPiProvider 回合 → 收口计划（planOrchestratorTurnClose）
 * → 熔断喂线/转录索引/气泡/自动重试/排队续发/自治链收口。send 与 retry 共用。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，逻辑逐字保留。）
 */
import { randomUUID } from 'node:crypto';
import { formatNotifyText, type ChatImageAttachment, type ChatMessage } from '../../../shared/types';
import { t } from '../../../shared/i18n';
import { abortPiTurn, runPiProvider } from '../providers/piProvider';
import { classifyContextOverflowMessage, feedBreakerTurnCompleted } from '../../../shared/compactBreaker';
import {
  findRetrySourceMessage,
  isTransientProviderError,
  locateRetryableTurn,
  planOrchestratorTurnClose,
  TURN_AUTO_RETRY_MAX
} from '../turnRetry';
import { locateAbortedTurn } from '../../../shared/chatTurnRail';
import { getModeController } from '../providers/modeExtension';
import { runAsAgentWorkspace, runWithSchedulerDesktopTurnSource } from '../agentScope';
import { composeReadPathTurnText } from './memoryInjection';
import {clearRecall,finishRecall,piRecallEpoch} from '../../memory/recallDedup';
import { expandWorkflowCommand, parseWorkflowCommand } from '../../../shared/workflowCommand';
import { bindModeController, updatePlanCard } from './planModes';
import { releaseTurnGate } from './turnGate';
import { beginSchedulerWorkspaceContext, captureSchedulerWorkspaceContext, getSchedulerConnectionContext } from '../schedulerWorkspaceContext';
import { turnChanges } from '../../turnChanges/runtime';
import type { TurnChangeTracker } from '../../turnChanges/service';
import { reviewRootDirs } from '../../turnChanges/rootDirs';
import { beginSchedulerDesktopTurn, endSchedulerDesktopTurn, observeSchedulerDesktopSteer, type OrchestratorHost } from './internal';
import type { WsAgentBucket } from './types';
import type { HostNotificationDelivery } from '../../../shared/hostNotification';
import { HOST_NOTIFICATION_TRIGGER } from '../../../shared/hostNotification';
import { schedulerIsClosing, trackSchedulerWork } from './lifecycle';
import { hasWorkerModelMentions } from '../../../shared/workerModelMention';
import { prepareWorkerModelMentions } from '../../tasks/workerRouting';
import type { SchedulerWorkbenchRemoteTurn } from './internal';

/** 建 assistant 占位并执行回合（send / 排队续发共用） */
export async function startTurn(
  o: OrchestratorHost,
  bucket: WsAgentBucket,
  wsId: string,
  text: string,
  images?: ChatImageAttachment[],
  host?: boolean,
  notification?: HostNotificationDelivery,
  desktopInstructionId?: string,
  causationId?: string,
  workbenchRemote?: SchedulerWorkbenchRemoteTurn
): Promise<void> {
  if (schedulerIsClosing(o)) throw new Error('Scheduler is shutting down');
  if (!host && !notification) desktopTurnGrants.nextUserMessage(`orchestrator:${wsId}`);
  const assistant: ChatMessage = {
    id: workbenchRemote?.assistantId ?? randomUUID(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    ...(notification ? { hostEvent: 'pending' as const } : {}),
    createdAt: Date.now()
  };
  const previous = bucket.streamingAssistant;
  try {
    bucket.display.push(assistant);
    bucket.streamingAssistant = assistant;
    try { o.emit('agent:message', { ...assistant, workspaceId: wsId }); }
    catch (error) {
      bucket.display.splice(bucket.display.indexOf(assistant), 1);
      bucket.streamingAssistant = previous;
      throw error;
    }
    await runTurn(o, bucket, wsId, text, assistant, images, host, notification, desktopInstructionId, causationId, workbenchRemote);
  } finally { notification?.settled?.(); }
}

/**
 * 重试失败回合：丢弃失败 assistant（连同其错误展示），复用对应的用户消息文本
 * 重跑。Pi 侧上下文里会多一份用户消息副本，与用户手动「继续」等价。
 *
 * 失败回合可能被 busy 期间排队/插话的消息垫在 display 后面（失败不 drain，队列
 * 原地滞留等重试成功后再续发），定位走 locateRetryableTurn 从尾部跳过它们；新
 * 占位插回原位，排队消息保持在它之后、成功后照常 drain。
 *
 * 同步返回「是否受理」——回合本身是长任务，脱钩执行，失败由 runTurn 收口成
 * agent:done。调用方据此立即给出反馈，不必猜测何时该解除 busy。
 */
export function retry(o: OrchestratorHost, wsId: string): { accepted: boolean; error?: string } {
  if (schedulerIsClosing(o)) return { accepted: false, error: 'Scheduler is shutting down' };
  const bucket = o.ensureBucket(wsId);
  if (bucket.busy) return { accepted: false, error: t('该工作区 Agent 正忙，请等当前回合结束') };

  const display = bucket.display;
  const failedIdx = locateRetryableTurn(display);
  if (failedIdx < 0) {
    return { accepted: false, error: t('没有可重试的失败回合') };
  }
  if (display[failedIdx].hostEvent === 'pending') return { accepted: false, error: t('宿主事件尚未进入上下文，已保留在待投递队列') };
  const hostEvent = display[failedIdx].hostEvent === 'consumed';
  const source = hostEvent ? undefined : findRetrySourceMessage(
    display,
    failedIdx,
    (m) => m.role === 'user' && !m.queued && !m.host
  );
  const text = hostEvent ? `${HOST_NOTIFICATION_TRIGGER}\n继续处理刚才未完成的宿主事件；使用已有事件上下文，先核对已完成的操作，避免重复副作用。只有有用结论或需要人介入才汇报。` : source?.content ?? '';
  const images = source?.images;
  if (!text && (!images || images.length === 0)) {
    return { accepted: false, error: t('找不到失败回合对应的用户消息') };
  }

  const assistant: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: Date.now()
  };
  if (hostEvent) assistant.hostEvent = 'consumed';
  commitDisplayEdit(o, wsId, { removeIds: [display[failedIdx].id], upsert: [{ message: assistant, index: failedIdx }] });
  bucket.streamingAssistant = assistant;

  void runTurn(o, bucket, wsId, text, assistant, images, hostEvent).catch((e) =>
    console.error('[orchestrator] retry turn failed', e)
  );
  return { accepted: true };
}

/**
 * 重新编辑已手动终止回合的用户消息：移除该轮用户消息与已终止助手回复，
 * 返回原文本与随文图片供前端填入输入框重新编辑。
 */
export function recallAborted(
  o: OrchestratorHost,
  wsId: string,
  messageId?: string
): {
  ok: boolean;
  text?: string;
  images?: ChatImageAttachment[];
  error?: string;
} {
  const bucket = o.ensureBucket(wsId);
  if (bucket.busy) {
    return { ok: false, error: t('该工作区 Agent 正忙，请等当前回合结束') };
  }

  const display = bucket.display;
  const loc = locateAbortedTurn(display, messageId);
  if (!loc) {
    return { ok: false, error: t('没有可重新编辑的终止消息') };
  }
  const source = display[loc.userIdx]!;
  const text = source.content.trim();
  const images = source.images?.length ? source.images : undefined;
  if (!text && !images?.length) {
    return { ok: false, error: t('没有可重新编辑的终止消息') };
  }

  const head = display.slice(0, loc.userIdx);
  const tailQueued = display.slice(loc.userIdx).filter((m) => m.queued);
  const retained = [...head, ...tailQueued];
  const changedPlans: ChatMessage[] = [];

  let activePlanMsg: ChatMessage | null = null;
  for (const m of retained) {
    if (m.plan?.status === 'pending') activePlanMsg = m;
  }
  for (const m of retained) {
    if (m !== activePlanMsg && m.plan?.status === 'pending') changedPlans.push({ ...m, plan: { ...m.plan, active: false } });
  }
  const modeCtrl = getModeController(wsId);
  if (activePlanMsg?.plan) {
    changedPlans.push({ ...activePlanMsg, plan: { ...activePlanMsg.plan, active: true } });
  }

  commitDisplayEdit(o, wsId, { removeIds: display.slice(loc.userIdx).filter(message => !message.queued).map(message => message.id),
    upsert: changedPlans.map(message => ({ message })) }, () => {
      if (modeCtrl) modeCtrl.planSteps = activePlanMsg?.plan?.steps.map(step => ({ ...step })) ?? [];
    });
  o.persistBucket(wsId);
  o.ctx.ui.setBubble(t('待命'), 'idle', wsId);
  return { ok: true, text, ...(images ? { images } : {}) };
}

/** 执行一个回合（send / retry 共用）：占位 assistant 已入列。host=true 时为
 *  自治回合：不建用户消息证据面（B3 直写门 MAJOR-1，经 runPiProvider turnKind='host'）。 */
function runTurn(...args: Parameters<typeof runTurnOwned>): Promise<void> {
  return trackSchedulerWork(args[0], () => runTurnOwned(...args));
}

async function runTurnOwned(
  o: OrchestratorHost,
  bucket: WsAgentBucket,
  wsId: string,
  text: string,
  assistant: ChatMessage,
  images?: ChatImageAttachment[],
  host?: boolean,
  notification?: HostNotificationDelivery,
  desktopInstructionId?: string,
  causationId?: string,
  workbenchRemote?: SchedulerWorkbenchRemoteTurn
): Promise<void> {
  bucket.busy = true;
  bucket.workbenchRemoteAssistantId = workbenchRemote?.assistantId;
  const cause = causationId ?? desktopInstructionId ?? assistant.id;
  void Promise.resolve().then(() => semanticOperationsFor(o.ctx, `orchestrator:${wsId}`, app.getPath('userData'), o.ctx.sessionLogs)
    .fact('scheduler.turn-started', assistant.id, [cause], { assistantId: assistant.id, host: !!host }))
    .catch(error => console.error('[scheduler] turn start fact failed', wsId, error));
  const desktopExecution = {};
  bucket.desktopExecution = desktopExecution;
  bucket.desktopPendingSteers = [];
  bucket.desktopSteersInFlight = 0;
  let initialUserSeen = false;
  // 新回合开始即作废待触发的自动重试（用户/事件已推进对话，旧的重发计划过时）
  const pendingRetry = o.autoRetryTimers.get(wsId);
  if (pendingRetry) {
    clearTimeout(pendingRetry);
    o.autoRetryTimers.delete(wsId);
  }
  o.ctx.usage.recordSessionActivity(`scheduler:${wsId}`, { name: '调度 Agent', runtime: 'scheduler', workspaceId: wsId });
  o.ctx.usage.recordDispatchTurn();

  const forceNewSession = bucket.resetPiOnNextSend;
  bucket.resetPiOnNextSend = false;
  // R-12 调度记忆前缀 + B5 读路径（trigger/Lane2）：桶建立/clearHistory/compact 后的
  // 首个回合、或记忆版本变化时把内容作为**回合文本前缀**注入（进 LLM 上下文；display
  // 用户消息仍是原文，UI 不重复显示）。host 自治回合只保留 R-12 前缀（无 trigger/
  // Lane2）；失败 fail-open 不挡回合。
  // 工作流命令（/workflow-new、/workflow）：只在进引擎的文本里展开成指令，界面仍显示原文
  const wfCmd = host || workbenchRemote ? null : parseWorkflowCommand(text);
  const engineText = wfCmd ? expandWorkflowCommand(wfCmd) : text;
  let releaseWorkspaceContext: (() => void) | undefined;
  let fileChanges: TurnChangeTracker | undefined;
  try {
    if (workbenchRemote?.signal.aborted) { assistant.aborted = true; return; }
    if (!workbenchRemote) beginSchedulerDesktopTurn(o, bucket, wsId, !host && !notification ? desktopInstructionId : undefined, notification?.desktopContinuation);
    const workspaceContext = captureSchedulerWorkspaceContext(o.ctx.config.get(), wsId, bucket.piSession, bucket.piSessionFile, !!forceNewSession);
    if(forceNewSession||bucket.piSession&&JSON.stringify(getSchedulerConnectionContext(bucket.piSession))!==JSON.stringify(workspaceContext))clearRecall(bucket);
    releaseWorkspaceContext = beginSchedulerWorkspaceContext(o.ctx.config, workspaceContext);
    assistant.turnChanges = { id: '', state: 'collecting', files: [], warnings: [] };
    o.emit('agent:message', { ...assistant, workspaceId: wsId });
    o.persistBucket(wsId);
    // Register synchronously before the provider; capture does not scan roots.
    fileChanges = turnChanges().begin(`dispatch:${wsId}`, assistant.id, workspaceContext.cwd, workspaceContext.writableDirectories.map(d => d.path), reviewRootDirs(workspaceContext));
    // The live summary (real snapshot ID, coverage warnings) is published
    // synchronously; background preparation never gates the provider.
    assistant.turnChanges = { ...fileChanges.summary };
    o.emit('agent:message', { ...assistant, workspaceId: wsId });
    o.persistBucket(wsId);
    // Late repository identity lands while this turn's message is still current.
    const review = fileChanges;
    void review.ready.then(() => {
      if (o.buckets.get(wsId) !== bucket) return;
      if (!bucket.display.includes(assistant)) return;
      if (assistant.turnChanges?.id !== review.summary.id || assistant.turnChanges?.finalizing || assistant.turnChanges?.state !== 'collecting') return;
      assistant.turnChanges = { ...review.summary };
      o.emit('agent:message', { ...assistant, workspaceId: wsId });
      o.persistBucket(wsId);
    }).catch(() => { /* ready never rejects */ });
    if (assistant.aborted || schedulerIsClosing(o)) return;
    let checkedText = engineText;
    if (!host && !notification && !workbenchRemote && hasWorkerModelMentions(engineText)) {
      checkedText = await prepareWorkerModelMentions(o.ctx, { workspaceId: wsId, rootId: workspaceContext.sourceRootId,
        rootsRevision: workspaceContext.rootsRevision, cwd: workspaceContext.cwd }, engineText);
    }
    if (assistant.aborted || schedulerIsClosing(o)) return;
    const turnText = await composeReadPathTurnText(o.ctx, bucket, wsId, checkedText, host, assistant.id);
    if (assistant.aborted || schedulerIsClosing(o)) return;
    // A fresh human turn supersedes its previous report. Background wakes preserve it.
    if (!host && !notification) o.ctx.schedulerStatus?.remove(wsId);
    bindModeController(o, wsId);
    o.ctx.ui.setBubble(t('思考中…'), 'thinking', wsId);
    try { fileChanges?.markExecutionStarted?.(); }
    catch (error) { console.error('[orchestrator] review execution boundary failed', error); }
    await runAsAgentWorkspace(wsId, () => runWithSchedulerDesktopTurnSource(() => {
      if (bucket.desktopExecution !== desktopExecution) return undefined;
      const id = bucket.desktopTurnId;
      return id ? { sessionId: `orchestrator:${wsId}`, desktopTurnId: id,
        isDesktopCurrent: () => bucket.busy && bucket.desktopTurnId === id } : undefined;
    }, () => runPiProvider({
        ctx: o.ctx,
        text: turnText,
        notification,
        onPiEvent: event => {
          if (bucket.desktopExecution !== desktopExecution || event.type !== 'message_start') return;
          const message = event.message as { role?: unknown } | undefined;
          if (message?.role !== 'user') return;
          if (!initialUserSeen) { initialUserSeen = true; return; }
          try { observeSchedulerDesktopSteer(o, bucket, wsId, event); }
          catch (error) { console.error('[orchestrator] desktop steer observation failed', error); }
        },
        onNotification: (summary, id) => {
          if (notification) assistant.hostEvent = 'consumed';
          const activity: ChatMessage = { id, role: 'user', host: true, content: summary, createdAt: Date.now() };
          const index = bucket.display.indexOf(assistant);
          commitDisplayEdit(o, wsId, { upsert: [{ message: activity, index: index < 0 ? bucket.display.length : index },
            ...(notification ? [{ message: assistant }] : [])] });
          o.persistBucket(wsId);
        },
        images,
        assistant,
        fileChanges,
        forceNewSession,
        openSessionFile: bucket.piSessionFile,
        onSessionCreated: (file) => {
          bucket.piSessionFile = file;
        },
        workspaceId: wsId,
        workspaceContext,
        mode: bucket.mode,
        turnKind: host ? 'host' : 'user',
        originalUserText: host || workbenchRemote ? undefined : text,
        literalText: !!workbenchRemote,
        targetModel: {
          providerId: bucket.providerId,
          modelId: bucket.modelId
        },
        getThinkingLevel: () => o.getThinkingLevel(wsId),
        emit: (c, p) => {
          if (p && typeof p === 'object') {
            const status = c === 'agent:context' ? o.getContextStatus(wsId) : undefined;
            const extra = status ? { thinking: status.thinking, injection: status.injection } : {};
            o.emit(c, { ...(p as object), ...extra, workspaceId: wsId });
          } else {
            o.emit(c, p);
          }
        },
        getSession: () => bucket.piSession,
        setSession: (s) => {
          bucket.piSession = s;
          if (s && schedulerIsClosing(o)) abortPiTurn(wsId, s);
        },
        // 插话切分（queueOps.sendNow steer）换 bucket.streamingAssistant 后，
        // provider 的流式 delta/终态章都落新占位；未切分时回落本回合占位
        getAssistant: () => bucket.streamingAssistant ?? assistant
      }))
    );
    finishRecall(bucket,bucket.piSession,piRecallEpoch(bucket.piSession),assistant.id,!assistant.aborted&&!assistant.error&&bucket.streamingAssistant===assistant);
  } catch (e) {
    finishRecall(bucket,bucket.piSession,piRecallEpoch(bucket.piSession),assistant.id,false);
    const msg = (e as Error).message;
    // 插话切分后错误章落当前占位（终态可见），未切分即本回合占位
    (bucket.streamingAssistant ?? assistant).error = msg;
    if (forceNewSession) bucket.resetPiOnNextSend = true;
    o.invalidatePiSession(wsId);
    // B2 spike：超窗错误面可结构化识别（classifyContextOverflowMessage，模式移植
    // 自 pi-ai overflow.js）。pi 已在回合内自动做过一次 compact+重试（agent-session
    // _checkCompaction case 1），回合仍以超窗失败收场说明恢复无效——宿主不再重试
    // （防连环重试），只做结构化归因日志；后续阈值压缩会按熔断状态机决定是否执行。
    if (classifyContextOverflowMessage(msg)) {
      console.error(`[orchestrator] 回合失败含超窗特征（pi 回合内已自动尝试一次压缩+重试；ws=${wsId}）：${msg.slice(0, 200)}`);
    }
    const detail = msg.slice(0, 120) || t('出错了');
    o.ctx.notify.push({
      workspaceId: wsId,
      sessionId: `orchestrator:${wsId}`,
      sessionName: t('调度'),
      kind: 'error',
      text: formatNotifyText(t('调度'), detail),
      update: true,
      updateKey: `orch-error:${wsId}`,
      toast: true
    });
  } finally {
    if (bucket.desktopExecution === desktopExecution) {
      bucket.desktopExecution = undefined;
      bucket.desktopPendingSteers = [];
      bucket.desktopSteersInFlight = 0;
      try { endSchedulerDesktopTurn(o, bucket, wsId); }
      catch (error) { console.error('[orchestrator] desktop turn cleanup failed', error); }
    }
    if (fileChanges) {
      assistant.turnChanges = { ...fileChanges.summary, finalizing: true };
      o.emit('agent:message', { ...assistant, workspaceId: wsId });
      o.persistBucket(wsId);
      // Review settlement is decoupled from the engine lifecycle: busy release,
      // context release and queue dispatch below never wait for the snapshot.
      // A late completion only lands while this bucket, message and snapshot
      // identity are all still current — cleared/replaced turns stay untouched.
      const review = fileChanges, ownerBucket = bucket;
      void review.finish().then(summary => {
        if (o.buckets?.get(wsId) !== ownerBucket || !ownerBucket.display.includes(assistant)) return;
        if (assistant.turnChanges?.id !== summary.id) return;
        assistant.turnChanges = { ...summary };
        o.emit('agent:message', { ...assistant, workspaceId: wsId });
        o.persistBucket(wsId);
        if (summary.state === 'ready' && summary.files.length) turnChanges().requestRetention?.(`dispatch:${wsId}`, { id: summary.id, messageId: assistant.id });
      }).catch(error => {
        console.error('[orchestrator] turn review settlement failed', error);
        if (o.buckets?.get(wsId) === ownerBucket && ownerBucket.display.includes(assistant) && assistant.turnChanges?.id === review.summary.id) {
          assistant.turnChanges = { id: review.summary.id, state: 'error', files: [], warnings: [`改动快照失败：${String(error)}`] };
          o.emit('agent:message', { ...assistant, workspaceId: wsId });
          o.persistBucket(wsId);
        }
      });
    }
    releaseWorkspaceContext?.();
    o.abortPendingAsk(wsId);
    // 终态一律读当前占位：插话切分后 error/aborted/工具计数都落在切分后的新
    // assistant 上（provider getAssistant 同源），读回合起点占位会把失败当成功
    const finalAssistant = bucket.streamingAssistant ?? assistant;
    finalAssistant.finishedAt = Date.now();
    void Promise.resolve().then(() => semanticOperationsFor(o.ctx, `orchestrator:${wsId}`, app.getPath('userData'), o.ctx.sessionLogs)
      .fact(finalAssistant.aborted ? 'scheduler.turn-cancelled' : finalAssistant.error ? 'scheduler.turn-error' : 'scheduler.turn-settled',
        finalAssistant.id, [cause], { assistantId: finalAssistant.id, aborted: !!finalAssistant.aborted, failed: !!finalAssistant.error }))
      .catch(error => console.error('[scheduler] turn outcome fact failed', wsId, error));
    o.persistBucket(wsId);
    const doneMsg = bucket.display[bucket.display.length - 1] ?? finalAssistant;
    // 回合成败看本回合 assistant，不看 display 末条（忙时排队/插话会垫在后面）
    const plan = planOrchestratorTurnClose({
      assistantError: finalAssistant.error,
      queueLength: bucket.queue.length,
      nextRetryAttempt: (o.autoRetryAttempts.get(wsId) ?? 0) + 1,
      toolCallCount: finalAssistant.toolCalls?.length ?? 0
    });
    if (assistant.turnChanges?.state === 'error' && !fileChanges) plan.retryDelayMs = null;
    if (workbenchRemote) plan.retryDelayMs = null;
    if (finalAssistant.hostEvent === 'pending') plan.retryDelayMs = null; // Durable queue owns pre-consumption retry/backoff.
    if (plan.invalidateSession) {
      o.invalidatePiSession(wsId);
    }
    // 执行回合被中止/出错：复位执行标志、重套只读工具面、卡退回待确认（保留
    // 已勾进度）——与 GUI Worker 收口语义一致；否则卡永久停在「执行中」且无
    // 按钮，写工具也保持执行期全量，下一回合还会注入「继续执行」上下文，与
    // 用户「停下」的意图相反。终态标记读本回合 assistant 而非 doneMsg：忙回合
    // 期间排队/插话消息已 push 到 display 末位，doneMsg 是用户消息，其上永远
    // 没有 aborted/error。正常收口（agent_end 里全步完成）时 executing 已被置
    // false，不会进这里
    const modeCtrl = getModeController(wsId);
    if (modeCtrl?.executing && (!!finalAssistant.error || finalAssistant.aborted)) {
      modeCtrl.executing = false;
      modeCtrl.applyTools?.();
      updatePlanCard(o, wsId, (card) =>
        card.status === 'executing' ? { ...card, status: 'pending' } : card
      );
    }
    const doneForUi = plan.failed ? finalAssistant : doneMsg;
    o.emit('agent:done', {
      workspaceId: wsId,
      message: doneForUi,
      ...(plan.drainQueue ? { queuedNext: true } : {})
    });
    workbenchRemote?.settle(finalAssistant.id === workbenchRemote.assistantId ? finalAssistant : undefined);
    if (bucket.workbenchRemoteAssistantId === workbenchRemote?.assistantId) bucket.workbenchRemoteAssistantId = undefined;
    bucket.busy = false;
    // B1 idle 触发的计时锚：微压缩/唤醒判定用的「上次 assistant 完成时间」
    bucket.lastTurnCompletedAt = Date.now();
    // B2 熔断喂线：每个完成的回合让 rapid-refill 窗口计数 +1（成败都算回合）
    bucket.compactBreaker = feedBreakerTurnCompleted(bucket.compactBreaker);
    o.ctx.ui.setBubble(
      plan.failed ? t('请求失败') : doneForUi.aborted ? t('已停止') : t('待命'),
      plan.failed ? 'error' : 'idle',
      wsId
    );
    // 清当前占位引用（必须先于 drain/释放闸：两者都可能同步起下一回合并置新占位）
    bucket.streamingAssistant = undefined;
    if (plan.drainQueue) {
      void o.drainQueue(bucket, wsId);
    } else {
      // 自治链收口：释放闸槽并 drain 满闸 pending（drain 可能立刻起下一回合置 busy）
      releaseTurnGate(o, bucket);
      o.ctx.onOrchestratorIdle?.(wsId);
      // 无排队、无自动重试时：占比超阈走与 /compact 同一条 compactSession
      if (plan.retryDelayMs === null) {
        o.maybeAutoCompact(wsId);
      }
    }
    // 回合收口后安排瞬态失败的自动重发；成功清零连续失败计数；确定性失败
    // （401/额度等，不自动重试）同样清零——否则下次瞬态失败会从旧计数续档
    if (plan.retryDelayMs !== null) {
      o.scheduleTurnAutoRetry(wsId, finalAssistant, plan.retryDelayMs);
    } else if (!plan.failed || !isTransientProviderError(finalAssistant.error)) {
      o.autoRetryAttempts.delete(wsId);
    }
  }
}

/**
 * 回合失败且属瞬态服务错误时，延时自动重发该回合（扛本机重负载/服务抖动的分钟级
 * 窗口；请求级重试 pi 侧已放宽到 ~2 分钟，见 syncPiRetrySettings）。计数按工作区
 * 连续失败累计，任一回合成功即清零，到上限只报错等人工。到点复用 retry()，其定位
 * 会跳过垫在失败回合后的排队/插话消息；未受理（状态漂移）只落日志，不静默假成功。
 */
export function scheduleTurnAutoRetry(o: OrchestratorHost, wsId: string, failedMsg: ChatMessage, delayMs: number): void {
  if (schedulerIsClosing(o)) return;
  const attempt = (o.autoRetryAttempts.get(wsId) ?? 0) + 1;
  if (attempt > TURN_AUTO_RETRY_MAX) return;
  o.autoRetryAttempts.set(wsId, attempt);
  const delaySec = Math.round(delayMs / 1000);
  console.error(
    `[orchestrator] 瞬态回合失败，${delayMs === 0 ? '立即' : `${delaySec}s 后`}自动重试 ${attempt}/${TURN_AUTO_RETRY_MAX}（ws=${wsId} invalidateSession）：${(failedMsg.error ?? '').slice(0, 200)}`
  );
  failedMsg.retryHint =
    delayMs === 0
      ? t('⏳ 会话状态已失效，正在重建并重试（{{attempt}}/{{max}}）…', {
          attempt,
          max: TURN_AUTO_RETRY_MAX
        })
      : t('⏳ 瞬态失败，{{delay}}秒后自动重试回合（{{attempt}}/{{max}}）…', {
          delay: delaySec,
          attempt,
          max: TURN_AUTO_RETRY_MAX
        });
  o.emit('agent:message', { ...failedMsg, workspaceId: wsId });
  const timer = setTimeout(() => {
    o.autoRetryTimers.delete(wsId);
    const res = o.retry(wsId);
    if (!res.accepted) {
      console.error('[orchestrator] 自动重试未受理', wsId, res.error);
    }
  }, delayMs);
  o.autoRetryTimers.set(wsId, timer);
}

/** 出队下一条排队消息并作为新回合发送 */
export async function drainQueue(o: OrchestratorHost, bucket: WsAgentBucket, wsId: string): Promise<void> {
  if (schedulerIsClosing(o)) { releaseTurnGate(o, bucket); return; }
  const next = bucket.queue.shift();
  if (!next || bucket.busy) {
    if (next && bucket.busy) bucket.queue.unshift(next);
    // 队列排空：自治链收口，释放闸槽（busy 分支保留 token——现有回合结束后会再 drain）
    if (!next) releaseTurnGate(o, bucket);
    return;
  }
  const qm = bucket.display.find((m) => m.id === next.id);
  if (qm) {
    delete qm.queued;
    o.emit('agent:message', { ...qm, workspaceId: wsId });
  }
  await startTurn(o, bucket, wsId, next.text, next.images, next.host, undefined, next.host ? undefined : next.desktopInstructionId, next.id);
}

/** 手动停止当前回合：中止 Pi 生成与在途工具；排队消息保留，回合结束后继续 */
export function stop(o: OrchestratorHost, workspaceId: string): { stopped: boolean } {
  o.abortPendingAsk(workspaceId);
  const b = o.buckets.get(workspaceId);
  if (!b || !b.busy) {
    // 空闲但可能挂着等待触发的自动重试：一并取消，避免「已停下」的回合被定时器复活
    const timer = o.autoRetryTimers.get(workspaceId);
    if (!b || !timer) return { stopped: false };
    clearTimeout(timer);
    o.autoRetryTimers.delete(workspaceId);
    const display = b.display;
    for (let i = display.length - 1; i >= 0; i--) {
      const m = display[i]!;
      if (m.role === 'assistant' && m.retryHint) {
        delete m.retryHint;
        o.emit('agent:message', { ...m, workspaceId });
        break;
      }
    }
    return { stopped: false };
  }
  if (b.streamingAssistant?.turnChanges?.preparing) b.streamingAssistant.aborted = true;
  try { endSchedulerDesktopTurn(o, b, workspaceId); }
  catch (error) { console.error('[orchestrator] desktop turn stop failed', error); }
  const assistantId = b.streamingAssistant?.id;
  // Stop remains synchronous and independent of audit I/O. This records the
  // request; only a terminal aborted projection proves cancellation settled.
  abortPiTurn(workspaceId, b.piSession);
  if (assistantId) void Promise.resolve().then(() => semanticOperationsFor(o.ctx, `orchestrator:${workspaceId}`, app.getPath('userData'), o.ctx.sessionLogs)
    .fact('scheduler.cancel-requested', assistantId, [assistantId], { requested: true }))
    .catch(error => console.error('[scheduler] cancellation request fact failed', workspaceId, error));
  return { stopped: true };
}
