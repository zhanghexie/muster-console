/**
 * 调度 Orchestrator 门面：公开 API 与装配唯一入口。原单文件已按调度职责拆分进
 * `orchestrator/`：桶 buckets / 排队 queueOps / 发送分流 sendPipeline / 会话档案
 * sessions / 上下文状态 contextStatus / 提问卡 askQuestions / 模式计划 planModes /
 * 自治闸簿记 turnGate / 转录索引 transcriptIndex / 回合前缀注入 memoryInjection /
 * 压缩链 compaction / 回合执行 turnExecution；协作面见 orchestrator/internal.ts。
 * 对外 import 路径不变：本模块仍导出 Orchestrator 类，方法多为一步转发。
 */
import type { AppContext } from '../context';
import { app } from 'electron';
import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { randomUUID } from 'node:crypto';
import type { DisplayItemSink } from '../../shared/displayItems';
import { CHAT_HISTORY_PAGE_SIZE, resolveChatHistoryWindow } from '../../shared/chatHistory';
import {
  type AgentContextStatus,
  type AgentMode,
  type AgentSessionSummary,
  type ChatImageAttachment,
  type ChatMessage
} from '../../shared/types';
import { normalizeTurnGateConfig, type TurnGate, type TurnGateQueue } from '../../shared/turnGate';
import type { CompactBreakerTripReason } from '../../shared/compactBreaker';
import { normalizeAgentModelSelections, pickSchedulerModelTarget } from './agentModelSelection';
import type { AgentModelSelection } from './agentModelSelection';
import { normalizeAgentThinkings } from './agentThinking';
import { syncPiConfigFromApp } from './piConfigSync';
import type { PiCompactResult } from '../../shared/piEvents';
import { interjectHostNotification } from '../agentSession/piInterject';
import type { CursorAskQuestionMapped } from '../../shared/cursorAskQuestion';
import type { OrchestratorAskOutcome, OrchestratorHumanWait } from '../../shared/orchestratorAskQuestion';
import * as buckets from './orchestrator/buckets';
import * as eventBus from './orchestrator/eventBus';
import * as queueOps from './orchestrator/queueOps';
import * as sendPipeline from './orchestrator/sendPipeline';
import * as sessions from './orchestrator/sessions';
import * as contextStatus from './orchestrator/contextStatus';
import * as askQuestions from './orchestrator/askQuestions';
import * as planModes from './orchestrator/planModes';
import * as compaction from './orchestrator/compaction';
import * as turnExecution from './orchestrator/turnExecution';
import * as workbenchRemote from './orchestrator/workbenchRemote';
import type { OrchestratorHost, PendingAsk, SchedulerSendOptions } from './orchestrator/internal';
import { createTurnGateWiring } from './orchestrator/turnGate';
import { normalizeAgentMode, type WsAgentBucket } from './orchestrator/types';
import { observeScheduler } from './orchestrator/observation';
import type { ComposerReplySuggestions } from '../../shared/replySuggestions';
import * as suggestions from './orchestrator/suggestions';
import { schedulerIsClosing, shutdownScheduler, trackSchedulerWork } from './orchestrator/lifecycle';

/**
 * 调度 Agent：每工作区独立对话桶 + Pi session。
 * 切区只换 active 指针并推送该区 history；busy 区可并行，互不覆盖 display。
 */
export class Orchestrator implements OrchestratorHost {
  readonly ctx: AppContext;
  readonly buckets = new Map<string, WsAgentBucket>();
  /** UI / getHistory / send 默认落点 */
  workspaceId: string;
  /** 每 ws 的 Agent 模式（agent-modes.json 持久化） */
  readonly modes: Record<string, AgentMode> = {};
  /** 每 ws 的调度对话模型选择（agent-models.json 持久化；重启后 ensureBucket 恢复） */
  readonly models: Record<string, AgentModelSelection> = {};
  /** 每 ws 的调度思考档（agent-thinking.json 持久化；未写入=跟随默认） */
  readonly thinkings: Record<string, string> = {};
  /** 每 ws 的回合级自动重试定时器（瞬态失败后延时重发；stop() 可取消待触发的） */
  readonly autoRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 每 ws 连续瞬态失败的已自动重试次数（任一回合成功即清零） */
  readonly autoRetryAttempts = new Map<string, number>();
  /** 每 ws 挂起的 askQuestion（工具等用户作答） */
  readonly pendingAsks = new Map<string, PendingAsk>();
  /**
   * O8 全局自治回合闸（跨工作区 token 槽信号量 + 租约回收，装配见 turnGate.ts）。
   * 只对 host 标记的自治入口生效——人的回合（无 host 标记）永不被自治负载节流。
   */
  readonly turnGate: TurnGate;
  /** 闸满暂存 + 释放即 drain 的投递缓冲（不丢、不向上游报错） */
  readonly gateQueue: TurnGateQueue;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.workspaceId = ctx.config.get().activeWorkspaceId;
    const gate = createTurnGateWiring(
      () => normalizeTurnGateConfig(this.ctx.config.get().turnGate),
      (item, token) => {
        // 空闲→起回合（token 已持有，不再二次过闸）；忙→排队路径（token 就地释放，
        // 排队消息并入该区现有链续发）
        void this.send(
          item.text,
          item.workspaceId,
          item.images as ChatImageAttachment[] | undefined,
          { host: true, gateToken: token, messageId: item.messageId, requireIdle: item.requireIdle, schedulerWake: item.schedulerWake,
            beforeStart: item.beforeStart, onAccepted: item.onAccepted, onSkipped: item.onSkipped, notification: item.notification }
        ).catch((e) => { item.onSkipped?.(e); console.error('[orchestrator] gated autonomous send failed', e); });
      }
    );
    this.turnGate = gate.turnGate;
    this.gateQueue = gate.gateQueue;
    const saved = ctx.store.loadAgentModes();
    for (const [id, v] of Object.entries(saved)) {
      this.modes[id] = normalizeAgentMode(v);
    }
    this.models = normalizeAgentModelSelections(ctx.store.loadAgentModels());
    this.thinkings = normalizeAgentThinkings(ctx.store.loadAgentThinking());
    try {
      const cfg = ctx.config.get();
      syncPiConfigFromApp(cfg, userDataStorage(app.getPath('userData')).resolve('app', 'muster-core'));
    } catch (e) {
      console.error('[orchestrator] sync Pi config failed', e);
    }
  }

  /** 兼容旧调用：当前绑定区是否忙 */
  get busy(): boolean {
    return this.isBusy(this.workspaceId);
  }

  isBusy(workspaceId: string): boolean {
    return this.buckets.get(workspaceId)?.busy === true;
  }

  async interjectHostNotification(workspaceId: string, delivery: import('../../shared/hostNotification').HostNotificationDelivery): Promise<boolean> {
    const bucket = this.buckets.get(workspaceId);
    if (!bucket?.busy || !bucket.piSession) return false;
    const session = bucket.piSession, execution = bucket.desktopExecution;
    return interjectHostNotification(session, delivery,
      () => bucket.busy && bucket.piSession === session && bucket.desktopExecution === execution, (summary, id) => {
      const activity: ChatMessage = { id, role: 'user', host: true, content: summary, createdAt: Date.now() };
      bucket.display.push(activity);
      this.emit('agent:message', { ...activity, workspaceId });
      this.persistBucket(workspaceId);
    });
  }

  observe(workspaceId: string, includeReply = true) {
    return observeScheduler(this, workspaceId, includeReply);
  }

  isAnyBusy(): boolean {
    for (const b of this.buckets.values()) {
      if (b.busy) return true;
    }
    return false;
  }

  get activeWorkspaceId(): string {
    return this.workspaceId;
  }

  /**
   * 气泡默认归属：工具 ALS 优先；仅一区 busy 用该区；否则当前绑定区。
   */
  get agentWorkspaceId(): string {
    const busyIds = [...this.buckets.entries()].filter(([, b]) => b.busy).map(([id]) => id);
    if (busyIds.length === 1) return busyIds[0];
    return this.workspaceId;
  }

  /**
   * per-workspace 调度模型访问器：会话级覆盖（桶内 providerId/modelId）→ 工作区级
   * 持久选择（agent-models.json）→ undefined（调用方回落全局 active）。
   */
  schedulerModelFor(workspaceId: string): { providerId?: string; modelId?: string } {
    const b = this.buckets.get(workspaceId);
    const sel = b ? { providerId: b.providerId, modelId: b.modelId } : undefined;
    return pickSchedulerModelTarget(sel, this.models[workspaceId]);
  }

  ensureBucket(workspaceId: string): WsAgentBucket {
    return buckets.ensureBucket(this, workspaceId);
  }

  persistBucket(workspaceId: string): void {
    buckets.persistBucket(this, workspaceId);
  }

  async flushSessions(): Promise<void> {
    const results = await Promise.allSettled([...this.buckets.values()].map(bucket => bucket.schedulerSession?.flush('app-shutdown')));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Scheduler flush failed');
  }

  closeSchedulerSessions(): void {
    for (const bucket of this.buckets.values()) bucket.schedulerSession?.close();
  }

  shutdown(): Promise<void> {
    return shutdownScheduler(this, () => {
      const errors: unknown[] = [];
      try { this.gateQueue.dispose(); } catch (error) { errors.push(error); }
      for (const timer of this.autoRetryTimers.values()) clearTimeout(timer);
      this.autoRetryTimers.clear();
      for (const [id, bucket] of this.buckets) {
        bucket.queue = [];
        try { this.stop(id); } catch (error) { errors.push(error); }
        try { bucket.piSession?.abortCompaction?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Scheduler cancellation failed');
    }, () => this.invalidatePiSession(), async () => {
      try { await this.flushSessions(); }
      finally { this.closeSchedulerSessions(); }
    });
  }

  getHistory(workspaceId = this.workspaceId): ChatMessage[] {
    return this.ensureBucket(workspaceId).display;
  }

  getHistoryRange(workspaceId = this.workspaceId, before?: number, limit = CHAT_HISTORY_PAGE_SIZE, targetMessageId?: string): import('../../shared/chatSurface').ChatHistoryPage {
    const bucket = this.buckets.get(workspaceId);
    let page: import('../../shared/chatSurface').ChatHistoryPage;
    if (!bucket) page = buckets.getColdHistoryRange(this, workspaceId, before, limit, targetMessageId);
    else {
      const messages = bucket.display;
      const {start,end} = resolveChatHistoryWindow(messages,before,limit,targetMessageId);
      page = {messages:messages.slice(start,end),before:start,total:messages.length,hasEarlier:start>0};
    }
    const eventSeq = eventBus.liveSequenceFor(this,workspaceId);
    return {...page,...(eventSeq !== undefined ? {eventSeq} : {})};
  }

  /** 当前桶绑定的 Pi 会话文件（Channel 远程输入用于核对所选会话） */
  getCurrentSessionFile(workspaceId = this.workspaceId): string | undefined {
    const bucket = this.buckets.get(workspaceId);
    return bucket ? bucket.piSessionFile : buckets.getColdSessionFile(this, workspaceId);
  }

  /** Only the currently executing assistant is a reliable reminder source. */
  currentAssistantMessageId(workspaceId: string): string | null {
    const bucket = this.buckets.get(workspaceId);
    const assistant = bucket?.streamingAssistant;
    return bucket?.busy && assistant && bucket.display.includes(assistant) ? assistant.id : null;
  }

  /** 调度面板历史会话列表（R-12：只回无头定时任务桶，见 orchestrator/sessions.ts） */
  async listSessions(workspaceId = this.workspaceId): Promise<AgentSessionSummary[]> {
    return sessions.listSessions(this, workspaceId);
  }

  /** 重命名一个历史 Pi 会话（追加 session_info 条目） */
  async renameSession(workspaceId: string, sessionFile: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return sessions.renameSession(this, workspaceId, sessionFile, name);
  }

  /** 删除一个历史 Pi 会话；删中当前桶绑定会话时清指针与 display（见 sessions.ts） */
  async deleteSession(workspaceId: string, sessionFile: string): Promise<{ ok: boolean; error?: string }> {
    return sessions.deleteSession(this, workspaceId, sessionFile);
  }

  /** 重命名当前绑定 Pi 会话（调度 Agent 自我命名；无落盘会话则报错） */
  async renameCurrentSession(workspaceId: string, name: string): Promise<{ ok: boolean; error?: string }> {
    return sessions.renameCurrentSession(this, workspaceId, name);
  }

  /** 装载一个历史 Pi 会话（R-12 门控：仅定时任务桶，见 orchestrator/sessions.ts） */
  async openSession(workspaceId: string, sessionFile: string, beforeCommit?: () => boolean): Promise<{ ok: boolean; error?: string }> {
    return sessions.openSession(this, workspaceId, sessionFile, beforeCommit);
  }

  /** 从历史某条消息分叉出新调度对话（见 orchestrator/sessions.ts） */
  async forkSession(
    uptoMessageId: string,
    workspaceId = this.workspaceId
  ): Promise<{ ok: boolean; sessionFile?: string; originalSessionFile?: string; error?: string }> {
    return sessions.forkSession(this, uptoMessageId, workspaceId);
  }

  /** 当前区模型 + 上下文占用（无 Pi session 时仅回落配置模型名） */
  getContextStatus(workspaceId = this.workspaceId): AgentContextStatus {
    return contextStatus.getContextStatus(this, workspaceId);
  }

  getWorkspacePromptScope(workspaceId = this.workspaceId) {
    return contextStatus.getWorkspacePromptScope(this, workspaceId);
  }

  /** 工作区级思考档（未设=null=跟随默认） */
  getThinkingLevel(workspaceId = this.workspaceId): string | null {
    return this.thinkings[workspaceId] ?? this.buckets.get(workspaceId)?.thinkingLevel ?? null;
  }

  /** 切换调度思考档（工作区级，agent-thinking.json）；null=跟随默认 */
  setThinking(
    level: string | null,
    workspaceId = this.workspaceId
  ): { ok: boolean; error?: string; thinkingLevel: string | null; available: boolean } {
    return contextStatus.setThinking(this, level, workspaceId);
  }

  /** 调度面带图发送守卫：当前生效模型非多模态则拒绝（send() 内再拦一次） */
  checkSendImages(
    workspaceId = this.workspaceId,
    images?: ChatImageAttachment[]
  ): { ok: true } | { ok: false; error: string } {
    return contextStatus.checkSendImages(this, workspaceId, images);
  }

  /**
   * 切换当前工作区调度对话使用的服务商与模型（会话级覆盖：只写本工作区 bucket，
   * 不动全局配置——全局默认模型由设置页管理，改它只影响没有覆盖的会话）。
   */
  switchModel(workspaceId = this.workspaceId, model: { providerId: string; modelId: string }): { thinkingReset: boolean; thinkingUnknown: boolean } {
    return contextStatus.switchModel(this, workspaceId, model);
  }

  getPickerConfiguration(...args: Parameters<typeof contextStatus.getPickerConfiguration> extends [OrchestratorHost, ...infer Rest] ? Rest : never) {
    return contextStatus.getPickerConfiguration(this, ...args);
  }

  setPickerConfiguration(...args: Parameters<typeof contextStatus.setPickerConfiguration> extends [OrchestratorHost, ...infer Rest] ? Rest : never) {
    return contextStatus.setPickerConfiguration(this, ...args);
  }

  emitContextStatus(workspaceId: string): void {
    this.emit('agent:context', { ...this.getContextStatus(workspaceId), workspaceId });
  }

  /** 丢掉进程内 AgentSession（MCP 连接等）；下次 send 会从磁盘 continueRecent */
  invalidatePiSession(workspaceId?: string): void {
    buckets.invalidatePiSession(this, workspaceId);
  }

  /** 切换工作区：只换绑定指针 + 推送目标区历史；不拆进行中回合 */
  bindWorkspace(workspaceId: string): void {
    sessions.bindWorkspace(this, workspaceId);
  }

  /** 清空指定区 UI 历史；R-12 记忆豁免不碰 .muster/scheduler/（见 buckets.ts） */
  clearHistory(workspaceId = this.workspaceId): void {
    buckets.clearHistory(this, workspaceId);
  }

  /** 事件泵（orchestrator/* 模块经 OrchestratorHost.emit 推送；勿在模块外直接调用） */
  emit(channel: string, payload: unknown): void {
    eventBus.emit(this, channel, payload);
  }

  /** 事件监听器表（主进程内订阅，见 orchestrator/eventBus.ts） */
  readonly eventListeners = new Set<(channel: string, payload: unknown) => void>();

  /**
   * 主进程内订阅 agent 事件（与渲染层推送同源同序）。
   * 主进程常驻服务用；回调抛错不影响渲染层推送。
   */
  onEvent(cb: (channel: string, payload: unknown) => void): () => void {
    return eventBus.onEvent(this, cb);
  }

  /** 受理一条用户/自治消息并发起回合（分流见 orchestrator/sendPipeline.ts） */
  async send(
    text: string,
    workspaceId = this.workspaceId,
    images?: ChatImageAttachment[],
    opts?: SchedulerSendOptions
  ): Promise<void> {
    await trackSchedulerWork(this, () => sendPipeline.send(this, text, workspaceId, images, opts));
  }

  sendWorkbenchRemote(text: string, workspaceId: string, requestId: string, signal: AbortSignal, isCurrent: () => boolean) {
    return workbenchRemote.sendWorkbenchRemote(this, text, workspaceId, requestId, signal, isCurrent);
  }

  /** 撤回一条排队消息（busy 期间发送、尚未轮到执行的） */
  cancelQueued(messageId: string, workspaceId = this.workspaceId): boolean {
    return queueOps.cancelQueued(this, messageId, workspaceId);
  }

  /** 立即发送（排队面板「立即」）：空闲发送 / 忙插话 steer / 回落排队（见 queueOps） */
  async sendNow(text: string, workspaceId = this.workspaceId): Promise<'sent' | 'steered' | 'queued' | 'failed'> {
    if (schedulerIsClosing(this)) return 'failed';
    return queueOps.sendNow(this, text, workspaceId);
  }

  /** 改写一条排队消息的内容（queue 与 display 同步改；未轮到执行的才可改） */
  editQueued(messageId: string, text: string, workspaceId = this.workspaceId): boolean {
    return queueOps.editQueued(this, messageId, text, workspaceId);
  }

  /** 重排排队消息（自动发送顺序）；ids 为全量排队 id 的目标顺序 */
  reorderQueued(orderedIds: string[], workspaceId = this.workspaceId): boolean {
    return queueOps.reorderQueued(this, orderedIds, workspaceId);
  }

  /** 调度 askQuestion：挂提问卡等用户作答；第二张到达先取消旧卡（见 askQuestions.ts） */
  requestUserQuestion(mapped: CursorAskQuestionMapped, workspaceId?: string): Promise<OrchestratorAskOutcome> {
    return askQuestions.requestUserQuestion(this, mapped, workspaceId);
  }

  /** Suggestions belong to the active assistant in the calling workspace. */
  setSuggestedReplies(workspaceId: string, replies: string[]): boolean {
    const bucket = this.buckets.get(workspaceId);
    const assistant = bucket?.streamingAssistant;
    if (!bucket?.busy || !assistant || !bucket.display.includes(assistant) || this.pendingAsks.has(workspaceId)) return false;
    assistant.suggestedReplies = replies;
    this.emit('agent:message', { ...assistant, workspaceId });
    this.persistBucket(workspaceId);
    return true;
  }

  /** Bind host display data to the original scheduler message, even across steering. */
  captureDisplayItemSink(workspaceId: string): DisplayItemSink | undefined {
    const bucket = this.buckets.get(workspaceId);
    const assistant = bucket?.streamingAssistant;
    if (!bucket?.busy || !assistant || !bucket.display.includes(assistant)) return undefined;
    const anchorPartIndex = assistant.parts?.length ?? 0;
    return payload => {
      if (this.buckets.get(workspaceId) !== bucket || !bucket.display.includes(assistant)) return false;
      assistant.displayItems = [...(assistant.displayItems ?? []), { ...payload, id: randomUUID(), anchorPartIndex }];
      this.emit('agent:message', { ...assistant, workspaceId });
      this.persistBucket(workspaceId);
      return true;
    };
  }

  /** Dismiss the displayed snapshot without responding to any pending question. */
  clearSuggestedReplies(workspaceId: string, expected: ComposerReplySuggestions): boolean {
    return suggestions.clearSuggestedReplies(this, workspaceId, expected);
  }

  /** 渲染层作答/取消（IPC chat:respondUserQuestion） */
  respondUserQuestion(
    workspaceId: string, questionId: string, action: 'answer' | 'abort',
    answers?: Array<{ id: string; selected: string[]; custom?: string }>
  ): boolean {
    return askQuestions.respondUserQuestion(this, workspaceId, questionId, action, answers);
  }

  /** 另一单 needs_you 通道可读的当前等待态；无挂起卡则 null */
  getHumanWait(workspaceId = this.workspaceId): OrchestratorHumanWait | null {
    return askQuestions.getHumanWait(this, workspaceId);
  }

  abortPendingAsk(wsId: string): void {
    askQuestions.abortPendingAsk(this, wsId);
  }

  /** 手动停止当前回合：中止 Pi 生成与在途工具；排队消息保留，回合结束后继续 */
  stop(workspaceId = this.workspaceId): { stopped: boolean } {
    return turnExecution.stop(this, workspaceId);
  }

  /** 压缩当前会话上下文（B2 source 语义 / B3 快照见 orchestrator/compaction.ts） */
  async compactSession(
    workspaceId = this.workspaceId,
    instructions?: string,
    opts?: { source?: 'manual' | 'auto' }
  ): Promise<PiCompactResult> {
    return compaction.compactSession(this, workspaceId, instructions, opts);
  }

  /**
   * B2 熔断可见信号：自动压缩链被打闸时经现有通知通道告知人工接管（见 compaction.ts）。
   */
  signalCompactBreakerTripped(wsId: string, reason: CompactBreakerTripReason): void {
    compaction.signalCompactBreakerTripped(this, wsId, reason);
  }

  getAgentMode(workspaceId = this.workspaceId): AgentMode {
    return this.buckets.get(workspaceId)?.mode ?? normalizeAgentMode(this.modes[workspaceId]);
  }

  /** 切换 Agent 模式（default/ask/plan）；已有会话时即时生效（IPC 边界，接受宽松 string） */
  setAgentMode(mode: string, workspaceId = this.workspaceId): AgentMode {
    return planModes.setAgentMode(this, mode, workspaceId);
  }

  /** 计划卡操作：execute 开始执行（走正常回合管道）；abandon 放弃 */
  async planAction(action: 'execute' | 'abandon', workspaceId = this.workspaceId): Promise<{ ok: boolean; error?: string }> {
    return planModes.planAction(this, action, workspaceId);
  }

  /** 建 assistant 占位并执行回合（send / 排队续发共用；见 turnExecution.ts） */
  startTurn(
    bucket: WsAgentBucket,
    wsId: string,
    text: string,
    images?: ChatImageAttachment[],
    host?: boolean,
    notification?: import('../../shared/hostNotification').HostNotificationDelivery,
    desktopInstructionId?: string,
    causationId?: string,
    workbenchRemote?: import('./orchestrator/internal').SchedulerWorkbenchRemoteTurn
  ): Promise<void> {
    return turnExecution.startTurn(this, bucket, wsId, text, images, host, notification, desktopInstructionId, causationId, workbenchRemote);
  }

  /** 重试失败回合：丢弃失败 assistant、复用对应用户消息重跑（见 turnExecution.ts） */
  retry(workspaceId = this.workspaceId): { accepted: boolean; error?: string } {
    return turnExecution.retry(this, workspaceId);
  }

  /** 重新编辑已终止回合的用户消息：移除该轮用户与已终止 assistant，返回原消息文本与图片 */
  recallAborted(workspaceId = this.workspaceId, messageId?: string) {
    return turnExecution.recallAborted(this, workspaceId, messageId);
  }

  /** 回合失败且属瞬态服务错误时，延时自动重发该回合（见 orchestrator/turnExecution.ts） */
  scheduleTurnAutoRetry(wsId: string, failedMsg: ChatMessage, delayMs: number): void {
    turnExecution.scheduleTurnAutoRetry(this, wsId, failedMsg, delayMs);
  }

  /** 出队下一条排队消息并作为新回合发送 */
  drainQueue(bucket: WsAgentBucket, wsId: string): Promise<void> {
    return turnExecution.drainQueue(this, bucket, wsId);
  }

  /** 调度侧阈值自动压缩（0.8 全量 / 微压缩链，见 orchestrator/compaction.ts） */
  maybeAutoCompact(wsId: string): void {
    compaction.maybeAutoCompact(this, wsId);
  }

  /** B1 idle 触发的微压缩（send 非忙碌路径在进回合前调用） */
  maybeIdleMicrocompact(wsId: string): Promise<void> {
    return compaction.maybeIdleMicrocompact(this, wsId);
  }

}
