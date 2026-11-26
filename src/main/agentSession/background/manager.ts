import { userDataStorage } from '../../runtimeKernel/storageRootResolver';
/**
 * BackgroundTaskManager：GUI 会话的后台任务注册表（子代理 / 后台终端 / 定时器）。
 * 主进程唯一 writer；完成通知路由——
 * - wake 类（subagent/timer/带 wake 的 shell）：busy 由 host.send 自动 steer、idle 自动开新回合；
 * - 静默 shell：置 pendingDigest，父会话下一回合由 host.startTurn 经 takeDigest 注入引擎前缀
 *   （forkTranscript 同款「只进引擎、不进 UI」）。
 * 任务注册表落盘 userData/bg-tasks.json（debounce，借鉴 rpiv-todo「真源是文件」）：
 * 重启后 replay 重建——中断的 running 任务标 error「应用重启，任务中断」并置 pendingDigest，
 * 父会话下一回合即知；消息流与 timer 不跨重启（既有边界）。
 * 子代理预算硬顶（budget）：onUsage 回传累计轮次/token，breach 即停并写明原因
 * （借鉴 pi-subagents invocation-config 的双层预算，这里做单任务级）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { semanticOperationsFor } from '../../runtimeKernel/semanticOperations';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../../atomicJson';
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import type {
  BgTaskListResult,
  BgTaskPush,
  BgTaskRecord,
  BgTaskStatus
} from '../../../shared/backgroundTasks';
import {
  BG_TASKS_MAX_PER_SESSION,
  buildBgTaskDigest,
  claimNotification,
  resolveShellWakePolicy,
  shouldInjectBgWake,
  truncateBgText,
  type BgKillInitiator,
  type BgShellRunResult,
  type BgWakeOn
} from '../../../shared/backgroundTasks';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import { startBgShell, type BgShellHandle } from './shellTask';
import { bgTaskLaunchGuard, captureBgTaskSource, type BgTaskSource } from './source';

interface TaskRuntime {
  shell?: BgShellHandle;
  timer?: NodeJS.Timeout;
}

interface PersistedBgTasks {
  version: 1;
  savedAt: number;
  tasks: BgTaskRecord[];
}

/** 落盘保留策略：已完成任务最久留 7 天、总数上限 300（超出丢最旧） */
const PERSIST_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_KEEP_MAX = 300;
const KNOWN_KINDS: readonly BgTaskRecord['kind'][] = ['subagent', 'shell', 'timer'];
const KNOWN_STATUS: readonly BgTaskStatus[] = ['running', 'done', 'error', 'cancelled'];

export interface PreparedBgDigest {
  sessionId: string;
  text: string;
  entries: Array<{ id: string; fingerprint: string }>;
  operationId: string;
}
function digestFingerprint(task: BgTaskRecord): string {
  return createHash('sha256').update(JSON.stringify({ id: task.id, status: task.status, summary: task.summary,
    detail: task.detail, label: task.label, endedAt: task.endedAt, exitCode: task.exitCode, outputPath: task.outputPath })).digest('hex');
}

export interface BgSpawnResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export class BackgroundTaskManager {
  private stopped = false;
  private wakeStop = new AbortController();
  private pendingWakeTasks = new Set<string>();
  private shutdownPromise?: Promise<void>;
  private cleanupErrors = new Map<string, { error: unknown; priorSummary?: string; renderedSummary: string }>();
  private pendingLaunches = new Set<string>();
  private taskOperations = new Map<string, Set<Promise<unknown>>>();
  private shellClosures = new Map<string, Promise<void>>();
  private operations = new Set<Promise<unknown>>();
  private track<T>(operation: Promise<T>, taskId?: string): Promise<T> {
    this.operations.add(operation);
    const tasks = taskId ? this.taskOperations.get(taskId) ?? new Set<Promise<unknown>>() : undefined;
    if (taskId && tasks) { tasks.add(operation); this.taskOperations.set(taskId, tasks); }
    void operation.finally(() => {
      this.operations.delete(operation);
      tasks?.delete(operation);
      if (taskId && tasks?.size === 0) this.taskOperations.delete(taskId);
    }).catch(() => {});
    return operation;
  }
  private trackLaunch<T>(operation: Promise<T>, taskId: string): Promise<T> {
    this.pendingLaunches.add(taskId);
    return this.track(operation.finally(() => this.pendingLaunches.delete(taskId)), taskId);
  }

  private recordCleanupError(taskId: string, error: unknown, summary?: string): void {
    const task = this.tasks.get(taskId);
    const existing = this.cleanupErrors.get(taskId);
    const priorSummary = summary ?? (existing ? existing.priorSummary : task?.summary);
    const renderedSummary = [priorSummary, t('进程清理失败：{{error}}', { error: String(error) })].filter(Boolean).join('\n');
    this.cleanupErrors.set(taskId, { error, priorSummary, renderedSummary });
    if (task) { task.summary = renderedSummary; task.unread = true; this.scheduleSnapshot(task.parentSessionId); this.persistSoon(); }
    console.error('[bgTasks] process cleanup failed', error);
  }

  private clearCleanupError(taskId: string): void {
    const failure = this.cleanupErrors.get(taskId), task = this.tasks.get(taskId);
    this.cleanupErrors.delete(taskId);
    if (failure && task) {
      if (task.summary === failure.renderedSummary) task.summary = failure.priorSummary;
      this.scheduleSnapshot(task.parentSessionId); this.persistSoon();
    }
  }

  private releaseShell(taskId: string): Promise<void> {
    const active = this.shellClosures.get(taskId);
    if (active) return active;
    const runtime = this.runtimes.get(taskId);
    if (!runtime?.shell) return Promise.resolve();
    const closing = Promise.resolve().then(() => runtime.shell!.close ? runtime.shell!.close() : runtime.shell!.kill()).then(() => {
      if (this.runtimes.get(taskId) === runtime) this.runtimes.delete(taskId);
      this.clearCleanupError(taskId);
    }, error => { this.recordCleanupError(taskId, error); throw error; });
    this.shellClosures.set(taskId, closing);
    void closing.finally(() => { if (this.shellClosures.get(taskId) === closing) this.shellClosures.delete(taskId); }).catch(() => {});
    return closing;
  }

  private async acceptShell(taskId: string, handle: BgShellHandle): Promise<void> {
    this.runtimes.set(taskId, { shell: handle });
    if (this.tasks.get(taskId)?.status !== 'running') await this.releaseShell(taskId).catch(() => {});
  }

  private tasks = new Map<string, BgTaskRecord>();
  private runtimes = new Map<string, TaskRuntime>();
  /** runShellWithTimeout 在途等待者：kill 必须解套，否则工具调用永挂（审计 background-tasks F-01）。 */
  private waiters = new Map<string, (r: BgShellRunResult | { ok: false; error: string }) => void>();
  private messagesByTask = new Map<string, GuiChatMessage[]>();
  /** 快照推送节流（按父会话） */
  private snapTimers = new Map<string, NodeJS.Timeout>();
  /** 订阅消息流整包推送的会话（= 后台任务面板已打开）；未订阅不推整包 */
  private messageSubs = new Set<string>();
  /** 注册表落盘节流 */
  private persistTimer: NodeJS.Timeout | null = null;
  private readonly persistPath: string;
  /** 任务终态回调（证据归集器 T4.4 挂钩；传快照，异常自负） */
  onTaskFinished?: (task: BgTaskRecord) => void;

  constructor(
    private ctx: AppContext,
    private opts: { userDataDir: string }
  ) {
    this.persistPath = userDataStorage(opts.userDataDir).file('bg-tasks');
    this.restore();
    // C1 复审：bg-outputs 输出文件只随任务记录存续——记录已被修剪/注册表缺失的孤儿文件启动即清扫
    this.sweepOrphanBgOutputs();
  }

  /** 任务大输出落盘路径（shellTask.writeShellOutput 同一约定） */
  private bgOutputPathOf(taskId: string): string {
    return path.join(userDataStorage(this.opts.userDataDir).resolve('app', 'bg-outputs'), `${taskId}.log`);
  }

  private deleteBgOutput(taskId: string): void {
    try {
      fs.rmSync(this.bgOutputPathOf(taskId), { force: true });
    } catch {
      /* ignore */
    }
  }

  /** 清扫无任务记录对应的输出文件（启动时；防 userData 只增不减） */
  private sweepOrphanBgOutputs(): void {
    try {
      const dir = userDataStorage(this.opts.userDataDir).resolve('app', 'bg-outputs');
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        const m = /^(.+)\.log$/.exec(name);
        if (!m || this.tasks.has(m[1]!)) continue;
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // ---------- 注册表落盘（真源是文件；重启 replay） ----------

  /** 启动恢复：running 任务已随进程消亡，标 error 并置 pendingDigest 让父会话下一回合知晓 */
  private restore(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.persistPath, 'utf8');
    } catch {
      return; // 首次运行/文件缺失：空表启动
    }
    let data: PersistedBgTasks;
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedBgTasks>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tasks)) return;
      data = parsed as PersistedBgTasks;
    } catch {
      console.warn('[bgTasks] bg-tasks.json 损坏，忽略（空表启动）');
      return;
    }
    const now = Date.now();
    for (const r of data.tasks) {
      if (
        !r ||
        typeof r.id !== 'string' ||
        typeof r.parentSessionId !== 'string' ||
        !KNOWN_KINDS.includes(r.kind) ||
        !KNOWN_STATUS.includes(r.status) ||
        typeof r.createdAt !== 'number'
      ) {
        continue;
      }
      if (now - r.createdAt > PERSIST_KEEP_MS) continue;
      if (r.status === 'running') {
        r.status = 'error';
        r.summary = t('应用重启，任务中断');
        r.endedAt = data.savedAt ?? now;
        r.unread = true;
        r.pendingDigest = true;
        r.wake = false;
      }
      this.tasks.set(r.id, r);
    }
  }

  private persistSoon(): void {
    if (this.stopped || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 500);
    this.persistTimer.unref?.();
  }

  /** 同步写盘（原子替换；app 退出路径用） */
  private persistNow(strict = false): void {
    try {
      const now = Date.now();
      const tasks = [...this.tasks.values()]
        .filter((t) => t.status === 'running' || now - (t.endedAt ?? t.createdAt) <= PERSIST_KEEP_MS)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, PERSIST_KEEP_MAX);
      const payload: PersistedBgTasks = { version: 1, savedAt: now, tasks };
      writeJsonAtomicSync(this.persistPath, payload);
    } catch (e) {
      console.warn('[bgTasks] 注册表落盘失败', e);
      if (strict) throw e;
    }
  }

  private send(payload: BgTaskPush): void {
    if (this.stopped) return;
    try {
      this.ctx.getWindow()?.webContents.send('agentSession:bgTask', payload);
    } catch {
      /* 窗口可能已销毁 */
    }
    try {
      this.ctx.sendToAuxiliaryRenderers('agentSession:bgTask', payload);
    } catch {
      /* 同上 */
    }
  }

  private scheduleSnapshot(sessionId: string): void {
    if (this.stopped || this.snapTimers.has(sessionId)) return;
    const t = setTimeout(() => {
      this.snapTimers.delete(sessionId);
      this.send({ kind: 'snapshot', sessionId, tasks: this.listFor(sessionId) });
    }, 120);
    this.snapTimers.set(sessionId, t);
  }

  /**
   * 子代理消息整包推送——**只在面板订阅时推**。
   *
   * payload 是全量 GuiChatMessage[]（含工具卡与工具输出，与主聊天 sync 同构，真机
   * 单会话可到 2.93MB），而渲染层只有 BgTasksPanel 挂载时才消费它：面板关着推的每
   * 一包都是白扔。订阅打开时渲染层用 bgTasks:list 补齐当前全量，不会缺数据。
   * 任务列表 snapshot 仍无条件推（轻量，胶囊要显示运行数/未读）。
   */
  private pushMessages(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (!this.messageSubs.has(task.parentSessionId)) return;
    this.send({
      kind: 'task-messages',
      taskId,
      sessionId: task.parentSessionId,
      status: task.status,
      messages: this.messagesByTask.get(taskId) ?? []
    });
  }

  /**
   * 面板订阅子代理消息流（BgTasksPanel 挂载/卸载时调用）。
   * 打开订阅不在这里补推：渲染层同时会走 bgTasks:list 拿全量首帧。
   */
  setMessagesSubscribed(sessionId: string, on: boolean): void {
    const id = String(sessionId ?? '');
    if (!id) return;
    if (on) this.messageSubs.add(id);
    else this.messageSubs.delete(id);
  }

  private runningCount(sessionId: string): number {
    let n = 0;
    for (const t of this.tasks.values()) {
      if (t.parentSessionId === sessionId && t.status === 'running') n += 1;
    }
    return n;
  }

  private sourceFor(parentSessionId: string, cwd?: string): BgTaskSource | { ok: false; error: string } {
    if (this.stopped) return { ok: false, error: t('后台任务服务已停止') };
    try {
      return captureBgTaskSource(this.ctx.config.get(), this.ctx.sessions.get(parentSessionId), cwd);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private launchGuard(task: BgTaskRecord, source: BgTaskSource) {
    return bgTaskLaunchGuard(
      () => this.ctx.config.get(), () => this.ctx.sessions.get(task.parentSessionId), source,
      () => this.tasks.get(task.id)?.status === 'running'
    );
  }

  private baseTask(kind: BgTaskRecord['kind'], parentSessionId: string, label: string, detail: string, wake: boolean, source: BgTaskSource): BgTaskRecord {
    return {
      id: `t-${randomUUID().slice(0, 8)}`,
      parentSessionId,
      workspaceId: source.workspaceId,
      sourceRoot: { ...source.sourceRoot },
      cwd: source.cwd,
      cwdPhysicalPath: source.cwdKey,
      kind,
      label: truncateBgText(label || detail, 40),
      detail,
      status: 'running',
      createdAt: Date.now(),
      unread: false,
      pendingDigest: false,
      wake
    };
  }

  // ---------- 派发 ----------

  spawnShell(
    parentSessionId: string,
    cwd: string,
    command: string,
    name: string | undefined,
    wake: boolean,
    wakeOn?: BgWakeOn
  ): BgSpawnResult {
    const source = this.sourceFor(parentSessionId, cwd);
    if ('ok' in source) return source;
    if (this.runningCount(parentSessionId) >= BG_TASKS_MAX_PER_SESSION) {
      return { ok: false, error: `后台任务并发已达上限（${BG_TASKS_MAX_PER_SESSION}），请先完成/取消部分任务` };
    }
    const policy = resolveShellWakePolicy(wake, wakeOn);
    const task = this.baseTask('shell', parentSessionId, name ?? '', command, policy.wake, source);
    if (policy.wake) task.wakeOn = policy.wakeOn;
    this.tasks.set(task.id, task);
    this.persistSoon();
    void this.trackLaunch(startBgShell(this.ctx, task.id, source.cwd, command, {
      onExit: (exitCode, tail, outputPath) => {
        this.runtimes.delete(task.id); this.clearCleanupError(task.id);
        this.complete(task.id, exitCode === 0 ? 'done' : 'error', tail || undefined, exitCode, outputPath);
      },
      onCleanupFail: (message, exitCode, summary, outputPath) => {
        this.recordCleanupError(task.id, new Error(message), summary);
        this.complete(task.id, exitCode === 0 ? 'done' : 'error', this.tasks.get(task.id)?.summary, exitCode, outputPath);
      },
      onFail: (message) => {
        this.complete(task.id, 'error', message);
      }
    }, undefined, undefined, this.launchGuard(task, source))
      .then(handle => this.acceptShell(task.id, handle))
      .catch((e: unknown) => {
        this.complete(task.id, 'error', (e as Error).message);
      }), task.id);
    this.scheduleSnapshot(parentSessionId);
    return { ok: true, id: task.id };
  }

  /**
   * C1 超时转后台：带 timeoutMs 的 shell 执行——超时前跑完返回 foreground，
   * 超时（非 sleep）自动转后台返回 backgrounded（命令继续运行），sleep 超时判失败。
   */
  async runShellWithTimeout(
    parentSessionId: string,
    cwd: string,
    command: string,
    name: string | undefined,
    wake: boolean,
    wakeOn: BgWakeOn | undefined,
    timeoutMs: number
  ): Promise<BgShellRunResult | { ok: false; error: string }> {
    const source = this.sourceFor(parentSessionId, cwd);
    if ('ok' in source) return source;
    if (this.runningCount(parentSessionId) >= BG_TASKS_MAX_PER_SESSION) {
      return { ok: false, error: `后台任务并发已达上限（${BG_TASKS_MAX_PER_SESSION}），请先完成/取消部分任务` };
    }
    const policy = resolveShellWakePolicy(wake, wakeOn);
    const task = this.baseTask('shell', parentSessionId, name ?? '', command, policy.wake, source);
    if (policy.wake) task.wakeOn = policy.wakeOn;
    this.tasks.set(task.id, task);
    this.persistSoon();
    this.scheduleSnapshot(parentSessionId);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: BgShellRunResult | { ok: false; error: string }) => {
        if (settled) return;
        settled = true;
        this.waiters.delete(task.id);
        resolve(r);
      };
      this.waiters.set(task.id, settle);
      void this.trackLaunch(startBgShell(
        this.ctx,
        task.id,
        source.cwd,
        command,
        {
          onExit: (exitCode, summary, outputPath) => {
            this.runtimes.delete(task.id); this.clearCleanupError(task.id);
            this.complete(task.id, exitCode === 0 ? 'done' : 'error', summary || undefined, exitCode, outputPath);
            settle({ kind: 'foreground', exitCode, summary, outputPath });
          },
          onCleanupFail: (message, exitCode, summary, outputPath) => {
            this.recordCleanupError(task.id, new Error(message), summary);
            this.complete(task.id, exitCode === 0 ? 'done' : 'error', this.tasks.get(task.id)?.summary, exitCode, outputPath);
            settle({ ok: false, error: `命令退出码 ${exitCode}；进程清理失败：${message}` });
          },
          onFail: (msg) => {
            this.complete(task.id, 'error', msg);
            settle({ ok: false, error: msg });
          },
          onTimeout: () => {
            // 超时自动转后台：任务继续运行，完成时走 complete 通知
            settle({ kind: 'backgrounded', taskId: task.id, reason: t('超时 {{ms}}ms 自动转后台（命令继续运行）', { ms: timeoutMs }) });
          }
        },
        timeoutMs,
        this.opts.userDataDir,
        this.launchGuard(task, source)
      )
        .then(handle => this.acceptShell(task.id, handle))
        .catch((e: unknown) => {
            this.complete(task.id, 'error', (e as Error).message);
          settle({ ok: false, error: (e as Error).message });
        }), task.id);
    });
  }

  addTimer(parentSessionId: string, delayMs: number, reason: string): BgSpawnResult {
    const source = this.sourceFor(parentSessionId);
    if ('ok' in source) return source;
    if (this.runningCount(parentSessionId) >= BG_TASKS_MAX_PER_SESSION) {
      return { ok: false, error: `后台任务并发已达上限（${BG_TASKS_MAX_PER_SESSION}），请先完成/取消部分任务` };
    }
    const task = this.baseTask('timer', parentSessionId, '', reason, true, source);
    task.wakeAt = Date.now() + delayMs;
    this.tasks.set(task.id, task);
    this.persistSoon();
    const timer = setTimeout(() => {
      const rt = this.runtimes.get(task.id);
      if (rt) rt.timer = undefined;
      const guard = this.launchGuard(task, source);
      void this.track(guard.prepare().then(() => {
        guard.assertCurrent();
        this.complete(task.id, 'done', undefined, 0);
      }).catch((error: unknown) => {
        this.complete(task.id, 'error', (error as Error).message);
      }), task.id);
    }, delayMs);
    timer.unref?.();
    this.runtimes.set(task.id, { timer });
    this.scheduleSnapshot(parentSessionId);
    return { ok: true, id: task.id };
  }

  // ---------- 完成路由 ----------

  private complete(
    taskId: string,
    status: Extract<BgTaskStatus, 'done' | 'error' | 'cancelled'>,
    summary?: string,
    exitCode?: number,
    outputPath?: string
  ): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'running') return;
    task.status = status;
    task.endedAt = Date.now();
    if (summary) task.summary = summary;
    if (exitCode !== undefined) task.exitCode = exitCode;
    if (outputPath) task.outputPath = outputPath;
    task.unread = true;
    // Task outcome and parent delivery are distinct. Retain the digest until a
    // confirmed successful parent turn acknowledges this exact result version.
    const claimed = claimNotification(task);
    task.pendingDigest = status !== 'cancelled';
    if (status === 'cancelled') task.wake = false;
    const shouldWake = claimed && status !== 'cancelled' && shouldInjectBgWake({ task,
      sessionPhase: this.ctx.sessions.get(task.parentSessionId)?.phase?.value,
      siblings: [...this.tasks.values()].filter(x => x.parentSessionId === task.parentSessionId) });
    task.parentNotification = status === 'cancelled' ? 'disabled' : shouldWake ? 'pending' : 'digest';
    let durable = true;
    try { this.persistNow(true); }
    catch (error) {
      durable = false; task.notificationError = `任务结果无法落盘，未唤醒父会话：${String(error)}`;
      console.error('[bgTasks]', task.notificationError);
    }
    if (durable) void this.track(Promise.resolve().then(async () => {
      await semanticOperationsFor(this.ctx, task.parentSessionId, this.opts.userDataDir, this.ctx.sessionLogs)
        .fact(`background.task-${status}`, task.id, [task.id], { taskId: task.id, kind: task.kind, status, parentSessionId: task.parentSessionId });
      if (shouldWake && !this.stopped && this.tasks.get(task.id) === task) this.wakeParent(task);
    }).catch(error => {
      if (!this.stopped && this.tasks.get(task.id) === task) {
        task.notificationError = `任务结果已保存，通知事实待修复：${String(error)}`;
        this.scheduleSnapshot(task.parentSessionId); this.persistSoon();
      }
      console.error('[bgTasks] terminal fact failed', error);
    }), task.id);
    try {
      this.onTaskFinished?.(structuredClone(task));
    } catch (e) {
      console.warn('[bgTasks] 任务终态回调失败', e);
    }
    this.scheduleSnapshot(task.parentSessionId);
    this.pushMessages(taskId);
    this.persistSoon();
  }

  private wakeParent(task: BgTaskRecord): void {
    const source = this.sourceFor(task.parentSessionId);
    if ('ok' in source || source.workspaceId !== task.workspaceId
      || source.sourceRoot.rootId !== task.sourceRoot?.rootId
      || source.sourceRoot.physicalPath !== task.sourceRoot.physicalPath
      || source.cwd !== task.cwd || source.cwdKey !== task.cwdPhysicalPath) {
      // Preserve the result for inspection; never wake a parent that has moved to another source.
      task.pendingDigest = true;
      return;
    }
    const host = this.ctx.agentSessions;
    if (!host) {
      task.pendingDigest = true;
      return;
    }
    const failed = task.status === 'error';
    const text =
      task.kind === 'timer'
        ? t('【后台任务】定时器（{{id}}）到点：{{reason}}。请继续处理之前安排的相关事项。', {
            id: task.id,
            reason: task.detail
          })
        : t('【后台任务】{{label}}（{{id}}）{{state}}{{summary}}。请查看并继续处理。', {
            label: task.label,
            id: task.id,
            state: failed ? t('失败') : t('已完成'),
            summary: task.summary ? t('，结果摘要：\n{{summary}}', { summary: task.summary }) : ''
          });
    const preserveDigest = (): void => {
      // 用户可能在异步回执之前删除记录；不得重新写回已删除的任务。
      if (this.stopped || this.tasks.get(task.id) !== task) return;
      task.pendingDigest = true;
      this.scheduleSnapshot(task.parentSessionId);
      this.persistSoon();
    };
    const receipt = new Promise<void>(resolve => {
      let active = true;
      const finish = (): void => {
        if (!active) return;
        active = false;
        this.pendingWakeTasks.delete(task.id);
        this.wakeStop.signal.removeEventListener('abort', finish);
        resolve();
      };
      this.pendingWakeTasks.add(task.id);
      this.wakeStop.signal.addEventListener('abort', finish, { once: true });
      try {
        // GUI owns the accepted send/connection. This scope owns only its receipt
        // callback; stopping admission must not wait on a later-disposed GUI domain.
        void Promise.resolve(host.send(task.parentSessionId, text, undefined, { hiddenFromTranscript: true, host: true, messageId: `background-wake-${task.id}` })).then(result => {
          if (!active) return;
          if (!result?.ok) {
            task.parentNotification = 'pending'; task.notificationError = '父会话尚未受理，结果摘要已保留'; preserveDigest();
          } else if (this.tasks.get(task.id) === task) {
            task.parentNotification = 'accepted'; delete task.notificationError;
            this.scheduleSnapshot(task.parentSessionId); this.persistSoon();
          }
          finish();
        }, error => { if (active) {
          if ((error as { deliveryUncertain?: boolean })?.deliveryUncertain) {
            task.parentNotification = 'unknown'; task.notificationError = '父会话唤醒结果未知，未自动重发；请检查原生历史，结果摘要已保留';
            this.ctx.ui?.notify?.(t('后台任务'), task.notificationError);
          } else { task.parentNotification = 'pending'; task.notificationError = `父会话唤醒失败，结果摘要已保留：${String(error)}`; }
          preserveDigest(); finish();
        } });
      } catch { preserveDigest(); finish(); }
    });
    void this.track(receipt);

  }

  // ---------- 查询 / 控制 ----------

  listFor(sessionId: string): BgTaskRecord[] {
    return [...this.tasks.values()]
      .filter((t) => t.parentSessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((t) => structuredClone(t));
  }

  runningSourceRoster(): BgTaskRecord[] {
    return [...this.tasks.values()].filter(task => task.status === 'running').map(task => structuredClone(task));
  }

  getListResult(sessionId: string): BgTaskListResult {
    const tasks = this.listFor(sessionId);
    const messages: Record<string, GuiChatMessage[]> = {};
    for (const t of tasks) {
      const m = this.messagesByTask.get(t.id);
      if (m && m.length > 0) messages[t.id] = m;
    }
    return { tasks, messages };
  }

  markRead(sessionId: string): void {
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.parentSessionId === sessionId && t.unread) {
        t.unread = false;
        changed = true;
      }
    }
    if (changed) this.scheduleSnapshot(sessionId);
  }

  /** Prepare a stable result batch; preparation and failed sends never consume it. */
  prepareDigest(sessionId: string, alreadyIncludedTaskId?: string): PreparedBgDigest | null {
    const pending = this.listFor(sessionId).filter(task => task.pendingDigest && task.status !== 'running');
    if (!pending.length) return null;
    const entries = pending.map(task => ({ id: task.id, fingerprint: digestFingerprint(task) }));
    return { sessionId, entries, text: buildBgTaskDigest(pending.filter(task => task.id !== alreadyIncludedTaskId)) ?? '',
      operationId: `background-digest-${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}` };
  }

  /** Acknowledge only versions included in a confirmed, successful engine turn. */
  ackDigest(prepared: PreparedBgDigest): void {
    if (this.stopped) return;
    const changed: Array<{ task: BgTaskRecord; notification: BgTaskRecord['parentNotification']; error?: string }> = [];
    for (const entry of prepared.entries) {
      const task = this.tasks.get(entry.id);
      if (!task || task.parentSessionId !== prepared.sessionId || !task.pendingDigest || task.status === 'running' || digestFingerprint(task) !== entry.fingerprint) continue;
      changed.push({ task, notification: task.parentNotification, error: task.notificationError });
      task.pendingDigest = false; task.parentNotification = 'digested'; delete task.notificationError;
    }
    if (!changed.length) return;
    try { this.persistNow(true); }
    catch (error) {
      for (const previous of changed) { previous.task.pendingDigest = true; previous.task.parentNotification = previous.notification; previous.task.notificationError = previous.error; }
      throw error;
    }
    this.scheduleSnapshot(prepared.sessionId);
    void this.track(Promise.resolve().then(() => semanticOperationsFor(this.ctx, prepared.sessionId, this.opts.userDataDir, this.ctx.sessionLogs)
      .fact('background.digest-consumed', prepared.operationId, changed.map(item => item.task.id), { taskIds: changed.map(item => item.task.id) }))
      .catch(error => console.error('[bgTasks] digest consumption fact failed', error)));
  }

  kill(taskId: string, initiator: BgKillInitiator = 'model'): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'running') {
      task.initiator = initiator;
      this.complete(taskId, 'cancelled');
    }
    const rt = this.runtimes.get(taskId);
    if (rt?.timer) clearTimeout(rt.timer);
    if (rt?.shell) void this.track(this.releaseShell(taskId).catch(() => {}), taskId);
    else this.runtimes.delete(taskId);
    // kill 后 shell 回调已被摘除：显式解套在途等待者，工具调用以终止语义收口而非永挂。
    this.waiters.get(taskId)?.({ ok: false, error: t('任务已被终止（{{who}}）', { who: initiator === 'user' ? '用户' : '模型' }) });
    this.waiters.delete(taskId);
    this.scheduleSnapshot(task.parentSessionId);
    return true;
  }

  /** Confirm cancellation of both registered and still-preparing resources. */
  async killAndWait(taskId: string, initiator: BgKillInitiator = 'model'): Promise<boolean> {
    if (!this.kill(taskId, initiator)) return false;
    while (this.taskOperations.get(taskId)?.size) await Promise.allSettled([...this.taskOperations.get(taskId)!]);
    const error = this.cleanupErrors.get(taskId)?.error;
    if (error) throw error;
    return true;
  }

  /** 删除已完成任务记录（running 拒绝；要删运行中任务先经 kill 转终态再调本方法）；连带消息流、输出文件与落盘 */
  remove(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'running' || this.runtimes.get(taskId)?.shell || this.pendingLaunches.has(taskId)) return false;
    this.tasks.delete(taskId);
    this.messagesByTask.delete(taskId);
    this.runtimes.delete(taskId);
    this.deleteBgOutput(taskId);
    this.persistSoon();
    this.scheduleSnapshot(task.parentSessionId);
    return true;
  }

  /** 清除该会话全部已完成记录（面板「清除已完成」）；返回清除条数 */
  clearFinished(sessionId: string): number {
    let removed = 0;
    for (const t of this.listFor(sessionId)) {
      if (this.remove(t.id)) removed += 1;
    }
    return removed;
  }

  killAllForSession(sessionId: string): void {
    // 会话关闭是用户动作：initiator 记 user（缺省会记成 model，区分失真）
    for (const t of this.listFor(sessionId)) {
      if (t.status === 'running') this.kill(t.id, 'user');
    }
  }

  async killAllForSessionAndWait(sessionId: string): Promise<void> {
    const tasks = this.listFor(sessionId).filter(task => task.status === 'running' || this.runtimes.get(task.id)?.shell || this.pendingLaunches.has(task.id));
    const results = await Promise.allSettled(tasks.map(task => this.killAndWait(task.id, 'user')));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, `Background session cleanup failed: ${errors.map(String).join('; ')}`);
  }

  /** 该父会话的全部任务 id（含已完成）：Pi purge 反查 `bg-<taskId>` 引擎转录用，只读不动记录 */
  taskIdsForSession(sessionId: string): string[] {
    return this.listFor(sessionId).map((t) => t.id);
  }

  /** 全部任务记录的 (id, parentSessionId)：引擎孤儿清扫判断 `bg-<taskId>` 文件去留用 */
  taskParentPairs(): Array<{ id: string; parentSessionId: string }> {
    return [...this.tasks.values()].map((t) => ({ id: t.id, parentSessionId: t.parentSessionId }));
  }

  stopAdmission(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const taskId of this.pendingWakeTasks) {
      const task = this.tasks.get(taskId);
      if (task) { task.pendingDigest = true; task.parentNotification = 'unknown'; task.notificationError = '退出时父会话唤醒尚未确认，结果摘要已保留'; }
    }
    this.wakeStop.abort();
  }

  /** Stop admission first, then drain accepted launches and callbacks before final persistence. */
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopAdmission();
    this.shutdownPromise = (async () => {
      const errors: unknown[] = [];
      for (const timer of this.snapTimers.values()) clearTimeout(timer);
      this.snapTimers.clear();
      this.messageSubs.clear();
      for (const task of this.tasks.values()) {
        try { if (task.status === 'running') this.kill(task.id, 'user'); }
        catch (error) { errors.push(error); }
      }
      for (const [taskId, runtime] of this.runtimes) if (runtime.shell) void this.track(this.releaseShell(taskId).catch(() => {}), taskId);
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = null;
      // Includes handles returned after async shell profile/source preparation.
      while (this.operations.size) {
        const results = await Promise.allSettled([...this.operations]);
        for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      }
      this.onTaskFinished = undefined;
      try { this.persistNow(true); } catch (error) { errors.push(error); }
      errors.push(...[...this.cleanupErrors.values()].map(failure => failure.error));
      if (errors.length) throw new AggregateError(errors, 'Background task shutdown failed');
    })();
    const stopping = this.shutdownPromise;
    void stopping.catch(() => { if (this.shutdownPromise === stopping) this.shutdownPromise = undefined; });
    return stopping;
  }
}
