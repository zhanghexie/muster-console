import type { AppContext } from '../context';
import type { AppValues } from '../../shared/agentApps';
import { authorizeSafetyOperation } from '../safety/bindings';
import { t } from '../../shared/i18n';
import { localizeSafetyReason } from '../../shared/safetyReason';

/** Called after the App service enforces the account and conversation capability. */
export async function authorizeAppSend(ctx: AppContext, workspaceId: string, appName: string, values: AppValues, signal?: AbortSignal): Promise<boolean> {
  const snapshot = await ctx.agentApps?.snapshot(workspaceId);
  const connection = snapshot?.connections.find(c => c.id === values.accountId);
  return (await authorizeSafetyOperation(ctx, {
    workspaceId, source: 'app', action: connection?.kind === 'feishu' ? 'messages.send' : 'mail.send',
    args: values, summary: `${appName} · 发送`, signal,
    humanConfirm: async (reason, signal) => (await ctx.ui.confirm(t('安全审核需要确认'), localizeSafetyReason(reason), { dangerous: true, signal, confirmLabel: t('继续发送') })).confirmed
  })).allowed;
}
