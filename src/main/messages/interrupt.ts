import type { AppContext } from '../context';
import { deliverAgentMessage, readAgentLedgerFor, type DeliverAgentMessageInput } from './deliver';
import { holdMailboxWake, flushMailboxWake } from './wake';
import { updateAgentMessageWakeInStore } from '../metaAgent/messageStore';
import { deliverMailboxNotice } from './communication';
import { assertInterruptPermission } from './interruptAuthorization';
import { captureGuiWorkContext } from '../agentSession/workSnapshot';
import { publicMailWakeReceipt } from '../../shared/agentMessage';

const active = new WeakMap<AppContext, Map<string, Promise<unknown>>>();
const nativeActive = new WeakMap<AppContext, Map<string, Promise<boolean>>>();

export async function sendInterruptMail(ctx: AppContext, input: DeliverAgentMessageInput, signal?: AbortSignal) {
  assertInterruptPermission(ctx, input.from, input.to);
  if (signal?.aborted) throw new Error('已取消，未保存或中断。');
  const target = ctx.sessions.get(input.to)!;
  const workspaceId = target.workspaceId || input.workspaceId || ctx.resolveBubbleWorkspaceId();
  const release = holdMailboxWake(ctx, target.id, workspaceId);
  try {
    const saved = await deliverAgentMessage(ctx, { ...input, interrupt: true });
    let pending = active.get(ctx);
    if (!pending) { pending = new Map(); active.set(ctx, pending); }
    const root = ctx.workspaces.list().find(workspace => workspace.id === saved.mailboxWorkspaceId)?.path;
    if (!root) throw new Error(`信件 ${saved.messageId} 已保存，但收件工作区已关闭。`);
    const entryBefore = readAgentLedgerFor(ctx, saved.mailboxWorkspaceId).messages.find(mail => mail.id === saved.messageId)!;
    const nativeHandled = entryBefore.interruption === 'accepted' ||
      entryBefore.interruption !== 'stopped' && entryBefore.interruption !== 'requested' &&
      await tryNativeDelivery(ctx, input.from, target.id, saved.mailboxWorkspaceId, saved.messageId, signal);
    if (!nativeHandled && entryBefore.interruption !== 'stopped') {
      // Different letters arriving together stop the same current turn once.
      // Each sender holds wakes until its own durable receipt is marked stopped.
      const key = JSON.stringify([saved.mailboxWorkspaceId, target.id]);
      let job = pending.get(key);
      if (!job) {
        job = stopSavedMail(ctx, input.from, target.id, saved.mailboxWorkspaceId, saved.messageId, signal)
          .finally(() => pending!.delete(key));
        pending.set(key, job);
      } else {
        await updateAgentMessageWakeInStore(root, saved.mailboxWorkspaceId, [saved.messageId], { interruption: 'requested' });
      }
      try {
        await job;
        await updateAgentMessageWakeInStore(root, saved.mailboxWorkspaceId, [saved.messageId], { interruption: 'stopped' });
      } catch (error) {
        await updateAgentMessageWakeInStore(root, saved.mailboxWorkspaceId, [saved.messageId], {
          error: (error as Error).message,
          ...((error as { interruptNotSent?: boolean }).interruptNotSent ? { interruption: 'pending' as const } : {})
        });
        throw error;
      }
    }
    release();
    await flushMailboxWake(ctx, target.id, workspaceId);
    const entry = readAgentLedgerFor(ctx, saved.mailboxWorkspaceId).messages.find(mail => mail.id === saved.messageId)!;
    const { wake: _wake, wakeDeferred: _deferred, wakeError: _error, wakeUncertain: _uncertain,
      notifiedAt: _notified, deliveryMethod: _delivery, ...savedMail } = saved;
    const wakeReceipt = publicMailWakeReceipt(entry);
    return { ...savedMail, interruption: entry.interruption, read: entry.read, readAt: entry.readAt, ...wakeReceipt,
      ...(!entry.read ? { wake: wakeReceipt.notifiedAt !== undefined ? 'notified' : wakeReceipt.wakeDeferred ? 'deferred' : 'pending' } : {}) };
  } finally { release(); }
}

async function tryNativeDelivery(ctx: AppContext, parentId: string, targetId: string,
  workspaceId: string, messageId: string, signal?: AbortSignal): Promise<boolean> {
  let jobs = nativeActive.get(ctx);
  if (!jobs) { jobs = new Map(); nativeActive.set(ctx, jobs); }
  const key = JSON.stringify([workspaceId, messageId]);
  const existing = jobs.get(key);
  if (existing) return existing;
  const job = (async () => {
    const root = ctx.workspaces.list().find(w => w.id === workspaceId)?.path;
    if (!root) throw new Error('收件工作区已关闭');
    const entry = () => readAgentLedgerFor(ctx, workspaceId).messages.find(mail => mail.id === messageId)!;
    if (entry().interruption === 'accepted') return true;
    if (entry().interruption === 'delivering') throw new Error(`信件 ${messageId} 已保存；原生投递状态未知，未重复插话或中断`);
    if (signal?.aborted) throw new Error(`信件 ${messageId} 已保存；通信已取消`);
    assertInterruptPermission(ctx, parentId, targetId);
    await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { interruption: 'delivering' });
    try {
      const result = await deliverMailboxNotice(ctx, targetId, workspaceId,
        `【宿主收信提醒】发来打断类消息，请优先用 host.mail.read 读取信件 ${messageId}。提醒不代表信件已读或任务完成；无需回复本提醒。`,
        `mailbox-interrupt-${messageId}`, () => { assertInterruptPermission(ctx, parentId, targetId); return !entry().read; },
        { intent: 'interrupt', nativeOnly: true, signal });
      if (result.status === 'accepted') {
        await updateAgentMessageWakeInStore(root, workspaceId, [messageId], {
          interruption: 'accepted', deliveryMethod: result.method, notifiedAt: Date.now() });
        ctx.sessions.broadcastMessagesChanged();
        return true;
      }
      await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { interruption: 'pending',
        ...(result.status === 'deferred' ? { deferred: result.reason } : {}) });
      // Deferred is a deliberate native decision, not permission to stop the engine instead.
      return result.status === 'deferred';
    } catch (error) {
      await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { error: (error as Error).message });
      throw new Error(`信件 ${messageId} 已保存；原生投递未确认：${(error as Error).message}`);
    }
  })().finally(() => jobs!.delete(key));
  jobs.set(key, job);
  return job;
}

async function stopSavedMail(ctx: AppContext, parentId: string, targetId: string, workspaceId: string, messageId: string, signal?: AbortSignal) {
  const root = ctx.workspaces.list().find(workspace => workspace.id === workspaceId)?.path;
  if (!root) throw new Error(`信件 ${messageId} 已保存，但收件工作区已关闭。`);
  const entry = readAgentLedgerFor(ctx, workspaceId).messages.find(mail => mail.id === messageId)!;
  if (entry.interruption === 'stopped') return;
  assertInterruptPermission(ctx, parentId, targetId);
  const stopped = () => {
    const session = ctx.sessions.get(targetId);
    if (!session || session.archived) throw new Error('目标会话已关闭或归档。');
    if (ctx.sessions.isChatRuntime(session.runtime)) {
      if (!ctx.agentSessions) throw new Error('GUI 会话宿主不可用，无法确认停止');
      return !ctx.agentSessions.isBusy(targetId);
    }
    return !ctx.pty.isRunning(targetId) || session.lifecycle === 'idle';
  };
  const deadline = Date.now() + 10000;
  const binding = ctx.sessions.getCliWorkspaceContext?.(targetId);
  const initial = ctx.sessions.get(targetId)!;
  const nativeSessionId = initial.externalSessionId;
  let confirm: (() => Promise<boolean>) | undefined;
  let interruptNotSent = entry.interruption !== 'requested';
  try {
    if (signal?.aborted) throw new Error('已取消');
    if (!stopped() && entry.interruption !== 'requested') {
      const guiTurn = ctx.agentSessions?.entries?.get(targetId)?.activeExecutionTurnId;
      await boundedStop(ctx.sessions.captureManagedInterruptSnapshot(targetId, Date.now(), captureGuiWorkContext(ctx, targetId)), signal);
      if (stopped()) {
        await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { interruption: 'stopped' });
        return;
      }
      if (guiTurn && ctx.agentSessions?.entries?.get(targetId)?.activeExecutionTurnId !== guiTurn)
        throw new Error('捕获快照期间回合已变化，未发送中断信号');
      if (binding?.prepareInterrupt && nativeSessionId && initial.cwd)
        confirm = await boundedStop(binding.prepareInterrupt({ cwd: binding.workspaceContext?.cwd || initial.cwd, sessionId: nativeSessionId }), signal);
      if (ctx.sessions.getCliWorkspaceContext?.(targetId) !== binding || ctx.sessions.get(targetId)?.externalSessionId !== nativeSessionId) {
        interruptNotSent = true;
        throw new Error('准备中断时会话已更换，未发送中断信号');
      }
      await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { interruption: 'requested' });
      assertInterruptPermission(ctx, parentId, targetId);
      if (signal?.aborted) { interruptNotSent = true; throw new Error('已取消'); }
      if (stopped()) {
        await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { interruption: 'stopped' });
        return;
      }
      if (guiTurn && ctx.agentSessions?.entries?.get(targetId)?.activeExecutionTurnId !== guiTurn)
        throw new Error('中断投递前回合已变化，未发送中断信号');
      const session = ctx.sessions.get(targetId)!;
      if (ctx.sessions.isChatRuntime(session.runtime)) {
        if (!ctx.agentSessions) throw new Error('GUI 会话宿主不可用');
        interruptNotSent = false;
        await boundedStop(ctx.agentSessions.abort(targetId), signal);
      } else if (!ctx.pty.write(targetId, ctx.sessions.getCliWorkspaceContext?.(targetId)?.interruptInput ?? '\x03')) {
        throw new Error('未能发送中断信号');
      } else interruptNotSent = false;
    }
    while (!stopped()) {
      if (confirm && await boundedStop(confirm(), signal, Math.max(1, deadline - Date.now()))) {
        const current = ctx.sessions.get(targetId);
        if (!current || ctx.sessions.getCliWorkspaceContext?.(targetId) !== binding || current.externalSessionId !== nativeSessionId)
          throw new Error('中断确认期间会话已更换');
        ctx.sessions.applyActivitySignal?.(targetId, 'idle', 'native-interrupt-confirmed');
        if (stopped()) break;
      }
      if (signal?.aborted) throw new Error('已取消');
      if (Date.now() >= deadline) throw new Error('尚未确认当前回合停止；未重复中断或启动并发回合');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { interruption: 'stopped' });
  } catch (error) {
    const detail = (error as Error).message;
    await updateAgentMessageWakeInStore(root, workspaceId, [messageId], { error: detail,
      ...(interruptNotSent ? { interruption: 'pending' as const } : {}) });
    throw Object.assign(new Error(`信件 ${messageId} 已保存；中断阶段未完成：${detail}`), { interruptNotSent });
  }
}

async function boundedStop<T>(stop: Promise<T>, signal?: AbortSignal, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([stop, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('中断超时')), timeoutMs);
      cancel = () => reject(new Error('已取消'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}
