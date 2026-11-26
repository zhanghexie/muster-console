import type { AppContext } from '../context';
import { runOutsideAgentScope } from '../agent/agentScope';
import { agentMailIdForKey, deliverAgentMessage, readAgentLedgerFor } from '../messages/deliver';
import { controlRootFor } from '../workspacePaths';
import { getSubscriptionPolicyStore } from '../orchestrator/subscriptionPolicyStore';
import { decidePolicyAction, matchPolicyRule } from '../../shared/subscriptionPolicy';
import { isOrchestratorSessionId } from '../../shared/runtimeFacts';
import type { EventEnvelope, EventSubscription } from './eventLog';
import type { AppOutboxEvent } from '../agentApps/store';

export async function deliverSystemReminderEvent(ctx: AppContext, sub: EventSubscription, event: EventEnvelope): Promise<void> {
  const workspace = ctx.workspaces.list().find(w => w.id === sub.workspaceId);
  if (!workspace || !ctx.agentApps || !ctx.eventRouter) throw new Error('Reminder service unavailable');
  const page = ctx.eventRouter.log.payload(event.id, 0, 32000);
  if (!page || page.nextOffset !== null) throw new Error('Reminder payload unavailable');
  const reminder = JSON.parse(page.text) as AppOutboxEvent;
  const key = `app:${reminder.id}`;
  const target = `orchestrator:${sub.workspaceId}`;
  if (readAgentLedgerFor(ctx, sub.workspaceId).messages.some(message => message.id === agentMailIdForKey('host', target, key))) return;
  if (!await ctx.agentApps.notification(sub.workspaceId, reminder.id)) return;
  const policy = getSubscriptionPolicyStore().load(controlRootFor(workspace)).policy;
  const decision = decidePolicyAction({ kind: 'event.subscription', factKind: 'reminder', trigger: reminder.kind }, policy);
  const action = decision.ruleId === 'builtin.default'
    ? policy.rules.find(rule => matchPolicyRule(rule.match, { kind: 'fact', factKind: `app.${reminder.kind}` }))?.action ?? reminder.action
    : decision.action;
  if (action === 'mute') return;
  await runOutsideAgentScope(() => deliverAgentMessage(ctx, { workspaceId: sub.workspaceId, from: 'host', to: target,
    kind: 'notice', subject: reminder.title, idempotencyKey: key, text: reminder.title,
    meta: { hostNotification: { kind: 'app', appId: reminder.appId, eventId: reminder.id },
      subscriptionEvent: true, ...(action === 'digest' ? { digest: true as const } : {}), eventId: reminder.id, notificationKey: key } }));
}

export async function deliverSubscriptionEvent(ctx: AppContext, sub: EventSubscription, event: EventEnvelope): Promise<void> {
  const workspace = ctx.workspaces.list().find(w => w.id === sub.workspaceId);
  if (!workspace) throw new Error('Subscription workspace is unavailable');
  let appEventId: string | undefined;
  if (event.source === 'reminder') {
    if (!ctx.agentApps || !ctx.eventRouter) throw new Error('Reminder service unavailable');
    const page = ctx.eventRouter.log.payload(event.id, 0, 32000);
    if (!page || page.nextOffset !== null) throw new Error('Reminder payload unavailable');
    appEventId = (JSON.parse(page.text) as { id?: string }).id;
    if (!appEventId || !await ctx.agentApps.notification(sub.workspaceId, appEventId)) return;
  }
  const scheduler = isOrchestratorSessionId(sub.subject);
  if (!scheduler) {
    const target = ctx.sessions.get(sub.subject);
    if (!target || target.workspaceId !== sub.workspaceId || target.archived) throw new Error('Subscription target is unavailable');
  }
  const current = ctx.eventRouter?.log.subscriptions(sub.subject).find(item => item.id === sub.id);
  if (!current || current.expiresAt !== null && current.expiresAt <= Date.now()) return;
  const key = `subscription-event:${sub.id}:${event.id}`;
  if (readAgentLedgerFor(ctx, sub.workspaceId).messages.some(message => message.id === agentMailIdForKey('host', sub.subject, key))) return;
  let digest = sub.mode === 'digest';
  if (scheduler) {
    const policy = getSubscriptionPolicyStore().load(controlRootFor(workspace)).policy;
    const decision = decidePolicyAction({ kind: 'event.subscription', factKind: event.source, trigger: event.type }, policy);
    if (decision.action === 'mute') return;
    if (decision.ruleId !== 'builtin.default') digest = decision.action === 'digest';
  }
  const body = { type: 'event-subscription', eventType: event.type, source: event.source,
    occurredAt: event.receivedAt, summary: event.summary,
    data: { eventId: event.id, scope: event.scope, payloadRef: event.id, untrusted: true, ...(appEventId ? { appEventId } : {}) } };
  await runOutsideAgentScope(() => deliverAgentMessage(ctx, { from: 'host', to: sub.subject, workspaceId: sub.workspaceId,
    subject: `事件通知：${event.source}`, idempotencyKey: key,
    meta: { ...(scheduler ? { hostNotification: { kind: 'event' as const, eventId: event.id } } : {}),
      eventId: event.id, subscriptionIds: [sub.id], ...(scheduler ? { subscriptionEvent: true as const } : {}), ...(digest ? { digest: true as const } : {}) },
    text: JSON.stringify(body) }));
}
