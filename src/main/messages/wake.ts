/** One durable mailbox. Only GUI initial assignments use the native turn prefix. */
import path from 'node:path';
import { semanticOperationsFor, type SemanticOperations } from '../runtimeKernel/semanticOperations';
import { createHash, randomUUID } from 'node:crypto';
import type { AppContext } from '../context';
import { runOutsideAgentScope } from '../agent/agentScope';
import { agentMessagesFilePath, listAgentMessageWorkspaceIds, readAgentMessageLedger, updateAgentMessageWakeInStore } from '../metaAgent/messageStore';
import { deliverMailboxNotice } from './communication';
import type { RuntimeDeliveryResult } from '../../shared/runtimeCommunication';
import { isHostNotification } from '../../shared/hostNotification';
import { hostNotificationDelivery } from './hostNotifications';
import { canInterruptSession } from './interruptAuthorization';
import { getSubscriptionPolicyStore } from '../orchestrator/subscriptionPolicyStore';
import { effectivePolicyTiming } from '../../shared/subscriptionPolicy';
import { controlRootFor } from '../workspacePaths';
import { isSchedulerWaitingOnHuman } from '../schedulerStatusStore';
import { deliverSession } from '../agentSession/delivery';
import { formatResumeBrief } from '../../shared/interruptSnapshot';
import { isPendingInitialAssignment } from '../../shared/agentMessage';

type WakeSender = (...args: Parameters<typeof deliverMailboxNotice>) => Promise<boolean | RuntimeDeliveryResult>;
const services = new WeakMap<AppContext, MailboxWakes>();
const closedContexts = new WeakSet<AppContext>();
export type MailboxWakeOwner = (() => void) & { drain(): Promise<void> };

export class MailboxWakes {
  private holds = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private delayed = new Set<string>();
  private running = new Map<string, Promise<void>>();
  private rerun = new Set<string>();
  private expedite = new Set<string>();
  private disposed = false;
  private readonly admission = new AbortController();
  private retries = new Map<string, number>();
  private retryDelay = new Map<string, number>();
  private assignmentKicks = new Set<string>();
  constructor(private ctx: AppContext, private send: WakeSender = deliverMailboxNotice,
    private retryDelays: readonly number[] = [500, 1500, 4000, 30000]) {}

  request(recipient: string, workspaceId: string, subscriptionEvent = false): void {
    if (this.disposed) return;
    const key = JSON.stringify([recipient, workspaceId]);
    if (this.holds.has(key)) return;
    if (this.running.has(key)) {
      if (!subscriptionEvent) { this.retryDelay.delete(key); this.expedite.add(key); }
      this.rerun.add(key); return;
    }
    if (this.timers.has(key)) {
      if (subscriptionEvent || !this.delayed.has(key)) return;
      clearTimeout(this.timers.get(key));
      this.timers.delete(key); this.delayed.delete(key); this.retryDelay.delete(key);
    }
    const delay = this.retryDelay.get(key) ?? 120;
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.delayed.delete(key);
      void this.flush(recipient, workspaceId);
    }, delay);
    if (delay > 120) this.delayed.add(key);
    this.retryDelay.delete(key);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  flush(recipient: string, workspaceId: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const key = JSON.stringify([recipient, workspaceId]);
    if (this.holds.has(key)) return Promise.resolve();
    const active = this.running.get(key);
    if (active) return active;
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.delayed.delete(key);
    const job = runOutsideAgentScope(() => this.deliver(recipient, workspaceId)).catch(error => {
      console.warn('[mailbox] 收信提醒失败，信件已保留', recipient, error);
    }).finally(() => {
      this.running.delete(key);
      if (this.rerun.delete(key)) {
        if (this.expedite.delete(key)) this.retryDelay.delete(key);
        this.request(recipient, workspaceId);
      } else this.expedite.delete(key);
    });
    this.running.set(key, job);
    return job;
  }

  private async deliver(recipient: string, workspaceId: string): Promise<void> {
    const root = this.ctx.workspaces.list().find(w => w.id === workspaceId)?.path;
    if (!root || !readAgentMessageLedger(root, workspaceId).messages.some(m =>
      (m.to === recipient || m.to === 'scheduler' && recipient === `orchestrator:${workspaceId}`) &&
      !m.read && !m.notifiedAt && !m.initialAssignmentReceipt)) return;
    let journal: SemanticOperations;
    try { journal = semanticOperationsFor(this.ctx, recipient,
      path.dirname(path.dirname(agentMessagesFilePath(workspaceId))), this.ctx.sessionLogs); }
    catch (error) {
      const ids = readAgentMessageLedger(root, workspaceId).messages.filter(message =>
        (message.to === recipient || message.to === 'scheduler' && recipient === `orchestrator:${workspaceId}`) && !message.read && !message.notifiedAt).map(message => message.id);
      await updateAgentMessageWakeInStore(root, workspaceId, ids, { error: `唤醒状态记录不可用，未提交：${String(error)}` });
      this.ctx.sessions.broadcastMessagesChanged();
      throw error;
    }
    return journal.serial('mailbox-wake', () => this.deliverInner(recipient, workspaceId, journal));
  }

  private async deliverInner(recipient: string, workspaceId: string, journal: SemanticOperations): Promise<void> {
    const root = this.ctx.workspaces.list().find(w => w.id === workspaceId)?.path;
    if (!root) return; // Closed workspaces retain mail without reviving sessions.
    // Plain shell terminals host no model; their letters can never be woken here.
    // Record the definite non-delivery instead of stranding them silently.
    const shellTarget = recipient.startsWith('orchestrator:') ? undefined : this.ctx.sessions.get(recipient);
    if (shellTarget && !shellTarget.archived && shellTarget.launchKind === 'shell') {
      const stranded = readAgentMessageLedger(root, workspaceId).messages.filter(m =>
        (m.to === recipient || m.to === 'scheduler' && recipient === `orchestrator:${workspaceId}`) &&
        m.receipt === 'stored' && !m.read && !m.notifiedAt && !m.wakeError);
      if (stranded.length) {
        await updateAgentMessageWakeInStore(root, workspaceId, stranded.map(m => m.id), { error: '普通 shell 终端不接收唤醒' });
        this.ctx.sessions.broadcastMessagesChanged();
      }
      return;
    }
    const eligible = () => {
      if (this.disposed || this.holds.has(JSON.stringify([recipient, workspaceId])) || !this.ctx.workspaces.list().some(w => w.id === workspaceId)) return false;
      if (recipient.startsWith('orchestrator:')) return true;
      const s = this.ctx.sessions.get(recipient);
      return !!s && !s.archived && s.launchKind !== 'shell';
    };
    if (!eligible()) {
      // X2-F01: 投递后才归档/删除的目标永远不会被唤醒，信件若静默停格则寄件方
      // 回执永远停在「已存待唤醒」。复用 shell 分支的 stranded 写账模式记一笔
      // 确定性 wakeError（transient 的 disposed/hold 状态不写，等真正的边沿再判）。
      if (!recipient.startsWith('orchestrator:') && !this.disposed && !this.holds.has(JSON.stringify([recipient, workspaceId]))) {
        const s = this.ctx.sessions.get(recipient);
        const reason = s ? (s.archived ? '会话已归档，不再唤醒' : undefined) : '会话已删除，不再唤醒';
        if (reason) {
          const stranded = readAgentMessageLedger(root, workspaceId).messages.filter(m =>
            m.to === recipient && m.receipt === 'stored' && !m.read && !m.notifiedAt && !m.wakeError);
          if (stranded.length) {
            await updateAgentMessageWakeInStore(root, workspaceId, stranded.map(m => m.id), { error: reason });
            this.ctx.sessions.broadcastMessagesChanged();
          }
        }
      }
      return;
    }
    // A stop acknowledgement may arrive after the caller's bounded wait expired.
    // Recover the saved letter on the real idle edge, without sending a second stop.
    const target = this.ctx.sessions.get(recipient);
    if (target && (this.ctx.sessions.isChatRuntime(target.runtime)
      ? !!this.ctx.agentSessions && !this.ctx.agentSessions.isBusy(recipient) : target.lifecycle === 'idle' || target.lifecycle === 'exited')) {
      const stopped = readAgentMessageLedger(root, workspaceId).messages.filter(m => m.to === recipient &&
        m.interruption === 'requested' && !m.read && !m.notifiedAt && canInterruptSession(this.ctx, m.from, recipient));
      if (stopped.length) await updateAgentMessageWakeInStore(root, workspaceId, stopped.map(m => m.id), { interruption: 'stopped' });
    }
    // Recover an accepted dispatch before selecting a new batch. If writing
    // mailbox receipts failed, newly arrived letters must not re-send old ones.
    const accepted = new Map([...journal.acceptedCauses('mailbox.wake'), ...journal.acceptedCauses('mailbox.interject')]);
    const uncertain = new Set([...journal.uncertainCauses('mailbox.wake'), ...journal.uncertainCauses('mailbox.interject')]);
    for (const message of readAgentMessageLedger(root, workspaceId).messages) {
      if (message.to !== recipient && !(message.to === 'scheduler' && recipient === `orchestrator:${workspaceId}`) ||
          message.read || message.notifiedAt || message.initialAssignmentReceipt) continue;
      const receipt = accepted.get(message.id);
      if (receipt) {
        const result = receipt.result as RuntimeDeliveryResult | boolean;
        await updateAgentMessageWakeInStore(root, workspaceId, [message.id], { notifiedAt: receipt.at,
          ...(result && typeof result === 'object' && result.status === 'accepted' ? { deliveryMethod: result.method } : {}) });
        this.ctx.sessions.broadcastMessagesChanged();
      } else if (uncertain.has(message.id) && !message.wakeUncertain) {
        await updateAgentMessageWakeInStore(root, workspaceId, [message.id], { uncertain: true,
          error: '上次投递结果未知，未自动重发；请检查原生会话历史和邮箱回执' });
        this.ctx.sessions.broadcastMessagesChanged();
      }
    }
    const pending = () => readAgentMessageLedger(root, workspaceId).messages.filter(m =>
      (m.to === recipient || m.to === 'scheduler' && recipient === `orchestrator:${workspaceId}`) &&
      m.receipt === 'stored' && !m.read && !m.notifiedAt && !m.wakeUncertain && !m.initialAssignmentReceipt &&
      (!m.meta?.interrupt || m.interruption === 'stopped' || m.interruption === 'pending'));
    const gui = !!target && this.ctx.sessions.isChatRuntime(target.runtime);
    const assignment = gui ? pending().find(isPendingInitialAssignment) : undefined;
    if (assignment && !this.assignmentKicks.has(assignment.id)) {
      // A normal idle turn provides the transport. The native send boundary
      // reserves and prefixes the body. Admission itself is not a receipt.
      const needed = () => eligible() && pending().some(message => message.id === assignment.id);
      try {
        const result = await this.send(this.ctx, recipient, workspaceId, '开始处理宿主分配的任务。',
          `assignment-start-${randomUUID()}`, needed, { signal: this.admission.signal });
        if (result === true || typeof result === 'object' && result.status === 'accepted') {
          this.assignmentKicks.add(assignment.id);
          return;
        }
      } catch (error) {
        this.assignmentKicks.add(assignment.id);
        await updateAgentMessageWakeInStore(root, workspaceId, [assignment.id], {
          error: error instanceof Error ? error.message : String(error)
        });
        this.ctx.sessions.broadcastMessagesChanged();
        throw error;
      }
    }
    // A known pre-submission failure can be recovered by the router or by
    // explicitly retrying the turn; it must not spin up new kickoff turns.
    const batch = pending().filter(message => !gui || !message.meta?.initialAssignment);
    if (!batch.length || !batch.some(message => !message.meta?.digest)) return;
    if (recipient.startsWith('orchestrator:') && batch.every(message => message.meta?.subscriptionEvent)) {
      const workspace = this.ctx.workspaces.list().find(w => w.id === workspaceId)!;
      const timing = effectivePolicyTiming(getSubscriptionPolicyStore().load(controlRootFor(workspace)).policy);
      const times = batch.filter(message => !message.meta?.digest).map(message => message.ts);
      const delay = Math.min(Math.max(...times) + timing.mergeWindowMs, Math.min(...times) + timing.maxWaitMs) - Date.now();
      if (delay > 0) {
        const key = JSON.stringify([recipient, workspaceId]);
        this.retryDelay.set(key, delay);
        this.rerun.add(key);
        return;
      }
    }
    // Only scheduler subscription events can interject, after their merge window.
    // A definite rejection is recorded per letter and falls back to idle delivery.
    const eventBatch = batch.filter(m => m.meta?.subscriptionEvent && !m.meta?.digest && isHostNotification(m) && !m.wakeAtIdle);
    const orch = this.ctx.orchestrator;
    const eventTimes = eventBatch.map(m => m.ts);
    let eventDue = false, eventDelay = Infinity;
    if (recipient.startsWith('orchestrator:') && eventTimes.length) {
      const workspace = this.ctx.workspaces.list().find(w => w.id === workspaceId)!;
      const timing = effectivePolicyTiming(getSubscriptionPolicyStore().load(controlRootFor(workspace)).policy);
      eventDelay = Math.min(Math.max(...eventTimes) + timing.mergeWindowMs, Math.min(...eventTimes) + timing.maxWaitMs) - Date.now();
      eventDue = eventDelay <= 0;
    }
    if (recipient.startsWith('orchestrator:') && eventDue &&
        orch?.isBusy(workspaceId) && !isSchedulerWaitingOnHuman(this.ctx, workspaceId)) {
      const eventIds = eventBatch.map(m => m.id);
      const delivery = hostNotificationDelivery(this.ctx, workspaceId, eventIds, true, 'steered');
      const prepared = await delivery.prepare();
      if (!prepared) return;
      const preparedIds = prepared.ids;
      // Reserve exactly the prepared batch before native submission. A crash
      // after this point leaves an uncertain receipt rather than replaying it.
      await updateAgentMessageWakeInStore(root, workspaceId, preparedIds, { uncertain: true });
      const reservedDelivery = { ...delivery, prepare: () => prepared, signal: this.admission.signal };
      try {
        const deliveryId = `subscription:${[...preparedIds].sort().join(',')}`;
        const outcome = await journal.run('mailbox.interject', deliveryId, preparedIds, () => deliverSession({
          capabilities: { interject: true, snapshot: false },
          isBusy: () => orch.isBusy(workspaceId),
          wake: async () => ({ status: 'deferred', reason: '等待常规空闲投递' }),
          interject: async () => {
            try { return await orch.interjectHostNotification(workspaceId, reservedDelivery)
              ? { status: 'confirmed' } : { status: 'unsupported', reason: '原生插话不可用' }; }
            catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUncertain: true }); }
          },
          queue: async () => {} // The mailbox already persists this batch.
        }, prepared.content, { priority: 'preempt', deliveryId }), result => result.status === 'confirmed');
        if (outcome.status === 'confirmed') {
          const remaining = readAgentMessageLedger(root, workspaceId).messages.filter(m => eventIds.includes(m.id) && !m.read && !m.notifiedAt).map(m => m.id);
          if (remaining.length) await updateAgentMessageWakeInStore(root, workspaceId, remaining, { uncertain: false });
          console.info('[mailbox] event subscription delivery: interject', workspaceId, eventIds.length);
          if (pending().length) this.request(recipient, workspaceId);
          return;
        }
        await updateAgentMessageWakeInStore(root, workspaceId, preparedIds, {
          uncertain: false, atIdle: true, deferred: '等待调度空闲后投递'
        });
        console.warn('[mailbox] event subscription interject unavailable; waiting for idle', workspaceId);
        const key = JSON.stringify([recipient, workspaceId]);
        this.retryDelay.set(key, this.retryDelays[0] ?? 30000);
        this.rerun.add(key);
        return;
      } catch (error) {
        if ((error as { deliveryUncertain?: boolean })?.deliveryUncertain !== true) {
          await updateAgentMessageWakeInStore(root, workspaceId, preparedIds, { uncertain: false, atIdle: true,
            error: error instanceof Error ? error.message : String(error) });
          const key = JSON.stringify([recipient, workspaceId]);
          this.retryDelay.set(key, this.retryDelays[0] ?? 30000); this.rerun.add(key);
        }
        console.error('[mailbox] event subscription interject failed; uncertain input is not replayed', workspaceId, error);
        throw error;
      }
    }
    const hostMessages = recipient.startsWith('orchestrator:') ? batch.filter(isHostNotification) : [];
    const letters = batch.filter(m => !hostMessages.includes(m));
    const notification = hostMessages.length ? hostNotificationDelivery(this.ctx, workspaceId, hostMessages.map(m => m.id), !letters.length) : undefined;
    // Retire cancelled/processed events without opening an empty model turn.
    if (!letters.length && notification && !await notification.prepare()) return;
    const ids = batch.map(m => m.id).sort(), reserved = new Set(ids);
    const nativeInterrupts = batch.filter(m => m.meta?.interrupt && m.interruption === 'pending');
    const id = `mailbox-wake-${createHash('sha256').update(ids.join('\0')).digest('hex')}`;
    const interruptSnapshot = target?.interruptSnapshot;
    const workBrief = interruptSnapshot && letters.some(m => m.interruption === 'stopped')
      ? `\n\n${formatResumeBrief({ sessionName: target.name, snapshot: interruptSnapshot })}` : '';
    const text = letters.length ? `【宿主收信提醒】邮箱收到 ${letters.length} 封新信。请用 host.mail.read 批量读取未读正文，按 nextCursor 续收。${letters.some(m => m.meta?.interrupt) ? `收到打断类消息，请优先读取信件：${letters.filter(m => m.meta?.interrupt).map(m => m.id).join(', ')}。` : ''}提醒不代表信件已读或任务完成；无需回复本提醒。${workBrief}` : '';
    if (notification && letters.length) {
      const prepare = notification.prepare;
      notification.prepare = async () => await prepare() ?? (pending().some(m => letters.some(letter => letter.id === m.id))
        ? { ids: [], summary: `收到 ${letters.length} 封代理来信`, content: text } : null);
    }
    try {
      if (nativeInterrupts.length) {
        if (nativeInterrupts.some(m => {
          return !canInterruptSession(this.ctx, m.from, m.to);
        })) throw new Error('打断权限或目标已变化，打断类通知未重试');
        await updateAgentMessageWakeInStore(root, workspaceId, nativeInterrupts.map(m => m.id), { interruption: 'delivering' });
      }
      const result = await journal.run('mailbox.wake', id, ids, () => this.send(this.ctx, recipient, workspaceId, text, id,
        () => eligible() && readAgentMessageLedger(root, workspaceId).messages.some(m =>
          reserved.has(m.id) && !m.read && !m.notifiedAt && !m.wakeUncertain),
        { signal: this.admission.signal, ...(nativeInterrupts.length ? { intent: 'interrupt' as const, nativeOnly: true } : {}), ...(notification ? { notification } : {}) }),
        result => result === true || typeof result === 'object' && result.status === 'accepted');
      const accepted = result === true || typeof result === 'object' && result.status === 'accepted';
      if (accepted) {
        if (hostMessages.some(m => m.meta?.subscriptionEvent)) console.info('[mailbox] event subscription delivery: idle-wake', workspaceId);
        this.retries.delete(JSON.stringify([recipient, workspaceId]));
        await updateAgentMessageWakeInStore(root, workspaceId, letters.map(m => m.id), { notifiedAt: Date.now(),
          ...(typeof result === 'object' && result.status === 'accepted' ? { deliveryMethod: result.method } : {}) });
        if (nativeInterrupts.length) await updateAgentMessageWakeInStore(root, workspaceId,
          nativeInterrupts.map(m => m.id), { interruption: 'accepted' });
        this.ctx.sessions.broadcastMessagesChanged();
        // New arrivals while admission waited get their own later batch.
        if (pending().length) this.request(recipient, workspaceId);
      } else {
        if (nativeInterrupts.length) await updateAgentMessageWakeInStore(root, workspaceId,
          nativeInterrupts.map(m => m.id), { interruption: 'pending' });
        const unread = pending().filter(m => reserved.has(m.id));
        if (!unread.length) return;
        const key = JSON.stringify([recipient, workspaceId]);
        const attempt = this.retries.get(key) ?? 0;
        const failure = typeof result === 'object' && result.status === 'unsupported';
        const reason = typeof result === 'object' && result.status !== 'accepted' ? result.reason : '当前接入暂未受理';
        const reportIds = unread.filter(m => (failure ? m.wakeError : m.wakeDeferred) !== reason).map(m => m.id);
        if (reportIds.length) {
          await updateAgentMessageWakeInStore(root, workspaceId, reportIds, failure ? { error: reason } : { deferred: reason });
          this.ctx.sessions.broadcastMessagesChanged();
        }
        // A late MCP handshake / long native turn need not produce a host idle edge.
        // Cap the polling rate, not the lifetime of a definitely unsubmitted notice.
        // Uncertain delivery is excluded by pending(), never retried here.
        const index = Math.min(attempt, this.retryDelays.length - 1);
        this.retries.set(key, index + 1);
        this.retryDelay.set(key, Math.min(this.retryDelays[index] ?? 30000, eventDelay > 0 ? eventDelay : Infinity));
        this.rerun.add(key);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const uncertain = (error as { deliveryUncertain?: boolean })?.deliveryUncertain === true;
      // The same failing reason must not rewrite the ledger on every retry attempt.
      if (batch.some(m => (uncertain ? !m.wakeUncertain : m.wakeError !== reason))) {
        await updateAgentMessageWakeInStore(root, workspaceId, ids, { error: reason, ...(uncertain ? { uncertain: true as const } : {}) });
        this.ctx.sessions.broadcastMessagesChanged();
      }
      if (!uncertain && pending().some(message => reserved.has(message.id))) {
        const key = JSON.stringify([recipient, workspaceId]);
        const attempt = Math.min(this.retries.get(key) ?? 0, this.retryDelays.length - 1);
        this.retries.set(key, attempt + 1); this.retryDelay.set(key, this.retryDelays[attempt] ?? 30000); this.rerun.add(key);
      }
      throw error;
    }
  }

  scan(recipient?: string): void {
    for (const key of this.retries.keys()) if (!recipient || JSON.parse(key)[0] === recipient) this.retries.delete(key);
    for (const workspaceId of listAgentMessageWorkspaceIds()) {
      const root = this.ctx.workspaces.list().find(w => w.id === workspaceId)?.path;
      if (!root) continue;
      try {
        const targets = new Set(readAgentMessageLedger(root, workspaceId).messages
          .filter(m => m.receipt === 'stored' && !m.read && !m.notifiedAt && !m.initialAssignmentReceipt).map(m => m.to));
        for (const target of targets) if (!recipient || target === recipient) this.request(target, workspaceId);
      } catch (error) { console.warn('[mailbox] 无法扫描邮箱，原文件保留', workspaceId, error); }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.admission.abort();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.assignmentKicks.clear();
    this.timers.clear(); this.delayed.clear(); this.rerun.clear(); this.expedite.clear(); this.retries.clear(); this.retryDelay.clear();
  }

  async drain(): Promise<void> {
    // Admission is stopped before dependants close. Wait only after their
    // scheduler/GUI cancellation has released native receipt/gate waiters.
    await Promise.all([...this.running.values()]);
  }

  hold(recipient: string, workspaceId: string): () => void {
    const key = JSON.stringify([recipient, workspaceId]);
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(key) ?? 1) - 1;
      if (left) this.holds.set(key, left); else { this.holds.delete(key); this.request(recipient, workspaceId); }
    };
  }
}

function service(ctx: AppContext): MailboxWakes {
  let value = services.get(ctx);
  if (!value) { value = new MailboxWakes(ctx); services.set(ctx, value); }
  return value;
}
export function requestMailboxWake(ctx: AppContext, recipient: string, workspaceId: string, subscriptionEvent = false): void {
  if (!closedContexts.has(ctx)) service(ctx).request(recipient, workspaceId, subscriptionEvent);
}
export function holdMailboxWake(ctx: AppContext, recipient: string, workspaceId: string): () => void {
  return closedContexts.has(ctx) ? () => {} : service(ctx).hold(recipient, workspaceId);
}
export function flushMailboxWake(ctx: AppContext, recipient: string, workspaceId: string): Promise<void> {
  return closedContexts.has(ctx) ? Promise.resolve() : service(ctx).flush(recipient, workspaceId);
}
export function attachMailboxWakes(ctx: AppContext): MailboxWakeOwner {
  closedContexts.delete(ctx);
  const wakes = service(ctx);
  const off = ctx.sessions.onLifecycle((s, _prev, next) => {
    if (next === 'idle') wakes.scan(s.id);
  });
  const offScheduler = ctx.orchestrator?.onEvent((channel, payload) => {
    if (channel === 'agent:done') {
      const ws = (payload as { workspaceId?: string })?.workspaceId;
      if (ws) { wakes.scan(`orchestrator:${ws}`); }
    }
  });
  wakes.scan();
  const stop = (): void => { closedContexts.add(ctx); off(); offScheduler?.(); wakes.dispose(); services.delete(ctx); };
  return Object.assign(stop, { drain: () => wakes.drain() });
}
