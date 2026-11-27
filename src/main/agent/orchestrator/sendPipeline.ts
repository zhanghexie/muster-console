import { app } from 'electron';
import { semanticOperationsFor } from '../../runtimeKernel/semanticOperations';
import { desktopTurnGrants } from '../../desktop/turnGrant';
/**
 * 发送入口分流：本地会话命令（/new、/clear、/compact）→ 图片守卫 → idle 微压缩
 * 唤醒 → 忙时排队（上限拒绝/入列）→ O8 自治回合闸（host 标记）→ 正常起回合。
 * （自 orchestrator.ts 拆分；`this.` 改经 OrchestratorHost 协作面，逻辑逐字保留。）
 */
import { abortPendingAsk } from './askQuestions';
import { randomUUID } from 'node:crypto';
import { formatNotifyText, type ChatImageAttachment, type ChatMessage } from '../../../shared/types';
import { t } from '../../../shared/i18n';
import { formatCompactResult } from '../../../shared/piEvents';
import { parseCompactCommand } from '../../../shared/compactCommand';
import type { OrchestratorHost, SchedulerSendOptions } from './internal';
import { bindTurnGateToken, releaseGateTokenOnly } from './turnGate';
import { MAX_AGENT_QUEUE } from './types';
import {getMemoryService,resolveMemoryWorkspaceRoot} from '../../memory/runtime';

const NEEDS_YOU_WAKE_GUIDANCE = '仍需用户行动时，用 `host_ui_reminders({"action":"add","text":"待办事项"})` 记下具体事项。继续执行下面的唤醒指令。';

/**
 * 受理一条用户/自治消息并发起回合。
 * host 标记 = 自治入口：满闸进 pending 缓冲、不建用户消息证据面（B3 直写门）。
 */
export async function send(o: OrchestratorHost, text: string, wsId: string, images?: ChatImageAttachment[],
  opts?: SchedulerSendOptions): Promise<void> {
  // The ungated call can synchronously re-enter through gateQueue.submit. Only
  // the real gate admission owns this operation, never its outer dispatcher.
  if (!opts?.host || !opts.messageId || !opts.gateToken || opts.notification)
    return sendInner(o, text, wsId, images, opts);
  let completion: Promise<void> | undefined;
  try {
    const journal = semanticOperationsFor(o.ctx, `orchestrator:${wsId}`, app.getPath('userData'), o.ctx.sessionLogs);
    await journal.run('scheduler.delivery', opts.messageId, [opts.messageId], () => new Promise<{ admitted: boolean }>((resolve, reject) => {
      completion = sendInner(o, text, wsId, images, opts, () => resolve({ admitted: true }));
      void completion.then(() => resolve({ admitted: false }), reject);
    }), result => result.admitted);
    // A duplicate did not consume its new gate token or start another turn.
    if (!completion) { if (opts.beforeStart?.() !== false) opts.onAccepted?.(); else opts.onSkipped?.(); releaseGateTokenOnly(o, opts.gateToken); }
    await completion;
  } catch (error) {
    if (!completion) releaseGateTokenOnly(o, opts.gateToken);
    throw error;
  }
}

async function sendInner(
  o: OrchestratorHost,
  text: string,
  wsId: string,
  images?: ChatImageAttachment[],
  opts?: SchedulerSendOptions,
  onAdmitted?: () => void
): Promise<void> {
  try{const root=resolveMemoryWorkspaceRoot(o.ctx,wsId);if(root)getMemoryService()?.knowledge(root,'scheduler');}
  catch(error){console.warn('[knowledge] scheduler initialization failed',error);}
  const trimmed = text.trim();
  // The paired IM host resolves workbench commands before submitting a turn.
  // Treat the remaining remote text as literal content at every dispatch boundary.
  // 本地会话命令：清空 UI + 下次新建 Pi 落盘会话，绝不送给模型
  if (!opts?.workbenchRemote && (trimmed === '/new' || trimmed === '/clear')) {
    releaseGateTokenOnly(o, opts?.gateToken);
    const b = o.ensureBucket(wsId);
    if (b.busy) {
      o.ctx.notify.push({
        workspaceId: wsId,
        sessionId: `orchestrator:${wsId}`,
        sessionName: t('调度'),
        kind: 'info',
        text: formatNotifyText(t('调度'), t('Agent 正忙，请等当前回合结束后再清空')),
        update: true,
        updateKey: `orch-clear-busy:${wsId}`,
        toast: true
      });
      return;
    }
    o.clearHistory(wsId);
    opts?.onAccepted?.();
    return;
  }

  // 本地会话命令：手动压缩上下文，绝不送给模型。桌面渲染层已拦截 /compact，
  // 走 compactSession 专用通道；这里兜飞书等直发路径，结果以通知呈现
  const compactHit = opts?.workbenchRemote ? null : parseCompactCommand(trimmed);
  if (compactHit) {
    releaseGateTokenOnly(o, opts?.gateToken);
    const result = await o.compactSession(wsId, compactHit.instructions);
    o.ctx.notify.push({
      workspaceId: wsId,
      sessionId: `orchestrator:${wsId}`,
      sessionName: t('调度'),
      kind: result.ok ? 'info' : 'error',
      text: formatNotifyText(
        t('调度'),
        result.ok ? formatCompactResult(result) : result.error
      ),
      update: true,
      updateKey: `orch-compact:${wsId}`,
      toast: true
    });
    if (result.ok) opts?.onAccepted?.();
    return;
  }

  const imgGuard = o.checkSendImages(wsId, images);
  if (!imgGuard.ok) {
    releaseGateTokenOnly(o, opts?.gateToken);
    o.ctx.notify.push({
      workspaceId: wsId,
      sessionId: `orchestrator:${wsId}`,
      sessionName: t('调度'),
      kind: 'error',
      text: formatNotifyText(t('调度'), imgGuard.error),
      update: true,
      updateKey: `orch-no-image:${wsId}`,
      toast: true
    });
    return;
  }

  const bucket = o.ensureBucket(wsId);
  if (opts?.messageId && bucket.display.some(m => m.id === opts.messageId)) {
    if (opts.beforeStart?.() !== false) opts.onAccepted?.(); else opts.onSkipped?.();
    onAdmitted?.();
    releaseGateTokenOnly(o, opts.gateToken);
    return;
  }
  const messageId = opts?.messageId ?? randomUUID();
  // Remote actors can use the workbench without resuming a desktop seat or creating desktop instruction evidence.
  const humanInstruction = !opts?.host && !opts?.notification && !opts?.workbenchRemote;
  // Capture acceptance before microcompaction or any other asynchronous work.
  // sendNow records it before attempting steer and passes the same id on fallback.
  if (humanInstruction && !opts?.desktopInstructionNoted) {
    o.ctx.desktopTurns?.().noteUserInstruction(`orchestrator:${wsId}`, messageId);
  }
  // B1 idle 触发（主路径，挂事件唤醒）：调度被事件/人唤醒时，若上次回合完成已久
  // （prompt cache 本就过期——「清理挑缓存已死时动手」，ZCode TimeBased 同思路），
  // 先试微压缩再进回合。放在 busy 判定**之前**：微压缩期间新到的消息走 busy 排队
  // 分支；压缩完 compactSession 收口 drain 若已抢开回合（busy 翻 true），本消息同样
  // 自然落队，不会并发双回合。微压缩自带 compactSession busy 窗，与手动 /compact、
  // 0.8 自动压缩互斥；失败 fail-open 不挡回合。
  if (humanInstruction) desktopTurnGrants.nextUserMessage(`orchestrator:${wsId}`);
  await o.maybeIdleMicrocompact(wsId);
  if (opts?.workbenchRemote?.signal.aborted) return;
  // Another call may have admitted the same stable request while compaction
  // awaited I/O. Recheck before queue mutation or a second model dispatch.
  if (opts?.messageId && bucket.display.some(message => message.id === opts.messageId)) {
    if (opts.beforeStart?.() !== false) opts.onAccepted?.(); else opts.onSkipped?.();
    onAdmitted?.(); releaseGateTokenOnly(o, opts.gateToken); return;
  }
  // External CLI admission is atomic with model dispatch. Busy work remains in its
  // own persistent queue; never silently discard it in the bounded chat queue.
  if (opts?.requireIdle && bucket.busy) {
    releaseGateTokenOnly(o, opts.gateToken);
    opts.onSkipped?.();
    return;
  }
  if (bucket.busy) {
    // 满闸 drain 撞上忙区的极 rare 路径：token 就地释放（排队消息并入该区现有链，
    // 链自身持有原 token 或本就是人链——自治链=一槽，不叠加占位）
    releaseGateTokenOnly(o, opts?.gateToken);
    // busy 时排队：消息先进 display（queued 标记），回合正常结束后自动续发
    if (bucket.queue.length >= MAX_AGENT_QUEUE) {
      o.ctx.notify.push({
        workspaceId: wsId,
        sessionId: `orchestrator:${wsId}`,
        sessionName: t('调度'),
        kind: 'error',
        text: formatNotifyText(t('调度'), t('排队消息已达上限（{{n}} 条），请等 Agent 完成后再发', { n: MAX_AGENT_QUEUE })),
        update: true,
        updateKey: `orch-queue-full:${wsId}`,
        toast: true
      });
      return;
    }
    const queuedMsg: ChatMessage = {
      id: messageId,
      role: 'user',
      content: text,
      images: images && images.length > 0 ? images : undefined,
      createdAt: Date.now(),
      queued: true,
      host: opts?.host
    };
    bucket.display.push(queuedMsg);
    bucket.queue.push({ id: queuedMsg.id, text, images, host: opts?.host,
      ...(humanInstruction ? { desktopInstructionId: messageId } : {}) });
    // 先受理用户原文再解除工具等待；宿主通知不代表用户放弃作答。
    if (!opts?.host) abortPendingAsk(o, wsId, 'superseded');
    try { o.emit('agent:message', { ...queuedMsg, workspaceId: wsId }); }
    catch (error) { bucket.queue.pop(); bucket.display.splice(bucket.display.indexOf(queuedMsg), 1); throw error; }
    onAdmitted?.(); opts?.onAccepted?.();
    o.persistBucket(wsId);
    return;
  }

  // O8 自治回合闸：host 标记的自治入口（事件 flush / 邮箱收信 / requestIntegrate /
  // sessions.message 异常上行 / facts 订阅投递）空闲时过闸；满闸进 pending 缓冲（不丢、不报错，槽释放
  // 即 drain）。人的手动输入不带 host 标记，直通不节流。host 标记同时定性回合作用域
  // （B3 直写门）：host 回合不建用户消息证据面，memory.remember 保守拒绝。
  if (opts?.host && !opts.gateToken) {
    const outcome = o.gateQueue.submit({ text, workspaceId: wsId, images,
      messageId, requireIdle: opts.requireIdle, schedulerWake: opts.schedulerWake,
      beforeStart: opts.beforeStart, onAccepted: opts.onAccepted, onSkipped: opts.onSkipped, notification: opts.notification });
    if (outcome === 'pending') return;
    // submit 同步经 deliver 回到本方法（带 gateToken），此处直接收尾
    return;
  }
  if (opts?.beforeStart && !opts.beforeStart()) {
    releaseGateTokenOnly(o, opts.gateToken);
    opts.onSkipped?.();
    return;
  }
  if (opts?.gateToken) bindTurnGateToken(o, bucket, opts.gateToken);

  const wakeGuidance = opts?.host && opts.schedulerWake && o.ctx.schedulerStatus?.get(wsId)?.phase === 'needs_you'
    ? NEEDS_YOU_WAKE_GUIDANCE : '';
  const userMsg: ChatMessage = {
    id: messageId,
    role: 'user',
    content: text,
    images: images && images.length > 0 ? images : undefined,
    createdAt: Date.now(),
    host: opts?.host
  };
  if (!opts?.notification) {
    bucket.display.push(userMsg);
    try { o.emit('agent:message', { ...userMsg, workspaceId: wsId }); }
    catch (error) { bucket.display.splice(bucket.display.indexOf(userMsg), 1); throw error; }
  }

  let notification = opts?.notification;
  if (notification) {
    const original = notification;
    notification = { ...original, ...(wakeGuidance ? { async prepare() {
      const batch = await original.prepare();
      return batch ? { ...batch, content: `${wakeGuidance}\n\n${batch.content}` } : null;
    } } : {}), accepted: async batch => {
      let receiptCommitted = false;
      try { await original.accepted(batch); receiptCommitted = true; }
      finally {
        const receiptStatus = receiptCommitted ? 'committed' : 'failed';
        void Promise.resolve().then(async () => {
          const journal = semanticOperationsFor(o.ctx, `orchestrator:${wsId}`, app.getPath('userData'), o.ctx.sessionLogs);
          const id = opts?.messageId ?? batch.ids.join(',');
          await journal.fact('scheduler.notification-consumed', id, batch.ids,
            { messageId: opts?.messageId, boundary: 'native-context-persisted', receiptStatus });
          if (!receiptCommitted) await journal.fact('scheduler.notification-receipt-failed', id, batch.ids, { boundary: 'host-receipt-persistence' });
        })
          .catch(error => console.error('[scheduler] notification consumption fact failed', wsId, error));
      }
    } };
  }
  const turnText = wakeGuidance && !notification ? `${wakeGuidance}\n\n${text}` : text;
  const running = o.startTurn(bucket, wsId, turnText, images, opts?.host, notification, humanInstruction ? messageId : undefined, messageId, opts?.workbenchRemote);
  // startTurn sets busy synchronously before its first asynchronous preparation.
  // This is host admission, not a claim that the model executed the request.
  if (bucket.busy) {
    onAdmitted?.(); opts?.onAccepted?.();
    if (notification) void Promise.resolve().then(() => semanticOperationsFor(o.ctx, `orchestrator:${wsId}`, app.getPath('userData'), o.ctx.sessionLogs)
      .fact('scheduler.notification-admitted', messageId, [messageId], { accepted: true }))
      .catch(error => console.error('[scheduler] notification admission fact failed', wsId, error));
  }
  await running;
}
