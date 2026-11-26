/** Mailbox transport carries wake text. GUI first-assignment bodies are assembled at native dispatch. */
import type { AppContext } from '../context';
import { typeAndSubmit } from '../pty/submit';
import { assertWorkspaceExecutionContextCurrent } from '../workspaceExecutionContext';
import { hasSchedulerPendingQuestion } from '../schedulerStatusStore';
import type { HostNotificationDelivery } from '../../shared/hostNotification';
import type { RuntimeDeliveryResult } from '../../shared/runtimeCommunication';

export async function sendSchedulerMailboxWake(ctx: AppContext, workspaceId: string,
  text: string, messageId: string, stillNeeded: () => boolean, notification?: HostNotificationDelivery): Promise<RuntimeDeliveryResult> {
  const scheduler = ctx.orchestrator;
  if (!scheduler) throw new Error('调度宿主尚未就绪');
  const blockedReason = () => {
    if (scheduler.isBusy(workspaceId)) return '调度正忙';
    if (hasSchedulerPendingQuestion(ctx, workspaceId)) return '调度正在等待用户回答';
    return undefined;
  };
  const blocked = blockedReason();
  if (blocked) return { status: 'deferred', reason: blocked };

  // Keep one reservation through autonomy admission and recheck the letter at dispatch.
  return new Promise<RuntimeDeliveryResult>((resolve, reject) => {
    const accepted = () => resolve({ status: 'accepted', method: 'sent' });
    const defer = (reason = blockedReason() ?? '调度暂未受理唤醒') => resolve({ status: 'deferred', reason });
    let consumed = false;
    const delivery = notification ? { ...notification,
      accepted: async (batch: Parameters<HostNotificationDelivery['accepted']>[0]) => {
        await notification.accepted(batch); consumed = true; accepted();
      },
      settled: () => { notification.settled?.(); if (!consumed) defer(); }
    } : undefined;
    void scheduler.send(text, workspaceId, undefined, {
      host: true, messageId, requireIdle: true, schedulerWake: true, notification: delivery,
      beforeStart: () => {
        const reason = stillNeeded() ? blockedReason() : '邮件已读取或目标不可用';
        if (reason) defer(reason);
        return !reason;
      },
      onAccepted: () => { if (!notification) accepted(); },
      onSkipped: error => { if (error !== undefined) reject(error); else defer(); }
    }).catch(reject);
  });
}

export async function sendMailboxWake(ctx: AppContext, recipient: string, workspaceId: string,
  text: string, messageId: string, stillNeeded: () => boolean, notification?: HostNotificationDelivery): Promise<boolean> {
  if (recipient.startsWith('orchestrator:')) {
    return (await sendSchedulerMailboxWake(ctx, workspaceId, text, messageId, stillNeeded, notification)).status === 'accepted';
  }
  let session = ctx.sessions.get(recipient);
  if (!session || session.archived || session.launchKind === 'shell') return false;
  if (ctx.sessions.isChatRuntime(session.runtime)) {
    if (!ctx.agentSessions) throw new Error('会话宿主尚未就绪');
    if (ctx.agentSessions.isBusy(recipient)) return false;
    if (!ctx.agentSessions.isOpen(recipient)) ctx.agentSessions.open(session);
    if (!stillNeeded()) return false;
    const result = await ctx.agentSessions.send(recipient, text, undefined,
      { host: true, messageId, requireIdle: true });
    if (!result.ok && result.error !== 'busy') throw new Error(result.error || '宿主提醒未受理');
    return result.ok;
  }
  if (session.lifecycle === 'working' || session.lifecycle === 'blocked' || session.lifecycle === 'starting') return false;
  if (!ctx.pty.isRunning(recipient)) {
    // Resume uses the existing common runtime adapter and never selects the session.
    await ctx.sessions.respawn(recipient);
    session = ctx.sessions.get(recipient);
    if (!session || session.archived || session.lifecycle !== 'idle') return false;
  }
  if (session.lifecycle !== 'idle') return false;
  const context = ctx.sessions.getCliWorkspaceContext(recipient);
  const strategy = await ctx.sessions.injectStrategy(session.runtime);
  const paste = await ctx.sessions.pasteInput(session.runtime);
  session = ctx.sessions.get(recipient);
  if (!session || session.archived || session.lifecycle !== 'idle' || !stillNeeded()) return false;
  if (ctx.sessions.getCliWorkspaceContext(recipient) !== context) throw new Error('会话已重新启动，提醒未提交');
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), context?.workspaceContext);
  let submitted = false;
  try {
  if (strategy === 'relaunch-resume') {
    submitted = true;
    await ctx.sessions.relaunchWithPrompt(recipient, text);
  } else {
    const writer = ctx.pty.captureWriter(recipient);
    // Actual submission revokes the previous Stop without pretending it was human input.
    ctx.sessions.applyActivitySignal?.(recipient, 'active', 'host-prompt-submit');
    await typeAndSubmit({ write: (id, data) => {
      const current = ctx.sessions.get(recipient);
      if (!current || current.archived || current.lifecycle === 'blocked' || ctx.sessions.getCliWorkspaceContext(recipient) !== context) return false;
      try {
        const written = writer.write(id, data);
        // A rejected Enter is a definite non-submission. typeAndSubmit records
        // its typed residue and clears it on retry; do not strand that request.
        if (written && data === '\r') submitted = true;
        return written;
      } catch (error) { submitted = true; throw error; }
    } }, recipient, text, { paste, enterCount: 1 });
  }
  } catch (error) {
    // Entering the runtime or terminal submission can leave partial input even
    // when its promise fails. Never automatically replay that uncertain effect.
    if (submitted) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUncertain: true });
    throw error;
  }
  return true;
}
