/** Unified subscription matching; all notifications are durable mailbox letters. */
import { createHash } from 'node:crypto';
import type { AppContext } from '../context';
import { runOutsideAgentScope } from '../agent/agentScope';
import { deliverAgentMessage, readAgentLedgerFor } from '../messages/deliver';
import { isAgentMessageTargetEnded } from '../../shared/agentMessage';
import { isOrchestratorSessionId, listAliveAwarenessSessionIds, parseOrchestratorWorkspaceId, type RuntimeFact } from '../../shared/runtimeFacts';
import { decideSubscribeDelivery, isSuppressedFactKind, matchSubscriptions } from '../../shared/runtimeFactsSubscribe';
import { decidePolicyAction } from '../../shared/subscriptionPolicy';
import { getSubscriptionPolicyStore } from '../orchestrator/subscriptionPolicyStore';
import { controlRootFor } from '../workspacePaths';

export interface FactDispatchResult { delivered: number; skipped: number; }
const chains = new WeakMap<AppContext, Promise<unknown>>();
export function dispatchRuntimeFacts(ctx: AppContext, facts: RuntimeFact[], opts?: { now?: number; debounceMs?: number; hourlyLimit?: number }): Promise<FactDispatchResult> {
  // 事件面收敛（noticeScope 防回声窗已废除）：activity/lifecycle 常规翻转只进查询面，
  // 不再对订阅方保存事件邮件；「需要你 / 停滞」等有意义事件照常投递。
  const filtered = facts.filter(f => !isSuppressedFactKind(f.kind));
  for (const fact of filtered) {
    if (!ctx.eventRouter || !fact.workspaceId) continue;
    const payload = JSON.stringify(fact);
    // liveFactId is stable for the current field. The event log needs a stable
    // id for the exact occurrence so a changed field becomes a new event.
    const occurrenceId = createHash('sha256').update(payload).digest('hex');
    ctx.eventRouter.publish({ source: 'fact', deliveryId: `${fact.workspaceId}:${fact.id}:${occurrenceId}`, type: fact.kind, scope: fact.sessionId ?? '',
      workspaceId: fact.workspaceId, receivedAt: fact.ts, summary: fact.summary.slice(0, 1000), payload });
  }
  const prior = chains.get(ctx) ?? Promise.resolve();
  const job = prior.catch(() => {}).then(() => deliverFacts(ctx, filtered, opts));
  chains.set(ctx, job); void job.finally(() => { if (chains.get(ctx) === job) chains.delete(ctx); }).catch(() => {});
  return job;
}

async function deliverFacts(ctx: AppContext, facts: RuntimeFact[], opts?: { now?: number; debounceMs?: number; hourlyLimit?: number }): Promise<FactDispatchResult> {
  const store = ctx.awareness;
  if (!store || !facts.length) return { delivered: 0, skipped: 0 };
  const alive = new Set(listAliveAwarenessSessionIds(ctx.sessions.list().map(s => s.id), ctx.workspaces.list().map(w => w.id)));
  store.pruneSubscriptions(alive);
  const subs = store.listSubscriptions().flatMap(sub => {
    if (sub.query.workspaceId) return [sub];
    const workspaceId = isOrchestratorSessionId(sub.subscriberSessionId) ? parseOrchestratorWorkspaceId(sub.subscriberSessionId) : ctx.sessions.get(sub.subscriberSessionId)?.workspaceId;
    return workspaceId ? [{ ...sub, query: { ...sub.query, workspaceId } }] : [];
  });
  let delivered = 0, skipped = 0; const failures: string[] = [];
  for (const fact of facts) {
    const targets = new Map<string, typeof subs>();
    for (const sub of matchSubscriptions(subs, fact)) targets.set(sub.subscriberSessionId, [...(targets.get(sub.subscriberSessionId) ?? []), sub]);
    for (const [recipient, matches] of targets) {
      const scheduler = isOrchestratorSessionId(recipient);
      const target = ctx.sessions.get(recipient);
      const workspaceId = scheduler ? parseOrchestratorWorkspaceId(recipient) : target?.workspaceId;
      const workspace = ctx.workspaces.list().find(w => w.id === workspaceId);
      if (!workspace || (!scheduler && (!target || isAgentMessageTargetEnded(target)))) { skipped++; continue; }
      // X1-F03：eventId 取排除 ts/id 的语义键（kind+sessionId+data.value）——同值重报
      // （如 setPhase 前置短路遗漏的旁路写入）不再产生新信，账本 E 的幂等去重生效；
      // 值真正变化时键随之变化，照常投递。检查放在策略/防抖判定之后：防抖窗口内或
      // 超限的同值重报仍按未投递记账（skipped），只有本会投递的事件才做幂等去重。
      const eventId = createHash('sha256')
        .update(JSON.stringify([fact.kind, fact.sessionId ?? null, fact.data?.value ?? null]))
        .digest('hex');
      const ledger = structuredClone(store.rateLedger);
      const match = matches.find(sub => decideSubscribeDelivery(sub, fact, ledger, opts?.now ?? Date.now(), opts).ok);
      if (!match) { skipped++; continue; }
      if (readAgentLedgerFor(ctx, workspaceId).messages.some(m => m.to === recipient && m.meta?.eventId === eventId)) {
        // 幂等去重命中：信已在邮箱（不重复存信），按已投递记账并照常消耗限频窗口
        //（与旧「每次重报都新信」的限频消耗口径一致，防同值重报绕开限频）。
        Object.assign(store.rateLedger, ledger); delivered++; continue;
      }
      let digest = false;
      if (scheduler) {
        const source = fact.sessionId ? ctx.sessions.get(fact.sessionId) : undefined;
        const policy = getSubscriptionPolicyStore().load(controlRootFor(workspace)).policy;
        const decision = decidePolicyAction({ kind: 'fact', factKind: fact.kind, sessionId: fact.sessionId,
          ...(typeof fact.data.value === 'string' ? { trigger: fact.data.value } : {}), orchestrated: source?.orchestrated === true }, policy);
        if (decision.action === 'mute') { skipped++; continue; }
        digest = decision.action === 'digest';
      }
      try {
        await runOutsideAgentScope(() => deliverAgentMessage(ctx, { from: 'host', to: recipient, workspaceId,
          subject: '事件通知：' + fact.kind, idempotencyKey: 'event:' + eventId,
          meta: { ...(scheduler ? { hostNotification: { kind: 'event' as const, eventId } } : {}), eventId, subscriptionIds: matches.map(sub => sub.id).sort(), ...(digest ? { digest: true } : {}) },
          text: JSON.stringify({ type: 'event-notification', sourceEventId: fact.id, eventId, eventType: fact.kind,
            sourceSessionId: fact.sessionId ?? null, workspaceId: fact.workspaceId ?? null, occurredAt: fact.ts,
            summary: fact.summary, data: fact.data, paths: fact.paths ?? [] }) }));
        Object.assign(store.rateLedger, ledger); delivered++;
      } catch (error) { failures.push(recipient + ': ' + (error as Error).message); }
    }
  }
  if (failures.length) throw new Error('事件通知保存失败，未记为投递成功：' + failures.join('；'));
  return { delivered, skipped };
}
