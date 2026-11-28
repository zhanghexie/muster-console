/**
 * 主进程 / 预加载 / 渲染层共享的类型与 IPC 契约。
 */

import { t, type AppLocale } from './i18n';
import type { AgentRule } from './agentConduct';
import type { MissedPolicy } from './promptTasks';
import type { HarnessIntegration } from './harnessIntegration';
import type { RuntimeManifest } from './runtimeManifest';
import type { TurnGateUserConfig } from './turnGate';

export type { MissedPolicy };

// ---------- 会话 ----------

type SessionType = 'terminal' | 'scheduled';

/** starting：正在预分配 CLI 会话 / 拉起 pty，UI 已可见但尚未可交互 */
export type TerminalStatus = 'running' | 'exited' | 'idle' | 'starting';

/** Agent 生命周期（detect/notify 用；与 TerminalStatus 并存，agent 侧以 lifecycle 为准） */
export type AgentLifecycle = 'starting' | 'working' | 'quiet' | 'idle' | 'blocked' | 'exited';

/** 任意已注册 runtime id */
export type AgentRuntimeKey = string;

/**
 * runtime 呈现面：pty = 真终端（node-pty + TUI CLI）；chat = 内置 GUI 聊天
 * （无 pty、无拉起脚本，中栏渲染 AgentChatView）。缺省 'pty'（旧数据兼容）。
 */
export type AgentRuntimeSurface = 'pty' | 'chat';
export type TerminalRestartIntent = 'resume' | 'new';

export function runtimeSurface(entry: { surface?: AgentRuntimeSurface; } | undefined): AgentRuntimeSurface {
  return entry?.surface === 'chat' ? 'chat' : 'pty';
}

export interface AgentRuntimeEntry {
  id: string;
  label: string;
  /** 仅 pty runtime 需要：scripts/ 下的拉起脚本文件名。chat runtime 无脚本。 */
  script: string;
  builtin: boolean;
  enabled: boolean;
  /** 呈现面（缺省 pty）；chat runtime 由内置 driver 处理，不走 RuntimeHost.allocate/resolveLaunch */
  surface?: AgentRuntimeSurface;
  /** The launcher can attempt an exact native ID; omitted terminal entries are start-only. */
  terminalResume?: 'by-id';
  extraArgs?: string[];
  /** 开箱脚本内容版本：种子版本更高时启动覆盖 userData 脚本（升级分发通道） */
  builtinScriptVersion?: number;
  integrations?: HarnessIntegration;
  /** Declarative runtime registration; no launcher source or vendor-specific host code required. */
  manifest?: RuntimeManifest;
  updatedAt: number;
}

/** `runtimes:get`：条目 + 脚本全文 */
export interface AgentRuntimeDetail extends AgentRuntimeEntry {
  scriptSource: string;
}

export interface UpdateRuntimeArgs {
  id: string;
  label?: string;
  enabled?: boolean;
  extraArgs?: string[];
  scriptSource?: string;
}

export type RegisterRuntimeManifestArgs = RuntimeManifest;

/** 设置页 / IPC 写操作结果（取消不落盘） */
export interface RuntimeMutationResult {
  ok: boolean;
  cancelled?: boolean;
  entry?: AgentRuntimeEntry;
  entries?: AgentRuntimeEntry[];
  removed?: true;
  id?: string;
  error?: string;
}

export function isAgentRuntimeKey(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** terminal 启动种类：Agent CLI 或普通 Shell（缺省 agent 兼容旧数据） */
export type SessionLaunchKind = 'agent' | 'shell';

export const SHELL_PROFILE_IDS = ['powershell', 'pwsh', 'cmd', 'git-bash', 'wsl', 'zsh', 'bash'] as const;
export type ShellProfileId = (typeof SHELL_PROFILE_IDS)[number];

export function isShellProfileId(value: string | undefined | null): value is ShellProfileId {
  return !!value && (SHELL_PROFILE_IDS as readonly string[]).includes(value);
}

/** 本机探测到的 Shell 配置档（打开终端菜单时按需探测） */
export interface ShellProfile {
  id: ShellProfileId;
  label: string;
  command: string;
  args: string[];
}

/** 后台命令 Shell 档位：auto = 有 Git Bash 优先用 Git Bash（缺省）；powershell = 强制 PowerShell */
export type BgShellMode = 'auto' | 'powershell';

/**
 * Shell 环境信息（shell:getInfo IPC；设置页 Shell 区块展示用）。
 * gitBashPath = 实际生效的探测/手工结果（null = 本机无可用 Git Bash）。
 */
export interface ShellEnvInfo {
  platform: string;
  /** 本机可用 Shell 配置档列表（与 shell:listProfiles 同源） */
  profiles: ShellProfile[];
  gitBashPath: string | null;
  /** 用户手工指定值（未设置为空串） */
  manualGitBashPath: string;
  /** 手工指定值是否存在（不存在时探测回落自动，界面上标红提示） */
  manualGitBashPathExists: boolean;
  /** 后台命令（bgtasks.shell）Shell 档位；未配置时为 'auto' */
  bgShellMode: BgShellMode;
  /** 新后台任务实际会选用的配置档，未找到可用 Shell 时为 null */
  bgShellProfile: ShellProfile | null;
}

/**
 * 会话实时胶囊（自由文案）。只用于左栏/看板卡片标签，不驱动看板列。
 * 看板列走 SessionPhase（idle / needs_you / done）。
 */
export type LiveStatusKind = 'info' | 'active' | 'waiting' | 'done' | 'error';

export interface LiveStatus {
  /** 自由文案，发起任务时由调度 Agent 规定或 Worker 按约定上报 */
  label: string;
  /** 可选着色桶，缺省 info；不再推导看板列 */
  kind?: LiveStatusKind;
  /** 可选更长说明（气泡/tooltip） */
  summary?: string;
  ts: number;
}

/** 看板相位（模型只上报 needs_you / done；idle 兼容历史、手动标记与宿主读屏）。
 * idle=空闲不等人 / needs_you=下一步在人（含等验收） / done=已闭环人不需要再看 */
export type SessionPhaseKind = 'idle' | 'needs_you' | 'done';

/** done/needs_you 的判定来源；user=用户手动标记（粘性，model/llm 不得回退） */
export type SessionPhaseSource = 'model' | 'llm' | 'user';

export interface SessionPhase {
  value: SessionPhaseKind;
  source: SessionPhaseSource;
  ts: number;
}

/** 结构化生命周期（仅 hooks 脚本 POST activity；模型协议用 phase） */
export type StructuredActivityKind = 'active' | 'idle' | 'waiting_input' | 'blocked';

export interface SessionActivity {
  kind: StructuredActivityKind;
  /** 来源事件名（如 user-prompt-submit / stop / permission-request） */
  event?: string;
  ts: number;
  /** 宿主拥有明确的 GUI 回合结束信号，不按输出/时长过期。 */
  guiTurn?: boolean;
  /** shell-start/end 成对的执行事实；无 id 的旧 hook 用计数兼容。 */
  pendingTools?: string[];
  unpairedTools?: number;
}

export interface WorkspaceNotifyItem {
  id: string;
  workspaceId: string;
  /**
   * 来源会话 id；合成前缀（notify:/ext:/task:/orchestrator:）只用于分组，
   * 点通知时不要 sessions.select（见 shouldSelectNotifySession）。
   */
  sessionId: string;
  sessionName: string;
  ts: number;
  lifecycle?: AgentLifecycle;
  label?: string;
  kind?: LiveStatusKind;
  /** 展示串，含会话名，如 `工作面板 2 · blocked` */
  text: string;
  /**
   * 更新键：带 `update: true` 推送时，同工作区内相同 updateKey 的旧通知会被原地更新（不新增）。
   * 典型：`lifecycle:<sessionId>` / `live:<sessionId>`
   */
  updateKey?: string;
}

export function formatNotifyText(sessionName: string, detail: string): string {
  const name = sessionName.trim() || t('会话');
  const d = detail.trim();
  return d ? `${name} · ${d}` : name;
}

/** A queued task has no session until a worker slot becomes available. */
export interface TaskDelegateResult {
  session?: SessionMeta;
  inject?: {
    mode: 'typed' | 'cli-prompt' | 'gui-prompt' | 'mailbox';
    messageId?: string;
    briefChars: number;
    typedPreview?: string;
    injectFile?: string;
    queued?: boolean;
    /** Initial prompt is attached, but process startup is still pending. Keep this session id. */
    pending?: boolean;
  };
  isolate?: boolean;
  repoSet?: string[];
  repoNote?: string;
  notified: boolean;
  queued?: boolean;
  queueId?: string;
  queuePosition?: number;
  maxConcurrentWorkers?: number;
  activeWorkers?: number;
  status?: 'started' | 'starting' | 'queued';
  routing?: import('./workerRouting').WorkerRouteReceipt;
}

export interface SessionMeta {
  /** Archived CLI output, stored locally and omitted from the session list projection. */
  archiveTerminalText?: string;
  /** Registry owner kept solely so a detached worktree remains discoverable and cleanable. */
  retainedWorktreeOnly?: boolean;
  worktreeCleanupPending?: boolean;
  workerRouting?: import('./workerRouting').WorkerRouteState;
  id: string;
  type: SessionType;
  name: string;
  /**
   * 名字仍是创建时的默认名（如「工作面板 N」）：用户首条指令到达时自动改名。
   * 手工或自动改名后即清除；旧落盘无此字段，不参与自动命名。
   */
  autoNamed?: boolean;
  createdAt: number;
  /** 最近一次真使用时间（用户键盘输入/任务运行时更新；选中查看、终端输出均不更新）；排序与「x 前」展示用此字段，缺省回落 createdAt */
  lastUsedAt?: number;
  /** 最近助手正文的有界预览；正常打开历史时可补齐或刷新。 */
  boardReplyPreview?: string;
  /** terminal：agent（CLI）或 shell；缺省 agent */
  launchKind?: SessionLaunchKind;
  /** shell 会话：配置档 id */
  shellProfileId?: ShellProfileId;
  /** terminal 会话：内置 runtime key（仅 agent） */
  runtime?: AgentRuntimeKey;
  /** Explicit CLI startup overrides, persisted for relaunch/continuation. */
  cliLaunchOptions?: import('./cliLaunchOptions').CliLaunchOptions;
  /** CLI 侧会话 ID（cursor chatId / claude uuid / opencode ses_*） */
  externalSessionId?: string;
  /** Source scope of the saved PTY handle. Legacy rows retain their recorded runtime and cwd. */
  terminalResumeScope?: { runtime: string; cwd: string };
  /** terminal 会话：工作目录 */
  cwd?: string;
  /** 所属工作区（多根目录并行） */
  workspaceId?: string;
  /** Pinned source identity; cwd may instead point at an external task worktree. */
  sourceRoot?: { rootId: string; path: string; cwd: string; physicalPath?: string; };
  /** terminal 会话：pty 当前状态 */
  status?: TerminalStatus;
  /** CLI 会话最近一次模型建议；按会话隔离，发送新消息后清除。 */
  cliSuggestedReplies?: { messageId: string; replies: string[] };
  /** agent 生命周期（与 status 并存；agent 侧以 lifecycle 为准） */
  lifecycle?: AgentLifecycle;
  /** 左栏置顶（同区内置顶项排在前面） */
  pinned?: boolean;
  /** 置顶时间，用于多个置顶项之间排序 */
  pinnedAt?: number;
  /** 已归档：默认不出现在左栏，可再显示 */
  archived?: boolean;
  /** scheduled 会话：关联的服务 id */
  serviceId?: string;
  /** 由提示词任务创建的执行会话 */
  taskId?: string;
  /**
   * 父会话 id（子代理通用化）：带此字段的会话是「子代理」——一个被父拉起、
   * 在左栏挂在父下方、共享父工作区的普通 worker 会话（不再有专属执行路径）。
   * 缺省 = 顶层会话。链深度见 `sessionDepth`（顶层 1，总深度上限 3），超限拉活一律拒绝。
   * 不在 SessionMeta 冗余存 depth——按 parentSessionId 回溯算，单一真源。
   */
  parentSessionId?: string;
  /** 内置职业身份；仅子代理创建时设定，随会话持久化。 */
  subagentCharacterId?: import('./subagentCharacters').SubagentCharacterId;
  /** 编排跟踪标记：调度 Agent 拉起/派活的会话为 true（调度可用 sessions.setOrchestrated
   *  动态改）；用户手工拉起缺省。相位翻转/回合结束/R3 守卫等编排事件只上报 true 的会话。 */
  orchestrated?: boolean;
  /** @deprecated 已被 orchestrated 取代（该计数只在 pty 注入分支 +1，与派活路径解耦）。
   *  字段保留仅为读入迁移：orchestrated 缺省且 briefCount>0 时回填 true，之后不再写入。 */
  briefCount?: number;
  /** Worker/脚本上报的实时胶囊文案（列表标签；不驱动看板列） */
  liveStatus?: LiveStatus;
  /**
   * 未消化的排队注入条数（宿主控制提示等 fromInject 项）。
   * 运行时字段，装载时清掉；左栏胶囊由 project() 叠「· 排队N」。
   */
  queuedInjects?: number;
  /** 看板三档（模型或 LLM 读屏）；hooks 走 activity */
  phase?: SessionPhase;
  /** 首个权威信号时间（hook / 模型 phase / LLM）；缺省视为未知 */
  firstSignalAt?: number;
  /** 最近一次拉起时间；重启后的无信号宽限不能沿用会话创建时间。 */
  runtimeStartedAt?: number;
  /** 当前宿主投影，非历史执行事实；不从磁盘恢复。dormant 表示尚未按需加载。 */
  runtimePresence?: 'dormant' | 'starting' | 'running' | 'exited';
  /** 当前 PTY 的最近字节活动，仅用于运行监控，不参与列表排序。 */
  lastOutputAt?: number;
  /** 结构化生命周期信号（hooks 权威上报；waiting_input/blocked 为 sticky） */
  activity?: SessionActivity;
  /** 会话隔离 worktree（P3.5：派活 isolate 时创建；路径自带会话溯源） */
  worktreePath?: string;
  /** Source identity survives external storage and missing-worktree recovery. */
  worktreeSource?: { mainRepo: string; commonDir: string; };
  /** 会话 worktree 的分支（ao/<sessionId> 命名空间） */
  worktreeBranch?: string;
  /**
   * 建树时实际起点分支（R-18「从哪建回哪」）：HEAD 正常时=主仓当时分支名，
   * base 守卫（detached/ao 残留）回落时=默认分支名；detached 无名时缺省。
   * integrate 缺省 target 优先用它，旧会话无此字段才回落默认分支。
   */
  worktreeBaseBranch?: string;
  /**
   * R-18b 多仓隔离组：嵌套独立仓清单（主仓工作区内、各仓 worktree 按主检出内
   * 相对位置嵌进容器）。有值时 integrate/清理走组级路径；主仓仍是
   * worktreePath/worktreeBranch，不进本清单。
   */
  worktreeRepoSet?: WorktreeRepoRef[];
  /** Task-owned repository groups; legacy worktree fields project the named primary group. */
  worktreeGroups?: SessionWorktreeGroups;
  /**
   * 会话上报令牌（注入 MUSTER_STATUS_URL / MUSTER_SESSION_TOKEN）。
   * Worker 不必知道宿主 sessionId；凭此令牌由宿主反查会话。
   */
  statusToken?: string;
  /** Native values to restore after an automatic permission override. */
  nativePermissionRestore?: import('./nativeSessionConfig').NativeConfigIntent;
  /** GUI（chat surface）Worker 会话：权限档位（由 guiMode 派生维护；旧数据兼容字段） */
  permissionMode?: WorkerPermissionMode;
  /** GUI Worker 会话模式（default/ask/plan/auto，与调度模式体系同源）；缺省按旧 permissionMode 迁移 */
  guiMode?: GuiWorkerMode;
  /** Enables manual permission settings and review. Only true opts in. */
  configurePermissions?: boolean;
  /** Native selections explicitly requested at creation, scoped to their engine/source. */
  nativeConfig?: import('./nativeSessionConfig').NativeConfigIntent;
  /** GUI 会话续聊令牌（Pi session id；禁止存绝对路径） */
  runtimeResumeToken?: string;
  /** Storage profile that issued the current native GUI history handle. */
  nativeHistoryStorageKey?: string;
  /** Directory supplied to the engine when it issued the history handle. */
  nativeHistoryCwd?: string;
  /** Confirmed native deletion of a bound history, retained until the local row is removed. */
  nativeHistoryDeleteReceipt?: string;
  /** History still owned by this row after Codex changes its resume handle. */
  codexContinuationHistory?: Array<{ sourceId: string; stagingId?: string }>;
  /** Pi GUI 会话的自定义模式（内置 creator/用户自建 id；空串=标准无模式；产生内容后不可换） */
  piModeId?: string;
  /** 会话级模型覆盖（Pi GUI 会话；不设=跟随全局默认。设置页改默认模型不影响已覆盖的会话） */
  modelOverride?: {
    providerId: string;
    modelId: string;
    /** Cursor GUI 模型参数（Router optimize_for 等）；Pi 忽略 */
    params?: Array<{ id: string; value: string; }>;
  };
  /** 会话级思考档（Pi GUI 会话；缺省=跟随默认：reasoning 模型 medium / 其余 off） */
  thinkingLevel?: GuiThinkingLevel;
  /** Runtime-neutral session parameter overrides, independent of model pinning. */
  modelParameters?: import('./modelParameters').ModelParameterValues;
  /**
   * needs_you 用户注意通知预算计数；普通会话通信不消费此预算。
   * key=escalateBudgetKey（session:<id>），value=用户注意通知已用次数；不计会话通信。
   * 预算 3/条目；第 4 次 refused 正常结果。可挂任务条目/会话链。
   */
  escalateBudget?: Record<string, number>;
  /**
   * 待验收搁置（R4）：仍可在「需要你」列看到，但不进探出条/轮播，批量清理可一并收走。
   */
  reviewDeferred?: boolean;
  /** 验收留痕（通过/打回/搁置/标记已处理） */
  acceptanceLog?: import('./boardReview').AcceptanceRecord[];
  /**
   * 交验前置门快照（R-14 一期）：编排会话报 needs_you 时宿主对本次交付改动
   * 跑机械维度门（i18n / motion）的结果。红灯 = 不进「需要你」列；下一次
   * needs_you 上报重跑覆盖；打回/验收后清除。手工会话不进门（无此字段）。
   */
  dimensionGates?: import('./dimensionGates').DimensionGatesSnapshot;
  /** 附加元数据（如 meta.issueId） */
  meta?: Record<string, string>;
  /**
   * 隐藏临时会话：仅 createTerminal 内部入口设置，不进左栏 / 看板 / 切换器 / 搜索，
   * 不抢 activeId；完成或失败后宿主走 allowUnarchived 销毁。外部 IPC 不开放此字段。
   */
  hidden?: boolean;
  /**
   * 应用重启中断快照（R12）：启动对账写入 in-flight 会话。
   * 续作一键消费后清除。无按天 TTL（保守默认）。
   */
  interruptSnapshot?: import('./interruptSnapshot').InterruptSnapshot;
}

/** GUI Worker 会话级权限档位（chat surface 专用；CLI Worker 不受此约束） */
export type WorkerPermissionMode = 'acceptEdits' | 'ask' | 'auto';

/** 产品统一思考档（五档；Pi 引擎七档的子集——minimal/xhigh 不暴露）。定义在零依赖的 thinkingLevels.ts */
import type { GuiThinkingLevel } from './thinkingLevels';
export type { GuiThinkingLevel } from './thinkingLevels';
export { GUI_THINKING_LEVELS } from './thinkingLevels';

/**
 * GUI（chat surface）Worker 会话的初始态：建会话时一次性落上 SessionMeta 的会话级配置。
 * 两条来源：delegate / 新建任务面板「高级选项」开局指定；fork 从源会话延续。
 * piModeId 产生首条消息后锁死，只能在创建时给——这也是它进创建参数面的原因。
 */
export interface GuiSessionInitialMeta {
  modelParameters?: import('./modelParameters').ModelParameterValues;
  configurePermissions?: boolean;
  nativeConfig?: import('./nativeSessionConfig').NativeConfigIntent;
  piModeId?: string;
  guiMode?: GuiWorkerMode;
  modelOverride?: {
    providerId: string;
    modelId: string;
    /** Cursor GUI 模型参数；Pi 忽略 */
    params?: Array<{ id: string; value: string; }>;
  };
  /** 会话级思考档，仅 Pi 生效（需服务商配置思考映射） */
  thinkingLevel?: GuiThinkingLevel;
}

/**
 * GUI Worker 会话模式。旧 default/ask/plan/auto 的持久化含义保持不变；
 * standard 与 accept-edits 是有逐项审批接线的引擎使用的新权限档；auto-review 是 Codex 原生自动审核。
 */
export type GuiWorkerMode = AgentMode | 'auto' | 'standard' | 'accept-edits' | 'auto-review';

/** 登记的源文件夹。id 在改显示名、排序或默认 cwd 时保持稳定。 */
export interface WorkspaceRoot {
  id: string;
  path: string;
  label?: string;
}

/** 文件身份不能仅由相对路径表示：不同源根可以有同名文件。 */
export interface WorkspaceFileRef {
  workspaceId: string;
  rootId: string;
  relativePath: string;
}

/** 已打开的逻辑工作区。旧字段在配置入口兼容，消费者使用 workspaceRoots/workspacePaths。 */
export interface WorkspaceInfo {
  id: string;
  /** 兼容旧调用的默认 cwd 投影；不是管理数据目录。 */
  path: string;
  /** 缺省仅用于迁移旧单根数据；ConfigManager 产出的工作区总是有此字段。 */
  roots?: WorkspaceRoot[];
  defaultRootId?: string;
  /** 固定管理根；不得跟随默认 cwd 或源根排序移动。 */
  controlRoot?: string;
  /** Demo 主进程派生的管理数据目录。源目录和默认 cwd 仍指向用户选择的项目。 */
  demoDataRoot?: string;
  rootsRevision?: number;
  /** 外部配置结构无效时保留原登记并反馈，禁止静默重置整个配置。 */
  rootsError?: string;
  name: string;
  openedAt: number;
  /** 工作区图标：builtin-workspace:<id>，或上传图片 URL；兼容历史 emoji。 */
  avatar?: string;
  /** 工作区独立强调色：'avatar' = 跟随头像，#rrggbb = 手选；无 accent/accentOff 则跟随全局默认 */
  accent?: string;
  /** 头像取色缓存（accent='avatar' 时生效；渲染层保存工作区时按头像重算） */
  avatarAccent?: string;
  /** true = 不使用主题色（框/头像/指示条改中性灰） */
  accentOff?: boolean;
}

export interface ResolvedWorkspaceInfo extends WorkspaceInfo {
  roots: WorkspaceRoot[];
  defaultRootId: string;
  controlRoot: string;
  rootsRevision: number;
}

/** 编辑/新建工作区时可写的强调色字段；null = 清除 */
export interface WorkspaceAccentOptions {
  accent?: string | null;
  avatarAccent?: string | null;
  accentOff?: boolean;
}

/** 打开/新建工作区选项 */
export interface WorkspaceOpenOptions extends WorkspaceAccentOptions {
  path?: string;
  roots?: WorkspaceRoot[];
  defaultRootId?: string;
  /** 创建时固定宿主文件夹；缺省为首次添加的根。 */
  controlRootId?: string;
  /** 使用推荐根时按需创建该目录（仅限 defaultWorkspaceRoot()）。 */
  ensureRecommendedRoot?: boolean;
  name?: string;
  avatar?: string;
}

/** workspaces:update 可写字段 */
export interface WorkspaceUpdateOptions extends WorkspaceAccentOptions {
  roots?: WorkspaceRoot[];
  defaultRootId?: string;
  /** 源根变更必须携带读取时的版本，避免覆盖其他窗口的变更。 */
  expectedRootsRevision?: number;
  name?: string;
  avatar?: string;
}

export type TaskSchedule =
  | { kind: 'daily'; time: string; }
  | { kind: 'weekly'; time: string; weekdays: number[]; }
  | { kind: 'interval'; intervalMinutes: number; }
  /** 一次性（T6/A4）：at 为 ISODateTime；成功触发一次后自动停用 */
  | { kind: 'once'; at: string; };

/** 执行模式：terminal = 新开可见 Worker；headless 已退役（启动 purge，仅历史运行记录仍可能出现） */
export type PromptTaskMode = 'headless' | 'terminal';

export interface PromptTask {
  id: string;
  name: string;
  workspaceId: string;
  /** 创建/显式选根时固定；改默认目录和重启均不重定向。 */
  sourceRoot?: SessionMeta['sourceRoot'];
  runtime: AgentRuntimeKey;
  prompt: string;
  schedule: TaskSchedule;
  /** 错过策略（T3.4）：缺省 skip。仅 time 触发在启动/唤醒评估错过窗口时生效 */
  missedPolicy?: MissedPolicy;
  /** confirm 策略下错过槽位后等待用户确认补跑 */
  missedPendingConfirm?: boolean;
  /** 相对延迟（分钟，T6/A4）：创建时与 schedule 二选一；宿主真实时钟换算触发点后落到 once，此字段留存原始延迟供展示 */
  delayMinutes?: number;
  /** 成功触发次数上限（T6/A4）：interval/daily/weekly 用，达到后自动停用 */
  maxRuns?: number;
  /** 已成功触发次数（maxRuns 判定用；缺省 0） */
  runCount?: number;
  /** 缺省 / 新建恒为 terminal；存量 headless 启动时删除 */
  mode?: PromptTaskMode;
  /** 会话级模型覆盖的服务商 id；缺省跟随全局当前激活服务商 */
  providerId?: string;
  /** 会话级模型覆盖的模型 id；缺省跟随全局当前激活模型 */
  modelId?: string;
  /** Native CLI launch arguments for a scheduled terminal. */
  cliLaunchOptions?: import('./cliLaunchOptions').CliLaunchOptions;
  /** GUI 会话权限档（仅 chat runtime；对齐新建任务弹窗） */
  guiMode?: GuiWorkerMode;
  configurePermissions?: boolean;
  nativeConfig?: import('./nativeSessionConfig').NativeConfigIntent;
  /** Pi 自定义模式 / ACP 引擎 id（产生首条消息后锁死） */
  piModeId?: string;
  /** 会话级思考档（仅 Pi） */
  thinking?: GuiThinkingLevel;
  modelParameters?: import('./modelParameters').ModelParameterValues;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  lastResult?: 'ok' | 'error';
  lastError?: string;
  createdAt: number;
}

/** 定时任务执行记录：terminal 记 sessionId、headless 记 Pi 会话文件；missed = 应用未运行时错过；
 *  skipped = 事件触发被防抖窗口丢弃（T3.2 webhook/file/phase 源，未真正执行） */
export interface TaskRun {
  id: string;
  taskId: string;
  mode: 'headless' | 'terminal' | 'missed' | 'skipped';
  status: 'running' | 'ok' | 'error' | 'missed' | 'skipped';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** terminal 模式创建的会话 id（点击跳转） */
  sessionId?: string;
  /** headless 模式的 Pi 会话 jsonl 路径（点击跳调度面板装载） */
  piSessionPath?: string;
  /** 输出摘要（headless 聚合文本，截断保存） */
  output?: string;
  error?: string;
}

/** 调度面板历史会话条目（Pi 落盘会话的只读摘要） */
export interface AgentSessionSummary {
  path: string;
  id?: string;
  title: string;
  modified: number;
  messageCount: number;
  isTask: boolean;
  taskName?: string;
}

// ---------- 聊天 ----------

export interface ToolCallRecord {
  id: string;
  /** Catalog 名（带点，如 sessions.list） */
  name: string;
  arguments: string;
  /** 结构化入参（GUI Worker 传；调度面板只填 arguments JSON 串） */
  input?: Record<string, unknown>;
  /** JSON 字符串的执行结果 */
  result?: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  /** 仅 UI：终端截图本地路径，不回传模型 */
  previewPath?: string;
  /** 仅 UI：编辑类工具的 unified patch（git-diff 展示） */
  patch?: string;
}

/** Metadata retained after an old scheduler turn purges tool payloads. */
export interface ArchivedToolCallSummary {
  id: string;
  name: string;
  status: ToolCallRecord['status'];
}

export interface ChatImageAttachment {
  /** Generic composer attachment. Legacy field name retained for saved drafts/queues. */
  sourcePath?: string;
  id: string;
  /** 纯 base64 字符串（不带 data:image/...;base64, 前缀） */
  data: string;
  mimeType: string;
  /** 预览用完整 Data URL 或本地路径 */
  url?: string;
  name?: string;
  size?: number;
}

/**
 * 展示用交错内容片段（GUI Worker 与调度面板的 parts 消息模型都映射到
 * ChatMessageView；不填 parts 的消息走 thinking/toolCalls/content 扁平字段）。
 */
export type ChatDisplayPart =
  | { kind: 'text'; text: string; }
  | { kind: 'thinking'; text: string; }
  | { kind: 'tool'; toolCall: ToolCallRecord; };

/** 调度 askQuestion 提问卡的单一题目（与 GuiUserQuestionItem 同形，避免 types↔guiWorker 循环依赖） */
export interface ChatUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: Array<{ label: string; description?: string; }>;
  multiSelect?: boolean;
  intent?: { kind: string; approve?: string; };
  /** Explicit free-text prompt; unlike a questionnaire, an empty answer is valid. */
  textInput?: { defaultValue?: string; placeholder?: string; multiline?: boolean };
}

/** 调度 askQuestion 提问卡（挂在所属 assistant；一次一张） */
export interface ChatUserQuestionView {
  questionId: string;
  questions: ChatUserQuestionItem[];
  status: 'pending' | 'answered' | 'aborted';
  abortReason?: 'superseded';
  answers?: Array<{ id: string; selected: string[]; custom?: string; }>;
  anchorPartIndex?: number;
}

export interface ChatMessage {
  /** Display-only status of the final model call, independent of earlier tool-loop text. */
  outputNotice?: 'length' | 'reasoning-only';
  turnChanges?: import('./turnChanges').TurnChanges;
  /** Host-owned display annotations; never forwarded as model input. */
  displayItems?: import('./displayItems').DisplayItem[];
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 按时间顺序交错的片段（填了就优先于 thinking/toolCalls/content 渲染） */
  parts?: ChatDisplayPart[];
  /** 用户附加的图片（多模态模型使用） */
  images?: ChatImageAttachment[];
  /** 思维链（reasoning 模型流式输出；展示层专用，不回传给模型） */
  thinking?: string;
  toolCalls?: ToolCallRecord[];
  /** Scheduler-only archive projection. Raw tool arguments/results are purged. */
  archived?: boolean;
  archiveSummary?: string;
  archivedTools?: ArchivedToolCallSummary[];
  createdAt: number;
  /** Actual host turn settlement; absent in legacy or interrupted fragments. */
  finishedAt?: number;
  /** 请求失败等错误信息 */
  error?: string;
  /** 自动重试进行中的提示行（如「⏳ 自动重试 1/3…」；成功后清除） */
  retryHint?: string;
  /** 用户消息已排队：Agent 空闲后自动发送；发送前置为 undefined */
  queued?: boolean;
  /** 用户手动停止当前回合（stopReason === 'aborted'） */
  aborted?: boolean;
  /** plan 模式提取出的计划卡（渲染层专用） */
  plan?: PlanCard;
  /** 仅 UI：/status 等本地插入，不进模型上下文、不进 Pi 历史 */
  local?: boolean;
  /** 宿主注入（R1 编排事件/守卫提醒/审计副本等）：进模型上下文，但非用户发送；通栏系统条 */
  host?: boolean;
  /** Assistant round originated from a structured host event; retries must not replay an older human request. */
  hostEvent?: 'pending' | 'consumed';
  /**
   * 转写身份：scheduler = 调度注入，agent = 跨会话代理消息（引擎仍是 user 回合）。
   * 省略 = 用户真输入。host:true 优先于本字段（通栏不改）。
   */
  source?: import('./chatMessageSource').ChatTranscriptSource;
  sourceAgent?: import('./subagentCharacters').SourceAgentIdentity;
  /** 调度 askQuestion 提问卡（挂在所属 assistant；GUI 会话走 GuiChatMessage.userQuestion） */
  userQuestion?: ChatUserQuestionView;
  /**
   * 当前 assistant 的建议回复（≤3）：空输入框内预览，Tab 才写入草稿。
   * 调度由 ui.suggestReplies 写入；问答待答期间隐藏并清理旧建议。
   */
  suggestedReplies?: string[];
  /**
   * Harness 透明·插话标记（GUI 会话映射自 GuiChatMessage.steering）：
   * 'host' = 宿主静默插话，不作为回合界线（流式定位/停靠点跳过）。
   * 'send' = 用户插话：调度 steer 的切分与 TOCTOU 回落两路径都携带该标记。
   */
  steering?: 'send' | 'host';
}

/** 调度 Agent 模式：default 正常；ask 只读（禁写工具+bash 只读白名单）；plan 只读规划+批准执行 */
export type AgentMode = 'default' | 'ask' | 'plan';

export interface PlanStepView {
  step: number;
  text: string;
  completed: boolean;
}

export interface PlanCard {
  steps: PlanStepView[];
  status: 'pending' | 'executing' | 'done' | 'abandoned';
  /** 计划原文 markdown（工具提交/正文提取的完整计划块；缺省=旧数据，仅步骤列表） */
  markdown?: string;
  /** 当前生效计划（挂新卡时旧 pending 卡置 false 转只读；缺省视为 true，兼容旧数据） */
  active?: boolean;
}

export type AgentStatus = 'idle' | 'thinking' | 'streaming' | 'tool' | 'confirm' | 'error';

export interface BubbleState {
  text: string;
  status: AgentStatus;
  /** 多工作区：该气泡所属工作区；缺省表示 active */
  workspaceId?: string;
}

export interface WorkspaceSwitchResult {
  ok: boolean;
  message?: string;
  rootDependencies?: WorkspaceRootDependency[];
  workspaces?: WorkspaceInfo[];
  activeWorkspaceId?: string;
}

/** Main-process evidence preventing removal of a registered source folder. */
export interface WorkspaceRootDependency {
  rootId: string;
  kind: 'session' | 'worktree' | 'queued-task' | 'service' | 'background-task' | 'launch' | 'open-file' | 'file-write' | 'file-delete';
  id: string;
  label: string;
  sessionId?: string;
  serviceId?: string;
  relativePath?: string;
}

export interface SandboxInfo {
  enabled: boolean;
  rootDir?: string;
  userDataDir?: string;
  workspacesDir?: string;
  templateDir?: string;
  hasTemplate?: boolean;
}

// ---------- 能力目录 ----------

export interface CatalogToolInfo {
  /** 带点名称，如 sessions.create */
  name: string;
  description: string;
  dangerous: boolean;
  parameters: unknown;
  summary?: string;
  schedulerVisible?: boolean;
  /** Availability in the Worker presets and extension allowlist. */
  workerVisible?: boolean;
  extensionVisible?: boolean;
  /** Settings projection of registration/routing definitions, never session or execution evidence. */
  exposure?: {
    kind: 'direct' | 'domain' | 'action' | 'internal';
    scheduler: boolean;
    workerPresets: string[];
    entry?: string;
    action?: string;
    skillPath?: string;
    /** Settings-only local path for showing a declared skill in the file manager. */
    resolvedSkillPath?: string;
    actions?: Array<{ action: string; target: string }>;
  };
  /** 动态注册的扩展工具（ext.*）；缺省为内置工具 */
  source?: 'builtin' | 'dynamic';
  /** 动态工具 TOFU 内容指纹是否与信任记录一致（仅 source=dynamic 时有意义） */
  trusted?: boolean;
}

export interface CapabilityCatalogInfo {
  version: string;
  tools: CatalogToolInfo[];
}

// ---------- 配置 ----------

/** 已解析的 pty 启动命令（内置 registry 产出，不再由用户自由定义整条命令） */
export interface ResolvedLaunch {
  command: string;
  args: string[];
  /** Per-process transport credentials; host identity variables are applied afterwards. */
  env?: Record<string, string>;
  /** args already escaped for cmd.exe; node-pty must not apply C argv quoting again. */
  windowsVerbatimArguments?: boolean;
}

/** 用户可对内置 runtime 做的唯一覆盖：追加启动参数 */
export interface RuntimeOverride {
  extraArgs?: string[];
}

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface LlmModelConfig {
  attachments?: import('./attachmentPolicy').AttachmentPolicy;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /** 是否支持多模态（图片输入） */
  multimodal?: boolean;
  /** 由配置入口记录的显式图片开关。早期手动添加曾把未操作的开关保存为 false。 */
  multimodalExplicit?: true;
  /** 扩展模型网关可调用的能力；未填写时只按 provider 的能力声明推断。 */
  modalities?: LlmModality[];
}

export type LlmModality = 'text' | 'image' | 'video' | 'asr' | 'tts';

export interface LlmProviderMediaConfig {
  /** OpenAI-compatible image generation endpoint, relative to the provider base URL. */
  imagePath?: string;
  /** OpenAI-compatible speech synthesis endpoint, relative to the provider base URL. */
  ttsPath?: string;
  /** OpenAI-compatible transcription endpoint, relative to the provider base URL. */
  asrPath?: string;
  /** Optional asynchronous video adapter. Paths may contain {taskId}. */
  video?: { submitPath: string; pollPath: string; resultPath?: string; statusPath?: string };
}

export type LlmApiProtocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'
  | 'mistral-conversations'
  | 'azure-openai-responses';

/** 思考方言：openai-completions 系「思考控制字段」的格式。缺省由 pi-ai 按服务商自动探测 */
export const LLM_THINKING_FORMATS = [
  'openai',
  'openrouter',
  'deepseek',
  'together',
  'zai',
  'qwen',
  'qwen-chat-template',
  'chat-template',
  'string-thinking',
  'ant-ling'
] as const;

export type LlmThinkingFormat = (typeof LLM_THINKING_FORMATS)[number];

export interface LlmProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /**
   * 底层请求 API 协议规范，缺省为 'openai-completions'
   * - 'openai-completions': 传统标准 (/v1/chat/completions) - 支持 DeepSeek/小米/百炼/第三方
   * - 'openai-responses': OpenAI 新一代 Responses API (/v1/responses)
   * - 'anthropic-messages': Anthropic Claude 原生协议 (/v1/messages)
   * - 'google-generative-ai': Google Gemini 原生协议
   */
  api?: LlmApiProtocol;
  models: LlmModelConfig[];
  enabled?: boolean;
  /** Capabilities exposed to extension model callers. Keys stay in the host config. */
  modalities?: LlmModality[];
  media?: LlmProviderMediaConfig;
  /** OpenAI completions capabilities; custom endpoints default to system instructions. */
  compat?: {
    /** Explicit support for developer instructions on reasoning models; absent uses the catalog or the custom-endpoint default. */
    supportsDeveloperRole?: boolean;
  };
  /**
   * 思考强度映射（产品五档 → 服务商载荷值）：服务商只提供三档时，用户可以把
   * 多个产品档重复映射到同一载荷值；某档留空=该档不可用（下发时跳过）。
   * reasoningEffortField：openai-completions 系是否以 reasoning_effort 字段发送
   * （部分网关/自建服务用自定义字段名，由服务端决定，这里只开/关该字段）。
   * thinkingFormat：思考方言显式指定（仅 openai-completions 协议生效），用于纠正
   * pi-ai 按 baseUrl 自动探测的误判（网关代理/自建服务常见）；缺省=自动探测。
   * disableAtOff：off 档真正关闭思考。仅 completions + DeepSeek 系方言生效
   * （GLM-5.3 系/OpenAI 推理模型协议层禁止关闭，勾了也无效）；piConfigSync 会把它
   * 翻译成 off 档哨兵值（pi-ai 据 map.off !== null 发 thinking:{type:'disabled'}），
   * 替代手写哨兵的暗语义。
   */
  thinking?: {
    levels?: Partial<Record<GuiThinkingLevel, string>>;
    reasoningEffortField?: boolean;
    thinkingFormat?: LlmThinkingFormat;
    disableAtOff?: boolean;
  };
}

export interface LlmConfig {
  providers: LlmProviderConfig[];
  activeProviderId: string;
  activeModelId: string;
}

export interface LlmTestResult {
  ok: boolean;
  durationMs?: number;
  error?: string;
}

/** 划词浮条的「文本工具」：名称 + 提示词，选中文本作为 user 消息交给模型 */
export interface TextToolFunction {
  id: string;
  /** 浮条按钮文字 */
  name: string;
  /** system 提示词，描述如何处理输入；只输出处理结果 */
  prompt: string;
  /** 空 = 用 textTools.default*，再回落全局 active */
  providerId?: string;
  modelId?: string;
  /** false = 不在浮条显示（配置保留） */
  enabled?: boolean;
  /** 尽力关闭深度思考（默认开）：对支持的模型附加关闭/降档参数；
   *  DeepSeek reasoner 等官方无开关的模型无效，需选非思考版模型 */
  noThinking?: boolean;
}

export interface TextToolsConfig {
  functions: TextToolFunction[];
  /** 功能组默认模型；空 = 跟随全局 active */
  defaultProviderId?: string;
  defaultModelId?: string;
}

/** 文本工具执行请求（textTools:run）；渲染层只传功能定义与文本，apiKey 留在主进程 */
export interface TextToolRunRequest {
  name: string;
  prompt: string;
  providerId?: string;
  modelId?: string;
  text: string;
  /** 传了就走流式：增量经 textTools:chunk 事件按 runId 推送 */
  runId?: string;
  /** 尽力关闭深度思考；缺省视为开（与 TextToolFunction.noThinking 对齐） */
  noThinking?: boolean;
}

export interface TextToolRunResult {
  text: string;
  /** 实际使用的「服务商 · 模型」（结果卡展示用） */
  modelLabel: string;
}

/** 调度 Agent 可用的 MCP 服务器（stdio 子进程或 HTTP） */
export type McpTransportKind = 'stdio' | 'http';

export interface McpServerConfig {
  /** 唯一名，如 FeishuProjectMcp */
  name: string;
  enabled: boolean;
  transport: McpTransportKind;
  /** stdio */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** http */
  url?: string;
  headers?: Record<string, string>;
  /** Concrete CLI / GUI / SDK entry points. Undefined preserves legacy all-target behavior. */
  targetIds?: string[];
}

export interface McpConfig {
  /** 总开关：关则不注册 mcp 工具、不拉起服务器 */
  enabled: boolean;
  /** 用户级（整体生效，所有工作区） */
  servers: McpServerConfig[];
}

/** Composer：Pi ResourceLoader 已发现的 Skill（调度与 GUI 会话同一数据源） */
export interface AgentSkillInfo {
  name: string;
  description: string;
  /** Stable physical file identity for injection bookkeeping. */
  id?: string;
  /** Menu command; qualified when more than one file has this name. */
  commandName?: string;
  qualifiedName?: string;
  physicalFilePath?: string;
  source?: { kind: 'project' | 'user' | 'mode'; rootIds?: string[]; label: string; path: string; };
  /** SKILL.md 绝对路径（发送展开时读正文；菜单只消费 name/description） */
  filePath?: string;
  /** 技能目录（相对引用基准，与 Pi Skill.baseDir 对齐） */
  baseDir?: string;
}

/** 调度 Composer：@ 文件引用条目 */
export interface WorkspaceFileEntry {
  /** 相对所属源根，POSIX 分隔；旧单根条目仍相对工作区。 */
  path: string;
  fileRef?: WorkspaceFileRef;
  /** 给模型使用的源根绝对路径，不能用显示名前缀代替。 */
  absolutePath?: string;
  /** 显示层根名/相对路径；不用于磁盘解析或发送。 */
  displayPath?: string;
}

/** 文件面板：目录一层条目 */
export interface FsDirEntry {
  name: string;
  isDirectory: boolean;
  /** 链接本身或其祖先是链接；树不对这些条目提供删除。 */
  isSymbolicLink?: boolean;
  viaSymbolicLink?: boolean;
  /** 指向源根外时，使用既有外部只读预览。 */
  externalPath?: string;
  /** 失效或循环链接仍显示，不能展开或打开。 */
  linkError?: string;
  /** 相对所属源根，POSIX；旧单根调用仍相对 workspace.path。 */
  relativePath: string;
  /** IPC 提供的完整身份；旧单根列表仍可只消费 relativePath。 */
  fileRef?: WorkspaceFileRef;
}

export type FsReadResult =
  | { ok: true; content: string; /** 读取时的 mtime（ms），作为写盘乐观锁基线 */ mtimeMs: number; }
  | { ok: false; error: string; };

export interface FsWriteResult {
  ok: boolean;
  error?: string;
  /** true=磁盘 mtime 与期望基线不一致，拒绝覆盖（外部修改保护） */
  conflict?: boolean;
  /** 写入成功后的新 mtime（ms），调用方用来刷新乐观锁基线 */
  mtimeMs?: number;
}

/** 内容搜索命中 */
export interface FsSearchHit {
  path: string;
  line: number;
  preview: string;
  fileRef?: WorkspaceFileRef;
}

export interface FsListPathsOptions {
  max?: number;
}

export interface FsSearchTextOptions {
  query: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

/** 多根查询使用独立返回形状，禁止丢掉根身份后用裸路径导航。 */
export interface WorkspaceQueryOptions {
  rootIds?: string[];
  max?: number;
  query?: string;
  caseSensitive?: boolean;
  requestId?: string;
  includeHidden?: boolean;
  includeIgnored?: boolean;
}

export interface WorkspaceQueryRootStatus {
  rootId: string;
  truncated: boolean;
  timedOut: boolean;
  error?: string;
}

export interface WorkspaceQueryResult<T> {
  items: T[];
  roots: WorkspaceQueryRootStatus[];
  rootsRevision: number;
  truncated: boolean;
  cancelled: boolean;
  error?: string;
}

export interface WorkspaceListedFile extends WorkspaceFileEntry {
  fileRef: WorkspaceFileRef;
  absolutePath: string;
}
export interface WorkspaceSearchHit extends FsSearchHit {
  fileRef: WorkspaceFileRef;
}

/** 工作区磁盘变更（文件树自动刷新） */
export interface FsChangedPayload {
  /** 新监听器按源根投递；旧单根事件可省略。 */
  rootId?: string;
  rootsRevision?: number;
  /** 根级监听失败；不代表文件已变更，不触发自动化。 */
  error?: string;
  workspaceId: string;
  /** 相对对应源根的 POSIX 路径；旧单根事件相对 workspace.path；空字符串表示根或未知 */
  relativePaths: string[];
}

export type FsStatResult =
  | { ok: true; size: number; isFile: boolean; isDirectory: boolean; }
  | { ok: false; error: string; };

/** 旧版 Cursor 配置仅用于保留和脱敏，ACP 不读取这些字段。 */
export interface CursorConfig {
  apiKey: string;
  defaultModel?: { id: string; params?: Array<{ id: string; value: string; }>; };
  /** local.sandboxOptions.enabled */
  sandbox?: boolean;
  /** local.autoReview（分类器拒绝，非审批卡） */
  autoReview?: boolean;
}

/** Claude Agent SDK GUI Worker：鉴权走本机 claude 配置，不走 llm.providers */
export interface ClaudeConfig {
  /**
   * true：CLAUDE_CONFIG_DIR 指向 userData/agents/claude-gui（独立登录/中转，transcript 可清）。
   * 缺省 false：共享 ~/.claude（复用本机登录与 settings.json）。
   */
  isolateConfig?: boolean;
}

export interface AppConfig {
  /** Show only live thinking and exclude it from workbench display history (default true). */
  liveThinkingOnly?: boolean;
  /** Show product tips while waiting for the first response; defaults on. */
  showWaitingTips?: boolean;
  /** Machine-wide executables for local attachment conversion. */
  attachmentTools?: import('./attachmentPolicy').AttachmentTools;
  attachmentProcessing?: import('./attachmentPolicy').AttachmentProcessing;
  /** Workbench runtime/provider/model parameter defaults and display mappings. */
  modelParameterProfiles?: import('./modelParameters').ModelParameterProfile[];
  /** Automatic Worker tiers use a global default and optional explicit workspace overrides. */
  workerRoutingDefault?: import('./workerRouting').WorkerRoutingConfig;
  workerRoutingByWorkspace?: Record<string, import('./workerRouting').WorkerRoutingConfig>;
  /** Retains the workspace edit generation after deleting its override. */
  workerRoutingWorkspaceRevisions?: Record<string, number>;
  /** 调度 Agent（Pi）使用的 OpenAI 兼容 LLM；兼容存量并与 llm 双向映射；会同步到 ~/.pi/agent */
  openai: OpenAIConfig;
  /** 历史配置；Cursor ACP 使用 CLI 自身登录和设置。 */
  cursor?: CursorConfig;
  /** Claude（GUI）：是否隔离 CLAUDE_CONFIG_DIR */
  claude?: ClaudeConfig;
  /** Optional workbench-local executable overrides for user-installed Pi runtimes. */
  externalPi?: { 'pi-external'?: { executable?: string }; omp?: { executable?: string } };
  /** Optional workbench-local executable overrides for the Muse and ZCode GUI runtimes. */
  externalHarness?: { 'muse-gui'?: { executable?: string }; 'zcode-gui'?: { executable?: string } };
  /** Disabled ACP products; does not disable their independent terminal runtimes. */
  disabledAcpAgents?: string[];
  /** 多服务商与多模型配置 */
  llm?: LlmConfig;
  /** 当前活跃工作区根路径（与 activeWorkspaceId 对应，兼容旧字段） */
  workspace: string;
  /** 已打开的工作区列表 */
  workspaces: WorkspaceInfo[];
  closedWorkspaces?: WorkspaceInfo[];
  /** 当前活跃工作区 id */
  activeWorkspaceId: string;
  /** Absolute application-managed worktree storage root; unset uses the host default. */
  worktreeStorageRoot?: string;
  defaultRuntime: AgentRuntimeKey;
  /** 仅三端 key；不可新增其它 runtime */
  runtimeOverrides: Partial<Record<AgentRuntimeKey, RuntimeOverride>>;
  /** Pi 调度侧 MCP（用户级；同步到 ~/.pi/agent/mcp.json 的是用户+当前工作区合并结果） */
  mcp: McpConfig;
  /**
   * 工作区级 MCP 服务器（workspaceId → 列表）。仅该工作区生效；同名覆盖用户级。
   */
  mcpByWorkspace: Record<string, McpServerConfig[]>;
  /**
   * 调度 Agent 追加 system prompt 正文（用户可编辑）。
   * 空字符串 = 使用内置默认；保存后仍会在末尾自动追加 Catalog 能力摘要。
   */
  dispatcherAppendPrompt: string;
  /**
   * 全局行为规约（Agent Rules）：用户在设置里维护的规则，注入所有 agent 面
   * （调度提示、GUI 首条输入和传统 CLI 简报）。
   * 渲染统一走 shared/agentConduct.ts；字段缺失时由 config 归一填充种子规则。
   */
  agentRules?: AgentRule[];
  /**
   * GUI 会话结束（release）时自动用 headless LLM 写工作日志摘要（journal-automation M1，
   * 归并进 memory-system-plan M-D）。默认关：LLM 调用有成本，且会话内容会发送到所选模型；
   * 模型走 textTools 的解析链（功能组默认 → 全局 active）。
   */
  journalExitSummaryEnabled?: boolean;
  /**
   * 压缩前记忆 flush（memory-refactor §6.2/决策 #8）：上下文压缩摘要前用私有对话
   * 拷贝跑静默回合，把未落盘的重要上下文写进记忆暂存。enabled 缺省 true（只在压缩
   * 触发时发生，频次低）；providerId/modelId 为 flush 专用模型，缺省跟随调度 agent
   * 当前模型，不继承会话回退链。归一：shared/memoryFlush.ts。
   */
  memoryFlush?: import('./memoryFlush').MemoryFlushConfig;
  /**
   * 专用Pi记忆会话：只在明确候选或主动记忆消息时请求模型。enabled缺省true；
   * admissionMode控制自动/观察/暂停。专用模型优先，其次工作区调度模型和全局active。
   * 旧巩固阈值仅供历史回放兼容，不控制新会话。归一：shared/memoryConsolidation.ts。
   */
  memoryConsolidation?: import('./memoryConsolidation').MemoryConsolidationConfig;
  /**
   * 上下文阈值自动压缩（第一步，仅 Pi 引擎直通）：
   * transcript 占比 ≥ ratio 时走与 /compact 同一条 session.compact 链路。
   * 能力位 CHAT_RUNTIME_CAPABILITIES.autoCompact 门控（现仅 pi）；
   * enabled 缺省 true，ratio 缺省 0.8（见 shared/autoCompact.ts）。
   */
  autoCompact?: import('./autoCompact').AutoCompactConfig;
  /**
   * GUI Worker 网络/传输中止后续作（ECONNRESET 等）：指数退避、有限次数。
   * 缺省开，maxRetries=3 / baseDelayMs=2000 / maxDelayMs=30000。
   */
  guiTurnRetry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  /**
   * 扩展动作 TOFU 信任哈希（workspaceId → extId → sha256）。
   * 本机数据，不随工作区同步；脚本内容变化（哈希不匹配）会重新要求确认。
   */
  extensionTrust?: Record<string, Record<string, string>>;
  /**
   * CLI 入站 stdio MCP 的 TOFU：用户确认写入 ~/.claude.json 等之后记下 command+args 指纹。
   * 脚本路径变化需重新确认。
   */
  inboundMcpTrust?: { fingerprint: string; confirmedAt: number; };
  /** 已禁用扩展（workspaceId → extId 列表）；禁用后不出现在顶栏/侧栏 */
  disabledExtensions?: Record<string, string[]>;
  /** 推送通知偏好：推送开关与免打扰时段（决策纯函数见 shared/notifyDecision；设置页 T1.4 接入） */
  notify?: import('./notifyDecision').NotifyPrefs;
  /** 内置浏览器（虚拟屏浏览器页）：标签恢复与 CDP 桥开关 */
  browser?: import('./browser').BrowserConfig;
  /** 证据归集（T4.4）：pty 翻转切片与 bgTasks 摘要默认开；browser 截图证据默认关（手动改 config 开启，设置页见 T4.5） */
  evidence?: import('./evidence').EvidenceConfig;
  /**
   * 当前色彩主题 id：内置 dark/light 或 userData/themes/<id>.json 自定义主题。
   * 由设置「主题外观」页即时维护，不随设置表单草稿回写。
   */
  themeId?: string;
  /**
   * 工作区独立主题（workspaceId → themeId）：该工作区激活时覆盖全局 themeId，
   * 未设置的区跟随全局。由设置「主题外观」页与 themes.activate(scope=workspace) 维护。
   */
  themeByWorkspace?: Record<string, string>;
  /** 设置 → 外观维护的主题色全局默认；工作区 accent/accentOff 为独立覆盖。 */
  workspaceAccentDefault?: import('./workspaceAccent').WorkspaceAccentDefault;
  /**
   * 快捷键用户覆盖（actionId → 序列化和弦；null = 显式解绑）。
   * 缺省键用内置默认；由设置「快捷键」页即时维护，不随设置表单草稿回写。
   */
  keybindings?: Record<string, string | null>;
  systemShortcuts?: import('./systemShortcuts').SystemShortcut[];
  /** 划词「文本工具」：内置翻译 + 用户自定义提示词功能；由设置「文本工具」页维护 */
  textTools?: TextToolsConfig;
  /**
   * Shell 环境（Windows 专属语义）：手工指定 Git Bash 路径。
   * detectGitBashPath 优先返回手工值（存在才生效，否则回落自动探测）；
   * 同时随 syncPiShellPath 同步进 ~/.pi/agent/settings.json 与 GUI 会话隔离 settings，
   * 让 pi 的 bash 工具在自定义安装盘（如 D:\Git）下也能找到 bash。
   * 由设置「Worker 终端」页 Shell 区块维护；空/缺省 = 全自动探测。
   *
   * bgShellMode：后台命令（bgtasks.shell）的 Shell 档位。'auto'（缺省，不入盘）=
   * 有 Git Bash 档优先用 Git Bash 跑命令，没有回落 profiles[0]（Windows 上即 PowerShell）；
   * 'powershell' = 强制 PowerShell（旧行为）。只影响后台任务选档，不改终端默认 shell。
   */
  shell?: { manualGitBashPath?: string; bgShellMode?: BgShellMode; };
  /**
   * 界面语言：'system' 跟随系统（zh* → 中文，其余 → 英文）。
   * 由设置「外观」页即时维护，不随设置表单草稿回写。
   */
  locale?: AppLocale;
  /**
   * 全局面板周围灯带（全局看板未读「需要你」时的流动彩光描边）。
   * 缺省开；设 false 关闭。由设置「外观」页即时维护，不随设置表单草稿回写。
   */
  globalPanelGlow?: boolean;
  /**
   * 渐变与毛玻璃：窗口背景（frameBackdrop）+ 玻璃页半透明 + 悬浮层背景模糊。
   * 缺省开；设 false 全部退回实底。由设置「外观」页即时维护，不随设置表单草稿回写。
   */
  frameEffects?: boolean;
  /**
   * 窗口背景（框底图）：模板 id + 该模板的参数（纯色浓度 / 壁纸路径与模糊暗化）。
   * 缺省角光；frameEffects 关闭时不生效。由设置「外观 → 效果」即时维护，不随设置表单草稿回写。
   */
  frameBackdrop?: import('./frameBackdrop').FrameBackdropChoice;
  /** 工作区独立背景（workspaceId → 背景）：该工作区激活时覆盖全局 frameBackdrop，未设置的跟随全局 */
  frameBackdropByWorkspace?: Record<string, import('./frameBackdrop').FrameBackdropChoice>;
  /**
   * 会话消息「用户」头像（emoji 或自定义图）。
   * 由设置「外观 → 头像」即时维护，不随设置表单草稿回写。
   * image 落盘只留 kind，像素在 userData/avatars/user.png。
   */
  userAvatar?: import('./userAvatar').UserAvatarConfig;
  /**
   * 界面字体族（oppo 默认 / misans / harmonyos / system）与字号档（compact/standard/comfortable）。
   * 由设置「外观 → 字体」即时维护；渲染层经 :root 内联变量覆盖生效（见 renderer/uiFont.ts）。
   */
  uiFont?: import('./appearanceFonts').UiFontId;
  uiFontScale?: import('./appearanceFonts').UiFontScale;
  /**
   * 触发任务 keep-awake（T3.4）：有活跃运行或临近计划时刻时用 powerSaveBlocker 阻止休眠。
   * 缺省开；设 false 关闭。
   */
  tasksKeepAwake?: boolean;
  /**
   * R2/R11：编排视图与配额预检阈值（保守默认 15 分钟）。
   * stallMs：无活动判 stalled；stallScanMs：后台扫描间隔（写 pipeline.verdict 事件）；quotaWindowMs：失败率统计窗。
   */
  pipeline?: PipelineConfig;
  /**
   * O8：调度自治回合全局闸（跨工作区 token 槽 + 租约回收）。缺省 { enabled: true,
   * cap: 4, leaseMs: 15min }；人的手动输入不经闸（只对 host 标记的自治入口生效）。
   */
  turnGate?: TurnGateUserConfig;
}

/** 编排/配额机械阈值（config.pipeline） */
export interface PipelineConfig {
  stallMs?: number;
  quotaWindowMs?: number;
  /** O6：当前回合运行超过该阈值判 slowTurn（缺省 10 分钟） */
  slowTurnMs?: number;
  /** 停滞扫描间隔（缺省 2 分钟，钳 1–5 分钟） */
  stallScanMs?: number;
}

/** 设置「能力」页：Catalog + 调度提示词预览 */
export interface CapabilitiesView {
  catalog: CapabilityCatalogInfo;
  workerToolAllowlist: string[];
  /**
   * A3 注入注册表快照（main/agent/injection-registry.ts 登记的全部现役注入点）。
   * 结构内联定义避免 shared → main 层级依赖；字段口径见该文件 InjectionSource。
   */
  injections: Array<{
    id: string;
    target: 'scheduler' | 'worker' | 'both';
    channel: 'system' | 'tool-schema' | 'turn-prefix' | 'tool-result' | 'event-wake' | 'host-md' | 'compact';
    mode: 'always' | 'conditional';
    survivesCompact: boolean;
    note: string;
  }>;
  dispatcher: {
    /** 当前生效的正文（自定义或默认，已代入 shell/mcp） */
    body: string;
    /** 内置默认正文（供「恢复默认」） */
    defaultBody: string;
    /** 配置里存的自定义正文；空表示用默认 */
    customBody: string;
    isCustom: boolean;
    /** 始终追加的 Catalog 附录 */
    catalogAppendix: string;
    /** body + appendix，即真正交给 Pi 的 appendSystemPrompt */
    fullPreview: string;
    /** 初始化说明（给人看） */
    initNotes: string[];
  };
}


// ---------- IPC 事件负载 ----------

export interface PtyDataEvent {
  sessionId: string;
  data: string;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number;
}

export interface ConfirmRequest {
  requestId: string;
  title: string;
  detail: string;
  desktopEvidence?: import('./confirmDialog').DesktopEvidencePreview;
  /** CLI 入站 MCP 写引擎配置的 TOFU 审查 */
  inboundMcpReview?: import('./inboundMcp').InboundMcpReview;
  /** 危险工具确认：禁用遮罩点击关闭（仍可用 Esc / 取消 / ×） */
  dangerous?: boolean;
  /** 副标题：工作区 · 会话（调度/Worker）· 工具名 */
  subtitle?: string;
  /** 一句话意图（人话） */
  intent?: string;
  /** 参数人话摘要 */
  summary?: string;
  /** 调用方 confirmNote/reason */
  confirmNote?: string;
  /** 模型向工具描述，折叠进详情 */
  toolDescription?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 权限选项门（B2）：四态 kind + always 作用域 + freeText + 结构化预览 */
  permission?: import('./permissionOption').PermissionGateOptions;
}

export interface AgentTokenEvent {
  messageId: string;
  token: string;
  /** 本段在 assistant.parts 中的下标；缺省表示消息未启用 parts 模型 */
  partIndex?: number;
  workspaceId?: string;
  /** Renderer live cursor assigned by the orchestrator event bus. */
  eventSeq?: number;
}

/** 思维链增量（与 AgentTokenEvent 同构） */
export interface AgentThinkingEvent {
  messageId: string;
  token: string;
  /** 本段在 assistant.parts 中的下标；缺省表示消息未启用 parts 模型 */
  partIndex?: number;
  workspaceId?: string;
  eventSeq?: number;
}

export interface AgentToolEvent {
  messageId: string;
  toolCall: ToolCallRecord;
  workspaceId?: string;
  eventSeq?: number;
}

export interface AgentDoneEvent {
  message: ChatMessage;
  workspaceId?: string;
  /** true：本回合结束后还有排队消息，主进程会立即续发下一轮（UI 保持 busy） */
  queuedNext?: boolean;
  eventSeq?: number;
}

export interface AgentHistoryEvent {
  workspaceId: string;
  messages: ChatMessage[];
  /** Tail-window cursor. Omitted by legacy/full-history test or external events. */
  before?: number;
  total?: number;
  hasEarlier?: boolean;
  /** Workspace live cursor assigned by the orchestrator event bus. */
  eventSeq?: number;
}

/** D1 注入度量：恒注入分段构成（字符数 + UTF-8 字节数） */
export interface InjectionSegmentMetric {
  /** 段名：stable=正文+全局规约（会话内字节不变）；catalog（A2 概念名 dynamic）=Catalog 附录（A6 瘦身后=白名单全文条目+查询指引，恒排尾） */
  name: string;
  chars: number;
  bytes: number;
}

/** 调度 Agent 会话框底部：当前模型 + 上下文占用 */
export interface AgentContextStatus {
  workerRoutingScope?: import('./workerRouting').WorkerRoutingScope;
  modelId: string;
  modelName: string;
  provider?: string;
  /** 估算占用 token；未知（如刚 compaction）为 null */
  tokens: number | null;
  contextWindow: number | null;
  /** 相对 contextWindow 的百分比；tokens 未知时为 null */
  percent: number | null;
  /** 当前生效模型是否支持图片输入（显式 multimodal / id 推断） */
  supportsImages?: boolean;
  /**
   * 调度面思考档（工作区级）。level=null 跟随默认；
   * levels 是当前模型由 Pi 声明的产品档，缺省表示档位尚不可确定。
   */
  thinking?: { level: string | null; available: boolean; levels?: string[] };
  /** 会话累计缓存 token（pi getSessionStats 聚合，D1 缓存度量；SDK 版本相关，缺席/未知为 null） */
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  /** 当前调度恒注入构成（stable/catalog 分段，D1 注入度量；仅调度面快照携带） */
  injection?: InjectionSegmentMetric[];
}

export interface AgentContextEvent extends AgentContextStatus {
  workspaceId?: string;
}

// ---------- Git 面板 ----------

/** Repository identity without a status query; never implies clean/dirty. */
export interface GitRepoLocation {
  path: string;
  name: string;
  /** Logical list membership; rootId is absent for external/task worktrees. */
  workspaceId?: string;
  rootId?: string;
  /** Confirmed by Git/session registration, independent of directory spelling. */
  worktree?: boolean;
}

/** workspace 下扫到的仓库摘要（列表用） */
export interface GitRepoSummary extends GitRepoLocation {
  /** Absent until status is known, or after a failed status read. */
  dirty?: boolean;
  branch?: string;
  ahead?: number;
  behind?: number;
  /** 最近活动时间（.git/HEAD·index 等 mtime），用于「最近修改」排序 */
  lastModifiedMs?: number;
}

export interface GitRepoDiscoveryIssue {
  workspaceId: string;
  rootId?: string;
  rootPath: string;
  path: string;
  message: string;
  code?: string;
}

/** Partial results preserve accessible sources; issues are bounded for IPC. */
export interface GitRepoListResult {
  workspaceId: string;
  rootsRevision: number;
  repos: GitRepoSummary[];
  issues: GitRepoDiscoveryIssue[];
  issueCount: number;
}

export interface GitRepoLocationListResult {
  workspaceId: string;
  rootsRevision: number;
  repos: GitRepoLocation[];
  issues: GitRepoDiscoveryIssue[];
  issueCount: number;
}

export interface GitAddRepoResult {
  ok: boolean;
  path?: string;
  message?: string;
}

/** 与 commit-graph 库 Commit 形状对齐 */
export interface GitGraphCommit {
  sha: string;
  commit: {
    author: {
      name: string;
      date: string;
      email?: string;
    };
    message: string;
  };
  parents: { sha: string; }[];
}

export interface GitGraphBranch {
  name: string;
  commit: { sha: string; };
}

export interface GitLogPage {
  commits: GitGraphCommit[];
  branchHeads: GitGraphBranch[];
  hasMore: boolean;
}

export interface GitCommitFile {
  path: string;
  /** A/M/D/R/C 等；rename 时 path 为新路径 */
  status: string;
  oldPath?: string;
}

export interface GitCommitFilesResult {
  sha: string;
  files: GitCommitFile[];
}

export interface GitCommitDiffResult {
  sha: string;
  path: string;
  diff: string;
}

export interface GitBranchInfo {
  name: string;
  /** 完整 ref，如 remotes/origin/main */
  ref: string;
  current?: boolean;
  /** 远程短名，如 origin/main；本地为空 */
  remote?: string;
}

export interface GitBranchList {
  current: string | null;
  local: GitBranchInfo[];
  remote: GitBranchInfo[];
}

/** 有未提交变更时的处理 */
export type GitCheckoutStashMode = 'none' | 'stash' | 'stash-reapply';

export interface GitCheckoutRequest {
  /** 本地分支名，或要从远程检出的本地名 */
  name: string;
  /** 若从远程检出：如 origin/feature */
  startPoint?: string;
  /** 是否新建本地分支（create 或 remote checkout -b） */
  create?: boolean;
  stashMode?: GitCheckoutStashMode;
}

/** 单文件变更（对齐 git status porcelain） */
export interface GitFileChange {
  path: string;
  /** index 区状态字符，如 M/A/D/R/ 空格 */
  index: string;
  /** 工作区状态字符 */
  working_dir: string;
}

export interface GitRepoStatus {
  branch: string;
  tracking: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  /** Last explicit remote check for this branch/upstream; process-local facts. */
  remoteCheck?: GitRemoteCheck;
}

export interface GitRemoteCheck {
  attemptedAt: number;
  checkedAt?: number;
  error?: string;
}

export type GitDiscardMode = 'unstaged' | 'all';

export interface GitDiffResult {
  /** unified diff 文本；无变更时为空串 */
  diff: string;
  /** 是否暂存区 diff */
  staged: boolean;
  path: string;
}

export interface GitActionResult {
  ok: boolean;
  message?: string;
  /** Some steps completed, but manual recovery is required. */
  warning?: boolean;
  stashRef?: string;
  conflicts?: string[];
  remote?: { completedAt: number; destination?: string; targets?: string[]; unchanged?: boolean };
}

// ---------- Worktree（P3.5 轻量版）----------

/** `git worktree list --porcelain` 条目（首条为主 worktree） */
export interface GitWorktreeInfo {
  path: string;
  head?: string;
  /** 短分支名（refs/heads/ 前缀已剥） */
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  /** 主 worktree（列表首条） */
  main?: boolean;
}

export interface GitWorktreeAddArgs {
  /** worktree 目录名（放在应用管理根的工作区/仓库分组下） */
  dirName: string;
  /** 新建分支名（isolate 用 ao/<sessionId> 命名空间）；与 branch 二选一 */
  newBranch?: string;
  /** 直接检出的已有分支 */
  branch?: string;
  /** 起点 ref（缺省 HEAD） */
  baseRef?: string;
  /** 建后执行的项目级 provisioning 命令 */
  provisionCommands?: string[];
}

export interface GitWorktreeAddResult {
  ok: boolean;
  path?: string;
  branch?: string;
  /** 实际作为起点的 ref（新建分支时缺省 HEAD），供溯源/展示 */
  baseBranch?: string;
  message?: string;
  source?: { mainRepo: string; commonDir: string; };
}

/**
 * R-18b 多仓隔离组的嵌套仓记账：主仓相对路径 + 该仓分支（与主仓同名 ao/<id8>，
 * 注册在嵌套仓自身 .git）+ 建树起点分支（该仓对称合入 target）。
 */
export interface WorktreeRepoRef {
  /** 主仓相对 posix 路径（如 Plugins/Foo） */
  path: string;
  /** 该仓隔离分支名（ao/<id8>） */
  branch: string;
  /** 建树时实际起点分支（该仓「从哪建回哪」；detached 无名时缺省） */
  baseBranch?: string;
  kind?: 'independent' | 'submodule';
  /** Exact starting commit, including the superproject's pinned gitlink. */
  baseCommit?: string;
}

/** A repository group preserves its own nested layout and source identity. */
export interface SessionWorktreeGroup {
  id: string;
  path: string;
  /** Missing only for old records whose source identity has not been recovered. */
  sourceRoot?: SessionMeta['sourceRoot'];
  source?: SessionMeta['worktreeSource'];
  branch?: string;
  baseBranch?: string;
  /** Exact creation baseline; the named target branch can advance independently. */
  baseCommit?: string;
  repos: WorktreeRepoRef[];
  /** Saved results allow later groups to fail without forgetting completed merges. */
  integration?: SessionWorktreeRepoResult[];
  /** Durable cleanup evidence; live registration/ref checks still govern every retry. */
  cleanup?: SessionWorktreeRepoCleanupResult[];
}

export interface SessionWorktreeRepoCleanupResult {
  repo: string;
  branch: string;
  status: 'not-started' | 'retained' | 'removed';
  treeRemoved: boolean;
  branchRemoved: boolean;
  target?: string;
  headCommit?: string;
  commonDir?: string;
  message?: string;
}

export interface SessionWorktreeRepoResult extends Omit<GitRepoIntegrateEntry, 'status'> {
  status: GitRepoIntegrateEntry['status'] | 'not-started';
  /** Diagnostic evidence only; retries verify live Git ancestry. */
  headCommit?: string;
  targetCommit?: string;
  /** Actual successful merge HEAD; used to attribute later parent gitlink changes. */
  mergedCommit?: string;
  warnings?: string[];
  gates?: GitMergeIsolateResult['gates'];
}

/** Repository labels are relative to this group, never task-wide unique keys. */
export interface SessionWorktreeGroupIntegrationResult {
  groupId: string;
  rootId: string;
  path: string;
  repos: SessionWorktreeRepoResult[];
}

export interface SessionWorktreeGroups {
  version: 1;
  /** New tasks retain their source cwd; absence preserves legacy tree-cwd behavior. */
  cwdPolicy?: 'source';
  revision?: number;
  /** Explicit borrowers share mappings without acquiring cleanup ownership. */
  borrowedFrom?: string;
  /** A stable identity, independent of collection order and default source folder. */
  primaryGroupId: string;
  groups: SessionWorktreeGroup[];
  /** Selected overlapping roots still pin provenance even when containers are deduplicated. */
  sourceRoots?: NonNullable<SessionMeta['sourceRoot']>[];
}

/** Rooted repository selection; relativePath is a repository location within that root. */
export interface WorkspaceWorktreeGroupSelection {
  rootId: string;
  relativePath: string;
  repoSet?: string[];
}

/** 嵌套仓健全性失败原因：缺 HEAD 会让 git 向上回退到主仓；对象丢失会让 worktree add 炸整组 */
export type NestedRepoUnhealthyReason = 'missing-head' | 'lost-objects' | 'missing-directory' | 'identity-changed';

/** 发现阶段跳过的残缺嵌套仓（不进 repoSet，告警后人修或删） */
export interface NestedRepoSkipInfo {
  /** 主仓相对 posix 路径 */
  path: string;
  reason: NestedRepoUnhealthyReason;
  /** 日志用细节（git stderr / 文件症状）；给用户的症状走 i18n 映射 */
  detail: string;
}

/** addSessionWorktreeGroup 结果：主仓容器根 + 嵌套仓清单 */
export interface GitWorktreeAddGroupResult extends GitWorktreeAddResult {
  /** 嵌套仓建组结果（主仓内无嵌套仓=空数组；失败时无意义） */
  repos?: WorktreeRepoRef[];
  /** 扫描到但不健全、已跳过的嵌套仓（部分残缺时仍建组；全残缺走 ok:false） */
  skippedNestedRepos?: NestedRepoSkipInfo[];
  /** A failed creation can retain a changed/locked tree or a branch; never hide it. */
  creationResiduals?: GitWorktreeCreationResidual[];
}

export interface GitWorktreeCreationResidual {
  path: string;
  mainRepo: string;
  branch: string;
  treeRemoved: boolean;
  message: string;
}

/** R-18b 组级合入（sessions.integrate）逐仓结果；repo='' 为主仓，否则主仓相对路径 */
export interface GitRepoIntegrateEntry {
  repo: string;
  branch: string;
  target?: string;
  status: 'merged' | 'already-merged' | 'skipped-unchanged' | 'failed' | 'blocked';
  message?: string;
  conflicts?: string[];
}

/** 删除已合入本地分支的结果；unmerged=true 表示分支仍有未合入提交而保留 */
export interface GitDeleteBranchResult {
  ok: boolean;
  unmerged?: boolean;
  message?: string;
}

/** sessions.integrate / mergeIsolate 可选策略（默认：允许快进、校验闸告警不回滚） */
export interface MergeIsolateOptions {
  /** 合入提交说明；省略则 git 默认 merge 文案（noFf 时宿主生成「合入 branch 到 target」） */
  message?: string;
  /** true 时 `git merge --no-ff`。默认 false（允许快进）；是否改默认见待决策 */
  noFf?: boolean;
  /** 主仓脏文件与待合入重叠时先存私有 Git 快照再合、成功后按 ref 恢复。默认 false */
  stashMain?: boolean;
  /** 跳过合入后 npm install（即使 package.json/lock 变了） */
  skipNpmInstall?: boolean;
  /** 跳过合入后 typecheck 闸 */
  skipTypecheck?: boolean;
  /** 校验闸失败：warn=合入成功仅告警（默认）；abort=reset --hard ORIG_HEAD */
  onGateFail?: 'warn' | 'abort';
}

/** 隔离 worktree 合入主仓结果（宿主从主仓执行，不在 worktree cwd 里删自己） */
export interface GitMergeIsolateResult {
  ok: boolean;
  mergedCommit?: string;
  /** 合入的目标分支（main/master 等） */
  target?: string;
  /** 合入的来源分支（ao/<id>） */
  branch?: string;
  alreadyMerged?: boolean;
  /** 冲突文件清单（合入失败时尽力收集；abort 已执行——stashMain 恢复失败时改动保留在私有 ref，message 会说明） */
  conflicts?: string[];
  /** 冲突分级：journal 等机械 vs 需人裁定 */
  conflictClass?: { mechanical: string[]; judgment: string[]; };
  /** 需裁定文件在两侧的调用点（git grep，尽力） */
  callSites?: { file: string; hits: string[]; }[];
  blockReason?: 'dirty-worktree' | 'dirty-overlap' | 'conflict' | 'gate-failed';
  dirtyOverlap?: string[];
  warnings?: string[];
  gates?: {
    npmInstall?: 'ok' | 'skipped' | 'failed';
    typecheck?: 'ok' | 'skipped' | 'failed';
    /** 仓库自带的 pre-merge-commit 钩子拒绝了合并提交（已 abort） */
    mergeHook?: 'failed';
  };
  message: string;
}

// ---------- Hunk 级原子采纳（T5.5）----------

/** hunk 键：unified diff `@@` 头四元组 + 文件路径（b/ 侧，与渲染层 react-diff-view 的 hunk 元数据同源） */
export interface GitAdoptHunkKey {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** 部分采纳预览：worktree 相对 merge-base 的完整 diff（含未提交/未跟踪改动） */
export interface GitAdoptPreviewResult {
  ok: boolean;
  /** 采纳目标（主仓绝对路径） */
  targetRepo?: string;
  /** diff 基（merge-base sha） */
  base?: string;
  /** unified diff 文本（--binary，供渲染层 parseDiff 出 hunk 勾选） */
  diff?: string;
  message?: string;
}

/** 勾选 hunk 原子采纳到主仓：默认 staged 不 commit，永不半应用 */
export interface GitAdoptHunksResult {
  ok: boolean;
  targetRepo?: string;
  base?: string;
  /** 实际落地的文件（相对主仓） */
  files?: string[];
  message: string;
}

/** 渲染层经 IPC 寄任务邮件（T1.7 diff 评论回注）；失败不 throw */
export type SessionMessageIpcResult =
  | ({ ok: true; stored: true; receipt: 'stored'; sessionId: string; messageId: string; read: boolean; readAt?: number;
      name?: string; runtime?: string } & import('./agentMessage').MailSendWakeReceipt)
  | { ok: false; message: string; };
