import type { AgentRuntimeKey } from './types';

export const META_AGENT_DIR = '.muster';
export const META_AGENT_PRODUCT = 'muster-console';
export const META_AGENT_SCHEMA_VERSION = 1;
/** GUI Worker 用户工具规则（相对 .muster） */
export const META_AGENT_TOOL_RULES = 'tool-rules.json';
export const META_AGENT_MANAGED_EXT_MARKER = 'x-muster-managed: daily-report';

/** `.muster/workspace.json` — 可同步项目偏好 + 面板布局 */
export interface WorkspaceFileConfig {
  /** 任意已注册 runtime id（运行时以 registry 为准，不写死开箱三端） */
  defaultRuntime?: AgentRuntimeKey;
  /**
   * 工作区级 GUI/CLI coding worker 并发预算（R7）。
   * 省略=5；0=不限制。超预算时 sessions.create 入队，空位后自动出队拉起。
   */
  maxConcurrentWorkers?: number;
  sideToolsTab?: string;
  filesTreeOpen?: boolean;
  /** Unified content tabs and project Pins, with optional bookmark fields for legacy migration. */
  rightWorkspace?: import('./rightWorkspace').RightWorkspaceSaved;
  hVirtualScreen?: boolean;
  /** 旧版虚拟屏页位，供本机页位偏好缺省时读取。 */
  hDock?: 'terminal' | 'git';
  /** 横向虚拟屏两主态页占比（长按出钮左右拖跟手调节，各自独立持久化） */
  hTerminalRatio?: number;
  hGitRatio?: number;
  /** Files 面板：文件树（primary）vs 编辑器分割比；松手再写 */
  filesSplitRatio?: number;
  /** 专注模式：藏左栏会话列，会话与 Git 页并肩恒满全宽（虚拟屏临时退出，退出专注恢复） */
  focusMode?: boolean;
  /** 专注模式会话侧占比（中段把手长按拖跟手调节，两侧之和恒为全宽） */
  focusRatio?: number;
  /** 左栏（会话列）像素宽：拖左栏右缘分隔手柄调节，占中栏宽度、总页宽不变 */
  leftColumnWidth?: number;
  /** 中央区分屏方向（最近一次分屏）：新建分屏时复用，按工作区记忆 */
  centerSplitDir?: 'row' | 'col';
  /** 中央区分屏比例（pane0 占比）：新建分屏时复用，按工作区记忆 */
  centerSplitRatio?: number;
  git?: {
    selectedRepo?: string | null;
    pinnedRepos?: string[];
    hiddenRepos?: string[];
    repoListOpen?: boolean;
    /** 显示已隐藏仓：exclude / include / only */
    hiddenView?: 'exclude' | 'include' | 'only';
    /** 仓列表（primary）vs 详情分割比；松手再写 */
    repoListSplitRatio?: number;
    repoSort?: string;
    /** Git 面板跟随会话：切会话时自动把 selectedRepo 切到该会话的 worktree（默认关） */
    followSessionRepo?: boolean;
    /** worktree 建后执行的 provisioning 命令（项目级配置；在 worktree cwd 依次执行） */
    worktreeProvisionCommands?: string[];
    /** Rooted per-repository recipes; execute after every selected task tree exists. */
    worktreeRepoProvisionCommands?: import('./worktreePreparation').WorktreeRepoPreparation[];
    /** Source coordinates excluded from automatic nested isolation; explicit selection overrides. */
    worktreeIsolationExclusions?: import('./worktreePreparation').WorktreeRepoExclusion[];
  };
}

export function defaultWorkspaceFileConfig(): WorkspaceFileConfig {
  return {
    sideToolsTab: 'files',
    filesTreeOpen: true,
    hVirtualScreen: false,
    filesSplitRatio: 0.28,
    focusMode: false,
    git: {
      selectedRepo: null,
      pinnedRepos: [],
      hiddenRepos: [],
      hiddenView: 'exclude',
      repoListOpen: true,
      repoListSplitRatio: 0.28,
      repoSort: 'name',
      followSessionRepo: false,
      worktreeProvisionCommands: [],
      worktreeRepoProvisionCommands: [],
      worktreeIsolationExclusions: []
    }
  };
}

/** IPC `workspaceFile:get` and `workspaceFile:get-for-workspace` */
export interface WorkspaceFileGetResult {
  workspaceId: string;
  config: WorkspaceFileConfig;
}

/** IPC `workspaceFile:patch` — stale 时不写盘 */
export type WorkspaceFilePatchResult =
  | { ok: true; workspaceId: string; config: WorkspaceFileConfig }
  | { ok: false; stale: true };
