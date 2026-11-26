import type { AppContext } from '../context';
import { isConfirmed } from '../../shared/confirmDialog';
import { t } from '../../shared/i18n';
import { localizeSafetyReason } from '../../shared/safetyReason';

export async function confirmAppDefinition(ctx: AppContext, action: string, definition: { name: string; id: string }, reason: string, signal?: AbortSignal): Promise<boolean> {
  return isConfirmed(await ctx.ui.confirm(t('App 审批需要人工处理'), `${action} · ${definition.name} (${definition.id})\n${localizeSafetyReason(reason)}`, { dangerous: true, signal }));
}

export async function confirmSessionOperation(ctx: AppContext, action: string, args: unknown, reason: string, signal?: AbortSignal): Promise<boolean> {
  return isConfirmed(await ctx.ui.confirm(t('会话审批需要人工处理'), `${action}\n${t('目标：{{args}}', { args: JSON.stringify(args) })}\n${localizeSafetyReason(reason)}`, { dangerous: true, signal }));
}
