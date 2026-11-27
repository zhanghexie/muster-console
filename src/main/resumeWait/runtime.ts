import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import type { AppContext } from '../context';

import fs from 'node:fs';
import { onAgentMessageAppended } from '../metaAgent/messageStore';
import { deliverAgentMessage, mailboxStores } from '../messages/deliver';
import { currentGuiExecutionTurn, currentSchedulerDesktopExecutionTurn, runOutsideAgentScope } from '../agent/agentScope';
import { readAgentMessageLedger } from '../metaAgent/messageStore';
import { sendMailboxWake } from '../messages/transport';
import { deliverMailboxNotice } from '../messages/communication';
import { watchedSession } from '../messages/watch';
import { deliverSession, type DeliveryAttempt, type DeliveryCapabilities } from '../agentSession/delivery';
import { captureGuiWorkContext } from '../agentSession/workSnapshot';
import { isSchedulerWaitingOnHuman } from '../schedulerStatusStore';
import type { HostNotificationDelivery } from '../../shared/hostNotification';
import { parseRuntimeDeliveryResult } from '../../shared/runtimeCommunication';
import { ResumeWaitStore, type ResumeWait } from './store';
import { ResumeWaitService } from './service';
import { bindDesktopContinuationDelivery, DesktopContinuationSources } from './desktopSources';

const boundaryOnly: DeliveryCapabilities = { interject: false, snapshot: false };
const refreshers = new WeakMap<AppContext, () => void>();
export function refreshResumeWait(ctx: AppContext): void { refreshers.get(ctx)?.(); }

function preemptionCapabilities(ctx: AppContext, owner: string): DeliveryCapabilities {
  if (owner.startsWith('orchestrator:')) return { interject: !!ctx.orchestrator, snapshot: false };
  const session = ctx.sessions.get(owner);
  if (!session || session.archived || session.launchKind === 'shell') return boundaryOnly;
  if (ctx.sessions.isChatRuntime(session.runtime)) return ctx.agentSessions?.getDriver(session.runtime!)?.deliveryCapabilities ?? boundaryOnly;
  return ctx.sessions.getCliWorkspaceContext(owner)?.deliveryCapabilities ?? boundaryOnly;
}

function isBusy(ctx: AppContext, owner: string): boolean {
  if (owner.startsWith('orchestrator:')) return ctx.orchestrator?.isBusy(owner.slice('orchestrator:'.length)) !== false;
  const session = ctx.sessions.get(owner);
  return !!session && ctx.sessions.isChatRuntime(session.runtime)
    ? ctx.agentSessions?.isBusy(owner) !== false
    : !['idle', 'exited'].includes(session?.lifecycle ?? '');
}

function snapshot(ctx: AppContext, wait: ResumeWait): { text: string; turnId?: string } {
  const session = ctx.sessions.get(wait.owner);
  const entry = ctx.agentSessions?.entries.get(wait.owner);
  if (!session || !entry || !entry.busy) throw new Error('会话已变化，未发送抢占中断');
  const text = captureGuiWorkContext(ctx, wait.owner) ?? '';
  return { text, turnId: entry.activeExecutionTurnId };
}

/** Attach after the event router and session hosts are ready. */
export function attachResumeWait(ctx: AppContext, userDataDir: string): () => void {
  const log = ctx.eventRouter?.log;
  if (!log) throw new Error('Event log unavailable; waitFor cannot start');
  const store = new ResumeWaitStore(userDataDir);
  let desktopSources: DesktopContinuationSources | undefined;
  let desktopSourcesFailed = false;
  let disposed = false;
  let nextDesktopSourceCleanup = 0;
  const desktopSourceFile = userDataStorage(userDataDir).file('desktop-continuation-sources');
  const getDesktopSources = (): DesktopContinuationSources | undefined => {
    if (desktopSourcesFailed || disposed) return undefined;
    try { return desktopSources ??= new DesktopContinuationSources(desktopSourceFile); }
    catch (error) {
      desktopSourcesFailed = true;
      console.error('[resume-wait] desktop continuation storage unavailable; desktop use must remain frozen:', error);
      return undefined;
    }
  };
  const intersectDesktop = (owner: string, turn: string | undefined, workspaceId: string,
    continuation: import('../../shared/hostNotification').HostDesktopContinuation): void => {
    let turns: ReturnType<NonNullable<AppContext['desktopTurns']>> | undefined;
    try {
      turns = ctx.desktopTurns?.();
      if (turn) turns?.intersectContinuation(owner, turn, workspaceId, continuation);
      else turns?.blockCurrent(owner);
    } catch (error) {
      console.error('[resume-wait] desktop continuation intersection failed; cancelling desktop turn:', error);
      try { turns?.blockCurrent(owner); } catch (cancelError) { console.error('[resume-wait] desktop turn cancellation failed:', cancelError); }
    }
  };
  const alerted = new Set<string>();
  let service!: ResumeWaitService;
  const env = {
    now: () => Date.now(),
    desktopEpoch: (owner: string) => {
      if (!ctx.desktopEpochs) throw new Error('Host desktop epoch service unavailable');
      return ctx.desktopEpochs.currentBinding(owner);
    },
    recordDesktopSource: (wait: ResumeWait) => {
      if (!ctx.desktopTurns) return;
      const scheduler = wait.owner.startsWith('orchestrator:');
      const source = scheduler ? currentSchedulerDesktopExecutionTurn() : currentGuiExecutionTurn();
      const sourceOwner = source?.sessionId;
      const desktopTurnId = source?.desktopTurnId;
      const current = source?.isDesktopCurrent;
      // No trustworthy GUI/scheduler tool snapshot (including PTY) is not authorization.
      if (!desktopTurnId || sourceOwner !== wait.owner || typeof current !== 'function') return;
      const captured = ctx.desktopTurns().captureContinuation(wait.owner, desktopTurnId, wait.workspaceId, current);
      if (!captured) return;
      return captured.then(origin => {
        if (!origin || disposed) return;
        const sources = getDesktopSources();
        if (!sources) throw new Error('Desktop continuation storage is unavailable');
        sources.record(wait, origin);
      });
    },
    cleanupDesktopSources: () => {
      if (!ctx.desktopTurns || Date.now() < nextDesktopSourceCleanup) return;
      nextDesktopSourceCleanup = Date.now() + 60_000;
      if (!desktopSources && !fs.existsSync(desktopSourceFile)) return;
      getDesktopSources()?.pruneRemoved(store);
    },
    isBusy: (owner: string) => isBusy(ctx, owner),
    alert: async (wait: ResumeWait, reason: string, kind?: 'queued') => {
      const category = kind ?? (reason.includes('七天') ? 'expired' : reason.includes('未确认') ? 'uncertain' : 'delivery');
      const key = `${wait.id}:${category}`;
      if (alerted.has(key)) return;
      ctx.notify.push({ workspaceId: wait.workspaceId, sessionId: wait.owner, sessionName: '续接等待',
        label: category === 'queued' ? '续接已排队' : '续接未确认',
        text: category === 'queued' ? `抢占不可用，已排队到回合边界投递（${wait.id}）` : `${reason}（${wait.id}）`,
        update: true, updateKey: `resume-wait:${wait.id}`, toast: true });
      await runOutsideAgentScope(() => deliverAgentMessage(ctx, { from: 'host', to: `orchestrator:${wait.workspaceId}`,
        workspaceId: wait.workspaceId, idempotencyKey: `resume-wait-dead:${key}`,
        text: category === 'expired' ? `续接 ${wait.id} 已过期超过七天，记录将被清理。`
          : category === 'queued' ? `续接 ${wait.id} 抢占不可用，已排队到回合边界投递；回合结束后会正常送达，无需重复执行。`
          : `续接 ${wait.id} 未完成；请核对目标会话和回执，避免重复执行。` }));
      alerted.add(key);
    },
    deliver: async (wait: ResumeWait, rawContent: string, deliveryId: string, batch: readonly ResumeWait[]) => {
      const scheduler = wait.owner.startsWith('orchestrator:');
      const session = scheduler ? undefined : ctx.sessions.get(wait.owner);
      const gui = !!session && ctx.sessions.isChatRuntime(session.runtime);
      if (scheduler ? !ctx.orchestrator : !session || session.archived || session.launchKind === 'shell')
        return { status: 'deferred' as const, reason: '等待所属的受管会话已不可用' };
      if (session && !gui && !session.archived && !ctx.sessions.getCliWorkspaceContext(wait.owner) && !ctx.pty.isRunning(wait.owner)) {
        // Restore the same managed session's normal input binding after a restart.
        try { await ctx.sessions.respawn(wait.owner); }
        catch (error) { return { status: 'deferred' as const, reason: `恢复会话失败：${(error as Error).message}` }; }
      }
      let stoppedTurn: string | undefined;
      const sources = ctx.desktopTurns ? getDesktopSources() : undefined;
      const desktopContinuation = sources ? bindDesktopContinuationDelivery(sources, batch, store, wait.owner, wait.workspaceId,
        { pending: () => service.desktopSourcesPending(batch), ready: () => service.awaitDesktopSources(batch),
          currentBinding: () => {
            if (!ctx.desktopEpochs) throw new Error('Host desktop epoch service unavailable');
            return ctx.desktopEpochs.continuationBinding
              ? ctx.desktopEpochs.continuationBinding(wait.owner) : ctx.desktopEpochs.currentBinding(wait.owner);
          } })
        : Object.freeze({ allows: () => false });
      const content = wait.snapshot ? `${rawContent}\n\n[被抢占工作续接]\n${wait.snapshot}` : rawContent;
      const stillNeeded = () => {
        const current = store.get(wait.id);
        return current?.state === 'delivering' && current.deliveryId === deliveryId;
      };
      const delivery: HostNotificationDelivery = {
        desktopContinuation,
        prepare: () => stillNeeded()
          ? { ids: [deliveryId], summary: '等待条件已触发', content } : null,
        accepted: () => {},
        started: () => { service.acknowledge(wait.owner, deliveryId); }
      };
      const wake = async (text: string): Promise<DeliveryAttempt> => {
        if (scheduler) {
          const accepted = await sendMailboxWake(ctx, wait.owner, wait.workspaceId, '', deliveryId, stillNeeded, delivery);
          return accepted ? { status: 'submitted' } : { status: 'deferred', reason: '调度暂未空闲或未获准入' };
        }
        if (!gui) {
          const result = await deliverMailboxNotice(ctx, wait.owner, wait.workspaceId, text, deliveryId,
            stillNeeded, { intent: 'normal' });
          // CLI acknowledgement is transport acceptance, including a native queue.
          // It does not prove execution; replaying an accepted input would duplicate it.
          if (result.status === 'accepted') return { status: 'confirmed' };
          return result;
        }
        const session = ctx.sessions.get(wait.owner), host = ctx.agentSessions;
        if (!session || !host || session.archived) return { status: 'deferred', reason: '会话已不可用' };
        if (!host.isOpen(wait.owner)) host.open(session);
        if (!stillNeeded()) return { status: 'deferred', reason: '续接已由其他回执确认' };
        const result = await host.send(wait.owner, text, undefined,
          { host: true, messageId: deliveryId, requireIdle: true, desktopContinuation });
        return result.ok ? { status: 'submitted' } : { status: 'deferred', reason: result.error || '会话暂未接受输入' };
      };
      return deliverSession({
        capabilities: preemptionCapabilities(ctx, wait.owner),
        isBusy: () => isBusy(ctx, wait.owner),
        wake: async text => wake(text),
        interject: async () => {
          if (scheduler) {
            if (!ctx.orchestrator) return { status: 'unsupported', reason: '调度宿主不可用' };
            if (isSchedulerWaitingOnHuman(ctx, wait.workspaceId)) return { status: 'deferred', reason: '调度正等待用户处理审批或提问' };
            const accepted = await ctx.orchestrator.interjectHostNotification(wait.workspaceId, {
              ...delivery, beforeSubmit: () => {
                let turn: string | undefined;
                try { turn = ctx.orchestrator?.buckets?.get(wait.workspaceId)?.desktopTurnId; }
                catch (error) { console.error('[resume-wait] desktop turn lookup failed; cancelling desktop turn:', error); }
                intersectDesktop(wait.owner, turn, wait.workspaceId, desktopContinuation);
              }, accepted: () => { service.acknowledge(wait.owner, deliveryId); }
            });
            return accepted ? { status: 'confirmed' } : { status: 'unsupported', reason: '原生插话不可用' };
          }
          if (gui) {
            const entry = ctx.agentSessions?.entries.get(wait.owner);
            const connection = entry?.connection;
            if (!stillNeeded() || !entry?.busy || !connection?.receiveMessage)
              return { status: 'unsupported', reason: '会话没有可用的原生插话通道' };
            if (entry.activeApproval || entry.activeUserQuestion || entry.forkSettlement)
              return { status: 'deferred', reason: '会话正在处理用户决策或分叉' };
            const turn = entry.activeExecutionTurnId;
            entry.nativeDeliveryInFlight = (entry.nativeDeliveryInFlight ?? 0) + 1;
            try {
              intersectDesktop(wait.owner, entry.activeDesktopTurnId, wait.workspaceId, desktopContinuation);
              // External event material goes directly through the trusted hidden
              // host channel; it must not pass user-input skill expansion.
              const result = parseRuntimeDeliveryResult(await connection.receiveMessage({ intent: 'interrupt',
                text: content, messageId: deliveryId, hostNotification: true }));
              if (entry.connection !== connection || entry.activeExecutionTurnId !== turn)
                return { status: 'uncertain', reason: '插话期间会话或回合已变化' };
              return result.status === 'accepted' ? result.method === 'steered'
                ? { status: 'confirmed' } : { status: 'submitted' } : result;
            } finally { entry.nativeDeliveryInFlight = Math.max(0, (entry.nativeDeliveryInFlight ?? 1) - 1); }
          }
          const result = await deliverMailboxNotice(ctx, wait.owner, wait.workspaceId, content, deliveryId,
            stillNeeded, { intent: 'interrupt', nativeOnly: true });
          if (result.status === 'accepted') return result.method === 'steered' || result.method === 'sent'
            ? { status: 'confirmed' } : { status: 'submitted' };
          return result;
        },
        snapshot: async () => {
          const captured = snapshot(ctx, wait);
          stoppedTurn = captured.turnId;
          const managed = await ctx.sessions.captureManagedInterruptSnapshot(wait.owner, Date.now(), captured.text);
          if (ctx.agentSessions?.entries.get(wait.owner)?.activeExecutionTurnId !== stoppedTurn)
            throw new Error('捕获快照期间回合已变化，未发送中断');
          const text = managed.brief;
          store.saveSnapshot(wait.id, deliveryId, text);
          return text;
        },
        interrupt: async () => {
          const host = ctx.agentSessions, entry = host?.entries.get(wait.owner);
          if (!stillNeeded() || !host || !entry || !entry.busy || entry.activeExecutionTurnId !== stoppedTurn)
            return { status: 'deferred', reason: '捕获快照后回合已变化，未发送中断' };
          if (entry.activeApproval || entry.activeUserQuestion)
            return { status: 'deferred', reason: '会话正在等待用户处理审批或提问，未发送中断' };
          await host.abort(wait.owner);
          if (entry.busy || entry.abortError) return { status: 'uncertain', reason: entry.abortError || '未确认原回合停止' };
          return { status: 'confirmed' };
        },
        // The ready wait itself is the durable queue; no second queue can lose it.
        queue: async () => {}
      }, content, { priority: wait.failures >= 2 ? 'preempt' : wait.priority, deliveryId });
    }
  };
  service = new ResumeWaitService(store, env);
  ctx.resumeWait = service;
  const cancelUnavailable = (wait: ResumeWait): void => {
    const ownerWorkspaceId = wait.owner.startsWith('orchestrator:') ? wait.owner.slice('orchestrator:'.length) : wait.workspaceId;
    const workspaceExists = ctx.workspaces.list().some(workspace => workspace.id === ownerWorkspaceId);
    const session = wait.owner.startsWith('orchestrator:') ? undefined : ctx.sessions.get(wait.owner);
    const unavailable = !workspaceExists || (!wait.owner.startsWith('orchestrator:') &&
      (!session || session.archived || session.launchKind === 'shell'));
    if (unavailable) store.cancel(wait.id, '等待所属的受管会话已不可用');
  };
  // A wait can outlive an archived/deleted Worker. Retire those records before
  // the first startup tick so they cannot become a recurring failure toast.
  for (const wait of store.pending()) cancelUnavailable(wait);
  let scheduled = false;
  const request = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (disposed) return;
      try { service.events(log); scanSessions(); }
      catch (error) { console.error('[resume-wait] scan failed', error); }
      void service.tick().catch(error => console.error('[resume-wait] delivery failed', error));
    });
  };
  const scanSessions = () => {
    for (const wait of store.pending()) {
      if (wait.state !== 'armed' || wait.condition.kind !== 'session') continue;
      const state = watchedSession(ctx, wait.condition.sessionId);
      if (wait.condition.phase === 'needs_you' && state.phase === 'needs_you') service.session(state.sessionId, 'needs_you', state);
      if (wait.condition.phase === 'idle' && !state.missing && state.busy === false && state.lifecycle === 'idle') service.session(state.sessionId, 'idle', state);
    }
  };
  const scanMail = () => {
    for (const { root, workspaceId } of mailboxStores(ctx)) {
      for (const message of readAgentMessageLedger(root, workspaceId).messages) if (!message.read) service.mail(workspaceId, message);
    }
  };
  const off = [onAgentMessageAppended((ws, message) => { service.mail(ws, message); request(); }),
    ctx.sessions.onLifecycle((session) => {
      if (session.archived || session.launchKind === 'shell') {
        for (const wait of store.pending(session.id)) cancelUnavailable(wait);
      }
      request();
    }),
    ctx.sessions.onSessionRemoved((session) => {
      for (const wait of store.pending(session.id)) cancelUnavailable(wait);
      request();
    }),
    ctx.sessions.onPhaseFlip(() => request()),
    ctx.eventRouter!.onPublished(() => request()),
    ctx.orchestrator?.onEvent(channel => { if (channel === 'agent:done') request(); }) ?? (() => {})];
  const timer = setInterval(request, 1000);
  timer.unref?.();
  refreshers.set(ctx, () => { scanMail(); request(); });
  scanMail(); request();
  return () => {
    disposed = true; clearInterval(timer); for (const unsubscribe of off) unsubscribe();
    refreshers.delete(ctx);
    if (ctx.resumeWait === service) delete ctx.resumeWait;
    desktopSources?.close();
    store.close();
  };
}
