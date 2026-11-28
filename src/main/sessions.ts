import { userDataStorage } from './runtimeKernel/storageRootResolver';
import { attachTaskWorktrees } from './git/worktreeAttach';
import { randomUUID } from 'node:crypto';
import { sessionSubtreePostOrder } from '../shared/sessionTree';
import {
  archiveAffectedSessions, NativeSessionHistoryError, sessionMayInterrupt, type NativeSessionHistoryAction,
  type NativeSessionHistoryTarget, type SessionDeleteOptions, type SessionDeletePreview
} from '../shared/sessionLifecycle';
import type { SafetyGitEvidence } from '../shared/safety';
import { createSafetyGitEvidenceCollector, type GitEvidenceContents } from './safety/evidence';
import { resolveRepoIdentity } from './git/repoIdentity';
import { pathKey } from './pathKey';
import { deriveAutoSessionName } from '../shared/sessionAutoName';
import { cliArgsForSession, effectiveCliLaunchOptions } from '../shared/cliLaunchOptions';
import { buildHostIntro } from '../shared/workerBrief';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import type {
  AgentLifecycle,
  GuiThinkingLevel,
  GuiWorkerMode,
  LiveStatus,
  PromptTask,
  SessionMeta,
  TerminalRestartIntent,
  SessionPhase,
  SessionPhaseKind,
  StructuredActivityKind,
  GitMergeIsolateResult,
  GitRepoIntegrateEntry
} from '../shared/types';
import { formatNotifyText, isShellProfileId, runtimeSurface } from '../shared/types';
import { historicalServiceRuntime } from '../shared/retiredServiceRuntimes';
import { usesTaskWorktreeLifecycle, assertSingleWorktreeGroup, clearSessionWorktreeMetadata, hasRegisteredWorktreeCleanupIdentity, normalizeSessionWorktrees, sessionWorktreeGroups, transferSessionWorktrees } from '../shared/sessionWorktrees';
import { cleanupTaskWorktrees } from './git/worktreeTaskCleanup';
import { assertTaskWorktreeOperationIdle, beginTaskWorktreeOperation, taskWorktreeOwnership } from './git/worktreeTaskOperation';
import { worktreeSessionReferences } from './storage/sessionDependencies';
import {
  appendAcceptanceLog,
  type ReviewDecision
} from '../shared/boardReview';
import type { IntegrateApproval } from '../shared/integrateApproval';
import type { Store } from './store';
import type { ConfigManager } from './config';
import { resolveLlmConfig } from './config';
import type { PtyManager } from './pty/manager';
import type { NotifyStore } from './notify/store';
import { SessionPersister } from './sessions/persister';
import {
  createAgentTerminalSession,
  createShellTerminalSession
} from './sessions/createTerminal';
import { assertSessionTargetCurrent, legacySessionSourceRoot, legacySessionWorkspaceId, registeredWorktreeGroup, registeredWorktreeSession, resolveSessionTarget } from './sessions/targets';
import type { CreateTerminalFlowCtx, CreateTerminalOptions } from './sessions/createTerminal';
import type { RuntimeAwarenessStore } from './awareness/store';
import type { RuntimeFact } from '../shared/runtimeFacts';
import { projectSessionFacts, type SessionFactInput } from '../shared/runtimeFactsQuery';
import { sweepHandoverFiles } from './persistenceSweeps';
import { deleteSessionHandover, sweepOrphanHandovers } from './handover/paths';
import { purgeEndedSessionReminders, purgeSessionReminders } from './sessionReminders/service';
import { recoverWorkerRouteAfterRestart } from '../shared/workerRouting';
import { releaseThenCleanup } from './sessions/releaseThenCleanup';
import { GuiSessionDataCleanupError } from './agentSession/cleanupError';
import { holdPendingSource } from './workspaceRootUses';
import { normalizeWorktreeGroupSelections } from './git/worktreeTaskCreate';
import { captureWorktreeSelectionSources, assertWorktreeSelectionSources } from './git/worktreeSelectionSources';
import { beginCliWorkspaceContext, getCliWorkspaceContext, type CliWorkspaceContext } from './sessions/cliWorkspaceContext';
import { assertWorkspaceExecutionContextCurrent, assertWorktreeExecutionCurrent, usesCodexWorktreeCwd } from './workspaceExecutionContext';
import { renderWorkerDirectoryScope } from '../shared/workspaceExecutionContext';
import {
  cleanupSessionWorktreeOnArchive,
  cleanupSessionWorktreeOnClose,
  discardSessionWorktree,
  healMissingSessionWorktree,
  resolveSessionMainRepo,
  type SessionWorktreeCtx
} from './git/worktreeSessionOps';
import {
  integrateSessionWorktree,
  type IntegrateWorktreeOpts,
  type SessionIntegrateCtx
} from './git/worktreeIntegrate';
import { nextPtyLifecycle, nextSessionActivity } from '../shared/sessionActivity';
import { migrateOrchestratedFlag } from '../shared/orchestratorGuards';
import { formatInjectQueueCapsule } from '../shared/injectQueue';
import {
  hashScreenText,
  SCREEN_CLASSIFY_MAX_CHARS,
  SCREEN_CLASSIFY_MIN_INTERVAL_MS,
  shouldScreenClassify,
  shouldScreenClassifyCheap
} from '../shared/screenClassify';
import { plainTextFromPtyBuffer } from './detect/stripAnsi';
import { classifyTerminalScreen } from './sessions/screenClassifyLlm';
import type { RuntimeHost } from './runtime/host';
import type { RuntimeInjectStrategy } from './runtime/types';
import type { GitService } from './git/service';
import type { UsageStatsService } from './usage/service';
import { normalizeRuntimeKey } from './runtime/registry';
import { resolveShellLaunchAsync } from './shell/profiles';
import { sleep, typeAndSubmit } from './pty/submit';
import { writeInjectPrompt, injectFileFromPromptArg, injectPromptDir } from './pty/injectFile';
import { activityClearsDonePhase, boardStatusOfSession, phaseWriteBlocked } from '../shared/boardStatus';
import type { EvidenceCollector } from './sessions/evidence';
import type { NotifyBus } from './notify/bus';
import { errorMessage } from '../shared/errors';
import { t } from '../shared/i18n';
import {
  ENDED_SESSION_REFS_MAX,
  rememberEndedSessionRef,
  toEndedSessionRef,
  type EndedSessionRef
} from '../shared/agentMessage';
import { matchFlexibleSessionId } from '../shared/sessionQuery';
import { adjacentSessionId, decideAdoptActive, decideSelectDisplay, railFirstTerminalId, sessionIdsByRail,
  type ArchiveSelectionHint } from '../shared/workspaceActiveSession';
import { notifyDelegateSlotFreed } from './tasks/delegateQueue';
import { turnChangesDir } from './turnChanges/runtime';
import { purgeTurnChangesForSessions } from './turnChanges/cleanup';
import { noteDimensionGateRed } from './orchestrator/events';
import { collectDimensionGates } from './dimensionGates/runner';
import {
  dimensionGateBadgeLabel,
  dimensionGateDetailText,
  hasRedGate,
  type DimensionGatesSnapshot
} from '../shared/dimensionGates';
import { tryEscalate } from '../shared/escalateBudget';
import {
  buildInterruptSnapshot,
  formatResumeBrief,
  INTERRUPT_SNAPSHOT_DEFAULTS,
  isInFlightForInterrupt
} from '../shared/interruptSnapshot';

/** 启动失败信息上限：完整 ANSI 终端帧可达 37 万字符，仅保留头部 + 省略标记 */
const MAX_LAUNCH_ERROR_CHARS = 2000;
/** 生命周期评估取 pty buffer 的尾部窗口（检测只看最后 12k 文本，取 16k 原始字符留足 ANSI 余量） */
const LIFECYCLE_BUFFER_TAIL_CHARS = 16_000;
/** 终端生命周期轮询间隔 */
const LIFECYCLE_POLL_MS = 500;
/** 同时在途的 LLM 读屏请求上限：per-session 去重之外再限总量，避免多会话齐发打爆配额 */
const SCREEN_CLASSIFY_MAX_CONCURRENCY = 2;
/** 读屏失败退避的封顶 */
const SCREEN_CLASSIFY_MAX_BACKOFF_MS = 10 * 60_000;
/** 简报文件的保留期：够 Worker 慢启动读到，又不至于在 userData 里长期留任务原文 */
const INJECT_FILE_TTL_MS = 15 * 60_000;
/** R-14 维度门重复触发冷却：Worker 短时间内重复报 needs_you 不重跑（红灯时例外——返工后再报必须重查） */
const DIM_GATE_COOLDOWN_MS = 20_000;
function capLaunchError(msg: string): string {
  if (msg.length <= MAX_LAUNCH_ERROR_CHARS) return msg;
  return `${msg.slice(0, MAX_LAUNCH_ERROR_CHARS)}${t('…（省略 {{n}} 字符）', { n: msg.length - MAX_LAUNCH_ERROR_CHARS })}`;
}

/** CreateTerminalOptions 拆至 sessions/createTerminal.ts；原路径 re-export 保持对外 import 不变 */
export type { CreateTerminalOptions } from './sessions/createTerminal';

type SessionServiceAgentSessions = {
  isBusy?(id: string): boolean;
  observe?(id: string): { lastReply: { text: string } | null };
  validateLaunchModel?(runtime: string, cwd: string, model: SessionMeta['modelOverride'], piModeId?: string): Promise<void>;
  probeRuntime(
    id: string,
    piModeId?: string
  ): Promise<import('./agentSession/types').GuiRuntimeProbeResult>;
};

/** GUI（chat surface）Worker 会话的宿主桥（AgentSessionHost 晚绑定注入） */
export interface ChatSessionBridge {
  /** 会话可见：加载历史、初始化板卡信号；幂等 */
  open(s: SessionMeta): void;
  /** 会话删除：释放 driver / MCP；purgeHistory 时一并删落盘聊天记录与引擎侧数据（meta 为删除前快照） */
  close(id: string, opts?: { purgeHistory?: boolean; meta?: SessionMeta }): void | Promise<void>;
  /** sessions.restartConversation（GUI）：只中止当前回合，不清历史 */
  refresh(id: string): void | Promise<void>;
  /**
   * 归档 / 合入 worktree：拆 driver 连接但保留历史。
   * 必须可 await——删 worktree 前要等 GUI 子进程释放目录锁（见 releaseThenCleanup）。
   */
  release(id: string): void | Promise<void>;
  nativeHistory?(s: Readonly<SessionMeta>): import('./agentSession/types').GuiRuntimeDriver['nativeHistory'];
}

/**
 * 会话注册表：左栏列表的唯一数据源。
 * terminal 会话背后是真 pty；scheduled 会话是定时服务在左栏的投影。
 * GUI（chat surface）runtime 的 terminal 会话没有 pty——由 AgentSessionHost 驱动。
 *
 * 预分配 CLI id / 杀 ConPTY 可能很慢：一律先改注册表并 broadcast，再后台干活，避免卡 UI。
 */
type ArchiveGuardTarget = Readonly<Pick<SessionMeta, 'id' | 'type' | 'launchKind' | 'workspaceId'>>;
type CliPromptLaunchReceipt = { mode: 'cli-prompt'; injectFile: string; promptArg: string };

export class SessionsService {
  private sessions: SessionMeta[];
  private archiveCleanupPending = new Set<string>();
  private deletingSessions = new Set<string>();
  private beforeArchiveGuards?: Set<(sessions: readonly ArchiveGuardTarget[]) => void>;

  /** Synchronous safety preflight; a failure leaves the archive batch unchanged. */
  onBeforeArchive(guard: (sessions: readonly ArchiveGuardTarget[]) => void): () => void {
    if (typeof guard !== 'function') throw new Error('Invalid archive guard');
    const guards = this.beforeArchiveGuards ??= new Set();
    guards.add(guard);
    return () => { guards.delete(guard); };
  }

  private assertArchiveAllowed(rows: readonly SessionMeta[]): void {
    const pending = rows.filter(row => !row.archived);
    if (!pending.length) return;
    const targets = Object.freeze(pending.map(row => Object.freeze({ id: row.id, type: row.type, launchKind: row.launchKind, workspaceId: row.workspaceId })));
    for (const guard of this.beforeArchiveGuards ?? []) {
      const result: unknown = guard(targets);
      if (result !== undefined) {
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(result).catch(error => console.error('[sessions] asynchronous archive guard failed:', error));
        }
        throw new Error('Archive guard must complete synchronously');
      }
    }
  }
  /** In-memory leases are replaced whenever a session is archived; never sent to a model. */
  private sessionScopeTokens?: WeakMap<SessionMeta, object>;

  sessionScopeToken(id: string): object | undefined {
    const row = this.peek(id);
    if (!row || row.archived) return undefined;
    const tokens = this.sessionScopeTokens ??= new WeakMap();
    let token = tokens.get(row);
    if (!token) { token = Object.freeze({}); tokens.set(row, token); }
    return token;
  }

  private markArchived(row: SessionMeta): void {
    this.sessionScopeTokens?.delete(row);
    row.archived = true;
    if (row.workerRouting && ['starting', 'running', 'switching'].includes(row.workerRouting.phase)) {
      row.workerRouting.phase = 'cancelled';
      const attempt = row.workerRouting.attempts.at(-1);
      if (attempt && attempt.state !== 'failed') attempt.state = 'cancelled';
    }
  }
  /** GUI 会话宿主（晚绑定）：chat runtime 预检经它探测 driver 可用性 */
  private agentSessionsRef: SessionServiceAgentSessions | null = null;
  /** index.ts 建 AgentSessionHost 后晚绑定（chat runtime 预检用；未绑定=chat 预检落 unknown，按不可用拒绝创建） */
  bindAgentSessions(h: SessionServiceAgentSessions): void {
    this.agentSessionsRef = h;
  }

  getCliWorkspaceContext(sessionId: string): CliWorkspaceContext | undefined {
    return getCliWorkspaceContext(this.config, sessionId);
  }
  activeId: string | null = null;
  /**
   * 每工作区最后选中 / 待显示的会话（仅内存）：
   * 切走时由 adoptActiveForWorkspace 记下；跨区 select / create(activate)
   * 不抢当前中栏，改为写入目标区，切回该区时再显示。
   */
  private lastActiveByWs = new Map<string, string>();
  /** 进行中的拉起任务，避免同一会话重复 allocate */
  private launchTasks = new Map<string, Promise<CliPromptLaunchReceipt | undefined>>();
  /** 拉起代数：relaunch/close 递增后，过期的 allocate 不得再 spawn */
  private launchGen = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private persister: SessionPersister;
  private readonly strictRuntimeResets = new Set<string>();
  /** 证据归集器（T4.4）：翻转切片 best-effort，未注入时零开销 */
  private evidence: EvidenceCollector | null = null;

  attachEvidence(c: EvidenceCollector | null): void {
    this.evidence = c;
  }
  /** 运行时状态流（合入事件 + 会话关闭清公示栏）；未注入时零开销 */
  private awareness: RuntimeAwarenessStore | null = null;

  attachAwareness(s: RuntimeAwarenessStore | null): void {
    this.awareness = s;
  }
  /** 传感器写入后匹配订阅并保存事件邮件；未注入时零开销 */
  private factSink: ((facts: RuntimeFact[]) => void) | null = null;

  attachFactSink(fn: ((facts: RuntimeFact[]) => void) | null): void {
    this.factSink = fn;
  }

  private emitRuntimeFacts(facts: RuntimeFact[]): void {
    if (!facts.length || !this.factSink) return;
    try {
      this.factSink(facts);
    } catch (e) {
      console.error('[sessions] fact sink failed', e);
    }
  }

  private emitSessionFactKind(
    s: SessionMeta,
    kind: 'session.phase' | 'session.note' | 'session.activity' | 'session.lifecycle'
  ): void {
    if (s.hidden || s.type !== 'terminal') return;
    const input: SessionFactInput = {
      id: s.id,
      name: s.name,
      workspaceId: s.workspaceId,
      phase: s.phase,
      note: s.liveStatus,
      activity: s.activity,
      lifecycle: s.lifecycle,
      archived: s.archived,
      worktreePath: s.worktreePath,
      worktreeBranch: s.worktreeBranch
    };
    this.emitRuntimeFacts(projectSessionFacts(input).filter((f) => f.kind === kind));
  }
  /** LLM 读屏节流状态（per session） */
  private classifyBySession = new Map<
    string,
    { lastHash?: string; lastClassifyAt?: number; nextAllowedAt?: number; cooldownMs: number }
  >();
  /** 在途 LLM 读屏的会话 id：以前是全局布尔，一个会话读屏会把其它会话全挡住 */
  private classifyInFlight = new Set<string>();
  private readonly monitorController = new AbortController();
  private readonly monitorTasks = new Set<Promise<void>>();
  /** R-14：在途维度门会话 id（防同一 needs_you 上报并发重跑） */
  private dimGateInFlight = new Set<string>();
  /** R-14：会话最近一次维度门跑时刻（冷却去重；红灯时冷却不生效——返工再报必须重查） */
  private dimGateLastRunAt = new Map<string, number>();
  /**
   * O6：pty 会话最近一次 lifecycle→working 的翻转时刻（working 中才有值；翻出 working 清）。
   * 内存即可（重启归零合理）——sessions.observe 的 activeTurnMs 据此算（GUI 会话走
   * AgentSessionHost.getActiveTurnStartedAt，两条源互斥：chat runtime 不跑 pty）。
   */
  private ptyWorkingSince = new Map<string, number>();
  private lifecycleListeners: Array<
    (s: SessionMeta, prev: AgentLifecycle | undefined, next: AgentLifecycle) => void
  > = [];
  /**
   * phase 翻转监听（子代理完成通知等）。phase 是「交付状态」（done/needs_you/working），
   * 与 lifecycle（working/idle/exited，进程活跃度）是两套轴——子代理报 done 是
   * 明确宣告收尾，比等 lifecycle 回 idle 更早更准，故需要独立钩子。
   */
  private phaseListeners: Array<
    (s: SessionMeta, next: SessionPhaseKind, prev: SessionPhaseKind | undefined) => void
  > = [];
  /** 会话被移除（close 删除，含 allowUnarchived 内部清理分支）后的回调（O1 任务收口挂这里） */
  private removedListeners: Array<(s: SessionMeta) => void> = [];
  /** 子 worktree 尚在清理时保留父记录，待后代确实删除后再删父。 */
  private subtreeCloseWaiters = new Map<string, () => void>();
  private forceDirectoryPreviews?: Map<string, { sessionId: string; ownership: string; expiresAt: number; directory: { path: string; dev: number; ino: number; mtimeMs: number } }>;
  /**
   * close() 墓碑：已从 registry 删除的会话仍能让 sessions.message 回执 session_ended。
   * 仍在册的会话不进这里（get/peek 即可）。落盘 session-ended.json，重启仍可辨认。
   */
  private endedRefs: EndedSessionRef[] = [];
  private chatBridge: ChatSessionBridge | null = null;
  private usageStats: UsageStatsService | null = null;

  /** AgentSessionHost 晚绑定（main/index.ts 构造后注入） */
  setChatSessionBridge(bridge: ChatSessionBridge): void {
    this.chatBridge = bridge;
  }

  /** 使用统计晚绑定（main/index.ts 构造后注入）；埋点：会话创建 / LLM 读屏 */
  setUsageStats(usage: UsageStatsService): void {
    this.usageStats = usage;
  }

  /** 该 runtime 是否 GUI（chat）surface */
  isChatRuntime(runtimeKey: string | undefined): boolean {
    if (!runtimeKey) return false;
    return runtimeSurface(this.runtimes.get(runtimeKey) ?? historicalServiceRuntime(runtimeKey)) === 'chat';
  }

  /**
   * 派活时首条简报的注入方式，由 runtime 脚本声明（派活主路径据此分流，禁止按 id 写死）。
   * GUI（chat）runtime 无拉起脚本，简报直接经 AgentSessionHost.send 发送。
   */
  /**
   * 该 runtime 的 TUI 输入框是否支持 bracketed paste（由 runtime 脚本声明，
   * 未声明/读取失败按 false——逐字键入 + 多次 Enter 兜底）。
   */
  async pasteInput(runtimeKey: string | undefined): Promise<boolean> {
    const runtime = runtimeKey?.trim() || this.config.get().defaultRuntime;
    if (this.isChatRuntime(runtime)) return false;
    try {
      return await this.runtimes.pasteInput(runtime);
    } catch {
      return false;
    }
  }

  async injectStrategy(runtimeKey: string | undefined): Promise<RuntimeInjectStrategy> {
    const runtime = runtimeKey?.trim() || this.config.get().defaultRuntime;
    if (this.isChatRuntime(runtime)) return 'initial-prompt';
    try {
      return await this.runtimes.injectStrategy(runtime);
    } catch (err) {
      console.warn(
        `[sessions] runtime ${runtime} 注入方式读取失败，按 initial-prompt 处理:`,
        errorMessage(err)
      );
      return 'initial-prompt';
    }
  }

  private businessApproval?: (workspaceId: string, action: string, args: Record<string, unknown>, evidence: string, gitEvidence?: SafetyGitEvidence) => Promise<boolean>;
  setBusinessApproval(authorize: NonNullable<SessionsService['businessApproval']>): void { this.businessApproval = authorize; }
  private async approvalSnapshot(ids: string[], options?: unknown, capture?: (sessionId: string, root: string, contents: GitEvidenceContents) => void, operation: 'integrate' | 'delete' = 'delete'): Promise<string> {
    const rows = ids.flatMap(id => sessionSubtreePostOrder(this.sessions, id));
    const unique = [...new Map(rows.map(row => [row.id, row])).values()];
    const sessions = await Promise.all(unique.map(async row => {
      // Explicit operation identity: telemetry and presentation must never invalidate consent.
      const safe = {
        id: row.id, createdAt: row.createdAt, type: row.type, workspaceId: row.workspaceId, cwd: row.cwd,
        sourceRoot: row.sourceRoot, parentSessionId: row.parentSessionId,
        worktreePath: row.worktreePath, worktreeSource: row.worktreeSource,
        worktreeBranch: row.worktreeBranch, worktreeBaseBranch: row.worktreeBaseBranch,
        worktreeRepoSet: row.worktreeRepoSet,
        // Saved integration targets/cleanup ownership affect retries and must remain bound.
        worktreeGroups: row.worktreeGroups,
        ...(operation === 'delete' ? {
          archived: row.archived, runtime: row.runtime,
          externalSessionId: row.externalSessionId, runtimeResumeToken: row.runtimeResumeToken
        } : {})
      };
      const refs = new Map<string, { branch?: string; baseBranch?: string; role: 'task' | 'target-checkout' | 'shared' }>();
      const rootPaths = new Map<string, string>();
      const add = (root: string | undefined, branch: string | undefined, baseBranch: string | undefined, role: 'task' | 'target-checkout') => {
        if (root) {
          const key = pathKey(root), previous = refs.get(key);
          rootPaths.set(key, root);
          refs.set(key, { branch, baseBranch, role: previous && previous.role !== role ? 'shared' : role });
        }
      };
      const addGroup = (tree: string | undefined, main: string | undefined, branch: string | undefined, base: string | undefined, repos: NonNullable<SessionMeta['worktreeRepoSet']>) => {
        add(tree, branch, base, 'task'); add(main, branch, base, 'target-checkout');
        for (const repo of repos) {
          add(tree && path.join(tree, repo.path), repo.branch, repo.baseBranch, 'task');
          add(main && path.join(main, repo.path), repo.branch, repo.baseBranch, 'target-checkout');
        }
      };
      addGroup(row.worktreePath, row.worktreeSource?.mainRepo, row.worktreeBranch, row.worktreeBaseBranch, row.worktreeRepoSet ?? []);
      for (const group of row.worktreeGroups?.groups ?? []) {
        const savedTarget = (repo: string, branch?: string) => group.integration?.find(entry => entry.repo === repo && entry.branch === branch)?.target;
        addGroup(group.path, group.source?.mainRepo, group.branch, savedTarget('', group.branch) ?? group.baseBranch,
          group.repos.map(repo => ({ ...repo, baseBranch: savedTarget(repo.path, repo.branch) ?? repo.baseBranch })));
      }
      const candidates = [...rootPaths.values()];
      let cwdRoot = row.cwd;
      if (cwdRoot && !candidates.some(root => pathKey(root) === pathKey(cwdRoot!)) && fs.existsSync(cwdRoot)) {
        const identity = await resolveRepoIdentity(cwdRoot, candidates);
        if (identity) cwdRoot = identity.root;
      }
      const roots = [...new Map([...candidates, ...(cwdRoot ? [cwdRoot] : [])].map(root => [pathKey(root), root])).values()];
      const repositories = await Promise.all(roots.map(async root => {
        const role = refs.get(pathKey(root))?.role;
        const ownership = { role: role ?? 'shared', roleUnknown: !role, workingTreeEvidence: operation === 'integrate' ? 'informational' : 'critical' };
        if (!this.git) return { root, ...ownership, unavailable: 'Git service unavailable' };
        try {
          let contents: GitEvidenceContents | undefined;
          const evidence = await this.git.approvalEvidence(root,
            operation === 'integrate' ? (options as IntegrateWorktreeOpts | undefined)?.targetBranch ?? refs.get(pathKey(root))?.baseBranch ?? row.worktreeBaseBranch ?? 'HEAD' : 'HEAD',
            operation === 'integrate' ? refs.get(pathKey(root))?.branch ?? row.worktreeBranch ?? 'HEAD' : 'HEAD', capture ? value => { contents = value; } : undefined);
          if (contents) capture?.(row.id, evidence.root, contents);
          // Remote polling timestamps/upstream counters do not affect local merge contents.
          return { ...evidence, ...ownership, status: { branch: evidence.status.branch, files: evidence.status.files } };
        }
        catch (error) { return { root, ...ownership, unavailable: errorMessage(error) }; }
      }));
      return { session: safe, repositories };
    }));
    const opts = options as IntegrateWorktreeOpts | undefined;
    const mergeOptions = operation === 'integrate' ? {
      targetBranch: opts?.targetBranch, message: opts?.message, noFf: opts?.noFf,
      stashMain: opts?.stashMain, skipNpmInstall: opts?.skipNpmInstall,
      skipTypecheck: opts?.skipTypecheck, onGateFail: opts?.onGateFail, approval: opts?.approval
    } : undefined;
    return JSON.stringify({ operation, sessions, options: mergeOptions });
  }
  /** Bounded field paths only: do not echo diff contents or credentials into errors. */
  private approvalChanges(before: string, after: string): string {
    const changes: string[] = [];
    const walk = (a: any, b: any, location: string): void => {
      if (changes.length >= 12 || JSON.stringify(a) === JSON.stringify(b)) return;
      if (a?.sha256 && b?.sha256 && a.sha256 !== b.sha256 && typeof b.text === 'string') {
        const files = [...new Set([...`${a.text ?? ''}\n${b.text}`.matchAll(/^diff --git (.+)$/gm)].map(match => match[1]))].slice(0, 5);
        changes.push(`${location}.sha256${files.length ? ` files=${JSON.stringify(files)}` : ''}`);
        return;
      }
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        const label = typeof (b.root ?? a.root) === 'string' ? `[${b.root ?? a.root}]`
          : typeof (b.path ?? a.path) === 'string' ? `[${b.path ?? a.path}]` : '';
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${location}${label}.${key}`);
      } else changes.push(`${location}${typeof (b?.path ?? a?.path) === 'string' ? ` file=${JSON.stringify(b?.path ?? a?.path)}` : ''}`);
    };
    walk(JSON.parse(before), JSON.parse(after), 'snapshot');
    return changes.join(', ');
  }
  private isExecuting(session: SessionMeta): boolean {
    return !session.archived && (!!this.agentSessionsRef?.isBusy?.(session.id) || sessionMayInterrupt(this.project(session)));
  }

  archiveExecutionIds(id: string): string[] {
    return archiveAffectedSessions(this.sessions, id).filter(row => this.isExecuting(row)).map(row => row.id);
  }

  archivedTerminalHistory(id: string): string {
    const session = this.peek(id);
    if (!session?.archived) return '';
    return session.archiveTerminalText ?? plainTextFromPtyBuffer(this.ptyMgr.getBufferTail(id, 24_000) ?? '').text;
  }

  private nativeHistoryTarget(row: SessionMeta, action?: NativeSessionHistoryAction): NativeSessionHistoryTarget | undefined {
    const target = this.chatBridge?.nativeHistory?.(row)?.describe(row);
    if (!target || !action) return target;
    if (target.actions.includes(action) && row.nativeHistoryDeleteReceipt !== this.nativeHistoryReceipt(target)) return target;
  }

  private nativeHistoryReceipt(target: NativeSessionHistoryTarget): string {
    return JSON.stringify([target.storageKey, [...target.ids].sort()]);
  }

  private async prepareNativeHistory(row: SessionMeta, history: NonNullable<import('./agentSession/types').GuiRuntimeDriver['nativeHistory']>,
    action: NativeSessionHistoryAction): Promise<void> {
    try { await history.prepare?.(row, action); }
    catch (error) { throw new NativeSessionHistoryError(errorMessage(error)); }
    if (this.peek(row.id) !== row) throw new Error(t('会话状态已变化，请重新扫描。'));
  }

  private async syncNativeHistory(row: SessionMeta, action: NativeSessionHistoryAction, target: NativeSessionHistoryTarget): Promise<void> {
    try {
      const driver = this.chatBridge?.nativeHistory?.(row);
      if (this.peek(row.id) !== row || !row.archived || !driver || !target.actions.includes(action) ||
          JSON.stringify(driver.describe(row)) !== JSON.stringify(target)) {
        throw new Error(t('会话状态已变化，请重新扫描。'));
      }
      const ids = new Set(target.ids);
      const otherSessionIds = new Set<string>();
      for (const other of this.sessions) {
        if (other === row) continue;
        const shared = this.nativeHistoryTarget(other);
        if (shared?.storageKey !== target.storageKey) continue;
        for (const id of shared.ids) {
          if (ids.has(id)) throw new Error(t('关联的原生会话还被另一条集序会话使用。'));
          otherSessionIds.add(id);
        }
      }
      await driver.update(row, action, otherSessionIds);
      if (action === 'delete') {
        const receipt = this.nativeHistoryReceipt(target);
        const assertBinding = () => {
          const current = driver.describe(row);
          if (this.peek(row.id) !== row || !row.archived || !current || this.nativeHistoryReceipt(current) !== receipt) {
            throw new Error(t('会话状态已变化，请重新扫描。'));
          }
        };
        assertBinding();
        row.nativeHistoryDeleteReceipt = receipt;
        await this.persister.flushStrict(assertBinding);
      }
    } catch (error) {
      throw new NativeSessionHistoryError(errorMessage(error));
    }
  }

  deletePreview(id: string): SessionDeletePreview {
    const root = this.peek(id);
    if (!root?.archived || root.type !== 'terminal') throw new Error(t('会话尚未归档：请先归档再删除（删除仅对已归档会话开放）'));
    const rows = sessionSubtreePostOrder(this.sessions, id);
    const worktrees = rows.flatMap(row => {
      const groups = sessionWorktreeGroups(row);
      return groups?.groups.flatMap(group => [
        { path: group.path, branch: group.branch, borrowed: !!groups.borrowedFrom },
        ...group.repos.map(repo => ({ path: path.join(group.path, repo.path), branch: repo.branch, borrowed: !!groups.borrowedFrom }))
      ]) ?? (row.worktreePath ? [{ path: row.worktreePath, branch: row.worktreeBranch, borrowed: false }] : []);
    });
    const active = rows.filter(row => this.isExecuting(row)).map(row => row.id);
    const nativeTargets = rows.map(row => this.nativeHistoryTarget(row, 'delete'));
    const providers = new Map<string, { ids: Set<string>; permanent: boolean; deletesNativeChildSessions: boolean }>();
    for (const target of nativeTargets) {
      if (!target) continue;
      const scope = providers.get(target.provider) ?? { ids: new Set<string>(), permanent: true, deletesNativeChildSessions: false };
      for (const id of target.ids) scope.ids.add(JSON.stringify([target.storageKey, id]));
      scope.permanent &&= target.permanentDelete === true;
      scope.deletesNativeChildSessions ||= target.deletesNativeChildSessions === true;
      providers.set(target.provider, scope);
    }
    return { name: root.name, descendants: rows.length - 1, active: active.length, worktrees,
      ...(providers.size ? { nativeHistory: [...providers].map(([provider, scope]) => ({
        provider, count: scope.ids.size, permanent: scope.permanent, deletesNativeChildSessions: scope.deletesNativeChildSessions
      })) } : {}),
      fingerprint: JSON.stringify([rows.map((row, i) => [row.id, row.archived, taskWorktreeOwnership(row), nativeTargets[i]]), active]) };
  }

  async previewPermanentDeletion(id: string): Promise<SessionDeletePreview> {
    const root = this.peek(id);
    if (root?.archived && root.type === 'terminal') {
      const rows = sessionSubtreePostOrder(this.sessions, id);
      for (const row of rows) {
        const history = this.chatBridge?.nativeHistory?.(row);
        const target = row.nativeHistoryDeleteReceipt ? history?.describe(row) : undefined;
        if (history?.prepare && (!target || row.nativeHistoryDeleteReceipt !== this.nativeHistoryReceipt(target))) {
          await this.prepareNativeHistory(row, history, 'delete');
        }
      }
    }
    const preview = this.deletePreview(id);
    if (!this.git) return preview;
    for (const row of sessionSubtreePostOrder(this.sessions, id)) {
      const referenced = this.worktreeReferencedByOtherSession(row);
      for (const group of sessionWorktreeGroups(row)?.groups ?? []) {
        if (!group.source?.mainRepo) continue;
        const members = [{ path: '', branch: group.branch, baseBranch: group.baseBranch }, ...group.repos];
        for (const member of members) {
          const checkout = path.join(group.path, member.path);
          const planned = preview.worktrees.find(tree => !tree.borrowed && pathKey(tree.path) === pathKey(checkout) && tree.branch === member.branch);
          if (!planned || !member.branch) continue;
          planned.disposition = referenced ? 'keep' : await this.git.previewWorktreeRemoval(path.join(group.source.mainRepo, member.path), checkout, member.branch, member.baseBranch);
        }
      }
    }
    if (preview.fingerprint !== this.deletePreview(id).fingerprint) throw new Error(t('会话状态已变化，请重新扫描。'));
    return preview;
  }

  /** The origin is set by the trusted entry point, never by tool arguments. */
  async deletePermanently(ids: string[], initiatedBy: 'human' | 'agent' = 'agent', options?: SessionDeleteOptions): Promise<void> {
    const targets = [...new Set(ids)];
    for (const id of targets) {
      const row = this.get(id);
      if (!row || !row.archived || row.type === 'scheduled') throw new Error('Only archived work sessions can be permanently deleted');
    }
    const workspaceId = this.get(targets[0])?.workspaceId;
    if (!workspaceId || targets.some(id => this.get(id)?.workspaceId !== workspaceId)) throw new Error('Deletion must target one workspace');
    if (options && (initiatedBy !== 'human' || targets.length !== 1 || this.deletePreview(targets[0]).fingerprint !== options.fingerprint)) {
      throw new Error(t('会话状态已变化，请重新扫描。'));
    }
    if (initiatedBy !== 'human') {
      const collector = createSafetyGitEvidenceCollector();
      try {
        const evidence = await this.approvalSnapshot(targets, undefined, collector.capture);
        if (!this.businessApproval || !await this.businessApproval(workspaceId, 'sessions.delete', { sessionIds: targets }, evidence, collector.finish(evidence))) throw new Error('Permanent deletion approval denied or unavailable');
        const currentEvidence = await this.approvalSnapshot(targets);
        if (currentEvidence !== evidence) throw new Error(`Deletion targets changed during approval: ${this.approvalChanges(evidence, currentEvidence)}`);
      } finally { collector.clear(); }
    }
    const covered = new Set(targets.flatMap(id => sessionSubtreePostOrder(this.sessions, id).filter(row => row.id !== id).map(row => row.id)));
    for (const id of targets) {
      if (covered.has(id)) continue;
      const rows = sessionSubtreePostOrder(this.sessions, id);
      const assertSameSubtree = () => {
        const current = sessionSubtreePostOrder(this.sessions, id);
        if (current.length !== rows.length || current.some((row, index) => row !== rows[index])) {
          throw new Error(t('会话状态已变化，请重新扫描。'));
        }
      };
      const deleting = this.deletingSessions ??= new Set<string>();
      for (const row of rows) {
        if (row.type === 'scheduled') throw new Error(t('scheduled 会话由服务管理，请使用 automations.delete 删除服务'));
        assertTaskWorktreeOperationIdle(this.config, row.id);
        if (this.archiveCleanupPending?.has(row.id) || deleting.has(row.id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
        if (!usesTaskWorktreeLifecycle(row)) assertSingleWorktreeGroup(row);
      }
      this.assertArchiveAllowed(rows);
      const active = new Set(rows.filter(row => this.isExecuting(row)).map(row => row.id));
      // This scope is presented by the desktop's permanent-delete confirmation.
      const nativeHistory = new Map<SessionMeta, NativeSessionHistoryTarget>();
      if (initiatedBy === 'human') {
        for (const row of rows) {
          const target = this.nativeHistoryTarget(row, 'delete');
          if (target) {
            if (!options) throw new Error(t('会话状态已变化，请重新扫描。'));
            nativeHistory.set(row, target);
          }
        }
      }
      for (const row of rows) { deleting.add(row.id); this.markArchived(row); }
      try {
        const needsRelease = rows.filter(row => nativeHistory.has(row) || options?.keepWorktrees || active.has(row.id) ||
          !!row.worktreePath || usesTaskWorktreeLifecycle(row));
        const releases = await Promise.allSettled(needsRelease.map(row => this.releaseTaskWorktreeSession(row)));
        for (const [i, result] of releases.entries()) {
          if (result.status !== 'rejected') continue;
          if (nativeHistory.has(needsRelease[i])) throw new NativeSessionHistoryError(errorMessage(result.reason));
          if (!options?.forceWorktrees) throw result.reason;
        }
        // Confirm the engine accepts archiving before removing its checkout.
        for (const [row, target] of nativeHistory) {
          assertSameSubtree();
          if (target.actions.includes('archive')) await this.syncNativeHistory(row, 'archive', target);
        }
        if (!options?.keepWorktrees) {
          // Child ownership is resolved before a parent can remove the referenced checkout.
          for (const row of needsRelease) {
            if (usesTaskWorktreeLifecycle(row)) {
              const result = options?.forceWorktrees
                ? await cleanupTaskWorktrees(this.worktreeCtx(), row, 'discard', { forceBranches: true })
                : await cleanupTaskWorktrees(this.worktreeCtx(), row, 'close');
              if (!result.ok) throw new Error(result.message);
            } else if (row.worktreePath) {
              if (options?.forceWorktrees) {
                const result = await discardSessionWorktree(this.worktreeCtx(), row.id, { forceBranch: true });
                if (!result.ok) {
                  row.meta = { ...row.meta, orphanWorktree: 'locked', worktreeCleanupIssue: result.message ?? t('worktree 强制清理失败') };
                  this.persist(); this.broadcast();
                  throw new Error(result.message || t('worktree 强制清理失败'));
                }
              } else {
                const lease = beginTaskWorktreeOperation(this.config, row.id, 'cleanup');
                try {
                  if (this.worktreeReferencedByOtherSession(row) || !await cleanupSessionWorktreeOnClose(this.worktreeCtx(), row)) {
                    row.meta = { ...row.meta, orphanWorktree: 'locked' };
                    this.persist(); this.broadcast();
                    throw new Error(row.meta.worktreeCleanupIssue || t('未通过 worktree 安全检查，已保留。'));
                  }
                  clearSessionWorktreeMetadata(row);
                } finally { lease.release(); }
              }
            }
          }
        }
        for (const [row, target] of nativeHistory) {
          assertSameSubtree();
          await this.syncNativeHistory(row, 'delete', target);
        }
        assertSameSubtree();
        if (options?.keepWorktrees) await this.deleteKeepingWorktrees(rows, assertSameSubtree);
        else this.close(id);
      } finally {
        for (const row of rows) deleting.delete(row.id);
        this.broadcast();
      }
    }
  }

  /** The storage plan names every session. Stop and remove exactly this leaf, retaining owned Git registrations. */
  async deleteLocalStorageSession(id: string): Promise<void> {
    const row = this.peek(id);
    const changed = () => new Error(t('清理依赖已变化，请重新扫描并确认。'));
    if (!row || row.type !== 'terminal' || row.hidden || !row.workspaceId) throw changed();
    const ownership = taskWorktreeOwnership(row);
    const validate = () => {
      if (this.peek(id) !== row || taskWorktreeOwnership(row) !== ownership ||
        this.sessions.some(child => child.parentSessionId === id && !child.retainedWorktreeOnly)) throw changed();
    };
    validate();
    const deleting = this.deletingSessions ??= new Set();
    if (deleting.has(id) || this.archiveCleanupPending?.has(id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
    this.assertArchiveAllowed([row]);
    const lease = beginTaskWorktreeOperation(this.config, id, 'storage-delete');
    deleting.add(id);
    this.markArchived(row);
    try {
      await this.releaseTaskWorktreeSession(row);
      await this.deleteKeepingWorktrees([row], validate);
    } finally {
      deleting.delete(id);
      lease.release();
      this.broadcast();
    }
  }

  private async deleteKeepingWorktrees(rows: readonly SessionMeta[], validate?: () => void): Promise<void> {
    const replacements = new Map(rows.map(row => [row.id, this.retainedWorktreeRow(row)]));
    const replace = (sessions: SessionMeta[]): SessionMeta[] => sessions.flatMap(row => {
      if (!replacements.has(row.id)) return [row];
      const retained = replacements.get(row.id);
      return retained ? [retained] : [];
    });
    await this.persister.flushStrict(() => {
      validate?.();
      if (rows.some(row => this.peek(row.id) !== row || !row.archived)) throw new Error(t('会话状态已变化，请重新扫描。'));
    }, replace, () => { this.sessions = replace(this.sessions); });
    for (const row of rows) {
      this.rememberEnded(row);
      try { purgeSessionReminders(row.id); }
      catch (error) {
        this.notify.push({ workspaceId: this.workspaceIdFor(row), sessionId: row.id, sessionName: row.name,
          kind: 'error', toast: true, text: t('待办清理失败：{{error}}', { error: errorMessage(error) }) });
      }
      this.finishDeletedSession(row, () => {}, true);
    }
  }

  private retainedWorktreeRow(s: SessionMeta): SessionMeta | undefined {
    if (s.worktreeGroups?.borrowedFrom || (!s.worktreePath && !s.worktreeGroups?.groups.length)) return undefined;
    return { id: s.id, name: s.name, type: 'terminal', createdAt: s.createdAt, workspaceId: s.workspaceId, archived: true,
      retainedWorktreeOnly: true, status: 'exited', lifecycle: 'exited', cwd: s.cwd, sourceRoot: s.sourceRoot,
      worktreePath: s.worktreePath, worktreeBranch: s.worktreeBranch, worktreeBaseBranch: s.worktreeBaseBranch,
      worktreeSource: s.worktreeSource, worktreeRepoSet: s.worktreeRepoSet, worktreeGroups: s.worktreeGroups, meta: s.meta && {
        orphanWorktree: s.meta.orphanWorktree, worktreeCleanupIssue: s.meta.worktreeCleanupIssue
      } };
  }

  constructor(
    private store: Store,
    private ptyMgr: PtyManager,
    private config: ConfigManager,
    private getWindow: () => BrowserWindow | null,
    private notify: NotifyStore,
    private notifyBus: NotifyBus,
    private runtimes: RuntimeHost,
    private git?: GitService
  ) {
    this.persister = new SessionPersister(store, () => this.sessions);
    this.sessions = store
      .loadSessions()
      .filter((s) => !(s.type === 'terminal' && s.launchKind === 'shell') && !s.hidden)
      .map((s) => this.normalizeLoadedSession(s));
    for (const s of this.sessions) {
      if (s.type === 'terminal') s.status = 'idle';
    }
    const orphans = this.dropOrphanWorkspaceSessions();
    this.hydrateEndedRefs(orphans);
    // 回填 workspaceId 后落盘一次
    this.persist();
    // 启动清扫 inject 残留（M-11）：契约是「启动/派活时扫掉 >2h 残留」——此前只有
    // cursor-cli 派活触发，宿主崩溃遗留的简报文件只能等 15 分钟延迟删除兜底
    this.sweepInjectFiles();
    // 同处启动清扫交接临时文档（X2-F07）：runHandover 三路清理之外，宿主崩溃/断电
    // 残留在 %TMP%/muster-handover 的文档只能等这里兜底（>2h 同口径）
    sweepHandoverFiles();
    void sweepOrphanHandovers(app.getPath('userData'), new Set(this.sessions.map(session => session.id)))
      .catch(error => console.warn('[handover] 清理遗留交接文档失败', error));
    ptyMgr.onReclamationError = (sessionId, error) => {
      const row = this.sessions.find(session => session.id === sessionId);
      this.notify.push({ workspaceId: row?.workspaceId || this.config.get().activeWorkspaceId || 'app', sessionId,
        sessionName: row?.name || sessionId, kind: 'error', toast: true,
        text: t('终端进程回收未确认：{{error}}', { error: errorMessage(error) }) });
    };
    ptyMgr.onExit = (sessionId) => this.handlePtyExit(sessionId);
    // Output is a heuristic; redraw cannot revoke an authoritative stop/wait fact.
    ptyMgr.onData = (sessionId) => {
      const s = this.sessions.find((x) => x.id === sessionId);
      if (!s || s.type !== 'terminal') return;
      if (s.lifecycle === 'exited' || s.lifecycle === 'blocked') return;
      if (s.activity?.kind === 'idle' || s.activity?.kind === 'waiting_input') return;
      this.applyLifecycle(s, 'working', { notify: false });
    };
    this.startLifecyclePoll();
  }

  private handlePtyExit(sessionId: string): void {
      const s = this.sessions.find((x) => x.id === sessionId);
      if (!s) return;
      // A pending launch owns its failure; auto-close here would invalidate its generation.
      if (s.launchKind === 'shell' && s.status === 'starting' && this.launchTasks.has(sessionId)) return;
      if (s.launchKind === 'shell' && !s.archived) {
        try {
          this.close(sessionId, { allowUnarchived: true });
        } catch {
          /* 已关闭 */
        }
        return;
      }
      s.status = 'exited';
      this.classifyBySession.delete(sessionId);
      const attempt = s.workerRouting?.attempts.at(-1);
      if (attempt && !['blocked', 'cancelled', 'completed'].includes(s.workerRouting!.phase)) this.noteWorkerRoute(s.id, attempt.attempt, 'blocked', 'delivery-unknown');
      this.applyLifecycle(s, 'exited', { notify: !s.archived });
  }

  cancelPersist(): void {
    this.persister.cancel();
  }

  reloadFromDisk(): void {
    this.persister.cancel();
    this.sessions = this.store
      .loadSessions()
      .filter((s) => !(s.type === 'terminal' && s.launchKind === 'shell') && !s.hidden)
      .map((s) => this.normalizeLoadedSession(s));
    for (const s of this.sessions) {
      if (s.type === 'terminal') s.status = 'idle';
    }
    const orphans = this.dropOrphanWorkspaceSessions();
    this.hydrateEndedRefs(orphans);
    if (this.activeId && !this.sessions.some((s) => s.id === this.activeId)) {
      this.activeId = this.sessions[0]?.id ?? null;
    }
    this.broadcast();
  }

  /** 装载/重载墓碑：仍在册的以 registry 为准；刚丢弃的孤儿补记。 */
  private hydrateEndedRefs(orphans: SessionMeta[]): void {
    const liveIds = new Set(this.sessions.filter(s => !s.retainedWorktreeOnly).map(s => s.id));
    this.endedRefs = this.store.loadEndedSessionRefs().filter((r) => !liveIds.has(r.id));
    for (const s of orphans) this.rememberEnded(s);
    try { purgeEndedSessionReminders(this.endedRefs.map(ref => ref.id)); }
    catch (error) {
      this.notify.push({ workspaceId: this.config.get().activeWorkspaceId || 'app', sessionId: 'notify:session-reminders:cleanup',
        sessionName: t('用户待办提醒'), kind: 'error', toast: true,
        text: t('已删除会话的待办清理失败：{{error}}', { error: errorMessage(error) }) });
    }
  }

  /** 启动/重载时丢弃已关闭工作区的遗留终端会话（workspaceId 悬空查不到归属） */
  private dropOrphanWorkspaceSessions(): SessionMeta[] {
    const config = this.config.get();
    const known = new Set([...config.workspaces, ...(config.closedWorkspaces ?? [])].map(w => w.id));
    const dropped: SessionMeta[] = [];
    this.sessions = this.sessions.filter((s) => {
      const keep = s.type !== 'terminal' || (!!s.workspaceId && known.has(s.workspaceId));
      if (!keep) dropped.push(s);
      return keep;
    });
    if (dropped.length > 0) {
      console.log(`[sessions] dropped ${dropped.length} orphan session(s) of closed workspaces`);
    }
    return dropped;
  }

  private startLifecyclePoll(): void {
    if (this.monitorController.signal.aborted) return;
    this.pollTimer = setInterval(() => this.pollLifecycles(), LIFECYCLE_POLL_MS);
    this.pollTimer.unref?.();
  }

  /** before-quit：停轮询，避免退出窗口期还在写盘 / 广播到已销毁的窗口 */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  stopMonitoring(): void { this.monitorController.abort(); this.stop(); }
  async shutdownMonitoring(): Promise<void> {
    this.stopMonitoring();
    await Promise.allSettled([...this.monitorTasks]);
  }

  private pollLifecycles(): void {
    if (this.monitorController.signal.aborted) return;
    for (const s of this.sessions) {
      if (s.type !== 'terminal') continue;
      if (s.lifecycle === 'exited') continue;
      if (!this.ptyMgr.isRunning(s.id)) continue;
      this.pollOutputLifecycle(s);
    }
  }

  /** 终端会话生命周期：廉价输出启发式（非对称迟滞，见 nextPtyLifecycle）+ 条件触发的 LLM 读屏 */
  private pollOutputLifecycle(s: SessionMeta): void {
    const last = this.ptyMgr.getLastOutputAt(s.id);
    const next = nextPtyLifecycle({
      lifecycle: s.lifecycle ?? 'starting',
      activity: s.activity,
      lastOutputAt: last,
      now: Date.now()
    });
    if (next && next !== s.lifecycle) {
      this.applyLifecycle(s, next, { notify: false });
    }
    // starting 且从未有过输出：多半是 CLI 还在启动，读屏必然读回启动屏噪声，
    // 等首个输出（翻到 working）再参与分类（重构前此处就是早退，保持同语义）
    if ((s.lifecycle ?? 'starting') === 'starting' && last <= 0) return;
    this.maybeClassifyScreen(s);
  }

  private maybeClassifyScreen(s: SessionMeta): void {
    if (this.monitorController.signal.aborted) return;
    if (s.launchKind === 'shell') return;
    if (this.classifyInFlight.size >= SCREEN_CLASSIFY_MAX_CONCURRENCY) return;
    const st = this.classifyBySession.get(s.id) ?? { cooldownMs: SCREEN_CLASSIFY_MIN_INTERVAL_MS };
    const cheap = shouldScreenClassifyCheap({
      now: Date.now(),
      createdAt: s.runtimeStartedAt ?? s.createdAt,
      lifecycle: s.lifecycle,
      activity: s.activity,
      phase: s.phase,
      lastClassifyAt: st.lastClassifyAt,
      inFlight: this.classifyInFlight.has(s.id),
      nextAllowedAt: st.nextAllowedAt
    });
    if (!cheap.ok) return;
    const openai = resolveLlmConfig(this.config.get()).openai;
    if (!openai.model || !openai.apiKey?.trim() || !openai.baseUrl?.trim()) return;
    const buf = this.ptyMgr.getBufferTail(s.id, LIFECYCLE_BUFFER_TAIL_CHARS);
    if (buf === undefined) return;
    const { text } = plainTextFromPtyBuffer(buf);
    const clipped = text.slice(-SCREEN_CLASSIFY_MAX_CHARS);
    const currentHash = hashScreenText(clipped);
    const gate = shouldScreenClassify({
      now: Date.now(),
      createdAt: s.runtimeStartedAt ?? s.createdAt,
      lifecycle: s.lifecycle,
      activity: s.activity,
      phase: s.phase,
      lastClassifyAt: st.lastClassifyAt,
      inFlight: this.classifyInFlight.has(s.id),
      nextAllowedAt: st.nextAllowedAt,
      lastHash: st.lastHash,
      currentHash
    });
    if (!gate.ok) return;
    this.classifyInFlight.add(s.id);
    void this.runScreenClassify(s.id, clipped, currentHash);
  }

  private runScreenClassify(id: string, text: string, currentHash: string): Promise<void> {
    const task = Promise.resolve().then(() => this.runScreenClassifyOwned(id, text, currentHash));
    this.monitorTasks.add(task);
    void task.then(() => this.monitorTasks.delete(task), () => this.monitorTasks.delete(task));
    return task;
  }

  private async runScreenClassifyOwned(id: string, text: string, currentHash: string): Promise<void> {
    if (this.monitorController.signal.aborted) { this.classifyInFlight.delete(id); return; }
    const st = this.classifyBySession.get(id) ?? { cooldownMs: SCREEN_CLASSIFY_MIN_INTERVAL_MS };
    st.lastClassifyAt = Date.now();
    this.classifyBySession.set(id, st);
    const session = this.sessions.find((s) => s.id === id);
    const activity = session?.activity;
    const phase = session?.phase;
    const outputAt = this.ptyMgr.getLastOutputAt(id);
    const stillCurrent = () => {
      if (this.monitorController.signal.aborted) return false;
      const current = this.sessions.find((s) => s.id === id);
      if (!current || current !== session || current.archived || current.lifecycle === 'exited' ||
          this.classifyBySession.get(id) !== st || current.activity !== activity || current.phase !== phase ||
          this.ptyMgr.getLastOutputAt(id) !== outputAt) return false;
      const buffer = this.ptyMgr.getBufferTail(id, LIFECYCLE_BUFFER_TAIL_CHARS);
      return buffer !== undefined && hashScreenText(plainTextFromPtyBuffer(buffer).text.slice(-SCREEN_CLASSIFY_MAX_CHARS)) === currentHash;
    };
    try {
      const openai = resolveLlmConfig(this.config.get()).openai;
      this.usageStats?.recordScreenRead();
      const result = await classifyTerminalScreen(openai, text, this.monitorController.signal);
      if (!stillCurrent()) return;
      st.lastHash = currentHash;
      st.lastClassifyAt = Date.now();
      st.cooldownMs = SCREEN_CLASSIFY_MIN_INTERVAL_MS;
      delete st.nextAllowedAt;
      this.classifyBySession.set(id, st);
      if (result !== 'unknown') {
        this.setPhase(id, { value: result, source: 'llm', ts: Date.now() });
      }
    } catch (e) {
      if (!stillCurrent()) return;
      st.cooldownMs = Math.min(st.cooldownMs * 2, SCREEN_CLASSIFY_MAX_BACKOFF_MS);
      st.nextAllowedAt = Date.now() + st.cooldownMs;
      this.classifyBySession.set(id, st);
      console.warn(
        `[sessions] screen classify failed (backoff ${Math.round(st.cooldownMs / 1000)}s):`,
        errorMessage(e)
      );
    } finally {
      this.classifyInFlight.delete(id);
    }
  }

  private workspaceIdFor(s: SessionMeta): string {
    return s.workspaceId ?? this.resolveWorkspaceId(s.cwd);
  }

  private applyLifecycle(
    s: SessionMeta,
    next: AgentLifecycle,
    opts?: { notify?: boolean; deferPublish?: boolean }
  ): void {
    if (s.lifecycle === next) return;
    const prev = s.lifecycle;
    s.lifecycle = next;
    // O6：working 翻转记时刻（重复进入 working 也刷新——那是新一轮输出）；翻出即清
    if (next === 'working') this.ptyWorkingSince.set(s.id, Date.now());
    else this.ptyWorkingSince.delete(s.id);
    // 注意：working（输出活动）不刷新 lastUsedAt——打开会话时终端回放/CLI 重绘也会产生输出，
    // 会造成「看一眼就冒泡」。真使用以用户键盘输入为准（见 touchUsed）
    if (!s.hidden && !opts?.deferPublish) {
      this.persist();
      this.broadcast();
    }
    for (const fn of this.lifecycleListeners) {
      try {
        fn(s, prev, next);
      } catch (e) {
        console.error('[sessions] lifecycle listener failed', e);
      }
    }
    const shouldNotify = opts?.notify !== false;
    if (next === 'exited') notifyDelegateSlotFreed(this.workspaceIdFor(s));
    // 启动回填 / 首次赋值不通知，避免 hydrate 后首轮刷屏
    this.emitSessionFactKind(s, 'session.lifecycle');
    if (!shouldNotify || prev === undefined || s.hidden) return;
    // exited 弹桌面 toast；blocked（hook 卡住态）的 toast 已移交通知总线
    // （applyActivitySignal 上报，needs_you 类、phase:<id> 键），这里不再重复弹
    if (next !== 'exited') return;
    this.notify.push({
      workspaceId: this.workspaceIdFor(s),
      sessionId: s.id,
      sessionName: s.name,
      lifecycle: next,
      text: formatNotifyText(s.name, next),
      update: true,
      updateKey: `lifecycle:${s.id}`,
      toast: true
    });
  }

  /** 生命周期边沿（含 notify:false 的 working/idle 轮询） */
  onLifecycle(
    fn: (s: SessionMeta, prev: AgentLifecycle | undefined, next: AgentLifecycle) => void
  ): () => void {
    this.lifecycleListeners.push(fn);
    return () => {
      this.lifecycleListeners = this.lifecycleListeners.filter((x) => x !== fn);
    };
  }

  /** O6：pty 会话最近一次进入 working 的时刻（working 中才有值；非 working/未知会话 undefined） */
  getPtyWorkingSince(sessionId: string): number | undefined {
    return this.sessions.find((s) => s.id === sessionId)?.lifecycle === 'working'
      ? this.ptyWorkingSince.get(sessionId)
      : undefined;
  }

  /** phase 翻转监听（子代理完成通知等）。与 onLifecycle 互补：phase 是交付状态轴。 */
  onPhaseFlip(
    fn: (s: SessionMeta, next: SessionPhaseKind, prev: SessionPhaseKind | undefined) => void
  ): () => void {
    this.phaseListeners.push(fn);
    return () => {
      this.phaseListeners = this.phaseListeners.filter((x) => x !== fn);
    };
  }

  private notifyPhaseListeners(s: SessionMeta, next: SessionPhaseKind, prev: SessionPhaseKind | undefined): void {
    for (const fn of this.phaseListeners) {
      try {
        fn(s, next, prev);
      } catch (e) {
        console.error('[sessions] phase listener failed', s.id, e);
      }
    }
  }

  /**
   * 会话被移除后回调（close 删除路径，含 shell 自清/关工作区的 allowUnarchived
   * 内部清理分支——这些路径不走 applyLifecycle('exited')，onLifecycle 看不见）。
   * 监听方做善后（订阅和后台任务收口等）；异常各自吞，不影响删除主流程。
   */
  onSessionRemoved(fn: (s: SessionMeta) => void): () => void {
    this.removedListeners.push(fn);
    return () => {
      this.removedListeners = this.removedListeners.filter((x) => x !== fn);
    };
  }

  private notifySessionRemoved(s: SessionMeta): void {
    for (const fn of this.removedListeners) {
      try {
        fn(s);
      } catch (e) {
        console.error('[sessions] removed listener failed', e);
      }
    }
  }

  private normalizeLoadedSession(s: SessionMeta): SessionMeta {
    if (s.type !== 'terminal') return s;
    const launchKind = s.launchKind === 'shell' ? 'shell' : 'agent';
    s = { ...s };
    // A process that existed before restart cannot prove a pending dispatch or
    // handoff reached the native engine. Keep the logical task and require review.
    if (s.workerRouting) s.workerRouting = recoverWorkerRouteAfterRestart(s.workerRouting);
    try {
      normalizeSessionWorktrees(s);
      if (s.meta?.worktreeGroupsError) delete s.meta.worktreeGroupsError;
    } catch (error) {
      const message = errorMessage(error);
      console.warn('[sessions] invalid worktree groups preserved; lifecycle blocked', s.id, message);
      s.meta = { ...s.meta, worktreeGroupsError: message };
    }
    const workspaceId = legacySessionWorkspaceId(this.config.get(), s);
    const sourceRoot = legacySessionSourceRoot(this.config.get(), s);
    s = { ...s, workspaceId, sourceRoot };
    // Legacy migration may recover provenance from the projected main checkout.
    if (s.worktreeGroups?.groups.length === 1 && !s.worktreeGroups.groups[0].sourceRoot && sourceRoot) s.worktreeGroups.groups[0].sourceRoot = { ...sourceRoot };
    if (!workspaceId) console.warn('[sessions] legacy session ownership unresolved; explicit workspace required', s.id, s.cwd);
    if (launchKind === 'shell') {
      return { ...s, launchKind, workspaceId, sourceRoot, runtime: undefined, externalSessionId: undefined };
    }
    // 一次性迁移：旧版编排标记 briefCount>0 的存量会话回填 orchestrated=true
    // （显式 false / 无计数则不动），升级后调度对原 Worker 集群的跟踪不中断
    const orchestrated = migrateOrchestratedFlag(s);
    if (orchestrated !== s.orchestrated) s.orchestrated = orchestrated;
    // 排队注入计数是运行时态：恢复后 Host 队列已空，旧值会让胶囊假显示「排队N」
    delete s.queuedInjects;
    delete s.runtimePresence;
    delete s.lastOutputAt;
    // 执行事实只对当前宿主生命周期有效，不能从磁盘恢复未结束的工具计数。
    if (s.activity) s.activity = { kind: s.activity.kind, event: s.activity.event, ts: s.activity.ts };
    const defaultRuntime = this.config.get().defaultRuntime;
    let runtime: string;
    try {
      // Do not reinterpret a removed Cursor SDK resume token as another engine's session.
      runtime = s.runtime === 'cursor' ? s.runtime : normalizeRuntimeKey(s.runtime as string | undefined, this.runtimes, defaultRuntime);
    } catch (e) {
      // Keep the saved engine identity when an adapter has been removed.
      runtime = s.runtime?.trim() || defaultRuntime;
      console.warn(
        `[sessions] session ${s.id} runtime "${runtime}" unavailable: ${errorMessage(e)}`
      );
    }
    const lifecycle =
      s.lifecycle ??
      (this.ptyMgr.isRunning(s.id) ? ('idle' as const) : ('exited' as const));
    return { ...s, launchKind: 'agent', runtime, workspaceId, sourceRoot, lifecycle };
  }

  /**
   * 旧路径反查仅在唯一工作区匹配时成立；区外/歧义不回落活动区。
   */
  resolveWorkspaceId(cwd?: string): string {
    return legacySessionWorkspaceId(this.config.get(), { cwd });
  }

  listByWorkspace(workspaceId: string): SessionMeta[] {
    return this.list().filter(
      (s) => (s.workspaceId ?? this.resolveWorkspaceId(s.cwd)) === workspaceId
    );
  }

  /** Catalog / 扩展派活轮询：该区 terminal 列表 + 若 global active 不在区内则 null */
  listForAgent(workspaceId: string): { sessions: SessionMeta[]; activeId: string | null } {
    const sessions = this.listByWorkspace(workspaceId);
    const active = this.activeId ? this.get(this.activeId) : undefined;
    const activeWs = active
      ? (active.workspaceId ?? this.resolveWorkspaceId(active.cwd))
      : null;
    const activeId =
      activeWs === workspaceId
        ? this.activeId
        : // session-model F-02：兜底复用左栏排序取第一行（原列表序 find 可能与
          // 用户左栏首行不同，导致调度/模型看到的「当前会话」与用户不一致）
          railFirstTerminalId(sessions);
    return { sessions, activeId };
  }

  /** 切换工作区后：恢复该区上次离开时选中的会话；无记忆或已失效则回落该区第一个 terminal */
  adoptActiveForWorkspace(workspaceId: string): void {
    const decision = decideAdoptActive(
      this.sessions,
      this.activeId,
      workspaceId,
      this.lastActiveByWs,
      (cwd) => this.resolveWorkspaceId(cwd)
    );
    if (decision.remember) {
      this.lastActiveByWs.set(decision.remember.workspaceId, decision.remember.sessionId);
    }
    this.activeId = decision.activeId;
    this.broadcast();
  }

  /**
   * select / create(activate) 共用：同区才改 activeId；异区写入该区待显示。
   * 返回决策供 select 决定是否发 sessions:reveal。
   */
  private applySelectDisplay(
    session: SessionMeta,
    activate?: boolean
  ): 'show' | 'pending' | 'skip' {
    const sessionWs = session.workspaceId ?? this.resolveWorkspaceId(session.cwd);
    const decision = decideSelectDisplay({
      sessionWorkspaceId: sessionWs,
      activeWorkspaceId: this.config.get().activeWorkspaceId,
      hidden: !!session.hidden,
      activate
    });
    if (decision.kind === 'show') {
      this.activeId = session.id;
      return 'show';
    }
    if (decision.kind === 'pending') {
      this.lastActiveByWs.set(decision.workspaceId, session.id);
      return 'pending';
    }
    return 'skip';
  }

  broadcast(): void {
    this.getWindow()?.webContents.send('sessions:changed', {
      sessions: this.list(),
      activeId: this.activeId
    });
  }

  private persist(): void {
    this.persister.schedule();
  }

  flushPersist(): void {
    this.persister.flush();
  }

  private bumpLaunchGen(id: string): number {
    const n = (this.launchGen.get(id) ?? 0) + 1;
    this.launchGen.set(id, n);
    return n;
  }

  private isCurrentLaunch(id: string, gen: number): boolean {
    return this.launchGen.get(id) === gen;
  }

  /**
   * 后台完成 allocate + spawn。调用方应已把会话标成 starting 并 broadcast。
   * 每次调用递增 generation：relaunch/close 之后过期的 allocate 不得再 spawn。
   */
  private async launchTerminal(
    s: SessionMeta,
    mode: 'start' | 'resume' | 'fork' | 'new',
    initialPrompt?: string,
    forkFromExternalSessionId?: string,
    injectHostIntro = false
  ): Promise<CliPromptLaunchReceipt | undefined> {
    const gen = this.bumpLaunchGen(s.id);
    const restarting = mode === 'resume' || mode === 'new';
    const previousCwd = s.cwd;
    if (!restarting) s.runtimeStartedAt = Date.now();
    let cliContext: ReturnType<typeof beginCliWorkspaceContext> | undefined;

    const task = (async () => {
      if (s.launchKind === 'shell' || !this.isChatRuntime(s.runtime)) cliContext = beginCliWorkspaceContext(this.config, s, this.sessions, app.getPath('userData'));
      const target = await resolveSessionTarget(this.config.get(), { workspaceId: s.workspaceId, cwd: s.cwd, capturedSource: s.sourceRoot }, registeredWorktreeSession(this.sessions, s.cwd, s.workspaceId) ?? s);
      if (!this.isCurrentLaunch(s.id, gen)) return;
      assertSessionTargetCurrent(this.config.get(), target);
      if (mode !== 'resume') {
        s.cwd = target.cwd;
        s.sourceRoot = { ...target.sourceRoot };
      }
      if (s.launchKind === 'shell') {
        if (!cliContext) throw new Error('Shell workspace scope is unavailable');
        await this.launchShellSession(s, gen, cliContext);
        return;
      }
      // GUI（chat surface）Worker：不 allocate、不写 inject、不 spawn pty。
      // 空会话 = 只物化带工具目录的系统提示（Host 连接懒建），等用户或派活消息。
      if (this.isChatRuntime(s.runtime)) {
        s.status = 'running';
        this.chatBridge?.open(s);
        if (!s.hidden) {
          this.persist();
          this.broadcast();
        }
        return;
      }
      const cfg = this.config.get();
      const runtime = s.runtime?.trim() || cfg.defaultRuntime;
      const entry = this.runtimes.get(runtime);
      if (!entry || !entry.enabled) {
        throw new Error(t('runtime 未注册或已禁用: {{runtime}}', { runtime }));
      }
      s.runtime = runtime;
      const executionCwd = cliContext?.workspaceContext?.cwd ?? target.cwd;
      const worktreeExecution = cliContext?.workspaceContext?.worktreeExecution;
      const directoryOptions = await this.runtimes.prepareWorkspaceDirectories(runtime, cliContext?.workspaceContext);
      assertWorkspaceExecutionContextCurrent(this.config.get(), cliContext?.workspaceContext);
      if (!this.isCurrentLaunch(s.id, gen)) return;
      const launchOptions = effectiveCliLaunchOptions(runtime, s.cliLaunchOptions, entry.manifest, s.configurePermissions === true, process.getuid?.());
      const extraArgs = [...directoryOptions.args, ...(entry.manifest ? entry.extraArgs ?? [] : cliArgsForSession(runtime, launchOptions, entry.extraArgs ?? []))];

      let sessionId = mode === 'new' ? undefined : s.externalSessionId;
      if (mode === 'resume') {
        const scope = s.terminalResumeScope ?? { runtime, cwd: previousCwd };
        if (sessionId && (scope.runtime !== runtime || !scope.cwd || pathKey(scope.cwd) !== pathKey(target.cwd))) {
          throw new Error(t('原对话的 Harness 或工作目录已变化，请恢复原配置后重试'));
        }
        const check = await this.runtimes.checkTerminalResume(runtime, executionCwd, sessionId, extraArgs);
        if (!this.isCurrentLaunch(s.id, gen)) return;
        assertSessionTargetCurrent(this.config.get(), target);
        switch (check.status) {
          case 'unsupported': throw new Error(t('当前终端配置不支持恢复原对话，请选择「开启新对话」'));
          case 'unbound': throw new Error(t('此终端尚未绑定原生会话，请选择「开启新对话」'));
          case 'missing': throw new Error(t('找不到原对话的历史记录。原会话 ID 已保留'));
          case 'failed': throw new Error(t('无法检查原对话的历史记录：{{error}}', { error: check.detail }));
        }
        if (!sessionId) throw new Error(t('此终端尚未绑定原生会话，请选择「开启新对话」'));
      } else {
        if (mode === 'fork' && !forkFromExternalSessionId?.trim()) throw new Error(t('fork 缺少源 CLI 会话 id'));
        if (!sessionId) {
          sessionId = await this.runtimes.allocate(runtime, executionCwd);
          if (!this.isCurrentLaunch(s.id, gen)) return;
          assertSessionTargetCurrent(this.config.get(), target);
          // A user-requested replacement keeps the old handle until its launch commits.
          if (mode !== 'new') {
            s.externalSessionId = sessionId;
            if (!s.hidden) { this.persist(); this.broadcast(); }
          }
        }
      }
      // 会话可能在等待期间被关闭 / 被 relaunch 取代
      if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some((x) => x.id === s.id)) return;
      let typeAfterSpawn: string | null = null;
      let promptReceipt: CliPromptLaunchReceipt | undefined;
      let prompt = initialPrompt?.trim();
      if (!prompt && (mode === 'start' || mode === 'new') && injectHostIntro && !s.hidden) {
        prompt = buildHostIntro({ rules: cfg.agentRules });
      }
      if (mode === 'resume' && initialPrompt !== undefined) {
        if ((await this.injectStrategy(runtime)) !== 'relaunch-resume') {
          throw new Error(t('runtime {{runtime}} 未声明 relaunch-resume 注入方式，请走 initialPrompt', { runtime }));
        }
        if (!this.isCurrentLaunch(s.id, gen)) return;
        this.sweepInjectFiles();
        const scopedBrief = cliContext?.workspaceContext
          ? `${initialPrompt}\n\n${renderWorkerDirectoryScope(cliContext.workspaceContext, directoryOptions.note, 'cli')}`
          : initialPrompt;
        const used = await this.runtimes.appendPrompt(runtime, scopedBrief, extraArgs);
        const promptArg = extraArgs.at(-1) ?? '';
        const injectFile = used ? injectFileFromPromptArg(promptArg) : undefined;
        if (!injectFile) throw new Error(t('未能写入任务文件'));
        this.scheduleInjectFileDelete(injectFile);
        promptReceipt = { mode: 'cli-prompt', injectFile, promptArg };
      } else if (mode !== 'resume' && prompt) {
        if (cliContext?.workspaceContext) prompt = `${prompt}\n\n${renderWorkerDirectoryScope(cliContext.workspaceContext, directoryOptions.note, 'cli')}`;
        const used = await this.runtimes.appendPrompt(runtime, prompt, extraArgs);
        if (!used) {
          const written = writeInjectPrompt(prompt);
          if (written) {
            typeAfterSpawn = written.promptArg;
            this.scheduleInjectFileDelete(written.file);
          }
        } else {
          const file = injectFileFromPromptArg(extraArgs.at(-1));
          if (file) this.scheduleInjectFileDelete(file);
        }
      }
      if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some((x) => x.id === s.id)) return;
      this.ensureStatusToken(s.id);
      assertSessionTargetCurrent(this.config.get(), target);
      assertWorkspaceExecutionContextCurrent(this.config.get(), cliContext?.workspaceContext);
      const launch = await this.runtimes.resolveLaunch(
        runtime,
        mode,
        sessionId,
        executionCwd,
        extraArgs,
        mode === 'fork' ? forkFromExternalSessionId : undefined,
        false,
        this.ptyMgr.getHostEnv?.(s.id),
        launchOptions,
        !!worktreeExecution
      );
      cliContext?.own(launch.dispose);
      if (mode === 'resume' && launch.externalSessionId && launch.externalSessionId !== sessionId) {
        throw new Error(t('Harness 返回了不同的会话 ID。原会话 ID 已保留'));
      }
      let runningContext: CliWorkspaceContext | undefined;
      let observedSessionId: string | undefined;
      if (mode !== 'resume') {
        cliContext?.own(launch.onSessionId?.(token => {
          if (!this.sessions.includes(s)) return;
          if (runningContext) {
            if (getCliWorkspaceContext(this.config, s.id) === runningContext)
              this.updateRuntimeHandle(s.id, { externalSessionId: token, runtimeResumeToken: token });
          } else if (this.isCurrentLaunch(s.id, gen)) {
            observedSessionId = token;
          }
        }));
      }
      if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some((x) => x.id === s.id)) return;
      assertSessionTargetCurrent(this.config.get(), target);
      await resolveSessionTarget(this.config.get(), { workspaceId: target.workspaceId, cwd: target.cwd, capturedSource: target.sourceRoot }, registeredWorktreeSession(this.sessions, target.cwd, target.workspaceId) ?? s);
      if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some((x) => x.id === s.id)) return;
      assertWorkspaceExecutionContextCurrent(this.config.get(), cliContext?.workspaceContext);
      if (launch.processIds?.length) cliContext?.own(this.ptyMgr.onAuxiliaryPids?.(s.id, launch.processIds));
      if (restarting) {
        this.classifyBySession.delete(s.id);
        s.status = 'starting';
        s.lifecycle = 'starting';
        delete s.activity;
        delete s.firstSignalAt;
      }
      s.runtimeStartedAt = Date.now();
      const ptyGeneration = await this.ptyMgr.spawn(s.id, launch, executionCwd, undefined, undefined, cliContext?.dispose,
        worktreeExecution ? () => assertWorktreeExecutionCurrent(worktreeExecution) : undefined);
      if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some(row => row.id === s.id) || this.ptyMgr.desktopProcessGeneration(s.id) !== ptyGeneration) { cliContext?.dispose(); await this.ptyMgr.killAndWait(s.id, ptyGeneration); return; }
      s.cwd = target.cwd;
      s.sourceRoot = { ...target.sourceRoot };
      s.externalSessionId = mode === 'resume' ? sessionId : observedSessionId ?? launch.externalSessionId ?? sessionId;
      if (mode === 'new') delete s.runtimeResumeToken;
      if (observedSessionId) s.runtimeResumeToken = observedSessionId;
      if (entry.terminalResume === 'by-id') s.terminalResumeScope = { runtime, cwd: target.cwd };
      else delete s.terminalResumeScope;
      cliContext?.commit(directoryOptions.note, launch.receiveMessage, launch.interruptInput, launch.prepareInterrupt, launch.deliveryCapabilities);
      s.status = 'running';
      runningContext = getCliWorkspaceContext(this.config, s.id);
      cliContext?.own(launch.onActivity?.((kind, event) => {
        if (runningContext && getCliWorkspaceContext(this.config, s.id) === runningContext && this.sessions.includes(s) && s.status === 'running' &&
            !(event === 'codex-turn-heartbeat' && (s.activity?.kind === 'blocked' || s.activity?.kind === 'waiting_input')))
          this.applyActivitySignal(s.id, kind, event);
      }));
      if (s.meta) delete s.meta.launchError;
      if (!s.hidden) {
        this.persist();
        this.getWindow()?.webContents.send('pty:respawn', { sessionId: s.id });
        this.broadcast();
        if (launch.warning) this.notify.push({ workspaceId: this.workspaceIdFor(s), sessionId: s.id,
          sessionName: s.name, kind: 'error', text: launch.warning, toast: true });
      }
      if (typeAfterSpawn) {
        void this.deferTypePrompt(s.id, typeAfterSpawn);
      }
      return promptReceipt;
    })()
      .catch((err): undefined => {
        // A replaced launch may reject late; it must not overwrite the recovered session.
        if (!this.isCurrentLaunch(s.id, gen)) return;
        const still = this.sessions.find((x) => x.id === s.id);
        if (still) {
          const running = restarting && this.ptyMgr.isRunning(s.id);
          still.status = running ? 'running' : 'exited';
          still.meta = {
            ...(still.meta ?? {}),
            launchError: capLaunchError(err instanceof Error ? err.message : String(err))
          };
          if (!running) this.applyLifecycle(still, 'exited', { notify: false, deferPublish: true });
          if (!still.hidden) {
            this.persist();
            this.broadcast();
            this.notify.push({
              workspaceId: this.workspaceIdFor(still),
              sessionId: still.id,
              sessionName: still.name,
              ...(running ? { kind: 'error' as const } : { lifecycle: 'exited' as const }),
              text: restarting || usesCodexWorktreeCwd(still) ? still.meta.launchError
                : still.launchKind === 'shell' ? t('Shell 启动失败：{{error}}', { error: still.meta.launchError }) : formatNotifyText(still.name, 'exited'),
              update: true,
              updateKey: `lifecycle:${still.id}`,
              toast: true
            });
          }
        }
        console.error('[sessions] launch failed', s.id, err);
        if (restarting) throw err;
      })
      .finally(() => {
        cliContext?.finishLaunch();
        if (this.launchTasks.get(s.id) === task) this.launchTasks.delete(s.id);
      });

    this.launchTasks.set(s.id, task);
    return task;
  }

  /**
   * OpenCode 等：等 TUI 就绪后再注入首条任务（CLI --prompt 传中文会直接挂）。
   * 旧版固定 1.8s 盲等：opentui（opencode 新 TUI）首绘要 ~4.3s，文本全被丢弃、
   * 只剩 Enter 在输入框堆空行。改判定（30s 超时放行；TUI 千差万别不做特征匹配）：
   * 进程起 ≥3s、输出静默 ≥1.2s、累计输出 ≥1.5KB。声明 pasteInput 的 runtime 走粘贴。
   */
  private async deferTypePrompt(sessionId: string, prompt: string): Promise<void> {
    const writer = this.ptyMgr.captureWriter(sessionId);
    try {
      const t0 = Date.now();
      const deadline = t0 + 30_000;
      while (Date.now() < deadline) {
        const idleFor = Date.now() - Math.max(this.ptyMgr.getLastOutputAt(sessionId), t0);
        const bytes = this.ptyMgr.getBuffer(sessionId)?.length ?? 0;
        if (Date.now() - t0 >= 3_000 && idleFor >= 1_200 && bytes >= 1_500) break;
        await sleep(120);
      }
      if (!this.ptyMgr.isRunning(sessionId)) return;
      const runtime = this.sessions.find((x) => x.id === sessionId)?.runtime;
      const paste = runtime ? await this.pasteInput(runtime) : false;
      await typeAndSubmit(writer, sessionId, prompt, paste ? { paste: true } : {
        afterTypeMs: 400,
        enterGapMs: 250,
        enterCount: 2
      });
    } catch (err) {
      console.error('[sessions] deferTypePrompt failed', sessionId, err);
    }
  }

  private async launchShellSession(s: SessionMeta, gen: number, cliContext: ReturnType<typeof beginCliWorkspaceContext>): Promise<void> {
    const target = await resolveSessionTarget(this.config.get(), { workspaceId: s.workspaceId, cwd: s.cwd, capturedSource: s.sourceRoot }, registeredWorktreeSession(this.sessions, s.cwd, s.workspaceId) ?? s);
    if (!s.shellProfileId || !isShellProfileId(s.shellProfileId)) {
      throw new Error(t('无效 Shell 配置档: {{id}}', { id: s.shellProfileId ?? '' }));
    }
    if (!this.sessions.some((x) => x.id === s.id)) return;
    const launch = await resolveShellLaunchAsync(s.shellProfileId);
    assertSessionTargetCurrent(this.config.get(), target);
    await resolveSessionTarget(this.config.get(), { workspaceId: target.workspaceId, cwd: target.cwd, capturedSource: target.sourceRoot }, registeredWorktreeSession(this.sessions, target.cwd, target.workspaceId) ?? s);
    assertWorkspaceExecutionContextCurrent(this.config.get(), cliContext.workspaceContext);
    if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some((x) => x.id === s.id)) return;
    const ptyGeneration = await this.ptyMgr.spawn(s.id, launch, target.cwd, undefined, undefined, cliContext.dispose);
      if (!this.isCurrentLaunch(s.id, gen) || !this.sessions.some(row => row.id === s.id) || this.ptyMgr.desktopProcessGeneration(s.id) !== ptyGeneration) { cliContext.dispose(); await this.ptyMgr.killAndWait(s.id, ptyGeneration); return; }
    cliContext.commit('');
    s.status = 'running';
    // 先标 idle；有输出时由 poll 切到 working（静默，避免刷气泡）
    this.applyLifecycle(s, 'idle', { notify: false });
    this.persist();
    this.getWindow()?.webContents.send('pty:respawn', { sessionId: s.id });
    this.broadcast();
  }

  /** 对外投影：终端会话的 status 按实时来源派生（GUI 会话由 host 维护、pty 按池状态） */
  private project(s: SessionMeta): SessionMeta {
    const pending = s.queuedInjects ?? 0;
    const live =
      pending > 0
        ? {
            label: formatInjectQueueCapsule(s.liveStatus?.label, pending).slice(0, 40),
            kind: s.liveStatus?.kind ?? ('waiting' as const),
            summary: s.liveStatus?.summary,
            ts: s.liveStatus?.ts || Date.now()
          }
        : s.liveStatus;
    const { archiveTerminalText: _archiveTerminalText, ...base } = s;
    if (live !== s.liveStatus) base.liveStatus = live;
    if (this.archiveCleanupPending?.has(s.id) || this.deletingSessions?.has(s.id)) base.worktreeCleanupPending = true;
    if (s.type !== 'terminal') return base;
    // GUI 会话无 pty：未结束时 status 由 AgentSessionHost 维护（open 后恒 running）。
    // 归档 / lifecycle=exited / 行上 status=exited 必须露出来——否则 get() 投影
    // 把已结束 GUI 会话盖成 running，sessions.message 会误走 delivered 并 open 复活。
    if (this.isChatRuntime(s.runtime)) {
      if (s.archived || s.lifecycle === 'exited' || s.status === 'exited') {
        return { ...base, status: 'exited' as const, runtimePresence: 'exited' };
      }
      if (s.status === 'idle') return { ...base, status: 'idle', runtimePresence: 'dormant',
        lifecycle: 'idle', activity: undefined, firstSignalAt: undefined, runtimeStartedAt: undefined };
      return { ...base, status: s.status === 'starting' ? 'starting' : 'running',
        runtimePresence: s.status === 'starting' ? 'starting' : 'running' };
    }
    const status = this.ptyMgr.getStatus(s.id);
    if (s.status === 'starting' || (this.launchTasks.has(s.id) && s.status === 'idle')) {
      return { ...base, status: 'starting' as const, runtimePresence: 'starting' };
    }
    if (status === 'idle' && s.status === 'exited') {
      return { ...base, status: 'exited', runtimePresence: 'exited' };
    }
    if (status === 'idle' && s.lifecycle !== 'exited' && !s.archived) {
      // Preserve raw history for interrupt snapshots, but never present it as a live process.
      return { ...base, status, runtimePresence: 'dormant', lifecycle: 'idle', activity: undefined,
        firstSignalAt: undefined, runtimeStartedAt: undefined, lastOutputAt: undefined };
    }
    return { ...base, status, runtimePresence: status === 'running' ? 'running' : 'exited',
      lastOutputAt: status === 'running' ? this.ptyMgr.getLastOutputAt(s.id) : undefined };
  }

  /**
   * 未消化注入条数（fromInject 排队项）。0 则删字段。
   * 左栏胶囊由 project() 叠字，不改 Worker 自报的 raw label。
   */
  setQueuedInjects(id: string, pending: number): SessionMeta | undefined {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return undefined;
    const n = Math.max(0, Math.floor(Number(pending) || 0));
    const prev = s.queuedInjects ?? 0;
    if (n === prev) return this.get(s.id);
    if (n > 0) s.queuedInjects = n;
    else delete s.queuedInjects;
    this.persist();
    this.broadcast();
    return this.get(s.id);
  }

  /** GUI 历史已在内存时更新有界看板预览；值不变时不广播或落盘。 */
  setBoardReplyPreview(id: string, preview: string): void {
    const session = this.sessions.find(item => item.id === id);
    if (!session || (session.boardReplyPreview ?? '') === preview) return;
    if (preview) session.boardReplyPreview = preview;
    else delete session.boardReplyPreview;
    this.persist();
    this.broadcast();
  }

  /** 模型建议只归属可信调用者自己的存活 CLI 会话。 */
  setCliSuggestedReplies(id: string, replies: string[]): boolean {
    const s = this.sessions.find(item => item.id === id);
    if (!s || s.type !== 'terminal' || s.launchKind === 'shell' || s.archived ||
        this.isChatRuntime(s.runtime) || !this.ptyMgr.isRunning(id)) return false;
    s.cliSuggestedReplies = { messageId: randomUUID(), replies: [...replies] };
    this.persist();
    this.broadcast();
    return true;
  }

  clearCliSuggestedReplies(id: string, expectedMessageId?: string): void {
    const s = this.sessions.find(item => item.id === id);
    if (!s?.cliSuggestedReplies || (expectedMessageId && s.cliSuggestedReplies.messageId !== expectedMessageId)) return;
    delete s.cliSuggestedReplies;
    this.persist();
    this.broadcast();
  }

  list(): SessionMeta[] {
    const closed = new Set(this.config.get().closedWorkspaces?.map(workspace => workspace.id));
    return this.sessions.filter(s => !s.hidden && !s.retainedWorktreeOnly && (!s.workspaceId || !closed.has(s.workspaceId))).map(s => this.project(s));
  }

  /** Hidden handoff sessions and their projected runtime status also own source folders. */
  rootDependencyRoster(): SessionMeta[] {
    return this.sessions.map(session => structuredClone(this.project(session)));
  }

  /**
   * 引擎孤儿清扫用名单：全部会话（含运行中的 hidden 临时会话）的 id 与引擎句柄。
   * 不走 project（运行状态无关，只要落盘去留判据）。
   */
  engineSweepRoster(): Array<
    Pick<SessionMeta, 'id' | 'runtime' | 'externalSessionId' | 'runtimeResumeToken'>
  > {
    return this.sessions.filter(s => !s.retainedWorktreeOnly).map((s) => ({
      id: s.id,
      runtime: s.runtime,
      externalSessionId: s.externalSessionId,
      runtimeResumeToken: s.runtimeResumeToken
    }));
  }

  get(id: string): SessionMeta | undefined {
    // 单条投影：get 是 IPC/host 的高频路径，别为一条走全表克隆
    const s = this.peek(id);
    return s ? this.project(s) : undefined;
  }

  /** 原始会话行（不经 project）。message 判定 ended 用这个，避免 GUI 投影盖掉 status。 */
  peek(id: string): SessionMeta | undefined {
    return this.sessions.find(x => x.id === id && !x.retainedWorktreeOnly);
  }

  /** close() 之后的结束墓碑；仍在册则应走 peek/get。 */
  peekEnded(id: string): EndedSessionRef | undefined {
    const key = id.trim();
    if (!key) return undefined;
    return this.endedRefs.find((x) => x.id === key);
  }

  private rememberEnded(s: SessionMeta): void {
    this.endedRefs = rememberEndedSessionRef(
      this.endedRefs,
      toEndedSessionRef({
        id: s.id,
        name: s.name,
        workspaceId: s.workspaceId,
        archived: s.archived,
        lifecycle: s.lifecycle ?? 'exited',
        status: s.status ?? 'exited'
      })
    );
    if (this.endedRefs.length > ENDED_SESSION_REFS_MAX) {
      this.endedRefs = this.endedRefs.slice(this.endedRefs.length - ENDED_SESSION_REFS_MAX);
    }
    try {
      this.store.saveEndedSessionRefs(this.endedRefs);
    } catch (e) {
      console.error('[sessions] 结束墓碑落盘失败', s.id, e);
    }
  }

  getActive(): SessionMeta | undefined {
    return this.activeId ? this.get(this.activeId) : undefined;
  }

  /**
   * 立刻把会话加进左栏（starting），再后台预分配/拉起，IPC 马上返回。
   * 双分支（shell / agent）实现拆至 sessions/createTerminal.ts（2026-09-26，行为保持）。
   */
  async createTerminal(opts: CreateTerminalOptions = {}): Promise<SessionMeta> {
    if (opts.isolationGroups !== undefined) {
      if (!opts.isolate || opts.shellProfileId || opts.repoSet !== undefined) throw new Error('isolationGroups requires an isolated agent and cannot be combined with legacy repoSet');
      if (!opts.workspaceId) throw new Error('isolationGroups requires workspaceId');
      const selection = captureWorktreeSelectionSources(this.config.get(), { ...opts, isolationGroups: normalizeWorktreeGroupSelections(opts.isolationGroups) });
      opts = { ...opts, isolationGroups: selection.selections, capturedIsolationSources: selection.sources };
    }
    const cfg = this.config.get();
    const source = opts.sourceSessionId ? this.sessions.find((s) => s.id === opts.sourceSessionId) :
      registeredWorktreeSession(this.sessions, opts.cwd, opts.workspaceId);
    if (opts.sourceSessionId && !source) throw new Error('source session not found');
    if (source) assertTaskWorktreeOperationIdle(this.config, source.id);
    const sourceGroup = source && opts.cwd ? registeredWorktreeGroup(source, opts.cwd) : undefined;
    const runningGroup = source?.cwd ? registeredWorktreeGroup(source, source.cwd) : undefined;
    const input = { ...opts, workspaceId: opts.workspaceId ?? source?.workspaceId,
      capturedSource: opts.capturedSource ?? (sourceGroup && sourceGroup.id !== runningGroup?.id ? sourceGroup.sourceRoot : source ? legacySessionSourceRoot(cfg, source) : undefined) };
    const release = holdPendingSource(this.config, { ...input, additionalRootIds: opts.isolationGroups?.map(selection => selection.rootId) }, { kind: 'launch', id: randomUUID(), label: opts.name ?? t('新会话') });
    try {
      const target = await resolveSessionTarget(cfg, input, source);
      if (opts.isolationGroups) assertWorktreeSelectionSources(this.config.get(), target.workspaceId, opts.isolationGroups, opts.capturedIsolationSources!);
      if (source) assertTaskWorktreeOperationIdle(this.config, source.id);
      const ctx = this.createTerminalCtx();
      if (opts.shellProfileId) return await createShellTerminalSession(ctx, opts, target);
      return await createAgentTerminalSession(ctx, opts, target);
    } finally { release(); }
  }

  /** createTerminal 分支函数的状态回接（this 转发；sessions 走 getter，重赋值后仍拿新引用） */
  private createTerminalCtx(): CreateTerminalFlowCtx {
    const svc = this;
    return {
      config: this.config,
      runtimes: this.runtimes,
      git: this.git,
      notify: this.notify,
      usageStats: this.usageStats,
      agentSessionsRef: this.agentSessionsRef,
      get sessions() {
        return svc.sessions;
      },
      isChatRuntime: (runtimeKey) => this.isChatRuntime(runtimeKey),
      applySelectDisplay: (s, activate) => this.applySelectDisplay(s, activate),
      persist: () => this.persist(),
      persistStrict: (validate, project, commit) => this.persister.flushStrict(validate, project, commit),
      broadcast: () => this.broadcast(),
      get: (id) => this.get(id),
      launchTerminal: async (s, mode, initialPrompt, forkFrom, injectHostIntro) => {
        await this.launchTerminal(s, mode, initialPrompt, forkFrom, injectHostIntro);
      }
    };
  }

  createScheduledTaskSession(task: PromptTask): SessionMeta {
    const session: SessionMeta = {
      id: randomUUID(),
      type: 'scheduled',
      name: task.name,
      createdAt: Date.now(),
      lastUsedAt: task.lastRunAt ?? Date.now(),
      serviceId: task.id,
      taskId: task.id,
      workspaceId: task.workspaceId,
      sourceRoot: task.sourceRoot ? structuredClone(task.sourceRoot) : undefined
    };
    this.sessions.push(session);
    this.persist();
    this.broadcast();
    return session;
  }

  updateScheduledTaskSession(task: PromptTask): void {
    const session = this.sessions.find((item) => item.type === 'scheduled' && item.serviceId === task.id);
    if (session) {
      session.name = task.name;
      session.workspaceId = task.workspaceId;
      session.sourceRoot = task.sourceRoot ? structuredClone(task.sourceRoot) : undefined;
      this.persist();
      this.broadcast();
    }
  }

  removeScheduledSession(serviceId: string): void {
    this.sessions = this.sessions.filter((s) => s.serviceId !== serviceId);
    if (this.activeId && !this.sessions.some((s) => s.id === this.activeId)) this.activeId = null;
    this.persist();
    this.broadcast();
  }

  /** Close only the selected view; keep the session, process and transcript intact. */
  deselect(id: string): boolean {
    if (this.activeId !== id) return false;
    this.activeId = null;
    const workspaceId = this.config.get().activeWorkspaceId;
    if (workspaceId) this.lastActiveByWs.delete(workspaceId);
    this.persist();
    this.broadcast();
    return true;
  }

  async select(id: string): Promise<SessionMeta> {
    const s = this.peek(id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    if (s.hidden) throw new Error(t('临时会话不可选中'));
    if (s.workspaceId && this.config.get().closedWorkspaces?.some(w => w.id === s.workspaceId)) throw new Error(t('工作区不存在'));
    if (s.archived) {
      if (this.applySelectDisplay(s, true) === 'show') {
        this.broadcast();
        this.getWindow()?.webContents.send('sessions:reveal', { sessionId: id });
      }
      return this.get(id)!;
    }
    assertTaskWorktreeOperationIdle(this.config, id);
    if (usesTaskWorktreeLifecycle(s)) healMissingSessionWorktree(this.worktreeCtx(), s);
    const display = this.applySelectDisplay(s, true);
    // 选中只是查看，不刷新 lastUsedAt——真活动（输出/working/任务运行）才刷新，
    // 否则看一眼就冒泡到列表最上，排序随查看行为跳动
    this.persist();
    if (s.type === 'terminal' && this.isChatRuntime(s.runtime)) {
      // GUI（chat）会话重启后没有进程可拉：选中即幂等 open（加载历史；连接懒建）
      healMissingSessionWorktree(this.worktreeCtx(), s);
      await resolveSessionTarget(this.config.get(), { workspaceId: s.workspaceId, cwd: s.cwd, capturedSource: s.sourceRoot }, registeredWorktreeSession(this.sessions, s.cwd, s.workspaceId) ?? s);
      this.chatBridge?.open(s);
    } else if (
      s.type === 'terminal' &&
      s.launchKind !== 'shell' &&
      s.externalSessionId &&
      this.runtimes.get(s.runtime ?? this.config.get().defaultRuntime)?.terminalResume === 'by-id' &&
      !this.ptyMgr.isRunning(id) &&
      !['blocked', 'switching', 'cancelled'].includes(s.workerRouting?.phase ?? '') &&
      !this.launchTasks.has(id)
    ) {
      void this.respawn(id).catch(error => console.warn('[sessions] could not resume selected terminal', id, errorMessage(error)));
    }
    this.broadcast();
    // 跨区只记待显示：不发 reveal，避免当前工作区被切到终端页
    if (display === 'show') {
      this.getWindow()?.webContents.send('sessions:reveal', { sessionId: id });
    }
    return this.get(id)!;
  }

  async restoreArchived(id: string): Promise<SessionMeta> {
    const session = this.peek(id);
    if (session?.archived && session.nativeHistoryDeleteReceipt) throw new Error(t('原生会话已删除，集序记录仍可在归档中查看。'));
    const history = session?.archived ? this.chatBridge?.nativeHistory?.(session) : undefined;
    if (session && history && (history.prepare || this.nativeHistoryTarget(session, 'unarchive'))) {
      if (this.archiveCleanupPending?.has(id) || this.deletingSessions?.has(id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
      assertTaskWorktreeOperationIdle(this.config, id);
      this.archiveCleanupPending.add(id);
      this.broadcast();
      try {
        if (history.prepare) await this.prepareNativeHistory(session, history, 'unarchive');
        const target = this.nativeHistoryTarget(session, 'unarchive');
        if (target) await this.syncNativeHistory(session, 'unarchive', target);
      } finally {
        this.archiveCleanupPending.delete(id);
        this.broadcast();
      }
      if (this.peek(id) !== session || !session.archived) throw new Error(t('会话状态已变化，请重新扫描。'));
    }
    return this.setArchived(id, false);
  }

  async continueArchived(id: string): Promise<SessionMeta> {
    const session = this.peek(id);
    if (!session?.archived) throw new Error(t('会话状态已变化，请重新扫描。'));
    if (this.archiveCleanupPending?.has(id) || this.deletingSessions?.has(id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
    assertTaskWorktreeOperationIdle(this.config, id);
    healMissingSessionWorktree(this.worktreeCtx(), session);
    const identity = taskWorktreeOwnership(session);
    await resolveSessionTarget(this.config.get(), { workspaceId: session.workspaceId, cwd: session.cwd, capturedSource: session.sourceRoot },
      registeredWorktreeSession(this.sessions, session.cwd, session.workspaceId) ?? session);
    if (this.peek(id) !== session || !session.archived || taskWorktreeOwnership(session) !== identity) throw new Error(t('会话状态已变化，请重新扫描。'));
    await this.restoreArchived(id);
    try { return await this.select(id); }
    catch (error) {
      if (this.peek(id) === session && !session.archived) {
        this.markArchived(session);
        this.persist(); this.broadcast();
        const target = this.nativeHistoryTarget(session, 'archive');
        if (target) {
          this.archiveCleanupPending.add(id);
          try { await this.syncNativeHistory(session, 'archive', target); }
          catch (restoreError) { throw new AggregateError([error, restoreError], `${errorMessage(error)} · ${errorMessage(restoreError)}`); }
          finally { this.archiveCleanupPending.delete(id); this.broadcast(); }
        }
      }
      throw error;
    }
  }

  async respawn(id: string, intent: TerminalRestartIntent = 'resume', injectHostIntro = false): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || s.type !== 'terminal') throw new Error(t('不是终端会话: {{id}}', { id }));
    assertTaskWorktreeOperationIdle(this.config, id);
    const chat = this.isChatRuntime(s.runtime);
    if (intent === 'new' && (s.launchKind === 'shell' || chat)) throw new Error(t('此操作仅适用于 CLI 对话'));
    if (intent === 'new' && s.externalSessionId && s.cwd && s.runtime && !s.terminalResumeScope) {
      s.terminalResumeScope = { runtime: s.runtime, cwd: s.cwd };
    }
    // An exact resume keeps its working directory. Task groups are still validated in place.
    if (intent === 'new' || chat || s.launchKind === 'shell' || usesTaskWorktreeLifecycle(s)) {
      healMissingSessionWorktree(this.worktreeCtx(), s);
    }
    if (s.launchKind === 'shell') {
      this.classifyBySession.delete(id);
      s.status = 'starting';
      this.broadcast();
      await this.launchTerminal(s, 'start');
      return;
    }
    // GUI（chat）会话无进程可拉：不走 starting（launchTerminal 只幂等 open，
    // entry 已存在时没人把 lifecycle 从 starting 翻回来，会卡死绑定/就绪判定）
    if (chat) {
      await this.launchTerminal(s, 'start');
      return;
    }
    const launch = this.launchTerminal(s, intent, undefined, undefined, injectHostIntro);
    this.broadcast();
    await launch;
  }

  /**
   * 启动对账（R12）：给 in-flight 会话写中断快照。已有快照不覆盖（保留首次中断时刻）。
   * 不自动开续作会话（INTERRUPT_SNAPSHOT_DEFAULTS.autoResumeOnBoot=false）。
   */
  async captureInterruptSnapshots(now = Date.now()): Promise<number> {
    if (!this.git) return 0;
    let n = 0;
    for (const s of this.sessions) {
      if (s.interruptSnapshot) continue;
      // 廉价排除先行：绝不可能 in-flight 的会话不去跑 git status（archived/hidden/非 terminal/shell
      // 必被 isInFlightForInterrupt 拒绝；working/needs_you/未 done 的 worktree 会话才可能命中）
      const possiblyInFlight =
        !s.archived &&
        !s.hidden &&
        s.type === 'terminal' &&
        s.launchKind !== 'shell' &&
        (s.lifecycle === 'working' ||
          s.phase?.value === 'needs_you' ||
          (Boolean(s.worktreePath) && s.phase?.value !== 'done'));
      if (!possiblyInFlight) continue;
      const taskGroups = s.worktreeGroups?.groups;
      const roots = taskGroups ? taskGroups.flatMap(group => [group.path, ...group.repos.map(repo => path.join(group.path, repo.path))]) : [s.worktreePath || s.cwd].filter((folder): folder is string => !!folder);
      let uncommitted: string[] = [];
      let worktreeClean = true;
      for (const root of roots) {
        const listed = await this.git.listUncommittedPaths(root);
        if (listed == null) {
          worktreeClean = false;
        } else {
          uncommitted.push(...listed.map(file => roots.length > 1 ? `${root}: ${file}` : file));
          if (listed.length) worktreeClean = false;
        }
      }
      if (
        !isInFlightForInterrupt({
          archived: s.archived,
          hidden: s.hidden,
          type: s.type,
          launchKind: s.launchKind,
          lifecycle: s.lifecycle,
          phase: s.phase,
          hasWorktree: Boolean(s.worktreePath),
          worktreeClean
        })
      ) {
        continue;
      }
      s.interruptSnapshot = buildInterruptSnapshot({
        session: s,
        now,
        uncommitted,
        worktreeClean
      });
      n += 1;
    }
    if (n) {
      this.persist();
      this.broadcast();
    }
    return n;
  }

  /** Persist the same recovery snapshot before a host-managed interruption. */
  async captureManagedInterruptSnapshot(id: string, now = Date.now(), workContext?: string) {
    const s = this.sessions.find(item => item.id === id);
    if (!s || s.archived || s.type !== 'terminal' || s.launchKind === 'shell') throw new Error(t('目标不是可中断的受管会话'));
    const identity = JSON.stringify([s.cwd, s.runtime, s.externalSessionId, s.worktreePath, s.worktreeGroups]);
    const groups = s.worktreeGroups?.groups;
    const roots = groups ? groups.flatMap(group => [group.path, ...group.repos.map(repo => path.join(group.path, repo.path))])
      : [s.worktreePath || s.cwd].filter((folder): folder is string => !!folder);
    const uncommitted: string[] = [];
    let worktreeClean = true, worktreeStatusUnknown = !this.git;
    for (const root of roots) {
      const files = this.git ? await this.git.listUncommittedPaths(root) : null;
      if (files === null) { worktreeStatusUnknown = true; continue; }
      uncommitted.push(...files.map(file => roots.length > 1 ? `${root}: ${file}` : file));
      if (files.length) worktreeClean = false;
    }
    if (!this.sessions.includes(s) || s.archived || JSON.stringify([s.cwd, s.runtime, s.externalSessionId, s.worktreePath, s.worktreeGroups]) !== identity)
      throw new Error(t('捕获快照期间会话已变化，未发送中断'));
    const snapshot = buildInterruptSnapshot({ session: s, now, uncommitted, worktreeClean,
      worktreeStatusUnknown, workContext, reason: 'preemption' });
    s.interruptSnapshot = snapshot;
    this.persist();
    this.broadcast();
    return { snapshot, brief: formatResumeBrief({ sessionName: s.name, snapshot }) };
  }

  /**
   * 带上下文续作：同 cwd/worktree 另开会话并移交隔离树归属，返回续作简报给调用方注入。
   * 默认不抢焦点。
   */
  async resumeInterrupted(
    sourceId: string,
    opts?: { activate?: boolean }
  ): Promise<{ session: SessionMeta; brief: string; sourceId: string }> {
    const src = this.sessions.find((x) => x.id === sourceId);
    if (!src) throw new Error(t('会话不存在: {{id}}', { id: sourceId }));
    assertTaskWorktreeOperationIdle(this.config, sourceId);
    const worktreeOwner = usesTaskWorktreeLifecycle(src) ? taskWorktreeOwnership(src) : undefined;
    const snap = src.interruptSnapshot;
    if (!snap) throw new Error(t('该会话没有中断快照'));
    if (src.type !== 'terminal' || src.launchKind === 'shell') {
      throw new Error(t('不是可续作的工作会话: {{id}}', { id: sourceId }));
    }
    const activate = opts?.activate ?? INTERRUPT_SNAPSHOT_DEFAULTS.resumeSelect;
    // 不回退到 snap.worktreePath：worktreePath 被清空只发生在树已删除/丢失之后，
    // 快照里的路径必指向不存在（或宿主已不再跟踪）的目录，续作只认会话现存的树。
    const cwd = src.cwd || src.worktreePath;
    const created = await this.createTerminal({
      name: t('{{name}} · 续作', { name: src.name }),
      runtime: src.runtime,
      cwd,
      workspaceId: src.workspaceId,
      sourceSessionId: src.id,
      configurePermissions: src.configurePermissions,
      cliLaunchOptions: src.cliLaunchOptions ? { ...src.cliLaunchOptions } : undefined,
      isolate: false,
      activate,
      inheritSourceGuiConfig: this.isChatRuntime(src.runtime)
    });
    const dst = this.sessions.find((x) => x.id === created.id);
    if (!dst) throw new Error(t('续作会话创建失败'));
    try {
      assertTaskWorktreeOperationIdle(this.config, sourceId);
      if (!this.sessions.includes(src) || (worktreeOwner && taskWorktreeOwnership(src) !== worktreeOwner)) throw new Error('worktree task ownership changed during continuation');
    } catch (error) {
      // session-model F-01：createTerminal 之后的归属复核失败时，回收本次创建的
      // 空壳续作会话（无简报、未接管快照），否则左栏遗留需手动归档+删除的孤儿行。
      try {
        this.close(dst.id, { allowUnarchived: true });
      } catch (closeErr) {
        console.error('[sessions] 续作归属复核失败后回收空壳会话失败', dst.id, closeErr);
      }
      throw error;
    }
    if (src.worktreePath) {
      transferSessionWorktrees(src, dst);
      for (const borrower of this.sessions) if (borrower.worktreeGroups?.borrowedFrom === src.id) borrower.worktreeGroups.borrowedFrom = dst.id;
    }
    dst.meta = { ...(dst.meta ?? {}), resumedFrom: src.id };
    delete src.interruptSnapshot;
    this.persist();
    this.broadcast();
    const brief = formatResumeBrief({ sessionName: src.name, snapshot: snap });
    return { session: this.get(dst.id)!, brief, sourceId: src.id };
  }

  async refreshFresh(id: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || s.type !== 'terminal') throw new Error(t('不是终端会话: {{id}}', { id }));
    // GUI（chat surface）：refresh = 中止当前回合；不清历史、不清续聊令牌、不重拉进程
    if (this.isChatRuntime(s.runtime)) {
      this.chatBridge?.refresh(id);
      return;
    }
    await this.respawn(id, 'new', true);
  }

  /** 清掉过期 inject 文件（默认 >2h）；本次文件另排延迟删除，等 CLI 读完 */
  private sweepInjectFiles(maxAgeMs = 2 * 60 * 60 * 1000): void {
    this.sweepInjectDir(injectPromptDir(), maxAgeMs);
  }

  private sweepInjectDir(dir: string, maxAgeMs = 2 * 60 * 60 * 1000): void {
    const now = Date.now();
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.md')) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          const ageLimit = name.startsWith('composer-') ? Math.max(maxAgeMs, 24 * 60 * 60 * 1000) : maxAgeMs;
          if (now - st.mtimeMs > ageLimit) fs.unlinkSync(full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  private scheduleInjectFileDelete(file: string, delayMs = INJECT_FILE_TTL_MS): void {
    setTimeout(() => {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
    }, delayMs).unref?.();
  }

  /**
   * 任意提示词落盘，返回短指令（TTY 键入 / 调用方预览用）。
   */
  writeInject(brief: string): { injectFile: string; promptArg: string } {
    const written = writeInjectPrompt(brief);
    if (!written) throw new Error(t('写入内容为空'));
    this.scheduleInjectFileDelete(written.file);
    return { injectFile: written.file, promptArg: written.promptArg };
  }

  /** 通过恢复原生会话的命令提交任务文件，仅供声明 relaunch-resume 的 CLI 使用。 */
  async relaunchWithPrompt(
    id: string,
    brief: string
  ): Promise<CliPromptLaunchReceipt> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || s.type !== 'terminal') throw new Error(t('不是终端会话: {{id}}', { id }));
    if (s.launchKind === 'shell' || this.isChatRuntime(s.runtime)) throw new Error(t('此操作仅适用于 CLI 对话'));
    assertTaskWorktreeOperationIdle(this.config, id);
    if (usesTaskWorktreeLifecycle(s)) healMissingSessionWorktree(this.worktreeCtx(), s);
    const result = await this.launchTerminal(s, 'resume', brief);
    if (!result) throw new Error(t('会话已关闭或被重新拉起，任务简报未注入'));
    return result;
  }

  /**
   * 立刻从列表移除并返回；pty 在后台杀。
   * 删除只对已归档会话开放（UI 菜单同样只在归档态显示「删除」）；
   * 宿主内部的 Shell 退出和失败回滚可使用 allowUnarchived。
   */
  close(id: string, opts?: { allowUnarchived?: boolean }): void {
    const rows = sessionSubtreePostOrder(this.sessions, id);
    const root = rows.find(s => s.id === id);
    if (!root) throw new Error(t('会话不存在: {{id}}', { id }));
    if (root.type === 'scheduled') throw new Error(t('scheduled 会话由服务管理，请使用 automations.delete 删除服务'));
    if (!opts?.allowUnarchived && !root.archived) {
      throw new Error(t('会话尚未归档：请先归档再删除（删除仅对已归档会话开放）'));
    }
    // 整枝预检先于删除：后代忙于合入/清理时，不先删掉父或兄弟。
    for (const row of rows) {
      if (row.type === 'scheduled') throw new Error(t('scheduled 会话由服务管理，请使用 automations.delete 删除服务'));
      assertTaskWorktreeOperationIdle(this.config, row.id);
      if (!usesTaskWorktreeLifecycle(row)) assertSingleWorktreeGroup(row);
    }
    this.assertArchiveAllowed(rows);
    if (rows.length === 1) { this.closeOne(id, opts); return; }
    // 子会话退出/移除的通知不能在清理过程中再次唤醒父。
    for (const row of rows) this.markArchived(row);
    const waiters = this.subtreeCloseWaiters ??= new Map();
    for (const row of rows) {
      if (!this.sessions.some(s => s.id === row.id)) continue;
      const descendants = sessionSubtreePostOrder(this.sessions, row.id)
        .filter(s => s.id !== row.id && rows.indexOf(s) < rows.indexOf(row));
      if (!descendants.length) { this.closeOne(row.id, { allowUnarchived: true }); continue; }
      if (waiters.has(row.id)) continue;
      // 内部关闭工作区允许删未归档父；等待后代时也须立刻停父，不能隐藏后继续运行。
      row.status = 'exited';
      this.applyLifecycle(row, 'exited', { notify: false });
      void this.releaseTaskWorktreeSession(row).catch(error => {
        console.error('[sessions] 等待子代理删除时释放父会话失败', row.id, error);
      });
      const off = this.onSessionRemoved(() => {
        if (descendants.some(child => this.sessions.some(s => s.id === child.id))) return;
        off(); waiters.delete(row.id);
        queueMicrotask(() => {
          const latest = this.sessions.find(s => s.id === row.id);
          if (!latest?.archived) return;
          try { this.close(row.id); }
          catch (error) { console.error('[sessions] 子代理删除后父会话清理失败', row.id, error); }
        });
      });
      waiters.set(row.id, off);
    }
    this.persist(); this.broadcast();
  }

  private closeOne(id: string, opts?: { allowUnarchived?: boolean }): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    if (s.type === 'scheduled') {
      throw new Error(t('scheduled 会话由服务管理，请使用 automations.delete 删除服务'));
    }
    if (!opts?.allowUnarchived && !s.archived) {
      throw new Error(t('会话尚未归档：请先归档再删除（删除仅对已归档会话开放）'));
    }
    assertTaskWorktreeOperationIdle(this.config, id);
    if (usesTaskWorktreeLifecycle(s)) {
      // Keep the archived owner until every registration and ref is settled, including partial failures.
      this.markArchived(s); s.status = 'exited';
      const pending = cleanupTaskWorktrees(this.worktreeCtx(), s, 'close', { release: () => this.releaseTaskWorktreeSession(s) });
      this.persist(); this.broadcast();
      void pending.then(result => {
        if (result.ok && this.sessions.includes(s)) {
          try { this.close(id, opts); }
          catch (error) {
            this.notify.push({ workspaceId: s.workspaceId || this.config.get().activeWorkspaceId || 'app', sessionId: id,
              sessionName: s.name || id, kind: 'error', toast: true,
              text: t('会话删除失败：{{error}}', { error: errorMessage(error) }) });
          }
        }
      }).catch(error => { console.error('[sessions] 多组 worktree 删除失败', id, error); });
      return;
    }
    // Legacy cleanup handles its one group after removing the row.
    assertSingleWorktreeGroup(s);
    const releaseSource = holdPendingSource(this.config, { workspaceId: s.workspaceId,
      capturedSource: legacySessionSourceRoot(this.config.get(), s), cwd: s.worktreeSource?.mainRepo ?? s.cwd },
      { kind: s.worktreePath ? 'worktree' : 'session', id: s.id, label: s.worktreePath ?? s.name, sessionId: s.id });
    try { purgeSessionReminders(id); }
    catch (error) {
      releaseSource();
      throw new Error(t('待办清理失败：{{error}}', { error: errorMessage(error) }));
    }
    // 先记墓碑再删行：sessions.message 对已 close 的 id 回执 session_ended，不抛「不存在」
    this.rememberEnded(s);
    this.sessions = this.sessions.filter(row => row.id !== id);
    this.finishDeletedSession(s, releaseSource);
  }

  private finishDeletedSession(s: SessionMeta, releaseSource: () => void, keepWorktree = false): void {
    const id = s.id;
    this.awareness?.clearShare(id);
    this.awareness?.clearSubscriptions(id);
    if (this.activeId === id) this.activeId = null;
    this.launchTasks.delete(id);
    this.launchGen.delete(id);
    this.classifyBySession.delete(id);
    // O6 卫生：会话移除时清 working 起始时刻（读侧有 lifecycle 守卫，这里是防泄漏）
    this.ptyWorkingSince.delete(id);
    this.notifyBus.clearSession(id);
    // 智能界面部件（ui.render 产物）：会话删除联动清 artifact 目录，失败不阻断删除
    void rm(path.join(userDataStorage(app.getPath('userData')).scopedPath('session', 'agent-sessions', id, value => value), 'ui'), { recursive: true, force: true }).catch(() => {});
    if (!s.hidden) {
      if (!keepWorktree) this.persist();
      this.broadcast();
    }
    notifyDelegateSlotFreed(s.workspaceId ?? this.resolveWorkspaceId(s.cwd));
    // 善后钩子（O1：订阅和后台任务收口等）。归档过的会话走 exited 已收口，这里幂等重放。
    this.notifySessionRemoved(s);
    // GUI 会话：释放 driver / MCP；左栏删除会话时才 purge 落盘历史（退出/切换不关盘）。
    // meta 快照随行传递：注册表行已移除，host 内反查不到引擎句柄
    // 有 worktree 时必须 await close/拆链后再删目录（同归档路径的 Windows 锁问题）
    void (async () => {
      if (this.isChatRuntime(s.runtime)) {
        const bridge = this.chatBridge;
        const snap = s;
        if (snap.worktreePath && !keepWorktree) {
          const cleanupState: { error?: GuiSessionDataCleanupError } = {};
          try {
            await releaseThenCleanup(
              bridge ? async () => {
                try { await bridge.close(id, { purgeHistory: true, meta: snap }); }
                catch (error) {
                  if (!(error instanceof GuiSessionDataCleanupError)) throw error;
                  // Resources were reclaimed, so unrelated worktree cleanup is safe.
                  cleanupState.error = error;
                }
              } : null,
              async () => { await cleanupSessionWorktreeOnClose(this.worktreeCtx(), snap); }
            );
          } catch (error) {
            if (cleanupState.error) throw new Error(t('{{detail}}；worktree 清理失败：{{error}}', { detail: cleanupState.error.message, error: errorMessage(error) }));
            throw error;
          }
          if (cleanupState.error) throw cleanupState.error;
        } else {
          await bridge?.close(id, { purgeHistory: true, meta: s });
        }
      } else {
        // 后台杀进程，不堵 IPC
        await this.ptyMgr.killAndWait(id);
        if (s.worktreePath && !keepWorktree) await cleanupSessionWorktreeOnClose(this.worktreeCtx(), s);
      }
    })().catch(error => {
      console.error('[sessions] 删除拆链/清理失败', id, error);
      this.notify.push({ workspaceId: s.workspaceId || this.config.get().activeWorkspaceId || 'app', sessionId: id,
        sessionName: s.name || id, kind: 'error', toast: true,
        text: t('会话已从列表移除，但部分数据清理失败：{{error}}', { error: errorMessage(error) }) });
    }).finally(releaseSource)
      .finally(() => {
        void deleteSessionHandover(app.getPath('userData'), id).catch(error => {
          console.error('[handover] 删除会话交接文档失败', id, error);
          this.notify.push({ workspaceId: s.workspaceId || this.config.get().activeWorkspaceId || 'app', sessionId: id,
            sessionName: s.name || id, kind: 'error', toast: true,
            text: t('会话已删除，但交接文档清理失败：{{error}}', { error: errorMessage(error) }) });
        });
        // F-01：turn-changes 快照连带清理——放在引擎/盘历史清理之后，避免在途 finalize 回写复活记录；
        // 漏网（如清理中崩溃）由启动清扫兜底。失败只告警，不阻断删除。
        void purgeTurnChangesForSessions(turnChangesDir(), [id]).catch(error => { console.warn('[sessions] turn-changes 快照连带清理失败', id, error); });
      });
  }

  /** GUI 会话：回填引擎侧句柄（Pi/Cursor 会话 id；不持久化绝对路径） */
  async commitWorkerRoute(id: string, expectedAttempt: number, next: NonNullable<SessionMeta['workerRouting']>,
    replacement?: { runtime: string; meta: import('../shared/types').GuiSessionInitialMeta }, validate?: () => void): Promise<void> {
    const session = this.peek(id);
    if (!session || session.archived || session.workerRouting?.attempts.at(-1)?.attempt !== expectedAttempt) throw new Error('Worker route attempt is no longer current.');
    validate?.();
    const original = session.workerRouting;
    const phase = original.phase;
    const changes: Partial<SessionMeta> = { workerRouting: structuredClone(next), ...(replacement ? {
      runtime: replacement.runtime, runtimeResumeToken: undefined, externalSessionId: undefined, cliLaunchOptions: undefined,
      nativeHistoryStorageKey: undefined, nativeHistoryCwd: undefined, nativeHistoryDeleteReceipt: undefined, codexContinuationHistory: undefined,
      piModeId: replacement.meta.piModeId, modelOverride: replacement.meta.modelOverride, modelParameters: replacement.meta.modelParameters,
      thinkingLevel: replacement.meta.thinkingLevel, guiMode: replacement.meta.guiMode,
      configurePermissions: replacement.meta.configurePermissions ?? session.configurePermissions,
      nativePermissionRestore: replacement.runtime === session.runtime ? session.nativePermissionRestore : undefined,
      nativeConfig: replacement.meta.nativeConfig ?? (replacement.runtime === session.runtime && replacement.meta.piModeId === session.piModeId ? session.nativeConfig : undefined)
    } : {}) };
    await this.persister.flushStrict(() => {
      if (this.peek(id) !== session || session.archived || session.workerRouting !== original || original.phase !== phase) throw new Error('Worker route attempt changed before persistence.');
      validate?.();
    }, sessions => sessions.map(row => row === session ? { ...row, ...changes } : row), () => { Object.assign(session, changes); });
    this.broadcast();
  }

  noteWorkerRoute(id: string, attemptNumber: number, phase: 'running' | 'idle' | 'blocked' | 'cancelled',
    reason?: import('../shared/workerRouting').WorkerRouteReason, nativeModel?: string): void {
    const session = this.peek(id);
    const route = session?.workerRouting;
    const attempt = route?.attempts.at(-1);
    if (!session || session.archived || !route || attempt?.attempt !== attemptNumber || route.phase === 'completed' || route.phase === 'cancelled') return;
    if (phase === 'running' && route.phase === 'switching' || phase === 'idle' && route.phase !== 'running' && route.phase !== 'starting') return;
    if (route.phase === phase && route.reason === reason && (!nativeModel || attempt.nativeConfirmed?.modelId === nativeModel)) return;
    route.phase = phase;
    route.reason = reason;
    attempt.state = phase;
    if (reason) attempt.reason = reason;
    if (nativeModel) attempt.nativeConfirmed = { modelId: nativeModel };
    this.persist(); this.broadcast();
  }

  updateRuntimeHandle(
    id: string,
    handle: { externalSessionId?: string; runtimeResumeToken?: string; nativeHistoryStorageKey?: string; nativeHistoryCwd?: string }
  ): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    let changed = false;
    if (handle.externalSessionId && s.externalSessionId !== handle.externalSessionId) {
      s.externalSessionId = handle.externalSessionId;
      changed = true;
    }
    if (handle.runtimeResumeToken && s.runtimeResumeToken !== handle.runtimeResumeToken) {
      s.runtimeResumeToken = handle.runtimeResumeToken;
      delete s.nativeHistoryDeleteReceipt;
      changed = true;
    }
    if (handle.nativeHistoryStorageKey && !s.nativeHistoryStorageKey) {
      s.nativeHistoryStorageKey = handle.nativeHistoryStorageKey;
      changed = true;
    }
    if (handle.nativeHistoryCwd && !s.nativeHistoryCwd) {
      s.nativeHistoryCwd = handle.nativeHistoryCwd;
      changed = true;
    }
    if (changed) this.persist();
  }

  /** A replacement native thread must be recoverable before its first user input. */
  async commitRuntimeContinuation(id: string, sourceId: string, continuationId: string,
    history: { storageKey: string; stagingId?: string }, validate: () => void): Promise<void> {
    const session = this.peek(id);
    if (!session) throw new Error(t('Codex 会话已变化。本次消息尚未提交。'));
    const handle = { externalSessionId: continuationId, runtimeResumeToken: continuationId, nativeHistoryStorageKey: history.storageKey,
      nativeHistoryDeleteReceipt: undefined,
      codexContinuationHistory: [...(session.codexContinuationHistory ?? []), {
        sourceId, ...(history.stagingId ? { stagingId: history.stagingId } : {})
      }] };
    await this.persister.flushStrict(() => {
      if (this.peek(id) !== session || session.archived || session.runtimeResumeToken !== sourceId ||
          (session.nativeHistoryStorageKey && session.nativeHistoryStorageKey !== history.storageKey)) {
        throw new Error(t('Codex 会话已变化。本次消息尚未提交。'));
      }
      validate();
    }, rows => rows.map(row => row === session ? { ...row, ...handle } : row), () => {
      Object.assign(session, handle);
    });
  }

  async updateConfigurePermissions(id: string, enabled: boolean, validate: () => void, commit: () => void,
    restore: () => SessionMeta['nativePermissionRestore']): Promise<void> {
    const session = this.sessions.find(row => row.id === id);
    if (!session || session.archived || session.launchKind !== 'agent') throw new Error(t('Harness 会话未打开'));
    let nativePermissionRestore: SessionMeta['nativePermissionRestore'];
    await this.persister.flushStrict(() => {
      if (!this.sessions.includes(session) || session.archived) throw new Error(t('Harness 会话未打开'));
      if (session.runtime && !this.isChatRuntime(session.runtime) && (this.ptyMgr.isRunning(id) || this.launchTasks.has(id))) {
        throw new Error(t('终端运行中，请先停止终端再更改权限设置'));
      }
      validate();
      nativePermissionRestore = restore();
    }, rows => rows.map(row => row === session ? { ...row, configurePermissions: enabled, nativePermissionRestore } : row), () => {
      session.configurePermissions = enabled;
      session.nativePermissionRestore = nativePermissionRestore;
      commit();
    });
    this.broadcast();
  }

  async updateNativePermissionRestore(id: string, next: SessionMeta['nativePermissionRestore'], validate: () => void): Promise<void> {
    const session = this.sessions.find(row => row.id === id);
    if (!session) throw new Error(t('Harness 会话未打开'));
    await this.persister.flushStrict(() => {
      if (!this.sessions.includes(session) || session.archived) throw new Error(t('Harness 会话未打开'));
      validate();
    }, rows => rows.map(row => row === session ? { ...row, nativePermissionRestore: next } : row),
    () => { session.nativePermissionRestore = next; });
  }

  /** GUI 会话：模式持久化（guiMode + 派生 permissionMode 双写，重启仍在/旧数据兼容） */
  updateGuiMode(id: string, mode: GuiWorkerMode): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || s.guiMode === mode) return;
    s.guiMode = mode;
    s.permissionMode =
      mode === 'auto'
        ? 'auto'
        : mode === 'default' || mode === 'accept-edits'
          ? 'acceptEdits'
          : 'ask';
    this.persist();
  }

  /** GUI 会话清空（/new）：作废引擎侧句柄，下轮连接走全新会话 */
  resetRuntimeHandle(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    if (s.externalSessionId === undefined && s.runtimeResumeToken === undefined && !s.nativeHistoryStorageKey && !s.nativeHistoryCwd &&
        !s.nativeHistoryDeleteReceipt && !s.codexContinuationHistory) return;
    s.externalSessionId = undefined;
    s.runtimeResumeToken = undefined;
    delete s.nativeHistoryStorageKey;
    delete s.nativeHistoryCwd;
    delete s.nativeHistoryDeleteReceipt;
    delete s.codexContinuationHistory;
    this.persist();
  }

  /** Clear must not remove its tombstone until the empty handle is on disk. */
  async resetRuntimeHandleStrict(id: string, validate?: () => void): Promise<void> {
    if (this.strictRuntimeResets.has(id)) throw new Error('该会话正在清空，请稍后再试');
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    this.strictRuntimeResets.add(id);
    try {
      s.externalSessionId = undefined;
      s.runtimeResumeToken = undefined;
      delete s.nativeHistoryStorageKey;
      delete s.nativeHistoryCwd;
      delete s.nativeHistoryDeleteReceipt;
      delete s.codexContinuationHistory;
      await this.persister.flushStrict(() => {
        validate?.();
        if (!this.sessions.includes(s) || s.externalSessionId || s.runtimeResumeToken) {
          throw new Error('会话清空期间引擎标识发生变化');
        }
      });
    } finally {
      this.strictRuntimeResets.delete(id);
    }
  }

  /** Pi GUI 会话：会话级思考档持久化（每回合热生效，无需重连；null=跟随默认） */
  updateThinkingLevel(id: string, level: GuiThinkingLevel | null): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    if (level === null) {
      if (s.thinkingLevel === undefined) return;
      s.thinkingLevel = undefined;
    } else {
      if (s.thinkingLevel === level) return;
      s.thinkingLevel = level;
    }
    this.persist();
  }

  /** Modern parameters supersede the legacy thinking field, including an empty override. */
  updateModelParameters(id: string, values: import('../shared/modelParameters').ModelParameterValues): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    s.modelParameters = { ...values };
    s.thinkingLevel = undefined;
    this.persist();
  }

  async commitModelConfiguration(id: string, model: import('../shared/harnessPicker').HarnessPickerModelIdentity | null,
    values: import('../shared/modelParameters').ModelParameterValues, validate: () => void, committed: () => void): Promise<void> {
    const session = this.peek(id);
    if (!session || session.archived) throw new Error(t('会话不可用'));
    const changes = { modelOverride: model ? { ...model } : undefined, modelParameters: { ...values }, thinkingLevel: undefined };
    await this.persister.flushStrict(() => {
      if (this.peek(id) !== session || session.archived) throw new Error(t('会话不可用'));
      validate();
    }, rows => rows.map(row => row === session ? { ...row, ...changes } : row), () => {
      Object.assign(session, changes);
      committed();
    });
  }

  /** Pi GUI 会话：自定义模式持久化（空串=标准无模式；空白期可改，产生内容后 Host 侧拦截） */
  updatePiMode(id: string, modeId: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s || s.piModeId === modeId) return;
    s.piModeId = modeId;
    this.persist();
  }

  /** 会话级模型覆盖（null=清除覆盖恢复跟随全局；连接由 Host 在下回合重建） */
  updateModelOverride(
    id: string,
    override: { providerId: string; modelId: string; params?: Array<{ id: string; value: string }> } | null
  ): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    if (!override) {
      if (s.modelOverride === undefined) return;
      s.modelOverride = undefined;
    } else {
      const sameParams =
        JSON.stringify(s.modelOverride?.params ?? []) === JSON.stringify(override.params ?? []);
      if (
        s.modelOverride &&
        s.modelOverride.providerId === override.providerId &&
        s.modelOverride.modelId === override.modelId &&
        sameParams
      ) {
        return;
      }
      s.modelOverride = { ...override };
    }
    this.persist();
  }

  /** 工作区关闭：连同该区终端会话一起删，不留悬空归属的孤儿数据（全局看板会暴露它们） */
  removeByWorkspace(workspaceId: string): void {
    const doomed = this.sessions.filter(
      (s) =>
        s.type === 'terminal' &&
        (s.workspaceId ?? this.resolveWorkspaceId(s.cwd)) === workspaceId
    );
    const failures: string[] = [];
    for (const s of doomed) {
      if (!this.peek(s.id)) continue; // A parent close may already remove its child.
      try {
        // 工作区都没了，会话必删：这是宿主内部清理，不受「先归档再删除」限制
        this.close(s.id, { allowUnarchived: true });
      } catch (error) {
        failures.push(`${s.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) throw new Error(`Workspace session cleanup failed: ${failures.join('; ')}`);
    this.lastActiveByWs.delete(workspaceId);
  }

  /** 编排跟踪标记（SessionMeta.orchestrated）：调度拉起/派活或动态收编时置 true；
   *  false 收回标记（字段删除，保持落盘精简）。编排事件只上报 true 的会话。 */
  setOrchestrated(id: string, value: boolean): SessionMeta | null {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return null;
    if (value) s.orchestrated = true;
    else delete s.orchestrated;
    this.persist();
    this.broadcast();
    return s;
  }

  rename(id: string, name: string): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    const trimmed = name.trim();
    if (!trimmed) throw new Error(t('名称不能为空'));
    s.name = trimmed.slice(0, 80);
    delete s.autoNamed;
    this.persist();
    this.broadcast();
    return this.get(id)!;
  }

  /**
   * 默认名会话的首条用户指令自动命名（仅 agentSession:send 用户聊天输入调用；
   * 邮箱/AI 工具发送不代表用户指令，不走这里）。仅 autoNamed 会话生效，
   * 改名即清除标记，之后手工/自动改名都不再干预；派生不出名字（纯图片等）不动。
   */
  autoNameFromInstruction(id: string, text: string): SessionMeta | undefined {
    const s = this.sessions.find((x) => x.id === id);
    if (!s?.autoNamed) return this.get(id);
    const derived = deriveAutoSessionName(text);
    if (!derived) return this.get(id);
    s.name = derived;
    delete s.autoNamed;
    this.persist();
    this.broadcast();
    return this.get(id);
  }

  setPinned(id: string, pinned: boolean): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    if (s.type !== 'terminal') throw new Error(t('仅终端/工作会话支持置顶'));
    if (pinned) {
      s.pinned = true;
      s.pinnedAt = Date.now();
    } else {
      delete s.pinned;
      delete s.pinnedAt;
    }
    this.persist();
    this.broadcast();
    return this.get(id)!;
  }

  /** 验收留痕：append-only，截断上限见 ACCEPTANCE_LOG_MAX */
  recordAcceptance(
    id: string,
    rec: { at: number; decision: ReviewDecision; note?: string }
  ): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    const note = rec.note?.trim();
    s.acceptanceLog = appendAcceptanceLog(s.acceptanceLog, {
      at: rec.at,
      decision: rec.decision,
      ...(note ? { note } : {})
    });
    this.persist();
    this.broadcast();
    return this.get(id)!;
  }

  setReviewDeferred(id: string, deferred: boolean): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    if (deferred) s.reviewDeferred = true;
    else delete s.reviewDeferred;
    this.persist();
    this.broadcast();
    return this.get(id)!;
  }

  /**
   * 标记已处理：相位收尾为 done 并归档（P12③）。已归档则只改相位。
   */
  markProcessed(id: string, opts?: { note?: string; source?: SessionPhase['source'] }): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    if (!s.archived) this.setArchived(id, true);
    this.setPhase(id, { value: 'done', source: opts?.source ?? 'user' });
    this.recordAcceptance(id, {
      at: Date.now(),
      decision: 'processed',
      note: opts?.note
    });
    return this.get(id)!;
  }

  setArchived(id: string, archived: boolean, selectionHint?: ArchiveSelectionHint): SessionMeta {
    if (!archived) {
      if (this.archiveCleanupPending?.has(id) || this.deletingSessions?.has(id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
      const session = this.peek(id);
      if (session && usesTaskWorktreeLifecycle(session)) healMissingSessionWorktree(this.worktreeCtx(), session);
      this.subtreeCloseWaiters?.get(id)?.();
      this.subtreeCloseWaiters?.delete(id);
      return this.setArchivedOne(id, false);
    }
    const rows = sessionSubtreePostOrder(this.sessions, id);
    if (!rows.length) throw new Error(t('会话不存在: {{id}}', { id }));
    if (this.archiveCleanupPending?.has(id) || this.deletingSessions?.has(id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
    const targets = rows.filter(s => !s.archived);
    // 先检查整个子树，再开始改状态与释放资源。
    for (const row of targets) {
      if (row.type !== 'terminal') throw new Error(t('仅终端/工作会话支持归档'));
      assertTaskWorktreeOperationIdle(this.config, row.id);
    }
    this.assertArchiveAllowed(targets);
    // Decide before mutating archived/pinned fields: both affect the rail's ordering.
    const selected = targets.find(row => row.id === this.activeId);
    if (selected) {
      const workspaceId = selected.workspaceId ?? this.resolveWorkspaceId(selected.cwd);
      const sameWorkspace = this.sessions.filter(row =>
        (row.workspaceId ?? this.resolveWorkspaceId(row.cwd)) === workspaceId
      );
      const excludedIds = new Set(targets.map(row => row.id));
      const orderedIds = sessionIdsByRail(sameWorkspace);
      const hintedId = selectionHint?.activeId === selected.id &&
        orderedIds.includes(selectionHint.nextId) && !excludedIds.has(selectionHint.nextId)
        ? selectionHint.nextId : null;
      this.activeId = hintedId ?? adjacentSessionId(orderedIds, selected.id, excludedIds);
    }
    for (const row of targets) this.markArchived(row);
    for (const row of targets) this.setArchivedOne(row.id, true);
    if (targets.length) this.startArchiveCleanup(targets);
    // 归档重试：子树过滤后已归档的目标会话不再走 setArchivedOne。任务 worktree 会话首次
    // 清理可能因脏文件保留树；用户处理完脏状态后再次归档应重跑安全清理收尾，
    // 而不是静默无操作（回归见 test/e2e/task-worktree-gui-lifecycle.spec.ts）。
    const self = rows.find(row => row.id === id);
    if (self?.archived && !targets.includes(self) && (usesTaskWorktreeLifecycle(self) || this.nativeHistoryTarget(self, 'archive') ||
      this.chatBridge?.nativeHistory?.(self)?.prepare)) {
      assertTaskWorktreeOperationIdle(this.config, id);
      if (this.archiveCleanupPending?.has(id)) throw new Error(t('会话正在归档，请等待资源清理完成'));
      this.startArchiveCleanup([self]);
    }
    return this.get(id)!;
  }

  private setArchivedOne(id: string, archived: boolean): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    assertTaskWorktreeOperationIdle(this.config, id);
    if (s.type !== 'terminal') throw new Error(t('仅终端/工作会话支持归档'));
    if (archived) {
      this.markArchived(s);
      delete s.pinned;
      delete s.pinnedAt;
      if (!this.isChatRuntime(s.runtime)) {
        const output = this.ptyMgr.getBufferTail?.(id, 24_000);
        if (output) s.archiveTerminalText = plainTextFromPtyBuffer(output).text;
      }
      if (this.ptyMgr.isRunning(id) || this.launchTasks.has(id)) {
        this.launchTasks.delete(id);
        this.launchGen.delete(id);
        this.ptyMgr.kill(id);
      }
      s.status = 'exited';
      this.classifyBySession.delete(id);
      this.applyLifecycle(s, 'exited', { notify: false });
    } else {
      delete s.archived;
      if (s.meta) delete s.meta.archiveWorktreeCleaned;
    }
    this.persist();
    this.broadcast();
    return this.get(id)!;
  }

  private startArchiveCleanup(rows: readonly SessionMeta[]): void {
    const pending = this.archiveCleanupPending ??= new Set<string>();
    for (const row of rows) pending.add(row.id);
    this.broadcast();
    void (async () => {
      for (const row of rows) {
        try {
          const hadWorktree = !row.worktreeGroups?.borrowedFrom && (!!row.worktreePath || !!row.worktreeGroups?.groups.length);
          await this.archiveReleaseThenCleanup(row);
          if (hadWorktree && !row.worktreePath && !row.worktreeGroups?.groups.length) {
            row.meta = { ...row.meta, archiveWorktreeCleaned: '1' };
            this.persist();
          }
        }
        catch (error) {
          if (!(error instanceof NativeSessionHistoryError) && (row.worktreePath || row.worktreeGroups?.groups.length)) {
            row.meta = { ...row.meta, orphanWorktree: 'locked', worktreeCleanupIssue: errorMessage(error) };
            this.persist();
          }
          this.notify.push({ workspaceId: row.workspaceId || this.config.get().activeWorkspaceId || 'app', sessionId: row.id,
            sessionName: row.name || row.id, kind: 'error', toast: true, text: error instanceof NativeSessionHistoryError
              ? t('集序已归档，原生会话同步失败。{{error}}', { error: errorMessage(error) })
              : t('归档清理失败：{{error}}', { error: errorMessage(error) }) });
        } finally {
          pending.delete(row.id);
          this.broadcast();
        }
      }
    })();
  }

  /**
   * 归档收尾：GUI 会话必须先 await release 再 cleanupSessionWorktreeOnArchive。
   * 无 worktree 时仍 release（拆连接）；无 GUI 则只走清理。
   */
  private async archiveReleaseThenCleanup(s: SessionMeta): Promise<{ ok: boolean; message: string } | undefined> {
    const history = this.chatBridge?.nativeHistory?.(s);
    let released = false;
    if (history?.prepare) {
      await this.releaseTaskWorktreeSession(s);
      released = true;
      await this.prepareNativeHistory(s, history, 'archive');
    }
    const target = this.nativeHistoryTarget(s, 'archive');
    if (target) {
      if (!released) await this.releaseTaskWorktreeSession(s);
      released = true;
      await this.syncNativeHistory(s, 'archive', target);
    }
    if (!this.isChatRuntime(s.runtime)) await this.ptyMgr.killAndWait(s.id);
    if (usesTaskWorktreeLifecycle(s)) {
      return cleanupTaskWorktrees(this.worktreeCtx(), s, 'archive', released ? undefined : { release: () => this.releaseTaskWorktreeSession(s) });
    }
    const bridge = this.chatBridge;
    const needRelease = !released && this.isChatRuntime(s.runtime) && !!bridge;
    if (!needRelease && !s.worktreePath) return;
    const operation = s.worktreePath ? beginTaskWorktreeOperation(this.config, s.id, 'cleanup') : undefined;
    let releaseSource: () => void = () => {};
    try {
      releaseSource = holdPendingSource(this.config, { workspaceId: s.workspaceId,
        capturedSource: legacySessionSourceRoot(this.config.get(), s), cwd: s.worktreeSource?.mainRepo ?? s.cwd },
        { kind: s.worktreePath ? 'worktree' : 'session', id: s.id, label: s.worktreePath ?? s.name, sessionId: s.id });
      await releaseThenCleanup(
        needRelease ? () => bridge!.release(s.id) : null,
        s.worktreePath ? () => cleanupSessionWorktreeOnArchive(this.worktreeCtx(), s) : async () => {}
      );
    } finally { releaseSource(); operation?.release(); }
  }

  /** Check Git without stopping the confirmed sessions or changing registrations. */
  async preflightLocalStorageWorktree(id: string, dependents: ReadonlySet<string>, discard: boolean): Promise<{ ok: boolean; message?: string }> {
    const row = this.sessions.find(session => session.id === id);
    if (!row || row.hidden || row.type !== 'terminal' || this.archiveCleanupPending?.has(id) || this.deletingSessions?.has(id) ||
      worktreeSessionReferences(row, this.sessions).some(other => !dependents.has(other.id))) {
      return { ok: false, message: t('清理依赖已变化，请重新扫描并确认。') };
    }
    if (hasRegisteredWorktreeCleanupIdentity(row)) {
      return cleanupTaskWorktrees(this.worktreeCtx(), row, discard ? 'discard' : 'archive', {
        forceBranches: discard, storage: { preflight: dependents }
      });
    }
    // Legacy records can still use safe cleanup when the live Git registration proves ownership.
    assertTaskWorktreeOperationIdle(this.config, id);
    const checkout = row.worktreePath, git = this.git;
    const main = !discard && git && checkout && await resolveSessionMainRepo(this.worktreeCtx(), row);
    if (main && row.worktreeBranch && git && checkout) {
      const members = [{ path: '', branch: row.worktreeBranch, baseBranch: row.worktreeBaseBranch }, ...(row.worktreeRepoSet ?? [])];
      const results = await Promise.all(members.map(member => git.previewWorktreeRemoval(path.join(main, member.path), path.join(checkout, member.path), member.branch, member.baseBranch)));
      if (results.every(result => result === 'remove-directory-and-branch')) return { ok: true };
    }
    return { ok: false, message: t('未通过 worktree 安全检查，已保留。') };
  }

  /** Retry archive cleanup or apply a confirmed storage plan after all dependents have been removed. */
  async cleanupArchivedWorktree(id: string, storage?: { discard: boolean }): Promise<{ ok: boolean; message?: string }> {
    const session = this.sessions.find(s => s.id === id);
    if (!session || !session.archived || session.hidden || session.type !== 'terminal' || (!session.worktreePath && !session.worktreeGroups?.groups.length)) {
      return { ok: false, message: t('会话状态已变化，请重新扫描。') };
    }
    if (this.archiveCleanupPending?.has(id) || this.deletingSessions?.has(id)) return { ok: false, message: t('会话正在归档，请等待资源清理完成') };
    if (this.worktreeReferencedByOtherSession(session) ||
      (storage && worktreeSessionReferences(session, this.sessions).length)) {
      return { ok: false, message: t('此 worktree 仍被其他会话引用，已保留。') };
    }
    const pending = this.archiveCleanupPending ??= new Set<string>();
    pending.add(id);
    this.broadcast();
    let result: Awaited<ReturnType<SessionsService['archiveReleaseThenCleanup']>>;
    try {
      if (storage && hasRegisteredWorktreeCleanupIdentity(session)) {
        result = await cleanupTaskWorktrees(this.worktreeCtx(), session, storage.discard ? 'discard' : 'archive', {
          release: () => this.releaseTaskWorktreeSession(session), forceBranches: storage.discard, storage: {}
        });
      } else if (storage?.discard) {
        return { ok: false, message: t('无法核验此 worktree 的强制清理身份。') };
      } else result = await this.archiveReleaseThenCleanup(session);
    }
    finally { pending.delete(id); this.broadcast(); }
    if (result && !result.ok) return result;
    if (session.worktreePath || session.worktreeGroups?.groups.length) {
      const partial = session.worktreeGroups?.groups.some(group => group.cleanup?.some(entry => entry.treeRemoved || entry.branchRemoved));
      return { ok: false, message: partial ? t('部分 worktree 已清理，其余因安全检查保留。') : t('未通过 worktree 安全检查，已保留。') };
    }
    if (session.retainedWorktreeOnly) {
      const remove = (rows: SessionMeta[]) => rows.filter(row => row !== session);
      if (storage) {
        await this.persister.flushStrict(() => {
          if (!this.sessions.includes(session) || session.worktreePath || session.worktreeGroups) throw new Error(t('会话状态已变化，请重新扫描。'));
        }, remove, () => { this.sessions = remove(this.sessions); });
      } else {
        this.sessions = remove(this.sessions);
        this.flushPersist();
      }
      this.broadcast();
    } else {
      session.meta = { ...session.meta, archiveWorktreeCleaned: '1' };
      this.persist(); this.broadcast();
    }
    return { ok: true };
  }

  private worktreeReferencedByOtherSession(session: SessionMeta): boolean {
    const paths = session.worktreeGroups?.groups.map(group => group.path) ?? (session.worktreePath ? [session.worktreePath] : []);
    const inside = (child: string, parent: string): boolean => {
      const relative = path.relative(pathKey(parent), pathKey(child));
      return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    };
    return this.sessions.some(other => other.id !== session.id && (other.worktreeGroups?.borrowedFrom === session.id ||
      paths.some(tree => (!other.archived && !!other.cwd && inside(other.cwd, tree)) ||
        (!!other.worktreePath && inside(other.worktreePath, tree)) || other.worktreeGroups?.groups.some(group => inside(group.path, tree)))));
  }

  /** Hold task cleanup's operation/root leases while awaiting engine release. */
  private async releaseTaskWorktreeSession(s: SessionMeta): Promise<void> {
    this.launchTasks.delete(s.id); this.launchGen.delete(s.id); this.classifyBySession.delete(s.id);
    if (!this.isChatRuntime(s.runtime)) await this.ptyMgr.killAndWait(s.id);
    if (this.isChatRuntime(s.runtime)) await this.chatBridge?.release(s.id);
    s.status = 'exited'; this.applyLifecycle(s, 'exited', { notify: false }); this.persist(); this.broadcast();
  }

  /**
   * 结构化生命周期信号（P2 hooks / Worker 自报 activity 字段）。
   * 优先级最高的状态来源：active → working；blocked → blocked（sticky，通知）；
   * waiting_input 存 activity 不动 lifecycle（推导层显示 waiting）；
   * idle → idle。waiting_input/blocked 只被下一个结构化信号或用户键盘输入清除。
   */
  applyActivitySignal(idOrExternal: string, kind: StructuredActivityKind, event?: string, toolUseId?: string): void {
    const resolved = this.resolveSessionRef({ sessionId: idOrExternal });
    const s = this.sessions.find((x) => x.id === resolved.id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: resolved.id }));
    if (s.type !== 'terminal') return;
    if (event === 'gui-open') {
      s.runtimeStartedAt = Date.now();
      s.status = 'running';
      delete s.activity;
      delete s.firstSignalAt;
    }
    if (s.firstSignalAt === undefined) {
      s.firstSignalAt = Date.now();
    }
    // 推导态翻转前快照：hook 卡住态（blocked/waiting_input）翻转为 needs_you 类时由总线推送
    const prevStatus = boardStatusOfSession(s);
    s.activity = nextSessionActivity(s.activity, kind, event, toolUseId, Date.now());
    // 只有新用户回合才清 done。shell-end / pre-tool-use / session-start 都是 Cursor
    // 工具链噪声：Worker 用 curl 报 phase=done 本身就会再触发一条 shell hook。
    if (
      (s.phase?.source !== 'user' || s.phase.value === 'done') &&
      activityClearsDonePhase(kind, event)
    ) {
      delete s.phase;
      delete s.reviewDeferred;
      delete s.liveStatus;
    }
    switch (kind) {
      case 'active':
        this.applyLifecycle(s, 'working', { notify: false, deferPublish: true });
        break;
      case 'blocked':
        this.applyLifecycle(s, 'blocked', { notify: true, deferPublish: true });
        break;
      case 'idle':
        // Left rail and mobile prefer the capsule over the derived idle label.
        if (!s.phase || s.phase.value === 'idle') delete s.liveStatus;
        this.applyLifecycle(s, 'idle', { notify: false, deferPublish: true });
        break;
      case 'waiting_input':
        break;
    }
    if (!s.hidden) { this.persist(); this.broadcast(); }
    this.emitSessionFactKind(s, 'session.activity');
    this.notifyBus.report({
      session: s,
      workspaceId: this.workspaceIdFor(s),
      prev: prevStatus,
      next: boardStatusOfSession(s),
      source: 'hook'
    });
  }

  /**
   * worktree 收尾/自愈/丢弃（git/worktreeSessionOps.ts）与验收合入（git/worktreeIntegrate.ts）
   * 的状态回接与公开方法委托（2026-09-26 sessions.ts → git/ 拆分，行为保持）。
   */
  async isolateRepositories(sessionId: string, selections: import('../shared/types').WorkspaceWorktreeGroupSelection[], apply = false) {
    return attachTaskWorktrees(this.worktreeCtx(), sessionId, selections, apply);
  }

  private worktreeCtx(): SessionWorktreeCtx {
    return {
      git: this.git,
      config: this.config,
      notify: this.notify,
      workspaceIdFor: (s) => this.workspaceIdFor(s),
      resolveWorkspaceId: (cwd) => this.resolveWorkspaceId(cwd),
      persist: () => this.persist(),
      flushPersist: () => this.flushPersist(),
      broadcast: () => this.broadcast(),
      findSession: (id) => this.sessions.find((x) => x.id === id),
      sessions: () => this.sessions
    };
  }

  private integrateCtx(): SessionIntegrateCtx {
    return {
      ...this.worktreeCtx(),
      awareness: this.awareness,
      emitRuntimeFacts: (facts) => this.emitRuntimeFacts(facts),
      setPhase: (id, phase) => this.setPhase(id, phase),
      setLiveStatus: (id, live) => this.setLiveStatus(id, live),
      recordAcceptance: (id, rec) => this.recordAcceptance(id, rec),
      isExecuting: session => this.archiveExecutionIds(session.id).length > 0,
      setArchived: (id, archived) => this.setArchived(id, archived),
      archiveReleaseThenCleanup: async (s) => {
        if (!this.archiveCleanupPending?.has(s.id) && !this.deletingSessions?.has(s.id)) await this.archiveReleaseThenCleanup(s);
      }
    };
  }

  /** 「放弃改动并清理」：force 删除会话 worktree（调用方须先弹确认）；已合入的分支一并删，未合入保留并说明 */
  async discardWorktree(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    const session = this.sessions.find(s => s.id === sessionId);
    if (session && usesTaskWorktreeLifecycle(session)) {
      return cleanupTaskWorktrees(this.worktreeCtx(), session, 'discard', { release: () => this.releaseTaskWorktreeSession(session) });
    }
    const operation = beginTaskWorktreeOperation(this.config, sessionId, 'discard');
    try { return await discardSessionWorktree(this.worktreeCtx(), sessionId); }
    finally { operation.release(); }
  }

  /** Prepare a one-use confirmation for exactly one unregistered task directory. */
  async previewForceRemoveUnregistered(sessionId: string, requestedPath: string): Promise<{ token: string; path: string; branch: string }> {
    const session = this.get(sessionId);
    if (!session?.archived || !usesTaskWorktreeLifecycle(session)) throw new Error(t('会话状态已变化，请重新扫描。'));
    assertTaskWorktreeOperationIdle(this.config, sessionId);
    const state = sessionWorktreeGroups(session);
    const matches = state?.groups.filter(group => pathKey(group.path) === pathKey(requestedPath)) ?? [];
    const group = matches[0];
    const inside = (child: string, parent: string) => {
      const relative = path.relative(pathKey(parent), pathKey(child));
      return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    };
    if (!state || state.borrowedFrom || matches.length !== 1 || group.repos.length || state.groups.some(other => other !== group &&
      (inside(other.path, group.path) || inside(group.path, other.path)))) {
      throw new Error(t('该目录包含或重叠其他任务仓库，请先分别处理。'));
    }
    const ownership = taskWorktreeOwnership(session), folder = group.path;
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || pathKey(fs.realpathSync(folder)) !== pathKey(folder)) throw new Error(t('目录身份已变化，请重新检查。'));
    if (!this.git) throw new Error(t('GitService 不可用'));
    const registrations = await this.git.worktreeList(group.source!.mainRepo);
    if (registrations.some(entry => {
      const relative = path.relative(pathKey(folder), pathKey(entry.path));
      return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
    })) throw new Error(t('该目录仍有 Git worktree 登记，请使用普通清理。'));
    if (this.get(sessionId) !== session || !session.archived || taskWorktreeOwnership(session) !== ownership) throw new Error(t('会话状态已变化，请重新扫描。'));
    const current = fs.lstatSync(folder);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs || pathKey(fs.realpathSync(folder)) !== pathKey(folder)) throw new Error(t('目录身份已变化，请重新检查。'));
    const token = randomUUID(), previews = this.forceDirectoryPreviews ??= new Map();
    for (const [key, entry] of previews) if (entry.expiresAt < Date.now() || entry.sessionId === sessionId) previews.delete(key);
    if (previews.size >= 32) previews.delete(previews.keys().next().value!);
    previews.set(token, { sessionId, ownership, expiresAt: Date.now() + 5 * 60_000,
      directory: { path: folder, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs } });
    return { token, path: folder, branch: group.branch ?? '' };
  }

  /** Consume the UI's explicit confirmation; unknown branches are always retained. */
  async forceRemoveUnregistered(sessionId: string, token: string): Promise<{ ok: boolean; message?: string }> {
    const preview = this.forceDirectoryPreviews?.get(token);
    this.forceDirectoryPreviews?.delete(token);
    const session = this.get(sessionId);
    if (!preview || preview.sessionId !== sessionId || preview.expiresAt < Date.now() || !session?.archived || taskWorktreeOwnership(session) !== preview.ownership) {
      throw new Error(t('清理确认已过期，请重新检查目录。'));
    }
    return cleanupTaskWorktrees(this.worktreeCtx(), session, 'discard', { release: () => this.releaseTaskWorktreeSession(session), forceUnregistered: preview.directory });
  }

  /**
   * 验收后合入隔离 worktree：宿主在主仓 merge（Worker cwd 就是 worktree，删不了自己），
   * 再推迟归档——先把工具结果回给模型，再杀进程并删目录。
   * R-18b：多仓组（worktreeRepoSet 有值）走组级路径——零改动过滤 + 全或无预检 +
   * 嵌套先主仓后逐仓真合（详见 git/nestedRepos.ts integrateRepoGroup）。
   */
  async integrateWorktree(
    sessionId: string,
    opts?: IntegrateWorktreeOpts,
    initiatedBy: 'human' | 'agent' = 'agent'
  ): Promise<{
    merged: boolean;
    alreadyMerged?: boolean;
    target?: string;
    branch?: string;
    cleanup: 'scheduled' | 'retained';
    approval: IntegrateApproval;
    message: string;
    warnings?: string[];
    gates?: GitMergeIsolateResult['gates'];
    /** R-18b 多仓组逐仓清单（repo='' 为主仓） */
    repos?: GitRepoIntegrateEntry[];
    groups?: import('../shared/types').SessionWorktreeGroupIntegrationResult[];
  }> {
    const row = this.get(sessionId);
    if (!row) throw new Error('Session not found');
    if (initiatedBy !== 'human') {
      const collector = createSafetyGitEvidenceCollector();
      try {
        const evidence = await this.approvalSnapshot([sessionId], opts, collector.capture, 'integrate');
        const workspaceId = row.workspaceId ?? this.resolveWorkspaceId(row.cwd);
        const reply = row.runtime && this.isChatRuntime(row.runtime) ? this.agentSessionsRef?.observe?.(sessionId)?.lastReply?.text : undefined;
        const delivery = [row.liveStatus?.summary, reply].filter(Boolean).join('\n').slice(0, 8000);
        if (!this.businessApproval || !await this.businessApproval(workspaceId, 'sessions.integrateWorktree', { sessionId, ...opts }, evidence, collector.finish(evidence, delivery))) throw new Error('Integration approval denied or unavailable');
        const currentEvidence = await this.approvalSnapshot([sessionId], opts, undefined, 'integrate');
        if (currentEvidence !== evidence) throw new Error(`Integration target or repository changed during approval: ${this.approvalChanges(evidence, currentEvidence)}`);
      } finally { collector.clear(); }
    }
    const current = this.get(sessionId);
    if (!current) throw new Error('Session not found');
    if (usesTaskWorktreeLifecycle(current)) return integrateSessionWorktree(this.integrateCtx(), sessionId, opts);
    const operation = beginTaskWorktreeOperation(this.config, sessionId, 'integrate');
    try { return await integrateSessionWorktree(this.integrateCtx(), sessionId, opts); }
    finally { operation.release(); }
  }

  /**
   * 看板三档（模型 / LLM / 用户手动）。label 胶囊走 setLiveStatus，互不影响。
   * 权威粘性：model/llm 不得回退用户标记的 done/needs_you；llm 亦不得回退 model 的。
   */
  setPhase(
    idOrExternal: string,
    phase: { value: SessionPhaseKind; source: SessionPhase['source']; ts?: number }
  ): SessionMeta {
    const resolved = this.resolveSessionRef({ sessionId: idOrExternal });
    const s = this.sessions.find((x) => x.id === resolved.id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: resolved.id }));
    if (phaseWriteBlocked(s.phase, phase)) {
      return this.get(s.id)!;
    }
    // X1-F03 同源同值短路：llm 读屏（result!=='unknown' 即 setPhase）与 model 的
    // 同值重报不再写新 ts——旧口径每次 setPhase 都重新投影 session.phase 事实，
    // ts 变化让 eventId 每写必新，订阅面「同值重报=新信」反复唤醒调度。权威升级
    // （source 变化，如 llm→model / model→user）仍照常写入。
    if (s.phase?.value === phase.value && s.phase?.source === phase.source) {
      return this.get(s.id)!;
    }
    if (s.firstSignalAt === undefined) s.firstSignalAt = Date.now();
    // 推导态翻转前快照（写入后交给通知总线裁决：翻转/45s 账本/免打扰/权限）
    const prevStatus = boardStatusOfSession(s);
    const prevPhaseValue = s.phase?.value;
    s.phase = {
      value: phase.value,
      source: phase.source,
      ts: phase.ts ?? Date.now()
    };
    if (phase.value === 'done' && s.workerRouting) {
      s.workerRouting.phase = 'completed';
      const attempt = s.workerRouting.attempts.at(-1);
      if (attempt && attempt.state !== 'failed') attempt.state = 'completed';
    }
    this.persist();
    this.broadcast();
    // 证据归集（T4.4）：翻转时刻 pty 切片（GUI 会话无 buffer，收集器自行跳过）
    const nextStatus = boardStatusOfSession(s);
    if (nextStatus !== prevStatus) {
      this.evidence?.recordPhaseFlip(s.id, { from: prevStatus, to: nextStatus, source: phase.source }, s.phase.ts);
    }
    // 看板三档是人需要出手/知晓的时刻：桌面 toast 由总线统一决策推送
    // （needs_you/done 触发规则见 shared/notifyDecision）
    this.notifyBus.report({
      session: s,
      workspaceId: this.workspaceIdFor(s),
      prev: prevStatus,
      next: nextStatus,
      source: phase.source
    });
    if (phase.value === 'done') notifyDelegateSlotFreed(this.workspaceIdFor(s));
    this.emitSessionFactKind(s, 'session.phase');
    // phase 翻转监听（子代理完成通知）：值真变才通知，重复写同值不算翻转
    if (phase.value !== prevPhaseValue) {
      this.notifyPhaseListeners(s, phase.value, prevPhaseValue);
    }
    // R-14 交验前置门：编排会话翻进 needs_you（交验）时，宿主对本次交付改动跑机械维度门。
    // 手工会话不进门（与 R-08 授权方向一致）；红灯由 applyDimensionGates 落 meta 后广播。
    if (phase.value === 'needs_you' && s.orchestrated === true && s.type === 'terminal') {
      this.scheduleDimensionGates(s);
    }
    return this.get(s.id)!;
  }

  /** 新任务注入：清掉上一轮 done / needs_you，避免一直占「已完成」或「需要你」列 */
  clearDonePhase(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    if (s.phase?.value !== 'done' && s.phase?.value !== 'needs_you') return;
    delete s.phase;
    delete s.liveStatus;
    this.persist();
    this.broadcast();
  }

  /**
   * R-14 交验前置门调度：编排会话 needs_you 时对本次交付改动跑机械维度门。
   * 红灯（或尚无门结果）时冷却不生效——返工后的再上报必须重查；纯绿灯重复上报
   * 受 DIM_GATE_COOLDOWN_MS 去重。fire-and-forget：结果经 applyDimensionGates 落 meta。
   */
  private scheduleDimensionGates(s: SessionMeta): void {
    const cwd = s.worktreePath?.trim() || s.cwd?.trim();
    if (!cwd || this.dimGateInFlight.has(s.id)) return;
    // 冷却只拦「纯绿灯的重复上报」；红灯或尚无结果（null，如上次门没跑/失败）必须重查——对齐注释与文档口径
    const red = hasRedGate(s.dimensionGates);
    const hasResult = s.dimensionGates != null;
    if (!red && hasResult) {
      const last = this.dimGateLastRunAt.get(s.id) ?? 0;
      if (Date.now() - last < DIM_GATE_COOLDOWN_MS) return;
    }
    this.dimGateInFlight.add(s.id);
    this.dimGateLastRunAt.set(s.id, Date.now());
    const members = s.worktreeGroups?.groups.flatMap(group => [
      { cwd: group.path, branch: group.branch, baseBranch: group.baseBranch },
      ...group.repos.map(repo => ({ cwd: path.join(group.path, repo.path), branch: repo.branch, baseBranch: repo.baseBranch }))
    ]) ?? [{ cwd, branch: s.worktreeBranch, baseBranch: s.worktreeBaseBranch }];
    const fingerprint = taskWorktreeOwnership(s);
    void (async () => {
      const snapshots: DimensionGatesSnapshot[] = [];
      for (const member of members) { const snapshot = await collectDimensionGates(member); if (snapshot) snapshots.push(snapshot); }
      const results: DimensionGatesSnapshot['results'] = [];
      for (const snapshot of snapshots) for (const result of snapshot.results) {
        const entry = results.find(item => item.id === result.id);
        if (entry) { if (result.status === 'red') entry.status = 'red'; entry.checkedFiles.push(...result.checkedFiles); entry.problems.push(...result.problems); }
        else results.push(structuredClone(result));
      }
      return { at: Date.now(), trigger: 'needs_you' as const, results };
    })()
      .then((snapshot) => { if (taskWorktreeOwnership(s) === fingerprint) this.applyDimensionGates(s.id, snapshot); })
      .catch((e) => {
        // 门失败不挡 needs_you（fail-open）：留错误日志，看板按无门处理
        console.error('[sessions] 维度门执行失败', s.id, e);
        this.applyDimensionGates(s.id, null);
      })
      .finally(() => this.dimGateInFlight.delete(s.id));
  }

  /** 维度门结果落盘 + 广播；红灯另发编排事件（通知调度建议打回）与通知中心纠正条 */
  private applyDimensionGates(id: string, snapshot: DimensionGatesSnapshot | null): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    const hadGates = !!s.dimensionGates;
    if (snapshot) s.dimensionGates = snapshot;
    else delete s.dimensionGates;
    if (!snapshot && !hadGates) return; // 无门→无门：不动盘不广播
    this.persist();
    this.broadcast();
    const red = hasRedGate(snapshot);
    if (!red) return;
    const badge = dimensionGateBadgeLabel(snapshot);
    const detail = dimensionGateDetailText(snapshot) || badge;
    noteDimensionGateRed({
      workspaceId: this.workspaceIdFor(s),
      sessionId: s.id,
      sessionName: s.name,
      detail
    });
    this.notify.push({
      workspaceId: this.workspaceIdFor(s),
      sessionId: s.id,
      sessionName: s.name,
      label: t('维度门'),
      text: t('红灯：{{badge}}，会话暂不进入需要你列（可打回或强制验收）', { badge }),
      update: true,
      updateKey: `dim-gate:${s.id}`,
      // needs_you 的桌面 toast 已在门结果前弹出过一次；这里补纠正气泡（红灯罕见，不构成噪声）
      toast: true
    });
  }

  /** 清除维度门结果（打回重做/验收收尾时；下一次 needs_you 上报会重跑） */
  clearDimensionGates(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s?.dimensionGates) return;
    delete s.dimensionGates;
    this.dimGateLastRunAt.delete(id);
    this.persist();
    this.broadcast();
  }

  /**
   * 更新会话列表胶囊。label 为自由文案，不改看板列。
   * 胶囊只落 liveStatus（左栏/看板卡展示），不再产生任何通知——高频文案变化
   * 弹 toast 是噪声（notification-system.md 矩阵）。
   */
  setLiveStatus(idOrExternal: string, live: LiveStatus): SessionMeta {
    const resolved = this.resolveSessionRef({ sessionId: idOrExternal });
    const s = this.sessions.find((x) => x.id === resolved.id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: resolved.id }));
    s.liveStatus = {
      label: live.label.trim().slice(0, 40),
      kind: live.kind ?? 'info',
      summary: live.summary?.slice(0, 200),
      ts: live.ts || Date.now()
    };
    this.persist();
    this.broadcast();
    this.emitSessionFactKind(s, 'session.note');
    return this.get(s.id)!;
  }

  /**
   * 解析上报用的宿主会话。
   * - 优先 statusToken（MUSTER_SESSION_TOKEN / STATUS_URL 路径）
   * - 否则 sessionId / externalSessionId（兼容旧调用与调度侧）
   */
  resolveSessionRef(ref: {
    sessionId?: string;
    externalSessionId?: string;
    statusToken?: string;
  }): { id: string; matchedBy: 'statusToken' | 'sessionId' | 'externalSessionId' } {
    const candidates = this.sessions.filter(row => !row.retainedWorktreeOnly);
    const token = ref.statusToken?.trim() || '';
    if (token) {
      const byTok = candidates.find((x) => x.statusToken === token);
      if (byTok) return { id: byTok.id, matchedBy: 'statusToken' };
      throw new Error(t('无效 statusToken（请用环境变量 MUSTER_STATUS_URL / MUSTER_SESSION_TOKEN）'));
    }

    const sid = ref.sessionId?.trim() || '';
    const ext = ref.externalSessionId?.trim() || '';

    if (sid) {
      const byId = candidates.find((x) => x.id === sid);
      if (byId) return { id: byId.id, matchedBy: 'sessionId' };
      const byExtAsSid = candidates.find((x) => x.externalSessionId === sid);
      if (byExtAsSid) return { id: byExtAsSid.id, matchedBy: 'externalSessionId' };
      const flex = matchFlexibleSessionId(candidates, sid);
      if (flex.kind === 'one') return { id: flex.id, matchedBy: 'sessionId' };
      if (flex.kind === 'many') {
        throw new Error(
          t('会话 id 前缀不唯一: {{id}}（匹配 {{n}} 个）', { id: sid, n: flex.ids.length })
        );
      }
      throw new Error(
        t('会话不存在: {{id}}。Worker 请 POST MUSTER_STATUS_URL（phase 或 label）；调度侧可传 sessionId。', { id: sid })
      );
    }

    if (ext) {
      const byExt = this.sessions.find((x) => x.externalSessionId === ext);
      if (byExt) return { id: byExt.id, matchedBy: 'externalSessionId' };
      throw new Error(t('找不到 externalSessionId={{id}} 对应的宿主会话', { id: ext }));
    }

    throw new Error(t('需要 statusToken（推荐 MUSTER_STATUS_URL）或 sessionId / externalSessionId'));
  }

  /** 确保终端会话有上报令牌（旧会话补发） */
  ensureStatusToken(sessionId: string): string {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id: sessionId }));
    if (!s.statusToken) {
      s.statusToken = randomUUID();
      this.persist();
    }
    return s.statusToken;
  }

  clearLiveStatus(id: string): SessionMeta {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    delete s.liveStatus;
    this.persist();
    this.broadcast();
    return this.get(id)!;
  }

  /** 消息账本变化通知（待答条/看板风险区按派生视图刷新；账本是唯一事实源） */
  broadcastMessagesChanged(): void {
    this.getWindow()?.webContents.send('messages:changed', { at: Date.now() });
  }

  /**
   * escalate 升级预算计数（S2.3/T4）：仅 needs_you 用户注意通知计数，挂在会话链上。
   * 预算尽返回 refused 正常结果（非抛错）；预算内 +1 并返回剩余次数。
   */
  consumeEscalateBudget(id: string, key: string): {
    allowed: boolean;
    used: number;
    remaining: number;
    escalate: boolean;
    message?: string;
  } {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) throw new Error(t('会话不存在: {{id}}', { id }));
    const budgets = s.escalateBudget ?? {};
    const attempt = tryEscalate(budgets, key);
    s.escalateBudget = budgets;
    this.persist();
    return attempt;
  }

  /** 定时任务运行时刷新其投影会话的最近使用时间（用于左栏排序） */
  touchScheduledSession(serviceId: string, ts: number): void {
    const s = this.sessions.find((x) => x.type === 'scheduled' && x.serviceId === serviceId);
    if (!s) return;
    s.lastUsedAt = ts;
    this.persist();
    this.broadcast();
  }

  /** 用户键盘输入 = 真使用，刷新最近使用时间。30s 节流：输入按字符触发，persist/broadcast 不能逐字符跑 */
  touchUsed(id: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    this.classifyBySession.delete(id);
    // 用户亲手按键（多半在答确认框）：立即清除 blocked 回 working，不受节流影响；
    // sticky 的结构化 waiting_input/blocked、以及模型/LLM 的 needs_you 一并清除
    const stickyActivity =
      s.activity?.kind === 'blocked' || s.activity?.kind === 'waiting_input' || s.activity?.kind === 'idle';
    const stickyNeed = s.phase?.value === 'needs_you' && s.phase.source !== 'user';
    if (stickyActivity) {
      delete s.activity;
    }
    if (stickyNeed) {
      delete s.phase;
    }
    if (s.lifecycle === 'blocked' || s.lifecycle === 'idle' && stickyActivity) {
      this.applyLifecycle(s, 'working', { notify: true });
    } else if (stickyActivity || stickyNeed) {
      this.persist();
      this.broadcast();
    }
    const now = Date.now();
    if (now - (s.lastUsedAt ?? 0) < 30_000) return;
    s.lastUsedAt = now;
    this.persist();
    this.broadcast();
  }
}
