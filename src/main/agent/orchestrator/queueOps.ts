import { commitDisplayEdit } from './eventBus';
import { desktopTurnGrants } from '../../desktop/turnGrant';
/**
 * 排队消息（busy 期间入队的待发回合）的纯变换与操作入口。
 * （自 orchestrator.ts 拆分：纯函数只做 queue/display 数组变换，便于单测；
 * 持久化与事件推送留在 OrchestratorHost 包装层，顺序与原实现一致。）
 */
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../../../shared/types';
import { t } from '../../../shared/i18n';
import type { OrchestratorHost } from './internal';
import { activateSchedulerDesktopSteer, endSchedulerDesktopTurn } from './internal';
import type { PendingDesktopSteer, QueuedTurn } from './types';
import { hasWorkerModelMentions } from '../../../shared/workerModelMention';
import { getSchedulerConnectionContext } from '../schedulerWorkspaceContext';

/**
 * 重启恢复：display 里仍带 queued 标记的用户消息重建为待发送队列
 * （对应 ensureBucket 的恢复逻辑，纯函数化便于单测）。
 */
export function collectRestoredQueue(display: ChatMessage[]): QueuedTurn[] {
  return display
    .filter((m) => m.role === 'user' && m.queued)
    .map((m) => ({
      id: m.id,
      text: m.content,
      ...(m.host ? { host: true } : {}),
      ...(m.images?.length ? { images: m.images } : {})
    }));
}

/**
 * 撤回一条排队消息：queue 摘除该条，display 过滤掉同 id 消息。
 * 无该 id 返回 null（调用方原样返回 false）；有则返回替换后的 queue/display。
 */
export function removeQueuedTurn(
  queue: QueuedTurn[],
  display: ChatMessage[],
  messageId: string
): { queue: QueuedTurn[]; display: ChatMessage[] } | null {
  const idx = queue.findIndex((q) => q.id === messageId);
  if (idx < 0) return null;
  const nextQueue = queue.slice();
  nextQueue.splice(idx, 1);
  return { queue: nextQueue, display: display.filter((m) => m.id !== messageId) };
}

/**
 * 改写一条排队消息的内容（queue 与 display 同步改；未轮到执行的才可改）。
 * 空文本 / 找不到该 id 返回 false，不做任何改动。
 */
export function editQueuedTurn(
  queue: QueuedTurn[],
  display: ChatMessage[],
  messageId: string,
  text: string
): boolean {
  const content = text.trim();
  if (!content) return false;
  const q = queue.find((item) => item.id === messageId);
  if (!q) return false;
  q.text = content;
  // 行内编辑只改文本，随文图片保留（丢图会让「改个错别字」变成静默丢附件）
  const msg = display.find((m) => m.id === messageId);
  if (msg) {
    msg.content = content;
  }
  return true;
}

/**
 * 重排排队消息（自动发送顺序）；ids 为全量排队 id 的目标顺序。
 * 未出现在 ids 里的（并发窗口新入队的）保序追加在尾部，不丢消息；
 * 顺序无变化返回 null（调用方据此跳过持久化）。
 */
export function reorderQueuedTurns(queue: QueuedTurn[], orderedIds: string[]): QueuedTurn[] | null {
  const byId = new Map(queue.map((q) => [q.id, q]));
  const next: QueuedTurn[] = [];
  for (const id of orderedIds) {
    const hit = byId.get(id);
    if (hit) {
      next.push(hit);
      byId.delete(id);
    }
  }
  // 未出现在 ids 里的（并发窗口新入队的）保序追加在尾部，不丢消息
  for (const rest of byId.values()) next.push(rest);
  if (next.length === queue.length && next.every((q, i) => q === queue[i])) {
    return null;
  }
  return next;
}

/** 重排后同步 display：queued 消息按新顺序排尾，其余消息保持原相对顺序在前 */
export function applyQueueOrderToDisplay(display: ChatMessage[], queue: QueuedTurn[]): ChatMessage[] {
  const order = new Map(queue.map((q, i) => [q.id, i] as const));
  const queuedMsgs = display.filter((m) => m.queued);
  queuedMsgs.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const others = display.filter((m) => !m.queued);
  return [...others, ...queuedMsgs];
}

/** 撤回一条排队消息（busy 期间发送、尚未轮到执行的） */
export function cancelQueued(o: OrchestratorHost, messageId: string, wsId: string): boolean {
  const bucket = o.ensureBucket(wsId);
  const next = removeQueuedTurn(bucket.queue, bucket.display, messageId);
  if (!next) return false;
  commitDisplayEdit(o, wsId, { removeIds: [messageId] }, () => { bucket.queue = next.queue; });
  o.persistBucket(wsId);
  return true;
}

/** 改写一条排队消息的内容（queue 与 display 同步改；未轮到执行的才可改） */
export function editQueued(o: OrchestratorHost, messageId: string, text: string, wsId: string): boolean {
  const bucket = o.ensureBucket(wsId);
  const queue = bucket.queue.map(item => ({ ...item }));
  const display = bucket.display.map(message => message.id === messageId ? { ...message } : message);
  if (!editQueuedTurn(queue, display, messageId, text)) return false;
  const message = display.find(item => item.id === messageId);
  if (!message) return false;
  commitDisplayEdit(o, wsId, { upsert: [{ message }] }, () => { bucket.queue = queue; });
  o.persistBucket(wsId);
  return true;
}

/** 重排排队消息（自动发送顺序）；ids 为全量排队 id 的目标顺序 */
export function reorderQueued(o: OrchestratorHost, orderedIds: string[], wsId: string): boolean {
  const bucket = o.ensureBucket(wsId);
  const next = reorderQueuedTurns(bucket.queue, orderedIds);
  if (!next) return false;
  const ordered = applyQueueOrderToDisplay(bucket.display, next).filter(message => message.queued).map(message => message.id);
  commitDisplayEdit(o, wsId, { moveToTail: ordered }, () => { bucket.queue = next; });
  o.persistBucket(wsId);
  return true;
}

/**
 * steer 已注入引擎：切开调度面板转写回合（与 GUI 会话 host/turn.ts splitSteeredTurn
 * 同语义）。旧 assistant 定稿——running 工具卡按「未收到结果」收尾（切分后 provider
 * 落点已换新占位，迟到的 tool end 在新占位查不到即自然丢弃，不收口则进行中动画永远
 * 转）；插话用户消息与其后新 assistant 占位入流，后续回复落新占位，回复不再显示在
 * 插话之前。返回新占位（调用方挂 bucket.streamingAssistant）。
 */
export function splitSteeredDisplayTurn(
  display: ChatMessage[],
  current: ChatMessage,
  userMsg: ChatMessage
): ChatMessage {
  const note = t('回合结束仍未收到该工具的结果');
  for (const rec of current.toolCalls ?? []) {
    if (rec.status === 'running') {
      rec.status = 'cancelled';
      rec.result = note;
    }
  }
  display.push(userMsg);
  const next: ChatMessage = {
    id: randomUUID(),
    role: 'assistant',
    content: '',
    toolCalls: [],
    createdAt: Date.now()
  };
  display.push(next);
  return next;
}

/**
 * 立即发送（统一排队面板的「立即」）：空闲 = 正常发送；忙 = 插话（steer）当前
 * 回合，引擎不支持/未在流式中则回落排队。返回落点供渲染层提示。
 */
export async function sendNow(
  o: OrchestratorHost,
  text: string,
  wsId: string
): Promise<'sent' | 'steered' | 'queued' | 'failed'> {
  const content = text.trim();
  if (!content) return 'failed'; // 渲染层入口各自 trim 守卫，这里兜住 IPC 直调的空文本
  const messageId = randomUUID();
  // A steer may wait on the engine. Its user instruction is accepted now, not
  // when the engine later consumes it or the fallback queue finally drains.
  o.ctx?.desktopTurns?.().noteUserInstruction(`orchestrator:${wsId}`, messageId);
  desktopTurnGrants.nextUserMessage(`orchestrator:${wsId}`);
  const bucket = o.ensureBucket(wsId);
  if (!bucket.busy) {
    await o.send(content, wsId, undefined, { messageId, desktopInstructionNoted: true });
    return 'sent';
  }
  const session = bucket.piSession;
  if (!bucket.workbenchRemoteAssistantId && session?.steer && session.isStreaming !== false) {
    let engineText = content;
    if (hasWorkerModelMentions(content)) {
      const context = getSchedulerConnectionContext(session);
      if (!context) throw new Error('Worker model reference: the active turn has no bound workspace source.');
      const { prepareWorkerModelMentions } = await import('../../tasks/workerRouting');
      engineText = await prepareWorkerModelMentions(o.ctx, { workspaceId: wsId, rootId: context.sourceRootId,
        rootsRevision: context.rootsRevision, cwd: context.cwd }, content);
      if (!bucket.busy || bucket.piSession !== session) {
        const disposition = bucket.busy ? 'queued' : 'sent';
        await o.send(content, wsId, undefined, { messageId, desktopInstructionNoted: true });
        return disposition;
      }
    }
    const tracked = !!o.ctx?.desktopTurns;
    const execution = bucket.desktopExecution;
    let steerSerial = 0;
    let pending: PendingDesktopSteer | undefined;
    if (tracked) {
      steerSerial = bucket.desktopSteerSerial = (bucket.desktopSteerSerial ?? 0) + 1;
      bucket.desktopSteersInFlight = (bucket.desktopSteersInFlight ?? 0) + 1;
      // While delivery is pending, neither old nor future calls may borrow a
      // new turn. The old snapshot becomes invalid synchronously.
      endSchedulerDesktopTurn(o, bucket, wsId);
      pending = { id: messageId, text: content, serial: steerSerial, session, accepted: false, consumed: false };
      (bucket.desktopPendingSteers ??= []).push(pending);
    }
    const endDelivery = desktopTurnGrants.beginUserDelivery(`orchestrator:${wsId}`);
    try {
      const disposition = await session.steer(engineText);
      if (pending && bucket.desktopExecution === execution) {
        if (disposition === 'handled') bucket.desktopPendingSteers = bucket.desktopPendingSteers?.filter(item => item !== pending);
        else pending.accepted = true;
      }
    } catch (error) {
      if ((error as { deliveryUncertain?: boolean })?.deliveryUncertain) throw error;
      // steer 被引擎拒绝：回落排队（busy 时 send 即入队）
      if (pending && bucket.desktopExecution === execution) bucket.desktopPendingSteers = bucket.desktopPendingSteers?.filter(item => item !== pending);
      endDelivery();
      await o.send(content, wsId, undefined, { messageId, desktopInstructionNoted: true });
      return 'queued';
    } finally {
      endDelivery();
      if (tracked && bucket.desktopExecution === execution) {
        bucket.desktopSteersInFlight = Math.max(0, (bucket.desktopSteersInFlight ?? 1) - 1);
        activateSchedulerDesktopSteer(o, bucket, wsId);
      }
    }
    // steer 已注入：切分转写（旧 assistant 定稿 + 插话 user + 新 assistant 占位），
    // provider 后续流式落 bucket.streamingAssistant（新占位）。await 期间回合可能
    // 已收口（steer 注入无人认领的引擎流，与 GUI 会话 TOCTOU 同类）——此时不切分，
    // 沿用旧行为只垫 user 消息（同样带 steering:'send'，插话两路径形态一致），
    // 回合收口的 doneMsg/重试定位本就兼容垫尾消息
    const current = bucket.streamingAssistant;
    const steerMsg: ChatMessage = { id: messageId, role: 'user', content, createdAt: Date.now(), steering: 'send' };
    try {
      if (bucket.busy && current) {
        const finalized = structuredClone(current);
        const changed = [finalized];
        const next = splitSteeredDisplayTurn(changed, finalized, steerMsg);
        // One durable command accepts the split; no partially written triple
        // or in-memory cancellation survives a refused append.
        commitDisplayEdit(o, wsId, { upsert: changed.map(message => ({ message })) }, () => { bucket.streamingAssistant = next; });
      } else {
        commitDisplayEdit(o, wsId, { upsert: [{ message: steerMsg }] });
      }
      o.persistBucket(wsId);
    } catch (error) {
      throw Object.assign(new Error(`插话已被引擎受理，但本地记录失败；请先检查当前回合，勿重复发送：${error instanceof Error ? error.message : String(error)}`),
        { deliveryUncertain: true, cause: error });
    }
    return 'steered';
  }
  await o.send(content, wsId, undefined, { messageId, desktopInstructionNoted: true });
  return 'queued';
}
