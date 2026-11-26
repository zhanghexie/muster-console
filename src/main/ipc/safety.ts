import type { AppContext } from '../context';
import { handle as registerIpc, ipcCaller, type IpcHandler } from './handle';
import { t } from '../../shared/i18n';
import { localizeSafetyUserError } from '../../shared/safetyReason';

function handle<T extends IpcHandler>(channel: string, fn: T): void {
  registerIpc(channel, (event, ...args) => {
    try {
      const result = fn(event, ...args);
      return result instanceof Promise ? result.catch(localizeSafetyUserError) : result;
    } catch (error) { return localizeSafetyUserError(error); }
  });
}

/** Only authenticated human UI transports reach these handlers; no host tool exposes them. */
export function registerSafetyIpc(ctx: AppContext): void {
  const service = (workspaceId: unknown) => {
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || !ctx.workspaces.list().some(workspace => workspace.id === workspaceId)) throw new Error(t('工作区已不存在'));
    if (!ctx.safety) throw new Error(t('安全子系统尚未就绪'));
    return ctx.safety;
  };
  handle('safety:snapshot', (_event, workspaceId: string) => service(workspaceId).snapshot(workspaceId));
  handle('safety:send', (event, workspaceId: string, text: string, requestId?: string) => {
    const caller = ipcCaller(event); if (!caller.isAlive()) throw new Error(t('用户连接已断开'));
    if (typeof text !== 'string' || !text.trim() || text.length > 8_000) throw new Error(t('请输入 1–8000 字符的消息'));
    if (requestId !== undefined && (typeof requestId !== 'string' || !requestId || requestId.length > 200)) throw new Error(t('审批事项标识无效'));
    return service(workspaceId).send(workspaceId, text, requestId);
  });
  handle('safety:stop', (event, workspaceId: string) => { if (!ipcCaller(event).isAlive()) throw new Error(t('用户连接已断开')); service(workspaceId).stop(workspaceId); });
  handle('safety:clear', (event, workspaceId: string) => { if (!ipcCaller(event).isAlive()) throw new Error(t('用户连接已断开')); return service(workspaceId).clearConversation(workspaceId); });
  handle('safety:setRuleEnabled', (event, workspaceId: string, ruleId: string, enabled: boolean, revision: number) => {
    const caller = ipcCaller(event); if (!caller.isAlive()) throw new Error(t('用户连接已断开'));
    if (typeof ruleId !== 'string' || !ruleId || ruleId.length > 200 || typeof enabled !== 'boolean' || !Number.isSafeInteger(revision) || revision < 0) throw new Error(t('规则参数无效'));
    return service(workspaceId).setRuleEnabled(workspaceId, ruleId, enabled, revision);
  });
}
