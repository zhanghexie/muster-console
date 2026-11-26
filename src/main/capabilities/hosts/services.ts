import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import type { TaskSchedule } from '../../../shared/types';
import type { NativeConfigIntent } from '../../../shared/nativeSessionConfig';

function assertRuntimeEnabled(ctx: AppContext, runtime: string): void {
  if (!ctx.runtimes.get(runtime)?.enabled) {
    throw new Error(t('runtime 未注册或已禁用: {{runtime}}', { runtime }));
  }
}

function modelFields(
  model?: { providerId: string; modelId: string }
): { providerId?: string; modelId?: string } {
  if (model === undefined) return {};
  if (
    !model ||
    typeof model.providerId !== 'string' || !model.providerId.trim() ||
    typeof model.modelId !== 'string' || !model.modelId.trim()
  ) {
    throw new Error('model requires providerId and modelId');
  }
  return { providerId: model.providerId, modelId: model.modelId };
}

/** create/update 的四类时间计划；与 delayMinutes 二选一 */
type ScheduleArg =
  | { kind: 'daily'; time?: string }
  | { kind: 'weekly'; time?: string; weekdays?: number[] }
  | { kind: 'interval'; intervalMinutes?: number }
  | { kind: 'once'; at: string };

function normalizeScheduleArg(schedule: ScheduleArg | undefined): TaskSchedule | undefined {
  if (!schedule) return undefined;
  if (!['daily', 'weekly', 'interval', 'once'].includes(schedule.kind)) throw new Error('Unknown schedule kind');
  if (schedule.kind === 'daily') return { kind: 'daily', time: schedule.time ?? '09:00' };
  if (schedule.kind === 'weekly') {
    return { kind: 'weekly', time: schedule.time ?? '09:00', weekdays: schedule.weekdays ?? [1] };
  }
  if (schedule.kind === 'interval') return { kind: 'interval', intervalMinutes: schedule.intervalMinutes ?? 60 };
  return { kind: 'once', at: schedule.at };
}

export const servicesHost = {
  'automations.list': (ctx: AppContext) => ({ automations: ctx.tasks.list(ctx.resolveBubbleWorkspaceId()) }),

  'automations.create': async (
    ctx: AppContext,
    args: {
      name: string;
      workspaceId?: string;
      rootId?: string;
      rootsRevision?: number;
      runtime: string;
      prompt: string;
      schedule?: ScheduleArg;
      delayMinutes?: number;
      maxRuns?: number;
      missedPolicy?: 'skip' | 'catch-up' | 'confirm';
      model?: { providerId: string; modelId: string };
      configurePermissions?: boolean;
      guiMode?: 'default' | 'ask' | 'plan' | 'auto';
      nativeConfig?: NativeConfigIntent;
      cliLaunchOptions?: import('../../../shared/cliLaunchOptions').CliLaunchOptions;
      piModeId?: string;
      thinking?: 'off' | 'low' | 'medium' | 'high' | 'max';
    }
  ) => {
    if (!args.runtime) throw new Error(t('必须传 runtime（先 runtimes.list）'));
    assertRuntimeEnabled(ctx, args.runtime);
    // 管理器统一校验互斥并按真实时钟换算 once，保留原相对延迟用于展示。
    const task = ctx.tasks.create({
      name: args.name,
      prompt: args.prompt,
      runtime: args.runtime,
      enabled: true,
      mode: 'terminal',
      workspaceId: args.workspaceId ?? ctx.resolveBubbleWorkspaceId(),
      rootId: args.rootId,
      rootsRevision: args.rootsRevision,
      schedule: normalizeScheduleArg(args.schedule),
      delayMinutes: args.delayMinutes,
      maxRuns: args.maxRuns,
      missedPolicy: args.missedPolicy,
      ...modelFields(args.model),
      configurePermissions: args.configurePermissions,
      guiMode: args.guiMode,
      nativeConfig: args.nativeConfig,
      cliLaunchOptions: args.cliLaunchOptions,
      piModeId: args.piModeId,
      thinking: args.thinking
    });
    return { created: true, task };
  },

  'automations.update': async (
    ctx: AppContext,
    args: {
      automationId: string;
      name?: string;
      workspaceId?: string;
      rootId?: string;
      rootsRevision?: number;
      runtime?: string;
      prompt?: string;
      schedule?: ScheduleArg;
      delayMinutes?: number;
      maxRuns?: number;
      missedPolicy?: 'skip' | 'catch-up' | 'confirm';
      model?: { providerId: string; modelId: string };
      configurePermissions?: boolean;
      guiMode?: 'default' | 'ask' | 'plan' | 'auto';
      nativeConfig?: NativeConfigIntent | null;
      cliLaunchOptions?: import('../../../shared/cliLaunchOptions').CliLaunchOptions | null;
      piModeId?: string;
      thinking?: 'off' | 'low' | 'medium' | 'high' | 'max';
    }
  ) => {
    if (args.runtime !== undefined) assertRuntimeEnabled(ctx, args.runtime);
    const { schedule, automationId, model } = args;
    const task = ctx.tasks.update(automationId, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
      ...(args.rootId !== undefined ? { rootId: args.rootId } : {}),
      ...(args.rootsRevision !== undefined ? { rootsRevision: args.rootsRevision } : {}),
      ...(args.runtime !== undefined ? { runtime: args.runtime } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.maxRuns !== undefined ? { maxRuns: args.maxRuns } : {}),
      ...(args.missedPolicy !== undefined ? { missedPolicy: args.missedPolicy } : {}),
      ...(args.configurePermissions !== undefined ? { configurePermissions: args.configurePermissions } : {}),
      ...(args.guiMode !== undefined ? { guiMode: args.guiMode } : {}),
      ...(args.cliLaunchOptions !== undefined ? { cliLaunchOptions: args.cliLaunchOptions } : {}),
      ...(args.nativeConfig !== undefined ? { nativeConfig: args.nativeConfig } : {}),
      ...(args.piModeId !== undefined ? { piModeId: args.piModeId } : {}),
      ...(args.thinking !== undefined ? { thinking: args.thinking } : {}),
      ...modelFields(model),
      ...(schedule !== undefined || args.delayMinutes !== undefined
        ? {
            schedule: normalizeScheduleArg(schedule),
            delayMinutes: args.delayMinutes
          }
        : {})
    });
    return { updated: true, task };
  },

  'automations.setEnabled': async (ctx: AppContext, args: { automationId: string; enabled: boolean }) => {
    if (typeof args.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (args.enabled) ctx.tasks.enable(args.automationId);
    else ctx.tasks.disable(args.automationId);
    return { enabled: args.enabled, automationId: args.automationId };
  },

  'automations.delete': async (ctx: AppContext, args: { automationId: string }) => {
    ctx.tasks.delete(args.automationId);
    return { deleted: true, automationId: args.automationId };
  },

  'automations.runNow': async (ctx: AppContext, args: { automationId: string }) => {
    await ctx.tasks.runNow(args.automationId);
    return { triggered: true, automationId: args.automationId };
  }
};
