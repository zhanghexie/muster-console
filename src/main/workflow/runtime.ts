/**
 * 工作流运行时（dynamic-workflow W1）：run 生命周期、wf.* 实现、等待登记、自动记账、
 * 护栏与重启续跑。不直接依赖 AppContext——派活/调工具/事件出口/信任确认都经 deps
 * 注入（wiring.ts 用真 ctx 装配，test/workflow-runtime.mjs 用假件直测）。
 *
 * 续跑语义：启动时未结束的顶层 run 从头重跑脚本（内容指纹须与启动时一致），
 * delegate/ask/waitFor/call（及带 key 的 wf.run）按记账键命中直接返回旧结果；
 * wf.run（无 key）/tool/read/glob 不记账（创作说明要求命令幂等）。子工作流随父 run 的
 * wf.call 重跑时续上。派活先记「准备派」+ 确定性任务 id，崩溃重跑时按会话创建标识找回。
 *
 * 触发：frontmatter schedule（随预算巡检 tick 判定到点）/ on（事件泵旁听点命中）由宿主
 * 直接起 run；只对已信任的当前指纹生效，无人值守不弹确认。
 */
import { startOwnedCommand } from '../agentSession/process/ownedCommand';
import { BackgroundPtyStartupCleanupError, BackgroundPtyCleanupError } from '../pty/backgroundOwner';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  appendWorkflowLog,
  describeWaitMatch,
  describeWorkflowRun,
  describeWorkflowSchedule,
  formatWorkflowEventDetail,
  globToRegExp,
  isWorkflowRunActive,
  matchWaitEvent,
  parseWaitMatch,
  phaseSnapshotSatisfies,
  selectWorkflowRunsToPrune,
  stableStringify,
  validateWorkflowArgs,
  waitMatchSessionId,
  workflowBudgetError,
  workflowDelegateTaskId,
  workflowRunView,
  workflowRunCommandLog,
  WORKFLOW_LIMITS,
  WORKFLOW_MEMO_PENDING,
  WORKFLOW_NAME_RE,
  WORKFLOW_TOOL_DENYLIST,
  WorkflowMemoCounter,
  type WorkflowOverview,
  type WorkflowRunRecord,
  type WorkflowRunTrigger,
  type WorkflowTriggerEntry,
  type WorkflowTriggerState,
  type WorkflowTrustState
} from '../../shared/workflow';
import type { PolicyEventView, PolicyMatch } from '../../shared/subscriptionPolicy';
import type { TaskSchedule } from '../../shared/types';
import { getNextRunAt } from '../tasks/schedule';
import { WorkflowKernel, smokeImportWorkflow, type KernelCall, type KernelOutcome, type WorkflowWorkerLease } from './kernel';
import {
  deleteRunRecord,
  listRunRecords,
  listWorkflows,
  loadWorkflow,
  readRunRecord,
  readTriggerState,
  workflowFingerprint,
  workflowsDir,
  writeRunRecord,
  writeRunFailure,
  writeTriggerState,
  type LoadedWorkflow
} from './store';

export type WorkflowEventTrigger =
  | 'started'
  | 'phase'
  | 'ask'
  | 'ask_human'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'trigger_blocked';

export interface WorkflowDelegateResult {
  sessionId?: string;
  sessionName?: string;
  taskId?: string;
  isolate?: boolean;
}

/** 派活控制句柄：派活出口登记撤销回调（排队未出队时撤销），run 取消时收回 */
export interface WorkflowDelegateControl {
  registerCancel: (cancel: () => boolean) => void;
}

export interface WorkflowRuntimeDeps {
  now?: () => number;
  workspaceIds: () => string[];
  workspaceRoot: (workspaceId: string) => string | undefined;
  /** 进度事件出口（事件泵 workflow 种类） */
  emit: (workspaceId: string, e: { runId: string; name: string; trigger: WorkflowEventTrigger; detail: string }) => void;
  /** 派活：排队时须等到真正拉起再 resolve；失败 reject。ctl 供 run 取消时撤销排队项 */
  delegate: (
    workspaceId: string,
    input: Record<string, unknown>,
    ctl?: WorkflowDelegateControl
  ) => Promise<WorkflowDelegateResult>;
  executeTool: (workspaceId: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  /** 会话当前相位（waitFor phase 先查现状）；查不到返回 undefined */
  sessionPhase?: (workspaceId: string, sessionId: string) => string | undefined;
  /** The origin is supplied by the host entry point, not workflow parameters. */
  ensureTrusted: (workspaceId: string, wf: LoadedWorkflow, initiatedBy?: 'human' | 'agent', signal?: AbortSignal) => Promise<boolean>;
  deleteSessionAsHuman?: (workspaceId: string, sessionId: string) => Promise<void>;
  /** 不弹窗的信任查询（触发用）：当前指纹已信任 / 信任过旧版本 / 从未信任 */
  trustState: (workspaceId: string, name: string, fingerprint: string) => WorkflowTrustState;
  revokeTrust?: (workspaceId: string, name: string) => void;
  /** 问用户的问题亮出时提醒人（桌面通知） */
  notifyHuman?: (workspaceId: string, info: { runId: string; name: string; question: string }) => void;
  /** run 记录 / 触发状态有变化（面板刷新） */
  onChange?: (workspaceId: string) => void;
  /** 删除工作流目录（wiring 走系统回收站；缺省直接删） */
  removeDir?: (dir: string) => Promise<void>;
  /** 定时下一次到点（默认复用定时任务的 getNextRunAt） */
  nextScheduleAt?: (schedule: TaskSchedule, fromMs: number) => number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

export interface WorkflowStartOptions {
  parent?: LiveRun;
  trigger?: WorkflowRunTrigger;
}

interface Waiter {
  match: PolicyMatch;
  resolve: (v: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  cancel(): void;
}

/** run 自有的 wf.run 子进程：终态（取消/失败/超时/关机）按 PID 收整棵进程树 */
interface OwnedChild {
  killTree: (reason: string) => void;
  close(): Promise<void>;
}

/** 发出但尚未落地的派活（排队/创建中）：取消时先试撤销，撤不掉的按选项迟到补偿 */
interface InFlightDelegate {
  key: string;
  creationKey: string;
  /** 派活出口登记的撤销回调（未登记=不可撤销，只能迟到补偿） */
  cancel?: () => boolean;
  /** run 已请求取消（含撤销回调尚未登记的交接窗口：晚登记时立即消费） */
  cancelRequested?: boolean;
  /** 撤销已生效：delegate promise 将以取消错误 reject */
  cancelled?: boolean;
  /** run 取消时要求 closeSessions：迟到返回/迟到失败后补偿关闭 */
  lateCloseSessions?: boolean;
  lateCloseInitiatedBy?: 'human' | 'agent';
  /** 已结算（防迟到结果重复处理） */
  settled?: boolean;
}

interface LiveRun {
  controller: AbortController;
  rec: WorkflowRunRecord;
  root: string;
  kernel: WorkflowKernel | null;
  memo: WorkflowMemoCounter;
  waiters: Set<Waiter>;
  /** 本 run 自有的 wf.run 子进程与在途派活：终态统一收回（内存资源，不进 run 记录） */
  children: Set<OwnedChild>;
  inFlight: Set<InFlightDelegate>;
  ask?: { askId: string; resolve: (answer: unknown) => void; cancel(): void };
  /** 已被取消/超限/关机收口：内核结局不再改状态 */
  stopped: boolean;
  persistenceFailed?: boolean;
  settled: Promise<WorkflowRunRecord>;
  resolveSettled: (rec: WorkflowRunRecord) => void;
}

const CALL_MEMO_CHILD = '__child';
const CALL_MEMO_DONE = '__done';
const BUDGET_TICK_MS = 60_000;
const DENIED_READ_PREFIXES = ['.muster/local/', '.muster/runtime.json', '.git/'];
const GLOB_SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'release']);

export class WorkflowError extends Error {}

function shortId(prefix: string): string {
  return `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function clipJson(v: unknown, max: number): unknown {
  const s = stableStringify(v);
  return s.length <= max ? v : `${s.slice(0, max)}…（已截断）`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function quoteWinArg(a: string): string {
  return /[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

function pushUnique(list: string[] | undefined, v: string | undefined): string[] | undefined {
  if (!v) return list;
  const out = list ?? [];
  if (!out.includes(v)) out.push(v);
  return out;
}

export class WorkflowRuntime {
  private live = new Map<string, LiveRun>();
  private pendingStarts = new Set<{ ws: string; name: string; trigger: WorkflowRunTrigger }>();
  private generation = 0;
  private readonly admission = new AbortController();
  private shutdownPending?: Promise<void>;
  private readonly kernels = new Set<WorkflowKernel>();
  private readonly commands = new Set<OwnedChild>();
  private readonly commandRuns = new WeakMap<OwnedChild, string>();
  private readonly kernelRuns = new WeakMap<WorkflowKernel, string>();
  private readonly starts = new Set<Promise<WorkflowRunRecord>>();
  private readonly accepted = new Set<Promise<unknown>>();
  private readonly validationWorkers = new Set<WorkflowWorkerLease>();
  private accept<T>(work: () => Promise<T>): Promise<T> {
    if (this.admission.signal.aborted) return Promise.reject(new WorkflowError('工作流运行时已关闭'));
    const pending = work(); this.accepted.add(pending);
    void pending.then(() => this.accepted.delete(pending), () => this.accepted.delete(pending));
    return pending;
  }
  /** Keep errors visible even if both the primary record and failure record cannot be written. */
  private failedWrites = new Map<string, WorkflowRunRecord>();
  private tick: ReturnType<typeof setInterval> | null = null;
  /** 工作区 → 触发状态（懒加载，改动即落盘） */
  private triggerStates = new Map<string, WorkflowTriggerState>();
  /** 工作区 → 声明了触发的工作流（每次巡检刷新） */
  private triggerDefs = new Map<string, LoadedWorkflow[]>();
  /** 工作流派出的会话/任务 id → 过期时刻（其事件不触发工作流） */
  private owned = new Map<string, number>();

  constructor(private deps: WorkflowRuntimeDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private root(ws: string): string {
    const r = this.deps.workspaceRoot(ws);
    if (!r) throw new WorkflowError(`未知工作区 ${ws}`);
    return r;
  }

  start(): void {
    if (this.admission.signal.aborted) throw new WorkflowError('工作流运行时已关闭');
    this.stop();
    const si: NonNullable<WorkflowRuntimeDeps['setInterval']> = this.deps.setInterval ?? setInterval;
    this.tick = si(() => {
      this.checkBudgets();
      this.checkTriggers();
    }, BUDGET_TICK_MS);
    (this.tick as NodeJS.Timeout).unref?.();
  }

  stop(): void {
    if (this.tick != null) (this.deps.clearInterval ?? clearInterval)(this.tick);
    this.tick = null;
  }

  stopAdmission(): void { this.admission.abort(); this.stop(); }

  /** 关机：硬杀内核与自有子进程，但保留 running/waiting 状态，下次启动续跑（重查信任） */
  shutdown(): Promise<void> {
    if (this.shutdownPending) return this.shutdownPending;
    this.stopAdmission();
    this.generation++;
    this.pendingStarts.clear();
    const initialErrors: unknown[] = [];
    for (const live of this.live.values()) {
      live.stopped = true;
      live.controller.abort();
      for (const w of live.waiters) w.cancel();
      live.ask?.cancel();
      for (const entry of live.inFlight) {
        entry.cancelRequested = true;
        try { entry.cancelled = entry.cancel?.() === true; } catch (error) { initialErrors.push(error); }
      }
      for (const c of live.children) c.killTree('应用关闭');
      live.children.clear();
      live.rec.updatedAt = this.now();
      try { this.persist(live); } catch (error) { initialErrors.push(error); }
      live.kernel?.kill('应用关闭');
      live.resolveSettled(live.rec);
    }
    this.live.clear();
    try { this.retryFailureRecords(); } catch (error) { initialErrors.push(error); }
    this.shutdownPending = (async () => {
      await Promise.allSettled([...this.starts, ...this.accepted]);
      const results = await Promise.allSettled([
        ...[...this.commands].map(async command => { await command.close(); this.commands.delete(command); }),
        ...[...this.validationWorkers].map(async owner => { await owner.release(); this.validationWorkers.delete(owner); }),
        ...[...this.kernels].map(async kernel => { await kernel.release(); this.kernels.delete(kernel); })
      ]);
      const errors = [...initialErrors, ...results.filter(result => result.status === 'rejected').map(result => result.reason)];
      if (errors.length) throw new AggregateError(errors, 'Workflow resource shutdown failed');
    })();
    void this.shutdownPending.catch(() => { this.shutdownPending = undefined; });
    return this.shutdownPending;
  }

  // ------------------------------------------------------------------
  // 调度工具面
  // ------------------------------------------------------------------

  list(ws: string): Record<string, unknown> {
    const root = this.root(ws);
    const now = this.now();
    const runs = this.records(ws, root);
    return {
      workflows: listWorkflows(root).map((w) => ({
        name: w.name,
        ...(w.def
          ? {
              description: w.def.description,
              args: w.def.args.map((a) => (a.optional ? `${a.name}?` : a.name)),
              maxDelegates: w.def.maxDelegates,
              maxHours: w.def.maxHours,
              ...(w.def.schedule ? { schedule: describeWorkflowSchedule(w.def.schedule) } : {}),
              ...(w.def.on ? { on: w.def.on, cooldownMin: w.def.cooldownMin } : {})
            }
          : {}),
        trust: w.fingerprint ? this.deps.trustState(ws, w.name, w.fingerprint) : 'never',
        ...(this.triggerStateOf(ws)[w.name]?.disabled ? { triggersDisabled: true } : {}),
        ...(w.errors.length ? { errors: w.errors } : {}),
        ...(w.warnings.length ? { warnings: w.warnings } : {})
      })),
      active: runs.filter((r) => isWorkflowRunActive(r.status)).map((r) => describeWorkflowRun(r, now, { logTail: 0 })),
      recent: runs
        .filter((r) => !isWorkflowRunActive(r.status))
        .slice(0, 5)
        .map((r) => ({ runId: r.runId, name: r.name, status: r.status, endedAt: r.endedAt, ...(r.error ? { error: r.error } : {}) }))
    };
  }

  /** 面板视图：工作流清单（信任/触发状态）+ 活跃 run + 最近结束的顶层 run */
  overview(ws: string): WorkflowOverview {
    const root = this.root(ws);
    const now = this.now();
    const states = this.triggerStateOf(ws);
    const records = this.records(ws, root);
    return {
      workflows: listWorkflows(root).map((w) => {
        const trust: WorkflowTrustState = w.fingerprint ? this.deps.trustState(ws, w.name, w.fingerprint) : 'never';
        const st = states[w.name];
        const def = w.def;
        const anchored = !!def?.schedule && trust === 'trusted' && !st?.disabled && st?.anchorFingerprint === w.fingerprint;
        return {
          name: w.name,
          fingerprint: w.fingerprint,
          trust,
          ...(def
            ? {
                description: def.description,
                args: def.args.map((a) => (a.optional ? `${a.name}?` : a.name)),
                ...(def.schedule ? { schedule: describeWorkflowSchedule(def.schedule) } : {}),
                ...(def.on ? { on: describeWaitMatch(def.on), cooldownMin: def.cooldownMin } : {})
              }
            : {}),
          ...(st?.disabled ? { triggersDisabled: true } : {}),
          ...(anchored && def?.schedule
            ? { nextDueAt: this.nextDue(def.schedule, Math.max(st?.lastFiredAt ?? 0, st?.anchorAt ?? now)) }
            : {}),
          ...(st?.lastFiredAt || st?.lastEventAt ? { lastFiredAt: Math.max(st.lastFiredAt ?? 0, st.lastEventAt ?? 0) } : {}),
          ...(st?.lastSkip ? { lastSkip: st.lastSkip } : {}),
          ...(w.errors.length ? { errors: w.errors } : {}),
          ...(w.warnings.length ? { warnings: w.warnings } : {})
        };
      }),
      active: records.filter((r) => isWorkflowRunActive(r.status)).map((r) => workflowRunView(r, now)),
      recent: records
        .filter((r) => !r.parentRunId && !isWorkflowRunActive(r.status))
        .slice(0, 10)
        .map((r) => workflowRunView(r, now, 30))
    };
  }

  /** 面板「信任」记录当前指纹（不运行）；定时基准随之重置。 */
  trust(ws: string, name: string, initiatedBy: 'human' | 'agent' = 'agent'): Promise<boolean> {
    return this.accept(() => this.trustInner(ws, name, initiatedBy));
  }
  private async trustInner(ws: string, name: string, initiatedBy: 'human' | 'agent'): Promise<boolean> {
    const wf = loadWorkflow(this.root(ws), name);
    if (wf.errors.length || !wf.def) throw new WorkflowError(`工作流 ${name} 不可用：${wf.errors.join('；')}`);
    const ok = await this.deps.ensureTrusted(ws, wf, initiatedBy, this.admission.signal);
    this.deps.onChange?.(ws);
    return ok;
  }

  revokeTrust(ws: string, name: string): void {
    this.deps.revokeTrust?.(ws, name);
    this.deps.onChange?.(ws);
  }

  /** 面板「停用触发 / 启用触发」：文件不动；恢复时定时基准从此刻重立，不补跑停用期间 */
  setTriggersEnabled(ws: string, name: string, enabled: boolean): void {
    const wf = loadWorkflow(this.root(ws), name);
    if (!wf.def) throw new WorkflowError(`工作流 ${name} 不可用：${wf.errors.join('；')}`);
    const st = this.triggerEntry(ws, name);
    if (enabled) {
      delete st.disabled;
      st.anchorAt = this.now();
      st.anchorFingerprint = wf.fingerprint;
    } else {
      st.disabled = true;
    }
    this.saveTriggerState(ws);
  }

  /** 面板清理运行历史：只删已结束的顶层 run（不给 runIds 即全部），子 run 随父删除；返回删除条数 */
  clearRuns(ws: string, runIds?: string[]): number {
    const root = this.root(ws);
    const records = this.records(ws, root);
    const pick = runIds ? new Set(runIds) : null;
    const tops = new Set(
      records
        .filter((r) => !r.parentRunId && !isWorkflowRunActive(r.status) && !this.live.has(r.runId) && (!pick || pick.has(r.runId)))
        .map((r) => r.runId)
    );
    const ids = [...tops];
    for (const r of records) {
      if (r.parentRunId && tops.has(r.parentRunId) && !this.live.has(r.runId)) ids.push(r.runId);
    }
    for (const id of ids) {
      deleteRunRecord(root, id);
      this.failedWrites.delete(id);
    }
    if (ids.length) this.deps.onChange?.(ws);
    return tops.size;
  }

  /** 面板「删除工作流」：有活跃 run 时拒绝；目录经 deps.removeDir（回收站）删除，清触发状态与信任 */
  deleteWorkflow(ws: string, name: string): Promise<void> { return this.accept(() => this.deleteWorkflowInner(ws, name)); }
  private async deleteWorkflowInner(ws: string, name: string): Promise<void> {
    if (!WORKFLOW_NAME_RE.test(name)) throw new WorkflowError(`工作流名不合法：${name}`);
    const root = this.root(ws);
    const dir = path.join(workflowsDir(root), name);
    if (!fs.existsSync(dir)) throw new WorkflowError(`找不到工作流 ${name}`);
    const running = [...this.live.values()].some((l) => l.rec.workspaceId === ws && l.rec.name === name)
      || [...this.pendingStarts].some(p => p.ws === ws && p.name === name);
    if (running) throw new WorkflowError(`工作流 ${name} 还有运行中的 run，先取消再删除`);
    if (this.deps.removeDir) await this.deps.removeDir(dir);
    else fs.rmSync(dir, { recursive: true, force: true });
    delete this.triggerStateOf(ws)[name];
    this.triggerDefs.delete(ws);
    this.deps.revokeTrust?.(ws, name);
    this.saveTriggerState(ws);
  }

  /**
   * 实际执行工作流模块代码（worker import，含模块顶层）前的统一信任门。
   * - interactive=true（手动 start / validate 冒烟）：已信任直接放行，否则弹确认（ensureTrusted），
   *   拒绝/取消返回 {ok:false, reason:'declined'}；确认即记入信任表
   * - interactive=false（触发 / 重启恢复）：只认已信任的当前指纹，不弹窗；
   *   never/撤销 → 'revoked'，内容已改未确认 → 'changed'
   * 调用方必须 await 本门后才允许进入内核；不允许为绕过确认另建默认放行的入口。
   */
  private async confirmExecutionTrust(
    ws: string,
    wf: LoadedWorkflow,
    opts: { interactive: boolean }
  ): Promise<{ ok: boolean; reason?: 'declined' | 'revoked' | 'changed' }> {
    if (!opts.interactive) {
      const state = this.deps.trustState(ws, wf.name, wf.fingerprint);
      if (state === 'trusted') return { ok: true };
      return { ok: false, reason: state === 'changed' ? 'changed' : 'revoked' };
    }
    if (await this.deps.ensureTrusted(ws, wf, undefined, this.admission.signal)) return { ok: true };
    return { ok: false, reason: 'declined' };
  }

  /**
   * 读当前脚本字节并核对指纹（r2-W1 执行绑定）：一致返回字节（后续快照执行用），
   * 不一致（内容已变/读失败）返回 null。字节与指纹同源核对——拿到即绑定。
   */
  private readVerifiedScript(wf: LoadedWorkflow): string | null {
    try {
      const doc = fs.readFileSync(wf.docPath, 'utf8');
      const script = fs.readFileSync(wf.scriptPath, 'utf8');
      return workflowFingerprint(doc, script) === wf.fingerprint ? script : null;
    } catch {
      return null;
    }
  }

  /**
   * 确认与执行的内容绑定（r1-W1 / r2-W1）：确认是异步的——弹框等待期间 run.mjs 可能被改，
   * 用户确认的是旧指纹，若返回后直接 import 就执行了未经确认的新内容。确认返回后
   * 必须重读校验：指纹变了就对当前内容重新过门（changed 会再弹「已修改」确认，有界
   * 防抖动文件死循环）；最终返回「字节已核对」的版本——后续 launch/smoke 一律快照
   * 这份字节执行（kernel 写同目录快照后 import），磁盘后续变化不再影响实际执行内容。
   * 非交互路径无等待窗口：单次字节核对即返回。字节捕获（同步）到快照写入（同步）
   * 之间无 await——进程内无竞态；进程外并发写盘的残余窗口由快照机制消除（执行的字
   * 节始终是已确认字节本身，而非磁盘当前内容）。
   */
  private async confirmExecutionTrustBound(
    ws: string,
    wf: LoadedWorkflow,
    opts: { interactive: boolean; check?: () => void }
  ): Promise<{
    ok: boolean;
    wf: LoadedWorkflow;
    script?: string;
    reason?: 'declined' | 'revoked' | 'changed' | 'unstable';
    errors?: string[];
  }> {
    let current = wf;
    for (let attempt = 0; attempt < 5; attempt++) {
      opts.check?.();
      const gate = await this.confirmExecutionTrust(ws, current, opts);
      opts.check?.();
      if (!gate.ok) return { ok: false, wf: current, reason: gate.reason };
      const script = this.readVerifiedScript(current);
      if (script !== null) return { ok: true, wf: current, script };
      if (!opts.interactive) return { ok: false, wf: current, reason: 'changed' };
      const reloaded = loadWorkflow(this.root(ws), current.name);
      if (reloaded.errors.length) {
        return { ok: false, wf: current, reason: 'unstable', errors: reloaded.errors };
      }
      current = reloaded;
    }
    return { ok: false, wf: current, reason: 'unstable' };
  }

  validate(ws: string, name: string): Promise<Record<string, unknown>> { return this.accept(() => this.validateInner(ws, name)); }
  private async validateInner(ws: string, name: string): Promise<Record<string, unknown>> {
    const wf = loadWorkflow(this.root(ws), name);
    const errors = [...wf.errors];
    // 静态检查（解析说明/警告）不执行模块代码，始终安全；
    // 冒烟 import 会真实执行 run.mjs 模块顶层（worker 线程不是沙箱），
    // 必须先过当前内容指纹的信任门（未确认/拒绝/撤销均不 import），
    // 且确认返回后重读校验绑定执行版本（确认等待期间改文件不会执行新内容）。
    let exec: { performed: boolean; reason?: 'static-errors' | 'declined' } = { performed: false, reason: 'static-errors' };
    let verified = wf;
    if (!errors.length) {
      const trust = await this.confirmExecutionTrustBound(ws, wf, { interactive: true });
      if (!trust.ok) {
        exec = { performed: false, reason: 'declined' };
        errors.push(
          trust.reason === 'unstable'
            ? `已跳过执行型校验：工作流内容在确认期间变化${trust.errors?.length ? `（${trust.errors.join('；')}）` : '（反复修改）'}，请稳定后重试`
            : '已跳过执行型校验：当前内容未确认（信任被拒绝或已撤销），未 import run.mjs'
        );
      } else {
        verified = trust.wf;
        exec = { performed: true };
        // r2-W1：冒烟 import 同样绑定已确认字节（kernel 快照），不是可变的 run.mjs
        const validation: { owner?: WorkflowWorkerLease } = {};
        let importErr: string | null;
        try {
          importErr = await smokeImportWorkflow(verified.scriptPath, verified.fingerprint, 10_000, trust.script, this.admission.signal,
            owner => { validation.owner = owner; this.validationWorkers.add(owner); });
        } finally { if (validation.owner?.released) this.validationWorkers.delete(validation.owner); }
        if (importErr) errors.push(`run.mjs 冒烟 import 失败：${importErr}`);
      }
    }
    return {
      ok: errors.length === 0,
      name,
      fingerprint: verified.fingerprint,
      exec,
      ...(errors.length ? { errors } : {}),
      ...(verified.warnings.length ? { warnings: verified.warnings } : {}),
      ...(verified.def ? { args: verified.def.args, maxDelegates: verified.def.maxDelegates, maxHours: verified.def.maxHours } : {})
    };
  }

  get(ws: string, runId: string, logTail = 20): Record<string, unknown> {
    const live = this.live.get(runId);
    const rec = live && live.rec.workspaceId === ws ? live.rec : this.failedWrites.get(runId) ?? readRunRecord(this.root(ws), runId);
    if (!rec || rec.workspaceId !== ws) throw new WorkflowError(`找不到 run ${runId}`);
    return describeWorkflowRun(rec, this.now(), { logTail });
  }

  /** 启动（顶层由 workflow.start 调；子工作流由 wf.call 调）。信任确认在这里做 */
  startRun(ws: string, name: string, args: Record<string, unknown>, opts: WorkflowStartOptions = {}): Promise<WorkflowRunRecord> {
    if (this.admission.signal.aborted) return Promise.reject(new WorkflowError('工作流运行时已关闭'));
    const pending = this.startRunInner(ws, name, args, opts);
    this.starts.add(pending);
    void pending.then(() => this.starts.delete(pending), () => this.starts.delete(pending));
    return pending;
  }

  private async startRunInner(
    ws: string,
    name: string,
    args: Record<string, unknown>,
    opts: WorkflowStartOptions = {}
  ): Promise<WorkflowRunRecord> {
    const { parent } = opts;
    const trigger: WorkflowRunTrigger = opts.trigger ?? 'manual';
    const root = this.root(ws);
    let wf = loadWorkflow(root, name);
    if (wf.errors.length || !wf.def) throw new WorkflowError(`工作流 ${name} 不可用：${wf.errors.join('；')}`);
    const argErrors = validateWorkflowArgs(wf.def, args);
    if (argErrors.length) throw new WorkflowError(`${argErrors.join('；')}（参数说明见 ${name}/WORKFLOW.md 的 args）`);
    const depth = parent ? parent.rec.depth + 1 : 0;
    if (depth > WORKFLOW_LIMITS.maxDepth) throw new WorkflowError(`子工作流嵌套超过 ${WORKFLOW_LIMITS.maxDepth} 层`);
    const generation = this.generation;
    const check = (): void => {
      if (generation !== this.generation) throw new WorkflowError('应用已关闭，启动请求已失效');
      if (parent && (parent.stopped || this.live.get(parent.rec.runId) !== parent)) throw new WorkflowError('父 run 已结束');
    };
    check();
    if (!parent) {
      const active = [...this.live.values()].filter((l) => l.rec.workspaceId === ws && !l.rec.parentRunId).length
        + [...this.pendingStarts].filter(p => p.ws === ws).length;
      if (active >= WORKFLOW_LIMITS.maxActiveRuns) {
        throw new WorkflowError(`本工作区已有 ${active} 个工作流在运行（上限 ${WORKFLOW_LIMITS.maxActiveRuns}），先等结束或 workflow.cancel`);
      }
    }
    const reservation = { ws, name, trigger };
    if (!parent) this.pendingStarts.add(reservation);
    try {
      let script: string;
      if (trigger !== 'manual') {
        const trust = await this.confirmExecutionTrustBound(ws, wf, { interactive: false, check });
        if (!trust.ok) {
          throw new WorkflowError(
            trust.reason === 'changed'
              ? `工作流 ${name} 内容已修改、尚未确认，触发不运行`
              : `工作流 ${name} 当前内容未确认，触发不运行`
          );
        }
        wf = trust.wf;
        script = trust.script!;
      } else {
        const trust = await this.confirmExecutionTrustBound(ws, wf, { interactive: true, check });
        if (!trust.ok) {
          throw new WorkflowError(
            trust.reason === 'unstable'
              ? `工作流 ${name} 内容在确认期间变化${trust.errors?.length ? `（${trust.errors.join('；')}）` : '（反复修改）'}，未执行，请稳定后重试`
              : `用户未确认运行工作流 ${name}（脚本指纹 ${wf.fingerprint}）`
          );
        }
        wf = trust.wf;
        script = trust.script!;
      }
      // 信任门后（含确认等待期间重读）的版本必有 def：重读时定义错误已在门内拦截
      if (!wf.def) throw new WorkflowError(`工作流 ${name} 不可用`);
      // r2-P2：确认期间定义可能重载（新增/改变必填参数）——参数必须按最终采用的定义重验，
      // 否则空 args 绕过参数护栏执行副作用
      const finalArgErrors = validateWorkflowArgs(wf.def, args);
      if (finalArgErrors.length) {
        throw new WorkflowError(`${finalArgErrors.join('；')}（参数说明见 ${name}/WORKFLOW.md 的 args；内容在确认期间有变化，按最新定义校验）`);
      }
      check();
      const now = this.now();
      const rec: WorkflowRunRecord = {
        version: 1,
        runId: shortId('wf'),
        name,
        workspaceId: ws,
        ...(parent ? { parentRunId: parent.rec.runId } : {}),
        depth,
        status: 'running',
        args,
        state: {},
        fingerprint: wf.fingerprint,
        maxDelegates: wf.def.maxDelegates,
        maxHours: wf.def.maxHours,
        startedAt: now,
        updatedAt: now,
        log: [],
        memo: {},
        delegates: 0,
        humanWaitMs: 0,
        resumes: 0,
        ...(parent ? {} : { trigger })
      };
      const how = trigger === 'schedule' ? '定时触发' : trigger === 'event' ? '事件触发' : '启动';
      appendWorkflowLog(rec, now, parent ? `由 ${parent.rec.name}（${parent.rec.runId}）调起` : how);
      const live = this.launch(root, rec, wf, script);
      this.emit(live, 'started', `${how}${Object.keys(args).length ? `，参数 ${stableStringify(args).slice(0, 120)}` : ''}`);
      return live.rec;
    } finally {
      this.pendingStarts.delete(reservation);
    }
  }

  /**
   * 取消（连同子 run）；closeSessions 时一并关闭本 run 及子 run 派出的会话。
   * 取消期间的在途派活（排队/创建中）先试撤销（能出队的直接撤销）；撤销不了的
   * 登记为迟到补偿——closeSessions:true 时派活出口迟到返回后补关会话并记账，
   * false 保持「保留会话」语义（迟到结果仍记入 run 的 sessions/tasks，审计可见）。
   */
  async cancel(
    ws: string,
    runId: string,
    reason?: string,
    opts: { closeSessions?: boolean; initiatedBy?: 'human' | 'agent' } = {}
  ): Promise<Record<string, unknown>> {
    const live = this.live.get(runId);
    if (!live || live.rec.workspaceId !== ws) {
      const rec = readRunRecord(this.root(ws), runId);
      if (!rec) throw new WorkflowError(`找不到 run ${runId}`);
      const cleanup = await Promise.allSettled([
        ...[...this.commands].filter(owner => this.commandRuns.get(owner) === runId).map(owner => owner.close()),
        ...[...this.kernels].filter(owner => this.kernelRuns.get(owner) === runId).map(owner => owner.releaseWorker())
      ]);
      const cleanupErrors = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason));
      return { runId, status: rec.status, note: '该 run 已不在运行', ...(cleanupErrors.length ? { cleanupErrors } : {}) };
    }
    // 先收集：finishStopped 会把子 run 从 live 表移除，之后再扫不到它们的资源
    const sessions = new Set<string>(live.rec.sessions ?? []);
    const affected = [live, ...[...this.live.values()].filter(item => this.isDescendant(item, runId))];
    const resources = affected.flatMap(item => [...item.children].map(child => () => child.close()));
    for (const item of affected) if (item.kernel) resources.push(() => item.kernel!.releaseWorker());
    const inFlight: InFlightDelegate[] = [...live.inFlight];
    for (const l of this.live.values()) {
      if (this.isDescendant(l, runId)) {
        for (const s of l.rec.sessions ?? []) sessions.add(s);
        inFlight.push(...l.inFlight);
      }
    }
    this.finishStopped(live, 'cancelled', reason?.trim() ? `已取消：${reason.trim()}` : '已取消');
    // 收回在途派活：先试撤销未出队的（含 delegateTask 在途、撤销回调尚未登记的一—
    // 那些先记 cancelRequested，回调晚登记时立即消费）；撤不掉的按 closeSessions 登记迟到补偿
    const revokedDelegates: string[] = [];
    const lateDelegates: string[] = [];
    for (const entry of inFlight) {
      entry.cancelRequested = true;
      if (entry.cancel?.()) {
        entry.cancelled = true;
        revokedDelegates.push(entry.creationKey);
      } else {
        if (opts.closeSessions) {
          entry.lateCloseSessions = true;
          entry.lateCloseInitiatedBy = opts.initiatedBy;
        }
        lateDelegates.push(entry.creationKey);
      }
    }
    const released = await Promise.allSettled(resources.map(release => release()));
    const cleanupErrors = released.filter(result => result.status === 'rejected').map(result => String(result.reason));
    if (!opts.closeSessions) {
      return {
        runId,
        status: 'cancelled',
        ...(cleanupErrors.length ? { cleanupErrors } : {}),
        ...(revokedDelegates.length ? { revokedDelegates } : {}),
        ...(lateDelegates.length
          ? { note: `派出的 ${sessions.size} 个会话未关闭（取消时传 closeSessions 可一并关闭）；${lateDelegates.length} 个在途派活无法撤销、保留会话` }
          : sessions.size
            ? { note: `派出的 ${sessions.size} 个会话未关闭（取消时传 closeSessions 可一并关闭）` }
            : {}),
        ...(lateDelegates.length ? { lateDelegates } : {})
      };
    }
    const closed: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];
    for (const sessionId of sessions) {
      try {
        await this.deleteSession(ws, sessionId, opts.initiatedBy);
        closed.push(sessionId);
      } catch (err) {
        failed.push({ sessionId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      runId,
      status: 'cancelled',
      ...(cleanupErrors.length ? { cleanupErrors } : {}),
      closed,
      ...(failed.length ? { failed } : {}),
      ...(revokedDelegates.length ? { revokedDelegates } : {}),
      ...(lateDelegates.length
        ? {
            lateDelegates,
            note: `${lateDelegates.length} 个派活正在创建、无法撤销：创建完成后会自动补关其会话并记录在 run 日志`
          }
          : {})
    };
  }

  private isDescendant(l: LiveRun, ancestorId: string): boolean {
    let p = l.rec.parentRunId;
    for (let i = 0; p && i <= WORKFLOW_LIMITS.maxDepth; i++) {
      if (p === ancestorId) return true;
      p = this.live.get(p)?.rec.parentRunId;
    }
    return false;
  }

  /** workflow.reply：答复给调度的 wf.ask */
  reply(ws: string, runId: string, askId: string, answer: unknown): Record<string, unknown> {
    const live = this.requireLive(ws, runId);
    const pa = live.rec.pendingAsk;
    if (!pa || pa.askId !== askId) throw new WorkflowError(`run ${runId} 没有待答问题 ${askId}（可能已答复或脚本已续跑换了问题）`);
    if (pa.to === 'human') throw new WorkflowError('这是问用户的问题：用 workflow.askHuman 弹卡给用户，不要替用户答');
    this.resolveAsk(live, answer);
    return { runId, askId, ok: true };
  }

  /** workflow.askHuman 第一步：取待答的问人问题 */
  pendingHumanAsk(ws: string, runId: string): { name: string; ask: NonNullable<WorkflowRunRecord['pendingAsk']> } {
    const live = this.requireLive(ws, runId);
    const pa = live.rec.pendingAsk;
    if (!pa) throw new WorkflowError(`run ${runId} 当前没有待答问题`);
    if (pa.to !== 'human') throw new WorkflowError('这个问题是问你的：自己判断后用 workflow.reply 答复');
    return { name: live.rec.name, ask: pa };
  }

  /** workflow.askHuman 第二步：用户作答原样回写（调度不经手） */
  answerHuman(ws: string, runId: string, askId: string, answer: unknown): void {
    const live = this.requireLive(ws, runId);
    if (live.rec.pendingAsk?.askId !== askId) throw new WorkflowError('问题已变化（run 可能已续跑或被取消），请重新 workflow.get');
    this.resolveAsk(live, answer);
  }

  /** 事件泵旁听点（策略判定之前）：命中的 waitFor 立即返回 */
  onEvent(ws: string, view: PolicyEventView & { detail?: string }): void {
    for (const live of this.live.values()) {
      if (live.rec.workspaceId !== ws || !live.waiters.size) continue;
      for (const w of [...live.waiters]) {
        if (matchWaitEvent(w.match, view)) w.resolve({ ...view, ts: this.now() });
      }
    }
    this.checkEventTriggers(ws, view);
  }

  /**
   * 启动续跑：未结束的顶层 run 从头重跑；指纹变了标记中断；父已结束的子 run 标记中断；
   * 父活跃但 memo 未记账的子 run（wf.call 在 startRun 落盘与 memo 写盘间崩溃的窗口）同样
   * 标记中断自愈——父续跑会另起新子，旧 running 记录无人接手，不标就成永久幽灵。
   * 恢复是重新启动 worker 并重新 import 脚本——同 startRun 一样必须重查当前信任：
   * 撤销（never）或内容改过未确认（changed）时不续跑，标记 interrupted 并通知，
   * 由用户重新信任/手动启动；memo/待答问题/日志保留在记录里。
   */
  resumeAll(): void {
    if (this.admission.signal.aborted) return;
    const now = this.now();
    for (const ws of this.deps.workspaceIds()) {
      const root = this.deps.workspaceRoot(ws);
      if (!root) continue;
      const active = this.records(ws, root).filter((r) => isWorkflowRunActive(r.status) && !this.live.has(r.runId));
      const byId = new Map(active.map((r) => [r.runId, r]));
      for (const rec of active) {
        if (rec.parentRunId) {
          const parentRec = byId.get(rec.parentRunId);
          if (!parentRec) {
            this.markInterrupted(root, rec, '父工作流已结束', false);
          } else {
            // F-02 自愈：wf.call 在 startRun 落盘后、memo 写盘前崩溃——父活跃但 memo 无该子，
            // 父续跑会另起新子 run，这条 running 记录无人接手 → 标中断，避免永久「运行中」幽灵
            const claimed = Object.values(parentRec.memo).some(
              (m) => isObj(m) && (m as Record<string, unknown>)[CALL_MEMO_CHILD] === rec.runId
            );
            if (!claimed) {
              this.markInterrupted(root, rec, '父工作流续跑未接上该子任务（记账缺失），已标记中断', false);
            }
          }
          continue;
        }
        const wf = loadWorkflow(root, rec.name);
        if (wf.errors.length || !wf.def || wf.fingerprint !== rec.fingerprint) {
          this.markInterrupted(root, rec, '工作流定义在停机期间被修改或删除，未续跑（确认新版本后可重新 workflow.start）', true);
          continue;
        }
        const trust = this.deps.trustState(ws, rec.name, wf.fingerprint);
        if (trust !== 'trusted') {
          this.markInterrupted(
            root,
            rec,
            trust === 'changed'
              ? '信任的是旧版本、当前内容未确认，未续跑（面板重新信任后可 workflow.start 重跑）'
              : '信任已撤销，未续跑（面板重新信任后可 workflow.start 重跑）',
            true
          );
          continue;
        }
        // r2-W1：恢复执行同样绑定字节——指纹核对过后读出已确认字节，快照执行；
        // 字节与指纹不符（恢复窗口内又变了）按内容变化中断，不重开竞态窗口
        const resumeScript = this.readVerifiedScript(wf);
        if (resumeScript === null) {
          this.markInterrupted(root, rec, '工作流内容在恢复时再次变化，未续跑（确认新版本后可重新 workflow.start）', true);
          continue;
        }
        this.excludeDowntime(rec, now);
        rec.resumes += 1;
        appendWorkflowLog(rec, now, `应用重启，第 ${rec.resumes} 次续跑`);
        try { this.launch(root, rec, wf, resumeScript); }
        catch (err) { console.error('[workflow] 恢复失败', rec.runId, err); }
      }
      this.pruneRuns(ws, root);
    }
    this.checkTriggers();
  }

  // ------------------------------------------------------------------
  // 触发（frontmatter schedule / on）
  // ------------------------------------------------------------------

  /** 定时巡检：刷新各工作区声明了触发的工作流，到点的起 run（漏跑最多补一次） */
  checkTriggers(): void {
    const now = this.now();
    for (const [id, exp] of this.owned) if (exp <= now) this.owned.delete(id);
    for (const ws of this.deps.workspaceIds()) {
      const root = this.deps.workspaceRoot(ws);
      if (!root) continue;
      const defs = listWorkflows(root).filter((w) => w.def && (w.def.schedule || w.def.on));
      this.triggerDefs.set(ws, defs);
      for (const wf of defs) {
        const schedule = wf.def?.schedule;
        if (!schedule) continue;
        const st = this.triggerEntry(ws, wf.name);
        if (st.disabled) continue;
        const trust = this.deps.trustState(ws, wf.name, wf.fingerprint);
        if (trust !== 'trusted') {
          if (trust === 'changed') this.reportBlocked(ws, wf, 'schedule');
          continue;
        }
        if (st.anchorFingerprint !== wf.fingerprint) {
          st.anchorAt = now;
          st.anchorFingerprint = wf.fingerprint;
          this.saveTriggerState(ws);
          continue;
        }
        const due = this.nextDue(schedule, Math.max(st.lastFiredAt ?? 0, st.anchorAt ?? now));
        if (now < due) continue;
        st.lastFiredAt = now;
        this.fireTrigger(ws, wf, 'schedule', {});
      }
    }
  }

  private checkEventTriggers(ws: string, view: PolicyEventView): void {
    if (String(view.kind).toLowerCase() === 'workflow') return;
    let defs = this.triggerDefs.get(ws);
    if (!defs) {
      const root = this.deps.workspaceRoot(ws);
      if (!root) return;
      defs = listWorkflows(root).filter((w) => w.def && (w.def.schedule || w.def.on));
      this.triggerDefs.set(ws, defs);
    }
    const candidates = defs.filter((w) => w.def?.on && matchWaitEvent(w.def.on, view));
    if (!candidates.length || this.isOwnedEvent(view)) return;
    const now = this.now();
    for (const wf of candidates) {
      if (this.triggerStateOf(ws)[wf.name]?.disabled) continue;
      const trust = this.deps.trustState(ws, wf.name, wf.fingerprint);
      if (trust !== 'trusted') {
        if (trust === 'changed') this.reportBlocked(ws, wf, 'event');
        continue;
      }
      const st = this.triggerEntry(ws, wf.name);
      if (st.lastEventAt !== undefined && now - st.lastEventAt < (wf.def?.cooldownMin ?? WORKFLOW_LIMITS.defaultCooldownMin) * 60_000) {
        continue;
      }
      st.lastEventAt = now;
      this.fireTrigger(ws, wf, 'event', { event: view });
    }
  }

  /** 事件来自工作流自己派出的会话/任务 → 不触发（防连锁） */
  private isOwnedEvent(view: PolicyEventView): boolean {
    const ids = [view.sessionId].filter((x): x is string => typeof x === 'string' && !!x);
    if (!ids.length) return false;
    const now = this.now();
    if (ids.some((id) => (this.owned.get(id) ?? 0) > now)) return true;
    for (const l of this.live.values()) {
      if (ids.some((id) => l.rec.sessions?.includes(id) || l.rec.tasks?.includes(id))) return true;
    }
    return false;
  }

  private fireTrigger(ws: string, wf: LoadedWorkflow, kind: 'schedule' | 'event', args: Record<string, unknown>): void {
    const st = this.triggerEntry(ws, wf.name);
    const skip = (reason: string): void => {
      st.lastSkip = { at: this.now(), reason };
      this.saveTriggerState(ws);
    };
    const tops = [...this.live.values()].filter((l) => l.rec.workspaceId === ws && !l.rec.parentRunId);
    if (tops.some((l) => l.rec.name === wf.name && l.rec.trigger && l.rec.trigger !== 'manual')
      || [...this.pendingStarts].some(p => p.ws === ws && p.name === wf.name && p.trigger !== 'manual')) {
      skip('上一次触发起的 run 仍在运行');
      return;
    }
    if (tops.length >= WORKFLOW_LIMITS.maxActiveRuns) {
      skip(`工作区已有 ${tops.length} 个工作流在运行（上限 ${WORKFLOW_LIMITS.maxActiveRuns}）`);
      return;
    }
    this.saveTriggerState(ws);
    this.startRun(ws, wf.name, args, { trigger: kind }).catch((err: unknown) =>
      skip(err instanceof Error ? err.message : String(err))
    );
  }

  /** 信任过旧版本、当前内容未确认：跳过并唤醒调度（每个指纹只报一次） */
  private reportBlocked(ws: string, wf: LoadedWorkflow, kind: 'schedule' | 'event'): void {
    const st = this.triggerEntry(ws, wf.name);
    if (st.blockedFingerprint === wf.fingerprint) return;
    st.blockedFingerprint = wf.fingerprint;
    st.lastSkip = { at: this.now(), reason: '内容已修改、尚未确认' };
    this.saveTriggerState(ws);
    try {
      this.deps.emit(ws, {
        runId: `trigger-${wf.name}`,
        name: wf.name,
        trigger: 'trigger_blocked',
        detail: `工作流 ${wf.name} 的${kind === 'schedule' ? '定时' : '事件'}触发被跳过：内容已修改、尚未确认。请用户在工作流面板点「信任」，或手动运行一次确认`
      });
    } catch (err) {
      console.error('[workflow] trigger_blocked 事件发送失败（忽略）', err);
    }
  }

  private nextDue(schedule: TaskSchedule, fromMs: number): number {
    return this.deps.nextScheduleAt ? this.deps.nextScheduleAt(schedule, fromMs) : getNextRunAt(schedule, new Date(fromMs));
  }

  private triggerStateOf(ws: string): WorkflowTriggerState {
    let s = this.triggerStates.get(ws);
    if (!s) {
      const root = this.deps.workspaceRoot(ws);
      s = root ? readTriggerState(root) : {};
      this.triggerStates.set(ws, s);
    }
    return s;
  }

  private triggerEntry(ws: string, name: string): WorkflowTriggerEntry {
    const s = this.triggerStateOf(ws);
    return (s[name] ??= {});
  }

  private saveTriggerState(ws: string): void {
    const root = this.deps.workspaceRoot(ws);
    if (!root) return;
    try {
      writeTriggerState(root, this.triggerStateOf(ws));
    } catch (err) {
      console.error('[workflow] 触发状态落盘失败', err);
    }
    this.deps.onChange?.(ws);
  }

  private pruneRuns(ws: string, root: string): void {
    try {
      const ids = selectWorkflowRunsToPrune(listRunRecords(root), this.now());
      for (const id of ids) if (!this.live.has(id)) {
        deleteRunRecord(root, id);
        this.failedWrites.delete(id);
      }
      if (ids.length) this.deps.onChange?.(ws);
    } catch (err) {
      console.error('[workflow] 清理 run 记录失败（忽略）', err);
    }
  }

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  /** rec.fingerprint 必须与 wf.fingerprint 一致；script 为已核对字节的快照源（r2-W1 执行绑定） */
  private launch(root: string, rec: WorkflowRunRecord, wf: LoadedWorkflow, script: string): LiveRun {
    if (this.admission.signal.aborted) throw new WorkflowError('工作流运行时已关闭');
    let resolveSettled!: (r: WorkflowRunRecord) => void;
    const settled = new Promise<WorkflowRunRecord>((r) => {
      resolveSettled = r;
    });
    const live: LiveRun = {
      controller: new AbortController(),
      rec,
      root,
      kernel: null,
      memo: new WorkflowMemoCounter(),
      waiters: new Set(),
      children: new Set(),
      inFlight: new Set(),
      stopped: false,
      settled,
      resolveSettled
    };
    rec.status = rec.pendingAsk ? 'waiting' : 'running';
    this.live.set(rec.runId, live);
    if (!this.persist(live)) throw new WorkflowError(rec.error!);
    const kernel = new WorkflowKernel({
      runId: rec.runId,
      script: wf.scriptPath,
      scriptSource: script,
      fingerprint: wf.fingerprint,
      args: rec.args,
      state: rec.state,
      onCall: (call) => this.handleCall(live, call)
    });
    live.kernel = kernel;
    this.kernels.add(kernel);
    this.kernelRuns.set(kernel, rec.runId);
    void kernel.done.then(() => kernel.release()).then(() => this.kernels.delete(kernel), error => {
      console.error('[workflow] kernel release failed', error);
    });
    kernel.start();
    void kernel.done.then((o) => this.onKernelDone(live, o));
    return live;
  }

  private onKernelDone(live: LiveRun, o: KernelOutcome): void {
    if (live.stopped) return;
    const rec = live.rec;
    if (o.state) rec.state = o.state;
    if (o.ok) {
      rec.result = clipJson(o.result, WORKFLOW_LIMITS.resultMaxChars);
      this.settle(live, 'completed');
      if (!rec.parentRunId && !live.persistenceFailed) {
        this.emit(live, 'completed', `已完成${o.result == null ? '' : `：${stableStringify(o.result).slice(0, 160)}`}`);
      }
    } else {
      rec.error = o.error;
      this.settle(live, 'failed');
      if (!rec.parentRunId && !live.persistenceFailed) this.emit(live, 'failed', `失败：${o.error}`);
    }
  }

  private settle(live: LiveRun, status: WorkflowRunRecord['status']): void {
    const now = this.now();
    const rec = live.rec;
    live.stopped = true;
    live.controller.abort();
    for (const w of live.waiters) w.cancel();
    live.waiters.clear();
    // 统一收回自有子进程（取消/超限/内核意外退出；正常完成时集合为空）。
    // 只杀本次创建且身份仍有效的进程树（exitCode/signalCode 判活），不全局按名杀。
    for (const c of live.children) c.killTree(`run ${status}`);
    live.children.clear();
    live.ask?.cancel(); live.ask = undefined;
    if (rec.humanWaitSince !== undefined) {
      rec.humanWaitMs += Math.max(0, now - rec.humanWaitSince);
      delete rec.humanWaitSince;
    }
    delete rec.pendingAsk;
    delete rec.waiting;
    rec.status = status;
    rec.endedAt = now;
    rec.updatedAt = now;
    appendWorkflowLog(rec, now, rec.error ? `${status}：${rec.error}` : status);
    this.persist(live);
    this.live.delete(rec.runId);
    if (!rec.parentRunId) this.pruneRuns(rec.workspaceId, live.root);
    live.resolveSettled(rec);
  }

  /** 取消/超限：先收口子 run，再硬杀自己 */
  private finishStopped(live: LiveRun, status: 'cancelled' | 'failed', error: string): void {
    for (const child of [...this.live.values()]) {
      if (child.rec.parentRunId === live.rec.runId) this.finishStopped(child, status, `父工作流${status === 'cancelled' ? '已取消' : '失败'}`);
    }
    live.rec.error = error;
    const kernel = live.kernel;
    this.settle(live, status);
    kernel?.kill(error);
    if (status === 'failed' && !live.rec.parentRunId) this.emit(live, 'failed', `失败：${error}`);
  }

  private markInterrupted(root: string, rec: WorkflowRunRecord, why: string, notify: boolean): void {
    const now = this.now();
    rec.status = 'interrupted';
    rec.error = why;
    rec.endedAt = now;
    rec.updatedAt = now;
    delete rec.pendingAsk;
    delete rec.waiting;
    appendWorkflowLog(rec, now, `interrupted：${why}`);
    try { writeRunRecord(root, rec); }
    catch (err) {
      rec.status = 'failed';
      rec.error = `运行记录保存失败，未续跑：${err instanceof Error ? err.message : String(err)}`;
      this.failedWrites.set(rec.runId, rec);
      this.persistFailure(root, rec);
    }
    this.deps.onChange?.(rec.workspaceId);
    if (notify) {
      this.deps.emit(rec.workspaceId, {
        runId: rec.runId,
        name: rec.name,
        trigger: rec.status === 'failed' ? 'failed' : 'interrupted',
        detail: formatWorkflowEventDetail(rec.name, rec.runId, rec.error!)
      });
    }
  }

  /** 应用关闭期间与停机前已等人的时间都不计入存活时长（updatedAt 视为最后存活时刻） */
  private excludeDowntime(rec: WorkflowRunRecord, now: number): void {
    if (rec.humanWaitSince !== undefined) {
      rec.humanWaitMs += Math.max(0, rec.updatedAt - rec.humanWaitSince);
      rec.humanWaitSince = now;
    }
    rec.humanWaitMs += Math.max(0, now - rec.updatedAt);
  }

  private checkBudgets(): void {
    this.retryFailureRecords();
    const now = this.now();
    for (const live of [...this.live.values()]) {
      const err = workflowBudgetError(live.rec, now);
      if (err && !live.stopped) this.finishStopped(live, 'failed', err);
    }
  }

  private requireLive(ws: string, runId: string): LiveRun {
    const live = this.live.get(runId);
    if (!live || live.rec.workspaceId !== ws) throw new WorkflowError(`run ${runId} 不在运行（workflow.get 看状态）`);
    return live;
  }

  private records(ws: string, root: string): WorkflowRunRecord[] {
    const records = new Map(listRunRecords(root).map(r => [r.runId, r]));
    for (const l of this.live.values()) if (l.rec.workspaceId === ws) records.set(l.rec.runId, l.rec);
    for (const r of this.failedWrites.values()) if (r.workspaceId === ws) records.set(r.runId, r);
    return [...records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private persistFailure(root: string, rec: WorkflowRunRecord): void {
    try { writeRunFailure(root, rec); }
    catch (err) {
      console.error('[workflow] 故障记录也无法保存；磁盘恢复前不可保证重启状态', rec.runId, err);
      if (!rec.error?.includes('故障记录也无法保存')) {
        rec.error += '；故障记录也无法保存，请修复磁盘后再关闭应用，否则旧记录可能在重启时续跑';
      }
    }
  }

  private retryFailureRecords(): void {
    for (const rec of this.failedWrites.values()) {
      const root = this.deps.workspaceRoot(rec.workspaceId);
      if (root) this.persistFailure(root, rec);
    }
  }

  /** A failed checkpoint is terminal. Never execute the next side effect on an unrecorded state. */
  private persist(live: LiveRun): boolean {
    if (live.persistenceFailed) {
      this.persistFailure(live.root, live.rec);
      this.deps.onChange?.(live.rec.workspaceId);
      return false;
    }
    try {
      writeRunRecord(live.root, live.rec);
    } catch (err) {
      console.error('[workflow] run 记录落盘失败', live.rec.runId, err);
      live.persistenceFailed = true;
      this.failedWrites.set(live.rec.runId, live.rec);
      for (const entry of live.inFlight) {
        entry.cancelRequested = true;
        entry.lateCloseSessions = true;
        try { entry.cancelled = entry.cancel?.() === true; }
        catch (error) { console.error('[workflow] 故障后撤销派活失败', error); }
      }
      // The recursive terminal save uses the independent failure record above.
      this.finishStopped(live, 'failed', `运行记录保存失败，已停止：${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.deps.onChange?.(live.rec.workspaceId);
    return true;
  }

  private emit(live: LiveRun, trigger: WorkflowEventTrigger, text: string): void {
    try {
      this.deps.emit(live.rec.workspaceId, {
        runId: live.rec.runId,
        name: live.rec.name,
        trigger,
        detail: formatWorkflowEventDetail(live.rec.name, live.rec.runId, text)
      });
    } catch (err) {
      console.error('[workflow] 进度事件发送失败（忽略）', err);
    }
  }

  private touch(live: LiveRun): void {
    if (live.stopped) throw new WorkflowError(live.rec.error ?? 'run 已结束');
    const rec = live.rec;
    rec.status = live.waiters.size || rec.pendingAsk ? 'waiting' : 'running';
    if (!live.waiters.size && !rec.pendingAsk) delete rec.waiting;
    rec.updatedAt = this.now();
    if (!this.persist(live)) throw new WorkflowError(live.rec.error!);
  }

  // ------------------------------------------------------------------
  // wf.* 桥
  // ------------------------------------------------------------------

  private async handleCall(live: LiveRun, call: KernelCall): Promise<unknown> {
    if (live.stopped) throw new WorkflowError('run 已结束');
    if (call.state && stableStringify(call.state).length <= WORKFLOW_LIMITS.stateMaxChars) live.rec.state = call.state;
    const budget = workflowBudgetError(live.rec, this.now());
    if (budget) {
      this.finishStopped(live, 'failed', budget);
      throw new WorkflowError(budget);
    }
    const a = call.args;
    switch (call.method) {
      case 'delegate':
        return this.wfDelegate(live, a[0]);
      case 'waitFor':
        return this.wfWaitFor(live, a[0], a[1]);
      case 'ask':
        return this.wfAsk(live, a[0], a[1]);
      case 'run':
        return this.wfRun(live, a[0], a[1], a[2]);
      case 'tool':
        return this.wfTool(live, a[0], a[1]);
      case 'read':
        return this.wfRead(live, a[0]);
      case 'glob':
        return this.wfGlob(live, a[0]);
      case 'call':
        return this.wfCall(live, a[0], a[1]);
      case 'phase': {
        const name = String(a[0] ?? '').trim().slice(0, 80);
        if (name) {
          live.rec.phase = name;
          appendWorkflowLog(live.rec, this.now(), `阶段：${name}`);
          this.touch(live);
          this.emit(live, 'phase', `进入阶段「${name}」`);
        }
        return null;
      }
      case 'checkpoint':
        this.touch(live);
        return null;
      case 'log':
        appendWorkflowLog(live.rec, this.now(), String(a[0] ?? ''));
        this.touch(live);
        return null;
      default:
        throw new WorkflowError(`未知 wf 方法 ${call.method}`);
    }
  }

  private async wfDelegate(live: LiveRun, raw: unknown): Promise<unknown> {
    if (!isObj(raw) || typeof raw.task !== 'string' || !raw.task.trim()) {
      throw new WorkflowError('wf.delegate 需要 {task: "任务说明", isolate: true|false, runtime?, name?}');
    }
    if (typeof raw.isolate !== 'boolean') throw new WorkflowError('wf.delegate 必须显式选择 isolate: true 或 false，无 auto 或默认值。');
    const input: Record<string, unknown> = { task: raw.task };
    for (const k of ['runtime', 'name', 'isolate', 'model', 'thinking', 'guiMode'] as const) {
      if (raw[k] !== undefined) input[k] = raw[k];
    }
    const key = live.memo.next('delegate', { ...input, key: raw.key });
    const prior = live.rec.memo[key];
    const pending = isObj(prior) && prior[WORKFLOW_MEMO_PENDING] === true;
    if (key in live.rec.memo && !pending) return prior;
    const ws = live.rec.workspaceId;
    const creationKey = workflowDelegateTaskId(live.rec.runId, key);
    if (!pending) {
      const over = workflowBudgetError(live.rec, this.now(), { addingDelegate: true });
      if (over) {
        this.finishStopped(live, 'failed', over);
        throw new WorkflowError(over);
      }
      live.rec.delegates += 1;
    }
    live.rec.memo[key] = { [WORKFLOW_MEMO_PENDING]: true, taskId: creationKey };
    live.rec.waiting = '派活拉起中';
    this.touch(live);
    // 登记 in-flight 归属：取消时先试撤销排队项；撤不掉的迟到返回/迟到失败后按选项补偿并记账
    const entry: InFlightDelegate = { key, creationKey };
    live.inFlight.add(entry);
    let result: WorkflowDelegateResult;
    try {
      // delegate owns creation-key reuse and must finish durable initial mail before success.
      result = await this.deps.delegate(ws, { ...input, creationKey }, {
        registerCancel: (fn) => {
          entry.cancel = fn;
          // 交接窗口（r1-W3）：cancel 可能发生在 delegateTask 在途、回调登记之前——
          // 登记时消费已请求的取消，能撤销的立即撤销（promise 将以取消错误 reject）
          if (entry.cancelRequested && !entry.cancelled && fn()) entry.cancelled = true;
        }
      });
    } catch (err) {
      live.inFlight.delete(entry);
      const lateSessionId = (err as { sessionId?: unknown } | null)?.sessionId;
      const failedWithSession = typeof lateSessionId === 'string' && lateSessionId ? lateSessionId : undefined;
      if (!live.stopped) {
        // run 还在：占位回退、计数回退，脚本侧报错；但出口已建出且保留的会话记入
        // sessions 归属（审计可见，r2-W1——不再丢资源标识）
        if (failedWithSession) {
          live.rec.sessions = pushUnique(live.rec.sessions, failedWithSession);
          appendWorkflowLog(live.rec, this.now(), `派活失败但会话已建出（保留）：${failedWithSession}`);
        }
        delete live.rec.memo[key];
        if (!pending) live.rec.delegates -= 1;
      } else if (entry.cancelled) {
        // run 已取消且排队项已撤销：没有创建任何资源，清占位与计数保持记录一致
        delete live.rec.memo[key];
        if (!pending) live.rec.delegates = Math.max(0, live.rec.delegates - 1);
        appendWorkflowLog(live.rec, this.now(), `取消时撤销排队派活 ${creationKey}`);
        this.persistRecord(live);
      } else {
        // 迟到失败（run 已结束）：出口可能已建出资源再抛错（生产形态：GUI 会话建出后
        // send 失败 throw 保留会话）——带 sessionId 的结构化失败按迟到结果补偿记账
        // （closeSessions:true 补关，false 保留但记入 sessions）；无资源失败也清占位，
        // 不留孤儿与永 pending 的 memo（r1-W3）。结构化标识经 queue/bridge 贯穿不丢（r2-W1）
        if (failedWithSession) {
          void this.settleLateDelegate(live, entry, { sessionId: failedWithSession }, '失败');
        } else {
          delete live.rec.memo[key];
          if (!pending) live.rec.delegates = Math.max(0, live.rec.delegates - 1);
          appendWorkflowLog(
            live.rec,
            this.now(),
            `派活迟到失败（run 已${live.rec.status}，未建出资源）：${err instanceof Error ? err.message : String(err)}`
          );
          this.persistRecord(live);
        }
      }
      throw err;
    } finally {
      if (!live.stopped) {
        delete live.rec.waiting;
        this.touch(live);
      }
    }
    live.inFlight.delete(entry);
    if (live.stopped) {
      // 迟到返回：资源已创建，不能丢弃——记账并按取消选项补关会话
      void this.settleLateDelegate(live, entry, result);
      throw new WorkflowError('run 已结束');
    }
    this.recordDelegate(live, key, result, '');
    return result;
  }

  private recordDelegate(live: LiveRun, key: string, result: WorkflowDelegateResult, note: string): void {
    const rec = live.rec;
    rec.memo[key] = result;
    rec.sessions = pushUnique(rec.sessions, result.sessionId);
    rec.tasks = pushUnique(rec.tasks, result.taskId);
    const exp = this.now() + WORKFLOW_LIMITS.ownedTtlMs;
    if (result.sessionId) this.owned.set(result.sessionId, exp);
    if (result.taskId) this.owned.set(result.taskId, exp);
    appendWorkflowLog(rec, this.now(), `派活 → ${result.sessionName ?? result.sessionId ?? '?'}${result.taskId ? `（任务 ${result.taskId}）` : ''}${note}`);
    this.touch(live);
  }

  /** Cancellation follows the same archive precondition as interactive session deletion. */
  private async deleteSession(workspaceId: string, sessionId: string, initiatedBy: 'human' | 'agent' = 'agent'): Promise<void> {
    if (initiatedBy === 'human') {
      if (!this.deps.deleteSessionAsHuman) throw new Error('人工会话删除入口不可用');
      return this.deps.deleteSessionAsHuman(workspaceId, sessionId);
    }
    const archive = await this.deps.executeTool(workspaceId, 'sessions.setArchived', { sessionIds: [sessionId], archived: true });
    const archived = archive.result as { updated?: string[]; failed?: Array<{ id: string; error?: string }> } | undefined;
    if (!archive.ok || !archived?.updated?.includes(sessionId)) {
      throw new Error(archive.error ?? archived?.failed?.find(item => item.id === sessionId)?.error ?? '会话归档未确认，未删除');
    }
    const response = await this.deps.executeTool(workspaceId, 'sessions.delete', { sessionIds: [sessionId] });
    const result = response.result as { closed?: Array<{ id: string }>; failed?: Array<{ id: string; error?: string }> } | undefined;
    if (!response.ok || !result?.closed?.some(item => item.id === sessionId)) {
      throw new Error(response.error ?? result?.failed?.find(item => item.id === sessionId)?.error ?? '会话删除未确认');
    }
  }

  /** Settle late resources once, retaining failures without changing the run's terminal state. */
  private async settleLateDelegate(
    live: LiveRun,
    entry: InFlightDelegate,
    result: WorkflowDelegateResult,
    failed?: '失败'
  ): Promise<void> {
    if (entry.settled) return;
    entry.settled = true;
    live.inFlight.delete(entry);
    const rec = live.rec;
    rec.memo[entry.key] = result;
    rec.sessions = pushUnique(rec.sessions, result.sessionId);
    rec.tasks = pushUnique(rec.tasks, result.taskId);
    const exp = this.now() + WORKFLOW_LIMITS.ownedTtlMs;
    if (result.sessionId) this.owned.set(result.sessionId, exp);
    if (result.taskId) this.owned.set(result.taskId, exp);
    appendWorkflowLog(
      rec,
      this.now(),
      `派活迟到${failed ? '失败（会话已建出）' : '返回'} → ${result.sessionName ?? result.sessionId ?? result.taskId ?? '?'}（run 已${rec.status}）`
    );
    if (entry.lateCloseSessions && result.sessionId) {
      try {
        await this.deleteSession(rec.workspaceId, result.sessionId, entry.lateCloseInitiatedBy);
        appendWorkflowLog(
          rec,
          this.now(),
          `已补偿关闭迟到会话 ${result.sessionId}`
        );
      } catch (err) {
        appendWorkflowLog(rec, this.now(), `迟到会话 ${result.sessionId} 关闭失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    rec.updatedAt = this.now();
    this.persistRecord(live);
  }

  /** 迟到回调落记录：不改状态/等待字段（终态不被迟到结果覆写），只更新时间并写盘 */
  private persistRecord(live: LiveRun): void {
    this.persist(live);
  }

  private wfWaitFor(live: LiveRun, rawMatch: unknown, rawOpts: unknown): Promise<unknown> {
    const { match, errors } = parseWaitMatch(rawMatch);
    if (!match) throw new WorkflowError(`wf.waitFor 条件不合法：${errors.join('；')}`);
    const opts = isObj(rawOpts) ? rawOpts : {};
    const timeoutMs =
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? Math.min(opts.timeoutMs, WORKFLOW_LIMITS.waitMaxTimeoutMs)
        : undefined;
    const key = live.memo.next('waitFor', { match, timeoutMs });
    if (key in live.rec.memo) return Promise.resolve(live.rec.memo[key]);
    const ws = live.rec.workspaceId;
    const sessionId = waitMatchSessionId(match);
    if (sessionId && this.deps.sessionPhase) {
      const phase = this.deps.sessionPhase(ws, sessionId);
      if (phase && phaseSnapshotSatisfies(match, { id: sessionId, phase })) {
        const hit = { kind: 'phase', sessionId, trigger: phase, snapshot: true };
        live.rec.memo[key] = hit;
        this.touch(live);
        return Promise.resolve(hit);
      }
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        match,
        cancel: () => { live.waiters.delete(waiter); if (waiter.timer) clearTimeout(waiter.timer); reject(new WorkflowError('工作流已停止')); },
        resolve: (v) => {
          if (!live.waiters.delete(waiter)) return;
          if (waiter.timer) clearTimeout(waiter.timer);
          if (live.stopped) return;
          live.rec.memo[key] = v;
          try { this.touch(live); resolve(v); }
          catch (err) { reject(err); }
        }
      };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => waiter.resolve({ timedOut: true }), timeoutMs);
        (waiter.timer as NodeJS.Timeout).unref?.();
      }
      live.waiters.add(waiter);
      live.rec.waiting = `等事件 ${describeWaitMatch(match)}${timeoutMs ? `（最长 ${Math.round(timeoutMs / 60_000)} 分钟）` : ''}`;
      this.touch(live);
    });
  }

  private wfAsk(live: LiveRun, rawQuestion: unknown, rawOpts: unknown): Promise<unknown> {
    const question = typeof rawQuestion === 'string' ? rawQuestion.trim().slice(0, WORKFLOW_LIMITS.questionMax) : '';
    if (!question) throw new WorkflowError('wf.ask 需要问题文本');
    const opts = isObj(rawOpts) ? rawOpts : {};
    const to = opts.to === 'human' ? 'human' : 'scheduler';
    const options = Array.isArray(opts.options)
      ? opts.options.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, WORKFLOW_LIMITS.optionsMax)
      : undefined;
    const multi = opts.multi === true;
    const key = live.memo.next('ask', { question, to, options, multi });
    if (key in live.rec.memo) return Promise.resolve(live.rec.memo[key]);
    if (live.ask) throw new WorkflowError('同时只能有一个待答问题：等上一个 wf.ask 答复后再问');
    const now = this.now();
    const prev = live.rec.pendingAsk;
    const askId = prev && prev.key === key ? prev.askId : shortId('ask');
    live.rec.pendingAsk = {
      askId,
      key,
      to,
      question,
      ...(options?.length ? { options } : {}),
      ...(multi ? { multi: true } : {}),
      since: prev && prev.key === key ? prev.since : now
    };
    if (to === 'human' && live.rec.humanWaitSince === undefined) live.rec.humanWaitSince = now;
    live.rec.waiting = to === 'human' ? '等用户答复' : '等调度答复';
    return new Promise((resolve, reject) => {
      live.ask = { askId, resolve, cancel: () => reject(new WorkflowError('工作流已停止')) };
      this.touch(live);
      const optBit = options?.length ? `（选项：${options.join(' / ')}${multi ? '，可多选' : ''}）` : '';
      if (to === 'human') {
        this.emit(
          live,
          'ask_human',
          `在等用户答复：${question}${optBit}（已亮在工作流面板并桌面通知；用户在对话里提起时可用 workflow.askHuman {runId:"${live.rec.runId}"} 代为弹卡，不要替用户答）`
        );
        try {
          this.deps.notifyHuman?.(live.rec.workspaceId, { runId: live.rec.runId, name: live.rec.name, question });
        } catch (err) {
          console.error('[workflow] 问人通知失败（忽略）', err);
        }
      } else {
        this.emit(
          live,
          'ask',
          `问你：${question}${optBit}。判断后用 workflow.reply {runId:"${live.rec.runId}", askId:"${askId}", answer} 答复`
        );
      }
    });
  }

  private resolveAsk(live: LiveRun, rawAnswer: unknown): void {
    const pa = live.rec.pendingAsk;
    const pending = live.ask;
    if (!pa || !pending) throw new WorkflowError('没有待答问题');
    const answer =
      typeof rawAnswer === 'string'
        ? rawAnswer.slice(0, WORKFLOW_LIMITS.answerMax)
        : clipJson(rawAnswer ?? null, WORKFLOW_LIMITS.answerMax);
    const now = this.now();
    live.rec.memo[pa.key] = answer;
    if (live.rec.humanWaitSince !== undefined) {
      live.rec.humanWaitMs += Math.max(0, now - live.rec.humanWaitSince);
      delete live.rec.humanWaitSince;
    }
    appendWorkflowLog(live.rec, now, `${pa.to === 'human' ? '用户' : '调度'}答复：${typeof answer === 'string' ? answer : stableStringify(answer)}`);
    delete live.rec.pendingAsk;
    live.ask = undefined;
    this.touch(live);
    pending.resolve(answer);
  }

  private async wfRun(live: LiveRun, rawCmd: unknown, rawArgs: unknown, rawOpts: unknown): Promise<unknown> {
    const cmd = typeof rawCmd === 'string' ? rawCmd.trim() : '';
    if (!cmd) throw new WorkflowError('wf.run 需要命令');
    // wf.run(cmd, {key}) 省略 args 的写法：第二参是选项对象
    const optsIn = isObj(rawArgs) && rawOpts === undefined ? rawArgs : rawOpts;
    const args = Array.isArray(rawArgs) ? rawArgs.map((x) => String(x)) : [];
    const opts = isObj(optsIn) ? optsIn : {};
    const memoKey =
      typeof opts.key === 'string' && opts.key.trim() ? live.memo.next('run', { key: opts.key.trim(), cmd, args }) : undefined;
    if (memoKey && memoKey in live.rec.memo) return live.rec.memo[memoKey];
    const result = await this.spawnCommand(live, cmd, args, opts);
    if (memoKey && !live.stopped) {
      live.rec.memo[memoKey] = result;
      this.touch(live);
    }
    return result;
  }

  /** External commands enter an authenticated Job/group before user code can start. */
  private async spawnCommand(live: LiveRun, cmd: string, args: string[], opts: Record<string, unknown>): Promise<unknown> {
    appendWorkflowLog(live.rec, this.now(), workflowRunCommandLog(cmd, args));
    this.persist(live);
    const cwd = typeof opts.cwd === 'string' && opts.cwd.trim() ? this.resolveInside(live, opts.cwd) : live.root;
    const timeoutMs = Math.min(
      typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : WORKFLOW_LIMITS.runDefaultTimeoutMs,
      WORKFLOW_LIMITS.runMaxTimeoutMs
    );
    let stdout = '', stderr = '', timedOut = false, killedByStop = false;
    const cap = (buffer: string, chunk: Buffer): string => (buffer + chunk.toString('utf8')).slice(-WORKFLOW_LIMITS.runOutputMax);
    const win = process.platform === 'win32';
    const shell = args.length === 0 || win;
    const command = win && args.length ? [cmd, ...args].map(quoteWinArg).join(' ') : cmd;
    const ownerPending = startOwnedCommand({ command, args: shell ? [] : args, cwd, shell,
      assertCurrent: () => { if (live.stopped || timedOut || killedByStop || this.admission.signal.aborted) throw new WorkflowError('工作流已停止'); },
      stdout: chunk => { stdout = cap(stdout, chunk); }, stderr: chunk => { stderr = cap(stderr, chunk); }
    });
    const owned: OwnedChild = {
      close: async () => {
        let owner;
        try { owner = await ownerPending; }
        catch (error) {
          if (error instanceof BackgroundPtyStartupCleanupError) await error.close();
          // Other startup errors are returned only after successful cleanup.
          this.commands.delete(owned); return;
        }
        await owner.close();
        this.commands.delete(owned);
      },
      killTree: reason => {
        killedByStop = true;
        appendWorkflowLog(live.rec, this.now(), `停止本 run 的外部命令（${reason}）`);
        void owned.close().catch(error => console.error('[workflow] command close failed', error));
      }
    };
    this.commands.add(owned); live.children.add(owned);
    this.commandRuns.set(owned, live.rec.runId);
    const timer = setTimeout(() => {
      timedOut = true;
      void owned.close().catch(error => console.error('[workflow] timed command close failed', error));
    }, timeoutMs);
    timer.unref?.();
    try {
      const owner = await ownerPending;
      try {
        const code = await owner.completed;
        this.commands.delete(owned);
        return { code, stdout, stderr, ...(timedOut ? { timedOut: true } : {}), ...(killedByStop ? { killedByRunStop: true } : {}) };
      } catch (error) {
        // Cancellation can reject completion, but still requires the actual container close.
        await owner.close(); this.commands.delete(owned);
        if (error instanceof BackgroundPtyCleanupError) return { code: error.commandExitCode, stdout, stderr };
        if (timedOut || killedByStop) return { code: -1, stdout, stderr, ...(timedOut ? { timedOut: true } : {}), ...(killedByStop ? { killedByRunStop: true } : {}) };
        throw error;
      }
    } catch (error) {
      // Startup rejection already includes its attempted resource cleanup. Keep
      // the owner record on failure so shutdown retries, rather than forgetting it.
      if (!(error instanceof BackgroundPtyStartupCleanupError)) {
        // A startup failure with successful cleanup owns no process to retry.
        try { await ownerPending; } catch {
          this.commands.delete(owned);
          return { code: -1, stdout, stderr: `${stderr}${error instanceof Error ? error.message : String(error)}`, ...(timedOut ? { timedOut: true } : {}), ...(killedByStop ? { killedByRunStop: true } : {}) };
        }
      }
      throw new WorkflowError(`外部命令或资源回收失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { clearTimeout(timer); live.children.delete(owned); }
  }

  private async wfTool(live: LiveRun, rawName: unknown, rawArgs: unknown): Promise<unknown> {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new WorkflowError('wf.tool 的 name 必须是非空字符串');
    if (WORKFLOW_TOOL_DENYLIST.includes(name)) {
      throw new WorkflowError(`wf.tool 不允许调用 ${name}（工作流不能通过此入口启动另一个工作流）`);
    }
    const r = await this.deps.executeTool(live.rec.workspaceId, name, isObj(rawArgs) ? rawArgs : {}, live.controller.signal);
    if (!r.ok) throw new WorkflowError(r.error || `${name} 调用失败`);
    return r.result ?? null;
  }

  private resolveInside(live: LiveRun, rel: string): string {
    const abs = path.resolve(live.root, rel);
    const relNorm = path.relative(live.root, abs).replace(/\\/g, '/');
    if (relNorm.startsWith('..') || path.isAbsolute(relNorm)) throw new WorkflowError(`路径越出工作区：${rel}`);
    const lower = `${relNorm.toLowerCase()}${fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? '/' : ''}`;
    if (DENIED_READ_PREFIXES.some((p) => lower === p || lower.startsWith(p))) throw new WorkflowError(`不允许访问 ${relNorm}`);
    return abs;
  }

  private wfRead(live: LiveRun, rawPath: unknown): string | null {
    const rel = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (!rel) throw new WorkflowError('wf.read 需要相对路径');
    const abs = this.resolveInside(live, rel);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) throw new WorkflowError(`${rel} 不是文件`);
    const max = WORKFLOW_LIMITS.readMaxBytes;
    if (st.size <= max) return fs.readFileSync(abs, 'utf8');
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(max);
      fs.readSync(fd, buf, 0, max, 0);
      return `${buf.toString('utf8')}\n…（已截断，文件共 ${st.size} 字节）`;
    } finally {
      fs.closeSync(fd);
    }
  }

  private wfGlob(live: LiveRun, rawPattern: unknown): string[] {
    const pattern = typeof rawPattern === 'string' ? rawPattern.trim() : '';
    if (!pattern) throw new WorkflowError('wf.glob 需要模式（如 docs/research/*.md）');
    const re = globToRegExp(pattern);
    const out: string[] = [];
    const walk = (dir: string, rel: string): void => {
      if (out.length >= WORKFLOW_LIMITS.globMaxResults) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (GLOB_SKIP_DIRS.has(e.name) || r.toLowerCase() === '.muster/local') continue;
          walk(path.join(dir, e.name), r);
        } else if (re.test(r)) {
          out.push(r);
          if (out.length >= WORKFLOW_LIMITS.globMaxResults) return;
        }
      }
    };
    walk(live.root, '');
    return out.sort();
  }

  private async wfCall(live: LiveRun, rawName: unknown, rawArgs: unknown): Promise<unknown> {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new WorkflowError('wf.call 需要子工作流名');
    const args = isObj(rawArgs) ? rawArgs : {};
    const key = live.memo.next('call', { name, args });
    const memo = live.rec.memo[key];
    if (isObj(memo) && memo[CALL_MEMO_DONE] === true) return memo.result ?? null;
    let childSettled: Promise<WorkflowRunRecord> | undefined;
    if (isObj(memo) && typeof memo[CALL_MEMO_CHILD] === 'string') {
      childSettled = this.resumeChild(live, memo[CALL_MEMO_CHILD] as string);
    }
    if (!childSettled) {
      const child = await this.startRun(live.rec.workspaceId, name, args, { parent: live });
      live.rec.memo[key] = { [CALL_MEMO_CHILD]: child.runId };
      this.touch(live);
      childSettled = this.live.get(child.runId)?.settled ?? Promise.resolve(child);
    }
    live.rec.waiting = `等子工作流 ${name}`;
    this.touch(live);
    const done = await childSettled;
    if (live.stopped) throw new WorkflowError('run 已结束');
    if (done.status !== 'completed') {
      throw new WorkflowError(`子工作流 ${name}（${done.runId}）${done.status}${done.error ? `：${done.error}` : ''}`);
    }
    live.rec.memo[key] = { [CALL_MEMO_DONE]: true, result: done.result ?? null };
    delete live.rec.waiting;
    this.touch(live);
    return done.result ?? null;
  }

  /**
   * 续跑父 run 时接上停机前的子 run：仍活着直接等；记录未结束则同指纹重跑（重跑前
   * 同样重查当前信任，撤销/改过未确认则标记中断）；已结束直接用结局
   */
  private resumeChild(parent: LiveRun, runId: string): Promise<WorkflowRunRecord> | undefined {
    const liveChild = this.live.get(runId);
    if (liveChild) return liveChild.settled;
    const rec = readRunRecord(parent.root, runId);
    if (!rec) return undefined;
    if (!isWorkflowRunActive(rec.status)) return Promise.resolve(rec);
    const wf = loadWorkflow(parent.root, rec.name);
    if (wf.errors.length || wf.fingerprint !== rec.fingerprint) {
      this.markInterrupted(parent.root, rec, '子工作流定义在停机期间被修改，未续跑', false);
      return Promise.resolve(rec);
    }
    const trust = this.deps.trustState(rec.workspaceId, rec.name, wf.fingerprint);
    if (trust !== 'trusted') {
      this.markInterrupted(
        parent.root,
        rec,
        trust === 'changed' ? '子工作流信任的是旧版本、当前内容未确认，未续跑' : '子工作流信任已撤销，未续跑',
        false
      );
      return Promise.resolve(rec);
    }
    const childScript = this.readVerifiedScript(wf);
    if (childScript === null) {
      this.markInterrupted(parent.root, rec, '子工作流内容在恢复时再次变化，未续跑', false);
      return Promise.resolve(rec);
    }
    const now = this.now();
    this.excludeDowntime(rec, now);
    rec.resumes += 1;
    appendWorkflowLog(rec, now, `随父工作流续跑（第 ${rec.resumes} 次）`);
    return this.launch(parent.root, rec, wf, childScript).settled;
  }
}
