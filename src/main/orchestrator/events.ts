import { WatcherLifetime } from '../watcherLifetime';
import { createHash } from 'node:crypto';
import { deliverAgentMessage } from '../messages/deliver';
/**
 * 调度事件泵（R1）：入队 + 合并窗口 flush；空闲才 inject（orchestrator.send 同管道）。
 * 守卫 tick（R3）复用同一队列。无 electron 类型依赖，便于离线测。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NotifyFlipEvent } from '../notify/bus';
import {
  aggregateOrchEvents,
  clipOrchDetail,
  decideOrchFlush,
  enqueueOrchEvent,
  formatReflogLine,
  isGitReflogRel,
  nextOrchFlushDelay,
  orchEventKey,
  ORCH_DIGEST_MAX,
  ORCH_WAKE_DEFAULTS,


  type OrchEvent,
  type OrchEventKind,
} from '../../shared/notifyQueue';
import {
  decidePolicyAction,
  effectivePolicyGuards,
  effectivePolicyTiming,
  type PolicyDecision,
  type PolicyEventView,
  type SubscriptionPolicy
} from '../../shared/subscriptionPolicy';
import {
  evaluateOrchGuards,
  guardKeysToClearOnActivity,
  guardKeysToClearOnPhase,
  isOrchestratedWorker,
  mergeLastActivityOnLoad,
  ORCH_GUARD_DEFAULTS,
  pruneGuardPersistState,
  slotFreeKey,
  type GuardWorkerSnapshot
} from '../../shared/orchestratorGuards';
import { OrchestratorGuardStateStore } from './guardStateStore';
import { activeWorkerCount, listDelegateQueue, readMaxConcurrentWorkers } from '../tasks/delegateQueue';
import { sourceRootsFor } from '../../shared/workspaceRoots';
import { readGitDirectories } from '../git/repoIdentity';
import { pathKey } from '../pathKey';
import { sourcePathKey } from '../workspacePaths';
import { hasSchedulerPendingQuestion } from '../schedulerStatusStore';
import { tailSummary } from '../../shared/chatTail';
import type { AppContext } from '../context';
import type { SessionMeta } from '../../shared/types';
import { lastActivityAt, sessionActivityParts } from '../../shared/pipelineStatus';
import { t } from '../../shared/i18n';

export type OrchPumpDeps = {
  ctx: AppContext;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (id: ReturnType<typeof setTimeout>) => void;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
  enabled?: () => boolean;
  guardsEnabled?: () => boolean;
  mergeWindowMs?: number;
  maxWaitMs?: number;
  /** 守卫状态持久化目录（userData；缺省不持久化——纯内存，测试无盘跑）。 */
  guardStateDir?: string;
  /**
   * R-12 态势快照刷新缝：任务翻转 / 相位翻转 / flush 后回调（index 装配 →
   * situationWriter 的 30s 节流重写 SITUATION.md）。回调抛错被吞（fail-open）。
   */
  onSituationChange?: (workspaceId: string) => void;
  /**
   * C1 订阅策略：按工作区取生效策略（index 装配 → SubscriptionPolicyStore）。
   * 缺省或抛错=空策略，即全部内置默认规则（与改造前的硬编码行为一致）。
   * mergeWindowMs/maxWaitMs 显式传入时优先于策略（测试用）。
   */
  policyFor?: (workspaceId: string) => SubscriptionPolicy | null | undefined;
  /** 每次策略判定的回调（规则命中统计；抛错被吞） */
  onPolicyDecision?: (workspaceId: string, decision: PolicyDecision) => void;
};

/** 策略判定之前的旁听者（工作流 waitFor）：看得到被 mute 的事件与未聚合的原始任务翻转 */
export type OrchEventTap = (workspaceId: string, view: PolicyEventView & { detail?: string }) => void;

let pumpRef: OrchestratorEventPump | null = null;

export function bindOrchestratorEventPump(p: OrchestratorEventPump | null): void {
  pumpRef = p;
}

export function getOrchestratorEventPump(): OrchestratorEventPump | null {
  return pumpRef;
}

export function noteMergeBlocked(opts: {
  workspaceId: string;
  sessionId?: string;
  sessionName?: string;
  files: string[];
}): void {
  pumpRef?.enqueue({
    kind: 'merge_blocked',
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    sessionName: opts.sessionName,
    detail: `主仓脏文件挡住合入：${opts.files.slice(0, 8).join(', ')}${opts.files.length > 8 ? '…' : ''}`
  });
}

/** R-14 交验前置门红灯：needs_you 被机械门挡下，入队通知调度（建议先打回） */
export function noteDimensionGateRed(opts: {
  workspaceId: string;
  sessionId?: string;
  sessionName?: string;
  detail: string;
}): void {
  pumpRef?.enqueue({
    kind: 'dim_gate_red',
    workspaceId: opts.workspaceId,
    sessionId: opts.sessionId,
    sessionName: opts.sessionName,
    detail: clipOrchDetail(
      `任务被维度门挡下，未进「需要你」列：${opts.detail}。建议先 sessions.review rejected 打回（红灯详情随打回注入）；确属误报才让用户在全局看板右键强制验收`
    )
  });
}

export function noteSlotFreed(workspaceId: string): void {
  pumpRef?.onSlotFreed(workspaceId);
}

export class OrchestratorEventPump {
  private queues = new Map<string, OrchEvent[]>();
  /** 策略判为 digest 的事件：不单独唤醒，随下一次 flush 捎带（上限 ORCH_DIGEST_MAX） */
  private digests = new Map<string, OrchEvent[]>();
  private firstAt = new Map<string, number>();
  private lastAt = new Map<string, number>();
  private flushTimer = new Map<string, ReturnType<typeof setTimeout>>();
  private activity = new Map<string, number>();
  private needsYouSince = new Map<string, number>();
  private fired = new Set<string>();
  private firedAt = new Map<string, number>();
  private guardTimer: ReturnType<typeof setInterval> | null = null;
  private sending = new Set<string>();
  private closing = false;
  private readonly active = new Set<Promise<unknown>>();
  /** 守卫状态持久化（O3）：fired/lastActivity 重启不丢；缺省 null=纯内存 */
  private guardStore: OrchestratorGuardStateStore | null = null;
  private guardLoaded = false;
  private taps = new Set<OrchEventTap>();

  constructor(private deps: OrchPumpDeps) {
    if (deps.guardStateDir) this.guardStore = new OrchestratorGuardStateStore(deps.guardStateDir);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** R-12：态势快照刷新信号（30s 节流在 situationWriter；此处只递缝，fail-open） */
  private noteSituation(ws: string): void {
    if (this.closing) return;
    if (!this.deps.onSituationChange) return;
    try {
      this.deps.onSituationChange(ws);
    } catch (err) {
      console.error('[orch-events] situation refresh signal failed（忽略）', ws, err);
    }
  }

  private enabled(): boolean {
    if (this.closing) return false;
    return this.deps.enabled?.() ?? ORCH_WAKE_DEFAULTS.enabled;
  }

  private policy(ws: string): SubscriptionPolicy | null {
    if (!this.deps.policyFor) return null;
    try {
      return this.deps.policyFor(ws) ?? null;
    } catch (err) {
      console.error('[orch-events] 读订阅策略失败，按内置默认处理', ws, err);
      return null;
    }
  }

  private decide(ws: string, view: PolicyEventView): PolicyDecision {
    const decision = decidePolicyAction(view, this.policy(ws));
    if (this.deps.onPolicyDecision) {
      try {
        this.deps.onPolicyDecision(ws, decision);
      } catch {
        /* 统计失败不影响判定 */
      }
    }
    return decision;
  }

  addTap(fn: OrchEventTap): () => void {
    if (this.closing) throw new Error('Orchestrator event pump is stopping');
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  private tap(ws: string, view: PolicyEventView, detail?: string): void {
    if (this.closing) return;
    for (const fn of this.taps) {
      try {
        fn(ws, detail ? { ...view, detail } : view);
      } catch (err) {
        console.error('[orch-events] tap failed（忽略）', err);
      }
    }
  }

  private timingFor(ws: string): { windowMs: number; maxWaitMs: number } {
    const t = effectivePolicyTiming(this.policy(ws));
    return {
      windowMs: this.deps.mergeWindowMs ?? t.mergeWindowMs,
      maxWaitMs: this.deps.maxWaitMs ?? t.maxWaitMs
    };
  }

  private addDigest(ws: string, event: OrchEvent): void {
    const { queue } = enqueueOrchEvent(this.digests.get(ws) ?? [], event, ORCH_DIGEST_MAX);
    this.digests.set(ws, queue);
    this.noteSituation(ws);
  }

  start(): void {
    if (this.closing) throw new Error('Orchestrator event pump is stopping');
    this.stop();
    const si: NonNullable<OrchPumpDeps['setInterval']> = this.deps.setInterval ?? setInterval;
    this.guardTimer = si(() => this.tickGuards(), ORCH_GUARD_DEFAULTS.tickMs);
    if (typeof this.guardTimer === 'object' && this.guardTimer && 'unref' in this.guardTimer) {
      (this.guardTimer as NodeJS.Timeout).unref?.();
    }
  }

  stop(): void {
    const ct = this.deps.clearTimeout ?? clearTimeout;
    const ci = this.deps.clearInterval ?? clearInterval;
    for (const id of this.flushTimer.values()) ct(id);
    this.flushTimer.clear();
    if (this.guardTimer != null) {
      ci(this.guardTimer);
      this.guardTimer = null;
    }
  }

  /** 测试用：当前队列快照 */
  stopAdmission(): void { this.closing = true; this.stop(); this.taps.clear(); }
  async shutdown(): Promise<void> { this.stopAdmission(); await Promise.allSettled([...this.active]); }

  peek(workspaceId: string): OrchEvent[] {
    return [...(this.queues.get(workspaceId) ?? [])];
  }

  /** 测试用：顺带（digest）队列快照 */
  peekDigest(workspaceId: string): OrchEvent[] {
    return [...(this.digests.get(workspaceId) ?? [])];
  }

  /** Only session lifecycle signals expire with the worker; workspace risks remain actionable. */
  private sessionEventAllowed(kind: OrchEventKind, sessionId?: string, trigger?: string): boolean {
    if (!sessionId || !['phase', 'turn_end', 'turn_error', 'heartbeat_stale', 'needs_you_stale'].includes(kind)) return true;
    const session = this.deps.ctx.sessions.get(sessionId);
    if (!session || session.hidden || session.archived || !isOrchestratedWorker(session)) return false;
    // The transition to done remains observable by explicit policy/workflow taps.
    return session.phase?.value !== 'done' || (kind === 'phase' && trigger === 'done');
  }

  private clearSessionGuards(workspaceId: string, sessionId: string): void {
    this.needsYouSince.delete(sessionId);
    this.unfireGuardKeys([
      ...guardKeysToClearOnActivity(workspaceId, sessionId),
      ...guardKeysToClearOnPhase(workspaceId, sessionId, 'done')
    ]);
  }

  enqueue(partial: {
    kind: OrchEventKind;
    workspaceId: string;
    sessionId?: string;
    sessionName?: string;
    detail?: string;
    extraKey?: string;
    ts?: number;
    /** 订阅策略判定用的附加字段（kind/sessionId/phase trigger 自动填） */
    view?: Omit<PolicyEventView, 'kind'>;
    /** 是否把事件算作该会话的活动（刷新心跳）；缺省 true，订阅事实传 false */
    touchActivity?: boolean;
  }): void {
    if (this.closing) return;
    const ws = partial.workspaceId?.trim();
    if (!ws) return;
    if (!this.sessionEventAllowed(partial.kind, partial.sessionId, partial.extraKey)) return;
    const ts = partial.ts ?? this.now();
    const key = orchEventKey(partial.kind, ws, partial.sessionId, partial.extraKey);
    const event: OrchEvent = {
      id: randomUUID(),
      kind: partial.kind,
      workspaceId: ws,
      ts,
      key,
      ...(partial.sessionId ? { sessionId: partial.sessionId } : {}),
      ...(partial.sessionName ? { sessionName: partial.sessionName } : {}),
      ...(partial.detail ? { detail: partial.detail } : {})
    };
    if (partial.sessionId && partial.touchActivity !== false &&
        (partial.touchActivity === true || partial.kind === 'phase' || partial.kind === 'turn_end')) {
      this.touchActivity(ws, partial.sessionId, ts);
      this.unfireGuardKeys(guardKeysToClearOnActivity(ws, partial.sessionId));
    }
    const view: PolicyEventView = {
      kind: partial.kind,
      ...(partial.kind === 'phase' && partial.extraKey ? { trigger: partial.extraKey } : {}),
      ...(partial.sessionId ? { sessionId: partial.sessionId } : {}),
      ...partial.view
    };
    this.tap(ws, view, partial.detail);
    // 订阅策略：内置默认下纯观测（commit / turn_end / phase→done）刷新活动但不入队
    const decision = this.decide(ws, view);
    if (decision.action === 'mute') return;
    if (decision.action === 'digest') {
      this.addDigest(ws, event);
      return;
    }
    const cur = this.queues.get(ws) ?? [];
    const { queue } = enqueueOrchEvent(cur, event);
    this.queues.set(ws, queue);
    if (!this.firstAt.has(ws)) this.firstAt.set(ws, ts);
    this.lastAt.set(ws, ts);
    this.noteSituation(ws);
    this.schedule(ws);
  }

  onFlip(flip: NotifyFlipEvent): void {
    if (this.closing) return;
    const trigger = flip.trigger;
    if (trigger !== 'needs_you' && trigger !== 'done' && trigger !== 'error') return;
    const s = this.deps.ctx.sessions.get(flip.sessionId);
    // 编排关联性：与 onTurnEnd 同口径——手工会话的 needs_you/done/error 由通知系统
    // 推给人，调度对它没有简报上下文、管不了也管不着；needsYouSince/守卫键同口径不追。
    if (!s || !this.sessionEventAllowed('phase', s.id, trigger)) return;
    const ws = flip.workspaceId;
    const sid = flip.sessionId;
    if (trigger === 'needs_you') this.needsYouSince.set(sid, flip.ts);
    else this.needsYouSince.delete(sid);
    this.unfireGuardKeys(
      guardKeysToClearOnPhase(ws, sid, trigger === 'needs_you' ? 'needs_you' : 'idle')
    );
    this.enqueue({
      kind: 'phase',
      workspaceId: ws,
      sessionId: sid,
      sessionName: flip.sessionName,
      extraKey: trigger,
      ts: flip.ts,
      detail: `phase → ${trigger}`,
      view: { orchestrated: true }
    });
  }

  /**
   * 工作流进度（dynamic-workflow）：trigger=started/phase/ask/ask_human/completed/failed/interrupted/trigger_blocked。
   * 内置默认：问调度/失败/中断（属底线）与完成、触发被挡唤醒；启动、阶段、问用户（面板直答）只捎带。
   * 同 run 同 trigger 后到覆盖。
   */
  enqueueWorkflow(workspaceId: string, e: { runId: string; trigger: string; detail: string }): void {
    this.enqueue({
      kind: 'workflow',
      workspaceId,
      extraKey: `${e.runId}:${e.trigger}`,
      detail: e.detail,
      touchActivity: false,
      view: { trigger: e.trigger }
    });
  }

  onTurnEnd(sessionId: string): void {
    if (this.closing) return;
    const s = this.deps.ctx.sessions.get(sessionId);
    if (!s || !this.sessionEventAllowed('turn_end', s.id)) return;
    // 编排关联性：只报 orchestrated 会话（调度拉起/派活时自动置位，可动态改）。
    // 用户手工拉起的工作面板回合结束与编排无关，报上去纯属自噪声，会把调度反复唤醒。
    if (!isOrchestratedWorker(s)) return;
    const ws = s.workspaceId?.trim();
    if (!ws) return;
    this.enqueue({
      kind: 'turn_end',
      workspaceId: ws,
      sessionId: s.id,
      sessionName: s.name,
      detail: this.turnEndDetail(sessionId),
      view: { orchestrated: true }
    });
  }

  /**
   * O13：GUI 回合结束的 detail 附最后一条 assistant 纯文本摘要（≤120 字符，截断加 …），
   * 省调度一次 sessions.observe。空回合/无 assistant 文本省略；pty 回合结束不带尾摘要
   * （缓冲区尾噪声大，本期明确不做——lastAssistantReply 只对 GUI（chat）会话有值）。
   */
  private turnEndDetail(sessionId: string): string {
    try {
      const tail = this.deps.ctx.agentSessions?.lastAssistantReply?.(sessionId);
      const summary = tailSummary(tail?.text);
      return summary ? `Worker 回合结束：${summary}` : 'Worker 回合结束';
    } catch {
      return 'Worker 回合结束'; /* 尾摘要失败回落通用文案 */
    }
  }

  /** GUI Worker 网络/传输中止用尽续作后上报；手工会话仍不吵醒调度 */
  onTurnFailed(
    sessionId: string,
    info?: { error?: string; retryAttempts?: number }
  ): void {
    if (this.closing) return;
    const s = this.deps.ctx.sessions.get(sessionId);
    if (!s || !this.sessionEventAllowed('turn_error', s.id)) return;
    if (!isOrchestratedWorker(s)) return;
    const ws = s.workspaceId?.trim();
    if (!ws) return;
    const err = info?.error?.replace(/\s+/g, ' ').trim().slice(0, 160);
    const attempts = info?.retryAttempts ?? 0;
    const retryBit = attempts > 0 ? t('（已自动续作 {{n}} 次）', { n: attempts }) : '';
    this.enqueue({
      kind: 'turn_error',
      workspaceId: ws,
      sessionId: s.id,
      sessionName: s.name,
      extraKey: 'network',
      detail: err
        ? t('网络/传输中止：{{error}}{{retry}}', { error: err, retry: retryBit })
        : t('Worker 回合因网络中断失败{{retry}}', { retry: retryBit }),
      view: { orchestrated: true }
    });
  }

  onFsChanged(workspaceId: string, relativePaths: string[]): void {
    if (this.closing) return;
    // Shared-directory writes cannot be attributed to an individual Worker.
    const commit = relativePaths.some(isGitReflogRel);
    if (commit) {
      this.enqueue({
        kind: 'commit',
        workspaceId,
        detail: 'git reflog 更新（提交落树）'
      });
    }
  }

  onGitReflog(workspaceId: string, reflogPath?: string): void {
    if (this.closing) return;
    let detail = 'git reflog 更新（提交落树）';
    if (reflogPath) {
      try {
        const lines = fs
          .readFileSync(reflogPath, 'utf8')
          .split(/\r?\n/)
          .filter((x) => x.trim());
        const last = lines[lines.length - 1];
        detail = (last && formatReflogLine(last)) || detail;
      } catch {
        /* 读/解析失败回落通用文案 */
      }
    }
    this.enqueue({
      kind: 'commit',
      workspaceId,
      detail
    });
  }

  onSlotFreed(workspaceId: string): void {
    if (this.closing) return;
    const ws = workspaceId.trim();
    if (!ws) return;
    this.unfireGuardKeys([slotFreeKey(ws)]);
    const queued = listDelegateQueue(ws).length;
    const active = activeWorkerCount(this.deps.ctx, ws);
    const max = readMaxConcurrentWorkers(this.deps.ctx, ws);
    if (max > 0 && queued > 0 && active < max) {
      this.enqueue({
        kind: 'slot_free',
        workspaceId: ws,
        detail: `并发位释放，排队 ${queued} / 活跃 ${active} / 上限 ${max}`
      });
    }
  }

  tickGuards(): void {
    if (this.closing) return;
    if (!(this.deps.guardsEnabled?.() ?? ORCH_GUARD_DEFAULTS.enabled)) return;
    this.ensureGuardStateLoaded();
    const cfg = this.deps.ctx.config.get();
    const now = this.now();
    for (const ws of cfg.workspaces) {
      const workers = this.deps.ctx.sessions.listByWorkspace(ws.id).map((s) => {
        if (s.archived || s.phase?.value === 'done') this.clearSessionGuards(ws.id, s.id);
        const ownActivity = lastActivityAt(sessionActivityParts(s));
        if (ownActivity !== undefined && ownActivity > (this.activity.get(s.id) ?? 0)) {
          this.touchActivity(ws.id, s.id, ownActivity);
          this.unfireGuardKeys(guardKeysToClearOnActivity(ws.id, s.id));
        }
        return this.snapshotOf(s);
      });
      const thresholds = effectivePolicyGuards(this.policy(ws.id));
      const alerts = evaluateOrchGuards({
        now,
        workers,
        queuedDelegateCount: listDelegateQueue(ws.id).length,
        activeWorkers: activeWorkerCount(this.deps.ctx, ws.id),
        maxConcurrent: readMaxConcurrentWorkers(this.deps.ctx, ws.id),
        workspaceId: ws.id,
        alreadyFired: this.fired,
        ...thresholds
      });
      for (const a of alerts) {
        this.fireGuardKey(a.key, now);
        this.enqueue({
          kind: a.kind,
          workspaceId: a.workspaceId,
          sessionId: a.sessionId,
          sessionName: a.sessionName,
          detail: a.detail,
          touchActivity: false,
          ...(a.sessionId ? { view: { orchestrated: true } } : {})
        });
      }
    }
    this.persistGuardState();
  }

  /** 调度回合刚结束：若窗口已到期立即尝试 flush */
  onOrchestratorIdle(workspaceId: string): void {
    if (this.closing) return;
    const sch = nextOrchFlushDelay({
      now: this.now(),
      firstAt: this.firstAt.get(workspaceId) ?? null,
      lastAt: this.lastAt.get(workspaceId) ?? null,
      ...this.timingFor(workspaceId)
    });
    if (sch.delayMs === 0) void this.flush(workspaceId);
    else this.schedule(workspaceId);
  }

  private snapshotOf(s: SessionMeta): GuardWorkerSnapshot {
    const ws = s.workspaceId?.trim() || '';
    const busy = this.deps.ctx.agentSessions?.isBusy(s.id) === true;
    return {
      sessionId: s.id,
      sessionName: s.name,
      workspaceId: ws,
      type: s.type,
      launchKind: s.launchKind,
      lifecycle: s.lifecycle,
      runtimePresence: s.runtimePresence,
      activity: s.activity,
      orchestrated: isOrchestratedWorker(s),
      hasAssignedTask: Boolean(s.taskId || s.lifecycle === 'working'),
      phase: s.phase?.value,
      lastActivityAt: lastActivityAt([...sessionActivityParts(s), this.activity.get(s.id)]) ?? 0,
      // 收编（setOrchestrated）前就已停在 needs_you 的会话没有翻转事件、本表无值；
      // 回落相位自身时间戳，否则 needs_you_stale 守卫对它永不触发
      needsYouSince:
        this.needsYouSince.get(s.id) ??
        (s.phase?.value === 'needs_you' ? s.phase.ts : undefined),
      busy,
      archived: s.archived,
      hidden: s.hidden
    };
  }

  private touchActivity(workspaceId: string, sessionId: string, ts: number): void {
    this.ensureGuardStateLoaded();
    const prev = this.activity.get(sessionId) ?? 0;
    if (ts > prev) {
      this.activity.set(sessionId, ts);
      this.persistGuardState();
    }
    void workspaceId;
  }

  // ------------------------------------------------------------------
  // 守卫状态持久化（O3）：fired/lastActivity 内存为真源，每次实际变更落盘；
  // 启动首次使用时读入（prune 无主 key；lastActivity 同 key 取 max 防回退）。
  // ------------------------------------------------------------------

  private ensureGuardStateLoaded(): void {
    if (!this.guardStore || this.guardLoaded) return;
    this.guardLoaded = true;
    try {
      const state = this.guardStore.read();
      const aliveWs = new Set(this.deps.ctx.config.get().workspaces.map((w) => w.id));
      const aliveSids = new Set(this.deps.ctx.sessions.list().map((s) => s.id));
      const pruned = pruneGuardPersistState(state, aliveWs, aliveSids);
      for (const [key, ts] of Object.entries(pruned.fired)) {
        this.fired.add(key);
        this.firedAt.set(key, ts);
      }
      const merged = mergeLastActivityOnLoad(pruned.lastActivity, this.activity);
      for (const [sid, ts] of Object.entries(merged)) this.activity.set(sid, ts);
    } catch (err) {
      console.error('[orch-events] guard state load failed（按空状态起步，宁可重报）', err);
    }
  }

  private fireGuardKey(key: string, ts: number): void {
    this.ensureGuardStateLoaded();
    this.fired.add(key);
    this.firedAt.set(key, ts);
  }

  private unfireGuardKeys(keys: readonly string[]): void {
    let changed = false;
    for (const k of keys) {
      if (this.fired.delete(k)) {
        this.firedAt.delete(k);
        changed = true;
      }
    }
    if (changed) this.persistGuardState();
  }

  private persistGuardState(): void {
    if (this.closing) return;
    if (!this.guardStore) return;
    const fired: Record<string, number> = {};
    for (const key of this.fired) fired[key] = this.firedAt.get(key) ?? this.now();
    const lastActivity: Record<string, number> = {};
    for (const [sid, ts] of this.activity) lastActivity[sid] = ts;
    this.guardStore.write({ fired, lastActivity });
  }

  private schedule(workspaceId: string): void {
    if (this.closing) return;
    const ct = this.deps.clearTimeout ?? clearTimeout;
    const st: NonNullable<OrchPumpDeps['setTimeout']> = this.deps.setTimeout ?? setTimeout;
    const prev = this.flushTimer.get(workspaceId);
    if (prev) ct(prev);
    const sch = nextOrchFlushDelay({
      now: this.now(),
      firstAt: this.firstAt.get(workspaceId) ?? null,
      lastAt: this.lastAt.get(workspaceId) ?? null,
      ...this.timingFor(workspaceId)
    });
    if (sch.delayMs == null) return;
    const delay = Math.max(0, sch.delayMs);
    const id = st(() => {
      this.flushTimer.delete(workspaceId);
      void this.flush(workspaceId);
    }, delay);
    if (typeof id === 'object' && id && 'unref' in id) (id as NodeJS.Timeout).unref?.();
    this.flushTimer.set(workspaceId, id);
  }

  flush(workspaceId: string): Promise<'skip' | 'hold' | 'send'> {
    if (this.closing) return Promise.resolve('skip');
    const task = Promise.resolve().then(() => this.flushOwned(workspaceId));
    this.active.add(task);
    void task.then(() => this.active.delete(task), () => this.active.delete(task));
    return task;
  }

  private async flushOwned(workspaceId: string): Promise<'skip' | 'hold' | 'send'> {
    if (this.closing) return 'skip';
    if (this.sending.has(workspaceId)) return 'hold';
    const keep = (event: OrchEvent): boolean => {
      const allowed = this.sessionEventAllowed(event.kind, event.sessionId, event.kind === 'phase' ? event.key.split(':').at(-1) : undefined);
      if (!allowed && event.sessionId) this.clearSessionGuards(workspaceId, event.sessionId);
      return allowed;
    };
    const events = (this.queues.get(workspaceId) ?? []).filter(keep);
    const digest = (this.digests.get(workspaceId) ?? []).filter(keep);
    this.queues.set(workspaceId, events);
    this.digests.set(workspaceId, digest);
    const orch = this.deps.ctx.orchestrator;
    const busy = !orch || orch.isBusy(workspaceId);
    const decision = decideOrchFlush({
      enabled: this.enabled(),
      busy,
      schedulerAwaitingAnswer: hasSchedulerPendingQuestion(this.deps.ctx, workspaceId),
      events,
      digest
    });
    if (decision.action === 'skip') {
      if (decision.reason === 'empty') {
        this.queues.delete(workspaceId);
        this.firstAt.delete(workspaceId);
        this.lastAt.delete(workspaceId);
      }
      this.noteSituation(workspaceId);
      return 'skip';
    }
    if (decision.action === 'hold') {
      const st: NonNullable<OrchPumpDeps['setTimeout']> = this.deps.setTimeout ?? setTimeout;
      const prev = this.flushTimer.get(workspaceId);
      if (prev) (this.deps.clearTimeout ?? clearTimeout)(prev);
      const id = st(() => {
        this.flushTimer.delete(workspaceId);
        void this.flush(workspaceId);
      }, decision.retryMs);
      if (typeof id === 'object' && id && 'unref' in id) (id as NodeJS.Timeout).unref?.();
      this.flushTimer.set(workspaceId, id);
      return 'hold';
    }
    this.sending.add(workspaceId);
    this.queues.delete(workspaceId);
    this.digests.delete(workspaceId);
    this.firstAt.delete(workspaceId);
    this.lastAt.delete(workspaceId);
    // 窗口已收口：同任务翻转链清空，下个窗口重新聚合（send 失败时随队列一并还原）
    try {
      const text = decision.text || aggregateOrchEvents(events, digest);
      if (!text) return 'skip';
      if (!orch) return 'skip';
      await deliverAgentMessage(this.deps.ctx, { from: 'host', to: 'scheduler', workspaceId, text, idempotencyKey: 'event-batch:' + createHash('sha256').update(JSON.stringify([events, digest])).digest('hex') });
      return 'send';
    } catch (err) {
      console.error('[orch-events] flush failed', workspaceId, err);
      const cur = this.queues.get(workspaceId) ?? [];
      // F-02：还原队列过 enqueue 同款裁剪（丢最旧保 ORCH_WAKE_DEFAULTS.maxEvents），
      // 与 digest 侧 slice(-ORCH_DIGEST_MAX) 对齐——持续失败 + 事件风暴下队列不得膨胀。
      this.queues.set(workspaceId, [...events, ...cur].slice(-ORCH_WAKE_DEFAULTS.maxEvents));
      if (digest.length) {
        const curDigest = this.digests.get(workspaceId) ?? [];
        this.digests.set(workspaceId, [...digest, ...curDigest].slice(-ORCH_DIGEST_MAX));
      }
      if (!this.firstAt.has(workspaceId) && events[0]) this.firstAt.set(workspaceId, events[0].ts);
      this.schedule(workspaceId);
      return 'hold';
    } finally {
      // R-12：flush 后（send 成功 / 失败还原 / 空文本 skip）发一次态势刷新信号
      this.noteSituation(workspaceId);
      this.sending.delete(workspaceId);
    }
  }
}

/**
 * `.git` 被工作区 skip，单独盯 reflog 才能看见 commit。
 *
 * **只盯 worktrees**：隔离树的提交才是 Worker 产出信号。主仓 `.git/logs/HEAD` 不盯——
 * 用户手工提交、或调度自己代为提交，提交人本就已知，报给调度纯属自噪声。
 */
export type GitReflogWatches = (() => void) & { sync(): void; shutdown(): Promise<void> };

export function startGitReflogWatches(ctx: AppContext, pump: OrchestratorEventPump): GitReflogWatches {
  type Scope = { root: string; workspaces: Set<string>; commonWatch: fs.FSWatcher; treeWatch?: fs.FSWatcher;
    inode?: string; startupProbe?: NodeJS.Timeout };
  const scopes = new Map<string, Scope>();
  const lifetime = new WatcherLifetime();
  let stopped = false;
  const close = (scope: Scope): void => {
    clearTimeout(scope.startupProbe);
    lifetime.retire(scope.treeWatch); lifetime.retire(scope.commonWatch);
  };
  const refreshTree = (scope: Scope): void => {
    const folder = path.join(scope.root, 'worktrees');
    let inode: string | undefined;
    try { const stat = fs.statSync(folder, { bigint: true }); if (stat.isDirectory()) inode = String(stat.ino); } catch { /* not created yet */ }
    if (scope.inode === inode) return;
    lifetime.retire(scope.treeWatch); scope.treeWatch = undefined; scope.inode = inode;
    if (!inode || stopped) return;
    try {
      scope.treeWatch = lifetime.own(fs.watch(folder, { recursive: true }, (_event, filename) => {
        if (!filename || stopped) return;
        const rel = String(filename).replace(/\\/g, '/');
        if (!rel.endsWith('/logs/HEAD')) return;
        const reflog = path.join(folder, rel);
        // Shared sources can belong to several workspaces. Git's registration
        // names the checkout; attribute it to a recorded session when possible.
        let checkout: string | undefined;
        try { checkout = sourcePathKey(path.dirname(fs.readFileSync(path.join(path.dirname(path.dirname(reflog)), 'gitdir'), 'utf8').trim())); } catch { /* legacy/unowned tree */ }
        const owners = [...scope.workspaces].filter(id => ctx.sessions.listByWorkspace(id).some(session => {
          const groups = session.worktreeGroups?.groups;
          const paths = groups ? groups.flatMap(group => [group.path, ...group.repos.map(repo => path.join(group.path, repo.path))])
            : session.worktreePath ? [session.worktreePath, ...(session.worktreeRepoSet ?? []).map(repo => path.join(session.worktreePath!, repo.path))] : [];
          return checkout !== undefined && paths.some(tree => sourcePathKey(tree) === checkout);
        }));
        const workspaceId = owners.length === 1 ? owners[0] : scope.workspaces.size === 1 ? [...scope.workspaces][0] : undefined;
        if (workspaceId) pump.onGitReflog(workspaceId, reflog);
      }));
      scope.treeWatch.on('error', error => { console.warn('[reflog] worktree watch failed', folder, error); lifetime.retire(scope.treeWatch); scope.treeWatch = undefined; scope.inode = undefined; });
    } catch (error) { scope.inode = undefined; console.warn('[reflog] worktree watch unavailable', folder, error); }
  };
  const sync = (): void => {
    if (stopped) return;
    const desired = new Map<string, { root: string; workspaces: Set<string> }>();
    const config = ctx.config.get();
    for (const workspace of config.workspaces) {
      if (workspace.rootsError) continue;
      const roots = sourceRootsFor(workspace).map(root => root.path);
      for (const session of ctx.sessions.listByWorkspace(workspace.id)) {
        if (session.worktreeGroups) for (const group of session.worktreeGroups.groups) {
          if (group.source) roots.push(group.source.mainRepo, ...group.repos.map(repo => path.join(group.source!.mainRepo, repo.path)));
        } else if (session.worktreeSource) roots.push(session.worktreeSource.mainRepo,
          ...(session.worktreeRepoSet ?? []).map(repo => path.join(session.worktreeSource!.mainRepo, repo.path)));
      }
      for (const repo of roots) {
        const dirs = readGitDirectories(repo); if (!dirs) continue;
        // Open both native watches on the same physical path used for deduplication.
        // macOS FSEvents can miss the initial directory creation through an alias.
        let root: string;
        try { root = fs.realpathSync.native(dirs.commonDir); }
        catch (error) { console.warn('[reflog] common-dir path unavailable', dirs.commonDir, error); continue; }
        const key = pathKey(root), entry = desired.get(key) ?? { root, workspaces: new Set<string>() };
        entry.workspaces.add(workspace.id); desired.set(key, entry);
      }
    }
    for (const [key, scope] of scopes) if (!desired.has(key)) { close(scope); scopes.delete(key); }
    for (const [key, entry] of desired) {
      const existing = scopes.get(key);
      let scope = existing;
      if (!scope) {
        try {
          // Shallow common-dir watch catches first creation/recreation of worktrees
          // without recursively watching Git objects or the source directory.
          const commonWatch = lifetime.own(fs.watch(entry.root, (_event, name) => { if (!stopped && (!name || String(name) === 'worktrees')) { const current = scopes.get(key); if (current) refreshTree(current); } }));
          commonWatch.on('error', error => console.warn('[reflog] common-dir watch failed', entry.root, error));
          scope = { ...entry, commonWatch }; scopes.set(key, scope);
        } catch (error) { console.warn('[reflog] common-dir watch unavailable', entry.root, error); continue; }
      }
      scope.workspaces = entry.workspaces; refreshTree(scope);
      if (!existing && !scope.treeWatch) {
        // A directory created while the native watcher is starting may not emit a rename event.
        const opened = scope;
        opened.startupProbe = setTimeout(() => {
          opened.startupProbe = undefined;
          if (scopes.get(key) === opened) refreshTree(opened);
        }, 100);
        opened.startupProbe.unref();
      }
    }
  };
  const offLifecycle = ctx.sessions.onLifecycle?.(() => sync());
  const offRemoved = ctx.sessions.onSessionRemoved?.(() => sync());
  const dispose = Object.assign(() => { if (stopped) return; stopped = true; offLifecycle?.(); offRemoved?.(); for (const scope of scopes.values()) close(scope); scopes.clear(); }, { sync, shutdown: async () => { dispose(); await lifetime.shutdown(); } });
  sync(); return dispose;
}
