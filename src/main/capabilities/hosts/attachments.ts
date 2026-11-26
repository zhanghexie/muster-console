import { app } from 'electron';
import path from 'node:path';
import type { AppContext } from '../../context';
import { convertAttachment, type ConvertRequest } from '../../attachments/convert';
import { isSchedulerInvocation } from '../../agent/agentScope';

export const attachmentsHost = {
  'attachments.convert': (ctx: AppContext, args: ConvertRequest & { __actorSessionId?: string }) => {
    const userData = app.getPath('userData');
    const scheduler = isSchedulerInvocation();
    const session = !scheduler && args.__actorSessionId ? ctx.sessions.get(args.__actorSessionId) : undefined;
    if (!scheduler && !session) throw new Error('附件转换需要已绑定的会话身份');
    const scope = scheduler ? `scheduler:${ctx.resolveBubbleWorkspaceId()}`
      : `${session!.type === 'terminal' && !ctx.sessions.isChatRuntime(session!.runtime) ? 'cli' : 'gui'}:${session!.id}`;
    return convertAttachment(userData, scope, args, ctx.config.get().attachmentTools, path.join(app.getAppPath(), 'out/main/attachments/worker.mjs'));
  }
};
