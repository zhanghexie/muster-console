/**
 * 巩固触发装配（memory-refactor §6.3 触发面 / §3 事件驱动）：
 * 事件源（任务关闭/会话结束/needs_you 翻转/空闲兜底/手动）→ request() 收口到
 * **每工作区一把运行锁**（同工作区同时至多一个 sweep）+ 去抖（事件风暴合并成一次）
 * + 最小间隔（防高频事件源把 sweep 打成轮询；手动入口可豁免——用户点按钮就是要跑）。
 *
 * 运行中再次 request 不丢弃而是排队（合并 reason，跑完当前接着跑一次——收掉
 * sweep 期间新到的候选）；空闲兜底由 startIdleWatch 周期检查「距上次 ≥N 小时」。
 *
 * 纯调度状态机（timers 注入可测；零 electron/IO 依赖——实际 sweep 执行体由
 * runtime.ts 注入，全链 try/catch 绝不影响业务事件）。
 */

/** request() 受理结果（手动入口如实上报用——被跳过不再静默吞，B4 评审 MINOR-5） */
export type MemoryConsolidationRequestOutcome =
  | 'queued' // 去抖排队受理
  | 'merged' // 运行中/去抖窗口内合并（当前跑完接着跑）
  | 'skipped_stopped' // 触发器已停止/空根，不受理
  | 'skipped_min_interval'; // 距上次 sweep 太近（bypassMinInterval 可豁免）

export interface ConsolidationTriggerOptions {
  /** 执行体（运行锁保护内调用；异常在此模块消化） */
  run: (root: string, reason: string) => Promise<unknown>;
  /** 事件去抖窗口（默认 15s：任务关闭/会话结束常成对到达） */
  debounceMs?: number;
  /** 同根两次 sweep 最小间隔（默认 10min：事件频发时防轮询） */
  minIntervalMs?: number;
  /** 空闲兜底间隔（默认 6h：memoryConsolidation.idleMinIntervalHours 折算） */
  idleIntervalMs?: number;
  /** 空闲检查周期（默认 5min；测试注入缩短） */
  idleCheckIntervalMs?: number;
  now?: () => number;
}

interface RootState {
  running: boolean;
  lastRunAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** 去抖/运行期间合并的待跑 reason（首个语义最强的保留：manual > 非空闲 > idle） */
  queuedReason?: string;
}

const REASON_RANK: Record<string, number> = { manual: 3, task_close: 2, session_end: 2, needs_you: 2, idle: 1 };

function reasonRank(r: string | undefined): number {
  if (r == null) return 0;
  return REASON_RANK[r] ?? 2;
}

export class MemoryConsolidationTrigger {
  private readonly roots = new Map<string, RootState>();
  private readonly run: (root: string, reason: string) => Promise<unknown>;
  private readonly debounceMs: number;
  private readonly minIntervalMs: number;
  /** 空闲兜底间隔（默认 6h；runtime 按配置覆写——公共可变字段） */
  idleIntervalMs: number;
  private readonly idleCheckIntervalMs: number;
  private readonly now: () => number;
  private idleTimer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(opts: ConsolidationTriggerOptions) {
    this.run = opts.run;
    this.debounceMs = opts.debounceMs ?? 15_000;
    this.minIntervalMs = opts.minIntervalMs ?? 10 * 60_000;
    this.idleIntervalMs = opts.idleIntervalMs ?? 6 * 3_600_000;
    this.idleCheckIntervalMs = opts.idleCheckIntervalMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  private state(root: string): RootState {
    let st = this.roots.get(root);
    if (!st) {
      st = { running: false, lastRunAt: 0 };
      this.roots.set(root, st);
    }
    return st;
  }

  isRunning(root: string): boolean {
    return this.roots.get(root)?.running === true;
  }

  lastRunAt(root: string): number {
    return this.roots.get(root)?.lastRunAt ?? 0;
  }

  /**
   * 事件入口：去抖排队 → 运行锁内执行；任何异常内部消化（不影响业务事件流）。
   * 返回受理结果（queued/merged=会跑；skipped_*=未受理及原因）——事件入口可忽略，
   * 手动入口据此如实上报。opts.bypassMinInterval：豁免最小间隔（手动入口专用；
   * 去抖与运行锁仍生效——运行中的合并接跑）。
   */
  request(
    root: string,
    reason: string,
    opts?: { bypassMinInterval?: boolean }
  ): MemoryConsolidationRequestOutcome {
    if (this.stopped || !root) return 'skipped_stopped';
    const st = this.state(root);
    // 运行中：不丢——排队（合并 reason），当前跑完接着跑
    if (st.running) {
      st.queuedReason = mergeReason(st.queuedReason, reason);
      return 'merged';
    }
    // 最小间隔内：跳过（空闲兜底与手动入口的 lastRunAt 同口径；手动可豁免）
    if (!opts?.bypassMinInterval && st.lastRunAt > 0 && this.now() - st.lastRunAt < this.minIntervalMs) {
      return 'skipped_min_interval';
    }
    if (st.timer) {
      st.queuedReason = mergeReason(st.queuedReason, reason);
      return 'merged';
    }
    st.queuedReason = mergeReason(undefined, reason);
    st.timer = setTimeout(() => {
      st.timer = undefined;
      void this.fire(root);
    }, this.debounceMs);
    // Electron 主进程短定时器不阻塞退出；测试进程自然快进
    (st.timer as { unref?: () => void }).unref?.();
    return 'queued';
  }

  private async fire(root: string): Promise<void> {
    const st = this.state(root);
    if (st.running || this.stopped) return;
    const reason = st.queuedReason ?? 'unknown';
    st.queuedReason = undefined;
    st.running = true;
    st.lastRunAt = this.now();
    try {
      await this.run(root, reason);
    } catch (err) {
      console.error('[memory-consolidation] sweep 执行失败（忽略，不影响业务）', err);
    } finally {
      st.running = false;
      // sweep 期间又有事件到达 → 接着跑一次（仍受去抖约束）
      const queued = st.queuedReason;
      st.queuedReason = undefined;
      if (queued && !this.stopped) {
        st.timer = setTimeout(() => {
          st.timer = undefined;
          void this.fire(root);
        }, this.debounceMs);
        (st.timer as { unref?: () => void }).unref?.();
        st.queuedReason = queued;
      }
    }
  }

  /** 空闲兜底：周期检查各根距上次 sweep ≥ idleIntervalMs 则触发（reason='idle'） */
  startIdleWatch(getRoots: () => ReadonlyArray<string>): void {
    if (this.idleTimer || this.stopped) return;
    this.idleTimer = setInterval(() => {
      const now = this.now();
      for (const root of getRoots()) {
        const st = this.roots.get(root);
        // 冷启动 lastRunAt=0 不视为已空闲——避免新工作区立刻打 idle 巩固
        const last = st?.lastRunAt;
        if (last == null || last <= 0) {
          if (st) st.lastRunAt = now;
          continue;
        }
        if (now - last >= this.idleIntervalMs) this.request(root, 'idle');
      }
    }, this.idleCheckIntervalMs);
    (this.idleTimer as { unref?: () => void }).unref?.();
  }

  /** 停止：清全部定时器（before-quit；运行中的 sweep await 完自然结束） */
  stop(): void {
    this.stopped = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const st of this.roots.values()) {
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = undefined;
      }
      st.queuedReason = undefined;
    }
  }
}

/** 合并排队 reason：取语义更强者（manual > 事件类 > idle；同级保先到） */
function mergeReason(cur: string | undefined, next: string): string {
  if (!cur) return next;
  return reasonRank(next) > reasonRank(cur) ? next : cur;
}
