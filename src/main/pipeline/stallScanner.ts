/**
 * 宿主后台扫描活跃 Worker：verdict 翻转入 stalled 时 recordFact + 订阅推送。
 * 仅对活跃 Worker 推送；复用 judgePipelineWorker；同停滞段去重；
 * 只观察会话自身活动，不用共享目录/Git 写入给 Worker 续心跳。
 */
import type { AppContext } from '../context';
import { dispatchRuntimeFacts } from '../awareness/dispatch';
import { projectPipelineVerdictEvent } from '../../shared/runtimeFactsQuery';
import {
  applyStallScanAction,
  decideStallScanAction,
  pruneStallEpochs,
  type StallEpochState
} from '../../shared/pipelineStallScan';
import {
  isPipelineActiveWorker,
  judgePipelineWorker,
  lastActivityAt,
  normalizePipelineStallMs,
  normalizePipelineStallScanMs,
  sessionActivityParts,
  type PipelineWorkerFacts
} from '../../shared/pipelineStatus';
import type { RuntimeFact } from '../../shared/runtimeFacts';
import type { SessionMeta } from '../../shared/types';

export interface PipelineStallScannerDeps {
  ctx: AppContext;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (id: ReturnType<typeof setInterval>) => void;
}

export interface StallScanTickResult {
  skipped?: boolean;
  facts: RuntimeFact[];
  errors: string[];
  scanned: number;
}

export class PipelineStallScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active?: Promise<StallScanTickResult>;
  private closing = false;
  readonly epochs = new Map<string, StallEpochState>();
  constructor(private deps: PipelineStallScannerDeps) {}

  start(): void {
    if (this.closing) throw new Error('Pipeline stall scanner is stopping');
    this.stop();
    const ms = normalizePipelineStallScanMs(this.deps.ctx.config.get().pipeline?.stallScanMs);
    const si = this.deps.setInterval ?? setInterval;
    this.timer = si(() => {
      void this.scanOnce().catch((err: unknown) => {
        console.warn('[pipeline-stall] scan failed', err);
      });
    }, ms);
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      (this.timer as NodeJS.Timeout).unref?.();
    }
  }

  stop(): void {
    if (this.timer == null) return;
    const ci = this.deps.clearInterval ?? clearInterval;
    ci(this.timer);
    this.timer = null;
  }

  stopAdmission(): void { this.closing = true; this.stop(); }
  async shutdown(): Promise<void> { this.stopAdmission(); await this.active; }

  scanOnce(now = this.now()): Promise<StallScanTickResult> {
    if (this.active || this.closing) return Promise.resolve({ skipped: true, facts: [], errors: [], scanned: 0 });
    const pending = Promise.resolve().then(() => this.closing
      ? { skipped: true, facts: [], errors: [], scanned: 0 } : this.scan(now)); this.active = pending;
    void pending.then(() => { if (this.active === pending) this.active = undefined; }, () => { if (this.active === pending) this.active = undefined; });
    return pending;
  }

  private async scan(now: number): Promise<StallScanTickResult> {
    const facts: RuntimeFact[] = [];
    const errors: string[] = [];
    try {
      const stallMs = normalizePipelineStallMs(this.deps.ctx.config.get().pipeline?.stallMs);
      const sessions = this.deps.ctx.sessions.list();
      const workers = sessions.filter(isPipelineActiveWorker);
      pruneStallEpochs(
        this.epochs,
        workers.map((s) => s.id)
      );
      // F-04：整体消失的会话连持久停滞段一并清；仅在册不活跃的保留（防名单抖动误清去重状态）
      this.deps.ctx.awareness?.pruneStallEpochs(sessions.map((s) => s.id));
      for (const s of workers) {
        if (this.closing) break;
        try {
          const fact = await this.scanWorker(s, now, stallMs);
          if (fact) facts.push(fact);
        } catch (err) {
          const msg = `${s.id}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(msg);
          console.warn('[pipeline-stall] worker failed', msg);
        }
      }
      return { facts, errors, scanned: workers.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      console.warn('[pipeline-stall] tick failed', err);
      return { facts, errors, scanned: 0 };
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async scanWorker(
    candidate: SessionMeta,
    now: number,
    stallMs: number
  ): Promise<RuntimeFact | null> {
    // A previous worker's notification delivery may have awaited. Read the current
    // session again; no await/foreign IO between this snapshot and recording the fact.
    const s = this.deps.ctx.sessions.list().find(row => row.id === candidate.id);
    if (!s || !isPipelineActiveWorker(s)) { this.epochs.delete(candidate.id); return null; }
    const store = this.deps.ctx.awareness;
    if (!store) return null;
    // F-04：去重种子走持久停滞段 map，与滚动事实账本解耦——账本按 400 条/128KB 滚动
    // 淘汰，末条 stalled 事实被挤出曾导致同一停滞段重复写事件并重复推送。
    // 持久段按运行时实例（runtimeStartedAt）限定：重启后是新停滞段，不沿用旧段。
    const persisted = store.getStallEpoch(s.id);
    // A dormant row is not a recovery event for the historical process.
    if (s.runtimePresence === 'dormant' || s.runtimePresence === 'starting') { this.epochs.delete(s.id); return null; }
    if (persisted && persisted.runtimeStartedAt === (s.runtimeStartedAt ?? null)) {
      this.epochs.set(s.id, { lastActivityAt: persisted.lastActivityAt });
    } else this.epochs.delete(s.id);
    const facts: PipelineWorkerFacts = {
      type: s.type,
      launchKind: s.launchKind,
      runtimePresence: s.runtimePresence,
      activity: s.activity,
      busy: this.deps.ctx.agentSessions?.isBusy(s.id) === true,
      phase: s.phase?.value,
      lifecycle: s.lifecycle,
      archived: s.archived,
      lastActivityAt: lastActivityAt(sessionActivityParts(s)),
      uncommittedCount: 0,
      aheadCount: 0,
      canFastForward: false,
      dirtyOverlap: false,
      hasWorktree: Boolean(s.worktreePath),
      queuedInjects: s.queuedInjects ?? 0
    };
    const verdict = judgePipelineWorker(facts, now, { stallMs });
    const action = decideStallScanAction(this.epochs.get(s.id), verdict.kind, facts.lastActivityAt);
    if (action.type === 'skip') return null;
    // 扫描器不收集 git 字段（ahead/uncommitted 恒 0）：needs_you 会判出依赖 git 的
    // mergeBlocked（如 no_ahead），与真实 ahead 无关，不能推给调度。扫描推送只陈述
    // 停滞状态变化——git 相关 verdict 降级为中性 working（真实合入判定走 sessions.observe）。
    const gitDerived = verdict.kind === 'mergeBlocked' || verdict.kind === 'readyToMerge';
    const fact = projectPipelineVerdictEvent({
      sessionId: s.id,
      workspaceId: s.workspaceId,
      name: s.name,
      kind: gitDerived ? 'working' : verdict.kind,
      mergeBlocked: gitDerived ? undefined : verdict.mergeBlocked,
      lastActivityAt: facts.lastActivityAt,
      runtimeStartedAt: s.runtimeStartedAt,
      recovered: action.type === 'recover',
      ts: now
    });
    store.recordFact(fact);
    applyStallScanAction(this.epochs, s.id, action);
    // F-04：停滞段状态同步进持久 map（enter 记段 / recover 清段），
    // 去重不再依赖刚写的 stalled 事实能否在滚动账本里活到下一轮
    if (action.type === 'enter') {
      store.setStallEpoch(s.id, {
        lastActivityAt: action.lastActivityAt,
        runtimeStartedAt: s.runtimeStartedAt ?? null
      });
    } else if (action.type === 'recover') {
      store.setStallEpoch(s.id, undefined);
    }
    try {
      await dispatchRuntimeFacts(this.deps.ctx, [fact]);
    } catch (err) {
      console.warn('[pipeline-stall] dispatch failed', s.id, err);
    }
    return fact;
  }
}
