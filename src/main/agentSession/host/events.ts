import { publishNativeConfig } from './nativeConfigState';
import { app } from 'electron';
import { semanticOperationsFor } from '../../runtimeKernel/semanticOperations';
import { desktopTurnGrants } from '../../desktop/turnGrant';
/**
 * AgentSessionHost 事件泵：连接事件流的消费、分发与兜底收口。
 * 每连接只挂一个泵（error 后连接可复用，重复挂泵会瓜分后续事件）。
 */
import { randomUUID } from 'node:crypto';
import { createGuiUserMessage, type GuiChatMessage } from '../../../shared/guiWorker';
import { t } from '../../../shared/i18n';
import type { GuiDriverStreamEvent, GuiRuntimeConnection } from '../types';
import { GuiDeliveryError } from '../types';
import { MAX_QUEUE, type HostCore, type SessionEntry } from './internal';
import { applyInjectQueueChange, log, persistEntry, push, syncEntry, syncPart } from './base';
import { pushContext } from './usage';
import { acknowledgeHostIntro, handleInjectionUpdate } from './injection';
import { capturePlanSubmission } from './plan';
import { finishTurn, handleTurnFailure, splitSteeredTurn, stopBeforeDispatch } from './turn';
import { noteReadStateToolResult, noteReadStateToolStart } from './readStateTrack';
import { noteFileChangeStart, noteFileChangeEnd, noteFileChangeWarning } from './fileChanges';
import { detachedConnectionOwnsTurn, retireConnection, retirementBarrier } from './retirement';
import { noteForkResumeToken } from './forkDelivery';
import { resolveApprovalInternal, resolveUserQuestionInternal } from './approvals';
import { confirmWorkerAssignment, noteWorkerNativeEnd, noteWorkerNativeStart } from './workerRoute';
import { classifyWorkerRuntimeFailure } from '../../tasks/workerRoutingPolicy';

export function consumeEvents(host: HostCore, entry: SessionEntry, conn: GuiRuntimeConnection): void {
  void (async () => {
    let retiredForFailure = false;
    try {
      for await (const ev of conn.events) {
        if (host.entries.get(entry.sessionId) !== entry || entry.connection !== conn) break;
        handleEvent(host, entry, ev);
      }
    } catch (e) {
      if (!entry.closed && host.entries.get(entry.sessionId) === entry && entry.connection === conn) {
        // Error handling may immediately dispatch a queued turn. Detach this
        // dead connection and register its cleanup before dispatch can start.
        retireConnection(host, entry);
        retiredForFailure = true;
        log(host, entry, 'error', `事件流异常: ${(e as Error).message}`);
        if (e instanceof GuiDeliveryError) {
          if (e.partialSummary && entry.assistant) entry.assistant.harness = e.partialSummary;
          handleTurnFailure(host, entry, e.message, e.delivery, classifyWorkerRuntimeFailure(e));
        }
        else handleEvent(host, entry, { type: 'error', message: (e as Error).message });
      }
    } finally {
      // 流结束但回合未收口（driver 违约/进程崩溃）：兜底收口
      if (host.entries.get(entry.sessionId) === entry && entry.connection === conn) {
        // Retire before finishing the turn: finishTurn can immediately start a
        // queued message, which must not reuse this ended stream.
        retireConnection(host, entry);
        if (entry.busy) {
          if (entry.turnRetryTimer) {
            // 已安排网络续作：丢掉死连接，到点 ensureConnection 重连后续作
            log(host, entry, 'warn', '事件流结束，保留网络续作计划并丢弃死连接');
          } else {
            log(host, entry, 'warn', '事件流结束但回合未收口，兜底 finish');
            handleTurnFailure(host, entry, 'Engine event stream ended without a terminal receipt.');
          }
        }
      } else if (
        !retiredForFailure && host.entries.get(entry.sessionId) === entry &&
        entry.connection === null &&
        entry.busy &&
        !entry.connecting && detachedConnectionOwnsTurn(conn, entry)
      ) {
        // 回合进行中连接被主动拆除（busy 中切模式/切模型会 close driver）：
        // 事件源已消失，turn-complete 永远不会来——不收口 busy 会永久卡死
        //（后续消息只进队列不消费、abort 变 no-op）。收口后下轮 send 重连接力。
        log(host, entry, 'warn', '回合进行中连接被拆除，收口当前回合');
        if (entry.assistant && !entry.assistant.error) {
          entry.assistant.error = t('连接因切换模式/模型被重建，本回合被中断，请重发');
        }
        finishTurn(host, entry);
      }
    }
  })();
}

/**
 * 正文/思考增量追加：尾部不是同类 part 就新开一个
 * （思考/工具之后重新出现的正文自然分段），并推送一条 delta 事件。
 */
export function appendDelta(host: HostCore, entry: SessionEntry, kind: 'text' | 'thinking', delta: string): void {
  if (!delta) return;
  const assistant = entry.assistant;
  if (!assistant) {
    // 回合已收口后的迟到事件（driver 违约）：留诊断线索，不再静默丢弃
    log(host, entry, 'warn', `迟到 ${kind}-delta 丢弃（回合已收口）: ${delta.slice(0, 60)}`);
    return;
  }
  const parts = assistant.parts;
  const last = parts[parts.length - 1];
  if (!last || last.kind !== kind) {
    parts.push({ kind, text: delta });
  } else {
    last.text += delta;
  }
  // push accepts the durable scalar event before publishing it to observers.
  push(host, {
    kind: 'delta',
    sessionId: entry.sessionId,
    messageId: assistant.id,
    partIndex: parts.length - 1,
    deltaKind: kind,
    delta
  });
}

/**
 * 子代理嵌套思考/正文：追加到对应工具卡 output，不新开主对话 part。
 * callId 对不上时回落到最近一张 running 卡（SDK 偶发漏 callId）。
 */
export function appendToolProgress(host: HostCore, entry: SessionEntry, toolCallId: string, delta: string): void {
  if (!delta) return;
  const assistant = entry.assistant;
  if (!assistant) {
    log(host, entry, 'warn', `迟到 tool-progress 丢弃（回合已收口）: ${delta.slice(0, 60)}`);
    return;
  }
  const parts = assistant.parts;
  let hit = -1;
  if (toolCallId) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.kind === 'tool' && p.tool.id === toolCallId) {
        hit = i;
        break;
      }
    }
  }
  if (hit < 0) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.kind === 'tool' && p.tool.status === 'running') {
        hit = i;
        break;
      }
    }
  }
  if (hit < 0) return;
  const part = parts[hit];
  if (part.kind !== 'tool') return;
  part.tool.output = (part.tool.output ?? '') + delta;
  syncPart(host, entry, assistant, hit);
}

const acknowledgedInputs = new WeakMap<SessionEntry, NonNullable<SessionEntry['lastTurnInput']>>();

/** Only native activity for the currently dispatched input can confirm a continuation. */
function acknowledgeNativeTurn(host: HostCore, entry: SessionEntry, userMessageId = entry.lastTurnInput?.userMessageId): void {
  const input = entry.lastTurnInput;
  const resumeWait = host.ctx.resumeWait;
  if (!input || !userMessageId || input.userMessageId !== userMessageId ||
      host.entries.get(entry.sessionId) !== entry || !entry.connection || !entry.busy ||
      !entry.assistant || entry.assistant.error || entry.assistant.aborted || entry.lastSentPayload == null ||
      entry.execution?.result === 'failed' || entry.execution?.result === 'aborted' ||
      entry.closed || entry.clearing || entry.abortRequested || entry.abortPreparing || entry.turnRetryTimer) return;
  acknowledgeHostIntro(host, entry);
  if (!resumeWait || acknowledgedInputs.get(entry) === input) return;
  resumeWait.acknowledge(entry.sessionId, userMessageId);
  acknowledgedInputs.set(entry, input);
}

export function handleEvent(host: HostCore, entry: SessionEntry, ev: GuiDriverStreamEvent): void {
  if (ev.type === 'execution') {
    if (!entry.busy) return;
    const previous = entry.execution;
    if (previous && (previous.id !== ev.state.id || previous.revision >= ev.state.revision)) return;
    entry.execution = ev.state;
    push(host, { kind: 'execution', sessionId: entry.sessionId, state: ev.state });
    if (ev.state.process === 'reclaim_failed') {
      const message = ev.state.message || '引擎进程回收失败，会话仍被占用，请重试停止';
      if (entry.assistant) entry.assistant.error = message;
      syncEntry(host, entry);
      push(host, { kind: 'error', sessionId: entry.sessionId, message });
    }
    return;
  }
  switch (ev.type) {
    case 'engine-input': {
      const { userMessageId, assistantMessageId } = ev.identity;
      if (!userMessageId || !entry.busy || entry.closed || entry.clearing || entry.assistant?.id !== assistantMessageId ||
          entry.lastTurnInput?.userMessageId !== userMessageId) break;
      const index = entry.messages.findIndex(message => message.id === userMessageId && message.role === 'user');
      if (index < 0) break;
      if (entry.pendingHostIntro) {
        const { context } = entry.pendingHostIntro;
        entry.pendingHostIntro.assistantMessageId = (ev.text === context || ev.text.endsWith(`\n\n${context}`))
          ? assistantMessageId : undefined;
      }
      try {
        const engineInputRef = host.store.saveEngineInput(entry.sessionId, userMessageId, ev.text);
        const message = { ...entry.messages[index]!, engineInputRef };
        entry.messages[index] = message;
        persistEntry(host, entry, [message]);
        syncEntry(host, entry);
      } catch (error) {
        log(host, entry, 'warn', `发送原文保存失败：${(error as Error).message}`);
        push(host, { kind: 'error', sessionId: entry.sessionId, message: t('发送原文保存失败') });
      }
      break;
    }
    case 'native-config':
      // Drivers with a synchronous view may already have consumed a newer
      // protocol frame while this event was queued.
      publishNativeConfig(host, entry, entry.connection?.getNativeConfig?.() ?? ev.state);
      break;
    case 'turn-started':
      if (entry.busy && entry.lastTurnInput?.userMessageId === ev.userMessageId) {
        acknowledgeNativeTurn(host, entry, ev.userMessageId);
        confirmWorkerAssignment(host, entry, ev.userMessageId);
        noteWorkerNativeStart(host, entry);
        entry.workerRouteHandoff = undefined;
      }
      break;
    case 'native-fork-points': {
      if (!entry.busy || !entry.assistant || entry.abortRequested ||
          host.ctx.sessions.get(entry.sessionId)?.runtimeResumeToken !== ev.sessionToken ||
          !ev.points.some(point => point.messageId === entry.assistant!.id)) break;
      try {
        for (const point of ev.points) {
          const message = entry.messages.find(item => item.id === point.messageId);
          if (!message || !point.entryId || point.entryId.length > 512 || /[\x00-\x1f]/.test(point.entryId)) continue;
          host.store.saveForkPoint(entry.sessionId,point.messageId,{ engine: ev.engine, sessionToken: ev.sessionToken, entryId: point.entryId, role: message.role });
        }
      } catch (error) {
        log(host, entry, 'warn', `原生分叉截点保存失败：${(error as Error).message}`);
        push(host, { kind: 'error', sessionId: entry.sessionId, message: `原生分叉截点保存失败：${(error as Error).message}` });
      }
      break;
    }
    case 'text-delta':
      if (entry.busy && ev.delta) { acknowledgeNativeTurn(host, entry); confirmWorkerAssignment(host, entry); noteWorkerNativeStart(host, entry); entry.workerRouteHandoff = undefined; }
      appendDelta(host, entry, 'text', ev.delta);
      break;
    case 'thinking-delta':
      if (entry.busy && ev.delta) { acknowledgeNativeTurn(host, entry); confirmWorkerAssignment(host, entry); noteWorkerNativeStart(host, entry); entry.workerRouteHandoff = undefined; }
      appendDelta(host, entry, 'thinking', ev.delta);
      break;
    case 'tool-progress':
      // Nested thinking is otherwise indistinguishable from persisted tool output.
      if (!ev.thinking || host.ctx.config.get().liveThinkingOnly === false)
        appendToolProgress(host, entry, ev.toolCallId, ev.delta);
      break;
    case 'tool-start':
      if (entry.busy) {
        (entry.openWorkerNativeTools ??= new Set()).add(ev.toolCallId);
        acknowledgeNativeTurn(host, entry);
        confirmWorkerAssignment(host, entry); noteWorkerNativeStart(host, entry); entry.workerRouteHandoff = undefined;
      }
      // Review capture is auxiliary: its failures must not break the event pump
      // or surface as engine errors.
      noteFileChangeStart(entry, ev.toolCallId, ev.toolName, ev.input, ev.toolKind, ev.reviewLate);
      // A1 read-state：Read/Write/Edit/bash 入参暂存（成功结果时再登记/标脏）
      noteReadStateToolStart(entry, ev.toolCallId, ev.toolName, ev.input);
      if (entry.assistant) {
        entry.assistant.parts.push({
          kind: 'tool',
          tool: {
            id: ev.toolCallId,
            name: ev.toolName,
            input: ev.displayInput ?? ev.input,
            status: 'running'
          }
        });
        // 计划类工具的参数可包含计划全文，立即挂卡，不等回合收口的正文提取。
        const previousPlan = entry.assistant.plan;
        capturePlanSubmission(host, entry, ev.toolName, ev.input);
        // 挂了计划卡就是消息级变化（卡片字段 + 其他消息的 active 翻转），退回全量
        if (previousPlan !== entry.assistant.plan) syncEntry(host, entry);
        else syncPart(host, entry, entry.assistant, entry.assistant.parts.length - 1);
      }
      break;
    case 'tool-update': {
      noteFileChangeStart(entry, ev.toolCallId, ev.toolName, ev.input, ev.toolKind, ev.reviewLate);
      const assistant = entry.assistant;
      if (!assistant) break;
      const hit = assistant.parts.findIndex(part => part.kind === 'tool' && part.tool.id === ev.toolCallId);
      const part = assistant.parts[hit];
      if (part?.kind !== 'tool' || part.tool.status !== 'running') break;
      const input = ev.displayInput ?? ev.input;
      if (part.tool.name === ev.toolName && part.tool.input === input) break;
      assistant.parts[hit] = { kind: 'tool', tool: { ...part.tool, name: ev.toolName, input } };
      syncPart(host, entry, assistant, hit);
      break;
    }
    case 'review-tool-start':
    case 'review-tool-update':
      if (entry.busy) (entry.openWorkerNativeTools ??= new Set()).add(ev.toolCallId);
      noteFileChangeStart(entry, ev.toolCallId, ev.toolName, ev.input, ev.toolKind, ev.reviewLate);
      break;
    case 'review-tool-result':
      entry.openWorkerNativeTools?.delete(ev.toolCallId);
      noteFileChangeEnd(entry, ev.toolCallId, ev.ok, ev.patch, ev.reviewChanges);
      break;
    case 'review-warning':
      noteFileChangeWarning(entry, ev.message);
      break;
    case 'tool-result':
      entry.openWorkerNativeTools?.delete(ev.toolCallId);
      noteFileChangeEnd(entry, ev.toolCallId, ev.ok, ev.patch, ev.reviewChanges);
      // A1 read-state：成功读入登记 / 写后标脏（失败只清暂存）
      noteReadStateToolResult(entry, ev.toolCallId, ev.ok, entry.cwd);
      if (entry.assistant) {
        const parts = entry.assistant.parts;
        let hit = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.kind === 'tool' && p.tool.id === ev.toolCallId) {
            p.tool.status = ev.ok ? 'ok' : 'error';
            // 空结果不要冲掉子代理已经流进卡里的正文
            if (ev.output || !p.tool.output) p.tool.output = ev.output;
            if (ev.patch) p.tool.patch = ev.patch;
            if (ev.durationMs !== undefined) p.tool.durationMs = ev.durationMs;
            hit = i;
            break;
          }
        }
        // 找不到对应工具卡（driver 违约/回合错位）：退回全量，别让 UI 停在 running
        if (hit >= 0) syncPart(host, entry, entry.assistant, hit);
        else { persistEntry(host, entry, [entry.assistant]); syncEntry(host, entry); }
      } else {
        // 迟到的工具结果（回合已收口）：留诊断线索——正是这类「完成事件丢失」让
        // 工具卡永远进行中，收口兜底已把它按取消收尾
        log(host, entry, 'warn', `迟到 tool-result 丢弃（回合已收口）: ${ev.toolCallId}`);
      }
      break;
    case 'resume-token':
      if (entry.clearing || entry.closed) break;
      if (!noteForkResumeToken(host, entry, ev.token)) {
        if (entry.busy) {
          // Revoke host tool authority synchronously, then retire the driver.
          // The busy flag stays held until the resource barrier completes.
          entry.abortRequested = true;
          entry.abortPreparing = true;
          entry.abortError = entry.forkPendingError;
          if (entry.activeApproval) {
            resolveApprovalInternal(host, entry, entry.activeApproval.approvalId, {
              approved: false, reason: '引擎会话标识未确认'
            });
          }
          if (entry.activeUserQuestion) {
            resolveUserQuestionInternal(host, entry, entry.activeUserQuestion.questionId, { kind: 'aborted' });
          }
          void stopBeforeDispatch(host, entry);
        } else if (entry.connection) {
          retireConnection(host, entry);
          void retirementBarrier(host, entry.sessionId).catch((error: unknown) => {
            const message = `引擎连接回收未确认：${(error as Error).message}`;
            log(host, entry, 'error', message);
            push(host, { kind: 'error', sessionId: entry.sessionId, message });
          });
        }
        break;
      }
      host.ctx.sessions.updateRuntimeHandle(entry.sessionId, {
        externalSessionId: ev.token,
        runtimeResumeToken: ev.token,
        ...(ev.historyStorageKey ? { nativeHistoryStorageKey: ev.historyStorageKey } : {}),
        ...(ev.historyCwd ? { nativeHistoryCwd: ev.historyCwd } : {})
      });
      if(entry.forkSeed&&!entry.closed&&!entry.clearing){
        try{
          host.store.savePendingFork(entry.sessionId,{state:'delivered',seed:null,transcript:null,resumeToken:ev.token,delivery:'seed'});
          entry.forkSeed=null;entry.forkDeliveryState=undefined;
          host.store.removeForkContext(entry.sessionId);
        }catch(error){log(host,entry,'warn',`分叉种子恢复标识保存失败：${(error as Error).message}`);}
      }
      pushContext(host, entry);
      break;
    case 'context-usage':
      pushContext(host, entry, ev.usage);
      break;
    case 'available-commands':
      entry.slashCommands = ev.commands;
      push(host, {
        kind: 'engine-meta',
        sessionId: entry.sessionId,
        slashCommands: ev.commands,
        ...(entry.engineMode ? { engineMode: entry.engineMode } : {})
      });
      break;
    case 'current-mode':
      entry.engineMode = { modeId: ev.modeId, ...(ev.name ? { name: ev.name } : {}) };
      push(host, {
        kind: 'engine-meta',
        sessionId: entry.sessionId,
        ...(entry.slashCommands.length ? { slashCommands: entry.slashCommands } : {}),
        engineMode: entry.engineMode
      });
      break;
    case 'steering':
      handleSteeringEvent(host, entry, ev.text);
      break;
    case 'native-message-start': {
      if (!entry.busy) {
        log(host, entry, 'warn', '迟到 native-message-start 丢弃（回合已收口）');
        break;
      }
      // A native queue owns dispatch; move its existing receipt to the consumption boundary.
      // It may start before the async admission call returns, so also deduplicate that race.
      const index = entry.messages.findIndex(m => m.id === ev.messageId);
      const existing = index >= 0 ? entry.messages[index] : undefined;
      if (existing?.nativeMessageStarted || existing && !existing.queued && entry.messages[index + 1]?.role === 'assistant') break;
      const message = index >= 0 ? entry.messages.splice(index, 1)[0] :
        createGuiUserMessage({ id: ev.messageId, text: ev.text, ts: Date.now(), host: true });
      const nativeUser = desktopTurnGrants.consumeNativeMessage(entry.sessionId, ev.messageId);
      if (nativeUser || (!message.host && !message.source)) desktopTurnGrants.nextUserMessage(entry.sessionId);
      splitSteeredTurn(host, entry, { ...message, queued: false, nativeMessageStarted: true }, nativeUser);
      const consumedTurnId = entry.activeExecutionTurnId;
      void Promise.resolve().then(() => semanticOperationsFor(host.ctx, entry.sessionId, host.semanticRoot ?? app.getPath('userData'), host.ctx.sessionLogs)
        .fact('gui.native-consumed', ev.messageId, [ev.messageId], { turnId: consumedTurnId }))
        .catch(error => log(host, entry, 'error', `原生消费事实保存失败: ${String(error)}`));
      break;
    }
    case 'steering-failed':
      handleSteeringFailedEvent(host, entry, ev.text, ev.reason);
      break;
    case 'injection-update':
      handleInjectionUpdate(host, entry, ev.source, ev.text);
      break;
    case 'compaction':
      handleCompactionEvent(host, entry, ev);
      break;
    case 'turn-complete':
      {
      const confirmed = !ev.cancelled && !!entry.busy && !!entry.assistant && !entry.abortRequested && !entry.abortPreparing &&
        (!entry.execution || entry.execution.process === 'released');
      if (confirmed && entry.nativeDeliveryInFlight &&
          (entry.forkGuardInFlight || entry.forkDeliveryState === 'sending' && entry.forkTranscript)) {
        entry.forkPendingError = '分叉会话回合结束时原生消息投递尚未确认，已停止自动续写；请检查原生历史';
        entry.abortRequested = true;
        entry.abortPreparing = true;
        entry.abortError = entry.forkPendingError;
        push(host, { kind: 'error', sessionId: entry.sessionId, message: entry.forkPendingError });
        void stopBeforeDispatch(host, entry);
        break;
      }
      // 透明模式计量：driver 组装的回合 summary 盖到本回合 assistant（finishTurn 收口落盘）
      if (ev.summary && entry.assistant) {
        entry.assistant.harness = ev.summary;
      }
      if (confirmed) {
        if (!entry.execution || entry.execution.result === 'completed') acknowledgeNativeTurn(host, entry);
        noteWorkerNativeEnd(host, entry, ev.summary?.model);
      }
      finishTurn(host, entry, { confirmed });
      break;
      }
    case 'error': {
      const failedMessageId = entry.assistant?.id;
      const failedTurnId = entry.activeExecutionTurnId;
      void Promise.resolve().then(() => semanticOperationsFor(host.ctx, entry.sessionId, host.semanticRoot ?? app.getPath('userData'), host.ctx.sessionLogs)
        .fact('turn.error', failedMessageId ?? failedTurnId ?? 'no-active-turn',
          failedMessageId ? [failedMessageId] : [], { turnId: failedTurnId, code: 'driver-error' }))
        .catch(error => log(host, entry, 'error', `回合错误事实保存失败: ${String(error)}`));
      // 失败回合的 partial summary 同样盖章（计量不随失败丢弃）
      if (ev.summary && entry.assistant) {
        entry.assistant.harness = ev.summary;
      }
      handleTurnFailure(host, entry, ev.message, undefined, ev.workerFailure, ev.workerFailure?.boundary);
      break;
    }
  }
}

/**
 * 插话事件落转写（pi-trajectory-plan v3 §4.4）：send() 的可见插话已同步落下
 * （steering:'send'，chat-surface 既有「已插话」切分点），这里按 lastSteeredText
 * 去重防双落；其余插话（后台任务唤醒等宿主静默路径）落 steering:'host' 消息——
 * 透明开关关闭时不渲染（现状不可见），开启后统一渲染为 §6.2 插话线。
 */
export function handleSteeringEvent(host: HostCore, entry: SessionEntry, text: string): void {
  if (!text) return;
  const dedupIdx = entry.lastSteeredTexts.indexOf(text);
  if (dedupIdx >= 0) {
    entry.lastSteeredTexts.splice(dedupIdx, 1);
    return;
  }
  const msg: GuiChatMessage = {
    id: randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
    steering: 'host',
    ts: Date.now()
  };
  entry.messages.push(msg);
  persistEntry(host, entry, [msg]);
  syncEntry(host, entry);
}

/**
 * 插话注入失败（M-7）：引擎从未收到该文本——按用户可见语义回队，当前回合结束后
 * 自动送达（与 messaging 的排队路径同构：queued 消息 + entry.queue 项）。
 */
export function handleSteeringFailedEvent(
  host: HostCore,
  entry: SessionEntry,
  text: string,
  reason: string
): void {
  if (!text) return;
  if (entry.queue.length >= MAX_QUEUE) {
    log(host, entry, 'error', t('插话未送达引擎且排队已满（{{reason}}），内容丢失', { reason }));
    // gui-worker-session F-02：队列满也不得静默丢——补 error 回执（渲染层 flashTip 即时
    // 可见），与 send 路径「排队已满（{{n}}）」错误回执同语义，让发送方知道这条没进去
    push(host, {
      kind: 'error',
      sessionId: entry.sessionId,
      message: t('插话未送达引擎且排队已满（{{n}} 条），这条消息未能发出：{{reason}}', { n: MAX_QUEUE, reason })
    });
    return;
  }
  log(host, entry, 'warn', t('插话未送达引擎（{{reason}}），已回队、随回合结束自动发送', { reason }));
  const msg: GuiChatMessage = {
    ...createGuiUserMessage({ id: randomUUID(), text, ts: Date.now() }),
    queued: true
  };
  entry.messages.push(msg);
  entry.queue.push({ messageId: msg.id, text });
  persistEntry(host, entry, [msg]);
  syncEntry(host, entry);
  applyInjectQueueChange(host, entry);
  // busy 如实上报：steer 重试窗口内回合可能已收口（entry.busy=false），此时该队列项
  // 要等下一次回合收口才派发——不得虚报忙把空闲会话吊成 busy 态
  push(host, { kind: 'busy', sessionId: entry.sessionId, busy: entry.busy, queued: entry.queue.length });
}

/**
 * 压缩生命周期（pi-trajectory-plan v3 B3'：账本退役后的独立事件源）：
 * start 开标记（同一时刻至多一个）+ 推 running；end 收口——成功落信封（渲染层
 * 重建 complete 分隔线），失败/中止摘线；willRetry 保持打开等下一次 end。
 */
export function handleCompactionEvent(
  host: HostCore,
  entry: SessionEntry,
  ev: Extract<GuiDriverStreamEvent, { type: 'compaction' }>
): void {
  try {
    if(entry.closed||entry.clearing||host.entries.get(entry.sessionId)!==entry)return;
    if (ev.phase === 'start') {
      if (entry.openCompaction) return;
      entry.compactionSeq += 1;
      const markerId = `hc-${entry.compactionSeq}`;
      entry.openCompaction = { markerId, at: Date.now() };
      push(host, { kind: 'compaction', sessionId: entry.sessionId, markerId, status: 'running', at: entry.openCompaction.at });
      return;
    }
    const open = entry.openCompaction;
    if (!open) return;
    if (ev.willRetry) return; // summarization 自动重试中：生命周期保持打开
    entry.openCompaction = null;
    entry.lastClosedCompaction = open.markerId;
    const error = ev.errorMessage || (ev.aborted ? t('压缩已中止') : undefined);
    if (error) {
      push(host, { kind: 'compaction', sessionId: entry.sessionId, markerId: open.markerId, status: 'error', at: Date.now() });
      return;
    }
    const record={at:open.at};host.store.recordCompaction(entry.sessionId,entry.compactions.length,record);
    entry.compactions.push(record);
    push(host, { kind: 'compaction', sessionId: entry.sessionId, markerId: open.markerId, status: 'complete', at: open.at,metadataCounts:{injectionCount:entry.injections.length,compactionCount:entry.compactions.length} });
  } catch (e) {
    log(host, entry, 'warn', `压缩事件处理失败（忽略）: ${(e as Error).message}`);
  }
}

/** 手动/自动压缩结果补写规模（compactSession 成功后调用；找不到刚收口的标记则短重试） */
export function stampCompactionTokens(
  host: HostCore,
  entry: SessionEntry,
  tokensBefore: number | null | undefined,
  tokensAfter: number | null | undefined,
  attempt = 0
): void {
  try {
    if(entry.closed||entry.clearing||host.entries.get(entry.sessionId)!==entry)return;
    const markerId = entry.lastClosedCompaction;
    if (!markerId) {
      // 竞态：compact() 可能先于事件泵消费 compaction_end 返回——迟一拍再试
      if (attempt < 3 && host.entries.get(entry.sessionId) === entry && !entry.closed) {
        const timer = setTimeout(() => {
          stampCompactionTokens(host, entry, tokensBefore, tokensAfter, attempt + 1);
        }, 150);
        timer.unref?.();
      }
      return;
    }
    entry.lastClosedCompaction = null;
    // 信封末条即该次压缩（handleCompactionEvent 刚落）
    const idx = entry.compactions.length - 1;
    if (idx >= 0) {
      const record = {
        ...entry.compactions[idx]!,
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(tokensAfter !== undefined ? { tokensAfter } : {})
      };
      host.store.recordCompaction(entry.sessionId,idx,record);entry.compactions[idx]=record;
    }
    push(host, {
      kind: 'compaction',
      sessionId: entry.sessionId,
      metadataCounts:{injectionCount:entry.injections.length,compactionCount:entry.compactions.length},
      markerId,
      status: 'complete',
      at: entry.compactions[idx]?.at ?? Date.now(),
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      ...(tokensAfter !== undefined ? { tokensAfter } : {})
    });
  } catch (e) {
    log(host, entry, 'warn', `压缩规模补写失败（忽略）: ${(e as Error).message}`);
  }
}
