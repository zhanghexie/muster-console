/** Shared intent routing. No vendor IDs and no implicit fallback after uncertain delivery. */
import type { AppContext } from '../context';
import { parseRuntimeDeliveryResult, type RuntimeDeliveryResult } from '../../shared/runtimeCommunication';
import { assertWorkspaceExecutionContextCurrent } from '../workspaceExecutionContext';
import { sendMailboxWake, sendSchedulerMailboxWake } from './transport';
import type { HostNotificationDelivery } from '../../shared/hostNotification';

const deferred = (reason: string): RuntimeDeliveryResult => ({ status: 'deferred', reason });
const unsupported = (): RuntimeDeliveryResult => ({ status: 'unsupported', reason: '当前接入未提供原生消息通道' });

export async function deliverMailboxNotice(ctx: AppContext, recipient: string, workspaceId: string,
  text: string, messageId: string, stillNeeded: () => boolean,
  options: { intent?: 'normal' | 'interrupt'; nativeOnly?: boolean; signal?: AbortSignal; notification?: HostNotificationDelivery } = {}): Promise<RuntimeDeliveryResult> {
  // 防回声窗（noticeScope）已废除：邮箱提醒与事件系统解耦，提醒投递不再进入任何事件抑制作用域。
  return deliver(ctx, recipient, workspaceId, text, messageId, stillNeeded, options);
}

async function deliver(ctx: AppContext, recipient: string, workspaceId: string,
  text: string, messageId: string, stillNeeded: () => boolean,
  options: { intent?: 'normal' | 'interrupt'; nativeOnly?: boolean; signal?: AbortSignal; notification?: HostNotificationDelivery }): Promise<RuntimeDeliveryResult> {
  if (options.signal?.aborted) throw new Error('已取消通信');
  if (!stillNeeded()) return deferred('邮件已读取或目标不可用');
  const message = { intent: options.intent ?? 'normal' as const, text, messageId,
    idleOnly: options.intent !== 'interrupt' };
  if (!recipient.startsWith('orchestrator:')) {
    const session = ctx.sessions.get(recipient);
    if (!session || session.archived || session.launchKind === 'shell') return deferred('收信会话不可用');
    if (ctx.sessions.isChatRuntime(session.runtime)) {
      const host = ctx.agentSessions;
      if (!host) throw new Error('会话宿主尚未就绪');
      // Ordinary notices must never survive in a native follow-up queue after
      // the running agent has already read its mailbox itself.
      if (message.intent === 'normal') {
        const accepted = await sendMailboxWake(ctx, recipient, workspaceId, text, messageId, stillNeeded);
        return accepted ? { status: 'accepted', method: 'sent' } : deferred('等待当前回合结束后重查未读信');
      }
      if (!host.isOpen(recipient)) host.open(session);
      if (host.deliverMessage) {
        let result: Awaited<ReturnType<typeof host.deliverMessage>>;
        try { result = await boundedAdmission(host.deliverMessage(recipient, message), options.signal); }
        catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUncertain: true }); }
        if (result.ok) return { status: 'accepted', method: result.delivery ?? (result.steered ? 'steered' : result.queued ? 'queued' : 'sent') };
        if (result.error === 'native-unsupported') return options.nativeOnly ? unsupported() : deferred('当前接入等待回合结束');
        return deferred(result.error || '宿主提醒暂未受理');
      }
    } else {
      if (message.intent === 'normal' && session.lifecycle !== 'idle' && session.lifecycle !== 'exited')
        return deferred('等待终端确认空闲后重查未读信');
      const binding = ctx.sessions.getCliWorkspaceContext?.(recipient);
      const module = !binding && session.runtime && ctx.runtimes ? await ctx.runtimes.loadModule(session.runtime) : undefined;
      const receiveMessage = binding ? binding.receiveMessage : module?.receiveMessage?.bind(module);
      if (receiveMessage) {
        const runtime = session.runtime, external = session.externalSessionId;
        const cwd = binding?.workspaceContext?.cwd || session.cwd;
        if (!cwd || !external) return deferred('终端引擎会话或工作目录尚未就绪');
        const isBound = () => {
          const current = ctx.sessions.get(recipient);
          return !!current && !current.archived && current.runtime === runtime &&
            (binding !== undefined || current.externalSessionId === external) && ctx.sessions.getCliWorkspaceContext?.(recipient) === binding;
        };
        const isCurrent = () => isBound() && stillNeeded() && (message.intent === 'interrupt' ||
          ['idle', 'exited'].includes(ctx.sessions.get(recipient)?.lifecycle ?? ''));
        if (!isCurrent() || !stillNeeded()) return deferred('会话已变更或邮件已读取');
        assertWorkspaceExecutionContextCurrent(ctx.config.get(), binding?.workspaceContext);
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel: (() => void) | undefined;
        try {
          const result = parseRuntimeDeliveryResult(await Promise.race([
            receiveMessage({ ...message, sessionId: external || session.id,
              hostSessionId: recipient, cwd, signal: controller.signal, isCurrent }),
            new Promise<never>((_, reject) => {
              const fail = (reason: string) => { controller.abort(); reject(new Error(reason)); };
              timer = setTimeout(() => fail('原生通信超时，投递状态未知，未自动改用键盘输入'), 10000);
              cancel = () => fail('通信已取消，投递状态未知');
              options.signal?.addEventListener('abort', cancel, { once: true });
              if (options.signal?.aborted) cancel();
            })
          ]));
          if (!isBound()) throw new Error('通信期间会话已重新启动，投递状态未知');
          if (result.status !== 'unsupported') {
            if (result.status === 'accepted' && (['sent', 'stopped-and-sent', 'steered'].includes(result.method) ||
              result.method === 'queued' && session.lifecycle === 'idle') && session.lifecycle !== 'blocked')
              ctx.sessions.applyActivitySignal?.(recipient, 'active', 'native-message-submit');
            return result;
          }
        } catch (error) {
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), { deliveryUncertain: true });
        } finally {
          if (timer) clearTimeout(timer);
          if (cancel) options.signal?.removeEventListener('abort', cancel);
        }
      }
    }
  }
  if (options.nativeOnly) return unsupported();
  if (recipient.startsWith('orchestrator:')) {
    return sendSchedulerMailboxWake(ctx, workspaceId, text, messageId, stillNeeded, options.notification);
  }
  const accepted = await sendMailboxWake(ctx, recipient, workspaceId, text, messageId, stillNeeded);
  return accepted ? { status: 'accepted', method: ctx.sessions.isChatRuntime(ctx.sessions.get(recipient)?.runtime) ? 'sent' : 'written' }
    : deferred('当前接入尚未就绪或未确认空闲，等待状态变化');
}

async function boundedAdmission<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('原生通信超时，投递状态未知')), 10000);
      cancel = () => reject(new Error('通信已取消，投递状态未知'));
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) signal?.removeEventListener('abort', cancel);
  }
}
