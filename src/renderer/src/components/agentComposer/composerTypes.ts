import type { GuiWorkerMode, ChatImageAttachment } from '../../../../shared/types';
import type { ChatSurfaceKind, ChatEngineSlashCommand } from '../../../../shared/chatSurface';
import type { CodexModelListItem } from '../../../../shared/codexModels';
import type { SetModelConfigurationInput, SetModelConfigurationResult } from '../../../../shared/harnessPicker';
import type { PickerBoundTarget } from '../HarnessModelPicker';
import type { CapabilityTargetId } from '../../../../shared/capabilityManagement';
import type { ReactNode } from 'react';
import type { PermissionConfigurationControl } from '../PermissionConfiguration';

/** 模式花名册条目（Pi 自定义模式） */
export interface ComposerPresetItem {
  id: string;
  name: string;
  description: string;
  trust: 'system' | 'user';
  order: number;
  broken: string | undefined;
}

/** 会话模式胶囊（Pi 自定义模式的通用装配） */
export interface ComposerPreset {
  /** 当前选中 id（Pi 的空串=标准无模式；花名册须含同名空 id 条目） */
  id: string;
  locked: boolean;
  /** 未锁定时的胶囊悬浮提示 */
  title: string;
  /** 锁定时的胶囊悬浮提示 */
  lockedTitle: string;
  /** 菜单底部的锁定注记（不传则不显示） */
  lockedNote?: string;
  /** 现拉最新花名册（不缓存） */
  loadRoster: () => Promise<ComposerPresetItem[] | null>;
  onChange: (id: string) => void;
}

export interface Props {
  workspaceId: string | null;
  creation?: {
    initialText: string;
    initialAttachments?: ChatImageAttachment[];
    label: string;
    placeholder: string;
    submitLabel: string;
    submitDisabled: boolean;
    allowEmpty: boolean;
    rootId?: string;
    cli: boolean;
    skillFileReference: boolean;
    targetButton: ReactNode;
    onAttachments: (items: ChatImageAttachment[], loading: boolean) => void;
  };
  workerRoutingScope?: import('../../../../shared/workerRouting').WorkerRoutingScope;
  /** 会话待办入口，放在输入框底栏。 */
  reminders?: ReactNode;
  requestRecordingShortcut?: ReactNode;
  nativeSettings?: ReactNode;
  permissionConfiguration?: PermissionConfigurationControl & {
    triggerLabel?: string;
    inherit?: { selected: boolean; reset: () => void };
    fields?: ReactNode;
  };
  busy: boolean;
  disabled?: boolean;
  /** False when a kept-alive conversation cannot receive interaction. */
  interactionActive?: boolean;
  /** 当前回复关联的可选草稿，空输入框内预览，Tab 接受。 */
  replySuggestions?: import('../../chatSurface/currentSuggestedReplies').ComposerReplySuggestions | null;
  /** 调度单题待答状态独立于建议，清除建议后仍可从输入框回答。 */
  pendingQuestion?: boolean;
  onClearReplySuggestions?: (snapshot: import('../../../../shared/replySuggestions').ComposerReplySuggestions) =>
    Promise<import('../../../../shared/replySuggestions').ClearReplySuggestionsResult>;
  /** GUI 会话后台任务胶囊（子代理/后台终端/定时器）；传入即显示（无任务零高） */
  bgTasks?: { sessionId: string; cwd?: string; workspaceId?: string };
  /** 拖到头像/气泡后打开面板时注入的路径文本 */
  pendingInsert?: string | null;
  onPendingInsertConsumed?: () => void;
  /** busy 排队消息（自动发送顺序）；统一排队面板「排队自动发送」泳道 */
  queuedItems?: ReadonlyArray<{ id: string; text: string; imageCount?: number }>;
  /** 撤回一条排队消息（自动泳道删除/立即出列时先摘排队副本） */
  onCancelQueued?: (messageId: string) => void;
  /** 立即发送：空闲=正常发；忙=插话（steer）当前回合；不支持时回落排队 */
  onSendNow?: (text: string) => Promise<'sent' | 'steered' | 'unsupported' | 'queued' | 'failed'>;
  onSendNowFallback?: (text: string, method: 'mail' | 'interrupt') => Promise<boolean>;
  /** 改写一条排队消息（自动泳道行内编辑） */
  onEditQueued?: (messageId: string, text: string) => void;
  /** 重排排队消息（自动泳道拖拽排序） */
  onReorderQueued?: (orderedIds: string[]) => void;
  /** 跨泳道 auto→manual 取排队条目随文图片（快照只带张数，原图在主进程/display） */
  getQueuedImages?: (messageId: string) => Array<{
    id: string;
    data: string;
    mimeType: string;
    name?: string;
    size?: number;
  }> | undefined;
  onSend:
    | ((text: string, images?: ChatImageAttachment[]) => void)
    | ((text: string, images?: ChatImageAttachment[]) => Promise<boolean | void>);
  /** 输入框全文变化（含草稿载入/外部同步）；批注 token 与消息的双删同步靠它 */
  onValueChange?: (text: string) => void;
  /** 入手动队列前固化发送正文与批注编辑快照（必须在清空草稿前调用）。 */
  prepareManualDraft?: (text: string) => {
    text: string;
    noteDraft?: import('../../../../shared/noteAnnotations').QueuedNoteDraft;
  };
  restoreManualDraft?: (draft: import('../../../../shared/noteAnnotations').QueuedNoteDraft) => string;
  /** 队列正文已固化，发送时不可再套用当前草稿的批注表。 */
  onSendResolved?: Props['onSend'];
  onSendNowResolved?: Props['onSendNow'];
  /** 会话批注 token（批注N）：在输入框里渲成可点药丸（点击跳回批注处） */
  noteTokens?: Array<{ id: string; token: string; title: string; label?: string }>;
  onNoteTokenClick?: (id: string) => void;
  /** 药丸悬浮 × 快删：连着批注记录与高亮锚点一起摘 */
  onNoteTokenDelete?: (id: string) => void;
  /** 停止当前回合（busy 时发送按钮切换为停止） */
  onStop?: () => void;
  onClear?: () => Promise<void>;
  /**
   * 手动压缩上下文（/compact）：提供即在斜杠菜单列出并拦截输入；缺省则
   * /compact 落「未支持命令」提示（能力位 caps.manualCompact 决定传不传）。
   */
  onCompact?: (instructions?: string) => Promise<{ ok: boolean; error?: string } | void> | void;
  onRecordRequests?: (intent: 'start' | 'view') => void;
  /** 本地斜杠命令（不发给模型） */
  onLocalCommand?: (
    kind: 'status' | 'statusVerbose' | 'stop' | 'help' | 'bind' | 'unbind',
    extra?: string
  ) => void;
  /** Agent 模式（default/ask/plan；GUI Worker 会话另有 'auto'） */
  mode?: GuiWorkerMode;
  onModeChange?: (mode: GuiWorkerMode) => void;
  /**
   * 模式循环次序（缺省调度三档 default→ask→plan）。GUI Worker 会话传四档
   * （default→ask→plan→auto）；此时 mode/onModeChange 的取值会包含 'auto'。
   */
  modeOrder?: GuiWorkerMode[];
  /** 覆盖模式芯片文案（Cursor 会话：Agent / Ask / Plan） */
  modeChipLabels?: Partial<Record<GuiWorkerMode, string>>;
  modeDescriptions?: Partial<Record<GuiWorkerMode, string>>;
  modeDisabled?: Partial<Record<GuiWorkerMode, boolean>>;
  /** busy 中禁止切档（Cursor 重建连接类）；与「切模型会中断」同款保护 */
  modeSwitchLocked?: boolean;
  modeSwitchLockedTitle?: string;
  /**
   * 会话模式胶囊（Pi 自定义模式，由调用侧装配）：
   * 调度面传 id 会显示胶囊；GUI 会话只保留启动态数据，不在实时输入条显示。
   * locked=产生内容后锁定（两引擎同款空白期语义）。
   * loadRoster 每次菜单打开/胶囊挂载时现拉（创造模式随时可能落盘新模式，不缓存）。
   */
  preset?: ComposerPreset;
  /** 草稿桶 key（缺省 workspaceId）；GUI Worker 会话传 agent-session:<id> 与调度隔离 */
  draftKey?: string;
  /** 图片附件（默认开）；GUI Worker 暂不支持多模态时关 */
  allowImages?: boolean;
  /** 左侧加号弹出面板（图片 / @文件 / 命令；调度与 GUI 都开。未开时退回旧的内联图片按钮） */
  plusMenu?: boolean;
  /**
   * 表面类型（显式双态，防行为随数据 prop 的有无漂移）：
   * dispatch=调度面板（本地命令清单）；gui-session=GUI Worker 会话。
   * 技能列表两边同一数据源（agent.listSkills），不按表面特判。
   */
  extensionTask?: boolean;
  extensionSkillNames?: readonly string[];
  surfaceKind: ChatSurfaceKind;
  /** Presentation identity of the fixed GUI session harness. */
  harnessId?: string;
  /** Exact runtime capability policy; dispatch defaults to its independent Pi SDK target. */
  skillTarget?: CapabilityTargetId;
  /** ACP AvailableCommands → 斜杠菜单（与本地 /new 等并列） */
  engineSlashCommands?: ReadonlyArray<ChatEngineSlashCommand>;
  /**
   * 状态条数据面（模型/用量/思考，由 ChatSurfaceView 从 surface 快照装配）：
   * - modelLabel/usage 原始值控制显示；providerId/modelId 提供时模型按钮可点、
   *   弹同款切模菜单（onModelChange 提供时会话级切模；modelPinned=true 时菜单顶部
   *   显示「跟随全局」项）。
   * - onModelSwitched：切模成功后的回调（刷新显示并清 usage）。
   */
  chatStatus?: {
    modelLabel?: string;
    /** 上下文用量原始值（内部格式化为「42% · 88k/200k」）；null/缺省不显示 */
    usage?: {
      tokens: number | null;
      contextWindow: number;
      ts?: number;
      stale?: boolean;
    } | null;
    title?: string;
    providerId?: string;
    modelId?: string;
    onModelSwitched?: () => void;
    modelPinned?: boolean;
    modelPickerTarget?: PickerBoundTarget;
    onModelConfiguration?: (input: Omit<SetModelConfigurationInput, 'sessionId'>) => Promise<SetModelConfigurationResult>;
    onModelChange?: (model: {
      providerId: string;
      modelId: string;
      params?: Array<{ id: string; value: string }>;
    } | null) => void;
    codexModelCatalog?: CodexModelListItem[];
    harnessModelCatalog?: import('../../../../shared/chatSurface').ChatHarnessModelCatalog;
    harnessModelSelection?: import('../../../../shared/chatSurface').ChatStatusInfo['harnessModelSelection'];
    modelCatalogWarning?: string;
    onReloadCodexCatalog?: () => Promise<void> | undefined;
    onReloadHarnessCatalog?: () => Promise<void> | undefined;
    onRefreshHarnessModelState?: () => Promise<void> | undefined;
    /** 当前选中 params（Cursor 变体/Router） */
    modelParams?: Array<{ id: string; value: string }>;
    modelParameters?: import('../../../../shared/modelParameters').ModelParameterState[];
    onModelParameterChange?: (id: string, value: string | null) => void;
    /**
     * 旧思考接口的当前值和已知可选档；每回合热生效（无需重连）。
     */
    thinking?: {
      level: string | null;
      levels?: string[];
      onChange: (level: string | null) => void;
    };
  };
}
