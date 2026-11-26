/**
 * GUI（chat surface）Worker 的 driver 合同（精简版 Cherry AgentSessionRuntimeDriver）。
 * Host 不知道具体引擎；Host / 渲染主干不按 runtime id 分支。
 * 硬性要求：driver 必须在每轮结束时发 turn-complete 或 error，否则视为未完成。
 */
import type { ChatUserQuestionItem, GuiWorkerMode, SessionMeta, WorkerPermissionMode } from '../../shared/types';
import type { GuiToolPermissionClass } from '../../shared/guiWorkerPolicy';
import type { GuiEngineCapture, GuiHarnessSummary } from '../../shared/guiWorker';
import type { ReportedFileChange } from '../../shared/turnChanges';
import type { ModeController } from '../agent/providers/modeExtension';
import type { WorkspaceExecutionContext } from '../../shared/workspaceExecutionContext';
import type { NativeApprovalChoice, NativeConfigIntent, NativeConfigState, NativeConfigValue } from '../../shared/nativeSessionConfig';

/** Delivery failures distinguish a known pre-submit failure from an uncertain write. */
export class GuiDeliveryError extends Error {
  /** Internal coordination: the connection's event stream will report this error. */
  reportedByStream = false;
  constructor(message: string, readonly delivery: 'not-submitted' | 'unknown', readonly partialSummary?: GuiHarnessSummary) {
    super(message);
    this.name = 'GuiDeliveryError';
  }
}

/** Host 注册给引擎的进程内工具（宿主四件套 / MCP 代理；引擎原生工具不走这里） */
export interface GuiHostTool {
  /** 对外名（点号名，如 sessions.setStatus）；引擎注册名由各 driver 自行映射 */
  id: string;
  label: string;
  description: string;
  /** 一句话参数要点（进系统提示目录） */
  argsHint?: string;
  /** JSON Schema（driver 注册引擎工具用） */
  parameters: Record<string, unknown>;
  permissionClass: GuiToolPermissionClass;
  /** Catalog executor emits a structured JSON result envelope. */
  resultFormat?: 'execute-result-json';
  execute(args: Record<string, unknown>, ctx: GuiToolExecContext): Promise<string>;
}

export interface GuiToolExecContext {
  sessionId: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface GuiApprovalRequest {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 为什么需要审批（如「工作区外路径」） */
  reason?: string;
  /** A trusted gateway already determined this real action requires a human. */
  requireHumanApproval?: boolean;
  /** Choices from the engine's own approval request. */
  nativeChoices?: NativeApprovalChoice[];
  nativeSource?: string;
}

export interface GuiApprovalDecision {
  approved: boolean;
  nativeChoiceId?: string;
  reason?: string;
  /** C2 计划门：批准回灌「Approved Plan」文本（driver 注入上下文） */
  feedback?: string;
  /** C2 计划门：批准后生效的 allowedPrompts 预授权清单 */
  allowedPrompts?: string[];
}

/** 用户提问请求（ask_user_question / 计划审阅；questions 词表与 GuiUserQuestionItem 同形） */
export interface GuiUserQuestionRequest {
  questions: ChatUserQuestionItem[];
}

/** 作答结果；driver 侧 reject（或 resolve aborted）表示用户取消作答 */
export interface GuiUserQuestionResult {
  kind: 'answered';
  answers: Array<{ id: string; selected: string[]; custom?: string; }>;
}

export type GuiUserQuestionOutcome = GuiUserQuestionResult | { kind: 'aborted'; };

export type GuiDriverStreamEvent =
  | { type: 'engine-input'; identity: GuiForkIdentity; text: string }
  | { type: 'turn-started'; userMessageId: string }
  | { type: 'native-config'; state: NativeConfigState }
  | { type: 'native-message-start'; messageId: string; text: string }
  | { type: 'native-fork-points'; sessionToken: string; engine: 'pi' | 'pi-external' | 'omp' | 'claude' | 'codex' | 'opencode'; points: Array<{ messageId: string; entryId: string }> }
  | { type: 'execution'; state: import('../../shared/executionLifecycle').ExecutionLifecycle }
  | { type: 'text-delta'; delta: string; }
  | { type: 'thinking-delta'; delta: string; }
  | {
      type: 'tool-start';
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
      /** Arguments shown in the card when input also carries review metadata. */
      displayInput?: Record<string, unknown>;
      /** 协议声明的工具类别（ACP `kind`：read/edit/delete/move/search/execute/think/fetch/other）；toolName 可能只是展示标题 */
      toolKind?: string;
      /** A completed-only event cannot supply an observed pre-write image. */
      reviewLate?: boolean;
    }
  | { type: 'tool-update'; toolCallId: string; toolName: string; input: Record<string, unknown>; displayInput?: Record<string, unknown>; toolKind?: string; reviewLate?: boolean }
  | { type: 'review-tool-start' | 'review-tool-update'; toolCallId: string; toolName: string; input: Record<string, unknown>; toolKind?: string; reviewLate?: boolean }
  | { type: 'review-tool-result'; toolCallId: string; ok: boolean; patch?: string; reviewChanges?: ReportedFileChange[] }
  | { type: 'review-warning'; message: string }
  | {
      /** 子代理嵌套流：思考/正文增量贴到父工具卡，禁止摊进主对话 parts */
      type: 'tool-progress';
      /** Preserve the origin so display history can exclude nested reasoning. */
      thinking?: boolean;
      toolCallId: string;
      delta: string;
    }
  | {
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      output: string;
      /** 编辑类工具的 unified patch（渲染层 git-diff 展示；engine 没有就缺省） */
      patch?: string;
      /** Provider-supplied per-file diff; review-only unless independently verified. */
      reviewChanges?: ReportedFileChange[];
      /** 工具执行时长（driver 起止打点；Pi 透明模式计量用） */
      durationMs?: number;
    }
  | { type: 'resume-token'; token: string; }
  | { type: 'context-usage'; usage: GuiContextUsage | null }
  | {
      type: 'available-commands';
    commands: Array<{ name: string; description?: string; inputHint?: string; }>;
    }
  | { type: 'current-mode'; modeId: string; name?: string; }
  | {
      /** 回合收口；summary 为 harness 透明计量（Pi driver 组装，其他引擎逐步补） */
      type: 'turn-complete';
      summary?: GuiHarnessSummary;
      /** A cancelled terminal result is not evidence that the input was accepted. */
      cancelled?: true;
    }
  | {
      /** 插话（steer）已注入引擎（pi-trajectory-plan v3：聊天可见的插话线数据源） */
      type: 'steering';
      text: string;
    }
  | {
      /**
       * 插话注入失败（重试后仍拒绝）：引擎从未收到该文本。Host 须把 text 回队，
       * 下轮自动送达——不得静默丢弃（2026-10-01 接入审查 M-7）。
       */
      type: 'steering-failed';
      text: string;
      reason: string;
    }
  | {
      /**
       * 逐轮注入变化（pi modeHooks stable 快照重渲染/首轮报到）：Host 据此落新注入代际
       * （记忆段/回合注入从「连接时预记」改为「真实逐轮文本报到」）
       */
      type: 'injection-update';
      source: string;
      text: string;
    }
  | {
      /**
       * 上下文压缩生命周期（pi-trajectory-plan v3 B3'：账本退役后压缩分隔的独立事件源；
       * willRetry=true 表示 SDK 正在自动重试摘要，生命周期保持打开）
       */
      type: 'compaction';
      phase: 'start' | 'end';
      aborted?: boolean;
      willRetry?: boolean;
      errorMessage?: string;
    }
  | {
      type: 'error';
      message: string;
      /** Structured native failure; settled requires an engine terminal receipt and tool reconciliation. */
      workerFailure?: import('../tasks/workerRoutingPolicy').WorkerRuntimeFailure & { boundary: 'settled' | 'not-submitted' };
      /** 失败回合的已结算计量（已烧 token 不随回合失败丢失；子代理预算口径） */
      summary?: GuiHarnessSummary;
    };

/** fork 的引擎侧种子消息（纯文本重建；user/assistant 交替） */
export interface GuiSeedMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

/** Candidate correspondence, verified against the provider's native history before forking. */
export interface GuiNativeForkPoint {
  engine: 'pi' | 'pi-external' | 'omp' | 'claude' | 'codex' | 'opencode';
  sessionToken: string;
  entryId: string;
  role: 'user' | 'assistant';
}

export interface GuiForkIdentity {
  userMessageId?: string;
  assistantMessageId: string;
}

export interface GuiInputAuthority {
  userText?: string;
  forkIdentity?: GuiForkIdentity;
  literalText?: boolean;
}

export interface GuiDriverConnectInput {
  /** Explicit, host-validated creation selections. Never reconstructed from guiMode. */
  nativeConfig?: NativeConfigIntent;
  /** Host-selected default. Drivers may only apply verified native permission values. */
  automaticPermissions?: boolean;
  getAutomaticPermissions?(): boolean;
  getNativePermissionRestore?(): NativeConfigIntent['selections'] | undefined;
  /** Journal native values before overriding them. Omit selections after confirmed restoration. */
  onNativePermissionRestore?(selections?: NativeConfigIntent['selections']): Promise<void>;
  /** A settings-owned policy digest; recheck it before submitting a replacement turn. */
  workerPermission?: { snapshot: string; assertCurrent(turnId: string): void };
  /** The external engine owns permissions for its operations. */
  nativePermissions?: boolean;
  /** Canonical parameter snapshot for this connection. No native SDK fields cross the host. */
  modelParameters?: import('../../shared/modelParameters').ModelParameterValues;
  /** The selected Core endpoint's catalog capability, frozen with the turn. */
  coreReasoning?: import('../agent/coreReasoningCatalog').CoreReasoningBinding | null;
  sessionId: string;
  /** Host session task identity, when this connection belongs to a background task. */
  taskId?: string;
  /** Human-facing names are host snapshots, never renderer supplied. */
  sessionName?: string;
  cwd: string;
  /** Registered source directory whose manually discovered model snapshot applies. */
  modelCatalogCwd?: string;
  /** Host-captured connection snapshot; never supplied by a model or renderer. */
  workspaceContext?: WorkspaceExecutionContext;
  /** Mode persona and extension instructions for the engine's system prompt, when supported. */
  systemPromptAppend: string;
  /** Host guidance still pending for this GUI conversation, appended after the first eligible input (legacy field name). */
  firstPromptPrefix?: string;
  /**
   * Pi 自定义模式的引擎原生工具白名单（read/write/edit/bash 子集；缺省全量）。
   * 仅 Pi driver 消费。
   */
  nativeTools?: string[];
  /** 引擎原生工具黑名单（excludeTools 语义，在白名单之后应用）。仅 Pi driver 消费 */
  nativeToolsDeny?: string[];
  /** 覆盖默认思考档（缺省：reasoning 模型 medium / 非 reasoning off）。仅 Pi driver 消费 */
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * 模式钉住的模型（缺省沿用全局激活配置；未给的一侧回落全局）。
   * Host 的连接重建判键与 driver 的模型解析都用它，保证「钉住期间全局切模不拆连接」。
   */
  modelOverride?: {
    providerId?: string;
    modelId?: string;
    params?: Array<{ id: string; value: string; }>;
  };
  /** Pi only: original session/mode selection before the host fills omitted fields; null means follow defaults. */
  modelSelectionIntent?: { providerId?: string; modelId?: string } | null;
  /** 替换 pi 原生基底系统提示（loader 的 systemPrompt 选项；追加段不受影响）。仅 Pi driver 消费 */
  systemPromptReplace?: string;
  /** 是否加载 AGENTS.md/CLAUDE.md 等上下文文件（缺省 true）。仅 Pi driver 消费 */
  contextFiles?: boolean;
  /** 旧 Pi 模式字段：只保留读取兼容，driver 告警；不扩展 .agents/skills 发现范围。 */
  skillsPaths?: string[];
  /**
   * 扩展 Agent 会话标记：不发现托管技能根（全局/工作区技能库都不加载），技能面只来自
   * manifest.agent.skills 的资源挂载。仅 Pi driver 的 skills.snapshot/filter 消费。
   */
  extensionAgentSkills?: boolean;
  /** 附加 prompt 模板根路径（提供即开启 pi 模板发现）。仅 Pi driver 消费 */
  promptPaths?: string[];
  /** 采样温度（经 before_provider_request 钩子注入 payload）。仅 Pi driver 消费 */
  temperature?: number;
  /** 额外/覆盖的 provider 请求头（经 before_provider_headers 钩子）。仅 Pi driver 消费 */
  providerHeaders?: Record<string, string>;
  /**
   * 模式硬守卫（tool_call 钩子引擎级拦截，先于审批扩展）：bashReadOnly 只读白名单、
   * bashAllow 放行正则、bashDeny 命令黑名单、denyPaths 写路径保护子串。仅 Pi driver 消费。
   */
  guards?: {
    bashDeny?: string[];
    denyPaths?: string[];
    bashReadOnly?: boolean;
    bashAllow?: string[];
  };
  /** 回合前动态注入模板（before_agent_start；支持 {{now}}/{{date}}/{{time}}/{{cwd}}）。仅 Pi driver 消费 */
  turnInject?: string;
  /**
   * stable snapshot 注入（true 时同一天内逐字节复用同一份渲染结果，翻日才重渲染），
   * 保 provider prompt/KV 前缀缓存命中；缺省 false=每轮重渲染（时间保持新鲜）。仅 Pi driver 消费
   */
  turnInjectStable?: boolean;
  /** 输入变换规则（Host 侧发送前按序应用正则替换）。仅 Pi driver 消费 */
  inputTransforms?: Array<{ pattern: string; replacement: string; }>;
  /** 上下文瘦身：toolResult 文本块超过 maxToolResultChars 即截断（context 钩子）。仅 Pi driver 消费 */
  contextTrim?: { maxToolResultChars?: number; };
  contextCompression?: import('../../shared/autoCompact').AutoCompactConfig;
  /**
   * 工作区记忆逐轮注入（before_agent_start）：bootstrap 注入（worker 面画像；B5 起
   * 数据源=MemoryService.inject——共享 MEMORY.md + 今日 journal 尾部），按天+记忆
   * 版本号 stable 快照（同天同版本逐字节复用，写入/翻日才刷新）。root 为主工作区根
   * （隔离 worktree 时与 cwd 不同）；sessionId 进 bootstrap 落账缓存键（首次/刷新记
   * kind=bootstrap）。仅 Pi driver 消费。
   */
  memoryInject?: { root: string; sessionId?: string; };
  /**
   * 自定义扩展路径（TS 模块，jiti 加载；扩展以宿主进程权限执行任意代码，模式创作者自负）。
   * 仅 Pi driver 消费。
   */
  extensionPaths?: string[];
  /** 自定义主题路径（TUI 主题；宿主 GUI 下基本无效果）。仅 Pi driver 消费 */
  themePaths?: string[];
  /** 可切换模型集（模型循环；每条经 modelRuntime 解析，缺失跳过并告警）。仅 Pi driver 消费 */
  scopedModels?: Array<{
    providerId: string;
    modelId: string;
    thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  }>;
  /** 任意工具名黑名单（createAgentSession 的 excludeTools，含扩展/自定义工具）。仅 Pi driver 消费 */
  excludeTools?: string[];
  /** pi 原生 settings 透传（SettingsManager.inMemory 首参；compaction/retry/shell/steering/images 等）。仅 Pi driver 消费 */
  piSettings?: Record<string, unknown>;
  /** Host-managed tiers own the retry decision and never replay uncertain native submissions. */
  managedWorkerRouting?: boolean;
  /** 会话模式（default/ask/plan/auto，与调度同源）；派生权限见 permissionMode */
  mode: GuiWorkerMode;
  /** plan 批准执行中（连接期快照；fire-time 以 getPolicyState 为准） */
  planExecuting: boolean;
  /** 派生执行权限（连接期快照；fire-time 以 getPolicyState 为准） */
  permissionMode: WorkerPermissionMode;
  /**
   * 每会话一个 ModeController（Host 构造）。Pi driver 挂 createModeExtensionFactory
   * （工具禁用/bash 白名单/每回合模式提示，切档即时生效）；Cursor 不消费（门控走宿主策略层）。
   */
  modeController: ModeController;
  /** 续聊令牌（Pi session id / Cursor 会话 id；缺省新建） */
  resumeToken?: string;
  /** Trusted host observation used to distinguish an empty lazy session from missing history. */
  hasPriorConversation?: boolean;
  /** A newly forked GUI session has a trusted history prefix queued for its first send. */
  forkTranscriptPending?: boolean;
  /**
   * fork 首连种子（无 resumeToken 时生效）：把先前对话作为引擎原生消息历史回放。
   * Pi 用 SessionManager.appendMessage 逐条注入（真实 message 上下文）；
   * 不支持的 driver 忽略（Host 侧降级为 transcript 前缀注入）。
   */
  seedSource?: {directory:string;descriptor:import('./forkContextSpool').ForkContextSpool};
  /** Host 进程内工具；driver 按引擎自己的工具命名规则注册 */
  hostTools: readonly GuiHostTool[];
  /**
   * 审批回调：主进程是审批状态的唯一 writer。driver 拿到决定后映射回引擎语义
   * （Pi：tool_call 钩子 block/放行；ACP：引擎提出的权限请求）。
   */
  requestApproval(req: GuiApprovalRequest, signal?: AbortSignal): Promise<GuiApprovalDecision>;
  /**
   * 用户提问回调（ask_user_question / Pi·Cursor 自定义 askQuestion）：Host 弹卡作答；
   * aborted=用户取消作答（driver 须把它变成引擎侧 ask 失败，模型看到取消语义）。
   * 不支持的 driver 可选。
   */
  requestUserQuestion?(req: GuiUserQuestionRequest, signal?: AbortSignal): Promise<GuiUserQuestionOutcome>;
  /** fire-time 热读当前模式（权限派生与只读门控都用它，无需重连） */
  getPolicyState(): { mode: GuiWorkerMode; planExecuting: boolean; allowedPrompts?: string[]; };
  /** Host-owned active turn identity; absent outside a live, non-aborted turn. */
  getTurnId?(): string | undefined;
  /** Host-owned desktop instruction generation; changes on a real user steer. */
  getDesktopTurnId?(): string | undefined;
  /**
   * 非用户对话连接（后台子代理）：send 的每回合不建立用户消息作用域（memory.remember
   * 直写门保守拒绝——任务提示词由父会话合成，不是用户证据；污点跟踪保留）。仅 Pi
   * driver 消费。缺省 false=GUI 会话（用户消息回合）。
   */
  nonUserTurns?: boolean;
  /**
   * fire-time 热读会话思考档（Pi：每回合 setThinkingLevel，切档即时生效、无需重连）。
   * null=未设置（driver 用自己的默认：reasoning 模型 medium / 其余 off）。仅 Pi driver 消费。
   */
  getThinkingLevel?(): (import('../../shared/types').GuiThinkingLevel) | null;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

/**
 * B2 合同拆轨（docs/plans/implemented/driver-contract-v2.md）：connect input 按跨进程安全性分三轨，
 * 类型层落位（Omit/Pick 派生，零运行时变更）。新增 connect 字段必须归入某一轨：
 * 纯数据 → 直接留在 interface（自动进 DTO）；回调 → 加进 CallbackRpc 的 Pick；
 * 活对象 → 加进 LiveObjects 的 Pick。test/unit/driver-contract.spec.ts 编译期锁死
 * 「三轨互不重叠 + 并集覆盖全部字段」。
 */
/** 回调 RPC 轨：出进程 driver 经 worker 协议回打主进程（B3 的 host.* 方法面） */
export type GuiDriverCallbackRpc = Pick<
  GuiDriverConnectInput,
  'requestApproval' | 'requestUserQuestion' | 'getPolicyState' | 'getTurnId' | 'getDesktopTurnId' | 'getThinkingLevel' | 'log'
>;
/** 活对象轨：不可过线，worker 侧需以 DTO+RPC 重建（modeController→modeCtl RPC；hostTools→execHostTool 代理） */
export type GuiDriverLiveObjects = Pick<GuiDriverConnectInput, 'modeController' | 'hostTools'>;
/** 可序列化 DTO 轨：JSON 可过线的线格式（B3 worker 的 create 消息体） */
export type GuiDriverConnectDto = Omit<
  GuiDriverConnectInput,
  keyof GuiDriverCallbackRpc | keyof GuiDriverLiveObjects
>;

/** 上下文窗口用量（驱动未暴露则未知，contextWindow=0 表示上限未知） */
export interface GuiContextUsage {
  /** 当前占用 tokens（compaction 后可能为 null=未知） */
  tokens: number | null;
  contextWindow: number;
}

/** 手动压缩结果（GuiRuntimeConnection.compact；ok=false 时 error 必有） */
export type GuiCompactResult =
  | {
      ok: true;
      /** 压缩摘要文本（引擎没给就缺省） */
      summary?: string;
      /** 压缩前上下文 tokens */
      tokensBefore?: number | null;
      /** 压缩后估算 tokens（未知为 null） */
      estimatedTokensAfter?: number | null;
    }
  | { ok: false; error: string; };

/** 引擎侧图片输入（与 ChatImageAttachment 对齐：纯 base64 + mime） */
export interface GuiSendImage {
  data: string;
  mimeType: string;
  name?: string;
}

export interface GuiRuntimeConnection {
  events: AsyncIterable<GuiDriverStreamEvent>;
  getNativeConfig?(): NativeConfigState;
  refreshPermissionStrategy?(): Promise<void>;
  restorePermissionStrategy?(selections: NativeConfigIntent['selections']): Promise<void>;
  refreshNativeConfig?(): Promise<NativeConfigState>;
  setNativeConfig?(id: string, value: NativeConfigValue): Promise<void>;
  /**
   * 引擎真身捕获（Harness 透明）：生效系统提示词 + 工具目录，连接期一次性快照，
   * Host 记注入代际时合并。仅 pi driver 提供；其他引擎缺省。
   */
  engineCapture?: GuiEngineCapture;
  /** 发起一轮用户消息；完成以 turn-complete / error 事件为准（send 本身先返回） */
  send(text: string, images?: GuiSendImage[], parameters?: import('../../shared/modelParameters').ModelParameterValues, authority?: GuiInputAuthority): Promise<void>;
  /** Fork without changing the source connection. Unsupported must have no side effects. */
  nativeFork?(point: GuiNativeForkPoint): Promise<{ status: 'forked'; token: string; preservesPointIds?: boolean } | { status: 'unsupported' }>;
  /** 回合中续发（steer）；返回 false 表示不支持/未注入，Host 改入队 */
  redirect?(text: string): boolean;
  /** Optional native delivery while a turn is active; idle turns use send().
   * Native queues own their events through settlement. Unsupported must have no side effects. */
  receiveMessage?(message: import('../../shared/runtimeCommunication').RuntimeMessage):
    Promise<import('../../shared/runtimeCommunication').RuntimeDeliveryResult>;
  /** 用户停止 */
  abort(): Promise<void> | void;
  /**
   * 手动上下文压缩（空闲期调用；pi=session.compact）。驱动不支持则省略；
   * 忙时 Host 拒绝而不是调它（pi 的 compact 会先 abort 当前回合）。
   */
  compact?(instructions?: string): Promise<GuiCompactResult>;
  /** 读当前会话的上下文窗口占用（无能力的 driver 省略） */
  getContextUsage?(): GuiContextUsage | null;
  close(): Promise<void> | void;
}

import type { RuntimePreflightStatus, RuntimePreflightProblem } from '../../shared/runtimePreflight';

export interface GuiRuntimeProbeResult {
  status: RuntimePreflightStatus;
  problems: RuntimePreflightProblem[];
  /** Discovered program path, when available; it does not prove authentication. */
  executable?: string;
}

export interface GuiRuntimeDriver {
  describeNativeConfig?(input: { cwd: string; piModeId?: string; refresh?: boolean }): Promise<NativeConfigState>;
  captureWorkerPermission?(input: { cwd: string; nativeConfig: NativeConfigIntent }): Promise<string>;
  nativeConfigVersion?(presetId?: string): string | undefined;
  /** Optional busy-turn preemption. Ordinary send is always available, with no capability declaration required. */
  readonly deliveryCapabilities?: import('./delivery').DeliveryCapabilities;
  /** Reject explicit models before session allocation, without starting inference. */
  validateModelOverride?(input: { cwd: string; model: NonNullable<GuiDriverConnectInput['modelOverride']>; piModeId?: string }): Promise<void>;
  /** Adapter-owned model capability discovery. Does not create a model inference turn. */
  describeModelParameters?(input: {
    cwd: string;
    modelOverride?: GuiDriverConnectInput['modelOverride'];
    piModeId?: string;
    legacyThinkingLevel?: import('../../shared/types').GuiThinkingLevel;
    legacyParameters?: boolean;
    /** Only an explicit user action may trigger model discovery. */
    refresh?: boolean;
  }): Promise<import('../../shared/modelParameters').ModelParameterContext & {
    coreReasoning?: import('../agent/coreReasoningCatalog').CoreReasoningBinding;
  }>;
  /** 与 chat runtime id 一致（pi / cursor / claude / codex-gui / acp） */
  readonly runtimeId: string;
  readonly connectionVersion?: string;
  /** 引擎能否接收图片附件（Host 决定 send 前是否拦截） */
  readonly supportsImages?: boolean;
  /**
   * 切档是否必须拆连接重连（模式语义是连接期快照的引擎：Cursor 白名单）。
   * true 时 Host 在切档时拆旧连接（resume 续聊）并 busy 中拒绝切档；
   * 缺省 false（Pi / Claude：fire-time 热读，切档即时生效）。
   */
  readonly permissionStrategyHot?: boolean;
  readonly modeSwitchReconnects?: boolean;
  /**
   * 会话级模型覆盖（P10）。reconnect=连接快照，idle 即时拆连、运行中下回合重建；
   * unsupported=明确拒绝。缺省按 CHAT_RUNTIME_CAPABILITIES 表。
   */
  readonly modelOverridePolicy?: 'reconnect' | 'unsupported';
  /** 会话级思考档：hot=每回合热读；unsupported=拒绝。 */
  readonly thinkingPolicy?: 'hot' | 'unsupported';
  /** 引擎能否回放 fork 种子消息（不能则 Host 降级 transcript 前缀） */
  readonly supportsSeed?: boolean;
  /** False disables native fork before opening an engine, including for old saved points. */
  readonly supportsNativeFork?: boolean;
  /**
   * 引擎侧存储是否与活连接共享文件（如 Cursor 的共享 ndjson 整文件重写）：
   * Host 在 purge/sweep 前查同引擎 busy 回合并错峰，避免重写吞掉活回合的追加写。
   */
  readonly purgeDefersOnBusy?: boolean;
  /** 可选的引擎侧模式名单（Pi 自定义模式；渲染层菜单用） */
  listPresets?(): Array<{
    id: string;
    name: string;
    description: string;
    trust: 'system' | 'user';
    order: number;
    broken: string | undefined;
  }>;
  /**
   * 可选的引擎侧模式解析（Pi 自定义模式）：把模式 id 解析成 persona、连接附加段与
   * 工具面裁剪。宿主不感知引擎细节；未实现或模式不可用时返回 null/undefined。
   */
  resolveMode?(modeId: string): {
    persona?: string;
    /** connect input 的引擎专属附加段（由各 driver 定义并自行消费） */
    connectExtras: Record<string, unknown>;
    /** 工具面：该模式的附加宿主工具（如 creator 的 modes.*） */
    extraHostTools?: GuiHostTool[];
    /** 工具面：宿主工具黑名单（点号名） */
    hostToolDeny?: string[];
    /** 选中该模式时的默认会话权限档（不设=保持现状） */
    defaultGuiMode?: 'default' | 'ask' | 'plan' | 'auto';
  } | null;
  connect(input: GuiDriverConnectInput): Promise<GuiRuntimeConnection>;
  /**
   * 可用性预检（可选）：不 spawn 引擎、不发网络——只查依赖 CLI 是否存在 / 配置是否齐备。
   * 创建前预检（sessions.create gate）与设置页状态徽标共用；未实现按 unknown 处理。
   */
  probe?(input: { piModeId?: string; modelOverride?: GuiDriverConnectInput['modelOverride']; }): Promise<GuiRuntimeProbeResult>;
  /**
   * 会话删除/清空后清理引擎侧落盘数据（转录、缓存、SDK 存储）。
   * 无需活连接也可调用（归档已久/重启后的会话）；幂等、best-effort，失败只 log。
   */
  purge?(input: GuiDriverPurgeInput): Promise<void>;
  /**
   * 启动孤儿清扫：删除引擎侧已无对应会话的存量数据（早期版本删除不清理的
   * 遗留、异常路径孤儿）。keep 由宿主按当前注册表（含运行中的 hidden 会话）
   * 计算；幂等、后台执行、失败只 log。
   */
  sweepOrphans?(keep: GuiDriverSweepKeep): Promise<void>;
}

/** purge 输入：sessionId 必有；引擎侧句柄来自删除前的 SessionMeta 快照（clear 场景为作废旧句柄） */
export interface GuiDriverPurgeInput {
  sessionId: string;
  externalSessionId?: string;
  runtimeResumeToken?: string;
}

/** sweepOrphans 的保留集：仍存活会话的 id/引擎句柄（含运行中的 hidden 会话）+ 父会话仍存活的 bg 任务 token（形如 `bg-<taskId>`）+ 名单快照时刻（错峰等待不改基准，防睡眠窗口内新建的会话被误删） */
export interface GuiDriverSweepKeep {
  metas: Array<
    Pick<SessionMeta, 'id' | 'runtime' | 'externalSessionId' | 'runtimeResumeToken'>
  >;
  bgTokens: string[];
  /** 名单快照时刻（ms epoch）：时效护栏基准，创建晚于它的引擎数据一律不动 */
  snapshotAt: number;
}
