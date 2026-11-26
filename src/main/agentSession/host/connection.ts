/**
 * AgentSessionHost 连接建立：生效模型解析（纯函数）与 ensureConnection 编排——
 * 会话工具集物化、记忆注入、政策层提示词材料化、driver.connect、
 * 注入快照入信封与事件泵挂载。切模型/流死亡都经这里重建（历史经 resume token 续聊）。
 */
import { nativeConfigIdentity, publishNativeConfig } from './nativeConfigState';
import { sameNativeConfigIdentity, type NativeConfigIntent } from '../../../shared/nativeSessionConfig';
import type { SessionMeta } from '../../../shared/types';
import { derivePermissionMode } from '../../../shared/guiWorkerPolicy';
import { resolveLlmConfig } from '../../config';
import { llmConnectionIdentity } from '../../agent/llmConnectionIdentity';
import { getMemoryService } from '../../memory/runtime';
import { firstGuiUserMessageContext, formatGuiHostContext, materializeGuiWorkerPrompt } from '../prompt';
import { buildSessionToolset } from '../tools/registry';
import { buildProjectedGuiTools } from '../tools/projectedGuiTools';
import type { GuiDriverConnectInput, GuiRuntimeConnection, GuiRuntimeDriver } from '../types';
import { t } from '../../../shared/i18n';
import { getChatCapabilities } from '../../../shared/agentRuntimeCapabilities';
import type { ChatRuntimeId } from '../../../shared/agentRuntimeCapabilities';
import { renderWorkerDirectoryScope } from '../../../shared/workspaceExecutionContext';
import { captureWorkspaceExecutionContext } from '../../workspaceExecutionContext';
import { controlRootFor } from '../../workspacePaths';
import type { HostCore, SessionEntry } from './internal';
import { getDriver, log } from './base';
import { currentTurnUserTs, prepareHostIntro, recordInjectionSnapshot } from './injection';
import { handleApprovalRequest, handleUserQuestionRequest } from './approvals';
import { consumeEvents } from './events';
import { usageModelSelectionKey } from './usage';
import { ConnectionCleanupError, markRetirementFailure, retireConnection, retirementBarrier } from './retirement';
import { supportsGuiPermissionMode } from '../../../shared/guiPermissionOptions';
import { parameterSnapshot } from './modelParameters';
import { resolveSessionTarget } from '../../sessions/targets';
import { assertWorkerRouteCurrent, workerCrossHarnessSnapshot } from '../../tasks/workerRouting';
import { validateWorkerConfig } from '../../tasks/workerRoutingCatalog';
import { sessionModelSourceCwd } from '../harnessCatalogSource';
import { hasConfiguredModelParameterDefault } from '../../../shared/modelParameters';

/** resolveMode 的解析产物（引擎侧模式合同） */
type ResolvedEngineMode = Exclude<ReturnType<NonNullable<GuiRuntimeDriver['resolveMode']>>, null>;

const connectionConfigurationChecks = new WeakMap<GuiRuntimeConnection, () => void>();

/** Recheck after asynchronous turn preparation, immediately before submission. */
export function assertConnectionConfigurationCurrent(connection: GuiRuntimeConnection): void {
  connectionConfigurationChecks.get(connection)?.();
}

/** 连接期生效模型（会话覆盖 > 模式钉住（缺一侧回落全局）> 全局激活配置） */
export interface ConnectionEffectiveModel {
  providerId: string;
  modelId: string;
  params?: Array<{ id: string; value: string; }>;
}

/**
 * 生效模型与连接键（纯函数；键是模型切换重建判据，缓存键语义——改键=改行为）。
 * codex / claude 等只取会话覆盖，否则跟随各自 CLI 配置；
 * ACP 的预设 ID 与会话模型 ID 分开参与连接键。
 */
export function resolveConnectionModel(opts: {
  runtimeId: string;
  session: SessionMeta | undefined;
  llmNow: { provider: { id: string; }; model: { id: string; }; };
  resolvedMode: ResolvedEngineMode | null;
}): { effModel: ConnectionEffectiveModel; modelKey: string; } {
  const { runtimeId, session, llmNow, resolvedMode } = opts;
  const effModel: ConnectionEffectiveModel =
    ['codex-gui', 'claude', 'pi-external', 'omp', 'muse-gui', 'zcode-gui'].includes(runtimeId)
        ? { providerId: runtimeId, modelId: session?.modelOverride?.modelId?.trim() || '' }
        : runtimeId === 'acp'
          ? {
              providerId: 'acp',
              modelId: session?.modelOverride?.modelId?.trim() || ''
            }
        : session?.modelOverride
        ? {
            providerId: session.modelOverride.providerId,
            modelId: session.modelOverride.modelId
          }
        : resolvedMode?.connectExtras.modelOverride
          ? {
              providerId:
                  (resolvedMode.connectExtras.modelOverride as { providerId?: string; }).providerId ||
                llmNow.provider.id,
              modelId:
                  (resolvedMode.connectExtras.modelOverride as { modelId?: string; }).modelId ||
                llmNow.model.id
            }
          : { providerId: llmNow.provider.id, modelId: llmNow.model.id };
  const modelKey =
    runtimeId === 'acp'
        ? JSON.stringify([effModel.providerId, session?.piModeId?.trim() || '', effModel.modelId])
        : `${effModel.providerId}/${effModel.modelId}`;
  return { effModel, modelKey };
}

export function ensureConnection(host: HostCore, entry: SessionEntry): Promise<GuiRuntimeConnection> {
  if (entry.connecting) return entry.connecting;
  let pending: Promise<GuiRuntimeConnection>;
  pending = prepareConnection(host, entry).finally(() => {
    if (entry.connecting === pending) entry.connecting = null;
  });
  entry.connecting = pending;
  return pending;
}

async function prepareConnection(host: HostCore, entry: SessionEntry): Promise<GuiRuntimeConnection> {
  if (entry.permissionStrategySwitch) throw new Error('Harness 正在切换权限策略，请稍后重试');
  // Keep the session editable so an incompatible imported/created mode can be repaired.
  if (entry.runtimeId === 'pi' && !supportsGuiPermissionMode(entry.runtimeId, entry.mode)) {
    return Promise.reject(new Error(t('当前引擎不支持此权限档，请更换权限档后重试')));
  }
  const session = host.ctx.sessions.get(entry.sessionId);
  const registrySession = host.ctx.sessions.peek?.(entry.sessionId);
  // 会话选定的引擎侧模式（Pi 自定义模式）：经 driver 合同解析，宿主不感知引擎细节
  const resolvedMode = session?.piModeId
    ? (getDriver(host, entry.runtimeId)?.resolveMode?.(session.piModeId) ?? null)
    : null;
  if (session?.piModeId && !resolvedMode) {
    if (entry.runtimeId === 'acp') throw new Error(t('ACP 引擎「{{id}}」不可用，请恢复注册或新建会话', { id: session.piModeId }));
    log(
      host,
      entry,
      'warn',
      t('自定义模式「{{id}}」不可用（损坏？），本次以标准模式连接', { id: session.piModeId })
    );
  }
  // 生效模型与连接键按 runtime 解析；ACP 跟随其 CLI 配置或会话覆盖。
  const cfg = host.ctx.config.get();
  const llmSnapshot = entry.runtimeId === 'pi' ? { ...cfg, llm: structuredClone(cfg.llm) } : cfg;
  const catalogCwd = session && sessionModelSourceCwd(cfg, session);
  const llmNow = resolveLlmConfig(cfg);
  const capturedContext = entry.turnWorkspaceContext ?? (session ? captureWorkspaceExecutionContext(cfg, session, host.ctx.sessions.rootDependencyRoster?.() ?? host.ctx.sessions.list?.()) : undefined);
  const workspaceContext = host.store?.withAttachmentReadAccess?.(entry.sessionId, capturedContext) ?? capturedContext;
  const executionCwd = workspaceContext?.cwd ?? session?.cwd ?? entry.cwd;
  const workspaceKey = JSON.stringify(workspaceContext ?? null);
  const resolved = resolveConnectionModel({ runtimeId: entry.runtimeId, session, llmNow, resolvedMode });
  const driver = getDriver(host, entry.runtimeId);
  const configurePermissions = session?.configurePermissions === true || !!session?.workerRouting?.attempts.at(-1)?.crossHarness;
  const originalIdentity = JSON.stringify([session?.configurePermissions, session?.runtime, session?.cwd, session?.piModeId, session?.modelOverride, driver?.connectionVersion]);
  const modeModel = entry.runtimeId === 'pi' ? resolvedMode?.connectExtras.modelOverride as SessionMeta['modelOverride'] : undefined;
  const explicit = session?.modelOverride ?? (modeModel ? resolved.effModel : undefined);
  const admitted = await host.modelAdmission.resolve(entry.runtimeId, catalogCwd ?? session?.cwd ?? entry.cwd, session?.piModeId, explicit,
    entry.runtimeId === 'pi' ? resolved.effModel : undefined);
  // Pi sessions retain their ModelRuntime model and credentials. Reconcile at the
  // next turn boundary, including same-ID edits from tools that bypass settings IPC.
  const llmSelection = session?.modelOverride ?? modeModel ?? admitted;
  const llmIdentity = entry.runtimeId === 'pi'
    ? llmConnectionIdentity(resolveLlmConfig(llmSnapshot, llmSelection)) : undefined;
  const assertLlmCurrent = () => {
    if (llmIdentity !== undefined &&
        llmConnectionIdentity(resolveLlmConfig(host.ctx.config.get(), llmSelection)) !== llmIdentity) {
      throw new Error(t('模型连接配置在准备期间变化，请重试'));
    }
  };
  assertLlmCurrent();
  const current = host.ctx.sessions.get(entry.sessionId);
  if (originalIdentity !== JSON.stringify([current?.configurePermissions, current?.runtime, current?.cwd, current?.piModeId, current?.modelOverride, getDriver(host, entry.runtimeId)?.connectionVersion])) {
    throw new Error(t('会话配置在模型校验期间变化，请重试'));
  }
  const effModel: ConnectionEffectiveModel = admitted ?? resolved.effModel;
  if (admitted) host.modelAdmission.assert(entry.runtimeId, session?.piModeId, admitted);
  // Parameter descriptions must follow the model actually selected for this turn.
  if (admitted && entry.turnModelParameters &&
      (entry.turnModelParameters.modelId !== admitted.modelId || entry.turnModelParameters.providerId !== admitted.providerId)) {
    const parameters = await parameterSnapshot(host, entry.sessionId, admitted);
    assertLlmCurrent();
    const hasOverrides = !!session?.thinkingLevel || Object.keys(session?.modelParameters ?? {}).length > 0;
    const hasProfiles = hasConfiguredModelParameterDefault(parameters, host.ctx.config.get().modelParameterProfiles ?? []);
    if (parameters.unavailable && (hasOverrides || hasProfiles)) throw new Error(t('模型参数尚未读取，请手动刷新模型目录后重试'));
    entry.turnModelParameters = parameters;
    Object.freeze(parameters.values);
    host.modelAdmission.assert(entry.runtimeId, session?.piModeId, admitted);
    const latest = host.ctx.sessions.get(entry.sessionId);
    if (originalIdentity !== JSON.stringify([latest?.configurePermissions, latest?.runtime, latest?.cwd, latest?.piModeId, latest?.modelOverride, getDriver(host, entry.runtimeId)?.connectionVersion])) {
      throw new Error(t('会话配置在模型校验期间变化，请重试'));
    }
  }
  const baseModelKey = admitted
    ? entry.runtimeId === 'acp' ? JSON.stringify([effModel.providerId, session?.piModeId?.trim() || '', effModel.modelId]) : `${effModel.providerId}/${effModel.modelId}`
    : resolved.modelKey;
  const usageModelKey = usageModelSelectionKey(session?.modelOverride);
  const version = driver?.connectionVersion;
  const parameterKey = entry.turnModelParameters?.reconnectKey ?? '[]';
  const coreReasoning = entry.runtimeId === 'pi' && entry.turnModelParameters ? entry.turnModelParameters.coreReasoning ?? null : undefined;
  // Some engines bind their permissions at process start. Plan execution and
  // its eventual reset must therefore be part of the connection identity too.
  const permissionKey = entry.runtimeId === 'pi' && driver?.modeSwitchReconnects
    ? JSON.stringify([entry.mode, entry.planExecuting])
    : entry.runtimeId === 'pi' || driver?.permissionStrategyHot ? '' : String(configurePermissions);
  const modelKey = `${version ? `${baseModelKey}/${version}` : baseModelKey}/parameters:${parameterKey}/permissions:${permissionKey}${llmIdentity === undefined ? '' : `/llm:${llmIdentity}`}${coreReasoning ? `/reasoning:${JSON.stringify(coreReasoning)}` : ''}`;
  // 模型切换重建（Cherry reconcile 的精简版）：连接建立时的生效 provider/model 与当前
  // 不一致 → 拆旧连接（含 MCP），本轮用新模型新建。切模型即「下回合生效」。
  if (entry.closed || entry.clearing || entry.abortRequested) throw new Error(t('会话已关闭或正在清空'));
  if (entry.connection) {
    if (entry.connectionModelKey === modelKey && entry.connectionWorkspaceKey === workspaceKey) {
      connectionConfigurationChecks.set(entry.connection, assertLlmCurrent);
      if (entry.pendingUsageModelKey === usageModelKey) entry.pendingUsageModelKey = undefined;
      return Promise.resolve(entry.connection);
    }
    log(
      host,
      entry,
      'info',
      `连接配置已变化（模型或工作区目录），重建连接（历史经 resume token 续聊）`
    );
    retireConnection(host, entry);
  }
  if (entry.forkResumeGuard && !session?.runtimeResumeToken) {
    return Promise.reject(new Error('分叉上下文已投递，但引擎没有提供可恢复的会话标识；请检查原生历史后新建会话'));
  }
  if (!driver) {
    if (entry.runtimeId === 'cursor') {
      return Promise.reject(new Error('此 Cursor 旧会话使用已移除的 SDK，原生上下文无法通过 ACP 安全恢复；历史仍可查看，请新建 Cursor 会话'));
    }
    return Promise.reject(
      new Error(t('GUI runtime「{{id}}」的 driver 未注册（应用初始化异常）', { id: entry.runtimeId }))
    );
  }
  // 会话事实以 sessions 注册表为准（cwd/worktree 可能在隔离派活后回填）
  if (session) {
    entry.cwd = session.cwd ?? entry.cwd;
    entry.worktreePath = session.worktreePath ?? entry.worktreePath;
  }

  const retired = retirementBarrier(host, entry.sessionId);
  return (async () => {
    await retired;
    assertLlmCurrent();
    if (entry.closed || entry.clearing) throw new Error(t('会话已关闭或正在清空'));
    entry.connectionModelKey = modelKey;
    entry.connectionWorkspaceKey = workspaceKey;
    // B2（capability-delivery-mcp-relay-plan）：pi 的进程内 MCP 代理桥已退役——
    // 第三方 MCP 不再直连引擎，经宿主中转（mcp.search/mcp.call）。
    const extensionAgent = host.ctx.extensionSystem?.agent;
    const taskResources = session?.meta?.extensionTask ? await host.ctx.extensionSystem?.extensionHost.projectTaskResources(session) : undefined;
    const extensionTools = taskResources?.tools ?? extensionAgent?.extensionToolsForSession(entry.sessionId) ?? [];
    const legacyToolset = buildSessionToolset(host.ctx, {
      runtimeId: entry.runtimeId as ChatRuntimeId,
      extraHostTools: [...(resolvedMode?.extraHostTools ?? []), ...extensionTools],
      hostToolDeny: resolvedMode?.hostToolDeny,
      sessionIdentity: { sessionId: entry.sessionId, cwd: executionCwd }
    });
    let activeConnection: GuiRuntimeConnection | undefined;
    const requestApproval: GuiDriverConnectInput['requestApproval'] = (req, signal) => {
      const turn = entry.activeExecutionTurnId;
      const isCurrent = () => {
        const row = host.ctx.sessions.get(entry.sessionId);
        return !!row && !row.archived && !!turn && entry.activeExecutionTurnId === turn && entry.busy &&
          !entry.closed && !entry.abortRequested && !!activeConnection && entry.connection === activeConnection &&
          host.entries.get(entry.sessionId) === entry;
      };
      return handleApprovalRequest(host, entry, req, signal, isCurrent);
    };
    const requestUserQuestion: NonNullable<GuiDriverConnectInput['requestUserQuestion']> = (req, signal) => handleUserQuestionRequest(host, entry, req, signal);
    const getTurnId = () => entry.busy && !entry.closed && !entry.abortRequested ? entry.activeExecutionTurnId : undefined;
    const getDesktopTurnId = () => entry.busy && !entry.closed && !entry.abortRequested ? entry.activeDesktopTurnId : undefined;
    const getPolicyState: GuiDriverConnectInput['getPolicyState'] = () => ({ mode: entry.mode, planExecuting: entry.planExecuting, allowedPrompts: entry.planAllowedPrompts });
    const publicTools = getChatCapabilities(entry.runtimeId).hostToolsAvailable === false ? []
      : buildProjectedGuiTools(host.ctx, { sessionId: entry.sessionId, cwd: executionCwd, workspaceContext,
        hostTools: legacyToolset.hostTools, requestApproval, requestUserQuestion, getTurnId, getDesktopTurnId, getPolicyState,
        nativePermissions: entry.runtimeId !== 'pi',
        getMemoryAuthority: () => entry.memoryAuthority,
        beginTool: () => {
          entry.activeWorkerHostTools = (entry.activeWorkerHostTools ?? 0) + 1;
          return () => { entry.activeWorkerHostTools = Math.max(0, (entry.activeWorkerHostTools ?? 1) - 1); };
        } });
    const toolset = { ...legacyToolset, hostTools: publicTools,
      hostClassOf: (id: string) => publicTools.find(tool => tool.id === id)?.permissionClass };
    entry.toolset = toolset;
    // Pi 在逐轮钩子更新记忆，其他引擎在完整宿主说明中携带首次快照。
    // 主工作区管理根可能与当前执行目录不同（隔离 worktree）。
    const workspace = cfg.workspaces.find(w => w.id === workspaceContext?.workspaceId);
    const wsRoot = workspaceContext?.controlRoot ?? (workspace ? controlRootFor(workspace) : entry.cwd);
    const includeHostIntro = !prepareHostIntro(host, entry, session).delivered;
    let memorySection = '';
    try {
      if (includeHostIntro && entry.runtimeId !== 'pi') {
        const svc = getMemoryService();
        memorySection = svc
          ? svc.injectKnowledge(wsRoot, 'worker').text
          : (console.error('[memory] MemoryService 未装配（应恒装配）——本轮空注入'), '');
      }
    } catch (err) {
      console.error('[memory] worker 注入失败——本轮空注入', err);
      memorySection = '';
    }
    // 模式 persona 单独物化，内置 Pi 仍通过系统层投递。
    const persona = resolvedMode?.persona;
    const directoryNote = entry.runtimeId === 'acp' && session?.piModeId === 'cursor'
      ? 'Cursor registers writable roots with --add-dir. Its own settings govern native access.'
      : getChatCapabilities(entry.runtimeId).directories.note;
    const workspaceSection = includeHostIntro && workspaceContext
      ? renderWorkerDirectoryScope(workspaceContext, directoryNote)
      : '';
    const workerPrompt = includeHostIntro ? materializeGuiWorkerPrompt(
      { id: entry.sessionId, cwd: executionCwd, worktreePath: entry.worktreePath, parentSessionId: session?.parentSessionId },
      entry.mode,
      toolset,
      {
        rules: cfg.agentRules, memorySection, workspaceContext, workspaceSection,
        piLoadsProjectContext: resolvedMode?.connectExtras.contextFiles !== false && !resolvedMode?.connectExtras.systemPromptReplace
      }
    ) : undefined;
    const extensionPrompt = taskResources?.prompt ?? extensionAgent?.extensionPromptForSession(entry.sessionId);
    const isExtensionAgentSession = !taskResources && !!extensionPrompt;
    const workerIntro = workerPrompt?.text ?? '';
    const systemPromptAppend = [persona, extensionPrompt].filter(Boolean).join('\n\n');
    let conn: GuiRuntimeConnection;
    const configIdentity = session && entry.runtimeId !== 'pi' ? nativeConfigIdentity(host, session) : undefined;
    const route = session?.workerRouting;
    const attempt = route?.attempts.at(-1);
    const consent = attempt?.crossHarness;
    const isManual = () => host.ctx.sessions.get(entry.sessionId)?.configurePermissions === true || !!consent;
    const getNativePermissionRestore = () => {
      const restore = host.ctx.sessions.get(entry.sessionId)?.nativePermissionRestore;
      return isManual() && !consent && restore && configIdentity && sameNativeConfigIdentity({ ...restore.identity, version: configIdentity.version }, configIdentity)
        ? restore.selections : undefined;
    };
    const saved = session?.nativeConfig;
    const restore = !driver.permissionStrategyHot && getNativePermissionRestore();
    const nativeIntent = restore && configIdentity ? { identity: configIdentity, selections: restore }
      : isManual() && (!session?.runtimeResumeToken || consent || entry.runtimeId === 'omp') ? saved : undefined;
    const onNativePermissionRestore: GuiDriverConnectInput['onNativePermissionRestore'] = configIdentity ? async (selections) => {
      const current = host.ctx.sessions.peek(entry.sessionId);
      if (!current || current !== registrySession || current.archived || entry.closed ||
          !sameNativeConfigIdentity(configIdentity, nativeConfigIdentity(host, current)) || (!!selections === isManual())) {
        throw new Error('Permission configuration changed while connecting.');
      }
      const previous = current.nativePermissionRestore;
      const accepted = previous && sameNativeConfigIdentity(previous.identity, configIdentity) ? previous.selections : [];
      const next: NativeConfigIntent | undefined = selections
        ? { identity: configIdentity, selections: [...accepted, ...selections.filter(item => !accepted.some(saved => saved.id === item.id))] }
        : undefined;
      if ((!selections && !previous) || (selections && next?.selections.length === accepted.length)) return;
      await host.ctx.sessions.updateNativePermissionRestore(entry.sessionId, next, () => {
        if (host.ctx.sessions.peek(entry.sessionId) !== current || entry.closed ||
            !sameNativeConfigIdentity(configIdentity, nativeConfigIdentity(host, current)) ||
            (!!selections === isManual()) || current.nativePermissionRestore !== previous) {
          throw new Error('Permission configuration changed while connecting.');
        }
      });
    } : undefined;
    if (nativeIntent && (!configIdentity || !sameNativeConfigIdentity(nativeIntent.identity, configIdentity))) {
      throw new Error(t('引擎或来源已变更，请刷新设置后重新选择'));
    }
    let workerPermission: GuiDriverConnectInput['workerPermission'];
    if (consent && route && attempt) {
      const target = await resolveSessionTarget(host.ctx.config.get(), route.plan.scope);
      const candidate = route.plan.candidates.find(item => item.memberId === attempt.memberId && item.crossHarness?.binding === consent.binding &&
        JSON.stringify(item.config) === JSON.stringify(attempt.config));
      if (!candidate || !driver.captureWorkerPermission || !nativeIntent || route.crossHarnessRestricted || session?.parentSessionId ||
          JSON.stringify(nativeIntent) !== JSON.stringify(consent.nativeConfig)) throw new Error('Worker handoff permissions changed.');
      const checked = await validateWorkerConfig(host.ctx, target, candidate.config, true);
      const snapshot = workerCrossHarnessSnapshot(target, candidate, checked.fingerprint);
      if (!snapshot) throw new Error('Worker handoff approval expired. Confirm the candidate permissions in Settings.');
      const placement = JSON.stringify([session?.worktreePath, session?.worktreeGroups]);
      const model = JSON.stringify([session?.modelOverride, session?.modelParameters]);
      const assertCurrent = (executionTurn: string) => {
        const latest = host.ctx.sessions.get(entry.sessionId);
        if (!latest || latest.archived || latest.phase?.value === 'done' || latest.runtime !== entry.runtimeId || latest.cwd !== entry.cwd ||
            JSON.stringify([latest.worktreePath, latest.worktreeGroups]) !== placement || JSON.stringify([latest.modelOverride, latest.modelParameters]) !== model ||
            !latest.workerRouting || latest.workerRouting.attempts.at(-1)?.attempt !== attempt.attempt ||
            latest.workerRouting.attempts.at(-1)?.crossHarness?.binding !== consent.binding ||
            JSON.stringify(latest.nativeConfig) !== JSON.stringify(consent.nativeConfig) ||
            host.entries.get(entry.sessionId) !== entry || !entry.busy || entry.closed || entry.clearing || entry.abortRequested ||
            !executionTurn || executionTurn !== entry.activeExecutionTurnId || (activeConnection && entry.connection !== activeConnection) ||
            !sameNativeConfigIdentity(consent.nativeConfig.identity, nativeConfigIdentity(host, latest))) {
          throw new Error('Worker handoff permissions changed or the handoff was cancelled.');
        }
        assertWorkerRouteCurrent(host.ctx, target, route.plan);
      };
      assertCurrent(entry.activeExecutionTurnId ?? '');
      workerPermission = { snapshot, assertCurrent };
    }
    try {
      assertLlmCurrent();
      conn = await driver.connect({
        nativeConfig: nativeIntent,
        automaticPermissions: !configurePermissions,
        onNativePermissionRestore,
        getAutomaticPermissions: () => !isManual(),
        getNativePermissionRestore,
        workerPermission,
        nativePermissions: entry.runtimeId !== 'pi',
        modelCatalogCwd: catalogCwd,
        managedWorkerRouting: !!session?.workerRouting,
        sessionId: entry.sessionId,
        ...(session?.taskId ? { taskId: session.taskId } : {}),
        ...(session?.name ? { sessionName: session.name } : {}),
        cwd: executionCwd,
        ...(entry.runtimeId === 'pi'
          ? { memoryInject: { root: wsRoot, sessionId: entry.sessionId }, contextCompression: cfg.autoCompact }
          : {}),
        // 扩展 Agent 是面板内助手：技能面收窄到 manifest 声明，不继承托管技能库。
        ...(isExtensionAgentSession ? { extensionAgentSkills: true } : {}),
        // 引擎侧模式附加段（单源映射）；生效模型（会话覆盖 > 模式钉住 > 全局）覆盖其中的部分钉住对
        ...resolvedMode?.connectExtras,
        systemPromptAppend,
        firstPromptPrefix: workerIntro,
        // The host snapshot wins over mode extras; neither modes nor models grant directories.
        workspaceContext,
        modelParameters: entry.turnModelParameters?.values,
        ...(coreReasoning !== undefined ? { coreReasoning } : {}),
        modelOverride: {
          providerId: effModel.providerId,
          modelId: effModel.modelId,
          ...('params' in effModel && effModel.params ? { params: effModel.params } : {})
        },
        ...(entry.runtimeId === 'pi' ? {
          modelSelectionIntent: session?.modelOverride ??
            (resolvedMode?.connectExtras.modelOverride as GuiDriverConnectInput['modelOverride'] | undefined) ?? admitted ?? null
        } : {}),
        mode: entry.mode,
        planExecuting: entry.planExecuting,
        permissionMode: derivePermissionMode(entry.mode, entry.planExecuting),
        modeController: entry.modeController,
        resumeToken: session?.runtimeResumeToken,
        hasPriorConversation: !entry.workerRouteHandoff && (
          entry.messages.some((message) => message.role === 'assistant' && message.id !== entry.assistant?.id) ||
          entry.messages.filter((message) => message.role === 'user' && !message.queued).length > 1),
        forkTranscriptPending: !!(entry.forkTranscriptSource || entry.forkTranscript),
        seedSource:
          !session?.runtimeResumeToken && entry.forkSeed ? host.store.forkSeedSource(entry.sessionId,entry.forkSeed) : undefined,
        hostTools: toolset.hostTools,
        requestApproval,
        requestUserQuestion,
        getTurnId,
        getDesktopTurnId,
        getPolicyState,
        ...(driver.thinkingPolicy === 'hot'
          ? { getThinkingLevel: () => entry.thinkingLevel }
          : {}),
        log: (level, msg) => log(host, entry, level, msg)
      });
    } catch (e) {
      // connect 失败直接上抛；Host 以连接重建路径兜底（本函数不再预建任何需回收的资源）
      if (e instanceof ConnectionCleanupError) markRetirementFailure(host, entry.sessionId, e);
      throw e;
    }
    if (entry.closed || entry.clearing) {
      // close/release 抢在 connect 落地前执行：这条迟到连接无人认领，就地回收，
      // 否则引擎子进程可能常驻泄漏
      try {
        await conn.close();
      } catch (error) {
        throw new ConnectionCleanupError(`迟到的引擎连接回收失败：${String(error)}`);
      }
      throw new Error(t('会话已关闭'));
    }
    try {
      assertLlmCurrent();
      host.modelAdmission.assert(entry.runtimeId, session?.piModeId, admitted ?? (effModel.modelId ? effModel : undefined));
    } catch (error) {
      try { await conn.close(); } catch (closeError) { throw new ConnectionCleanupError(t('模型校验失败后连接回收失败：{{detail}}', { detail: String(closeError) })); }
      throw error;
    }
    entry.connectionAdmissionModel = admitted ?? (effModel.modelId ? effModel : undefined);
    connectionConfigurationChecks.set(conn, assertLlmCurrent);
    entry.connection = conn;
    entry.pendingHostIntro = workerIntro ? {
      context: entry.runtimeId === 'pi' ? formatGuiHostContext(workerIntro)
        : firstGuiUserMessageContext({ firstPromptPrefix: workerIntro, systemPromptAppend })
    } : undefined;
    activeConnection = conn;
    entry.nativeConfigIdentity = configIdentity;
    if (configIdentity) publishNativeConfig(host, entry, conn.getNativeConfig?.() ?? { status: 'uninitialized', options: [] });
    if (entry.pendingUsageModelKey === usageModelKey &&
        usageModelSelectionKey(host.ctx.sessions.get(entry.sessionId)?.modelOverride) === usageModelKey) {
      entry.pendingUsageModelKey = undefined;
    }
    // Harness 透明·注入快照入信封（§4.4 + §7 落地）：物化产物 + 引擎真身（系统提示词/
    // 工具目录）一起记代际。pi 的记忆段不在此记——记忆走 modeHooks 逐轮注入，连接时
    // 预记的是旧文本；逐轮钩子首轮以 injection-update 报到真实渲染文本（含快照 caveat）。
    // 冷启动连接服务于当前回合：快照时刻回填当前回合用户消息 ts，首条消息即命中第一代
    //（此前物化晚于用户消息落转写，首回合永远缺卡——透明模式首轮缺卡根因）。
    recordInjectionSnapshot(
      host,
      entry,
      workerPrompt?.policy ?? '',
      memorySection,
      persona,
      conn.engineCapture,
      currentTurnUserTs(entry),
      workspaceSection
    );
    // 种子已被引擎消费（连接即回放完成），一次性清除。
    // 回放用的 ZERO_USAGE 占位不可写入 lastUsage，等本会话第一回合收口。
    if (entry.forkSeed && !entry.clearing && !entry.closed) {
      // The Pi worker publishes a complete native seed atomically and checks an
      // already-published seed on reconnect, so this operation is idempotent.
      // Keep the immutable spool and pending marker until the native token
      // event is durably recorded; a crash can verify/reuse the published seed.
      entry.skipUsagePersistUntilTurn = true;
    }
    // 每连接只挂一个泵：error 后连接可复用，再次 ensureConnection 命中
    // 同一连接时不得重复 consumeEvents——双泵会瓜分后续事件
    if (!host.pumpedConns.has(conn)) {
      host.pumpedConns.add(conn);
      consumeEvents(host, entry, conn);
    }
    return conn;
  })();
}
