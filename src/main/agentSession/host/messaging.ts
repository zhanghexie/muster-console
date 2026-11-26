import { isOpen, materializeForExecution } from './lifecycle';
import { desktopTurnGrants } from '../../desktop/turnGrant';
/**
 * AgentSessionHost 消息入口：send（含忙时 steer/排队）、失败回合重试、中止、
 * 刷新、手动压缩（/compact）与阈值自动压缩。
 * 时序纪律：send 的 TOCTOU 复查、压缩期 busy 门与收口派发顺序即行为合同。
 */
import { app } from 'electron';
import { semanticOperationsFor } from '../../runtimeKernel/semanticOperations';
import { randomUUID } from 'node:crypto';
import { parseRuntimeDeliveryResult, type RuntimeMessage, type RuntimeDeliveryMethod } from '../../../shared/runtimeCommunication';
import { createGuiUserMessage, guiMessageText } from '../../../shared/guiWorker';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import type { ChatImageAttachment } from '../../../shared/types';
import type { ChatTranscriptSource } from '../../../shared/chatMessageSource';
import { locateAbortedTurn } from '../../../shared/chatTurnRail';
import { t } from '../../../shared/i18n';
import { errorMessage } from '../../../shared/errors';
import { captureWorkspaceExecutionContext } from '../../workspaceExecutionContext';
import { assertTaskWorktreeOperationIdle } from '../../git/worktreeTaskOperation';
import { isChatRuntimeId, getChatCapabilities } from '../../../shared/agentRuntimeCapabilities';
import { decideAutoCompact, normalizeAutoCompactConfig } from '../../../shared/autoCompact';
import { prepareEngineSkillText, skillTurnBook } from '../../agent/skillInject';
import { guiSkillTargetForRuntime } from '../../../shared/capabilityManagement';
import {
  findRetrySourceMessage,
  locateRetryableTurn
} from '../../agent/turnRetry';
import type { GuiCompactResult, GuiSendImage } from '../types';
import type { HostCore, SessionEntry } from './internal';
import { MAX_QUEUE } from './internal';
import { applyInjectQueueChange, getDriver, log, persistEntry, push, syncEntry } from './base';
import { pushContext } from './usage';
import { stampCompactionTokens } from './events';
import { resolveApprovalInternal, resolveUserQuestionInternal } from './approvals';
import { rejectImagesForSessionModel } from './usage';
import { isMessagingUserMessageId, MESSAGING_SESSION_OWNER } from '../../messaging/sessionAuthority';
import { acceptMessagingInput } from './messagingInput';
import { cancelTurnRetry, splitSteeredTurn, startTurn, stopBeforeDispatch } from './turn';
import { retirePendingConnection } from './retirement';
import { cancelWorkerHandoff } from './workerRoute';
import { hasWorkerModelMentions } from '../../../shared/workerModelMention';

function forkContextError(entry: SessionEntry): string | undefined {
  return entry.forkPendingError ?? (entry.forkDeliveryState === 'unknown'
    ? '分叉上下文状态未知，请先检查原生历史后新建会话'
    : undefined);
}

/**
 * P5/P11：把宿主提醒回注给 GUI Worker（不抢焦点）。
 * 忙则 steer/排队；未打开则静默。不替 Worker 决定代码内容。
 */
export async function injectHostNudge(
  host: HostCore,
  sessionId: string,
  text: string
): Promise<{ ok: boolean; queued?: boolean; steered?: boolean }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  if (!isOpen(host,sessionId)) return { ok: false };
  return send(host, sessionId, trimmed, undefined, { fromInject: true, hiddenFromTranscript: true });
}

export function send(host: HostCore, sessionId: string, text: string, images?: GuiSendImage[],
  opts?: Parameters<typeof sendInner>[4]): ReturnType<typeof sendInner> {
  if (!opts?.host || !opts.messageId) return sendInner(host, sessionId, text, images, opts);
  const journal = semanticOperationsFor(host.ctx, sessionId, host.semanticRoot ?? app.getPath('userData'), host.ctx.sessionLogs);
  return journal.run('gui.delivery', opts.messageId, [opts.messageId],
    () => sendInner(host, sessionId, text, images, opts), result => result.ok && !result.steerUnsupported);
}

async function sendInner(
  host: HostCore,
  sessionId: string,
  text: string,
  images?: GuiSendImage[],
  opts?: {
    steerOnBusy?: boolean;
    hiddenFromTranscript?: boolean;
    fromInject?: boolean;
    /** 可信历史调度来源：转写用调度身份；输入框发送不得传 */
    source?: ChatTranscriptSource;
    sourceAgent?: import('../../../shared/subagentCharacters').SourceAgentIdentity;
    host?: boolean;
    messageId?: string;
    /** Host IPC already captured this human instruction before attachment processing. */
    desktopPreaccepted?: boolean;
    requireIdle?: boolean;
    /** Host-only continuation evidence, kept out of transcript and engine input. */
    desktopContinuation?: import('../../../shared/hostNotification').HostDesktopContinuation;
    /** Trusted mailbox intent; unsupported native delivery must not enter the host queue. */
    nativeMessage?: RuntimeMessage;
  }
): Promise<{
  ok: boolean;
  queued?: boolean;
  steered?: boolean;
  /** 忙时请求原生插话，但当前连接没有可用的原生插话通道。此结果不入队。 */
  steerUnsupported?: boolean;
  queueDepth?: number;
  error?: string;
  delivery?: RuntimeDeliveryMethod;
}> {
  /**
   * 语义：消息入 UI 历史并提交给引擎。忙时：steerOnBusy !== false 且有
   * redirect（Pi steer）则注入当前回合并返回 steered；否则入队立即返回 queued。
   * 空闲时消息入历史即返回 ok——回合发起（含连接冷启动，可达数十秒）后台
   * 执行，失败由 startTurn 内部收口（转写标错误 + finishTurn）。
   *
   * steer 成功时切开转写：旧 assistant 不再接 delta（闭合旧回合），插话用户
   * 消息入流（不标 queued），其后挂新 assistant 承接后续输出。渲染以最后一条
   * 非 queued user 为当前回合界线，插话+其后回复组成新回合。
   *
   * steerOnBusy=false 供聊天输入框普通发送：忙时一律排队（统一排队面板
   * 「排队自动发送」语义），插话只能经「立即」按钮显式触发（sendNow 传
   * true）。pi steer 是弱打断（工具批边界注入、不打断手头工作），不该在
   * 普通发送时隐式发生。
   *
   * hiddenFromTranscript=true（后台任务唤醒回调）：文本只进引擎不进转写——
   * 空闲开新回合/忙时 steer/steer 失败入队，三种路径都不产生 GuiChatMessage。
   */
  const messagingSession = host.ctx.sessions.get(sessionId);
  const owner = messagingSession?.meta?.[MESSAGING_SESSION_OWNER];
  if (owner) {
    if (!messagingSession?.workspaceId || opts?.host || opts?.source || opts?.fromInject || opts?.hiddenFromTranscript || opts?.nativeMessage) {
      return { ok: false, error: 'This Session is reserved for messaging.' };
    }
    const receipt = acceptMessagingInput(host, sessionId, {
      owner, workspaceId: messagingSession.workspaceId, requestId: opts?.messageId ?? randomUUID(), text, images, origin: 'desktop'
    });
    if (receipt.status === 'accepted') return { ok: true };
    const error = receipt.status === 'unknown' ? 'Messaging input receipt is unknown.' : 'The messaging Session is unavailable or busy.';
    return { ok: false, error };
  }
  const entry = materializeForExecution(host,sessionId);
  if (!entry) throw new Error(t('GUI 会话未打开: {{id}}', { id: sessionId }));
  if (entry.closed) throw new Error(t('会话已关闭'));
  if (entry.workerSwitch) return { ok: false, error: 'The Worker is switching Harness. Send again when the replacement is ready.' };
  const route = host.ctx.sessions.get(sessionId)?.workerRouting;
  if (route && ['blocked', 'cancelled'].includes(route.phase) && (opts?.host || opts?.fromInject || opts?.source)) return { ok: false, error: 'Worker delivery is paused. Review the previous attempt before sending a new instruction.' };
  if (entry.forking) return { ok: false, error: '会话正在分叉，请稍后再发' };
  entry.pendingSends = (entry.pendingSends ?? 0) + 1;
  let externalDeliveryStarted = false;
  try {
  const initialForkError = forkContextError(entry);
  if (initialForkError) return { ok: false, error: initialForkError };
  if (opts?.messageId && entry.messages.some(m => m.id === opts.messageId)) return { ok: true };
  if (opts?.requireIdle && (entry.busy || entry.queue.length > 0 || entry.clearing)) return { ok: false, error: 'busy' };
  const trimmed = (text ?? '').trim();
  const imgs = images && images.length > 0 ? images : undefined;
  if (!trimmed && !imgs) return { ok: false, error: t('消息为空') };
  if (imgs && !getDriver(host, entry.runtimeId)?.supportsImages) {
    return { ok: false, error: t('当前 runtime 暂不支持图片附件') };
  }
  if (imgs) {
    const modelGuard = rejectImagesForSessionModel(host, entry, imgs);
    if (modelGuard) return modelGuard;
  }

  if (entry.clearing) return { ok: false, error: t('会话正在清空，请稍后再发') };

  // Reject unavailable/partly cleaned task directories before accepting history,
  // queueing or steering. startTurn still rechecks at actual dispatch time.
  try {
    const session = host.ctx.sessions.get(sessionId);
    if (session) {
      assertTaskWorktreeOperationIdle(host.ctx.config, sessionId);
      captureWorkspaceExecutionContext(host.ctx.config.get(), session,
        host.ctx.sessions.rootDependencyRoster?.() ?? host.ctx.sessions.list?.());
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }

  if (!opts?.host) host.ctx.sessions.touchUsed(sessionId);
  // 消息侧补 UI 需要的 id（React key / 缩略图）；引擎侧仍按 {data,mimeType} 子集传
  const msgImages = imgs
    ? imgs.map((im, i) => ({
        id: `img-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
        data: im.data,
        mimeType: im.mimeType,
        ...(im.name ? { name: im.name } : {})
      }))
    : undefined;
  const hidden = opts?.hiddenFromTranscript === true;
  const msgSource = opts?.source === 'scheduler' || opts?.source === 'agent' ? opts.source : undefined;
  const userMsg: GuiChatMessage | null = hidden
    ? null
    : createGuiUserMessage({
        id: opts?.messageId ?? randomUUID(),
        text: trimmed,
        ts: Date.now(),
        ...(msgImages ? { images: msgImages } : {}),
        ...(opts?.host ? { host: true } : {}),
        ...(msgSource ? { source: msgSource } : {}),
        ...(msgSource === 'agent' && opts?.sourceAgent ? { sourceAgent: opts.sourceAgent } : {})
      });

  if (userMsg && !userMsg.host && !userMsg.source && !opts?.fromInject) {
    if (!opts?.desktopPreaccepted) host.ctx.desktopTurns?.().noteUserInstruction?.(sessionId, userMsg.id);
    desktopTurnGrants.nextUserMessage(sessionId);
  }
  const remoteBusy = entry.busy && isMessagingUserMessageId(entry.lastTurnInput?.userMessageId);
  const ordinarySteer = !remoteBusy && !entry.forkSettlement && !opts?.nativeMessage && opts?.steerOnBusy !== false && !imgs?.length;
  const userSteerFallback = ordinarySteer && !opts?.fromInject;
  // The GUI send-now contract only needs a boolean capability: true means the
  // adapter can accept a real turn-scoped steer. Adapter-owned native queues
  // are deliberately excluded; the workbench queue is the single fallback.
  const userSteerCapable = getChatCapabilities(entry.runtimeId).steer === 'turn-scoped';

  if (entry.busy) {
    if (remoteBusy && opts?.nativeMessage) return { ok: true, steerUnsupported: true };
    if (userSteerFallback && !userSteerCapable) return { ok: true, steerUnsupported: true };
    // skill 正文装配与首发同源（/skill: + 点名即加载；steer 沿用本回合预算）
    let engineText = trimmed;
    let referenceContext: SessionEntry['turnWorkspaceContext'];
    if (!opts?.host && !msgSource && !opts?.fromInject && ordinarySteer && hasWorkerModelMentions(trimmed)) {
      const context = entry.turnWorkspaceContext;
      if (!context) return { ok: false, error: 'Worker model reference: the active turn has no bound workspace source.' };
      try {
        const { prepareWorkerModelMentions } = await import('../../tasks/workerRouting');
        const source = host.ctx.sessions.get(sessionId)?.sourceRoot;
        engineText = await prepareWorkerModelMentions(host.ctx, { workspaceId: context.workspaceId, rootId: context.sourceRootId,
          rootsRevision: context.rootsRevision, cwd: source?.cwd ?? context.cwd, capturedSource: source }, trimmed);
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
      if (entry.busy && entry.turnWorkspaceContext !== context)
        return { ok: false, error: 'Worker model reference: the active turn changed; resend to validate the current source.' };
      referenceContext = context;
    }
    const skillPrep = await prepareEngineSkillText(engineText, {
      target: guiSkillTargetForRuntime(entry.runtimeId, host.ctx.runtimes.list()),
      cwd: entry.turnWorkspaceContext?.cwd ?? entry.cwd,
      workspaceContext: entry.turnWorkspaceContext,
      sessionId: entry.sessionId,
      budget: skillTurnBook().current(entry.sessionId),
      alreadyInjected: skillTurnBook().injectedOf(entry.sessionId)
    });
    const steerText = skillPrep.text;
    const forkErrorAfterPreparation = forkContextError(entry);
    if (forkErrorAfterPreparation) return { ok: false, error: forkErrorAfterPreparation };
    // TOCTOU 复查：上面的 await 期间回合可能已收口（finishTurn 置 busy=false）或开始
    // 清空/关闭。redirect 打到已收口的连接会把插话注入无人认领的引擎流（落错回合），
    // 故不忙时不得再走 steer——回落到下方「不忙」分支（直接开回合；startTurn 内部
    // 会再做同款 skill 装配，prepareEngineSkillText 对未知命令是幂等原文）
    if (entry.busy && !entry.clearing && !entry.closed) {
      if (referenceContext && entry.turnWorkspaceContext !== referenceContext)
        return { ok: false, error: 'Worker model reference: the active turn changed; resend to validate the current source.' };
      let nativeDelivery: RuntimeDeliveryMethod | undefined;
      if (userSteerFallback && !entry.connection?.receiveMessage && !entry.connection?.redirect) {
        return { ok: true, steerUnsupported: true };
      }
      // A synchronous redirect cannot acknowledge an IPC delivery. Prefer the
      // adapter's asynchronous receipt for GUI steering as well as host mail.
      // Images remain queued because RuntimeMessage does not carry them.
      if (entry.forkSettlement && opts?.nativeMessage) return { ok: false, error: 'busy' };
      if (opts?.nativeMessage || (ordinarySteer && userSteerCapable && entry.connection?.receiveMessage)) {
        const connection = entry.connection;
        const assistant = entry.assistant;
        const message = opts?.nativeMessage
          ? { ...opts.nativeMessage, text: steerText }
          : { intent: 'interrupt' as const, messageId: userMsg?.id ?? randomUUID(), text: steerText };
        const nativeUser = !!userMsg && !userMsg.host && !userMsg.source && !opts?.fromInject;
        if (nativeUser) desktopTurnGrants.noteNativeMessage(sessionId, message.messageId);
        const endDelivery = nativeUser ? desktopTurnGrants.beginUserDelivery(sessionId) : undefined;
        let result: ReturnType<typeof parseRuntimeDeliveryResult>;
        entry.nativeDeliveryInFlight = (entry.nativeDeliveryInFlight ?? 0) + 1;
        try {
          externalDeliveryStarted = !!connection?.receiveMessage;
          result = connection?.receiveMessage
            ? parseRuntimeDeliveryResult(await connection.receiveMessage(message))
            : { status: 'unsupported' as const, reason: '当前接入没有原生消息通道' };
        } finally {
          endDelivery?.();
          entry.nativeDeliveryInFlight = Math.max(0, (entry.nativeDeliveryInFlight ?? 1) - 1);
        }
        if (nativeUser && (result.status !== 'accepted' || result.method !== 'queued')) desktopTurnGrants.consumeNativeMessage(sessionId, message.messageId);
        externalDeliveryStarted = result.status === 'accepted';
        if (result.status === 'deferred') return { ok: false, error: result.reason };
        if (result.status === 'unsupported' && opts?.nativeMessage) return { ok: false, error: 'native-unsupported' };
        if (result.status === 'unsupported' &&
            (entry.closed || entry.clearing || !entry.busy || entry.assistant !== assistant || entry.connection !== connection)) {
          return { ok: false, error: '回合已变化，请重新发送消息' };
        }
        if (result.status === 'unsupported' && userSteerFallback) {
          return { ok: true, steerUnsupported: true };
        }
        if (userSteerFallback && result.status === 'accepted' && result.method !== 'steered') {
          // A true user steer has one meaningful receipt. A queued/sent
          // receipt violates the adapter contract; do not fall back and risk
          // duplicating text whose native submission status is now unknown.
          throw new Error('原生插话返回了非 steered 回执，投递状态未知');
        }
        if (result.status === 'accepted') {
          if (entry.closed || entry.connection !== connection) throw new Error('原生通信期间连接已更换，投递状态未知');
          nativeDelivery = result.method;
          if (nativeDelivery !== 'steered' || !entry.busy || entry.assistant !== assistant) {
            // Native queues remain owned by the adapter; never duplicate them in entry.queue.
            if (userMsg && !entry.messages.some(m => m.id === userMsg.id)) {
              entry.messages.push({ ...userMsg, queued: nativeDelivery === 'queued' });
              persistEntry(host, entry, [entry.messages.at(-1)]); syncEntry(host, entry);
            }
            return { ok: true, delivery: nativeDelivery, queued: nativeDelivery === 'queued' };
          }
        }
      }
      let steered = nativeDelivery === 'steered';
      if (!steered && ordinarySteer && userSteerCapable && entry.connection?.redirect) {
        externalDeliveryStarted = true;
        steered = entry.connection.redirect(steerText);
        externalDeliveryStarted = steered;
      }
      if (!steered) {
        if (entry.queue.length >= MAX_QUEUE) {
          return { ok: false, error: t('排队已满（{{n}}），请等当前回合结束', { n: MAX_QUEUE }) };
        }
        const messageId = userMsg?.id ?? randomUUID();
        if (userMsg) entry.messages.push({ ...userMsg, queued: true });
        entry.queue.push({
          messageId,
          text: trimmed,
          images: imgs,
          ...(opts?.fromInject ? { fromInject: true } : {})
        });
        try { if (userMsg) persistEntry(host, entry, [userMsg]); }
        catch (error) {
          entry.queue.pop();
          if (userMsg) { const at = entry.messages.findIndex(message => message.id === userMsg.id); if (at >= 0) entry.messages.splice(at, 1); }
          throw error;
        }
        syncEntry(host, entry);
        applyInjectQueueChange(host, entry);
        push(host, { kind: 'busy', sessionId, busy: true, queued: entry.queue.length });
        return { ok: true, queued: true, queueDepth: entry.queue.length };
      }
      if (nativeDelivery !== 'steered' && userMsg && !userMsg.host && !userMsg.source && !opts?.fromInject) desktopTurnGrants.nextUserMessage(sessionId);
      // 只有 steer 真投出去才记会话级注入台账：排队/回落路径重排的是原文 trimmed，
      // 之后还要经 startTurn 再装配一次，提前记账会让那次去重把正文整段吞掉
      skillTurnBook().noteInjected(entry.sessionId, skillPrep.injectedIds);
      // 投递已成功（弱 steer 不中止引擎）。切开转写：旧回复定稿，插话+新 assistant 开新回合。
      // 插话语义（pi-trajectory-plan v3）：'send' 标记——开关关闭时渲染为普通用户气泡
      // （现状零变化）；同步落定后记 lastSteeredText，driver 的 steering 事件到达时去重。
      if (userMsg) {
        entry.lastSteeredTexts.push(steerText);
        if (entry.lastSteeredTexts.length > 4) entry.lastSteeredTexts.shift();
        splitSteeredTurn(host, entry, { ...userMsg, steering: 'send' }, !opts?.fromInject && !userMsg.host && !userMsg.source);
      }
      // hiddenFromTranscript（后台任务唤醒）的插话不在此落——steering 事件落 'host'
      // 消息（开关关闭时不渲染，与现状不可见一致）
      push(host, { kind: 'busy', sessionId, busy: true, queued: entry.queue.length });
      return { ok: true, steered: true, delivery: 'steered', queueDepth: entry.queue.length };
    }
    // await 期间已不忙：清空/关闭沿用入口处的拒绝语义；否则按空闲消息开新回合
    if (entry.closed) return { ok: false, error: t('会话已关闭') };
    if (entry.clearing) return { ok: false, error: t('会话正在清空，请稍后再发') };
  }

  if (userMsg) {
    entry.messages.push(userMsg);
    try { persistEntry(host, entry, [userMsg]); }
    catch (error) { entry.messages.splice(entry.messages.indexOf(userMsg), 1); throw error; }
    syncEntry(host, entry);
  }
  // 回合发起不阻塞受理回执：连接冷启动可达数十秒，渲染层 Composer 等 send 返回
  // 才清草稿（失败才回填）。startTurn 内部全路径自收口（连接失败标错误 +
  // finishTurn），await 它不传错误、只剩拖住回执一个效果（队列派发同款 void）。
  void startTurn(host, entry, { text: trimmed, images: imgs, userText: userMsg && !userMsg.host && !userMsg.source ? trimmed : undefined,
    desktopUserInstruction: !opts?.fromInject && !!userMsg && !userMsg.host && !userMsg.source, userMessageId: userMsg?.id ?? (opts?.host ? opts.messageId : undefined),
    ...(opts?.host && opts.desktopContinuation ? { desktopContinuation: opts.desktopContinuation } : {}) }).catch(() => {});
  return { ok: true };
  } catch (error) {
    if (externalDeliveryStarted) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUncertain: true });
    throw error;
  } finally {
    entry.pendingSends = Math.max(0, (entry.pendingSends ?? 1) - 1);
  }
}

/**
 * 失败回合重试：丢掉失败 assistant（连同错误展示），复用对应的用户消息
 * 重跑。不追加用户消息副本——渲染层不得再走 send(原文)（那会污染转写）。
 * 定位走 locateRetryableTurn，跳过垫在失败回合后的排队消息；新 assistant
 * 插回原位。
 */
export function retry(host: HostCore, sessionId: string): { ok: boolean; error?: string } {
  const entry = materializeForExecution(host,sessionId);
  if (!entry) throw new Error(t('GUI 会话未打开: {{id}}', { id: sessionId }));
  if (entry.closed) throw new Error(t('会话已关闭'));
  if (entry.forking) return { ok: false, error: '会话正在分叉，请稍后再试' };
  if (entry.forkPendingError) return { ok: false, error: entry.forkPendingError };
  if (entry.forkDeliveryState === 'unknown') return { ok: false, error: '分叉上下文的上次投递状态未知，请检查引擎历史后新建会话' };
  if (entry.clearing) return { ok: false, error: t('会话正在清空，请稍后再发') };
  if (entry.busy) return { ok: false, error: t('该工作区 Agent 正忙，请等当前回合结束') };

  const failedIdx = locateRetryableTurn(entry.messages);
  if (failedIdx < 0) {
    return { ok: false, error: t('没有可重试的失败回合') };
  }

  const source = findRetrySourceMessage(entry.messages, failedIdx, (m) => m.role === 'user' && !m.queued);
  let text = '';
  let images: GuiSendImage[] | undefined;
  if (source) {
    text = guiMessageText(source).trim();
    if (source.images?.length) {
      images = source.images.map((im) => ({
        data: im.data,
        mimeType: im.mimeType,
        ...(im.name ? { name: im.name } : {})
      }));
    }
  }
  if (!text && !images?.length) {
    return { ok: false, error: t('找不到失败回合对应的用户消息') };
  }

  const removed = entry.messages[failedIdx];
  entry.messages.splice(failedIdx, 1);
  if (entry.assistant && removed && entry.assistant.id === removed.id) {
    entry.assistant = null;
  }
  persistEntry(host, entry, 'replace');
  syncEntry(host, entry);

  // Retry reuses an earlier message; it is not a newly accepted desktop instruction.
  // Text may continue, but a prior stop must remain in force for this turn.
  void startTurn(host, entry, { text, userText: source && !source.host && !source.source && source.steering !== 'host' ? text : undefined,
    desktopUserInstruction: false, userMessageId: source?.id, ...(images ? { images } : {}), insertAt: failedIdx }).catch(
    () => {}
  );
  return { ok: true };
}

/**
 * 重新编辑已手动终止回合的用户消息：移除该轮用户消息与已终止助手回复，
 * 返回原文本与随文图片供前端填入输入框重新编辑。
 */
export function recallAborted(
  host: HostCore,
  sessionId: string,
  messageId?: string
): {
  ok: boolean;
  text?: string;
  images?: ChatImageAttachment[];
  error?: string;
} {
  const entry = materializeForExecution(host,sessionId);
  if (!entry) throw new Error(t('GUI 会话未打开: {{id}}', { id: sessionId }));
  if (entry.closed) throw new Error(t('会话已关闭'));
  if (entry.forking) return { ok: false, error: '会话正在分叉，请稍后再试' };
  if (entry.clearing) return { ok: false, error: t('会话正在清空，请稍后再发') };
  if (entry.busy) return { ok: false, error: t('该工作区 Agent 正忙，请等当前回合结束') };

  const loc = locateAbortedTurn(entry.messages, messageId);
  if (!loc) {
    return { ok: false, error: t('没有可重新编辑的终止消息') };
  }
  const source = entry.messages[loc.userIdx]!;
  const text = guiMessageText(source).trim();
  const images: ChatImageAttachment[] | undefined = source.images?.length
    ? source.images.map((im) => ({
        id: im.id,
        data: im.data,
        mimeType: im.mimeType,
        ...(im.name ? { name: im.name } : {})
      }))
    : undefined;
  if (!text && !images?.length) {
    return { ok: false, error: t('没有可重新编辑的终止消息') };
  }

  try {
    for (const message of entry.messages.slice(loc.userIdx)) {
      if (!message.queued && message.engineInputRef) host.store.removeEngineInput(sessionId, message.id);
    }
  } catch (error) {
    log(host, entry, 'warn', `发送原文清理失败：${(error as Error).message}`);
    return { ok: false, error: t('发送原文清理失败，请重试') };
  }
  const head = entry.messages.slice(0, loc.userIdx);
  const tailQueued = entry.messages.slice(loc.userIdx).filter((m) => m.queued);
  entry.messages = [...head, ...tailQueued];
  if (entry.assistant) entry.assistant = null;
  if (entry.messages.length === 0) {
    skillTurnBook().forgetSession(entry.sessionId);
  }

  let activePlanMsg: GuiChatMessage | null = null;
  for (const m of entry.messages) {
    if (m.plan?.status === 'pending') activePlanMsg = m;
  }
  for (const m of entry.messages) {
    if (m !== activePlanMsg && m.plan?.status === 'pending') {
      m.plan = { ...m.plan, active: false };
    }
  }
  if (activePlanMsg?.plan) {
    activePlanMsg.plan = { ...activePlanMsg.plan, active: true };
    entry.planMessageId = activePlanMsg.id;
    entry.modeController.planSteps = activePlanMsg.plan.steps.map((s) => ({ ...s }));
  } else {
    entry.planMessageId = null;
    entry.modeController.planSteps = [];
  }

  persistEntry(host, entry, 'replace');
  syncEntry(host, entry);
  return { ok: true, text, ...(images ? { images } : {}) };
}

export async function abort(host: HostCore, sessionId: string, opts?: { holdQueue?: boolean }): Promise<void> {
  const entry = host.entries.get(sessionId);
  if (!entry || entry.closed) return;
  cancelWorkerHandoff(host, entry);
  if (!entry.busy) return;
  if (entry.abortPreparing) {
    if (opts?.holdQueue) entry.holdQueueAfterTurn = true;
    await stopBeforeDispatch(host, entry);
    return;
  }
  const stoppedAssistant = entry.assistant;
  const stoppedTurnId = entry.activeExecutionTurnId;
  cancelTurnRetry(entry);
  // The explicit "interrupt then send" fallback must keep the existing host
  // queue in place until the replacement message is accepted. Without this
  // guard finishTurn() immediately dispatches the first queued item, making
  // the fallback send race with the queue drain and leaving a duplicate row.
  if (opts?.holdQueue) entry.holdQueueAfterTurn = true;
  entry.abortRequested = true;
  // A terminal event can arrive before abort() returns. Hold the turn until
  // the connection's cleanup barrier has confirmed process release.
  entry.abortPreparing = true;
  // 先结掉挂起审批（拒绝）与挂起提问（取消），driver 才能继续走到 abort
  if (entry.activeApproval) {
    resolveApprovalInternal(host, entry, entry.activeApproval.approvalId, {
      approved: false,
      reason: t('用户停止了当前回合')
    });
  }
  if (entry.activeUserQuestion) {
    resolveUserQuestionInternal(host, entry, entry.activeUserQuestion.questionId, { kind: 'aborted' });
  }
  try {
    const journal = semanticOperationsFor(host.ctx, sessionId, host.semanticRoot ?? app.getPath('userData'), host.ctx.sessionLogs);
    const operationId = stoppedTurnId ?? stoppedAssistant?.id;
    if (operationId) await journal.run('turn.cancel', operationId, [stoppedAssistant?.id ?? operationId],
      async () => { await entry.connection?.abort(); return { cancelled: true }; }, () => true);
    else await entry.connection?.abort();
  } catch (e) {
    log(host, entry, 'warn', `abort 失败: ${(e as Error).message}`);
    const message = `停止过程报告错误：${(e as Error).message}`;
    if (entry.assistant === stoppedAssistant && entry.activeExecutionTurnId === stoppedTurnId) entry.abortError = message;
    if (stoppedAssistant && entry.messages.includes(stoppedAssistant)) stoppedAssistant.error = message;
    persistEntry(host, entry, [stoppedAssistant]);
    syncEntry(host, entry);
    push(host, { kind: 'error', sessionId: entry.sessionId, message });
  }
  // During connect, the turn owner retires the resulting connection before
  // finishing. Calling abort from a second continuation would race that owner.
  if (!entry.connection && entry.connecting) {
    // The connection promise may settle after abort() returned. Register the
    // in-flight resource in the host retirement barrier and send the same
    // abort signal to the late connection before closing it; otherwise a
    // provider can observe close without ever receiving the user stop.
    retirePendingConnection(host, entry, entry.connecting, null, { abortBeforeClose: true });
    void stopBeforeDispatch(host, entry);
    return;
  }
  await stopBeforeDispatch(host, entry);
}

/** GUI refresh：中止当前回合，并重置持久化用量（重开对话不当成旧占用） */
export async function refresh(host: HostCore, sessionId: string): Promise<void> {
  await abort(host, sessionId);
  const entry = host.entries.get(sessionId) ?? (isOpen(host,sessionId)?materializeForExecution(host,sessionId):undefined);
  if (entry) {
    entry.lastUsage = null;
    entry.skipUsagePersistUntilTurn = false;
    persistEntry(host, entry, []);
    push(host, { kind: 'context', sessionId: entry.sessionId, usage: null });
  } else {
    const messages = host.store.load(sessionId);
    if (messages.length || host.store.loadLastUsage(sessionId)) {
      host.store.save(sessionId, messages, null);
    }
  }
}

/**
 * 手动上下文压缩（/compact，空闲期）：空闲会话直接调 driver.compact；
 * 忙时拒绝（pi 的 compact 会先 abort 当前回合，与「手动压缩不打断工作」矛盾）；
 * 连接未建（打开后没发过消息）时提示先发一条消息。能力位与能力表 manualCompact
 * 同源——driver 没实现就明确说不支持，不静默。
 */
export async function compactSession(
  host: HostCore,
  sessionId: string,
  instructions?: string
): Promise<GuiCompactResult> {
  const entry = host.entries.get(sessionId);
  if(!entry&&isOpen(host,sessionId))return {ok:false,error:t('会话还没建立引擎连接，先发一条消息再压缩')};
  if (!entry || entry.closed) return { ok: false, error: t('会话未打开或已关闭') };
  if (entry.forking) return { ok: false, error: '会话正在分叉，请稍后再压缩' };
  if (entry.clearing) return { ok: false, error: '会话正在清空，请稍后再压缩' };
  if (entry.forkPendingError || entry.forkDeliveryState) {
    return { ok: false, error: entry.forkPendingError ?? '分叉上下文尚未确认投递，暂不能压缩会话' };
  }
  if (entry.forkResumeGuard) {
    return { ok: false, error: '当前分叉会话暂不支持压缩：引擎未提供可关联的压缩完成事件' };
  }
  if (entry.busy) return { ok: false, error: t('Agent 正忙，请等当前回合结束后再压缩') };
  if (!entry.connection) {
    return { ok: false, error: t('会话还没建立引擎连接，先发一条消息再压缩') };
  }
  const connection = entry.connection;
  const compact = connection.compact;
  if (typeof compact !== 'function') {
    return { ok: false, error: t('当前引擎不支持手动压缩') };
  }
  const compactOperation = Symbol('compact');
  try {
    // 压缩是一次完整的 LLM 请求（秒级）：置 busy 挡住并发 send/startTurn，否则
    // 并发回合会在摘要进行中开跑把 compact 掐死（piEvents 注明的失效模式）。收尾
    // 释放 busy 并按 finishTurn 的方式派发压缩期间排队的消息，不让它们悬死。
    entry.busy = true;
    entry.compactOperation = compactOperation;
    try {
      const r = await compact.call(connection, instructions?.trim() || undefined);
      if (entry.compactOperation !== compactOperation) return { ok: false, error: '压缩操作已结束或被替换，结果无法确认' };
      // 压缩后用量立即刷新（tokens 多半变 null=未知，等下回合恢复），别等下一轮
      if (r.ok) {
        // 透明分隔线的规模数字（引擎事件不带，结果里补写；事件在 await 期间已收口）
        stampCompactionTokens(host, entry, r.tokensBefore, r.estimatedTokensAfter);
        pushContext(host, entry);
      }
      return r;
    } finally {
      if (entry.compactOperation === compactOperation) {
        entry.compactOperation = undefined;
        // Stop/clear owns the busy flag until its resource barrier completes.
        if (!entry.closed && !entry.clearing && !entry.abortPreparing) {
          entry.busy = false;
          const next = entry.forkPendingError || entry.forkDeliveryState === 'unknown' ? undefined : entry.queue.shift();
          if (next) {
            const queuedMsg = entry.messages.find((m) => m.id === next.messageId);
            if (queuedMsg) delete queuedMsg.queued;
            persistEntry(host, entry, [queuedMsg]);
            syncEntry(host, entry);
            applyInjectQueueChange(host, entry);
            void startTurn(host, entry, { text: next.text, images: next.images, userText: queuedMsg && !queuedMsg.host && !queuedMsg.source && queuedMsg.steering !== 'host' ? next.text : undefined,
              desktopUserInstruction: !next.fromInject && !!queuedMsg && !queuedMsg.host && !queuedMsg.source && queuedMsg.steering !== 'host', userMessageId: queuedMsg?.id });
          }
        }
      }
    }
  } catch (e) {
    log(host, entry, 'warn', `compact 失败: ${(e as Error).message}`);
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 阈值自动压缩：能力位 + 配置开时，读 getContextUsage 占比，超阈复用 compactSession
 *（busy/单飞/SDK 拒压与手动互斥）。fire-and-forget，失败只记日志不打扰用户。
 */
export function maybeAutoCompact(host: HostCore, entry: SessionEntry): void {
  if (entry.busy || entry.queue.length > 0) return;
  if (entry.forkResumeGuard) return;
  if (entry.activeApproval || entry.activeUserQuestion) return;
  if (!isChatRuntimeId(entry.runtimeId)) return;
  const caps = getChatCapabilities(entry.runtimeId);
  if (!caps.autoCompact) return;
  if (typeof entry.connection?.compact !== 'function') return;
  if (typeof entry.connection.getContextUsage !== 'function') return;

  const ac = normalizeAutoCompactConfig(host.ctx.config.get().autoCompact);
  let usage: { tokens: number | null; contextWindow: number } | null = null;
  try {
    usage = entry.connection.getContextUsage();
  } catch {
    return;
  }
  const decision = decideAutoCompact({
    autoCompactCapable: true,
    configEnabled: ac.enabled,
    ratioThreshold: ac.ratio,
    tokens: usage?.tokens,
    contextWindow: usage?.contextWindow,
    busy: entry.busy
  });
  if (decision.action !== 'compact') return;

  void compactSession(host, entry.sessionId).then((r) => {
    if (!r.ok) {
      log(host, entry, 'info', `自动压缩未执行: ${r.error}`);
    }
  });
}
