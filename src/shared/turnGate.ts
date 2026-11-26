/**
 * O8 全局自治回合闸（wmux globalTurnGate 原型）：跨工作区的自治回合计数信号量。
 * 纯逻辑（零 process/electron，注入 clock 与配置读取）；主进程装配在 Orchestrator：
 * 只对 host 标记的自治入口（事件 flush / 邮箱收信 / requestIntegrate / 异常上行 /
 * facts 订阅投递）包闸，人的手动输入（chat:send / sendNow / 计划卡执行 / 飞书人指令）
 * 不带 host 标记，直通不节流。
 *
 * 语义（研究文档 §2.3）：
 * - 按 token 记槽：双释放 / 陈旧释放是安全 no-op（Map delete），不会幻影减计数；
 * - 每槽带租约（leaseMs）：tryAcquire 时先回收超租约的 wedged 槽（回收经 onReclaim
 *   上报日志），回收后本回合 transient 超限可接受——宁可放行也不死锁；
 * - enabled=false 直通：返回未记槽的 pass token（release 为 no-op），行为与无闸一致；
 * - 满闸返回 null：调用方排队重试（TurnGateQueue 缓冲，槽释放即 drain，不丢不报错）。
 */

/** 缺省宽（研究文档口径）：4 槽、15 分钟租约 */
export const ORCH_TURN_GATE_DEFAULTS = {
  enabled: true,
  cap: 4,
  leaseMs: 15 * 60_000
} as const;

const MIN_CAP = 1;
const MAX_CAP = 32;
const MIN_LEASE_MS = 60_000;
const MAX_LEASE_MS = 24 * 60 * 60_000;

/** 用户可写形状（config.turnGate；字段可省） */
export interface TurnGateUserConfig {
  enabled?: boolean;
  cap?: number;
  leaseMs?: number;
}

/** 归一后形状（全字段必填） */
export interface TurnGateConfig {
  enabled: boolean;
  cap: number;
  leaseMs: number;
}

export function normalizeTurnGateConfig(raw: unknown): TurnGateConfig {
  const o =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as TurnGateUserConfig) : {};
  const cap =
    typeof o.cap === 'number' && Number.isFinite(o.cap)
      ? Math.min(MAX_CAP, Math.max(MIN_CAP, Math.floor(o.cap)))
      : ORCH_TURN_GATE_DEFAULTS.cap;
  const leaseMs =
    typeof o.leaseMs === 'number' && Number.isFinite(o.leaseMs)
      ? Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(o.leaseMs)))
      : ORCH_TURN_GATE_DEFAULTS.leaseMs;
  return {
    enabled: o.enabled !== false,
    cap,
    leaseMs
  };
}

/** 租约超时回收上报（装配侧记日志） */
export interface TurnGateReclaimInfo {
  token: string;
  acquiredAt: number;
  heldMs: number;
}

export interface TurnGateSlot {
  token: string;
  acquiredAt: number;
}

export class TurnGate {
  private slots = new Map<string, TurnGateSlot>();
  private seq = 0;

  constructor(
    private getConfig: () => TurnGateConfig,
    private now: () => number,
    private onReclaim?: (info: TurnGateReclaimInfo) => void
  ) {}

  /** 当前占用槽数（观测/测试用） */
  get activeCount(): number {
    return this.slots.size;
  }

  /**
   * 尝试占一槽：
   * - disabled → 直通：返回未记槽的 pass token（release no-op）；
   * - 满闸（回收后仍无空位）→ null，调用方排队重试；
   * - 成功 → 记槽返回 token，回合结束必须 release。
   */
  tryAcquire(): string | null {
    const cfg = this.getConfig();
    if (!cfg.enabled) return this.nextToken('pass');
    this.reclaimExpired(cfg);
    if (this.slots.size >= cfg.cap) return null;
    const token = this.nextToken('turn');
    this.slots.set(token, { token, acquiredAt: this.now() });
    return token;
  }

  /** 释放一槽：未知 token / 双释放 / pass token 一律安全 no-op */
  release(token: string): void {
    this.slots.delete(token);
  }

  /** 回收超租约的 wedged 槽（只在 tryAcquire 内发生：无获取压力时不主动扫） */
  private reclaimExpired(cfg: TurnGateConfig): void {
    const now = this.now();
    for (const [token, slot] of this.slots) {
      const heldMs = now - slot.acquiredAt;
      if (heldMs > cfg.leaseMs) {
        this.slots.delete(token);
        try {
          this.onReclaim?.({ token, acquiredAt: slot.acquiredAt, heldMs });
        } catch {
          /* 上报失败不影响闸本身 */
        }
      }
    }
  }

  private nextToken(prefix: string): string {
    this.seq += 1;
    return `${prefix}:${this.seq}`;
  }
}

/**
 * 闸满暂存缓冲（Orchestrator 的 pending 语义，抽成纯类便于离线测）：
 * submit 满闸入队（不丢、不报错），槽释放调 drain 立即按 FIFO 重投；
 * deliver 由装配侧转发回真实 send 的自治路径（带 token，不再二次过闸）。
 * retryMs 兜底节奏：所有释放都触发 drain，但 wedged 槽只在 tryAcquire 时回收，
 * 定期重试保证 pending 不会因无人再 acquire 而永悬。
 */
export const TURN_GATE_RETRY_MS = 15_000;

export interface TurnGateQueueItem {
  text: string;
  workspaceId: string;
  images?: unknown;
  /** Trusted admission metadata survives deferred autonomous dispatch. */
  messageId?: string;
  requireIdle?: boolean;
  /** Identifies a host wake across deferred admission. */
  schedulerWake?: true;
  beforeStart?: () => boolean;
  /** Called only after the request entered the durable transcript/queue. */
  onAccepted?: () => void;
  notification?: import('./hostNotification').HostNotificationDelivery;
  onSkipped?: (error?: unknown) => void;
}

export interface TurnGateQueueDeps {
  gate: TurnGate;
  /** 拿到空槽后的真实投递（装配侧转发回 orchestrator.send 的自治路径） */
  deliver: (item: TurnGateQueueItem, token: string) => void;
  /** 重试调度（宿主 setTimeout；测试注入收集） */
  schedule: (fn: () => void, ms: number) => unknown;
  cancel?: (timer: unknown) => void;
  retryMs?: number;
}

export class TurnGateQueue {
  private items: TurnGateQueueItem[] = [];
  private retryTimer: unknown = null;
  private failOpenSeq = 0;
  private disposed = false;

  constructor(private deps: TurnGateQueueDeps) {}

  get pendingCount(): number {
    return this.items.length;
  }

  /** 测试观测：当前 pending 快照 */
  pendingSnapshot(): readonly TurnGateQueueItem[] {
    return [...this.items];
  }

  /**
   * 自治投递入口：有空槽 → 消耗槽并同步 deliver（返回 'sent'）；
   * 满闸 → 入 pending 排队重试（返回 'pending'，不丢不报错）。
   * fail-open：闸本身抛错（配置读失败等）按「不挡」放行——合成未记槽的
   * fail-open token 直接 deliver（release 是安全 no-op）。宁可放行也不死锁。
   */
  submit(item: TurnGateQueueItem): 'sent' | 'pending' {
    if (this.disposed) { item.onSkipped?.(); throw new Error('Turn gate queue is closed'); }
    let token: string | null;
    try {
      token = this.deps.gate.tryAcquire();
    } catch {
      this.failOpenSeq += 1;
      this.deps.deliver(item, `fail-open:${this.failOpenSeq}`);
      return 'sent';
    }
    if (token === null) {
      this.items.push(item);
      this.scheduleRetry();
      return 'pending';
    }
    this.deps.deliver(item, token);
    return 'sent';
  }

  /** 槽释放后调用：按 FIFO 重投 pending；仍满闸的项回队列并保底重试 */
  drain(): void {
    if (this.disposed) return;
    if (!this.items.length) return;
    const batch = this.items;
    this.items = [];
    for (const item of batch) {
      this.submit(item);
    }
    if (this.items.length) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.retryTimer != null || !this.items.length) return;
    const ms = this.deps.retryMs ?? TURN_GATE_RETRY_MS;
    this.retryTimer = this.deps.schedule(() => {
      this.retryTimer = null;
      this.drain();
    }, ms);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.retryTimer != null) this.deps.cancel?.(this.retryTimer);
    this.retryTimer = null;
    const pending = this.items.splice(0);
    const errors: unknown[] = [];
    for (const item of pending) {
      try { item.onSkipped?.(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Turn gate cancellation failed');
  }
}
