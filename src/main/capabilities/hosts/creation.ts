import type { AppContext } from '../../context';
import { delegateTask } from '../../tasks/delegate';
import { currentAgentSessionId, isSchedulerInvocation } from '../../agent/agentScope';
import { requireSessionIsolation, type SessionIsolation } from '../../../shared/sessionIsolation';
import type { CliLaunchOptions } from '../../../shared/cliLaunchOptions';
import type { GuiWorkerMode } from '../../../shared/types';
import { parseWorkerTargetSelection, workerReferenceSource, workerToolSource } from '../../tasks/workerRouting';
import { WORKER_ROUTING_SETTINGS_LOCATION } from '../../../shared/workerRouting';
import type { SessionTargetInput } from '../../sessions/targets';

/**
 * P4 统一派活：一条工具完成「建会话 + 邮箱派活 + 护栏 + 明确隔离选择」。
 * 也可分别用 sessions.create 建会话、sessions.message 寄送后续任务。
 */
export const createSessionWithTask = (
    ctx: AppContext,
    args: {
      task?: string;
      force?: boolean;
      modelParameters?: import('../../../shared/modelParameters').ModelParameterValues;
      runtime?: string;
      workspaceId?: string;
      rootId?: string;
      cwd?: string;
      rootsRevision?: number;
      isolationGroups?: import('../../../shared/types').WorkspaceWorktreeGroupSelection[];
      isolation: SessionIsolation;
      name?: string;
      configurePermissions?: boolean;
      guiMode?: GuiWorkerMode;
      nativeConfig?: import('../../../shared/nativeSessionConfig').NativeConfigIntent;
      piModeId?: string;
      acpPresetId?: string;
      cliLaunchOptions?: CliLaunchOptions;
      target?: unknown;
      inherit?: boolean;
      model?: { providerId: string; modelId: string };
      thinking?: 'off' | 'low' | 'medium' | 'high' | 'max';
      select?: boolean | string;
      /** 派子代理：父会话由宿主从调用者身份注入（模型无法伪造，见 tools.ts 的 asSubagent） */
      asSubagent?: boolean;
      /** 已停用（F-04）：出现即拒。角色由宿主轮选；显式角色仅剩内部可信路径（重试复用/队列重入直调 delegateTask） */
      characterId?: string;
    }
  ) => {
    // F-04（可靠性审查）：executor 只做 JSON.parse、不按 schema 拒收未声明参数，
    // 模型硬猜 characterId 仍可经此透传指定角色。sessions.create 处理链在此收口拒收；
    // creationKey 重放与队列重入走 delegateTask 直调（带会话快照 characterId），不受影响。
    if (args.characterId !== undefined) {
      throw new Error('sessions.create 不接受 characterId：子代理角色由宿主轮选分配，外部指定已停用');
    }
    if (Object.hasOwn(args, 'crossHarness')) throw new Error('Worker cross-Harness approval is managed in Settings.');
    const isolation = requireSessionIsolation(args, { allowDefaultGroup: true });
    const target = args.target === undefined ? undefined : parseWorkerTargetSelection(args.target);
    const rawChoice = ['runtime', 'model', 'modelParameters', 'thinking', 'piModeId', 'acpPresetId', 'cliLaunchOptions', 'force'] as const;
    if ((target || args.inherit === true) && rawChoice.some(field => args[field] !== undefined)) throw new Error('Worker target or inheritance cannot be combined with raw model or adapter options.');
    if (args.inherit === true && (args.configurePermissions !== undefined || args.guiMode !== undefined || args.nativeConfig !== undefined)) throw new Error('inherit=true uses the parent launch settings.');
    if (args.inherit !== undefined && typeof args.inherit !== 'boolean') throw new Error('inherit must be a boolean.');
    if (args.inherit === true && (target || args.asSubagent !== true)) throw new Error('inherit=true requires asSubagent=true and cannot be combined with target.');
    if (target && !args.task?.trim()) throw new Error('Worker target requires task text.');
    if (!target && !args.runtime?.trim() && isSchedulerInvocation() && args.task?.trim()) {
      throw new Error(`Choose a Worker tier with target:{tierId}, or pass an exact targetRef. Configure tiers in ${WORKER_ROUTING_SETTINGS_LOCATION}.`);
    }
    // 父 = 调用链上的会话（executeTool 用 callingSessionId 包的 ALS）。
    // actor 绑定供其他工具统一授权；父身份取受信任的调用上下文，不能回落到
    // 可由模型构造的参数。GUI 与 CLI 都须给 executeTool 传 callingSessionId。
    const actorSessionId = currentAgentSessionId() ?? '';
    if (args.asSubagent === true && !actorSessionId) {
      throw new Error('asSubagent 需要会话身份：请从 Worker 会话内调用（宿主从调用链注入父会话）');
    }
    const useParentSource = args.asSubagent && args.rootId === undefined && args.cwd === undefined && !!ctx.sessions.get(actorSessionId)?.sourceRoot;
    const source: SessionTargetInput = target ? workerReferenceSource(ctx, args, target) : args.inherit || useParentSource ? workerToolSource(ctx, args) : args;
    return delegateTask(ctx, {
      task: args?.task ?? '',
      force: args.force,
      modelParameters: args.modelParameters,
      runtime: args?.runtime,
      // 派子代理：父 = 调用链 ALS 中的会话，模型无法指定或伪造。顶层派活不带此字段。
      ...(args?.asSubagent === true && actorSessionId ? { parentSessionId: actorSessionId } : {}),
      ...(target && actorSessionId ? { routingCallerSessionId: actorSessionId } : {}),
      workspaceId: source.workspaceId,
      rootId: source.rootId,
      cwd: source.cwd,
      rootsRevision: source.rootsRevision,
      ...(source.capturedSource ? { capturedSource: source.capturedSource } : {}),
      isolationGroups: args?.isolationGroups,
      defaultIsolationGroup: isolation === 'isolated' && args.isolationGroups === undefined,
      isolate: isolation === 'isolated',
      name: args?.name,
      configurePermissions: args?.configurePermissions,
      guiMode: args?.guiMode,
      nativeConfig: args?.nativeConfig,
      piModeId: args?.piModeId,
      acpPresetId: args.acpPresetId,
      cliLaunchOptions: args.cliLaunchOptions,
      target,
      inherit: args.inherit,
      model: args?.model,
      thinking: args?.thinking,
      select: args?.select === false || args?.select === 'false' ? false : undefined,
      // 调度 Agent 自己发起：工具结果已含全部信息，不再自言自语式通知
      notifyOrchestrator: false
    });
  };
