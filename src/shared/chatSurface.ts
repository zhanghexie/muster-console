/**
 * ChatSurface 统一会话合同（渲染层边界）：
 * 调度 Agent 面板与 GUI Worker 会话共用的会话视图（ChatSurfaceView/ChatTranscript/AgentComposer）
 * 只面向本合同；两个适配器（orchestratorSurface / agentSessionSurface）各自消化自己的 IPC 协议。
 *
 * 分界规则（防双表面漂移的机制，见 docs/plans/implemented/chat-surface-plan.md）：
 * - 两表面**共同语义** = ChatSurface 必选方法 —— 协议演进加方法时 tsc 会同时逼两个适配器实现；
 * - 表面**特有能力** = ChatSurfaceCaps 能力位 —— 视图按 caps 渲染，「谁有谁没有」是数据不是分支。
 */
import type { ChatMessage, GuiWorkerMode, ChatImageAttachment } from './types';
import type { CodexModelListItem } from './codexModels';
import type { ChatCompactionMarker } from './chatCompaction';
import type { SetModelConfigurationInput, SetModelConfigurationResult } from './harnessPicker';

export type { ChatCompactionMarker, ChatCompactionStatus } from './chatCompaction';

/** 表面类型：输入框命令清单等行为按它显式分叉（不再从数据 prop 的有无推断） */
export type ChatSurfaceKind = 'dispatch' | 'gui-session';

/** 会话级模型覆盖 / 切模载荷 */
export interface ChatModelSelection {
  providerId: string;
  modelId: string;
  params?: Array<{ id: string; value: string }>;
}

/** Opaque fingerprints bind a model menu to the current session and engine configuration. */
export interface SessionHarnessModelExpected {
  runtimeId: string;
  cwd: string;
  catalogCwd?: string;
  workspaceId?: string;
  workspaceFingerprint: string;
  engineFingerprint: string;
  modelOverride: ChatModelSelection | null;
  presetId?: string;
  agentId?: string;
  agentFingerprint?: string;
}

/** 上下文用量原始值（视图层格式化为「42% · 88k/200k」） */
export interface ChatUsageInfo {
  tokens: number | null;
  contextWindow: number;
  /** 最后一次真实用量时间（重启恢复带此字段） */
  ts?: number;
  /** 重启恢复的陈旧值；下一条真实 usage 到达后静默去掉 */
  stale?: boolean;
}

/** An engine-specific model source; empty or failed results never mean global LLM models. */
export interface ChatHarnessModelCatalog {
  runtimeId: string;
  sessionId: string;
  /** Actual ACP agent identity, when known, for presentation. */
  agentId?: string;
  state: 'idle' | 'loading' | 'ready' | 'error';
  items: Array<{ id: string; name: string }>;
  error?: string;
  manual?: boolean;
  identityReady?: boolean;
}

/**
 * 状态条数据面（模型按钮 / 用量环 / 思考档 chip 的纯数据）。
 * 视图读出后喂给 Composer 的 chatStatus prop；动作走 ChatSurface 对应方法。
 */
export interface ChatStatusInfo {
  /** Trusted source scope for delegation references created by the dispatcher composer. */
  workerRoutingScope?: import('./workerRouting').WorkerRoutingScope;
  /** 展示名；空串 = 不显示模型按钮 */
  modelLabel: string;
  providerId?: string;
  modelId?: string;
  /** 会话级覆盖生效中（模型菜单顶部显示「跟随全局」项） */
  modelPinned?: boolean;
  /** Codex CLI 目录；空数组仍保留独立菜单，不能回落全局 LLM。 */
  codexModelCatalog?: CodexModelListItem[];
  harnessModelCatalog?: ChatHarnessModelCatalog;
  /** GUI-only picker preference; omitted for the independent dispatcher. */
  harnessModelSelection?: { runtimeId: string; ready: boolean; modelIds?: string[]; error?: string };
  modelCatalogWarning?: string;
  /** 当前选中 params（Cursor 变体/Router） */
  modelParams?: Array<{ id: string; value: string }>;
  usage?: ChatUsageInfo | null;
  usageTitle?: string;
  /** 旧思考接口的会话状态；levels 来自当前模型的能力描述。 */
  thinking?: { level: string | null; available: boolean; levels?: string[] } | null;
  modelParameters?: import('./modelParameters').ModelParameterState[];
  /**
   * 当前生效模型是否支持图片输入。缺省（undefined）= 跟 runtime 能力位。
   * false = 切到非多模态模型后隐藏上传入口；已贴的图仍可发，由发送守卫拒绝并留草稿。
   */
  supportsImages?: boolean;
}

/** 模式胶囊（Pi 自定义模式）当前态；id 语义由适配器定义 */
export interface ChatPresetState {
  id: string;
  /** 产生内容后锁定（空白期语义），不可中途切换 */
  locked: boolean;
}

/** 模式胶囊花名册条目（现拉不缓存；创造模式随时可能落盘新模式） */
export interface ChatPresetRosterItem {
  id: string;
  name: string;
  description?: string;
  trust: 'system' | 'user';
  order: number;
  /** 展示级健康标记（缺配置文件等） */
  broken?: string;
}

/** 会话视图能力位：视图（ChatSurfaceView/ChatTranscript）只按它渲染 */
export interface ChatSurfaceCaps {
  surfaceKind: ChatSurfaceKind;
  /** 草稿桶 key */
  draftKey: string;
  images?: boolean;
  /** 左侧加号附件面板 */
  plusMenu?: boolean;
  /** 后台任务胶囊 */
  bgTasks?: boolean;
  fork?: boolean;
  /** 会话批注（角标/气泡/输入框 token；宿主侧编排由壳经 notesHost 注入） */
  notes?: boolean;
  /** 模式胶囊（roster/changePreset 走 surface） */
  presets?: boolean;
  /** 模式胶囊菜单文案 */
  presetLabels?: { title: string; lockedTitle: string; lockedNote: string };
  /** 模式档循环次序；缺省三档；mode=null 的快照时不显示模式 chip */
  modeOrder?: GuiWorkerMode[];
  /** 覆盖模式芯片文案（Cursor：Agent/Ask/Plan） */
  modeLabels?: Partial<Record<GuiWorkerMode, string>>;
  /** Optional explanatory rows for GUI permission choices. */
  modeDescriptions?: Partial<Record<GuiWorkerMode, string>>;
  modeDisabled?: Partial<Record<GuiWorkerMode, boolean>>;
  /** busy 中禁止切档（Cursor 重建连接类） */
  modeLockOnBusy?: boolean;
  /** 表面自处理的本地斜杠命令（/status /help /bind…）进命令清单 */
  localCommands?: boolean;
  /** 手动压缩上下文（/compact）：Composer 才列命令、才拦截输入 */
  manualCompact?: boolean;
  /** Override the model picker scope when a purpose surface delegates model changes to a workspace. */
  modelPickerTarget?: { dispatch: { workspaceId: string } } | { sessionId: string };
}

export interface ChatEngineSlashCommand {
  name: string;
  description?: string;
  inputHint?: string;
}

/** 排队消息条目（统一排队面板「排队自动发送」泳道用；text 为纯文本预览） */
export interface ChatQueuedItem {
  id: string;
  text: string;
  /** 随文图片张数（面板角标；不把 base64 放进快照） */
  imageCount?: number;
}

/** sendNow 的落点：正常发送 / 已插话 / 不支持插话 / 回落排队 / 失败 */
export type SendNowResult = 'sent' | 'steered' | 'unsupported' | 'queued' | 'failed';

/**
 * Generation-scoped bounded history metadata exposed by both surfaces.
 * `messages` contains only retained page payloads and local pending rows.
 * Slots preserve absolute coordinates across eviction; unloaded rows are fetched
 * from the range source when the measured viewport reaches them.
 */
export type ChatSurfacePageDirection = 'tail' | 'earlier' | 'later';
export type ChatSurfacePageLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface ChatSurfacePageLoadState {
  status: ChatSurfacePageLoadStatus;
  generation: number;
  requestId?: string;
  error?: string;
}

export interface ChatSurfacePageState {
  generation: number;
  total: number;
  /** Retained absolute slots, including rows hidden by presentation filters. */
  slots?: ReadonlyArray<{ index: number; messageId: string }>;
  loadedRanges: ReadonlyArray<{ start: number; end: number }>;
  cursor: {
    before?: number | string | null;
    after?: number | string | null;
    total?: number;
    hasEarlier?: boolean;
    hasLater?: boolean;
    token?: string | null;
  };
  loadState: Readonly<Record<ChatSurfacePageDirection, ChatSurfacePageLoadState>>;
}

/** Absolute message window retained by the renderer virtualizer. */
export interface ChatSurfacePageWindow {
  start: number;
  end: number;
  anchorIndex?: number;
}

/**
 * busy 时正在流式的 assistant 下标：最后一条非 queued user 之后的最后一条 assistant。
 * 插话（steer）把 user 垫在旧回复后面时，旧 assistant 不再算「当前回合」——
 * 当前回合 = 插话消息 + 其后的回复。没有后接 assistant 时返回 -1。
 */
export function locateStreamingAssistantIndex(
  messages: ReadonlyArray<{ role: string; queued?: boolean; steering?: string }>,
  busy: boolean
): number {
  if (!busy) return -1;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    // 宿主静默插话（steering:'host'）在回合中途落进消息流，但引擎仍在同一回合里
    // 流式——不把它当回合界线，否则流式 caret 落空、当前回合被误判为历史折叠
    if (m.role === 'user' && !m.queued && m.steering !== 'host') {
      lastUser = i;
      break;
    }
  }
  const start = lastUser < 0 ? 0 : lastUser + 1;
  for (let i = messages.length - 1; i >= start; i--) {
    if (messages[i]!.role === 'assistant') return i;
  }
  return -1;
}

/** 订阅快照：消息/回合态/状态条/模式/胶囊的一切反应式数据 */
export interface ChatSurfaceSnapshot {
  execution?: import('./executionLifecycle').ExecutionLifecycle;
  /** Only history IPC waiting, independent from model execution. */
  historyLoading?: boolean;
  historyError?: string;
  /** Scheduler-only range protocol state. GUI worker histories still use their own adapter. */
  historyHasEarlier?: boolean;
  /** Absolute bounded-page metadata; messages remains the canonical row contract. */
  page?: ChatSurfacePageState;
  /** 适配器原生消息模型（GUI=GuiChatMessage，调度=ChatMessage）；转写经 toDisplay 映射 */
  messages: readonly unknown[];
  busy: boolean;
  queuedCount: number;
  /** 排队中消息（自动发送顺序）；统一排队面板「排队自动发送」泳道数据源 */
  queuedItems: ReadonlyArray<ChatQueuedItem>;
  status: ChatStatusInfo | null;
  /** null = 本表面无模式档（不显示模式 chip） */
  mode: GuiWorkerMode | null;
  preset: ChatPresetState | null;
  /** ACP AvailableCommands → 斜杠菜单 */
  engineSlashCommands?: ReadonlyArray<ChatEngineSlashCommand>;
  /** ACP CurrentMode 展示名 */
  engineModeLabel?: string | null;
  /**
   * 消息流里的上下文压缩分割线。
   * running = 活跃（贴末尾）；complete = 已归档的历史标记（锚定压缩点）。
   * 缺省或空 = 不画；失败不进这里（Composer hint 出错误）。
   */
  compactions?: readonly ChatCompactionMarker[];
}

/** 会话动作（视图层接线用；可选 = caps 未声明时视图不得调用） */
export interface ChatSurfaceActions {
  /** 返回是否受理（false 时 Composer 保留草稿不丢稿） */
  send(text: string, images?: ChatImageAttachment[]): Promise<boolean>;
  /**
   * 立即发送（统一排队面板「立即」）：空闲 = 正常发送；忙 = 插话（steer）当前
   * 回合，引擎不支持时回落排队。供插话按钮与手动确认行直接触发。
   * **仅文本**：steer 不带图片，带图消息走 `send` 排队（面板对带图行禁用「立即」）。
   */
  sendNow?(text: string): Promise<SendNowResult>;
  /**
   * 「立即」的兜底通道（引擎不支持插话时由 Composer 触发）：
   * mail = 投递到员工邮箱排队；interrupt = 保留宿主队列中断当前回合后重发。
   * 返回是否已受理（false 时 Composer 保留草稿）。
   */
  sendNowFallback?(text: string, method: 'mail' | 'interrupt'): Promise<boolean>;
  /** 改写一条排队消息的内容（未轮到执行的才可改） */
  editQueued?(messageId: string, text: string): void;
  /** 重排排队消息（自动发送顺序）；ids 为全量排队 id 的目标顺序 */
  reorderQueued?(orderedIds: string[]): void;
  /** 取排队条目随文图片（跨泳道 auto→manual 用；快照只带张数，原图在消息上） */
  getQueuedImages?(messageId: string): ChatImageAttachment[] | undefined;
  /** 输入区获得焦点（即将发起回合）：实现方可借机预热回合辅助能力；须廉价、幂等、不抛错 */
  stop(): void;
  clear(): Promise<void>;
  /** Load an older history range when the surface has a server-side cursor. */
  loadEarlier?(): Promise<void>;
  /** Ensure a message is loaded before explicit history/reveal navigation. */
  ensureMessageLoaded?(messageId: string): Promise<boolean>;
  /** Evict page metadata outside the mounted virtual window. */
  retainPageWindow?(window: ChatSurfacePageWindow): void;
  /** Return an absolute index when this surface has the message loaded in its page map. */
  messageIndex?(messageId: string): number | undefined;
  /** 手动压缩上下文（caps.manualCompact 声明时可用）；结果反馈由实现方自行呈现 */
  compact?(instructions?: string): Promise<{ ok: boolean; error?: string }>;
  retry(): void;
  /**
   * 重新编辑已终止回合的用户消息：从历史移除该轮用户消息与已终止助手回复，
   * 返回原文本与随文图片供填入输入框编辑。
   */
  recallAborted?(messageId?: string): Promise<{
    ok: boolean;
    text?: string;
    images?: ChatImageAttachment[];
    error?: string;
  }>;
  cancelQueued(messageId: string): void;
  /** revise = 计划卡「提出修改」：feedback 为修改意见，由实现方转发消息通道 */
  planAction?(action: 'execute' | 'abandon' | 'revise', feedback?: string): void;
  setMode?(mode: GuiWorkerMode): void;
  setThinking?(level: string | null): Promise<{ ok: boolean; error?: string }>;
  setModelParameter?(id: string, value: string | null): Promise<{ ok: boolean; error?: string }>;
  setModel?(model: ChatModelSelection | null): void;
  setModelConfiguration?(input: Omit<SetModelConfigurationInput, 'sessionId'>): Promise<SetModelConfigurationResult>;
  /** 切模成功后的回调（清用量/刷新显示） */
  onModelSwitched?(): void;
  reloadCodexCatalog?(): Promise<void>;
  reloadHarnessCatalog?(): Promise<void>;
  refreshHarnessModelState?(): Promise<void>;
  fork?(messageId: string): void;
  /** 本地回显（/status /help 等不进模型上下文的插入；ChatMessage.local 语义） */
  localEcho?(content: string): void;
  loadPresetRoster?(): Promise<ChatPresetRosterItem[] | null>;
  changePreset?(id: string): void;
  /** Harness 透明开关（GUI 会话；开关关闭时聊天渲染与现状完全一致） */
  setHarnessOn?(on: boolean): void;
}

/** Bounded scheduler history page used by the renderer range protocol. */
export interface ChatHistoryPage {
  messages: ChatMessage[];
  before: number;
  total: number;
  hasEarlier: boolean;
  /** Workspace live cursor for duplicate/gap recovery. */
  eventSeq?: number;
}

/**
 * 统一会话合同。两个适配器实现它，ChatSurfaceView 只消费它。
 * getSnapshot 必须返回引用稳定的快照（未变化时同一对象）——视图走 useSyncExternalStore。
 */
export interface ChatSurface {
  readonly sessionId: string;
  readonly caps: ChatSurfaceCaps;
  subscribe(listener: () => void): () => void;
  getSnapshot(): ChatSurfaceSnapshot;
  readonly actions: ChatSurfaceActions;
  /** Harness 透明标注（GUI 会话；pi-trajectory-plan extension §6） */
  harness?: {
    subscribe(listener: () => void): () => void;
    get(): HarnessViewState;
  };
}

/** Harness 透明视图态（surface.harness 的快照形状） */
export interface HarnessViewState {
  on: boolean;
  /** 连接级注入快照信封（按回合时间解析生效代际） */
  injections: readonly import('./guiHistoryMetadata').GuiInjectionView[];
  injectionDetails?: (ref: import('./guiHistoryMetadata').GuiInjectionDetailRef) => Promise<import('./guiHistoryMetadata').GuiInjectionDetailsResult>;
  engineInput?: (messageId: string, ref: string) => Promise<string | null>;
}

/** 模式档元数据（Composer 内置；modeLabels 可覆盖文案） */
export type ChatSurfaceMode = GuiWorkerMode;
