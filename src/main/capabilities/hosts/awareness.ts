/**
 * 运行时状态流：sessions.observe（内置字段只读）+ events.subscribe/unsubscribe（持续查询）
 * + share.set（摘要发布，读取归 sessions.observe）
 * + events.register / review / emit（自定义事件注册/审核/发射）。
 */
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import { isConfirmed } from '../../../shared/confirmDialog';
import { isSchedulerInvocation, runAsAgentWorkspace, runAsSchedulerTool } from '../../agent/agentScope';
import { getEventRegistry } from '../../awareness/eventRegistry';
import { dispatchRuntimeFacts } from '../../awareness/dispatch';
import { matchesEvent } from '../../awareness/eventRouter';
import {
  applyEventReview,
  authorizeEventEmit,
  authorizeEventReview,
  customEventKind,
  decideEventEmit,
  isEventReviewDecision,
  normalizeEventId,
  normalizeEventText,
  parseEventIdFromKind,
  projectCustomEventFact,
  type EventRegistration
} from '../../../shared/runtimeEvents';
import { isCustomEventKind } from '../../../shared/runtimeFacts';
import {
  lastActivityAt,
  judgePipelineWorker,
  normalizePipelineStallMs,
  sessionActivityParts,
  type PipelineWorkerFacts
} from '../../../shared/pipelineStatus';
import {
  isOrchestratorSessionId,
  normalizeFactQuery,
  normalizeShareText,
  parseOrchestratorWorkspaceId,
  queryFacts,
  resolveAwarenessActorId,
  resolveShareWriter,
  type RuntimeFact
} from '../../../shared/runtimeFacts';
import {
  FACT_SUBSCRIBE_MAX_PER_SESSION,
  normalizeSubscribeQuery
} from '../../../shared/runtimeFactsSubscribe';
import {
  projectSessionFacts,
  type GitFactInput,
  type SessionFactInput
} from '../../../shared/runtimeFactsQuery';
import { collectPipelineGitFacts } from '../../git/pipelineFacts';
import { ACTOR_SESSION_ID_ARG, resolveToolActor, resolveActorControlRoot } from './actors';

function requireAwareness(ctx: AppContext) {
  if (!ctx.awareness) throw new Error(t('运行时状态流未就绪'));
  return ctx.awareness;
}

/** Worker 注入会话，或调度调用链解析为 orchestrator:<workspaceId>。 */
function awarenessActorId(ctx: AppContext, args?: Record<string, unknown>): string {
  return resolveAwarenessActorId({
    injectedSessionId:
      typeof args?.[ACTOR_SESSION_ID_ARG] === 'string' ? args[ACTOR_SESSION_ID_ARG] : '',
    isScheduler: isSchedulerInvocation(),
    workspaceId: ctx.resolveBubbleWorkspaceId?.()
  });
}

function requireAwarenessSession(
  ctx: AppContext,
  actorId: string
): { id: string; workspaceId?: string; name?: string } {
  if (isOrchestratorSessionId(actorId)) {
    const wsId = parseOrchestratorWorkspaceId(actorId);
    const ws = ctx.workspaces.list().find((w) => w.id === wsId);
    if (!wsId || !ws) throw new Error(t('会话不存在: {{id}}', { id: actorId }));
    return { id: actorId, workspaceId: wsId, name: t('调度') };
  }
  const session = ctx.sessions.get(actorId);
  if (!session) throw new Error(t('会话不存在: {{id}}', { id: actorId }));
  return session;
}

function eventRoot(ctx: AppContext, args?: Record<string, unknown>): string {
  return resolveActorControlRoot(ctx, args);
}

export function assertApprovedSubscribeKinds(ctx: AppContext, args: Record<string, unknown> | undefined): void {
  const query = normalizeSubscribeQuery(args);
  const custom = (query.kinds ?? []).filter(isCustomEventKind);
  if (!custom.length) return;
  const root = eventRoot(ctx, args);
  const registry = getEventRegistry();
  for (const kind of custom) {
    const id = parseEventIdFromKind(kind);
    if (!registry.isApprovedKind(root, id)) {
      throw new Error(t('事件未批准，不能订阅：{{id}}', { id }));
    }
  }
}

function notifyEventPending(ctx: AppContext, entry: EventRegistration, sessionName: string): void {
  if (!ctx.notify?.push) return;
  const workspaceId = entry.workspaceId || ctx.resolveBubbleWorkspaceId?.() || '';
  if (!workspaceId) return;
  ctx.notify.push({
    workspaceId,
    sessionId: entry.proposerSessionId,
    sessionName,
    text: t('自定义事件「{{id}}」待审核：{{description}}', {
      id: entry.id,
      description: entry.description
    }),
    label: t('事件待审'),
    toast: true
  });
}

async function applyHumanConfirm(
  ctx: AppContext,
  root: string,
  entry: EventRegistration
): Promise<EventRegistration> {
  if (!ctx.ui?.confirm) return entry;
  const gate = await ctx.ui.confirm(
    t('审核自定义事件：{{id}}', { id: entry.id }),
    t('描述：{{description}}\n理由：{{why}}\n提出方：{{who}}', {
      description: entry.description,
      why: entry.why,
      who: entry.proposerSessionId
    }),
    {
      dangerous: true,
      intent: t('批准后他人可订，提出方可发射'),
      summary: `${entry.id}: ${entry.description}`,
      confirmLabel: t('批准事件'),
      cancelLabel: t('拒绝事件')
    }
  );
  const latest = getEventRegistry().get(root, entry.id);
  if (!latest || latest.status !== 'pending') return latest ?? entry;
  if (isConfirmed(gate)) {
    return getEventRegistry().save(
      root,
      applyEventReview(latest, 'approve', { role: 'human' }, Date.now()),
      'pending'
    );
  }
  if (gate && typeof gate === 'object' && (gate.cancelledBy === 'timeout' || gate.cancelledBy === 'backdrop')) {
    return latest;
  }
  return getEventRegistry().save(
    root,
    applyEventReview(latest, 'reject', { role: 'human' }, Date.now()),
    'pending'
  );
}

function toSessionInput(s: {
  id: string;
  name?: string;
  workspaceId?: string;
  phase?: { value: string; ts?: number };
  liveStatus?: { label: string; ts?: number };
  activity?: { kind: string; event?: string; ts?: number };
  lifecycle?: string;
  archived?: boolean;
  worktreePath?: string;
  worktreeBranch?: string;
}): SessionFactInput {
  return {
    id: s.id,
    name: s.name,
    workspaceId: s.workspaceId,
    phase: s.phase,
    note: s.liveStatus,
    activity: s.activity,
    lifecycle: s.lifecycle,
    archived: s.archived,
    worktreePath: s.worktreePath,
    worktreeBranch: s.worktreeBranch
  };
}

export const awarenessHost = {

  'events.subscribe': (ctx: AppContext, args?: Record<string, unknown>): Record<string, unknown> | Promise<Record<string, unknown>> => {
    const store = requireAwareness(ctx);
    const actorId = awarenessActorId(ctx, args);
    if (!actorId) throw new Error(t('events.subscribe 需要会话身份（Worker 只订自己）'));
    const subject = typeof args?.subject === 'string' && args.subject.trim() ? args.subject.trim() : actorId;
    if (subject !== actorId && !isSchedulerInvocation()) {
      const actor = requireAwarenessSession(ctx, actorId);
      const target = requireAwarenessSession(ctx, subject);
      const actorWorkspaceId = actor.workspaceId, targetWorkspaceId = target.workspaceId;
      if (!ctx.ui?.confirm) throw new Error('Cross-session subscription needs human review; ask the scheduler');
      if (!actorWorkspaceId) throw new Error('Actor workspace is unavailable');
      const snapshot = structuredClone(args ?? {});
      delete snapshot[ACTOR_SESSION_ID_ARG];
      snapshot.subject = subject;
      const details = JSON.stringify(snapshot);
      if (details.length > 4000) throw new Error('Subscription request is too large');
      return ctx.ui.confirm(t('审核跨会话事件订阅'), t('提出方：{{actor}}\n目标：{{subject}}\n参数：{{details}}', { actor: actorId, subject, details }), {
        dangerous: true, intent: t('批准后为目标会话建立订阅'), confirmLabel: t('批准订阅'), cancelLabel: t('拒绝')
      }).then(result => {
        if (!isConfirmed(result)) throw new Error('Cross-session subscription was not approved');
        if (requireAwarenessSession(ctx, actorId).workspaceId !== actorWorkspaceId ||
            requireAwarenessSession(ctx, subject).workspaceId !== targetWorkspaceId) throw new Error('Session workspace changed during review');
        return runAsAgentWorkspace(actorWorkspaceId, () => runAsSchedulerTool(async () =>
          awarenessHost['events.subscribe'](ctx, snapshot)));
      });
    }
    const session = requireAwarenessSession(ctx, subject);
    if (args?.source !== undefined) {
      const log = ctx.eventRouter?.log;
      if (!log) throw new Error('Event log is unavailable');
      log.prune();
      const source = typeof args.source === 'string' ? args.source.trim() : '';
      if (!['gitlab', 'github', 'file', 'time', 'phase', 'fact', 'intent', 'reminder'].includes(source)) throw new Error('Event source is not registered and approved');
      if (args.q !== undefined || args.kinds !== undefined || args.sessionId !== undefined || args.workspaceId !== undefined) throw new Error('Fact query filters cannot be used with source subscriptions');
      if (args.path !== undefined && (source !== 'file' || typeof args.path !== 'string' || !args.path.trim() || args.path.length > 512 || args.path.includes('\\'))) throw new Error('path requires a file source and a nonempty slash-separated pattern of at most 512 characters');
      const pathPattern = typeof args.path === 'string' ? args.path.trim() : undefined;
      const types = args.types === undefined ? [] : args.types;
      if (!Array.isArray(types) || types.length > 20 || types.some(x => typeof x !== 'string' || !x.trim() || x.length > 100)) throw new Error('types must be an array of up to 20 nonempty strings');
      if (source === 'fact' && types.length) assertApprovedSubscribeKinds(ctx, { ...args, workspaceId: session.workspaceId, kinds: types });
      let scope = typeof args.scope === 'string' ? args.scope.trim() : '';
      if (args.projectId !== undefined) {
        if (source !== 'gitlab' || typeof args.projectId !== 'number' || !Number.isSafeInteger(args.projectId) || args.projectId < 1) throw new Error('projectId must be a positive GitLab project ID');
        if (scope && scope !== String(args.projectId)) throw new Error('scope and projectId disagree');
        scope = String(args.projectId);
      }
      if (scope.length > 300) throw new Error('scope is too long');
      const mode = args.mode === undefined ? 'instant' : args.mode;
      if (mode !== 'instant' && mode !== 'digest') throw new Error('mode must be instant or digest');
      const rateLimit = args.rateLimit === undefined ? 20 : args.rateLimit;
      if (typeof rateLimit !== 'number' || !Number.isSafeInteger(rateLimit) || rateLimit < 1 || rateLimit > 20) throw new Error('rateLimit must be an integer from 1 to 20 per hour');
      const expiresAt = args.expiresAt === undefined ? null : args.expiresAt;
      if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) throw new Error('expiresAt must be a future timestamp');
      if (!session.workspaceId) throw new Error('subscriber workspace is unavailable');
      if (log.subscriptions(subject).length + store.listSubscriptions(subject).length >= FACT_SUBSCRIBE_MAX_PER_SESSION) throw new Error('Subscription limit reached');
      const subscription = log.subscribe({ subject, workspaceId: session.workspaceId, source, types: types as string[], scope, mode, ...(pathPattern ? { pathPattern } : {}),
        createdAt: Date.now(), expiresAt, rateLimit });
      return { ok: true, subscription, subscriptions: log.subscriptions(subject) };
    }
    const query = normalizeSubscribeQuery(args);
    if (!query.workspaceId) {
      const workspaceId = session.workspaceId?.trim();
      if (!workspaceId) throw new Error('subscriber workspace is unavailable');
      query.workspaceId = workspaceId;
    }
    assertApprovedSubscribeKinds(ctx, { ...args, workspaceId: session.workspaceId });
    if (store.listSubscriptions(subject).length + (ctx.eventRouter?.log.subscriptions(subject).length ?? 0) >= FACT_SUBSCRIBE_MAX_PER_SESSION) {
      throw new Error(t('本会话订阅数已达上限（{{max}}）', { max: FACT_SUBSCRIBE_MAX_PER_SESSION }));
    }
    const added = store.addSubscription({ subscriberSessionId: subject, query });
    if ('ok' in added && added.ok === false) {
      throw new Error(t('本会话订阅数已达上限（{{max}}）', { max: FACT_SUBSCRIBE_MAX_PER_SESSION }));
    }
    return {
      ok: true,
      subscription: added,
      subscriptions: store.listSubscriptions(subject)
    };
  },

  'events.unsubscribe': (ctx: AppContext, args?: Record<string, unknown>) => {
    const store = requireAwareness(ctx);
    const actorId = awarenessActorId(ctx, args);
    if (!actorId) throw new Error(t('events.unsubscribe 需要会话身份（Worker 只订自己）'));
    const id = typeof args?.id === 'string' ? args.id.trim() : '';
    if (!id) throw new Error(t('需要 id（events.unsubscribe）'));
    const external = ctx.eventRouter?.log.subscriptions().find(s => s.id === id);
    if (external) {
      if (external.subject !== actorId && !isSchedulerInvocation()) throw new Error('Cannot modify another session subscription');
      ctx.eventRouter!.log.unsubscribe(id, external.subject);
      return { ok: true, id };
    }
    const existing = store.getSubscription(id);
    if (!existing) throw new Error(t('订阅不存在：{{id}}', { id }));
    if (!store.removeSubscription(id, isSchedulerInvocation() ? existing.subscriberSessionId : actorId)) {
      throw new Error(t('不能改其他会话的订阅'));
    }
    return { ok: true, id, subscriptions: store.listSubscriptions(actorId) };
  },

  'events.list': (ctx: AppContext, args?: Record<string, unknown>) => {
    const actorId = awarenessActorId(ctx, args);
    const log = ctx.eventRouter?.log;
    if (!actorId || !log) throw new Error('Event log or actor unavailable');
    const subject = typeof args?.subject === 'string' && args.subject.trim() ? args.subject.trim() : actorId;
    if (subject !== actorId && !isSchedulerInvocation()) throw new Error('Cannot inspect another session subscription');
    const subscriptions = log.subscriptions(subject);
    const subId = typeof args?.subscriptionId === 'string' ? args.subscriptionId : '';
    if (!subId) return { subscriptions: [...requireAwareness(ctx).listSubscriptions(subject), ...subscriptions] };
    const sub = subscriptions.find(s => s.id === subId);
    if (!sub || sub.expiresAt !== null && sub.expiresAt <= Date.now()) throw new Error('Subscription unavailable');
    const after = args?.after === undefined ? sub.startCursor : args.after;
    if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < sub.startCursor) throw new Error('Invalid cursor');
    const since = args?.since, until = args?.until;
    if ((since !== undefined && typeof since !== 'number') || (until !== undefined && typeof until !== 'number')) throw new Error('Invalid time window');
    const rows = log.list({ after, source: sub.source, limit: 100, ...(since === undefined ? {} : { since }), ...(until === undefined ? {} : { until }) });
    const events: typeof rows = [];
    let cursor = after;
    for (const event of rows) {
      if (matchesEvent(sub, event, log)) {
        if (JSON.stringify([...events, event]).length > 7000) {
          if (!events.length) throw new Error('Event metadata exceeds response budget');
          break;
        }
        events.push(event);
      }
      cursor = event.sequence;
    }
    const claimsAfter = args?.claimsAfter === undefined ? 0 : args.claimsAfter;
    if (typeof claimsAfter !== 'number' || !Number.isSafeInteger(claimsAfter) || claimsAfter < 0) throw new Error('Invalid claims cursor');
    const claims = isSchedulerInvocation() && sub.subject.startsWith('system:intent:') ? log.launchClaims(sub.id, claimsAfter) : [];
    return { events, nextCursor: rows.length && (cursor < rows[rows.length - 1]!.sequence || rows.length === 100) ? cursor : null,
      ...(claims.length ? { launchClaims: claims.slice(0, 20), claimsNext: claims.length > 20 ? claims[19]!.sequence : null } : {}) };
  },

  'events.resolveLaunch': async (ctx: AppContext, args?: Record<string, unknown>) => {
    if (!isSchedulerInvocation()) throw new Error('Only the scheduler can resolve an uncertain launch');
    const router = ctx.eventRouter;
    const id = typeof args?.subscriptionId === 'string' ? args.subscriptionId : '';
    const sequence = args?.sequence;
    const action = args?.action;
    if (!router || !id || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || (action !== 'retry' && action !== 'complete')) throw new Error('Invalid launch resolution');
    const sub = router.log.subscriptions().find(item => item.id === id && item.subject.startsWith('system:intent:'));
    if (!sub) throw new Error('Managed subscription unavailable');
    if (router.isDelivering(id, sequence)) throw new Error('Launch is still in progress');
    if (action === 'retry') {
      if (!ctx.ui?.confirm) throw new Error('Human confirmation is unavailable');
      const result = await ctx.ui.confirm(t('重试不确定的事件处理'), t('处理可能已经发生；请先检查运行或通知记录。重试可能再次执行。'), { dangerous: true, confirmLabel: t('确认重试'), cancelLabel: t('取消') });
      if (!isConfirmed(result)) throw new Error('Retry was not confirmed');
    }
    if (router.isDelivering(id, sequence)) throw new Error('Launch is still in progress');
    if (!router.log.resolveLaunch(id, sequence, action)) throw new Error('No uncertain launch at this sequence');
    void router.replay().catch(error => console.error('[events] launch resolution replay failed', error));
    return { ok: true, subscriptionId: id, sequence, action };
  },

  'events.read': (ctx: AppContext, args?: Record<string, unknown>) => {
    const actorId = awarenessActorId(ctx, args);
    const log = ctx.eventRouter?.log;
    if (!actorId || !log) throw new Error('Event log or actor unavailable');
    const subject = typeof args?.subject === 'string' && args.subject.trim() ? args.subject.trim() : actorId;
    if (subject !== actorId && !isSchedulerInvocation()) throw new Error('Cannot inspect another session subscription');
    const id = typeof args?.id === 'string' ? args.id : '';
    const event = log.get(id);
    const authorized = event && log.subscriptions(subject).some(sub => (!sub.expiresAt || sub.expiresAt > Date.now()) && matchesEvent(sub, event, log));
    if (!event || !authorized) throw new Error('Event is unavailable or not authorized');
    const offset = args?.offset === undefined ? 0 : args.offset;
    const length = args?.length === undefined ? 4000 : args.length;
    if (typeof offset !== 'number' || typeof length !== 'number' || length > 5000) throw new Error('Invalid payload page');
    let size = length;
    let result = { event, ...log.payload(id, offset, size), untrusted: true };
    while (JSON.stringify(result).length > 8500 && size > 1) {
      size = Math.max(1, Math.floor(size / 2));
      result = { event, ...log.payload(id, offset, size), untrusted: true };
    }
    if (JSON.stringify(result).length > 8500) throw new Error('Event metadata exceeds response budget');
    return result;
  },

  'share.set': (ctx: AppContext, args?: Record<string, unknown>) => {
    const store = requireAwareness(ctx);
    const actorId = awarenessActorId(ctx, args);
    const requested = typeof args?.sessionId === 'string' ? args.sessionId : '';
    const writer = resolveShareWriter(actorId, requested);
    if (!writer.ok) {
      if (writer.code === 'not_actor') throw new Error(t('share.set 需要会话身份（Worker 只写自己）'));
      throw new Error(t('不能写其他会话的状态共享栏'));
    }
    const text = normalizeShareText(args?.text);
    if (!text.ok) {
      if (text.code === 'too_long') throw new Error(t('状态共享栏超过 500 字'));
      throw new Error(t('需要 text（状态共享栏正文，空串=清空）'));
    }
    const session = requireAwarenessSession(ctx, writer.sessionId);
    const entry = store.setShare({
      sessionId: writer.sessionId,
      workspaceId: session.workspaceId,
      sessionName: session.name,
      text: text.text,
      updatedAt: Date.now()
    });
    return { ok: true, entry };
  },

  'events.register': async (ctx: AppContext, args?: Record<string, unknown>) => {
    const actorId = awarenessActorId(ctx, args);
    if (!actorId) throw new Error(t('events.register 需要会话身份（提出方）'));
    const idRes = normalizeEventId(args?.id);
    if (!idRes.ok) {
      if (idRes.code === 'reserved') throw new Error(t('事件 id 与内置事实种类冲突：{{id}}', { id: String(args?.id ?? '') }));
      if (idRes.code === 'empty') throw new Error(t('需要 id（events.register）'));
      throw new Error(t('事件 id 不合法（小写字母开头，字母数字连字符 ≤48）: {{id}}', { id: String(args?.id ?? '') }));
    }
    const desc = normalizeEventText(args?.description);
    if (!desc.ok) {
      if (desc.code === 'too_long') throw new Error(t('description 超过 500 字'));
      throw new Error(t('description 不能为空'));
    }
    const why = normalizeEventText(args?.why);
    if (!why.ok) {
      if (why.code === 'too_long') throw new Error(t('why 超过 500 字'));
      throw new Error(t('why 不能为空'));
    }
    const session = requireAwarenessSession(ctx, actorId);
    const root = eventRoot(ctx, args);
    const registry = getEventRegistry();
    // F-06：判重→落盘走 (root,id) 串行临界区——同 id 并发注册时后到方在链上排队，
    // 看到先写结果（existed:true），而不是互相覆盖、双方都返回 ok
    const outcome = await registry.registerSerialized(root, idRes.id, (existing) => {
      if (existing && existing.status !== 'rejected') {
        return { created: false as const, event: existing };
      }
      const extraEmitters = Array.isArray(args?.emitters)
        ? (args.emitters as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
      const emitters = [...new Set([actorId, ...extraEmitters.map((s) => s.trim())])];
      const entry: EventRegistration = {
        id: idRes.id,
        description: desc.text,
        why: why.text,
        status: 'pending',
        proposerSessionId: actorId,
        emitters,
        createdAt: Date.now(),
        workspaceId: session.workspaceId
      };
      registry.register(root, entry);
      notifyEventPending(ctx, entry, session.name ?? actorId);
      return { created: true as const, event: entry };
    });
    if (!outcome.created) {
      return { ok: true, event: outcome.event, existed: true };
    }
    const reviewed = await applyHumanConfirm(ctx, root, outcome.event);
    return { ok: true, event: reviewed, kind: customEventKind(reviewed.id) };
  },

  'events.review': (ctx: AppContext, args?: Record<string, unknown>) => {
    const actor = resolveToolActor(args);
    const idRes = normalizeEventId(args?.id);
    if (!idRes.ok) throw new Error(t('需要 id（events.review）'));
    if (!isEventReviewDecision(args?.decision)) {
      throw new Error(t('decision 须为 approve 或 reject'));
    }
    const root = eventRoot(ctx, args);
    const registry = getEventRegistry();
    const existing = registry.get(root, idRes.id);
    if (!existing) throw new Error(t('事件不存在：{{id}}', { id: idRes.id }));
    if (existing.status !== 'pending') {
      throw new Error(t('事件已关闭或已审过：{{id}}', { id: idRes.id }));
    }
    const auth = authorizeEventReview({
      actorRole: actor.role,
      actorId: actor.role === 'worker' ? actor.id : undefined,
      proposerSessionId: existing.proposerSessionId,
      isScheduler: isSchedulerInvocation()
    });
    if (!auth.ok) {
      if (auth.code === 'self') throw new Error(t('Worker 不能审核自己注册的事件'));
      throw new Error(t('Worker 不能审核自定义事件（人或调度审）'));
    }
    const next = applyEventReview(
      existing,
      args.decision,
      { role: auth.role, sessionId: actor.role === 'worker' ? actor.id : undefined },
      Date.now()
    );
    registry.save(root, next, existing.status);
    return { ok: true, event: next };
  },

  'events.emit': async (ctx: AppContext, args?: Record<string, unknown>) => {
    const actorId = awarenessActorId(ctx, args);
    if (!actorId) throw new Error(t('events.emit 需要会话身份（登记发射方）'));
    const idRes = normalizeEventId(args?.id);
    if (!idRes.ok) throw new Error(t('需要 id（events.emit）'));
    const root = eventRoot(ctx, args);
    const registry = getEventRegistry();
    const existing = registry.get(root, idRes.id);
    const auth = authorizeEventEmit(existing, actorId);
    if (!auth.ok) {
      if (auth.code === 'missing') throw new Error(t('事件不存在：{{id}}', { id: idRes.id }));
      if (auth.code === 'pending') throw new Error(t('事件尚未批准，不能发射：{{id}}', { id: idRes.id }));
      if (auth.code === 'rejected') throw new Error(t('事件已拒绝，不能发射：{{id}}', { id: idRes.id }));
      if (auth.code === 'not_emitter') throw new Error(t('不是该事件的登记发射方'));
      throw new Error(t('事件未批准，不能发射：{{id}}', { id: idRes.id }));
    }
    const decided = decideEventEmit(idRes.id, actorId, registry.emitLedger, Date.now());
    if (!decided.ok) {
      if (decided.reason === 'debounce') throw new Error(t('发射过快，请稍后再试'));
      throw new Error(t('发射已达每小时上限（{{max}}）', { max: 20 }));
    }
    const session = isOrchestratorSessionId(actorId)
      ? requireAwarenessSession(ctx, actorId)
      : ctx.sessions.get(actorId);
    const summary = typeof args?.summary === 'string' ? args.summary : undefined;
    const paths = Array.isArray(args?.paths)
      ? (args.paths as unknown[]).filter((p): p is string => typeof p === 'string')
      : undefined;
    const data =
      args?.data && typeof args.data === 'object' && !Array.isArray(args.data)
        ? (args.data as Record<string, unknown>)
        : undefined;
    const fact = projectCustomEventFact({
      id: idRes.id,
      description: existing!.description,
      summary,
      sessionId: actorId,
      workspaceId: session?.workspaceId ?? existing!.workspaceId,
      paths,
      data
    });
    requireAwareness(ctx).recordFact(fact);
    const delivered = await dispatchRuntimeFacts(ctx, [fact]);
    return { ok: true, fact, delivered: delivered.delivered };
  }
};

export const queryRuntimeState = async (ctx: AppContext, args?: Record<string, unknown>) => {
    const query = normalizeFactQuery(args ?? {});
    const cfg = ctx.config.get();
    const stallMs = normalizePipelineStallMs(cfg.pipeline?.stallMs);
    const now = Date.now();
    const sessions = ctx.sessions.list().filter((s) => {
      if (s.type !== 'terminal') return false;
      if (query.sessionId && s.id !== query.sessionId) return false;
      if (query.workspaceId && (s.workspaceId ?? '') !== query.workspaceId) return false;
      return true;
    });

    const live: RuntimeFact[] = [];
    await Promise.all(
      sessions.map(async (s) => {
        const mainPath = s.worktreeSource?.mainRepo ?? cfg.workspaces.find((w) => w.id === (s.workspaceId ?? ''))?.path ?? '';
        const wt = s.worktreePath?.trim() || '';
        let git: GitFactInput | undefined;
        if (wt && args?.includeGit === true) {
          const raw = await collectPipelineGitFacts({
            worktreePath: wt,
            mainRepo: mainPath,
            branch: s.worktreeBranch
          });
          git = {
            dirtyPaths: raw.dirtyPaths,
            uncommittedCount: raw.uncommittedCount,
            aheadCount: raw.aheadCount,
            canFastForward: raw.canFastForward,
            dirtyOverlap: raw.dirtyOverlap,
            overlapFiles: raw.overlapFiles,
            lastCommit: raw.lastCommit,
            lastFileWriteAt: raw.lastFileWriteAt
          };
          // Git collection may outlive a stop/restart/delete. Query current execution
          // facts rather than validating a historical snapshot as still running.
          const current = ctx.sessions.get(s.id);
          if (!current) return;
          s = current;
        }
        const facts: PipelineWorkerFacts = {
          type: s.type,
          launchKind: s.launchKind,
          runtimePresence: s.runtimePresence,
          activity: s.activity,
          busy: ctx.agentSessions?.isBusy(s.id) === true,
          phase: s.phase?.value,
          lifecycle: s.lifecycle,
          archived: s.archived,
          lastActivityAt: lastActivityAt(sessionActivityParts(s)),
          uncommittedCount: git?.uncommittedCount ?? 0,
          aheadCount: git?.aheadCount ?? 0,
          canFastForward: git?.canFastForward ?? false,
          dirtyOverlap: git?.dirtyOverlap ?? false,
          hasWorktree: Boolean(wt),
          // 未消化排队注入（sessions 注册表计数）：judge 据此保守（不给 readyToMerge）
          queuedInjects: s.queuedInjects ?? 0
        };
        const verdict = judgePipelineWorker(facts, now, { stallMs });
        live.push(
          ...projectSessionFacts(toSessionInput(s), {
            git,
            verdict: {
              kind: verdict.kind,
              mergeBlocked: verdict.mergeBlocked,
              stalled: verdict.kind === 'stalled',
              readyToMerge: verdict.kind === 'readyToMerge'
            },
            now
          })
        );
      })
    );

    const events = requireAwareness(ctx).listFacts();
    const facts = queryFacts([...live, ...events], query);
    return { count: facts.length, facts };
  };
