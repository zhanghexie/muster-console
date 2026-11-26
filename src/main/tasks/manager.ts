import { randomUUID } from 'node:crypto';
import { buildTaskBriefText } from '../../shared/workerBrief';
import { holdPendingSource } from '../workspaceRootUses';
import { supportsGuiPermissionMode } from '../../shared/guiPermissionOptions';
import type {
  AgentRuntimeKey,
  GuiThinkingLevel,
  GuiWorkerMode,
  MissedPolicy,
  PromptTask,
  PromptTaskMode,
  TaskRun,
  TaskSchedule
} from '../../shared/types';
import {
  evaluateMissedWindow,
  inheritMetaFromPromptTask,
  partitionHeadlessPromptTasks,
  resolveMissedPolicy,
  shouldKeepAwake,
  type PurgedHeadlessTask
} from '../../shared/promptTasks';
import { isSchedulerWaitingOnHuman } from '../schedulerStatusStore';
import type { AppContext } from '../context';
import type { ConfigManager } from '../config';
import type { SessionsService } from '../sessions';
import type { Store } from '../store';
import type { RuntimeHost } from '../runtime/host';
import type { NotifyStore } from '../notify/store';
import type { UsageStatsService } from '../usage/service';
import {
  getNextRunAt,
  resolveScheduleInput,
  shouldAutoDisableAfterRun,
  consumeOnceSlot,
  validateMaxRuns
} from './schedule';
import { t } from '../../shared/i18n';
import { usageDayKey, type UsageHeadlessTaskStat } from '../../shared/usageStats';
import { assertPromptTaskSource, capturePromptTaskSource } from './source';
import { buildGuiInheritMeta } from '../../shared/guiInheritMeta';
import { effectiveCliLaunchOptions, type CliLaunchOptions } from '../../shared/cliLaunchOptions';
import { parseNativeConfigIntent, type NativeConfigIntent } from '../../shared/nativeSessionConfig';
import type { ModelParameterValues } from '../../shared/modelParameters';

export interface CreatePromptTaskOptions {
  name: string;
  workspaceId?: string;
  rootId?: string;
  rootsRevision?: number;
  runtime: AgentRuntimeKey;
  prompt: string;
  /** 与 delayMinutes 二选一（T6/A4） */
  schedule?: TaskSchedule;
  /** 相对延迟（分钟）：与 schedule 二选一，宿主真实时钟换算成 once */
  delayMinutes?: number;
  /** 成功触发次数上限；达到后自动停用 */
  maxRuns?: number;
  /** UI 新建默认停用等用户编辑；Agent 工具显式传 true 保持即建即用 */
  enabled?: boolean;
  /** 执行模式；缺省 terminal。headless 已退役，显式传入会拒绝 */
  mode?: PromptTaskMode;
  /** 会话级模型覆盖的服务商 id */
  providerId?: string;
  /** 会话级模型覆盖的模型 id */
  modelId?: string;
  /** GUI 会话权限档（仅 chat runtime） */
  configurePermissions?: boolean;
  guiMode?: GuiWorkerMode;
  nativeConfig?: NativeConfigIntent;
  cliLaunchOptions?: CliLaunchOptions;
  /** Pi 自定义模式 / ACP 引擎 id */
  piModeId?: string;
  /** 会话级思考档（仅 Pi） */
  thinking?: GuiThinkingLevel;
  modelParameters?: ModelParameterValues;
  /** 错过策略；缺省 skip */
  missedPolicy?: MissedPolicy;
}

/** Omitted fields are unchanged; null explicitly clears optional GUI overrides. */
export type UpdatePromptTaskOptions = Omit<Partial<CreatePromptTaskOptions>, 'guiMode' | 'piModeId' | 'thinking' | 'modelParameters' | 'nativeConfig' | 'cliLaunchOptions'> & {
  guiMode?: GuiWorkerMode | null;
  nativeConfig?: NativeConfigIntent | null;
  cliLaunchOptions?: CliLaunchOptions | null;
  piModeId?: string | null;
  thinking?: GuiThinkingLevel | null;
  modelParameters?: ModelParameterValues | null;
};

const TASK_OPTION_KEYS = new Set([
  'name', 'workspaceId', 'rootId', 'rootsRevision', 'runtime', 'prompt', 'schedule', 'delayMinutes',
  'maxRuns', 'enabled', 'mode', 'providerId', 'modelId', 'configurePermissions', 'guiMode', 'piModeId', 'thinking', 'modelParameters', 'nativeConfig', 'cliLaunchOptions', 'missedPolicy'
]);

function assertTaskOptions(options: object): void {
  const unknown = Object.keys(options).find(key => !TASK_OPTION_KEYS.has(key));
  if (unknown) throw new Error(`Unknown task option: ${unknown}`);
}

/** 每个任务保留的运行记录条数上限 */
export const MAX_RUNS_PER_TASK = 50;

/**
 * O12 决策门重试间隔：目标工作区调度 needs_you 时，调度域（headless）定时触发本轮
 * 跳过、nextRunAt 保持 due，30s 后再试（不进错过策略——这不是「错过」是「暂缓」）。
 */
const DECISION_GATE_RETRY_MS = 30_000;

/** once 任务执行失败后的自动重试延迟（只重试一次；再失败才消费槽位自停） */
export const ONCE_FAILURE_RETRY_MS = 5 * 60 * 1000;

/** 系统电源：keep-awake + 唤醒后重评错过窗口（测试可注入 mock） */
export interface PowerHost {
  startPreventAppSuspension(): number;
  stop(id: number): void;
  onResume(cb: () => void): () => void;
}

export interface HeadlessRunResult {
  ok: boolean;
  output?: string;
  error?: string;
  piSessionPath?: string;
  durationMs?: number;
}

export interface HeadlessRunHooks {
  /** 会话文件一就绪就回写，进行中也能跳进调度面板 */
  onSessionReady?: (piSessionPath: string) => void;
  /** 输出增量（已截断），进行中可回看 */
  onOutput?: (output: string) => void;
}

/** 无头执行器：由宿主绑定（piProvider.runHeadlessPiTask），测试可注入 mock */
export type HeadlessRunner = (task: PromptTask, hooks?: HeadlessRunHooks) => Promise<HeadlessRunResult>;

/** GUI（chat surface）注入器：AgentSessionHost.send 的结构子集（测试可注入 mock） */
export interface GuiPromptSender {
  send(
    sessionId: string,
    text: string,
    images?: unknown,
    opts?: { fromInject?: boolean }
  ): Promise<{ ok: boolean; queued?: boolean; error?: string }>;
}

export class PromptTasksManager {
  private tasks: PromptTask[];
  private terminalInFlight = new Set<PromptTask>();
  private readonly activeRuns = new Set<Promise<void>>();
  private paused = false;
  private closing = false;
  private readonly cleanupErrors = new Map<string, unknown>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private runs: TaskRun[] = [];
  /** 无头任务串行链：同一时刻只跑一个，避免并发打爆模型限流 */
  // —— headless 执行链（已退役）——
  // mode 断言 + 启动 purge 后生产不可达：新任务恒 terminal、存量 headless 启动即删。
  // 仅历史 run 记录展示与离线测试仍引用；O12 决策门/串行链/无头执行器的整链删除
  // 待独立批次（与 piProvider.runHeadlessPiTask 的代码索引/无头脚本用法区分，勿混删）。
  private headlessChain: Promise<void> = Promise.resolve();
  private headlessInFlight = new Set<string>();
  private headlessRunner: HeadlessRunner | null = null;
  /** once 任务「失败自动重试一次」标记（transient，不落盘：重启后重新给一次机会） */
  private onceFailureRetried = new Set<string>();
  /** 使用统计（bindHeadless 时取自 AppContext；测试注入 mock runner 时不计数） */
  private usage: UsageStatsService | null = null;
  /** 构造期标中断的无头条数：usage 晚绑定，等 bindHeadless 再记入日桶（避免卡片与列表分叉） */
  private pendingHeadlessInterrupts = 0;
  /** GUI（chat surface）runtime 的 terminal 模式经它注入任务原文（AgentSessionHost 晚绑定） */
  private guiHost: GuiPromptSender | null = null;
  /**
   * O12 决策门的状态源（bindHeadless 注入 AppContext，读 schedulerStatus）；
   * null / 读失败一律当「不挡」（fail-open）。runNow 手动触发不受门限制。
   */
  private decisionGateCtx: AppContext | null = null;
  private timeEventSink: ((task: PromptTask, at: number) => void) | null = null;
  private pendingTimeEvents: Array<{ task: PromptTask; at: number }> = [];
  private power: PowerHost | null = null;
  private unbindResume: (() => void) | null = null;
  private keepAwakeId: number | undefined;
  /**
   * O12 决策门暂缓标记（内存态：taskId → 最近一次暂缓时刻）。deferForDecisionGate
   * 挂重试时打上；门放行（deferForDecisionGate 放行 / run 真正执行）或任务停用/删除时清。
   * 系统唤醒 / 重挂定时器对过期任务判错过前先查它：暂缓链上的 due 不是「错过」，
   * 不进 evaluateMissedWindow（重启后内存标记丢失，由「此刻仍 needs_you」兜底，
   * 见 onDecisionGateHold）。
   */
  private decisionGateDeferred = new Map<string, number>();
  /** 本次启动从盘上清掉的存量 headless 任务摘要（交付复核） */
  private purgedHeadless: PurgedHeadlessTask[] = [];

  constructor(
    private store: Store,
    private config: ConfigManager,
    private sessions: SessionsService,
    private runtimes: RuntimeHost,
    private notify?: NotifyStore,
    initialTimeEventSink?: (task: PromptTask, at: number) => void,
    options: { startPaused?: boolean } = {}
  ) {
    this.paused = options.startPaused === true;
    this.timeEventSink = initialTimeEventSink ?? null;
    // Retire old event-triggered task definitions; ordinary time tasks keep their schedule.
    const loadedTasks = store.loadPromptTasks();
    this.tasks = loadedTasks.flatMap(task => {
      const { trigger, ...scheduled } = task as PromptTask & { trigger?: { kind?: unknown } };
      return trigger === undefined || trigger?.kind === 'time' ? [scheduled] : [];
    });
    this.purgeHeadlessOnLoad();
    this.runs = store.loadTaskRuns();
    // crash/强退残留的 running 记录：恢复时统一标中断，否则统计面板永远「运行中」且 3s 轮询不降频
    let interrupted = false;
    const now = Date.now();
    for (const run of this.runs) {
      if (run.status === 'running') {
        const wasHeadless = run.mode === 'headless' || Boolean(run.piSessionPath);
        run.status = 'error';
        run.error = run.error || t('应用重启，任务中断');
        run.finishedAt = now;
        run.durationMs = Math.max(0, run.finishedAt - run.startedAt);
        if (wasHeadless) this.pendingHeadlessInterrupts += 1;
        interrupted = true;
      }
    }
    if (interrupted) store.saveTaskRuns(this.runs);
    const taskIds = new Set(this.tasks.map((task) => task.id));
    for (const session of sessions.list()) {
      if (session.type === 'scheduled' && (!session.serviceId || !taskIds.has(session.serviceId))) {
        sessions.removeScheduledSession(session.serviceId ?? '');
      }
    }
    let quarantined = false;
    for (const task of this.tasks) {
      try {
        if (!task.sourceRoot) task.sourceRoot = capturePromptTaskSource(this.config.get(), task, true);
        assertPromptTaskSource(this.config.get(), task);
        if (!sessions.list().some((session) => session.type === 'scheduled' && session.serviceId === task.id)) {
          sessions.createScheduledTaskSession(task);
        }
        sessions.updateScheduledTaskSession(task);
        this.arm(task);
      } catch (error) {
        // 单个坏任务（非法 time/interval/weekdays 等）不能卡死整个应用启动：自动停用并记录原因
        task.enabled = false;
        task.nextRunAt = undefined;
        task.lastResult = 'error';
        task.lastError = t('任务配置无效，已自动停用：{{msg}}', {
          msg: error instanceof Error ? error.message : String(error)
        });
        this.disarm(task.id);
        quarantined = true;
      }
    }
    if (quarantined || this.tasks.length || loadedTasks.length !== this.tasks.length) this.persist();
  }

  /** 启动清理：删除全部 mode=headless 存量任务（破坏性，用户已确认） */
  private purgeHeadlessOnLoad(): void {
    const { kept, purged } = partitionHeadlessPromptTasks(this.tasks);
    this.purgedHeadless = purged;
    if (!purged.length) return;
    this.tasks = kept;
    for (const item of purged) {
      this.sessions.removeScheduledSession(item.id);
    }
    this.store.savePromptTasks(this.tasks);
    console.info(
      `[tasks] purged ${purged.length} headless prompt task(s):`,
      purged.map((p) => `${p.name} · ${p.promptPreview}`).join(' | ')
    );
  }

  /** 本次启动清掉的存量无头任务（名称/提示词摘要），供交付复核 */
  listPurgedHeadless(): PurgedHeadlessTask[] {
    return this.purgedHeadless.map((p) => ({ ...p }));
  }

  bindTimeEventSink(sink: (task: PromptTask, at: number) => void): void {
    this.timeEventSink = sink;
    for (const event of this.pendingTimeEvents) sink(event.task, event.at);
    this.pendingTimeEvents = [];
  }

  list(workspaceId?: string): PromptTask[] {
    return this.tasks
      .filter((task) => !workspaceId || task.workspaceId === workspaceId)
      .map((task) => ({ ...task, schedule: { ...task.schedule } as TaskSchedule }));
  }

  /** Definitions (including disabled ones) and immutable terminal startup snapshots. */
  rootDependencyRoster(): PromptTask[] {
    return [...this.tasks, ...this.terminalInFlight].map(task => structuredClone(task));
  }

  get(taskId: string): PromptTask {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(t('提示词任务不存在: {{taskId}}', { taskId }));
    return task;
  }

  listRuns(taskId: string): TaskRun[] {
    return this.runs.filter((run) => run.taskId === taskId).map((run) => ({ ...run }));
  }

  /** 运行记录筛选口径：mode（含存量无 mode 回看）+ 日期范围（本地日，端点含入） */
  private matchRun(
    run: TaskRun,
    opts: { mode?: TaskRun['mode']; fromKey?: string; toKey?: string }
  ): boolean {
    if (opts.mode && run.mode !== opts.mode) {
      // 存量无 mode 字段但留下了 Pi 会话文件的，按无头回看
      if (!(opts.mode === 'headless' && Boolean(run.piSessionPath))) return false;
    }
    if (opts.fromKey || opts.toKey) {
      // 与日桶一致：按结束日（进行中尚无 finishedAt 则用 startedAt）
      const key = usageDayKey(run.finishedAt ?? run.startedAt);
      if (opts.fromKey && key < opts.fromKey) return false;
      if (opts.toKey && key > opts.toKey) return false;
    }
    return true;
  }

  /** 使用统计：全部任务运行记录（可按 mode/日期范围过滤），倒序带任务名/工作区，分页返回 */
  listRunsAcrossTasks(
    opts: { mode?: TaskRun['mode']; fromKey?: string; toKey?: string; offset?: number; limit?: number } = {}
  ): { rows: Array<TaskRun & { taskName?: string; workspaceId?: string }>; total: number } {
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const limit = Math.max(1, Math.floor(opts.limit ?? 100));
    const matched = this.runs
      .filter((run) => this.matchRun(run, opts))
      .sort((a, b) => b.startedAt - a.startedAt);
    return {
      rows: matched.slice(offset, offset + limit).map((run) => {
        const task = this.tasks.find((t) => t.id === run.taskId);
        return { ...run, taskName: task?.name, workspaceId: task?.workspaceId };
      }),
      total: matched.length
    };
  }

  /** 使用统计：范围内运行按任务聚合（失败优先排序）；口径与 listRunsAcrossTasks 同源 */
  aggregateRunsByTask(
    opts: { mode?: TaskRun['mode']; fromKey?: string; toKey?: string } = {}
  ): UsageHeadlessTaskStat[] {
    const byId = new Map<
      string,
      UsageHeadlessTaskStat & { durSum: number; durCount: number }
    >();
    for (const run of this.runs) {
      if (!this.matchRun(run, opts)) continue;
      let stat = byId.get(run.taskId);
      if (!stat) {
        const task = this.tasks.find((tk) => tk.id === run.taskId);
        stat = {
          taskId: run.taskId,
          taskName: task?.name,
          workspaceId: task?.workspaceId,
          total: 0,
          ok: 0,
          error: 0,
          durSum: 0,
          durCount: 0
        };
        byId.set(run.taskId, stat);
      }
      stat.total += 1;
      if (run.status === 'ok') stat.ok += 1;
      else if (run.status === 'error') stat.error += 1;
      if (run.durationMs != null) {
        stat.durSum += run.durationMs;
        stat.durCount += 1;
      }
    }
    const out = [...byId.values()].map(({ durSum, durCount, ...stat }) => ({
      ...stat,
      avgDurationMs: durCount ? Math.round(durSum / durCount) : undefined
    }));
    out.sort(
      (a, b) =>
        b.error - a.error ||
        b.total - a.total ||
        (a.taskName ?? a.taskId).localeCompare(b.taskName ?? b.taskId)
    );
    return out;
  }

  /** 使用统计：范围内指定状态的运行条数（全量，不分页——分页列表只覆盖首页） */
  countRunsByStatus(
    status: TaskRun['status'],
    opts: { mode?: TaskRun['mode']; fromKey?: string; toKey?: string } = {}
  ): number {
    return this.runs.filter((run) => run.status === status && this.matchRun(run, opts)).length;
  }

  /** 调度面板历史列表用：按 Pi 会话文件反查任务名（运行记录裁剪后旧会话可能查不到） */
  findTaskNameByPiSessionPath(piSessionPath: string): string | undefined {
    const run = this.runs.find((r) => r.piSessionPath === piSessionPath);
    if (!run) return undefined;
    return this.tasks.find((t) => t.id === run.taskId)?.name;
  }

  /** 宿主启动后传入无头执行器；离线测试可传入 mock。 */
  bindHeadless(ctx: AppContext | null, runner: HeadlessRunner): void {
    this.usage = ctx?.usage ?? null;
    // O12 决策门：调度状态经 ctx 读（晚绑定与 usage 同理；测试可注入 mock ctx）
    this.decisionGateCtx = ctx;
    this.flushPendingHeadlessInterrupts();
    this.headlessRunner = runner;
  }

  /** 构造期标中断的无头运行补记日桶（usage 晚绑定；只 flush 一次） */
  private flushPendingHeadlessInterrupts(): void {
    if (!this.usage || this.pendingHeadlessInterrupts <= 0) return;
    const n = this.pendingHeadlessInterrupts;
    this.pendingHeadlessInterrupts = 0;
    for (let i = 0; i < n; i++) {
      try {
        this.usage.recordHeadlessRun(false);
      } catch {
        /* 统计失败不影响启动 */
      }
    }
  }

  /** AgentSessionHost 就绪后绑定（晚于构造）；terminal 模式命中 GUI runtime 时靠它注入任务。传 null 解绑（测试复位用） */
  bindGuiHost(host: GuiPromptSender | null): void {
    this.guiHost = host;
  }

  private assertMode(mode: PromptTaskMode | undefined): PromptTaskMode {
    if (mode === 'headless') {
      throw new Error(t('定时任务不再支持无头模式'));
    }
    if (mode !== undefined && mode !== 'terminal') {
      throw new Error(t('mode 必须是 terminal，收到: {{mode}}', { mode }));
    }
    return 'terminal';
  }

  private assertMissedPolicy(policy: MissedPolicy | undefined): MissedPolicy {
    if (policy !== undefined && policy !== 'skip' && policy !== 'catch-up' && policy !== 'confirm') {
      throw new Error(t('missedPolicy 必须是 skip、catch-up 或 confirm，收到: {{policy}}', { policy }));
    }
    return resolveMissedPolicy(policy);
  }

  create(options: CreatePromptTaskOptions): PromptTask {
    assertTaskOptions(options);
    if (!options.name.trim()) throw new Error(t('任务名称不能为空'));
    if (!options.prompt.trim()) throw new Error(t('提示词不能为空'));
    const mode = this.assertMode(options.mode);
    if (options.configurePermissions !== undefined && typeof options.configurePermissions !== 'boolean') throw new Error('configurePermissions must be a boolean.');
    if (options.configurePermissions === true && options.guiMode && !supportsGuiPermissionMode(options.runtime, options.guiMode)) {
      throw new Error(t('当前引擎暂不支持此权限档，请重新选择'));
    }
    if (mode === 'terminal') this.assertRuntimeEnabled(options.runtime);
    const missedPolicy = this.assertMissedPolicy(options.missedPolicy);
    const workspaceId = options.workspaceId ?? this.config.get().activeWorkspaceId;
    const sourceRoot = capturePromptTaskSource(this.config.get(), { ...options, workspaceId });
    if (options.cliLaunchOptions !== undefined && this.sessions.isChatRuntime(options.runtime)) throw new Error('CLI launch options require a terminal Harness.');
    const validatedCliOptions = effectiveCliLaunchOptions(options.runtime, options.cliLaunchOptions, this.runtimes.get(options.runtime)?.manifest, options.configurePermissions === true, process.getuid?.());
    const cliLaunchOptions = options.configurePermissions === true ? validatedCliOptions : options.cliLaunchOptions;
    const nativeConfig = parseNativeConfigIntent(options.nativeConfig);
    if (options.configurePermissions === true && nativeConfig && (nativeConfig.identity.runtimeId !== options.runtime ||
        nativeConfig.identity.presetId !== (options.runtime === 'acp' ? options.piModeId?.trim() : undefined))) throw new Error('nativeConfig does not match the scheduled Harness.');
    // T6/A4：delayMinutes 与 schedule 二选一；相对延迟由宿主真实时钟换算成 once
    const resolvedSchedule = resolveScheduleInput({
      schedule: options.schedule,
      delayMinutes: options.delayMinutes
    });
    const maxRuns = validateMaxRuns(options.maxRuns);
    const modelParameters = buildGuiInheritMeta({ modelParameters: options.modelParameters })?.modelParameters;
    const task: PromptTask = {
      id: this.newId(),
      name: options.name.trim(),
      workspaceId,
      sourceRoot,
      runtime: options.runtime,
      prompt: options.prompt.trim(),
      schedule: resolvedSchedule,
      missedPolicy,
      mode,
      providerId: options.providerId?.trim() || undefined,
      modelId: options.modelId?.trim() || undefined,
      configurePermissions: options.configurePermissions,
      guiMode: options.guiMode,
      nativeConfig,
      cliLaunchOptions,
      piModeId: options.piModeId?.trim() || undefined,
      thinking: options.thinking,
      modelParameters,
      delayMinutes: options.delayMinutes,
      maxRuns,
      runCount: 0,
      enabled: options.enabled ?? false,
      createdAt: Date.now()
    };
    task.nextRunAt = task.enabled ? getNextRunAt(task.schedule) : undefined;
    this.tasks.push(task);
    this.persist();
    this.sessions.createScheduledTaskSession(task);
    this.arm(task);
    return task;
  }

  update(taskId: string, patch: UpdatePromptTaskOptions): PromptTask {
    assertTaskOptions(patch);
    const task = this.get(taskId);
    this.disarm(task.id);
    try {
      const nextName = patch.name !== undefined ? patch.name.trim() : task.name;
      if (!nextName) throw new Error(t('任务名称不能为空'));
      const nextPrompt = patch.prompt !== undefined ? patch.prompt.trim() : task.prompt;
      if (!nextPrompt) throw new Error(t('提示词不能为空'));
      // headless 已退役：显式传 headless 仍在此拒绝；断言恒返 terminal，无 mode 迁移分支
      this.assertMode(patch.mode);
      const nextRuntime = patch.runtime !== undefined && patch.runtime !== task.runtime ? patch.runtime : task.runtime;
      if (patch.configurePermissions !== undefined && typeof patch.configurePermissions !== 'boolean') throw new Error('configurePermissions must be a boolean.');
      const configurePermissions = patch.configurePermissions ?? task.configurePermissions;
      const nextGuiMode = patch.guiMode !== undefined ? patch.guiMode : nextRuntime === 'pi' ? task.guiMode : undefined;
      if (configurePermissions === true && nextGuiMode && !supportsGuiPermissionMode(nextRuntime, nextGuiMode)) {
        throw new Error(t('当前引擎暂不支持此权限档，请重新选择'));
      }
      if (nextRuntime !== task.runtime) {
        this.assertRuntimeEnabled(nextRuntime);
      }
      const nextSchedule =
        patch.schedule !== undefined || patch.delayMinutes !== undefined
          ? resolveScheduleInput({
              schedule: patch.schedule ?? (patch.delayMinutes !== undefined ? undefined : task.schedule),
              delayMinutes: patch.delayMinutes
            })
          : task.schedule;
      const nextMissedPolicy =
        patch.missedPolicy !== undefined ? this.assertMissedPolicy(patch.missedPolicy) : resolveMissedPolicy(task.missedPolicy);
      // 全部候选值先过一遍校验再写回：抛错时内存里不能残留非法 schedule/trigger 被后续 persist 落盘
      const nextMaxRuns = patch.maxRuns !== undefined ? validateMaxRuns(patch.maxRuns) : task.maxRuns;
      const nextModelParameters = patch.modelParameters === null ? undefined : patch.modelParameters !== undefined
        ? buildGuiInheritMeta({ modelParameters: patch.modelParameters })?.modelParameters : task.modelParameters;
      const nextRunAt = task.enabled ? getNextRunAt(nextSchedule) : undefined;
      const workspaceId = patch.workspaceId ?? task.workspaceId;
      const retarget = patch.rootId !== undefined || workspaceId !== task.workspaceId;
      const sourceRoot = retarget
        ? capturePromptTaskSource(this.config.get(), { workspaceId, rootId: patch.rootId, rootsRevision: patch.rootsRevision })
        : assertPromptTaskSource(this.config.get(), task);
      const nextPreset = patch.piModeId !== undefined ? patch.piModeId?.trim() || undefined : task.piModeId;
      if (patch.cliLaunchOptions != null && this.sessions.isChatRuntime(nextRuntime)) throw new Error('CLI launch options require a terminal Harness.');
      const rawCliOptions = patch.cliLaunchOptions === null ? undefined : patch.cliLaunchOptions !== undefined
        ? patch.cliLaunchOptions : nextRuntime === task.runtime ? task.cliLaunchOptions : undefined;
      const validatedCliOptions = effectiveCliLaunchOptions(nextRuntime, rawCliOptions, this.runtimes.get(nextRuntime)?.manifest, configurePermissions === true, process.getuid?.());
      const cliLaunchOptions = configurePermissions === true ? validatedCliOptions : rawCliOptions;
      const nativeConfig = patch.nativeConfig === null ? undefined : patch.nativeConfig !== undefined
        ? parseNativeConfigIntent(patch.nativeConfig)
        : nextRuntime === task.runtime && nextPreset === task.piModeId && !retarget ? task.nativeConfig : undefined;
      if (configurePermissions === true && nativeConfig && (nativeConfig.identity.runtimeId !== nextRuntime ||
          nativeConfig.identity.presetId !== (nextRuntime === 'acp' ? nextPreset : undefined))) throw new Error('nativeConfig does not match the scheduled Harness.');
      if (!retarget && patch.rootsRevision !== undefined) {
        capturePromptTaskSource(this.config.get(), { workspaceId, rootId: sourceRoot.rootId, rootsRevision: patch.rootsRevision });
      }
      if ([...this.terminalInFlight].some(run => run.id === taskId
        && (run.workspaceId !== workspaceId || run.sourceRoot?.rootId !== sourceRoot.rootId
          || run.sourceRoot?.path !== sourceRoot.path || run.sourceRoot?.physicalPath !== sourceRoot.physicalPath))) {
        throw new Error('scheduled task is starting; wait before changing its source folder');
      }
      task.name = nextName;
      task.prompt = nextPrompt;
      task.workspaceId = workspaceId;
      task.sourceRoot = structuredClone(sourceRoot);
      if (nextRuntime !== task.runtime) task.runtime = nextRuntime;
      if (patch.providerId !== undefined) task.providerId = patch.providerId.trim() || undefined;
      if (patch.modelId !== undefined) task.modelId = patch.modelId.trim() || undefined;
      if (patch.configurePermissions !== undefined) task.configurePermissions = configurePermissions;
      if (patch.guiMode !== undefined) task.guiMode = patch.guiMode || undefined;
      task.nativeConfig = nativeConfig;
      task.cliLaunchOptions = cliLaunchOptions;
      if (patch.piModeId !== undefined) task.piModeId = patch.piModeId?.trim() || undefined;
      if (patch.thinking !== undefined) task.thinking = patch.thinking || undefined;
      task.modelParameters = nextModelParameters;
      // delayMinutes 与 schedule 互斥：显式改 schedule 时清掉旧 delayMinutes 残留
      //（否则 UI 展示口径漂移——任务已按 schedule 跑，列表还标着「延迟 N 分钟」）
      if (patch.schedule !== undefined) {
        task.delayMinutes = undefined;
        this.onceFailureRetried.delete(task.id);
      }
      if (patch.delayMinutes !== undefined) {
        task.delayMinutes = patch.delayMinutes;
        this.onceFailureRetried.delete(task.id);
      }
      task.maxRuns = nextMaxRuns;
      task.schedule = nextSchedule;
      task.missedPolicy = nextMissedPolicy;
      task.nextRunAt = nextRunAt;
    } catch (error) {
      this.arm(task);
      throw error;
    }
    this.decisionGateDeferred.delete(task.id);
    this.persist();
    this.sessions.updateScheduledTaskSession(task);
    this.arm(task);
    return task;
  }

  enable(taskId: string): PromptTask {
    const task = this.get(taskId);
    assertPromptTaskSource(this.config.get(), task);
    // 用户重新启用 = 给全新机会：清掉失败重试标记，否则 once 任务 enable 后
    // arm 会因 lastResult 仍是 error 且已重试过而立即消费槽位再次停用
    this.onceFailureRetried.delete(taskId);
    // 先校验再改状态：非法 schedule 不应留下 enabled=true 但无定时器的中间态；
    // 事件触发（webhook/file/phase）不挂定时器，nextRunAt 为 undefined（等事件源评估）
    const nextRunAt = getNextRunAt(task.schedule);
    task.enabled = true;
    task.nextRunAt = nextRunAt;
    this.persist();
    this.arm(task);
    return task;
  }

  disable(taskId: string): PromptTask {
    const task = this.get(taskId);
    task.enabled = false;
    task.nextRunAt = undefined;
    this.decisionGateDeferred.delete(taskId);
    this.persist();
    this.disarm(task.id);
    this.syncKeepAwake();
    return task;
  }

  delete(taskId: string): void {
    this.get(taskId);
    this.disarm(taskId);
    this.decisionGateDeferred.delete(taskId);
    this.tasks = this.tasks.filter((task) => task.id !== taskId);
    this.persist();
    this.sessions.removeScheduledSession(taskId);
    this.syncKeepAwake();
  }

  async runNow(taskId: string): Promise<PromptTask> {
    const task = this.get(taskId);
    task.missedPendingConfirm = undefined;
    try {
      await this.run(task);
    } finally {
      // run() 重写了 nextRunAt，定时器必须重挂，否则到旧时间点会再触发一次
      this.arm(task);
    }
    return task;
  }

  private newId(): string {
    let id = '';
    do {
      id = randomUUID().slice(0, 12);
    } while (this.tasks.some((task) => task.id === id));
    return id;
  }

  private persist(): void {
    this.store.savePromptTasks(this.tasks);
  }

  /** 记录一次运行（新增或按 id 更新），超出上限时裁掉该任务最旧的记录 */
  private recordRun(run: TaskRun): void {
    const runs = [run, ...this.runs.filter((r) => r.id !== run.id)];
    const forTask = runs.filter((r) => r.taskId === run.taskId);
    if (forTask.length > MAX_RUNS_PER_TASK) {
      const drop = new Set(forTask.slice(MAX_RUNS_PER_TASK).map((r) => r.id));
      this.runs = runs.filter((r) => !drop.has(r.id));
    } else {
      this.runs = runs;
    }
    this.store.saveTaskRuns(this.runs);
  }

  private pushNotify(task: PromptTask, kind: 'done' | 'error' | 'info', label: string, text: string): void {
    try {
      this.notify?.push({
        workspaceId: task.workspaceId,
        sessionId: `task:${task.id}`,
        sessionName: t('定时任务 · {{name}}', { name: task.name }),
        kind,
        label,
        text,
        // 任务跑完需要人看结果
        toast: true
      });
    } catch {
      /* 通知失败不影响调度 */
    }
  }

  private disarm(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer) clearTimeout(timer);
    this.timers.delete(taskId);
  }

  /**
   * 一轮跑完后计算下一次运行时间。基准取「本轮开始时刻」与「当前时刻」中较大者：
   * 定时器可能早于计划时刻几毫秒触发（时钟偏差），若只按 lastRunAt 起算，
   * daily/weekly 会把刚刚触发过的这个槽位又算成下一次，arm() 便会误判为错过。
   * 事件触发（webhook/file/phase）无定时语义，返回 undefined。
   */
  private nextRunAtFrom(task: PromptTask, startedAt: number): number | undefined {
    return getNextRunAt(task.schedule, new Date(Math.max(startedAt, Date.now())));
  }

  /** 绑定电源宿主（构造之后）：keep-awake + resume 重评错过。传 null 解绑 */
  bindPower(host: PowerHost | null): void {
    this.releaseResume();
    this.releaseKeepAwake();
    if (this.cleanupErrors.size) throw new AggregateError(this.cleanupErrors.values(), 'Prompt task power cleanup failed');
    this.power = this.closing ? null : host;
    if (this.closing) return;
    if (host) {
      this.unbindResume = host.onResume(() => this.evaluateMissedOnWake());
      this.syncKeepAwake();
    }
  }

  /** 启动已由构造期 arm() 覆盖；系统唤醒（powerMonitor resume）再走一遍错过窗口 */
  evaluateMissedOnWake(): void {
    if (this.paused || this.closing) return;
    for (const task of this.tasks) {
      if (task.enabled) this.arm(task);
    }
    this.syncKeepAwake();
  }

  /** 设置页关掉 keep-awake 后立刻释放 blocker */
  syncKeepAwake(): void {
    if (this.paused || this.closing) { this.releaseKeepAwake(); return; }
    if (!this.power) return;
    const enabled = this.config.get().tasksKeepAwake !== false;
    const want = shouldKeepAwake({
      enabled,
      inFlightCount: this.headlessInFlight.size,
      nextRunAts: this.tasks.filter((t) => t.enabled).map((t) => t.nextRunAt),
      now: Date.now()
    });
    if (want) {
      if (this.keepAwakeId == null) {
        this.keepAwakeId = this.power.startPreventAppSuspension();
      }
    } else {
      this.releaseKeepAwake();
    }
  }

  private releaseKeepAwake(): void {
    if (this.keepAwakeId != null && this.power) {
      try {
        this.power.stop(this.keepAwakeId);
      } catch (error) {
        this.cleanupErrors.set('power', error);
        console.error('[tasks] keep-awake release failed', error);
        return;
      }
    }
    this.keepAwakeId = undefined;
    this.cleanupErrors.delete('power');
  }

  private releaseResume(): void {
    try { this.unbindResume?.(); this.unbindResume = null; this.cleanupErrors.delete('resume'); }
    catch (error) { this.cleanupErrors.set('resume', error); console.error('[tasks] resume listener release failed', error); }
  }

  /** before-quit：拆掉全部定时器（含 phase 延迟评估）与 keep-awake，避免退出窗口期还去拉终端 / 写盘 */
  stop(): void {
    this.paused = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.releaseResume();
    this.releaseKeepAwake();
    if (this.keepAwakeId === undefined) this.power = null;
  }

  start(): void {
    if (this.closing) throw new Error('Prompt task service is stopping');
    this.paused = false;
    let quarantined = false;
    for (const task of this.tasks) {
      try { this.arm(task); }
      catch (error) {
        task.enabled = false; task.nextRunAt = undefined; task.lastResult = 'error';
        task.lastError = t('任务配置无效，已自动停用：{{msg}}', { msg: error instanceof Error ? error.message : String(error) });
        this.disarm(task.id); quarantined = true;
      }
    }
    if (quarantined) this.persist();
    this.syncKeepAwake();
  }

  stopAdmission(): void { this.closing = true; this.stop(); }
  async shutdown(): Promise<void> {
    this.stopAdmission();
    await Promise.allSettled([...this.activeRuns, this.headlessChain]);
    if (this.cleanupErrors.size) throw new AggregateError(this.cleanupErrors.values(), 'Prompt task shutdown failed');
  }

  private arm(task: PromptTask): void {
    if (this.paused || this.closing) return;
    this.disarm(task.id);
    if (!this.tasks.includes(task)) return;
    if (!task.enabled) {
      this.syncKeepAwake();
      return;
    }
    if (!task.nextRunAt || task.nextRunAt <= Date.now()) {
      // O12 决策门暂缓链上的过期任务不是「错过」：系统唤醒（evaluateMissedOnWake）或
      // 重挂走到这里时，暂缓中的 nextRunAt 早已是过去时刻——不进错过窗口（skip 不会
      // 静默吞轮、catch-up 不会绕门补跑、confirm 不会误弹确认），nextRunAt 保持 due，
      // 只重挂 30s 重试，门放行后由重试 tick 真正执行。
      if (task.nextRunAt && this.onDecisionGateHold(task)) {
        this.decisionGateDeferred.set(task.id, Date.now());
        this.armDecisionGateRetry(task);
        this.syncKeepAwake();
        return;
      }
      const decision = evaluateMissedWindow({
        nextRunAt: task.nextRunAt,
        lastRunAt: task.lastRunAt,
        now: Date.now(),
        inFlight: this.headlessInFlight.has(task.id),
        policy: task.missedPolicy
      });
      const missedAt = task.nextRunAt;
      // C1：once 的 getNextRunAt 恒返回同一 at，不能在槽位已消费后继续推进——
      // 否则 0 延迟 setTimeout 会无限重跑。槽位已跑（none）或 skip/confirm 记账后自停；
      // 但「跑过且失败」（lastResult=error）不算消费：给一次短延迟自动重试，再失败才自停——
      // 否则「8 分钟后提醒我」执行失败即永久死亡，且默认 missedPolicy=skip 下重新 enable
      // 也救不回（nextRunAt 仍是过去的 at，arm 立即再走本分支消费停用）。
      if (decision.action === 'none') {
        if (task.schedule.kind === 'once') {
          if (task.lastResult === 'error' && !this.onceFailureRetried.has(task.id)) {
            this.onceFailureRetried.add(task.id);
            task.nextRunAt = Date.now() + ONCE_FAILURE_RETRY_MS;
            this.persist();
            // fall through 到尾部 setTimeout 挂表（5 分钟后重试）
          } else {
            consumeOnceSlot(task);
            this.persist();
            this.syncKeepAwake();
            return;
          }
        } else {
          // 周期任务：推进到未来槽位再挂
          task.nextRunAt = getNextRunAt(task.schedule);
          this.persist();
        }
      } else if (decision.action === 'catch-up' && missedAt) {
        task.nextRunAt = getNextRunAt(task.schedule);
        this.persist();
        const when = new Date(missedAt).toLocaleString();
        this.pushNotify(
          task,
          'info',
          t('错过运行'),
          t('「{{name}}」错过计划时间 {{when}}，正在补跑', { name: task.name, when })
        );
        this.syncKeepAwake();
        this.run(task, true)
          .catch((error) => console.error(`[tasks] 定时任务「${task.name}」补跑失败`, error))
          .finally(() => this.arm(task));
        return;
      } else {
        // skip / confirm：只记账不执行。once 消费后自停 return；周期任务推进到未来槽位后
        // **必须落到尾部 setTimeout 挂表**（复审 critical：return 会漏挂导致任务静默死亡）。
        // 例外：lastResult=error 说明「跑过且失败」的重试槽跨重启撞进 missed 窗口——
        // 按失败重试语义再排 5 分钟（transient 标记重启后为空，至多一次），不让
        // missedPolicy 把重试机会记成「已跳过」吞掉。
        const when = missedAt ? new Date(missedAt).toLocaleString() : '';
        const pending = decision.action === 'confirm';
        if (pending) task.missedPendingConfirm = true;
        if (task.schedule.kind === 'once') {
          if (task.lastResult === 'error' && !this.onceFailureRetried.has(task.id)) {
            this.onceFailureRetried.add(task.id);
            task.nextRunAt = Date.now() + ONCE_FAILURE_RETRY_MS;
            this.persist();
            // fall through 到尾部 setTimeout 挂表（重试）
          } else {
            consumeOnceSlot(task);
            this.recordRun({
              id: randomUUID().slice(0, 12),
              taskId: task.id,
              mode: 'missed',
              status: 'missed',
              startedAt: missedAt ?? Date.now(),
              finishedAt: Date.now(),
              error: pending
                ? t('错过计划时间 {{when}}（应用未运行），等待确认补跑', { when })
                : t('错过计划时间 {{when}}（应用未运行），已跳过', { when })
            });
            this.persist();
            this.pushNotify(
              task,
              'info',
              t('错过运行'),
              pending
                ? t('「{{name}}」错过计划时间 {{when}}，等待确认补跑', { name: task.name, when })
                : t('「{{name}}」错过计划时间 {{when}}，已跳过', { name: task.name, when })
            );
            this.syncKeepAwake();
            return;
          }
        }
        task.nextRunAt = getNextRunAt(task.schedule);
        this.recordRun({
          id: randomUUID().slice(0, 12),
          taskId: task.id,
          mode: 'missed',
          status: 'missed',
          startedAt: missedAt ?? Date.now(),
          finishedAt: Date.now(),
          error: pending
            ? t('错过计划时间 {{when}}（应用未运行），等待确认补跑', { when })
            : t('错过计划时间 {{when}}（应用未运行），已跳过', { when })
        });
        this.persist();
        this.pushNotify(
          task,
          'info',
          t('错过运行'),
          pending
            ? t('「{{name}}」错过计划时间 {{when}}，等待确认补跑', { name: task.name, when })
            : t('「{{name}}」错过计划时间 {{when}}，已跳过', { name: task.name, when })
        );
        // 周期任务 fall-through 到尾部 setTimeout
      }
    }
    const delay = Math.max(0, task.nextRunAt - Date.now());
    const timer = setTimeout(() => {
      // O12 决策门：调度域（headless）定时触发撞上调度 needs_you → 本次跳过、
      // 保持 due 下轮再试（重试定时器仍挂 this.timers，disarm/stop 照常可清）
      if (this.deferForDecisionGate(task)) return;
      // run() 失败已记 lastError 并落盘；这里必须吞掉异常，否则成为 unhandled rejection
      this.run(task, true)
        .catch((error) => console.error(`[tasks] 定时任务「${task.name}」执行失败`, error))
        .finally(() => this.arm(task));
    }, delay);
    this.timers.set(task.id, timer);
    this.syncKeepAwake();
  }

  /**
   * O12 决策门（wmux hasPendingDecision 原型）：目标工作区的调度在等人时，调度域
   * 定时触发（headless——跑调度提示词 + 调度工具面，等于从旁开调度回合）本轮跳过：
   * 不执行、不记运行、nextRunAt 保持 due（不进错过策略），短间隔后再试；调度相位移出
   * needs_you（sessions.setStatus）后自然放行。terminal 模式拉的是独立 Worker 会话，
   * 不碰调度，不受门限制。读状态失败一律当不挡（fail-open）。
   */
  private deferForDecisionGate(task: PromptTask): boolean {
    if ((task.mode ?? 'terminal') !== 'headless') return false;
    if (!this.schedulerBlockedOnHuman(task.workspaceId)) {
      // 门放行：摘暂缓标记，由调用方真正执行
      this.decisionGateDeferred.delete(task.id);
      return false;
    }
    this.decisionGateDeferred.set(task.id, Date.now());
    this.armDecisionGateRetry(task);
    return true;
  }

  /** 决策门 30s 重试定时器（仍挂 this.timers，disarm/stop 照常可清） */
  private armDecisionGateRetry(task: PromptTask): void {
    if (this.paused || this.closing) return;
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      this.decisionGateRetryTick(task);
    }, DECISION_GATE_RETRY_MS);
    this.timers.set(task.id, timer);
  }

  /** 决策门重试到点：门仍挡继续暂缓（重挂重试）；放行则摘标记真正执行 */
  private decisionGateRetryTick(task: PromptTask): void {
    if (this.paused || this.closing) return;
    if (this.deferForDecisionGate(task)) return;
    this.run(task, true)
      .catch((error) => console.error(`[tasks] 定时任务「${task.name}」执行失败`, error))
      .finally(() => this.arm(task));
  }

  /**
   * 过期任务是否处于决策门暂缓链上：内存暂缓标记在（本进程暂缓中），或 headless
   * 调度域此刻仍 needs_you——后者兜底重启场景（重启后内存标记随进程丢失，但
   * scheduler-status.json 的 needs_you 还在，同样不该判错过）。只豁免决策门链上的
   * 任务：普通过期（无标记且门开/非 headless）照旧进错过窗口。
   */
  private onDecisionGateHold(task: PromptTask): boolean {
    if (this.decisionGateDeferred.has(task.id)) return true;
    return (task.mode ?? 'terminal') === 'headless' && this.schedulerBlockedOnHuman(task.workspaceId);
  }

  /**
   * X1-F02 单一等人谓词：C1 持久账（scheduler-status needs_you）或 C2 内存 ask 卡
   * 任一在等即 true；decisionGateCtx 未绑定（测试/宿主早期）或读失败一律 false
   * （fail-open=不挡）。
   */
  private schedulerBlockedOnHuman(workspaceId: string): boolean {
    if (!this.decisionGateCtx) return false;
    return isSchedulerWaitingOnHuman(this.decisionGateCtx, workspaceId);
  }

  private assertRuntimeEnabled(runtime: string): void {
    if (!this.runtimes.get(runtime)?.enabled) {
      throw new Error(t('runtime 未注册或已禁用: {{runtime}}', { runtime }));
    }
  }

  private run(task: PromptTask, scheduled = false): Promise<void> {
    if (this.paused || this.closing) return Promise.reject(new Error('Prompt task service is not accepting runs'));
    const pending = Promise.resolve().then(() => {
      if (this.paused || this.closing) throw new Error('Prompt task service is not accepting runs');
      return this.runInner(task, scheduled);
    }); this.activeRuns.add(pending);
    void pending.then(() => this.activeRuns.delete(pending), () => this.activeRuns.delete(pending));
    return pending;
  }

  private async runInner(task: PromptTask, scheduled = false): Promise<void> {
    if (scheduled) {
      const at = Date.now();
      if (this.timeEventSink) this.timeEventSink(task, at);
      else this.pendingTimeEvents.push({ task: structuredClone(task), at });
    }
    task.missedPendingConfirm = undefined;
    // 真正执行即摘决策门暂缓标记（含 runNow 直通）：本轮不再是「暂缓中」
    this.decisionGateDeferred.delete(task.id);
    if ((task.mode ?? 'terminal') === 'headless') {
      // 无头不阻塞调用方（runNow/定时器）：内部串行排队，完成时自行落盘并重挂
      this.startHeadless(task);
      return;
    }
    task.lastRunAt = Date.now();
    this.sessions.touchScheduledSession(task.id, task.lastRunAt);
    const run: TaskRun = {
      id: randomUUID().slice(0, 12),
      taskId: task.id,
      mode: 'terminal',
      status: 'running',
      startedAt: task.lastRunAt
    };
    this.recordRun(run);
    const snapshot = structuredClone(task);
    this.terminalInFlight.add(snapshot);
    try {
      // 运行前置检查（runtime 可用性/源目录）与拉起同在记账范围内：任何一步失败都
      // 进 TaskRun/lastError/lastResult 与原通知策略（W5），不新建会话、不记成功次数
      this.assertRuntimeEnabled(task.runtime);
      const config = this.config.get();
      const source = assertPromptTaskSource(config, snapshot);
      // prompt-tasks F-02：半配模型（providerId/modelId 只给一半）静默降级为不覆盖
      // 模型时，把降级写进本次运行记录（运行历史可见，不再只有 console.warn）。
      let inheritDegradedNote: string | undefined;
      const inheritMeta = inheritMetaFromPromptTask(snapshot, (note) => {
        inheritDegradedNote = note;
      });
      const runPrompt = snapshot.prompt;
      const isGuiRuntime = this.sessions.isChatRuntime(snapshot.runtime);
      const initialPrompt = isGuiRuntime ? runPrompt : buildTaskBriefText(runPrompt, { rules: config.agentRules });
      const session = await this.sessions.createTerminal({
        name: `${snapshot.name} · ${new Date(snapshot.lastRunAt!).toLocaleString()}`,
        runtime: snapshot.runtime,
        workspaceId: snapshot.workspaceId,
        rootId: source.rootId,
        cwd: source.cwd,
        capturedSource: source,
        initialPrompt,
        cliLaunchOptions: snapshot.cliLaunchOptions,
        meta: { taskId: task.id },
        ...(inheritMeta ? { inheritMeta } : {})
      });
      run.sessionId = session.id;
      if (this.closing) throw new Error('Workbench stopped before scheduled task injection; inspect the created session before retrying');
      // GUI（chat surface）runtime：createTerminal 会忽略 initialPrompt（GUI 约定派活方
      // 经 AgentSessionHost.send 注入，与 delegateTask 同一分流），任务原文在这里补发。
      // send 派发即返回（回合异步推进），不会阻塞定时器；失败按本轮执行失败走统一收尾。
      if (isGuiRuntime) {
        if (!this.guiHost) throw new Error(t('GUI 会话宿主未就绪（应用初始化异常）'));
        const sent = await this.guiHost.send(session.id, runPrompt, undefined, { fromInject: true });
        if (!sent.ok) throw new Error(sent.error || t('任务注入失败'));
      }
      task.lastResult = 'ok';
      task.lastError = undefined;
      this.onceFailureRetried.delete(task.id);
      // C2/T6：成功触发计数与自停必须在生产 terminal 路径生效（不能只留在已退役 headless）
      task.runCount = (task.runCount ?? 0) + 1;
      if (shouldAutoDisableAfterRun({
        schedule: task.schedule,
        maxRuns: task.maxRuns,
        runCount: task.runCount
      })) {
        consumeOnceSlot(task);
        task.enabled = false;
        task.nextRunAt = undefined;
      } else {
        task.nextRunAt = this.nextRunAtFrom(task, task.lastRunAt);
      }
      this.persist();
      run.status = 'ok';
      run.finishedAt = Date.now();
      run.durationMs = run.finishedAt - run.startedAt;
      if (inheritDegradedNote) run.error = inheritDegradedNote;
      this.recordRun(run);
    } catch (error) {
      task.lastResult = 'error';
      task.lastError = error instanceof Error ? error.message : String(error);
      task.nextRunAt = this.nextRunAtFrom(task, task.lastRunAt);
      this.persist();
      run.status = 'error';
      run.error = task.lastError;
      run.finishedAt = Date.now();
      run.durationMs = run.finishedAt - run.startedAt;
      this.recordRun(run);
      this.pushNotify(task, 'error', t('执行失败'), t('「{{name}}」执行失败：{{err}}', { name: task.name, err: task.lastError }));
      throw error;
    } finally {
      this.terminalInFlight.delete(snapshot);
    }
  }

  /** 无头运行入口：同任务已在跑则跳过本轮（完成时会重挂）；不同任务进串行链排队 */
  private startHeadless(task: PromptTask): void {
    if (this.headlessInFlight.has(task.id)) return;
    this.headlessInFlight.add(task.id);
    const releaseSource = holdPendingSource(this.config, { workspaceId: task.workspaceId, capturedSource: task.sourceRoot },
      { kind: 'service', id: task.id, label: task.name, serviceId: task.id });
    this.syncKeepAwake();
    const exec = async (): Promise<void> => {
      try {
        await this.execHeadless(task);
      } catch (error) {
        console.error(`[tasks] 定时任务「${task.name}」无头执行异常`, error);
      } finally {
        this.headlessInFlight.delete(task.id);
        releaseSource();
        this.arm(task);
        this.syncKeepAwake();
      }
    };
    this.headlessChain = this.headlessChain.then(exec, exec);
  }

  private async execHeadless(task: PromptTask): Promise<void> {
    task.lastRunAt = Date.now();
    this.sessions.touchScheduledSession(task.id, task.lastRunAt);
    const run: TaskRun = {
      id: randomUUID().slice(0, 12),
      taskId: task.id,
      mode: 'headless',
      status: 'running',
      startedAt: task.lastRunAt
    };
    this.recordRun(run);
    let result: HeadlessRunResult;
    try {
      if (!this.headlessRunner) throw new Error(t('无头执行器未绑定（bindHeadless 未调用）'));
      result = await this.headlessRunner(task, {
        onSessionReady: (path) => {
          run.piSessionPath = path;
          this.recordRun(run);
        },
        onOutput: (text) => {
          run.output = text;
          this.recordRun(run);
        }
      });
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    run.piSessionPath = result.piSessionPath;
    run.output = result.output;
    if (result.ok) {
      run.status = 'ok';
      task.lastResult = 'ok';
      task.lastError = undefined;
      this.onceFailureRetried.delete(task.id);
      // T6/A4：成功触发计数；once 或 maxRuns 达到后自动停用
      task.runCount = (task.runCount ?? 0) + 1;
      if (
        shouldAutoDisableAfterRun({
          schedule: task.schedule,
          maxRuns: task.maxRuns,
          runCount: task.runCount
        })
      ) {
        task.enabled = false;
      }
    } else {
      run.status = 'error';
      run.error = result.error;
      task.lastResult = 'error';
      task.lastError = result.error;
    }
    run.finishedAt = Date.now();
    run.durationMs = result.durationMs ?? run.finishedAt - run.startedAt;
    // 无头计数口径：与 task-runs 列表同源（含启动即败）
    try {
      this.usage?.recordHeadlessRun(result.ok);
    } catch {
      /* 统计失败不影响任务收尾 */
    }
    this.recordRun(run);
    task.nextRunAt = task.enabled
      ? getNextRunAt(task.schedule, new Date(run.finishedAt))
      : undefined;
    this.persist();
    if (!result.ok) {
      this.pushNotify(
        task,
        'error',
        t('执行失败'),
        t('「{{name}}」无头执行失败：{{err}}', { name: task.name, err: result.error ?? t('未知错误') })
      );
    }
  }
}

