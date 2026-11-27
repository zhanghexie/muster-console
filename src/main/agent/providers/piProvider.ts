import { runWithToolInvocation } from '../../runtimeKernel/toolInvocation';
import { desktopTurnGrants } from '../../desktop/turnGrant';
import { desktopEngineDeliveryFromContext } from '../../desktop/globalEngineDelivery';
import { randomUUID } from 'node:crypto';
import type { HostNotificationDelivery } from '../../../shared/hostNotification';
import { HOST_NOTIFICATION_TRIGGER } from '../../../shared/hostNotification';
import { hostNotificationDelivery } from '../../messages/hostNotifications';
import { sendHostNotification } from './hostNotification';
import { app } from 'electron';
import { installAttachmentPayload } from '../../attachments/piExtension';
import { captureModelRequests } from '../../agentSession/drivers/pi/modelRequestCapture';
import { traceRequestCompression } from '../../agentSession/drivers/pi/requestCompression';
import { schedulerModelRequestId } from '../../../shared/modelRequest';
import { promises as fsp, existsSync } from 'node:fs';
import { dirname, join as pathJoin } from 'node:path';
import type { AppContext } from '../../context';
import { requireShellApi } from '../../context';
import type { AgentMode, AgentSessionSummary, ChatDisplayPart, ChatImageAttachment, ChatMessage, ToolCallRecord } from '../../../shared/types';
import { GUI_THINKING_LEVELS, resolveThinkingLevel } from '../../../shared/thinkingLevels';
import { pickSessionTitle } from '../../../shared/sessionTitle';
import type { OrchestratorForkSeed } from '../../../shared/orchestratorFork';
import { lastAssistantOutcome, safeCompactSession, safeSetThinkingLevel } from '../../../shared/piEvents';
import type { PiAgentEvent, PiCompactResult, PiSessionHandle } from '../../../shared/piEvents';
import { subscribePiReview } from './reviewEvents';
import { errorMessage } from '../../../shared/errors';
import { t } from '../../../shared/i18n';
import {
  toApiName,
  catalogSnippetFor,
  hasNamedParameters,
  resolveToolCallArgs,
  getToolDef,
  type ToolDef
} from '../../capabilities/catalog';
import { executeTool, serializeModelToolResult, type ExecuteResult } from '../../capabilities/executor';
import { schedulerProjectedCatalog } from '../../capabilities/catalog/projectedCatalog';
import { executeProjectedScheduler } from '../../capabilities/projectedScheduler';
import { isSchedulerRegisterableTool } from '../../../shared/toolDiscovery';
import { rememberCapturePreview, takeCapturePreview } from '../../capabilities/capturePreview';
import { buildMetaAgentAppendPrompt } from '../systemPrompt';
import { createSkillSourceLoader, workspaceSkillPaths } from '../skillSources';
import { useProviderOutputDefaults } from '../piOutputLimit';
import { getConfiguredCoreReasoning, syncPiConfigFromApp, primePiCatalogSnapshot } from '../piConfigSync';
import type { CoreReasoningBinding } from '../coreReasoningCatalog';
import { configurePiReasoning } from '../piReasoning';
import { userDataStorage } from '../../runtimeKernel/storageRootResolver';
import { resolveEffectiveMcpFromApp } from '../../../shared/mcpConfig';
import { resolveLlmConfig, resolveLlmConfigWithReload } from '../../config';
import { llmConnectionIdentity } from '../llmConnectionIdentity';
import { patchElectronForPi } from '../piElectronCompat';
import { installLlmStreamTrace, LLM_STREAM_LOG_NAME } from '../llmStreamTrace';
import { snapshotPiContext } from '../piContext';
import { createModeExtensionFactory, ensureModeController } from './modeExtension';
import { CORE_CONTEXT_TOOL, createCoreContextExtension } from '../coreContext';
import { createSchedulerDirectoryExtension } from './directoryExtension';
import { createSchedulerWorkerRoutingExtension } from './workerRoutingExtension';
import { summarizeWorkerRoutingTiers } from '../../tasks/workerRouting';
import { writeSchedulerForkFile } from './forkSessionFile';
import { beginSchedulerWorkspaceContext, bindSchedulerSessionContext, captureSchedulerWorkspaceContext,
  getSchedulerConnectionContext, rememberSchedulerConnectionContext } from '../schedulerWorkspaceContext';
import { assertWorkspaceExecutionContextCurrent } from '../../workspaceExecutionContext';
import type { WorkspaceExecutionContext } from '../../../shared/workspaceExecutionContext';
import type { SessionMeta } from '../../../shared/types';
import { executeSchedulerPiTool, SchedulerPiDelivery } from '../schedulerPiDelivery';
import { runAsSchedulerTool, runOutsideSchedulerDesktopTurn } from '../agentScope';
import { runAsExtensionSchedulerCaller } from '../../extensions/extensionToolCaller';
import { runAsHeadlessTurn, runAsNonUserTurn, runWithTurnUserText } from '../turnScope';
import { isStickySessionError } from '../turnRetry';
import {
  resolveTurnHiddenTools,
  schedulerTurnKindFromTurnScope,
  type SchedulerTurnKind,
  type TurnHiddenTools
} from '../../../shared/turnVisibility';

type PiModule = typeof import('@earendil-works/pi-coding-agent');

function emitPiContext(
  session: unknown,
  emit: (channel: string, payload: unknown) => void,
  fallbackModel: string
): void {
  emit('agent:context', snapshotPiContext(session as object, fallbackModel));
}

let piMod: PiModule | null = null;
/** Retired with the actual in-process Pi session, never exposed to a model. */
const sessionDeliveries = new WeakMap<object, SchedulerPiDelivery>();
const sessionRequestCaptures = new WeakMap<object, () => void>();
const sessionLlmIdentities = new WeakMap<object, string>();
const sessionReasoning = new WeakMap<object, { key: string; control: ReturnType<typeof configurePiReasoning> }>();
const reasoningKey = (binding?: CoreReasoningBinding | null) => binding ? JSON.stringify(binding) : undefined;
/** 各工作区当前回合的 AbortController：手动停止时取消生成与在途 capability 工具 */
const activeTurnAborts = new Map<string, AbortController>();

function turnAbortKey(wsId?: string): string {
  return wsId || 'default';
}

/** 手动停止某工作区的当前回合：中止 Pi 生成 + 取消在途工具执行 */
export function abortPiTurn(wsId: string | undefined, session?: PiSessionHandle | null): void {
  try {
    void Promise.resolve(session?.abort?.()).catch(error => console.error('[pi] abort failed', error));
  } catch {
    /* ignore */
  }
  const key = turnAbortKey(wsId);
  const ac = activeTurnAborts.get(key);
  if (ac) {
    ac.abort();
    activeTurnAborts.delete(key);
  }
}

function resolveLlmStreamLogFile(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { app?: { getPath: (name: string) => string } };
    const userData = electron.app?.getPath('userData');
    if (!userData) return undefined;
    return pathJoin(userDataStorage(userData).resolve('app', 'logs'), LLM_STREAM_LOG_NAME);
  } catch {
    return undefined;
  }
}

async function loadPi(): Promise<PiModule> {
  patchElectronForPi();
  installLlmStreamTrace({ persistFile: resolveLlmStreamLogFile() });
  if (!piMod) piMod = await import('@earendil-works/pi-coding-agent');
  return piMod;
}

export async function disposePiSessionResources(session: unknown, wsId?: string): Promise<void> {
  if (!session || typeof session !== 'object') return;
  sessionRequestCaptures.get(session)?.();
  sessionRequestCaptures.delete(session);
  sessionDeliveries.get(session)?.close();
  sessionDeliveries.delete(session);
  sessionLlmIdentities.delete(session);
  sessionReasoning.delete(session);
  if (wsId) {
    abortPiTurn(wsId);
  } else {
    for (const ac of activeTurnAborts.values()) ac.abort();
    activeTurnAborts.clear();
  }
  const errors: unknown[] = [];
  try { await (session as PiSessionHandle).abort?.(); } catch (error) { errors.push(error); }
  try { await (session as PiSessionHandle).dispose?.(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Pi session cleanup failed');
}

export interface PiRunArgs {
  notification?: HostNotificationDelivery;
  onNotification?: (summary: string, id: string) => void;
  onPiEvent?: (event: PiAgentEvent) => void;
  fileChanges?: import('../../turnChanges/service').TurnChangeTracker;
  ctx: AppContext;
  /** Captured and held by runTurn before memory injection. Other callers acquire their own lease. */
  workspaceContext?: WorkspaceExecutionContext;
  text: string;
  assistant: ChatMessage;
  /**
   * 流式落点的动态解析（orchestrator 插话切分）：每次事件经它取当前 assistant——
   * steer 后调用方把占位换成新的，后续 delta/工具卡/终态章都落新占位，旧占位不再
   * 接流（与 GUI 会话 splitSteeredTurn 同语义）。缺省回落 assistant 参数本身。
   */
  getAssistant?: () => ChatMessage;
  emit: (channel: string, payload: unknown) => void;
  getSession: () => PiSessionHandle | null;
  setSession: (s: PiSessionHandle | null) => void;
  /** true：新建落盘会话（仅清空聊天时）；false/缺省：continueRecent 复用 */
  forceNewSession?: boolean;
  /** 指定则续用该文件；明确 forceNewSession 时开始新对话，不读取旧文件。 */
  openSessionFile?: string;
  /** 会话创建/打开后回调落盘文件路径（桶内持久化当前会话指针） */
  onSessionCreated?: (sessionFile?: string) => void;
  /** 本轮 Agent 发起时所在工作区；气泡/错误都落到它，不随当前 active 漂移 */
  workspaceId?: string;
  /** 工作区当前 Agent 模式（ask/plan 扩展状态初始化用） */
  mode?: AgentMode;
  /** 指定服务商与模型（未指定则使用当前活跃配置） */
  targetModel?: {
    providerId?: string;
    modelId?: string;
  };
  /** 用户附加的图片（多模态模型使用） */
  images?: ChatImageAttachment[];
  /**
   * 在回合开始时读取工作区思考档（null=跟随默认）。切档在下一轮生效。
   */
  getThinkingLevel?: () => string | null;
  /**
   * 回合作用域定性（B3 记忆写路径）：缺省 'user'=用户对话回合（建 userText 证据面）；
   * 'host'=orchestrator host 自治回合（事件 flush/邮箱收信 等 {host:true} 链路），
   * 不建用户证据面，memory.remember 保守拒绝（B3 评审 MAJOR-1）。
   */
  turnKind?: 'user' | 'host';
  originalUserText?: string;
  literalText?: boolean;
}

type PiApi = {
  registerTool: (tool: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: unknown;
    execute: (
      id: string,
      params: { arguments_json?: string } & Record<string, unknown>,
      signal?: AbortSignal
    ) => Promise<{ content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }>; details: Record<string, never> }>;
  }) => void;
};

async function registerToolsFactory(
  ctx: AppContext,
  wsId: string | undefined,
  /** A4 轮级工具可见性：本会话隐藏面（prompt-task 轮非空；交互会话为空集全量） */
  hidden: TurnHiddenTools,
  opts: { workspaceContext: WorkspaceExecutionContext; callerId: string; delivery: SchedulerPiDelivery;
    supportsCaptureImages(): boolean }
): Promise<(api: PiApi) => void> {
  const { Type } = await import('@earendil-works/pi-ai');
  const projected = schedulerProjectedCatalog(hidden);
  const projectedNames = new Set(projected.map(entry => entry.name));
  const abortKey = turnAbortKey(wsId);
  type RegisteredTool = ToolDef;
  const registerOneIn = (targetApi: PiApi) => (def: RegisteredTool): void => {
    if (!projectedNames.has(def.name) && !isSchedulerRegisterableTool(def.name)) return;
    const apiName = toApiName(def.name);
    // A7：有命名参数的工具直接注册目录里的真实参数 JSON Schema（catalog 的 parameters
    // 本就含 properties/required/中文参数说明；pi 校验层 validateToolArguments 对裸
    // JSON Schema 有显式分支，非 TypeBox 形态走 coercion，亲验 130 工具全过）。模型
    // 因此能看到参数结构，不再靠 description 文字猜。无 properties 的工具（无参
    // list/status 类，静态 11 个）保持 arguments_json 泛型兜底。dangerous 工具经
    // getToolDef 合入 confirmNote 参数（reason 只保留执行兼容）（与 getCatalogInfo 目录视图同源）。
    const registered = getToolDef(def.name) ?? def;
    targetApi.registerTool({
      name: apiName,
      label: def.name,
      description: def.description,
      // Available tools 行内标注每个工具的具体动作摘要，
      // 组级地图本体因此撤出 system prompt；此前传 def.name 是「名字:名字」纯噪音
      promptSnippet: catalogSnippetFor(def),
      parameters: hasNamedParameters(registered)
        ? registered.parameters
        : Type.Object({
            arguments_json: Type.Optional(
              Type.String({
                description: 'JSON object string of the tool arguments; may be omitted or {} when there are none'
              })
            )
          }),
      async execute(
        _id: string,
        params: { arguments_json?: string } & Record<string, unknown>,
        signal?: AbortSignal
      ) {
        // A7 双形态：真实 schema 注册后模型直传命名参数（首选）；arguments_json 字符串
        // 形态永久兼容（老会话历史/旧习惯不破）。判定与合并在 resolveToolCallArgs 纯函数。
        return executeSchedulerPiTool({ delivery: opts.delivery, id: _id, name: apiName, signal, params, supportsCaptureImages: opts.supportsCaptureImages,
          resolve: resolveToolCallArgs,
          serialize: (result: ExecuteResult, args) => serializeModelToolResult(result, def.name, (args ?? {}) as Record<string, unknown>),
          afterExecute: result => {
            if (result.display?.imagePath) rememberCapturePreview(String(_id), result.display.imagePath);
          },
          execute: async resolvedArgs => {
            // 调度身份同样适用于无头任务；用户 UI 和 GUI Worker 不经过此路径。
            const activeSignal = activeTurnAborts.get(abortKey)?.signal ?? signal;
            return runWithToolInvocation({ sessionId: `orchestrator:${opts.workspaceContext.workspaceId}`, toolCallId: _id }, () => runAsExtensionSchedulerCaller(opts.workspaceContext, opts.callerId, () => runAsSchedulerTool(async () => {
              if (!projectedNames.has(def.name)) return executeTool(ctx, def.name, JSON.stringify(resolvedArgs ?? {}), { signal: activeSignal });
              try {
                const value = await executeProjectedScheduler(projected, def.name, (resolvedArgs ?? {}) as Record<string, unknown>, {
                  isCurrent: () => !activeSignal?.aborted,
                  resolveSession: ref => { try { return ctx.sessions.get(ctx.sessions.resolveSessionRef({ sessionId: ref }).id); } catch { return undefined; } },
                  sessionIdentity: id => ctx.sessions.peek(id),
                  execute: (target, args) => executeTool(ctx, target, JSON.stringify(args), { signal: activeSignal })
                }, hidden);
                if (def.name === 'host.sessions.update') {
                  if ((value as { ok: boolean }).ok) return { ok: true, result: value };
                  return { ok: false, result: value, error: (value as { failed?: { error: string } }).failed?.error };
                }
                return value as ExecuteResult;
              } catch (error) { return { ok: false, error: errorMessage(error) }; }
            })));
          }
        });
      }
    });
  };
  return (api) => {
    const registerOne = registerOneIn(api);
    // R4：Available tools 行序跟随常驻清单的家族分组（点名清单即序；非清单项稳定排后）
    const ordered = projected.map(entry => entry.def);
    for (const def of ordered) registerOne(def);
  };
}

function subscribePiTurn(
  session: PiSessionHandle,
  getAssistant: () => ChatMessage,
  emit: (channel: string, payload: unknown) => void,
  modelId: string,
  fileChanges?: import('../../turnChanges/service').TurnChangeTracker,
  onPiEvent?: (event: PiAgentEvent) => void
): () => void {
  // The direct agent-core listener is the awaited capture boundary; do not
  // race it with AgentSession's non-awaiting copy of the same tool events.
  const hasAwaitedReview = typeof session.agent?.subscribe === 'function';
  /** 最近一次 agent_end 的末条 assistant 状态；settled 时据此判定回合成败 */
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  /** 回合阶段气泡（思考中/生成中/执行工具…）；仅变化时推送 */
  let bubbleLabel = '';
  const setTurnBubble = (label: string, status: 'thinking' | 'streaming' | 'tool'): void => {
    if (label === bubbleLabel) return;
    bubbleLabel = label;
    emit('ui:bubble', { text: label, status });
  };
  /** 往当前 assistant.parts 尾部追加流式片段：尾部不是同 kind 就新开一段
   *  （思考→正文→思考 自然交替），返回该段下标供渲染层按 partIndex 合并 */
  const appendStreamPart = (a: ChatMessage, kind: 'text' | 'thinking', token: string): number => {
    const parts = (a.parts ??= []);
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) {
      last.text += token;
    } else {
      parts.push({ kind, text: token } as ChatDisplayPart);
    }
    return parts.length - 1;
  };
  return session.subscribe((event: PiAgentEvent) => {
    onPiEvent?.(event);
    // 每次事件动态取当前落点：插话切分（orchestrator sendNow steer）后换新占位，
    // 旧占位不再接流；迟到的 tool end 在新占位里查不到即自然丢弃（与 GUI 会话一致）
    const assistant = getAssistant();
    if (event?.type === 'message_update') {
      const ev = event as Extract<PiAgentEvent, { type: 'message_update' }>;
      if (ev.assistantMessageEvent?.type === 'text_delta') {
        const token = ev.assistantMessageEvent.delta;
        if (token) {
          assistant.content += token;
          const partIndex = appendStreamPart(assistant, 'text', token);
          if (assistant.retryHint) assistant.retryHint = undefined;
          setTurnBubble(t('生成中…'), 'streaming');
          emit('agent:token', { messageId: assistant.id, token, partIndex });
        }
      }
      if (ev.assistantMessageEvent?.type === 'thinking_delta') {
        const token = ev.assistantMessageEvent.delta;
        if (token) {
          assistant.thinking = (assistant.thinking ?? '') + token;
          const partIndex = appendStreamPart(assistant, 'thinking', token);
          if (assistant.retryHint) assistant.retryHint = undefined;
          setTurnBubble(t('思考中…'), 'thinking');
          emit('agent:thinking', { messageId: assistant.id, token, partIndex });
        }
      }
    }
    if (event?.type === 'tool_execution_start') {
      const ev = event as Extract<PiAgentEvent, { type: 'tool_execution_start' }>;
      // AgentSession forwards events without awaiting listeners. This is only
      // an observation; the independent agent-core subscription is the barrier.
      if (!hasAwaitedReview) void fileChanges?.toolStart(String(ev.toolCallId ?? ''), String(ev.toolName ?? ''), (ev.args ?? {}) as Record<string, unknown>);
      const name = String(ev.toolName ?? 'tool');
      setTurnBubble(t('执行工具 {{name}}…', { name: name.replace(/_/g, '.') }), 'tool');
      const record: ToolCallRecord = {
        id: String(ev.toolCallId ?? Date.now()),
        name: name.replace(/_/g, '.'),
        arguments: JSON.stringify(ev.args ?? {}),
        status: 'running'
      };
      assistant.toolCalls = assistant.toolCalls ?? [];
      assistant.toolCalls.push(record);
      // 同一 record 引用挂进 parts，end 时原地改状态两边同步；
      // 有 parts 时渲染层只认 parts，工具卡必须进 parts 才显示
      (assistant.parts ??= []).push({ kind: 'tool', toolCall: record });
      emit('agent:tool', { messageId: assistant.id, toolCall: { ...record } });
    }
    if (event?.type === 'tool_execution_end') {
      const ev = event as Extract<PiAgentEvent, { type: 'tool_execution_end' }>;
      if (!hasAwaitedReview) void fileChanges?.toolEnd(String(ev.toolCallId ?? ''), !ev.isError);
      const id = String(ev.toolCallId ?? '');
      const rec = assistant.toolCalls?.find((t) => t.id === id);
      if (rec) {
        rec.status = ev.isError ? 'error' : 'ok';
        rec.result = typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? {});
        const preview = takeCapturePreview(id);
        if (preview) rec.previewPath = preview;
        emit('agent:tool', { messageId: assistant.id, toolCall: { ...rec } });
      }
    }
    if (event?.type === 'auto_retry_start') {
      const ev = event as Extract<PiAgentEvent, { type: 'auto_retry_start' }>;
      assistant.retryHint = t('⏳ 请求失败（{{error}}），{{delay}}后自动重试 {{attempt}}/{{max}}…', {
        error: ev.errorMessage,
        delay: ev.delayMs >= 1000 ? Math.round(ev.delayMs / 1000) + 's' : ev.delayMs + 'ms',
        attempt: ev.attempt,
        max: ev.maxAttempts
      });
      setTurnBubble(t('自动重试 {{attempt}}/{{max}}…', { attempt: ev.attempt, max: ev.maxAttempts }), 'thinking');
      emit('agent:message', { ...assistant });
      // abortRetry 的 AbortController 在 auto_retry_start 派发之后才创建；
      // 粘会话断流同会话再试必死，下一拍取消余下请求级重试，交给回合级重建会话。
      if (isStickySessionError(ev.errorMessage)) {
        setTimeout(() => {
          try {
            session.abortRetry?.();
          } catch {
            /* ignore */
          }
        }, 0);
      }
    }
    if (event?.type === 'auto_retry_end') {
      const ev = event as Extract<PiAgentEvent, { type: 'auto_retry_end' }>;
      if (ev.success) {
        assistant.retryHint = undefined;
        emit('agent:message', { ...assistant });
      }
    }
    if (event?.type === 'agent_end') {
      const ev = event as Extract<PiAgentEvent, { type: 'agent_end' }>;
      const outcome = lastAssistantOutcome(ev.messages);
      lastStopReason = outcome.stopReason;
      lastErrorMessage = outcome.errorMessage;
    }
    if (event?.type === 'agent_settled') {
      // 回合真正结束：失败则把错误落到消息上（UI 的 error-box + 重试入口都依赖它）
      if (lastStopReason === 'error' && lastErrorMessage) {
        assistant.error = lastErrorMessage;
        assistant.retryHint = undefined;
        emit('agent:message', { ...assistant });
      } else if (lastStopReason === 'aborted') {
        // 手动停止 / 会话销毁中止：标记后 UI 显示「已手动停止」，区别于正常完成
        assistant.aborted = true;
        assistant.retryHint = undefined;
        emit('agent:message', { ...assistant });
      }
      emitPiContext(session, emit, modelId);
    }
  });
}

/** agent_settled 后再放行一拍，等同批事件排干 */
const SETTLE_DRAIN_MS = 50;

function sessionModelReasoning(session: PiSessionHandle): boolean {
  // 缺字段按 reasoning 处理（调度旧默认 medium），避免误关小米思考流
  return session.model?.reasoning !== false;
}

async function runPiTurn(
  session: PiSessionHandle,
  text: string,
  wsId?: string,
  images?: ChatImageAttachment[],
  getThinkingLevel?: () => string | null,
  /** 回合作用域定性（B3 记忆写路径）：缺省用户对话回合；无头定时任务 'headless'；host 自治回合 'host' */
  turnKind: 'user' | 'headless' | 'host' = 'user',
  originalUserText?: string,
  notification?: { delivery: HostNotificationDelivery; show: (summary: string, id: string) => void },
  literalText = false
): Promise<void> {
  const abortKey = turnAbortKey(wsId);
  const ac = new AbortController();
  activeTurnAborts.set(abortKey, ac);
  // agent_end 是「单次 LLM 调用」结束的中间信号（自动重试的退避等待中也先发它），
  // 提前在这里收尾会把 pi 的自动重试 sleep 杀掉。回合真正结束以 agent_settled 为准。
  let settledOffBox: { off: (() => void) | null } = { off: null };
  const settled = new Promise<void>((resolve) => {
    settledOffBox.off = session.subscribe((event: PiAgentEvent) => {
      if (event?.type === 'agent_settled') {
        settledOffBox.off?.();
        settledOffBox.off = null;
        // agent_settled 与同批的末尾 token 同 tick 派发，让它们先落到 UI 再收尾
        setTimeout(resolve, SETTLE_DRAIN_MS);
      }
    });
  });
  const piImages = images?.map((img) => ({
    type: 'image' as const,
    data: img.data,
    mimeType: img.mimeType
  }));
  const requested = getThinkingLevel?.();
  const thinking = sessionReasoning.get(session)?.control.setLevel(requested) ??
    resolveThinkingLevel(GUI_THINKING_LEVELS.find(level => level === requested), sessionModelReasoning(session));
  safeSetThinkingLevel(session, thinking, (msg) =>
    console.warn('[pi] setThinkingLevel failed:', msg)
  );
  try {
    // 回合作用域（B3 记忆写路径）：用户对话回合传播本回合用户消息文本（memory.remember
    // 直写门证据 + §5 回合内污点）；无头定时任务只打 headless 标记——staging 种类门
    // 据此拒收无头候选，直写门在无头上下文保守拒绝；host 自治回合（MAJOR-1）无用户
    // 证据面（runAsNonUserTurn），污点跟踪保留，直写门保守拒绝。
    const run = (): Promise<unknown> =>
      Promise.race([
        notification ? sendHostNotification(session, notification.delivery, notification.show, true, text)
          : session.prompt(text, literalText ? { ...(piImages?.length ? { images: piImages } : {}), expandPromptTemplates: false }
            : piImages?.length ? { images: piImages } : undefined),
        settled
      ]);
    await (turnKind === 'user' && originalUserText !== undefined
      ? runWithTurnUserText(originalUserText, run)
      : turnKind !== 'headless'
        ? runAsNonUserTurn(run)
        : runAsHeadlessTurn(run));
  } catch (err) {
    try {
      session.abort?.();
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    // prompt 先失败/先返回时 settled 可能永不到来：退订防止长驻会话的监听器逐回合累积
    settledOffBox.off?.();
    settledOffBox.off = null;
    ac.abort();
    if (activeTurnAborts.get(abortKey) === ac) {
      sessionDeliveries.get(session)?.endTurn();
      activeTurnAborts.delete(abortKey);
    }
  }
}

async function createPiSession(
  ctx: AppContext,
  pi: PiModule,
  args: {
    cwd: string;
    workspaceContext: WorkspaceExecutionContext;
    wsId: string | undefined;
    forceNewSession: boolean | undefined;
    fullConfig: ReturnType<AppContext['config']['get']>;
    llmIdentity: string;
    targetModel?: { providerId?: string; modelId?: string };
    appendCustom: string | undefined;
    mode: AgentMode | undefined;
    /** 无头（定时任务）会话：独立中止键 + 独立会话桶，不挂 ask/plan 交互扩展 */
    headless?: {
      abortKey: string;
      sessionBucket: string;
    };
    /** 指定则打开该既有会话文件续聊（优先于 forceNew/continueRecent） */
    openSessionFile?: string;
    getThinkingLevel?: () => string | null;
    coreReasoning?: CoreReasoningBinding | null;
  }
): Promise<{ session: PiSessionHandle; modelId: string; providerId: string; sessionFile?: string }> {
  const assertLlmCurrent = () => assertLlmConnectionCurrent(ctx, args.targetModel, args.llmIdentity);
  assertLlmCurrent();
  // Open history and validate its source identity before model/resource loading can await.
  const sessionDir = ctx.store.getPiSessionDir(args.headless?.sessionBucket ?? args.wsId ?? 'default');
  const sessionManager = args.openSessionFile
    ? pi.SessionManager.open(args.openSessionFile, sessionDir, args.cwd)
    : args.forceNewSession
      ? pi.SessionManager.create(args.cwd, sessionDir)
      : pi.SessionManager.continueRecent(args.cwd, sessionDir);
  const workspaceContext = bindSchedulerSessionContext(ctx.config.get(), sessionManager, args.workspaceContext);
  const priorMsgs = sessionManager.buildSessionContext()?.messages?.length ?? 0;
  const userData = app.getPath('userData');
  const storage = userDataStorage(userData);
  const agentDir = storage.resolve('app', 'muster-core');
  await primePiCatalogSnapshot();
  assertLlmCurrent();
  // Other providers may have changed during catalog loading. Publish the current
  // config while retaining the selected model's verified connection snapshot.
  const synced = syncPiConfigFromApp(ctx.config.get(), agentDir);
  const mcp = resolveEffectiveMcpFromApp(args.fullConfig, args.wsId, 'pi-dispatcher');

  const { provider, model: resolvedModel } = resolveLlmConfig(args.fullConfig, args.targetModel);
  const providerId = provider.id;
  const modelId = resolvedModel.id;

  const modelRuntime = await pi.ModelRuntime.create({
    authPath: pathJoin(agentDir, 'auth.json'), modelsPath: pathJoin(agentDir, 'models.json'), allowModelNetwork: false
  });
  useProviderOutputDefaults(modelRuntime, synced.providerDefaultOutput);
  const registeredModel = modelRuntime.getModel(providerId, modelId);
  if (!registeredModel) {
    throw new Error(
      t('Muster Core 找不到模型 {{model}}。请检查模型设置中的 Base URL 和模型名。', {
        model: `${providerId}/${modelId}`
      })
    );
  }
  const binding = args.coreReasoning === undefined
    ? getConfiguredCoreReasoning(ctx.coreReasoningCatalog?.snapshot, provider, resolvedModel) : args.coreReasoning;
  const reasoning = binding ? configurePiReasoning(modelRuntime, registeredModel, binding) : undefined;
  const model = reasoning?.model ?? registeredModel;
  const authOk = await modelRuntime.checkAuth(providerId);
  assertLlmCurrent();
  if (!authOk) {
    throw new Error(t('Pi 模型 {{model}} 无可用凭证，请在设置中填写 API Key', { model: `${providerId}/${modelId}` }));
  }

  const skillPaths = workspaceSkillPaths(args.cwd, workspaceContext, 'pi-dispatcher');
  const mcpServers = mcp.enabled
    ? mcp.servers.filter((s) => s.enabled).map((s) => s.name)
    : [];
  // A4 轮级工具可见性（shared/turnVisibility）：无头定时任务会话 = prompt-task 回合类型
  //（每次运行新建独立会话，会话创建即回合发起），按映射收窄工具面（防定时任务递归自建
  // + 裁无关高危写组）。会话级判定唯一走 schedulerTurnKindFromTurnScope（词表对齐单源）：
  // 非无头会话是 user/host 共用长会话，基面按 'user'（→interactive）判定；事件唤醒轮
  //（host）不落会话级裁剪——pi setActiveToolsByName 是会话级开关（重建 system prompt），
  // 逐轮翻动会打穿前缀缓存，映射里该类型恒为空集（fail-open 见 turnVisibility）。
  const schedulerTurnKind: SchedulerTurnKind = schedulerTurnKindFromTurnScope(
    args.headless ? 'headless' : 'user'
  );
  const turnHidden = resolveTurnHiddenTools(schedulerTurnKind);
  // A2 stable/dynamic 分段：数组顺序 stable→dynamic，pi 侧 \n\n join 后 stable 字节恒在前
  const appendSegments = buildMetaAgentAppendPrompt(requireShellApi(ctx).baseUrl, {
    mcpEnabled: mcp.enabled,
    mcpServers,
    customBody: args.appendCustom,
    rules: args.fullConfig.agentRules,
    // A4：组级地图同步滤掉被裁组/工具，地图与实际工具面同源（prompt-task 轮非空）
    hiddenTools: turnHidden,
    workspaceContext
  });

  const delivery = new SchedulerPiDelivery(undefined, desktopEngineDeliveryFromContext(ctx));
  let session: PiSessionHandle | undefined;
  let stopRequestCapture: (() => void) | undefined;
  const registerTools = await registerToolsFactory(
    ctx,
    args.headless?.abortKey ?? args.wsId,
    turnHidden,
    // 动态工具同会话补注册只挂交互会话（无头任务会话按 task:<id> 中止键注册，
    // 匹配不了 workspaceId 事件且每次运行泄漏；无头轮的动态工具面本来也在
    // 注册面按 prompt-task 隐藏规则之外另行收敛）
    { workspaceContext, callerId: args.headless?.abortKey ?? `workspace:${workspaceContext.workspaceId}`, delivery,
      supportsCaptureImages: () => {
        const current = session?.model as { input?: readonly string[] } | undefined;
        return current?.input?.includes('image') === true;
      } }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const extensionFactories: Array<(api: any) => void> = [registerTools];
  extensionFactories.push(createCoreContextExtension(() => ctx.config.get().autoCompact));
  // ask/plan 模式扩展：controller 按 wsId 常驻，session 重建后复用同一状态（无头任务不挂）
  if (!args.headless) {
    extensionFactories.push(
      createModeExtensionFactory(ensureModeController(args.wsId, args.mode ?? 'default'))
    );
  }
  let getReadableSkills: () => ReturnType<ReturnType<typeof createSkillSourceLoader>['getSkills']>['skills'] = () => [];
  extensionFactories.push(createSchedulerDirectoryExtension(ctx, workspaceContext, () => getReadableSkills()));

  // B1：第三方 MCP 不再挂会话级 mcp 单工具扩展——mcp.search / mcp.call 作为 catalog 常驻
  // 工具经 registerTools 注册（residentHostToolIds('scheduler')），执行走 capabilities/hosts/mcp.ts
  // 的共享中转 hub（mcpHub 仍是唯一出口），调度/GUI/PTY/ACP 全角色一个形态。

  try {
    extensionFactories.push(createSchedulerWorkerRoutingExtension(workspaceContext.workspaceId,
      () => summarizeWorkerRoutingTiers(ctx.config.get(), workspaceContext.workspaceId)));
    const resourceLoader = createSkillSourceLoader(pi, {
      cwd: args.cwd,
      agentDir,
      additionalSkillPaths: skillPaths,
      appendSystemPrompt: appendSegments,
      extensionFactories
    }, args.cwd, agentDir, workspaceContext, 'pi-dispatcher');
    getReadableSkills = () => resourceLoader.getSkills().skills;

    await resourceLoader.reload({
      resolveProjectTrust: async () => true
    });
    assertLlmCurrent();
    assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);

    const skills = resourceLoader.getSkills()?.skills?.length ?? 0;
    const agents = resourceLoader.getAgentsFiles()?.agentsFiles?.length ?? 0;
    console.log(
      `[pi] cwd=${args.cwd} skills=${skills} agentsMd=${agents} extraSkillPaths=${skillPaths.length} mcp=${mcpServers.join(',') || 'off'}`
    );

    const toolNames = [
      CORE_CONTEXT_TOOL,
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      ...schedulerProjectedCatalog().map(entry => toApiName(entry.name))
    ];
    // A4：被裁 catalog 工具展开成 pi 侧 excludeTools 名单（registry 名是 toApiName 形态）。
    // 用「全量 allowlist + 排除名单」而非收窄 allowlist：保持既有 ext.*/mcp 激活语义零扰动，
    // 只做减法。空隐藏面不传，交互会话字节级不变。
    const visibleProjected = new Set(schedulerProjectedCatalog(turnHidden).map(entry => entry.name));
    const excludedApiTools = schedulerProjectedCatalog().filter(entry => !visibleProjected.has(entry.name)).map(entry => toApiName(entry.name));

    const requested = args.getThinkingLevel?.();
    const effThinking = reasoning?.setLevel(requested) ??
      resolveThinkingLevel(GUI_THINKING_LEVELS.find(level => level === requested), !!model.reasoning);
    if (!args.headless) {
      const traceDirectory = storage.resolve('app', 'pi-sessions');
      stopRequestCapture = captureModelRequests(modelRuntime, userData, schedulerModelRequestId(workspaceContext.workspaceId),
        message => console.warn('[model-requests] scheduler capture failed:', message), {
          leaf: () => sessionManager.getLeafId(),
          trace: (body, leaf) => traceRequestCompression(body, leaf, sessionManager, traceDirectory, pi.buildSessionProjection)
        });
    }
    const created = await pi.createAgentSession({
      cwd: args.cwd,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      tools: toolNames,
      // A4 轮级工具可见性：prompt-task 轮排除被裁工具（pi「Applies after tools」，下一回合/
      // 首回合生效，system prompt 同步按 active 集重建——被裁工具不进 Available tools 段）
      ...(excludedApiTools.length > 0 ? { excludeTools: excludedApiTools } : {}),
      thinkingLevel: effThinking
    });
    session = created.session as PiSessionHandle;
    if (stopRequestCapture) sessionRequestCaptures.set(session, stopRequestCapture);
    if (reasoning && binding) sessionReasoning.set(session, { key: JSON.stringify(binding), control: reasoning });
    delivery.attach(created.session.agent);
    sessionDeliveries.set(session, delivery);
    installAttachmentPayload(session, app.getPath('userData'), `scheduler:${args.wsId || 'default'}`);
    assertLlmCurrent();
    assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
    rememberSchedulerConnectionContext(session, workspaceContext);
    sessionLlmIdentities.set(session, args.llmIdentity);
    safeSetThinkingLevel(session, effThinking, (msg) =>
      console.warn('[pi] setThinkingLevel failed:', msg)
    );
    console.log(
      `[pi] session=${sessionManager.getSessionId()} file=${sessionManager.getSessionFile() ?? '(new)'} priorMsgs=${priorMsgs} forceNew=${!!args.forceNewSession}`
    );
    return { session, modelId, providerId, sessionFile: sessionManager.getSessionFile() };
  } catch (error) {
    stopRequestCapture?.();
    delivery.close();
    if (session) sessionDeliveries.delete(session);
    if (session) {
      sessionRequestCaptures.delete(session);
      sessionLlmIdentities.delete(session);
      sessionReasoning.delete(session);
    }
    if (session) await session.dispose?.();
    throw error;
  }
}

function assertLlmConnectionCurrent(ctx: AppContext, target: PiRunArgs['targetModel'], identity: string): void {
  if (llmConnectionIdentity(resolveLlmConfig(ctx.config.get(), target)) !== identity) {
    throw new Error(t('模型连接配置在准备期间变化，请重试'));
  }
}
/**
 * Pi coding-agent SDK：进程内常驻 session，会话落盘到 userData/pi-sessions。
 */
export async function runPiProvider(args: PiRunArgs): Promise<void> {
  const context = args.workspaceContext ?? captureSchedulerWorkspaceContext(args.ctx.config.get(), args.workspaceId,
    args.getSession(), args.openSessionFile, !!args.forceNewSession);
  const release = args.workspaceContext ? undefined : beginSchedulerWorkspaceContext(args.ctx.config, context);
  try { await runScopedPiProvider(args, context); }
  finally { release?.(); }
}

async function runScopedPiProvider(args: PiRunArgs, workspaceContext: WorkspaceExecutionContext): Promise<void> {
  const { ctx, text, assistant, emit, getSession, setSession, forceNewSession, workspaceId: wsId } = args;
  const { fullConfig: fullCfg, resolved } = resolveLlmConfigWithReload(ctx.config, args.targetModel);
  const llmIdentity = llmConnectionIdentity(resolved);

  const providerId = resolved.provider.id;
  const modelId = resolved.model.id;
  const requestedThinking = args.getThinkingLevel?.() ?? null;
  const pi = await loadPi();
  await primePiCatalogSnapshot();
  const coreReasoning = getConfiguredCoreReasoning(ctx.coreReasoningCatalog?.snapshot, resolved.provider, resolved.model) ?? null;
  assertLlmConnectionCurrent(ctx, args.targetModel, llmIdentity);
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
  const cwd = workspaceContext.cwd;

  let session = getSession();
  let sessionFile = args.openSessionFile;
  if (session) {
    const cur = session.model;
    if (forceNewSession || JSON.stringify(getSchedulerConnectionContext(session)) !== JSON.stringify(workspaceContext) ||
        sessionLlmIdentities.get(session) !== llmIdentity || sessionReasoning.get(session)?.key !== reasoningKey(coreReasoning) ||
        (cur?.id && cur.id !== modelId) || (cur?.provider && cur.provider !== providerId)) {
      sessionFile = forceNewSession ? undefined : session.sessionManager?.getSessionFile?.() ?? sessionFile;
      console.log(
        `[pi] recreate session: directories/model changed → ${providerId}/${modelId}`
      );
      await disposePiSessionResources(session, wsId);
      setSession(null);
      session = null;
    }
  }
  if (!session) {
    const created = await createPiSession(ctx, pi, {
      cwd,
      workspaceContext,
      wsId,
      forceNewSession,
      openSessionFile: forceNewSession ? undefined : sessionFile,
      fullConfig: fullCfg,
      llmIdentity,
      targetModel: args.targetModel,
      appendCustom: fullCfg.dispatcherAppendPrompt,
      mode: args.mode,
      getThinkingLevel: () => requestedThinking, coreReasoning
    });
    session = created.session;
    setSession(session);
    args.onSessionCreated?.(created.sessionFile);
    emitPiContext(session, emit, created.modelId);
  } else {
    emitPiContext(session, emit, modelId);
  }

  const unsubReview = subscribePiReview(session, args.fileChanges);
  const unsub = subscribePiTurn(session, args.getAssistant ?? (() => assistant), emit, modelId, args.fileChanges,
    event => {
      if (wsId) desktopTurnGrants.observePiMessage(`orchestrator:${wsId}`, event);
      args.onPiEvent?.(event);
    });
  try {
    assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
    // Digest is consumed by the next real turn, without scheduling an extra loop.
    if (!args.notification && wsId && args.onNotification) {
      await sendHostNotification(session, hostNotificationDelivery(ctx, wsId), args.onNotification, false);
    }
    assertLlmConnectionCurrent(ctx, args.targetModel, llmIdentity);
    await runPiTurn(session, text, wsId, args.images, () => requestedThinking, args.turnKind ?? 'user', args.originalUserText,
      args.notification ? { delivery: args.notification, show: args.onNotification ?? (() => {}) } : undefined, args.literalText);
  } finally {
    emitPiContext(session, emit, modelId);
    unsub();
    unsubReview();
  }
}

/**
 * 调度手动压缩（/compact）：活会话直接压；无活会话但绑定会话文件在（重启后、
 * 或刚切换历史会话），先按文件续聊建会话再压——建好的会话留在桶里，下回合复用。
 * 模型与生效配置不一致时先重建（与 runPiProvider 同判键），压缩摘要才用当前模型生成。
 */
export async function compactOrchestratorSession(args: {
  ctx: AppContext;
  wsId?: string;
  getSession: () => PiSessionHandle | null;
  setSession: (s: PiSessionHandle | null) => void;
  sessionFile?: string;
  targetModel?: { providerId?: string; modelId?: string };
  mode?: AgentMode;
  getThinkingLevel?: () => string | null;
  instructions?: string;
}): Promise<PiCompactResult> {
  if (!args.getSession() && !args.sessionFile) return { ok: false, error: t('会话还没有内容，无需压缩') };
  const context = captureSchedulerWorkspaceContext(args.ctx.config.get(), args.wsId, args.getSession(), args.sessionFile);
  const release = beginSchedulerWorkspaceContext(args.ctx.config, context);
  try { return await compactScopedOrchestratorSession(args, context); }
  finally { release(); }
}

async function compactScopedOrchestratorSession(
  args: Parameters<typeof compactOrchestratorSession>[0], workspaceContext: WorkspaceExecutionContext
): Promise<PiCompactResult> {
  const { ctx } = args;
  const cwd = workspaceContext.cwd;
  const { fullConfig: fullCfg, resolved } = resolveLlmConfigWithReload(ctx.config, args.targetModel);
  const llmIdentity = llmConnectionIdentity(resolved);

  const pi = await loadPi();
  await primePiCatalogSnapshot();
  const coreReasoning = getConfiguredCoreReasoning(ctx.coreReasoningCatalog?.snapshot, resolved.provider, resolved.model) ?? null;
  assertLlmConnectionCurrent(ctx, args.targetModel, llmIdentity);
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
  let session = args.getSession();
  let sessionFile = args.sessionFile;
  if (session) {
    const cur = session.model;
    if (
      JSON.stringify(getSchedulerConnectionContext(session)) !== JSON.stringify(workspaceContext) ||
      sessionLlmIdentities.get(session) !== llmIdentity || sessionReasoning.get(session)?.key !== reasoningKey(coreReasoning) ||
      (cur?.id && cur.id !== resolved.model.id) ||
      (cur?.provider && cur.provider !== resolved.provider.id)
    ) {
      sessionFile = session.sessionManager?.getSessionFile?.() ?? sessionFile;
      console.log(
        `[pi] compact recreate session: directories/model changed → ${resolved.provider.id}/${resolved.model.id}`
      );
      await disposePiSessionResources(session, args.wsId);
      args.setSession(null);
      session = null;
    }
  }
  if (!session) {
    if (!sessionFile) return { ok: false, error: t('会话还没有内容，无需压缩') };
    const created = await createPiSession(ctx, pi, {
      cwd,
      workspaceContext,
      wsId: args.wsId,
      forceNewSession: undefined,
      openSessionFile: sessionFile,
      fullConfig: fullCfg,
      llmIdentity,
      targetModel: args.targetModel,
      appendCustom: fullCfg.dispatcherAppendPrompt,
      mode: args.mode,
      getThinkingLevel: args.getThinkingLevel, coreReasoning
    });
    session = created.session;
    args.setSession(session);
  }
  assertLlmConnectionCurrent(ctx, args.targetModel, llmIdentity);
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
  return safeCompactSession(session, args.instructions);
}

// ---------- 定时任务无头执行 ----------

/** 无头输出摘要上限（字符）：超长只保留尾部 */
const HEADLESS_OUTPUT_LIMIT = 20_000;

export interface HeadlessPiTaskOptions {
  /** 任务所属工作区：决定 cwd 解析 */
  wsId: string;
  sourceRoot?: SessionMeta['sourceRoot'];
  /** 中止键，调用方传 `task:<taskId>`，与用户聊天回合隔离 */
  abortKey: string;
  prompt: string;
  timeoutMs: number;
  /** 绑定的服务商 id */
  providerId?: string;
  /** 绑定的模型 id */
  modelId?: string;
  /** 会话文件就绪（进行中即可回看/跳转） */
  onSessionReady?: (piSessionPath: string) => void;
  /** 输出增量（已截断） */
  onOutput?: (output: string) => void;
}

export interface HeadlessPiTaskResult {
  ok: boolean;
  output: string;
  error?: string;
  piSessionPath?: string;
  durationMs: number;
}

/**
 * 定时任务无头执行：每次运行创建全新 Pi 会话（落工作区独立任务桶，不抢占聊天的
 * continueRecent），聚合 assistant 文本输出，结束即清理全部会话资源。
 */
export async function runHeadlessPiTask(
  ctx: AppContext,
  opts: HeadlessPiTaskOptions
): Promise<HeadlessPiTaskResult> {
  const context = captureSchedulerWorkspaceContext(ctx.config.get(), opts.wsId, null, undefined, true, opts.sourceRoot);
  const release = beginSchedulerWorkspaceContext(ctx.config, context, { publish: false, id: opts.abortKey });
  try { return await runOutsideSchedulerDesktopTurn(() => runScopedHeadlessPiTask(ctx, opts, context)); }
  finally { release(); }
}

async function runScopedHeadlessPiTask(ctx: AppContext, opts: HeadlessPiTaskOptions,
  workspaceContext: WorkspaceExecutionContext): Promise<HeadlessPiTaskResult> {
  const startedAt = Date.now();
  const targetModel = { providerId: opts.providerId, modelId: opts.modelId };
  const { fullConfig: fullCfg, resolved } = resolveLlmConfigWithReload(ctx.config, targetModel);
  const llmIdentity = llmConnectionIdentity(resolved);
  const pi = await loadPi();
  assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
  const cwd = workspaceContext.cwd;

  const created = await createPiSession(ctx, pi, {
    cwd,
    workspaceContext,
    wsId: opts.wsId,
    forceNewSession: true,
    fullConfig: fullCfg,
    llmIdentity,
    targetModel,
    appendCustom: fullCfg.dispatcherAppendPrompt,
    mode: undefined,
    headless: {
      abortKey: opts.abortKey,
      sessionBucket: `${opts.wsId}:tasks`
    }
  });
  const session = created.session;
  let output = '';
  const clipOutput = (): string =>
    output.length > HEADLESS_OUTPUT_LIMIT ? `…${output.slice(-HEADLESS_OUTPUT_LIMIT)}` : output;
  if (created.sessionFile) {
    try {
      opts.onSessionReady?.(created.sessionFile);
    } catch {
      /* 回看回调失败不影响执行 */
    }
  }
  let lastStopReason: string | undefined;
  let lastErrorMessage: string | undefined;
  let lastOutputFlush = 0;
  const off = session.subscribe((event: PiAgentEvent) => {
    if (event?.type === 'message_update') {
      const ev = event as Extract<PiAgentEvent, { type: 'message_update' }>;
      if (ev.assistantMessageEvent?.type === 'text_delta' && ev.assistantMessageEvent.delta) {
        output += ev.assistantMessageEvent.delta;
        // 防御性截断：超长回合不让缓冲无限膨胀，最终摘要只保留尾部
        if (output.length > HEADLESS_OUTPUT_LIMIT * 2) {
          output = output.slice(-HEADLESS_OUTPUT_LIMIT * 2);
        }
        const now = Date.now();
        if (now - lastOutputFlush >= 1500) {
          lastOutputFlush = now;
          try {
            opts.onOutput?.(clipOutput());
          } catch {
            /* ignore */
          }
        }
      }
    }
    if (event?.type === 'agent_end') {
      const ev = event as Extract<PiAgentEvent, { type: 'agent_end' }>;
      const outcome = lastAssistantOutcome(ev.messages);
      lastStopReason = outcome.stopReason;
      lastErrorMessage = outcome.errorMessage;
    }
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      session.abort?.();
    } catch {
      /* ignore */
    }
  }, opts.timeoutMs);
  timeout.unref?.();

  const finalize = (ok: boolean, error?: string): HeadlessPiTaskResult => {
    // 无头使用计数在 tasks/manager.execHeadless 收口（与 task-runs 列表同源），此处不重复计
    if (created.sessionFile) {
      try {
        opts.onSessionReady?.(created.sessionFile);
      } catch {
        /* ignore */
      }
    }
    return {
      ok,
      output: clipOutput(),
      error,
      piSessionPath: created.sessionFile,
      durationMs: Date.now() - startedAt
    };
  };

  try {
    assertWorkspaceExecutionContextCurrent(ctx.config.get(), workspaceContext);
    assertLlmConnectionCurrent(ctx, targetModel, llmIdentity);
    await runPiTurn(session, opts.prompt, opts.abortKey, undefined, undefined, 'headless');
    if (timedOut) {
      return finalize(false, t('执行超时（{{n}} 分钟），已中止', { n: Math.round(opts.timeoutMs / 60000) }));
    }
    if (lastStopReason === 'error') {
      return finalize(false, lastErrorMessage ?? t('模型返回错误'));
    }
    if (lastStopReason === 'aborted') {
      return finalize(false, t('回合被中止'));
    }
    return finalize(true);
  } catch (err) {
    return finalize(false, errorMessage(err));
  } finally {
    clearTimeout(timeout);
    off();
    await disposePiSessionResources(session, opts.abortKey);
  }
}

// ---------- 调度面板历史会话 ----------

/** 历史列表最多返回条数 */
const MAX_SESSION_SUMMARIES = 100;

/** 单工作区会话摘要：聊天桶 + 定时任务桶（<wsId>:tasks）合并，按修改时间倒序 */
export async function listPiSessions(ctx: AppContext, wsId: string): Promise<AgentSessionSummary[]> {
  const pi = await loadPi();
  const fullCfg = ctx.config.get();
  const wsMeta = fullCfg.workspaces.find((w) => w.id === wsId);
  const cwd = wsMeta?.path ? wsMeta.path : fullCfg.workspace;
  const out: AgentSessionSummary[] = [];

  const collect = async (bucket: string, isTask: boolean): Promise<void> => {
    const dir = ctx.store.getPiSessionDir(bucket);
    let infos;
    try {
      infos = await pi.SessionManager.list(cwd, dir);
    } catch {
      return;
    }
    for (const info of infos) {
      const taskName = isTask ? ctx.tasks.findTaskNameByPiSessionPath(info.path) : undefined;
      out.push({
        path: info.path,
        id: info.id,
        title: pickSessionTitle({
          name: info.name,
          firstMessage: info.firstMessage,
          isTask,
          taskName
        }),
        modified: info.modified instanceof Date ? info.modified.getTime() : Date.now(),
        messageCount: info.messageCount,
        isTask,
        taskName
      });
    }
  };

  await collect(`${wsId}:tasks`, true);
  await collect(wsId, false);
  out.sort((a, b) => b.modified - a.modified);
  return out.slice(0, MAX_SESSION_SUMMARIES);
}

function entryText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      parts.push(String((block as { text?: string }).text ?? ''));
    }
  }
  return parts.join('');
}

/** 按块顺序把 Pi 内容块映射成交错 parts（thinking 不再丢弃；工具块不还原） */
function entryParts(content: unknown): ChatDisplayPart[] {
  if (!Array.isArray(content)) return [];
  const out: ChatDisplayPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = (block as { type?: string }).type;
    if (type === 'text') {
      const text = String((block as { text?: string }).text ?? '');
      if (text) out.push({ kind: 'text', text });
    } else if (type === 'thinking') {
      const text = String((block as { thinking?: string }).thinking ?? '');
      if (text) out.push({ kind: 'thinking', text });
    }
  }
  return out;
}

/** 只读装载一个历史 Pi 会话为 display 消息（时间取 entry 时间戳；工具调用不还原） */
export async function loadPiSessionDisplay(
  ctx: AppContext,
  wsId: string,
  sessionFile: string
): Promise<ChatMessage[]> {
  const pi = await loadPi();
  const sessionDir = ctx.store.getPiSessionDir(wsId);
  const sm = pi.SessionManager.open(sessionFile, sessionDir);
  const display: ChatMessage[] = [];
  for (const entry of sm.getEntries()) {
    if (!entry || (entry as { type?: string }).type !== 'message') continue;
    const msg = (entry as { message?: { role?: string; content?: unknown } }).message;
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const text = entryText(msg.content).trim();
    if (msg.role === 'user' && text.startsWith(HOST_NOTIFICATION_TRIGGER)) continue;
    if (!text) continue;
    const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? '');
    const parts = msg.role === 'assistant' ? entryParts(msg.content) : [];
    display.push({
      id: randomUUID(),
      role: msg.role,
      content: text,
      ...(parts.length > 0 ? { parts } : {}),
      createdAt: Number.isFinite(ts) ? ts : Date.now()
    });
  }
  return display;
}

/**
 * 重命名一个历史 Pi 会话：追加一条 session_info 条目（Pi 原生机制），
 * 下次 list 会把该名作为标题。空名等价于清除自定义名回落到首条消息。
 */
export async function renamePiSession(
  ctx: AppContext,
  wsId: string,
  sessionFile: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  // 限定只能改本工作区会话目录下的文件（聊天桶 / 定时任务桶），避免路径穿越
  const allowedDirs = [ctx.store.getPiSessionDir(wsId), ctx.store.getPiSessionDir(`${wsId}:tasks`)];
  const dir = dirname(sessionFile);
  if (!allowedDirs.includes(dir)) {
    return { ok: false, error: t('目标文件不在当前工作区会话目录内') };
  }
  const pi = await loadPi();
  const sessionDir = ctx.store.getPiSessionDir(wsId);
  try {
    const sm = pi.SessionManager.open(sessionFile, sessionDir);
    sm.appendSessionInfo(name);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: t('重命名失败：{{message}}', { message: (e as Error).message }) };
  }
}

/**
 * 删除一个历史 Pi 会话 jsonl 文件。仅删磁盘文件，不动桶内指针
 * （调用方负责判断是否是当前绑定会话并清理桶状态）。
 */
export async function deletePiSession(
  ctx: AppContext,
  wsId: string,
  sessionFile: string
): Promise<{ ok: boolean; error?: string }> {
  // 限定只能删本工作区会话目录下的文件（聊天桶 / 定时任务桶），避免路径穿越
  const allowedDirs = [ctx.store.getPiSessionDir(wsId), ctx.store.getPiSessionDir(`${wsId}:tasks`)];
  const dir = dirname(sessionFile);
  if (!allowedDirs.includes(dir)) {
    return { ok: false, error: t('目标文件不在当前工作区会话目录内') };
  }
  try {
    if (!existsSync(sessionFile)) return { ok: true };
    await fsp.unlink(sessionFile);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: t('删除失败：{{message}}', { message: (e as Error).message }) };
  }
}

/**
 * 新建一条调度 Pi 会话并回放种子（fork / 给尚无落盘文件的原会话补档）。
 * 只写 jsonl，不建 AgentSession、不碰原文件。
 */
export async function createForkedPiSession(
  ctx: AppContext,
  wsId: string,
  seeds: Iterable<OrchestratorForkSeed>,
  title: string,
  targetModel?: { providerId?: string; modelId?: string },
  source?: { workspaceContext: WorkspaceExecutionContext; parentFile?: string }
): Promise<{ ok: boolean; sessionFile?: string; id?: string; error?: string }> {
  let release: (() => void) | undefined;
  try {
    const fullCfg = ctx.config.get();
    const context = source?.workspaceContext ?? captureSchedulerWorkspaceContext(fullCfg, wsId);
    if (context.workspaceId !== wsId) throw new Error('scheduler fork belongs to another workspace');
    assertWorkspaceExecutionContextCurrent(fullCfg, context);
    if (!source) release = beginSchedulerWorkspaceContext(ctx.config, context, { publish: false, id: `fork:${wsId}` });
    const sessionDir = ctx.store.getPiSessionDir(wsId);
    const resolved = resolveLlmConfig(fullCfg, targetModel);
    const pi = await loadPi();
    return { ok: true, ...writeSchedulerForkFile(ctx.config, pi, { context, sessionDir, seeds, title,
      parentFile: source?.parentFile, model: { api: resolved.provider.api || 'openai-completions',
        provider: resolved.provider.id, model: resolved.model.id } }) };
  } catch (e) {
    return { ok: false, error: t('创建会话失败：{{message}}', { message: (e as Error).message }) };
  } finally { release?.(); }
}
