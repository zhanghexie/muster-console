import * as nativeConfig from './nativeConfig';
import {isChatRuntimeId} from '../../../shared/agentRuntimeCapabilities';
/**
 * AgentSessionHost：GUI（chat surface）Worker 会话的宿主。
 * 每会话一条：turn、queue、审批 registry、resume token、持久化；按 session.runtime
 * 从 driverRegistry 取 driver。主进程是审批/消息状态的唯一 writer。
 *
 * 本类是组装壳：实现按「生命周期 / 工具执行 / MCP 桥 / 事件泵」等关注点拆分在
 * 同目录各模块（以 `host: HostCore` 首参接收实例），方法一一委托、行为不变。
 */
import type { AppContext } from '../../context';
import { randomUUID } from 'node:crypto';
import type { DisplayItemSink } from '../../../shared/displayItems';
import type {
  GuiApprovalDecision,
  GuiApprovalRequest,
  GuiCompactResult,
  GuiRuntimeConnection,
  GuiRuntimeDriver,
  GuiRuntimeProbeResult
} from '../types';
import type { GuiSendImage } from '../types';
import type { GuiWorkerPush } from '../../../shared/guiWorker';
import type { GuiThinkingLevel, GuiWorkerMode, SessionMeta } from '../../../shared/types';
import type { ChatTranscriptSource } from '../../../shared/chatMessageSource';
import { sessionModelSourceCwd } from '../harnessCatalogSource';
import type { SessionChangeApplied } from '../../../shared/sessionModelChange';
import { GuiSessionStore } from '../persist';
import { HarnessModelAdmission } from '../harnessModelAdmission';
import { resolveLlmConfig } from '../../config';
import { t } from '../../../shared/i18n';
import type { HostCore, SessionEntry } from './internal';
import * as base from './base';
import * as lifecycle from './lifecycle';
import * as sessionOps from './sessionOps';
import * as messaging from './messaging';
import { acceptMessagingInput, type MessagingInput } from './messagingInput';
import { MESSAGING_SESSION_OWNER } from '../../messaging/sessionAuthority';
import * as approvals from './approvals';
import * as settings from './settings';
import * as observation from './observation';
import * as modelParameters from './modelParameters';
import { captureWorkspaceExecutionContext } from '../../workspaceExecutionContext';
import type { ComposerReplySuggestions } from '../../../shared/replySuggestions';
import * as suggestions from './suggestions';
import { captureSessionHarnessModelExpected, sameSessionHarnessModelExpected, type SessionHarnessModelExpected } from '../harnessModelIdentity';
import { GuiWorkerAdapterRegistry } from '../guiWorkerAdapter';

export class AgentSessionHost implements HostCore {
  get semanticRoot(): string { return this.userDataDir; }
  readonly ctx: AppContext;
  readonly openedSessionIds = new Set<string>();
  readonly entries = new Map<string, SessionEntry>();
  readonly adapters = new GuiWorkerAdapterRegistry();
  readonly drivers = {
    get: (runtimeId: string) => this.adapters.getDriver(runtimeId),
    values: () => this.adapters.drivers()
  };
  readonly store: GuiSessionStore;
  readonly modelAdmission: HarnessModelAdmission;
  private readonly userDataDir: string;
  /** 后台子代理审批冒泡（approvalId → 卡片消息与应答；不占父会话 activeApproval 槽） */
  readonly subagentApprovals = new Map<
    string,
    import('./internal').ActiveSubagentApproval
  >();
  /** 主进程侧推送订阅（渲染层 webContents 之外的口子；飞书回流用） */
  readonly pushSubs = new Set<(payload: GuiWorkerPush) => void>();
  /** 流式正文节流落盘（回合中崩溃的丢失窗口从「整回合」压到 2s） */
  readonly streamPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每连接只挂一个事件泵（error 后连接复用时防双泵瓜分事件） */
  readonly pumpedConns = new WeakSet<GuiRuntimeConnection>();

  constructor(ctx: AppContext, opts: { userDataDir: string }) {
    this.ctx = ctx;
    this.userDataDir = opts.userDataDir;
    this.modelAdmission = new HarnessModelAdmission(opts.userDataDir, () => this.ctx.config.get());
    const startupLiveIds = new Set([
      ...this.ctx.store.loadSessions().map(session => session.id),
      ...this.ctx.sessions.engineSweepRoster().map(session => session.id)
    ]);
    this.store = new GuiSessionStore(opts.userDataDir, () => this.ctx.config.get().liveThinkingOnly !== false, startupLiveIds, ctx.sessionLogs);
  }

  registerDriver(driver: GuiRuntimeDriver): void {
    this.adapters.register({ runtimeId: driver.runtimeId, driver });
  }

  /** 主进程侧订阅推送（与渲染层同份事件）；返回退订函数 */
  onPush(cb: (payload: GuiWorkerPush) => void): () => void {
    this.pushSubs.add(cb);
    return () => this.pushSubs.delete(cb);
  }

  getDriver(runtimeId: string): GuiRuntimeDriver | undefined {
    return base.getDriver(this, runtimeId);
  }

  assertLaunchModelAllowed(runtimeId: string, model: SessionMeta['modelOverride'], piModeId?: string): void {
    this.modelAdmission.assertEnabled(runtimeId, piModeId);
    if (model?.modelId) this.modelAdmission.assert(runtimeId, piModeId, model);
  }

  async validateLaunchModel(runtimeId: string, cwd: string, model: SessionMeta['modelOverride'], piModeId?: string): Promise<void> {
    const driver = this.getDriver(runtimeId);
    const version = driver?.connectionVersion;
    const admitted = await this.resolveLaunchModelAdmission(runtimeId, cwd, model, piModeId);
    if (model && admitted && runtimeId !== 'pi' && driver?.validateModelOverride) {
      await this.modelAdmission.prepareCatalog(runtimeId, cwd, piModeId);
    }
    if (model) await driver?.validateModelOverride?.({ cwd, model, piModeId });
    if (driver !== this.getDriver(runtimeId) || version !== this.getDriver(runtimeId)?.connectionVersion) {
      throw new Error('引擎配置在模型校验期间变化，请重试');
    }
    if (admitted) this.modelAdmission.assert(runtimeId, piModeId, admitted);
    else if (this.modelAdmission.hasSelection(runtimeId, piModeId)) throw new Error(t('模型设置在校验期间发生变化，请重试'));
  }

  private resolveLaunchModelAdmission(runtimeId: string, cwd: string, model: SessionMeta['modelOverride'], piModeId?: string) {
    const driver = this.getDriver(runtimeId);
    const modeModel = runtimeId === 'pi' && piModeId ? driver?.resolveMode?.(piModeId)?.connectExtras.modelOverride as SessionMeta['modelOverride'] : undefined;
    const llm = runtimeId === 'pi' && this.modelAdmission.hasSelection(runtimeId, piModeId) ? resolveLlmConfig(this.ctx.config.get(), modeModel) : undefined;
    const defaultModel = llm ? { providerId: llm.provider.id, modelId: llm.model.id } : undefined;
    return this.modelAdmission.resolve(runtimeId, cwd, piModeId, model ?? (modeModel ? defaultModel : undefined), defaultModel);
  }

  async validateLaunchParameters(runtimeId: string, cwd: string, meta: import('../../../shared/types').GuiSessionInitialMeta) {
    let admitted: import('../modelAdmissionPolicy').AdmissionModel | undefined;
    if (this.modelAdmission.hasSelection(runtimeId, meta.piModeId)) {
      const modeModel = runtimeId === 'pi' && meta.piModeId
        ? this.getDriver(runtimeId)?.resolveMode?.(meta.piModeId)?.connectExtras.modelOverride as SessionMeta['modelOverride'] : undefined;
      const llm = runtimeId === 'pi' ? resolveLlmConfig(this.ctx.config.get(), modeModel) : undefined;
      const localDefault = llm ? { providerId: llm.provider.id, modelId: llm.model.id } : undefined;
      admitted = await this.modelAdmission.resolve(runtimeId, cwd, meta.piModeId, meta.modelOverride ?? (modeModel ? localDefault : undefined), localDefault);
    }
    return modelParameters.validateLaunchParameters(this, { runtimeId, cwd, providerId: admitted?.providerId ?? meta.modelOverride?.providerId,
      modelId: admitted?.modelId ?? meta.modelOverride?.modelId, piModeId: meta.piModeId }, meta);
  }

  rememberLaunchParameterContext(session: SessionMeta, context: import('../../../shared/modelParameters').ModelParameterContext): void {
    modelParameters.rememberLaunchParameterContext(this, session, context);
  }

  /** Child agents inherit an active turn's fixed directory set. */
  getWorkspaceContext(sessionId: string) {
    const captured = this.entries.get(sessionId)?.turnWorkspaceContext;
    if (captured) return captured;
    const session = this.ctx.sessions.get(sessionId);
    return session ? this.store.withAttachmentReadAccess(sessionId,
      captureWorkspaceExecutionContext(this.ctx.config.get(), session, this.ctx.sessions.rootDependencyRoster?.() ?? this.ctx.sessions.list?.())) : undefined;
  }

  /** chat runtime 可用性预检：交给 driver.probe（未实现按 unknown；异常不打断批量预检） */
  async probeRuntime(runtimeId: string, piModeId?: string, modelOverride?: SessionMeta['modelOverride']): Promise<GuiRuntimeProbeResult> {
    return base.probeRuntime(this, runtimeId, piModeId, modelOverride);
  }

  // ---------- 生命周期（lifecycle.ts） ----------

  /** GUI 会话可见（launchTerminal chat 分支调用）：加载历史、初始化板卡信号 */
  open(session: SessionMeta): void {
    lifecycle.open(this, session);
  }

  /** Explicit mutation/engine boundary; ordinary UI opening stays cold. */
  materializeForExecution(sessionId: string): SessionEntry {
    return lifecycle.materializeForExecution(this,sessionId);
  }

  isOpen(sessionId: string): boolean {
    return lifecycle.isOpen(this, sessionId);
  }

  isBusy(sessionId: string): boolean {
    return lifecycle.isBusy(this, sessionId);
  }

  observe(sessionId: string) {
    return observation.observe(this, sessionId);
  }


  /** 最近一条 assistant 回复（正文 text part 拼接；无回复或纯空返回 null） */
  lastAssistantReply(sessionId: string): { id: string; text: string } | null {
    return lifecycle.lastAssistantReply(this, sessionId);
  }

  /** Return an anchor only for the live assistant owned by this session. */
  currentAssistantMessageId(sessionId: string): string | null {
    const entry = this.entries.get(sessionId);
    return entry && !entry.closed && !entry.clearing && entry.busy && entry.assistant && entry.messages.includes(entry.assistant)
      ? entry.assistant.id : null;
  }

  /** Store suggestions on the active assistant only; never target another session or a settled turn. */
  setSuggestedReplies(sessionId: string, replies: string[]): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.closed || !entry.busy || !entry.assistant || entry.activeUserQuestion) return false;
    entry.assistant.suggestedReplies = replies;
    base.persistEntry(this, entry, [entry.assistant]);
    base.syncEntry(this, entry);
    return true;
  }

  /** Bind an asynchronous host observation to the assistant that initiated it. */
  captureDisplayItemSink(sessionId: string): DisplayItemSink | undefined {
    const entry = this.entries.get(sessionId);
    const assistant = entry?.assistant;
    if (!entry || entry.closed || entry.clearing || !entry.busy || !assistant) return undefined;
    const anchorPartIndex = assistant.parts.length;
    return payload => {
      if (this.entries.get(sessionId) !== entry || entry.closed || entry.clearing || !entry.messages.includes(assistant)) return false;
      assistant.displayItems = [...(assistant.displayItems ?? []), { ...payload, id: randomUUID(), anchorPartIndex }];
      base.persistEntry(this, entry, [assistant]);
      base.syncEntry(this, entry);
      return true;
    };
  }

  /** Clear only the exact current suggestion snapshot; pending questions remain intact. */
  clearSuggestedReplies(sessionId: string, expected: ComposerReplySuggestions): boolean {
    return suggestions.clearSuggestedReplies(this, sessionId, expected);
  }

  messageCount(sessionId: string): number {
    return lifecycle.messageCount(this, sessionId);
  }

  /** P5：当前 GUI 回合开始时刻；会话未打开则 undefined */
  getTurnStartedAt(sessionId: string): number | undefined {
    return lifecycle.getTurnStartedAt(this, sessionId);
  }

  /** O6：进行中回合的开始时刻（busy 中才有值）。压缩占 busy 但不是回合，恒 undefined */
  getActiveTurnStartedAt(sessionId: string): number | undefined {
    return lifecycle.getActiveTurnStartedAt(this, sessionId);
  }

  waitUntilOpen(sessionId: string, timeoutMs = 8000): Promise<boolean> {
    return lifecycle.waitUntilOpen(this, sessionId, timeoutMs);
  }

  async close(sessionId: string, opts?: { purgeHistory?: boolean; meta?: SessionMeta }): Promise<void> {
    await lifecycle.close(this, sessionId, opts);
  }

  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    try { await lifecycle.closeAll(this); } catch (error) { errors.push(error); }
    try { await this.adapters.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'GUI session shutdown failed');
  }

  /** before-quit 同步收口：closeAll 是异步的，退出时未必跑得完 */
  flushPersist(): void {
    lifecycle.flushPersist(this);
  }

  async flushPersistAsync(): Promise<void> {
    await lifecycle.flushPersistAsync(this);
  }

  /**
   * 启动孤儿清扫（一次）：应用侧 agent-sessions 孤儿文件 + 各 driver 引擎侧存量。
   * 后台执行、失败只 log。
   */
  async sweepEngineOrphans(signal?: AbortSignal): Promise<void> {
    await lifecycle.sweepEngineOrphans(this, signal);
  }

  // ---------- 会话操作（sessionOps.ts） ----------

  /**
   * 归档 / 合入 worktree：中止回合、拆 driver 与 MCP，保留历史文件（与 close 相对）。
   * 这样 Windows 才能删掉仍被 GUI 子进程占着的 worktree 目录。
   */
  async release(sessionId: string): Promise<void> {
    await sessionOps.release(this, sessionId);
  }

  /**
   * 清空会话（对齐调度 /new：清历史 + 下轮新会话）。
   * 停当前回合、拆连接（含 MCP）、清历史文件与内存、清续聊令牌；entry 保留（下次 send 重连）。
   */
  async clear(sessionId: string): Promise<void> {
    await sessionOps.clear(this, sessionId);
  }

  /**
   * 从任意消息处 fork 新会话：UI 历史复制到新会话（截到 fork 点，含该消息）；
   * 引擎上下文按能力衔接——Pi 用种子消息原生回放，不支持回放的引擎前置 transcript。
   */
  async forkSession(
    sessionId: string,
    uptoMessageId?: string,
    opts?: { hidden?: boolean; name?: string; activate?: boolean; messagingOwner?: string }
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    return sessionOps.forkSession(this, sessionId, uptoMessageId, opts);
  }

  /** 撤回排队中的用户消息（对齐调度：队列与历史一并移除） */
  cancelQueued(sessionId: string, messageId: string): boolean {
    return sessionOps.cancelQueued(this, sessionId, messageId);
  }

  /** 改写一条排队消息的内容（queue 与消息历史同步改；未轮到执行的才可改） */
  editQueued(sessionId: string, messageId: string, text: string): boolean {
    return sessionOps.editQueued(this, sessionId, messageId, text);
  }

  /** 重排排队消息（自动发送顺序）；ids 为全量排队 id 的目标顺序 */
  reorderQueued(sessionId: string, orderedIds: string[]): boolean {
    return sessionOps.reorderQueued(this, sessionId, orderedIds);
  }

  // ---------- 消息入口（messaging.ts） ----------

  /**
   * P5/P11：把宿主提醒回注给 GUI Worker（不抢焦点）。
   * 忙则 steer/排队；未打开则静默。不替 Worker 决定代码内容。
   */
  async injectHostNudge(
    sessionId: string,
    text: string
  ): Promise<{ ok: boolean; queued?: boolean; steered?: boolean }> {
    return messaging.injectHostNudge(this, sessionId, text);
  }

  /** Trusted mailbox intent; active-turn mechanisms belong to the connection. */
  async deliverMessage(sessionId: string, message: import('../../../shared/runtimeCommunication').RuntimeMessage) {
    return messaging.send(this, sessionId, message.text, undefined, {
      host: true, messageId: message.messageId, nativeMessage: message, steerOnBusy: false
    });
  }

  /** Main-process messaging adapter only. No renderer IPC exposes this origin. */
  sendMessagingInput(sessionId: string, input: MessagingInput) {
    return acceptMessagingInput(this, sessionId, input);
  }

  /** The remote workbench bridge has already verified the exact conversation/workspace binding. */
  sendWorkbenchRemoteInput(sessionId: string, input: Omit<MessagingInput, 'owner' | 'origin'>) {
    return acceptMessagingInput(this, sessionId, { ...input, owner: '' }, true);
  }

  async send(
    sessionId: string,
    text: string,
    images?: GuiSendImage[],
    opts?: {
      steerOnBusy?: boolean;
      hiddenFromTranscript?: boolean;
      fromInject?: boolean;
      /** 可信历史调度来源：转写用调度身份；输入框发送不得传 */
      source?: ChatTranscriptSource;
      sourceAgent?: import('../../../shared/subagentCharacters').SourceAgentIdentity;
      host?: boolean;
      messageId?: string;
      desktopPreaccepted?: boolean;
      requireIdle?: boolean;
      /** Host-only continuation evidence; never accepted from renderer or tool arguments. */
      desktopContinuation?: import('../../../shared/hostNotification').HostDesktopContinuation;
      nativeMessage?: import('../../../shared/runtimeCommunication').RuntimeMessage;
    }
  ): Promise<{
    ok: boolean;
    queued?: boolean;
    steered?: boolean;
    steerUnsupported?: boolean;
    queueDepth?: number;
    error?: string;
    delivery?: import('../../../shared/runtimeCommunication').RuntimeDeliveryMethod;
  }> {
    return messaging.send(this, sessionId, text, images, opts);
  }

  /**
   * 失败回合重试：丢掉失败 assistant（连同错误展示），复用对应的用户消息重跑。
   * 不追加用户消息副本（渲染层不得再走 send(原文)）。
   */
  retry(sessionId: string): { ok: boolean; error?: string } {
    return messaging.retry(this, sessionId);
  }

  /**
   * 重新编辑已终止回合的用户消息：移除该轮用户消息与已终止助手回复，
   * 返回原文本与随文图片供填入输入框编辑。
   */
  recallAborted(sessionId: string, messageId?: string) {
    return messaging.recallAborted(this, sessionId, messageId);
  }

  async abort(sessionId: string, opts?: { holdQueue?: boolean }): Promise<void> {
    await messaging.abort(this, sessionId, opts);
  }

  /** GUI refresh：中止当前回合，并重置持久化用量（重开对话不当成旧占用） */
  async refresh(sessionId: string): Promise<void> {
    await messaging.refresh(this, sessionId);
  }

  /**
   * 手动上下文压缩（/compact，空闲期）：空闲会话直接调 driver.compact；
   * 忙时拒绝；连接未建时提示先发一条消息。
   */
  async compactSession(sessionId: string, instructions?: string): Promise<GuiCompactResult> {
    return messaging.compactSession(this, sessionId, instructions);
  }

  // ---------- 工具执行人机门（approvals.ts） ----------

  respondApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    reason?: string,
    nativeChoiceId?: string
  ): boolean {
    return approvals.respondApproval(this, sessionId, approvalId, approved, reason, nativeChoiceId);
  }

  /** fire-time 模式快照（后台子代理审批门控活读用）；会话未打开返回 null */
  getPolicyState(sessionId: string): { mode: GuiWorkerMode; planExecuting: boolean; allowedPrompts: string[] } | null {
    return approvals.getPolicyState(this, sessionId);
  }

  /**
   * 后台子代理审批冒泡：在父会话消息流挂一张独立审批卡（不占当前回合）。
   * 卡面渲染与应答复用现有审批卡 UI（respondApproval 按 approvalId 匹配）。
   */
  requestSubagentApproval(
    parentSessionId: string,
    req: GuiApprovalRequest,
    signal?: AbortSignal
  ): Promise<GuiApprovalDecision> {
    return approvals.requestSubagentApproval(this, parentSessionId, req, signal);
  }

  /** 渲染层作答/取消（IPC agentSession:respondUserQuestion）；返回是否命中挂起卡 */
  respondUserQuestion(
    sessionId: string,
    questionId: string,
    action: 'answer' | 'abort',
    answers?: Array<{ id: string; selected: string[]; custom?: string }>
  ): boolean {
    return approvals.respondUserQuestion(this, sessionId, questionId, action, answers);
  }

  // ---------- 会话设置（settings.ts） ----------

  /**
   * 切换会话模式（default/ask/plan/auto，与调度模式体系同源）——即时生效；
   * 快照型引擎 busy 中需重连的切档拒绝。
   */
  setConfigurePermissions(sessionId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    if (!enabled && this.ctx.sessions.get(sessionId)?.meta?.[MESSAGING_SESSION_OWNER]) {
      return Promise.resolve({ ok: false, error: 'Messaging Sessions require confirmation for tool actions.' });
    }
    return settings.setConfigurePermissions(this, sessionId, enabled);
  }

  setMode(sessionId: string, mode: GuiWorkerMode): Promise<{ ok: boolean; error?: string }> {
    if (mode !== 'ask' && this.ctx.sessions.get(sessionId)?.meta?.[MESSAGING_SESSION_OWNER]) {
      return Promise.resolve({ ok: false, error: 'Messaging Sessions require ask mode.' });
    }
    return settings.setMode(this, sessionId, mode);
  }

  getMode(sessionId: string): GuiWorkerMode | null {
    return settings.getMode(this, sessionId);
  }

  getModelParameters(sessionId: string) { return modelParameters.parameterSnapshot(this, sessionId); }
  getNativeConfig(sessionId: string) { return nativeConfig.getNativeConfig(this, sessionId); }
  describeNativeConfig(target: Parameters<typeof nativeConfig.describeNativeConfig>[1], refresh?: boolean) { return nativeConfig.describeNativeConfig(this, target, refresh); }
  validateNativeConfigIntent(target: Parameters<typeof nativeConfig.validateNativeConfigIntent>[1], raw: unknown) { return nativeConfig.validateNativeConfigIntent(this, target, raw); }
  captureWorkerPermission(target: Parameters<typeof nativeConfig.captureWorkerPermission>[1], raw: unknown) { return nativeConfig.captureWorkerPermission(this, target, raw); }
  refreshNativeConfig(sessionId: string) { return nativeConfig.refreshNativeConfig(this, sessionId); }
  setNativeConfig(sessionId: string, change: import('../../../shared/nativeSessionConfig').NativeConfigChange) { return nativeConfig.setNativeConfig(this, sessionId, change); }
  reconcileModelParameters(sessionId: string) { return modelParameters.reconcileModelParameters(this, sessionId); }
  describeModelParameters(target: modelParameters.ParameterTarget) { return modelParameters.describeParameters(this, target); }
  async describePickerModelParameters(target: modelParameters.ParameterTarget, session?: SessionMeta, resolveDefault = false) {
    const admitted = resolveDefault && target.cwd ? await this.resolveLaunchModelAdmission(target.runtimeId, target.cwd, undefined, target.piModeId) : undefined;
    return modelParameters.describeParameters(this, { ...target, ...admitted }, session && admitted ? { ...session, modelOverride: admitted } : session);
  }
  commitPickerModelConfiguration(...args: Parameters<typeof settings.commitPickerModelConfiguration> extends [HostCore, ...infer Rest] ? Rest : never) {
    return settings.commitPickerModelConfiguration(this, ...args);
  }
  setModelParameters(sessionId: string, changes: unknown) { return modelParameters.setModelParameters(this, sessionId, changes); }
  saveParameterProfiles(profiles: unknown) { return modelParameters.saveParameterProfiles(this, profiles); }
  validateParameterProfiles(profiles: unknown) { return modelParameters.validateParameterProfiles(this, profiles); }
  refreshModelParameters() { return modelParameters.refreshModelParameters(this); }

  /**
   * 会话级思考档（Pi GUI 会话；五档 off/low/medium/high/max）。
   * 每回合热读生效，无需重连；null=跟随默认。
   */
  setThinkingLevel(
    sessionId: string,
    level: GuiThinkingLevel | null
  ): Promise<{ ok: boolean; error?: string; applied?: SessionChangeApplied }> {
    return settings.setThinkingLevel(this, sessionId, level);
  }

  /** Pi 自定义模式名单（内置创造模式 + 用户自建；非 Pi runtime 返回 null） */
  listPiModes(): Array<{
    id: string;
    name: string;
    description: string;
    trust: 'system' | 'user';
    order: number;
    broken: string | undefined;
  }> | null {
    return settings.listPiModes(this);
  }

  listAcpAgents(): Array<{
    id: string;
    name: string;
    description: string;
    trust: 'system' | 'user';
    order: number;
    broken: string | undefined;
  }> | null {
    return settings.listAcpAgents(this);
  }

  /**
   * 切换 Pi 自定义模式。空白期锁语义：已有消息即拒绝；空白期切换拆现有连接。
   * 空串=标准（无模式）。
   */
  setPiMode(sessionId: string, modeId: string): { ok: boolean; error?: string } {
    return settings.setPiMode(this, sessionId, modeId);
  }

  /** 会话级模型覆盖；外部引擎在提交前验证各自的模型目录。 */
  async setSessionModel(
    sessionId: string,
    model: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null,
    expected?: SessionHarnessModelExpected
  ): Promise<{ ok: boolean; error?: string; warning?: string; applied?: SessionChangeApplied }> {
    const session = this.ctx.sessions.get(sessionId);
    if (expected) {
      try {
        if (!session || !sameSessionHarnessModelExpected(session, this.userDataDir, expected, this.getDriver(session.runtime ?? '')?.connectionVersion)) {
          return { ok: false, error: '会话或引擎配置已变化，请重新打开模型目录' };
        }
      } catch { return { ok: false, error: '无法确认当前会话或引擎配置，请重新打开模型目录' }; }
    }
    const checkAdmission = (): void => {
      if (!session) return;
      this.modelAdmission.assertEnabled(session.runtime ?? '', session.piModeId);
      if (model?.modelId?.trim()) this.modelAdmission.assert(session.runtime ?? '', session.piModeId, model);
    };
    try { checkAdmission(); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    if (session && ['acp', 'claude', 'pi-external', 'omp', 'zcode-gui', 'muse-gui'].includes(session.runtime ?? '') && model?.modelId?.trim()) {
      const driver = this.getDriver(session.runtime!);
      if (!driver?.validateModelOverride) return { ok: false, error: '外部引擎模型验证不可用' };
      let stamp: SessionHarnessModelExpected;
      try {
        stamp = captureSessionHarnessModelExpected(session, this.userDataDir, driver.connectionVersion);
        const config = this.ctx.config.get();
        const cwd = sessionModelSourceCwd(config, session) ?? session.cwd ?? config.workspace;
        if (this.modelAdmission.hasSelection(session.runtime!, session.piModeId)) {
          await this.modelAdmission.prepareCatalog(session.runtime!, cwd, session.piModeId);
        }
        await driver.validateModelOverride({
          cwd,
          model,
          piModeId: session.piModeId
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      const current = this.ctx.sessions.get(sessionId);
      let unchanged = false;
      try {
        unchanged = !!current && sameSessionHarnessModelExpected(current, this.userDataDir, stamp, this.getDriver(current.runtime ?? '')?.connectionVersion);
      } catch { /* A changed or invalid identity cannot be committed. */ }
      if (!unchanged) {
        return { ok: false, error: '会话配置在模型校验期间已变化，请重试' };
      }
    }
    try { checkAdmission(); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    const result = settings.setSessionModel(this, sessionId, model);
    if (!result.ok) return result;
    try {
      const snapshot = await modelParameters.reconcileModelParameters(this, sessionId);
      return { ...result, ...(snapshot.warning ? { warning: snapshot.warning } : {}) };
    } catch (error) {
      // The model choice is already committed. Do not report it as a failed write.
      return { ...result, warning: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 计划卡操作：execute 恢复工具并发起执行回合；abandon 丢弃计划回到探索态 */
  async planAction(
    sessionId: string,
    action: 'execute' | 'abandon'
  ): Promise<{ ok: boolean; error?: string }> {
    return settings.planAction(this, sessionId, action);
  }

  getHistory(
    sessionId: string,
    opts?: { light?: boolean; knownMessagesVersion?: never }
  ): import('../../../shared/guiWorker').GuiWorkerHistory | null;
  getHistory(
    sessionId: string,
    opts: { light?: boolean; knownMessagesVersion?: string } | undefined
  ): import('../../../shared/guiWorker').GuiWorkerHistoryResponse | null;
  getHistory(
    sessionId: string,
    opts?: { light?: boolean; knownMessagesVersion?: string }
  ): import('../../../shared/guiWorker').GuiWorkerHistoryResponse | null {
    return settings.getHistory(this, sessionId, opts);
  }

  injectionDetails(sessionId:string,reference:import('../../../shared/guiHistoryMetadata').GuiInjectionDetailRef):import('../../../shared/guiHistoryMetadata').GuiInjectionDetailsResult{
    const session=this.ctx.sessions.get(sessionId);
    if(!session||!isChatRuntimeId(session.runtime??''))return{ok:false,error:t('会话不存在')};
    try{const snapshot=this.store.injectionDetails(sessionId,reference);return snapshot?{ok:true,snapshot}:{ok:false,error:t('注入记录已变化或不存在，请刷新后重试')};}
    catch(error){return{ok:false,error:(error as Error).message};}
  }
  async engineInput(sessionId: string, messageId: string, ref: string): Promise<string | null> {
    const session = this.ctx.sessions.get(sessionId);
    if (!session || !isChatRuntimeId(session.runtime ?? '') || this.entries.get(sessionId)?.clearing) return null;
    return this.store.readEngineInput(sessionId, messageId, ref);
  }
  metadataTimeline(sessionId:string,kind:import('../../../shared/guiHistoryMetadata').GuiMetadataKind,before?:number,limit=120):import('../../../shared/guiHistoryMetadata').GuiMetadataTimelineResult{
    const session=this.ctx.sessions.get(sessionId);
    if(!session||!isChatRuntimeId(session.runtime??''))return{ok:false,error:t('会话不存在')};
    try{const page=this.store.metadataTimeline(sessionId,kind,before,limit);return page?{ok:true,page}:{ok:false,error:t('注入与压缩记录暂不可用，请重试')};}
    catch(error){return{ok:false,error:(error as Error).message};}
  }

  getHistoryRange(
    sessionId: string,
    before?: number,
    limit = 120,
    targetMessageId?: string
  ): import('../../../shared/guiWorker').GuiWorkerHistoryPage | null {
    return settings.getHistoryRange(this, sessionId, before, limit, targetMessageId);
  }
}
