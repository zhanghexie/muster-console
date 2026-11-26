export type {
  AgentRuntimeEntry,
  AgentRuntimeKey
} from '../../shared/types';

/**
 * 首条任务简报怎么进模型（可选导出，缺省 'initial-prompt'）。
 *
 * 派活主路径据此分流，不允许再按 runtime id 写 if（见
 * docs/superpowers/plans/2026-08-15-agent-runtime-registry.md 的全局约束）。
 *
 * - `initial-prompt`：首次 spawn 就把简报作为 CLI 初始 prompt 带上。
 *   CLI 不导出 appendPrompt 或返回 false 时，宿主自动回落到 TTY 键入。
 * - `relaunch-resume`：先空拉起、再 kill + resume 时带 prompt。
 *   给 allocate 较慢的 CLI 用——它的空 spawn 会盖掉带 prompt 的进程。
 */
export type RuntimeInjectStrategy = 'initial-prompt' | 'relaunch-resume';

type TerminalResumeStatus = 'attempt' | 'unbound' | 'missing' | 'unsupported';
export type TerminalResumeCheck = { status: TerminalResumeStatus } | { status: 'failed'; detail: string };
type TerminalResumeInput = { cwd: string; sessionId: string; extraArgs: string[] };

/** Optional additive CLI flag. Absence preserves cwd-only custom scripts. */
export interface RuntimeWorkspaceDirectories {
  flag: string;
  note: string;
  maxExtraDirectories?: number;
  /** A CLI which splits comma-separated values cannot represent a literal comma path. */
  rejectCommas?: boolean;
}

export interface RuntimeModule {
  /** Read-only confirmation captured before a fallback interrupt, bound to this native session. */
  prepareInterrupt?(input: { cwd: string; sessionId: string }): Promise<() => Promise<boolean>>;
  /** Optional native channel for this TUI integration, including dynamically registered runtimes.
   * Must bind the supplied session; unsupported means definitely not submitted.
   * An exception/timeout is uncertain and must not fall through to keyboard input. */
  receiveMessage?(input: import('../../shared/runtimeCommunication').RuntimeMessage & {
    sessionId: string;
    hostSessionId: string;
    cwd: string;
    signal: AbortSignal;
    isCurrent(): boolean;
  }): Promise<import('../../shared/runtimeCommunication').RuntimeDeliveryResult>;
  workspaceDirectories?(): RuntimeWorkspaceDirectories;
  allocate(ctx: { cwd: string }): Promise<{ sessionId: string }>;
  resolveLaunch(ctx: {
    mode: 'start' | 'resume' | 'fork';
    /** Explicit request to replace a PTY's conversation using its start configuration. */
    newConversation?: boolean;
    sessionId: string;
    cwd: string;
    /** The host verified cwd is the task's isolated checkout. */
    isolatedWorktree?: boolean;
    extraArgs: string[];
    forkFromSessionId?: string;
    /** Availability checks must have no process, port or file side effects. */
    probe?: boolean;
    /** Absolute executable selected by the built-in runtime's discovery adapter. */
    executable?: string;
    WebSocket?: typeof import('ws');
    /** Trusted environment of this host session, also needed by owned backend processes. */
    env?: Record<string, string>;
    /** Validated per-session options for transports which cannot express them as CLI flags. */
    cliLaunchOptions?: import('../../shared/cliLaunchOptions').CliLaunchOptions;
  }): RuntimeLaunch | Promise<RuntimeLaunch>;
  appendPrompt?(ctx: { prompt: string; extraArgs: string[] }): boolean;
  checkResume?(ctx: TerminalResumeInput): TerminalResumeStatus | Promise<TerminalResumeStatus>;
  canResume?(ctx: TerminalResumeInput): boolean | Promise<boolean>;
  injectStrategy?(): RuntimeInjectStrategy;
  /**
   * TUI 输入框支持 bracketed paste（ESC[200~…ESC[201~）时声明 true：
   * TTY 键入回落后宿主改用粘贴注入——文本原子进框、单次 Enter，不丢字、不残留空行。
   * 实测（2026-09-04）：opentui（opencode）支持；ConPTY 下 Ink 系（claude/cursor）paste
   * 无效，勿声明。未声明时维持逐字键入 + 多次 Enter 兜底。
   */
  pasteInput?(): boolean;
  /** Only used when native priority delivery is unsupported; never proves stopped. */
  interruptInput?(): string;
  /** P2：allocate 时在 cwd 装状态 hooks（可选导出） */
  ensureDetectHooks?(ctx: { cwd: string }): { file: string; events: string[] };
  /** P2：卸载本 runtime 装的状态 hooks（只删带 muster-hook-v1 标记的条目） */
  uninstallDetectHooks?(ctx: { cwd: string }): { file: string; removed: number };
}

export interface RuntimeLaunch {
  /** Optional busy-turn preemption; ordinary CLI input does not require a declaration. */
  deliveryCapabilities?: import('../agentSession/delivery').DeliveryCapabilities;
  command: string;
  args: string[];
  env?: Record<string, string>;
  windowsVerbatimArguments?: boolean;
  externalSessionId?: string;
  warning?: string;
  receiveMessage?: RuntimeModule['receiveMessage'];
  /** Idempotent; called on superseded preparation, spawn failure and actual PTY disposal. */
  dispose?(): void;
  /** Engine-created IDs (for example a TUI's new thread) replace provisional handles. */
  onSessionId?(listener: (sessionId: string) => void): () => void;
  onActivity?(listener: (kind: 'active' | 'idle', event: string) => void): () => void;
  interruptInput?: string;
  prepareInterrupt?: RuntimeModule['prepareInterrupt'];
  /** Owned backend roots outside the PTY ancestry; bind inbound MCP before starting the TUI. */
  processIds?: number[];
}
