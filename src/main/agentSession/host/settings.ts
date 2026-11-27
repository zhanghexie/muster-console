import { resolveChatHistoryWindow } from '../../../shared/chatHistory';
import { guiReplyLine } from '../../../shared/boardReplyPreview';
import { isOpen, materializeForExecution } from './lifecycle';
import { initialGuiWorkerMode } from './internal';
/**
 * AgentSessionHost 会话设置面：模式（default/ask/plan/auto）、会话级思考档、
 * Pi/ACP 自定义模式、会话级模型覆盖、计划卡操作、历史读取与多模态守卫。
 * 快照型引擎（Cursor）切档/切模型须拆连接的守卫语义在此收口。
 */
import { GUI_THINKING_LEVELS } from '../../../shared/thinkingLevels';
import { modelParameterOptions } from '../../../shared/modelParameters';
import { describeParameters, setModelParameters } from './modelParameters';
import type { GuiThinkingLevel, GuiWorkerMode, SessionMeta } from '../../../shared/types';
import type { GuiSessionSnapshot } from '../persist';
import { isChatRuntimeId, getChatCapabilities } from '../../../shared/agentRuntimeCapabilities';
import {
  decideSetModel,
  decideSetThinking,
  parseModelClearArgs,
  type SessionChangeApplied
} from '../../../shared/sessionModelChange';
import {
  sanitizeRestoredMessages,
  sanitizeRestoredMessagePage,
  isGuiMessagesVersion,
  type GuiWorkerHistory,
  type GuiWorkerHistoryResponse,
  type GuiWorkerHistoryPage
} from '../../../shared/guiWorker';
import { staleUsageView } from '../../../shared/guiContextUsage';
import type { GuiUsageView } from '../../../shared/guiContextUsage';
import { t } from '../../../shared/i18n';
import type { HostCore, SessionEntry } from './internal';
import { resolveAutomaticApprovals } from './approvals';
import { getDriver, log, persistEntry, push, syncEntry } from './base';
import { historyUsage, providerThinkingConfigured, providerThinkingConfiguredFor, usageModelSelectionKey } from './usage';
import { send } from './messaging';
import { guiLiveSequence, guiMessagesVersion } from './messagesVersion';
import { retireConnection } from './retirement';
import { nativeOptionAccepts } from '../../../shared/nativeSessionConfig';
import { supportsGuiPermissionMode } from '../../../shared/guiPermissionOptions';


export async function setConfigurePermissions(host: HostCore, sessionId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  const session = host.ctx.sessions.get(sessionId);
  if (!session || !session.runtime || session.archived || (host.ctx.sessions.isChatRuntime(session.runtime) && !isOpen(host, sessionId))) {
    return { ok: false, error: t('Harness 会话未打开') };
  }
  const entry = host.entries.get(sessionId);
  if (entry?.permissionStrategySwitch) return { ok: false, error: t('Harness 正在切换权限策略，请稍后重试') };
  if ((session.configurePermissions === true) === enabled) return { ok: true };

  const validate = () => {
    const current = host.entries.get(sessionId);
    if ((entry && (current !== entry || entry.closed)) || current?.clearing || current?.workerSwitch || session.workerRouting?.attempts.at(-1)?.crossHarness) {
      throw new Error(t('当前会话无法更改权限配置，请稍后重试'));
    }
    const driver = getDriver(host, session.runtime ?? '');
    if (current?.nativeConfigPending) throw new Error(t('Harness 正在更新权限选项，请稍后重试'));
    if (enabled && session.runtime !== 'pi' && (current?.connecting || (current?.busy && (!driver?.permissionStrategyHot || session.nativePermissionRestore)))) {
      throw new Error(t('当前 Harness 正在运行，请等待回合结束后开启权限配置'));
    }
  };
  if (entry) entry.permissionStrategySwitch = true;
  let restored = false;
  try {
    validate();
    if (enabled && entry?.connection?.restorePermissionStrategy && session.nativePermissionRestore) {
      await entry.connection.restorePermissionStrategy(session.nativePermissionRestore.selections);
      restored = true;
    }
    await host.ctx.sessions.updateConfigurePermissions(sessionId, enabled, validate, () => {
      const current = host.entries.get(sessionId);
      const committed = host.ctx.sessions.get(sessionId);
      if (current?.runtimeId === 'pi' && committed?.runtime === 'pi') {
        applyCorePermissionMode(current, initialGuiWorkerMode(committed));
      }
    }, () => {
      if (restored) return undefined;
      const snapshot = host.entries.get(sessionId)?.nativeConfig;
      const mode = snapshot?.options.find(option => option.id === 'permissionMode');
      if (!enabled && session.runtime === 'claude' && snapshot && mode && nativeOptionAccepts(mode, mode.currentValue)) {
        return { identity: snapshot.identity, selections: [{ id: mode.id, value: mode.currentValue }] };
      }
      return session.nativePermissionRestore;
    });

    const current = host.entries.get(sessionId);
    if (current) {
      if (!enabled) resolveAutomaticApprovals(host, current);
      if (current.runtimeId !== 'pi' && !current.busy) {
        const driver = getDriver(host, current.runtimeId);
        if (!driver?.permissionStrategyHot) retireConnection(host, current);
        else if (!enabled && current.connection?.refreshPermissionStrategy) {
          try { await current.connection.refreshPermissionStrategy(); }
          catch (error) { log(host, current, 'warn', String(error)); }
        }
      }
      persistEntry(host, current, [current.messages.find(message => message.id === current.planMessageId)]);
      syncEntry(host, current);
    }
    const committed = host.ctx.sessions.get(sessionId);
    if (committed?.runtime === 'pi') {
      push(host, { kind: 'permission-mode', sessionId, mode: current?.runtimeId === 'pi' ? current.mode : initialGuiWorkerMode(committed) });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (entry) entry.permissionStrategySwitch = false;
  }
}

/**
 * 切换会话模式（default/ask/plan/auto，与调度模式体系同源）——即时生效：
 * Pi 的 mode 扩展 fire-time 读控制器状态（工具集禁用/回合提示），审批门控同样 fire-time。
 * 离开 plan 时清计划状态；执行中的卡落回待确认，其余卡片保留原状。
 */
export async function setMode(
  host: HostCore,
  sessionId: string,
  mode: GuiWorkerMode
): Promise<{ ok: boolean; error?: string }> {
  const entry = host.entries.get(sessionId);
  if (!entry) {
    const session=host.ctx.sessions.get(sessionId);
    if(!session||!isOpen(host,sessionId))return {ok:false,error:t('GUI 会话未打开')};
    if(!['default','ask','plan','auto','standard','accept-edits','auto-review'].includes(mode))return {ok:false,error:t('未知模式: {{mode}}',{mode})};
    // 冷态（无 entry/连接）切档只是把偏好持久化到 session.guiMode（getMode 读它）；
    // 引擎是否真的支持该档要在有 entry 的运行时路径按 supportsGuiPermissionMode 校验，
    // 否则 codex-gui 等 GUI 会话在冷浏览时连档位都无法预设。
    if (!isChatRuntimeId(session.runtime ?? '')) return { ok: false, error: t('当前引擎暂不支持此权限档') };
    host.ctx.sessions.updateGuiMode(sessionId,mode);
    return {ok:true};
  }
  if (mode !== 'default' && mode !== 'ask' && mode !== 'plan' && mode !== 'auto' && mode !== 'standard' && mode !== 'accept-edits' && mode !== 'auto-review') {
    return { ok: false, error: t('未知模式: {{mode}}', { mode }) };
  }
  if (!supportsGuiPermissionMode(entry.runtimeId, mode)) {
    return { ok: false, error: t('当前引擎暂不支持此权限档') };
  }
  const session = host.ctx.sessions.get(sessionId);
  if (session?.configurePermissions === true) {
    const wasPlanExecuting = applyCorePermissionMode(entry, mode);
    if (wasPlanExecuting) persistEntry(host, entry, [entry.messages.find(message => message.id === entry.planMessageId)]);
    syncEntry(host, entry);
  }
  host.ctx.sessions.updateGuiMode(sessionId, mode);
  return { ok: true };
}

function applyCorePermissionMode(entry: SessionEntry, mode: GuiWorkerMode): boolean {
  entry.mode = mode;
  const wasPlanExecuting = entry.planExecuting;
  entry.planExecuting = false;
  // ModeController 只认调度 AgentMode；auto 的「全放行」由审批层派生，控制器置 default
  entry.modeController.setMode(mode === 'auto' || mode === 'standard' || mode === 'accept-edits' || mode === 'auto-review' ? 'default' : mode);
  // 同档重选（plan→plan）时上一行早退不清执行标志：手动复位并重套只读工具面，
  // 否则写工具仍解锁、下回合仍注入「继续执行」上下文，与卡已退回待确认相悖
  if (wasPlanExecuting && entry.modeController.executing) {
    entry.modeController.executing = false;
    entry.modeController.applyTools?.();
  }
  // 执行中切档：planExecuting/planSteps 已清，finishTurn 的复位条件与进度扫描
  // 从此永不再命中——执行中的卡必须在此落回待确认（保留已勾进度），否则是
  // 永久「执行中」死卡（无按钮、切回 plan 也不恢复）
  if (wasPlanExecuting) {
    const planMsg = entry.messages.find((m) => m.id === entry.planMessageId);
    if (planMsg?.plan && planMsg.plan.status === 'executing') {
      planMsg.plan = { ...planMsg.plan, status: 'pending' };
    }
  }
  return wasPlanExecuting;
}

export function getMode(host: HostCore, sessionId: string): GuiWorkerMode | null {
  const entry=host.entries.get(sessionId);
  const session=host.ctx.sessions.get(sessionId);
  // 冷浏览（无 entry）时权限档来自会话落盘的 guiMode——setMode 的冷态分支正是写它；
  // initialGuiWorkerMode 只作旧数据兜底（对非 pi 引擎恒返回 default，会丢掉显式档位）。
  return entry?.mode ?? (session && isOpen(host, sessionId) ? session.guiMode ?? initialGuiWorkerMode(session) : null);
}

/**
 * 会话级思考档（Pi GUI 会话；五档 off/low/medium/high/max）。
 * 每回合热读生效（driver setThinkingLevel），无需重连；null=跟随默认。
 */
export async function setThinkingLevel(
  host: HostCore,
  sessionId: string,
  level: GuiThinkingLevel | null
): Promise<{ ok: boolean; error?: string; applied?: SessionChangeApplied }> {
  const session = host.ctx.sessions.get(sessionId);
  const runtimeId = (host.entries.get(sessionId)?.runtimeId ?? session?.runtime ?? '') as string;
  if (!isChatRuntimeId(runtimeId)) {
    return { ok: false, error: t('仅 GUI 会话支持会话级思考档') };
  }
  const driver = getDriver(host, runtimeId);
  const policy =
    driver?.thinkingPolicy ?? getChatCapabilities(runtimeId).thinkingPolicy;
  const entry = host.entries.get(sessionId);
  const d = decideSetThinking({
    isChat: true,
    policy,
    busy: !!entry?.busy,
    hasOpenEntry: !!entry || isOpen(host,sessionId)
  });
  if (!d.ok) {
    return {
      ok: false,
      error:
        d.errorKey === 'unsupported'
          ? t('该会话类型不支持会话级思考档（Cursor 请用模型参数）')
          : t('仅 GUI 会话支持会话级思考档')
    };
  }
  if (level !== null && !GUI_THINKING_LEVELS.includes(level)) {
    return { ok: false, error: t('未知思考档: {{level}}', { level }) };
  }
  if (session?.modelParameters !== undefined) {
    const context = await describeParameters(host, { runtimeId }, session);
    const reasoning = context.parameters.find(c => c.semantic === 'reasoning');
    if (!reasoning) return { ok: false, error: t('该会话类型不支持会话级思考档（Cursor 请用模型参数）') };
    const mapped = level === null ? null : modelParameterOptions(context, host.ctx.config.get().modelParameterProfiles ?? [], reasoning.id).find(o => o.mappedValue === level)?.value;
    if (mapped === undefined) return { ok: false, error: t('未知思考档: {{level}}', { level: level ?? '' }) };
    return setModelParameters(host, sessionId, { [reasoning.id]: mapped });
  }
  if (entry) entry.thinkingLevel = level;
  host.ctx.sessions.updateThinkingLevel(sessionId, level);
  if (entry) syncEntry(host, entry);
  return { ok: true, applied: d.applied };
}

/** Pi 自定义模式名单（内置创造模式 + 用户自建；非 Pi runtime 返回 null） */
export function listPiModes(host: HostCore): Array<{
  id: string;
  name: string;
  description: string;
  trust: 'system' | 'user';
  order: number;
  broken: string | undefined;
}> | null {
  const driver = getDriver(host, 'pi');
  if (!driver?.listPresets) return null;
  return driver.listPresets();
}

export function listAcpAgents(host: HostCore): Array<{
  id: string;
  name: string;
  description: string;
  trust: 'system' | 'user';
  order: number;
  broken: string | undefined;
}> | null {
  const driver = getDriver(host, 'acp');
  if (!driver?.listPresets) return null;
  return driver.listPresets();
}

/**
 * 切换 Pi 自定义模式。空白期锁语义：已有消息即拒绝；空白期切换拆现有
 * 连接（persona 与 modes.* 工具在 connect 期物化，下轮重连生效）。空串=标准（无模式）。
 */
export function setPiMode(host: HostCore, sessionId: string, modeId: string): { ok: boolean; error?: string } {
  const entry = host.entries.get(sessionId);
  const session=host.ctx.sessions.get(sessionId);
  if(!entry&&(!session||!isOpen(host,sessionId)))return {ok:false,error:t('GUI 会话未打开')};
  const runtimeId=entry?.runtimeId??session!.runtime!;
  if (runtimeId !== 'pi' && runtimeId !== 'acp') {
    return { ok: false, error: t('该会话类型不支持自定义模式胶囊') };
  }
  if ((entry?.messages.length??host.store.loadRangeSnapshot(sessionId,0,1).total) > 0) {
    return { ok: false, error: t('对话已开始，模式已锁定（不支持中途切换）') };
  }
  const id = modeId.trim();
  const current = host.ctx.sessions.get(sessionId);
  // An ACP preset is the harness identity, not a user-switchable session mode.
  // Keep a one-time setup path for legacy empty sessions without a preset.
  if (runtimeId === 'acp' && id !== (current?.piModeId?.trim() ?? '') &&
      ((current?.piModeId?.trim() ?? '') !== '' || !!current?.runtimeResumeToken)) {
    return { ok: false, error: t('会话的 Harness 已确定，请新建会话以使用其他 Harness') };
  }
  if (runtimeId === 'acp' && id !== (current?.piModeId?.trim() ?? '') && current?.modelOverride?.modelId?.trim()) {
    return { ok: false, error: t('请先将模型切换为引擎默认，再切换 ACP 引擎') };
  }
  if (id) {
    const roster =
      (runtimeId === 'acp' ? listAcpAgents(host) : listPiModes(host)) ?? [];
    const mode = roster.find((m) => m.id === id);
    if (!mode) return { ok: false, error: t('未知模式: {{mode}}', { mode: id }) };
    if (mode.broken) return { ok: false, error: t('该模式已损坏：{{reason}}', { reason: mode.broken }) };
  }
  host.ctx.sessions.updatePiMode(sessionId, id);
  // 模式自带默认权限档时同步会话档位（不设=保持用户当前档位）
  if (id) {
    const def = getDriver(host, runtimeId)?.resolveMode?.(id);
    if (def?.defaultGuiMode) {
      if (entry && current?.configurePermissions === true) applyCorePermissionMode(entry, def.defaultGuiMode);
      host.ctx.sessions.updateGuiMode(sessionId, def.defaultGuiMode);
    }
  }
  if (entry?.connection) {
    retireConnection(host, entry);
  }
  if(entry) syncEntry(host, entry);
  return { ok: true };
}

/**
 * 会话级模型覆盖：只影响本会话，不动全局配置与其他会话。
 * model=null 清除覆盖恢复引擎默认；设置/清除都拆现有连接，下回合以新模型重建。
 */
export function setSessionModel(
  host: HostCore,
  sessionId: string,
  model: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null
): { ok: boolean; error?: string; applied?: SessionChangeApplied } {
  const change = prepareModelChange(host, sessionId, model);
  if (!change.ok) return change;
  host.ctx.sessions.updateModelOverride(sessionId, change.model);
  notifyModelChange(host, sessionId, change);
  return { ok: true, applied: change.applied };
}

type SessionModelChoice = NonNullable<SessionMeta['modelOverride']> | null;
type ModelChange = { ok: true; model: SessionModelChoice; changedModel: boolean; applied: SessionChangeApplied; dropConnection: boolean }
  | { ok: false; error: string };

function prepareModelChange(host: HostCore, sessionId: string, model: SessionModelChoice, parameterOnly = false): ModelChange {
  const session = host.ctx.sessions.get(sessionId);
  const runtimeId = (host.entries.get(sessionId)?.runtimeId ?? session?.runtime ?? '') as string;
  if (!isChatRuntimeId(runtimeId)) {
    return { ok: false, error: t('仅 GUI 会话支持单独设置模型') };
  }
  const driver = getDriver(host, runtimeId);
  const policy =
    driver?.modelOverridePolicy ??
    getChatCapabilities(runtimeId).modelOverridePolicy;
  const parsed = parseModelClearArgs({
    providerId: model?.providerId,
    modelId: model?.modelId
  });
  const entry = host.entries.get(sessionId);
  const d = decideSetModel({
    isChat: true,
    policy: parameterOnly ? 'reconnect' : policy,
    busy: !!entry?.busy,
    hasOpenEntry: !!entry || isOpen(host,sessionId),
    clearing: !model || parsed.clearing,
    complete: parsed.complete
  });
  if (!d.ok) {
    const err =
      d.errorKey === 'unsupported'
        ? t('该引擎不支持会话级模型覆盖（下次重连也不会改模型）')
        : d.errorKey === 'incomplete'
          ? t('模型信息不完整')
          : t('仅 GUI 会话支持单独设置模型');
    return { ok: false, error: err };
  }
  const nextModel = model && !parsed.clearing ? { providerId: model.providerId, modelId: model.modelId, ...(model.params?.length ? { params: model.params } : {}) } : null;
  const changedModel = usageModelSelectionKey(session?.modelOverride) !== usageModelSelectionKey(nextModel);
  return { ok: true, model: nextModel, changedModel, applied: d.applied, dropConnection: d.dropConnection && !parameterOnly };
}

function notifyModelChange(host: HostCore, sessionId: string, change: Extract<ModelChange, { ok: true }>): void {
  const entry = host.entries.get(sessionId);
  if (change.dropConnection && entry?.connection) {
    retireConnection(host, entry);
  }
  if (change.changedModel && entry) {
    entry.lastUsage = null;
    entry.pendingUsageModelKey = usageModelSelectionKey(change.model);
    persistEntry(host, entry, []);
    push(host, { kind: 'context', sessionId, usage: null });
  }
  if (entry) syncEntry(host, entry);
}

export async function commitPickerModelConfiguration(host: HostCore, sessionId: string,
  model: import('../../../shared/harnessPicker').HarnessPickerModelIdentity | null,
  values: import('../../../shared/modelParameters').ModelParameterValues, assertCurrent: () => void): Promise<import('../../../shared/harnessPicker').SetModelConfigurationResult> {
  let applied: SessionChangeApplied = 'immediate';
  let change: Extract<ModelChange, { ok: true }> | undefined;
  await host.ctx.sessions.commitModelConfiguration(sessionId, model, values, () => {
    assertCurrent();
    const previous = host.ctx.sessions.get(sessionId)?.modelOverride;
    const parameterOnly = (previous?.providerId ?? '') === (model?.providerId ?? '') && (previous?.modelId ?? '') === (model?.modelId ?? '');
    const prepared = prepareModelChange(host, sessionId, model, parameterOnly);
    if (!prepared.ok) throw new Error(prepared.error);
    change = prepared;
    applied = prepared.applied;
  }, () => {
    const entry = host.entries.get(sessionId);
    if (entry) entry.thinkingLevel = null;
    if (change) {
      try { notifyModelChange(host, sessionId, change); }
      catch (error) { console.warn('[agentSession] model configuration notification failed:', error); }
    }
  });
  return { ok: true, applied };
}

/** 计划卡操作：execute 恢复工具并发起执行回合；abandon 丢弃计划回到探索态 */
export async function planAction(
  host: HostCore,
  sessionId: string,
  action: 'execute' | 'abandon'
): Promise<{ ok: boolean; error?: string }> {
  const entry = materializeForExecution(host,sessionId);
  if (!entry) return { ok: false, error: t('GUI 会话未打开') };
  if (entry.busy && (getDriver(host, entry.runtimeId)?.modeSwitchReconnects ?? getChatCapabilities(entry.runtimeId).modeSwitchReconnects)) {
    return { ok: false, error: t('当前回合进行中，请稍后再修改计划状态') };
  }
  const planMsg = entry.messages.find((m) => m.id === entry.planMessageId);
  if (action === 'abandon') {
    entry.modeController.abandonPlan();
    entry.planExecuting = false;
    if (planMsg?.plan) planMsg.plan = { ...planMsg.plan, status: 'abandoned' };
    persistEntry(host, entry, [planMsg]);
    syncEntry(host, entry);
    return { ok: true };
  }
  if (entry.busy) return { ok: false, error: t('当前回合进行中，请稍后再执行计划') };
  const prompt = entry.modeController.executePlan();
  if (!prompt) return { ok: false, error: t('没有可执行的已批准计划') };
  entry.planExecuting = true;
  if (planMsg?.plan) planMsg.plan = { ...planMsg.plan, status: 'executing' };
  persistEntry(host, entry, [planMsg]);
  syncEntry(host, entry);
  await send(host, sessionId, prompt);
  return { ok: true };
}

export function getHistory(
  host: HostCore,
  sessionId: string,
  opts?: { light?: boolean; knownMessagesVersion?: never }
): GuiWorkerHistory | null;
export function getHistory(
  host: HostCore,
  sessionId: string,
  opts: { light?: boolean; knownMessagesVersion?: string } | undefined
): GuiWorkerHistoryResponse | null;
export function getHistory(
  host: HostCore,
  sessionId: string,
  opts?: { light?: boolean; knownMessagesVersion?: string }
): GuiWorkerHistoryResponse | null {
  const entry = host.entries.get(sessionId);
  if (entry) {
    const messagesVersion = guiMessagesVersion(entry);
    const metadata=entryHistoryMetadata(host,entry);
    // The file-change tracker can mutate shared summary arrays across awaits before its final push.
    // Keep those transitional entries, and all clearing/closed entries, on the full snapshot path.
    const reusable = isGuiMessagesVersion(opts?.knownMessagesVersion) && !opts?.light && !entry.closed && !entry.clearing &&
      !entry.messages.some(message => message.turnChanges?.state === 'collecting');
    return reusable && isGuiMessagesVersion(opts?.knownMessagesVersion) && opts.knownMessagesVersion === messagesVersion
      ? { ...metadata, messagesVersion, messagesUnchanged: true }
      : { ...metadata, messagesVersion, messages: entry.messages };
  }
  // 列表里已有 GUI 会话但 Host 尚未 open（竞态/重启后首屏）：仍可读落盘（同样消毒）。
  // light（sessions.search 等纯文本检索）：只取 messages，不读不修 trace——trace 属白读，
  // 对每个未打开会话做 repair 是搜索路径的无谓放大
  const session = host.ctx.sessions.get(sessionId);
  if (!session || !isChatRuntimeId(session.runtime ?? '')) return null;
  const snapshot = host.store.loadSnapshot(sessionId);
  return restoredHistory(host, session, snapshot);
}

function entryHistoryMetadata(host:HostCore,entry:SessionEntry,includeTimeline=true):Omit<GuiWorkerHistory,'messages'>{
  const sessionNow=host.ctx.sessions.get(entry.sessionId);
  return {
      ...(entry.runtimeId === 'pi' ? { mode: entry.mode } : {}),
      busy: entry.busy,
      execution: entry.execution,
      ...(guiLiveSequence(entry) !== undefined ? { liveSeq: guiLiveSequence(entry) } : {}),
      injections: includeTimeline?entry.injections:[],
      compactions: includeTimeline?entry.compactions:[],
      ...(entry.runtimeId === 'pi'
        ? {
            thinkingLevel: entry.thinkingLevel,
            thinkingConfigured: providerThinkingConfigured(host, entry)
          }
        : {}),
      ...(sessionNow?.piModeId ? { piModeId: sessionNow.piModeId } : {}),
      ...(sessionNow?.modelOverride ? { modelOverride: sessionNow.modelOverride } : {}),
      ...((): { usage?: GuiUsageView | null } => {
        const usage = historyUsage(host, entry);
        return usage !== undefined ? { usage } : {};
      })(),
      ...(entry.slashCommands.length ? { slashCommands: entry.slashCommands } : {}),
      ...(entry.engineMode ? { engineMode: entry.engineMode } : {})
    };
}

function restoredHistory(host: HostCore, session: SessionMeta, snapshot: GuiSessionSnapshot, preservePositions=false): GuiWorkerHistory {
  return {
    messages: preservePositions ? sanitizeRestoredMessagePage(snapshot.messages) : sanitizeRestoredMessages(snapshot.messages),
    ...(session.runtime === 'pi' ? { mode: initialGuiWorkerMode(session) } : {}),
    busy: false,
    injections: snapshot.injections,
    compactions: snapshot.compactions,
    ...(session.runtime === 'pi'
      ? {
          thinkingLevel: session.thinkingLevel ?? null,
          thinkingConfigured: providerThinkingConfiguredFor(
            host,
            session.modelOverride?.providerId,
            session
          )
        }
      : {}),
    ...(session.piModeId ? { piModeId: session.piModeId } : {}),
    ...(session.modelOverride ? { modelOverride: session.modelOverride } : {}),
    ...((): { usage?: GuiUsageView } => {
      const usage = session.runtime === 'cursor' ? null : staleUsageView(snapshot.lastUsage);
      return usage ? { usage } : {};
    })()
  };
}

/**
 * Return a bounded GUI history page while keeping the existing full-history
 * contract intact for callers that need metadata or fork/search semantics.
 * The host still owns the authoritative complete transcript. IPC only crosses
 * the requested page, so a long session does not allocate a second full copy
 * in the renderer during initial attach.
 */
export function getHistoryRange(
  host: HostCore,
  sessionId: string,
  before?: number,
  limit = 120,
  targetMessageId?: string
): GuiWorkerHistoryPage | null {
  // Open entries have an in-memory live projection that may contain deltas not
  // flushed to disk yet. Cold entries can read the bounded event projection
  // directly, avoiding a second full message array in the IPC path.
  const entry = host.entries.get(sessionId);
  if (!entry) {
    const session = host.ctx.sessions.get(sessionId);
    if (!session || !isChatRuntimeId(session.runtime ?? '')) return null;
    const range = host.store.loadRangeSnapshot(sessionId, before, limit, targetMessageId);
    if (range.before + range.messages.length === range.total) {
      const preview = guiReplyLine(range.messages);
      if (preview && preview !== session.boardReplyPreview) host.ctx.sessions.setBoardReplyPreview?.(sessionId, preview);
    }
    return {
      ...restoredHistory(host, session, {...range,injections:[],compactions:[]}, true),
      injections:range.injections,compactions:range.compactions,metadataStatus:range.metadataStatus,
      before: range.before,
      total: range.total,
      hasEarlier: range.hasEarlier
    };
  }
  const {start,end}=resolveChatHistoryWindow(entry.messages,before,limit,targetMessageId),messages=entry.messages.slice(start,end);
  const metadata=host.store.metadataForMessages(sessionId,messages);
  return{...entryHistoryMetadata(host,entry,false),...metadata,messages,before:start,total:entry.messages.length,hasEarlier:start>0};
}
