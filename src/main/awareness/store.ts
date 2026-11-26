import { userDataStorage } from '../runtimeKernel/storageRootResolver';
/**
 * 运行时状态流落盘：状态共享栏 + 合入等事件账本 + 内置订阅。
 * 路径在 userData，不进 git。会话关闭由 SessionsService 调 clearShare / clearSubscriptions。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomicSync } from '../atomicJson';
import {
  evictFactEvents,
  orchestratorSessionId,
  type RuntimeFact,
  type SessionShareEntry
} from '../../shared/runtimeFacts';
import { projectIntegrateFact, type IntegrateEventInput } from '../../shared/runtimeFactsQuery';
import {
  buildOrchestratorDefaultQuery,
  emptySubscribeLedger,
  FACT_SUBSCRIBE_MAX_PER_SESSION,
  isSuppressedFactKind,
  planOrchestratorDefaultSubscriptions,
  type FactSubscription,
  type OrchestratorDefaultPlanReason,
  type SubscribeRateLedger
} from '../../shared/runtimeFactsSubscribe';



/** 停滞段去重状态（F-04）：持久保存，与可被 400 条/128KB 淘汰的滚动事实账本解耦 */
export interface StallEpochRecord {
  /** 进入 stalled 时的 lastActivityAt（停滞段身份） */
  lastActivityAt: number;
  /** 进入时所在的运行时实例；重启后不沿用旧段（新实例是新停滞段） */
  runtimeStartedAt: number | null;
}

interface AwarenessFile {
  shares: Record<string, SessionShareEntry>;
  facts: RuntimeFact[];
  subscriptions: Record<string, FactSubscription>;
  /** 调度默认集已播种：`orchestrator:<wsId>` → 播种时间。退订后不复活。 */
  defaultSeeded: Record<string, number>;
  /** 停滞段去重：sessionId → 进入 stalled 时的 epoch（与滚动账本解耦，防淘汰后重复推送） */
  stallEpochs: Record<string, StallEpochRecord>;
}

function emptyFile(): AwarenessFile {
  return { shares: {}, facts: [], subscriptions: {}, defaultSeeded: {}, stallEpochs: {} };
}

export class RuntimeAwarenessStore {
  private readonly file: string;
  private data: AwarenessFile;
  /** 防抖/限频账本：内存持有，重启清零（小时窗） */
  readonly rateLedger: SubscribeRateLedger = emptySubscribeLedger();

  constructor(userDataDir: string) {
    this.file = userDataStorage(userDataDir).file('runtime-awareness');
    this.data = this.read();
  }

  private read(): AwarenessFile {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AwarenessFile>;
      const shares =
        parsed.shares && typeof parsed.shares === 'object' && !Array.isArray(parsed.shares)
          ? parsed.shares
          : {};
      const facts = Array.isArray(parsed.facts) ? parsed.facts.filter(isFactShape).filter(f => f.kind !== ('tasks.state' as never)) : [];
      const subscriptions =
        parsed.subscriptions && typeof parsed.subscriptions === 'object' && !Array.isArray(parsed.subscriptions)
          ? Object.fromEntries(
              Object.entries(parsed.subscriptions).filter(([, s]) => isSubscriptionShape(s) &&
                // tasks.state 已下线；session.activity/lifecycle 已收敛出订阅面（事件不再投递）——
                // 沿用同一加载清理模式，落盘里显式订了这些 kind 的订阅启动时清掉
                !s.query.kinds?.some((k) => k === ('tasks.state' as never) || isSuppressedFactKind(k)))
            )
          : {};
      const defaultSeeded = parseDefaultSeeded(parsed.defaultSeeded);
      const stallEpochs = parseStallEpochs(parsed.stallEpochs);
      return { shares, facts: evictFactEvents(facts), subscriptions, defaultSeeded, stallEpochs };
    } catch (err) {
      // F-07：损坏/截断静默回空会让共享栏、订阅、事实账本「无声消失」，且下一次
      // persist 会以空文件覆盖原文件——先把原文件改名保留 .bad 留诊断线索再按空启动
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.preserveCorruptFile(err);
      return emptyFile();
    }
  }

  /** 解析失败保留现场：原文件改名 *.bad（带时间戳防覆盖旧证据），新数据落干净文件 */
  private preserveCorruptFile(err: unknown): void {
    const bad = `${this.file}.${new Date().toISOString().replace(/[:.]/g, '-')}.bad`;
    try {
      fs.renameSync(this.file, bad);
      console.error(
        `[awareness] runtime-awareness.json 解析失败，已保留原文件为 ${path.basename(bad)}，按空数据启动:`,
        err instanceof Error ? err.message : err
      );
    } catch (renameErr) {
      console.error('[awareness] runtime-awareness.json 解析失败，且备份保留失败，按空数据启动:', err, renameErr);
    }
  }

  private persist(): void {
    writeJsonAtomicSync(this.file, this.data);
  }

  listShare(): SessionShareEntry[] {
    return Object.values(this.data.shares).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getShare(sessionId: string): SessionShareEntry | undefined {
    return this.data.shares[sessionId];
  }

  setShare(entry: SessionShareEntry): SessionShareEntry {
    if (!entry.text) {
      delete this.data.shares[entry.sessionId];
      this.persist();
      return { ...entry, text: '' };
    }
    this.data.shares[entry.sessionId] = entry;
    this.persist();
    return entry;
  }

  /** 会话关闭即删 */
  clearShare(sessionId: string): boolean {
    if (!this.data.shares[sessionId]) return false;
    delete this.data.shares[sessionId];
    this.persist();
    return true;
  }

  pruneShares(aliveSessionIds: Iterable<string>): string[] {
    const alive = new Set(aliveSessionIds);
    const removed: string[] = [];
    for (const id of Object.keys(this.data.shares)) {
      if (!alive.has(id)) {
        delete this.data.shares[id];
        removed.push(id);
      }
    }
    if (removed.length) this.persist();
    return removed;
  }

  /** F-04：读取某会话的持久停滞段（去重种子），无则 undefined */
  getStallEpoch(sessionId: string): StallEpochRecord | undefined {
    const rec = this.data.stallEpochs[sessionId];
    return rec ? { ...rec } : undefined;
  }

  /**
   * F-04：写/清某会话的持久停滞段。undefined=清（恢复或运行时更替后不再沿用）。
   * 值不变时不重复落盘（扫描每轮都会写同值）。
   */
  setStallEpoch(sessionId: string, epoch: StallEpochRecord | undefined): void {
    if (!epoch) {
      if (this.data.stallEpochs[sessionId] === undefined) return;
      delete this.data.stallEpochs[sessionId];
      this.persist();
      return;
    }
    const cur = this.data.stallEpochs[sessionId];
    if (
      cur &&
      cur.lastActivityAt === epoch.lastActivityAt &&
      cur.runtimeStartedAt === epoch.runtimeStartedAt
    ) {
      return;
    }
    this.data.stallEpochs[sessionId] = { ...epoch };
    this.persist();
  }

  /** F-04：会话已整体消失的停滞段清掉（不在活跃 Worker 名单但仍在册的保留，防名单抖动误清） */
  pruneStallEpochs(aliveSessionIds: Iterable<string>): string[] {
    const alive = new Set(aliveSessionIds);
    const removed: string[] = [];
    for (const id of Object.keys(this.data.stallEpochs)) {
      if (!alive.has(id)) {
        delete this.data.stallEpochs[id];
        removed.push(id);
      }
    }
    if (removed.length) this.persist();
    return removed;
  }

  listFacts(): RuntimeFact[] {
    return this.data.facts.slice();
  }

  recordFact(fact: RuntimeFact): RuntimeFact {
    this.data.facts = evictFactEvents([...this.data.facts, fact]);
    this.persist();
    return fact;
  }

  recordIntegrate(ev: IntegrateEventInput): RuntimeFact {
    return this.recordFact(projectIntegrateFact(ev));
  }

  listSubscriptions(subscriberSessionId?: string): FactSubscription[] {
    const all = Object.values(this.data.subscriptions);
    if (!subscriberSessionId) return all.slice();
    return all.filter((s) => s.subscriberSessionId === subscriberSessionId);
  }

  getSubscription(id: string): FactSubscription | undefined {
    return this.data.subscriptions[id];
  }

  addSubscription(input: {
    subscriberSessionId: string;
    query: FactSubscription['query'];
    id?: string;
    createdAt?: number;
  }): FactSubscription | { ok: false; code: 'limit' } {
    const mine = this.listSubscriptions(input.subscriberSessionId);
    if (mine.length >= FACT_SUBSCRIBE_MAX_PER_SESSION) return { ok: false, code: 'limit' };
    const entry: FactSubscription = {
      id: input.id ?? `sub-${randomUUID()}`,
      subscriberSessionId: input.subscriberSessionId,
      query: input.query,
      createdAt: input.createdAt ?? Date.now()
    };
    this.data.subscriptions[entry.id] = entry;
    this.persist();
    return entry;
  }

  /** 只删自己的。返回 false=不存在或不是自己的。 */
  removeSubscription(id: string, actorSessionId: string): boolean {
    const cur = this.data.subscriptions[id];
    if (!cur || cur.subscriberSessionId !== actorSessionId) return false;
    delete this.data.subscriptions[id];
    this.persist();
    return true;
  }

  clearSubscriptions(sessionId: string): number {
    let n = 0;
    for (const [id, s] of Object.entries(this.data.subscriptions)) {
      if (s.subscriberSessionId === sessionId) {
        delete this.data.subscriptions[id];
        n++;
      }
    }
    if (n) this.persist();
    return n;
  }

  pruneSubscriptions(aliveSessionIds: Iterable<string>): string[] {
    const alive = new Set(aliveSessionIds);
    const removed: string[] = [];
    for (const [id, s] of Object.entries(this.data.subscriptions)) {
      if (!alive.has(s.subscriberSessionId)) {
        delete this.data.subscriptions[id];
        removed.push(id);
      }
    }
    if (removed.length) this.persist();
    return removed;
  }

  isDefaultSeeded(subscriberSessionId: string): boolean {
    return typeof this.data.defaultSeeded[subscriberSessionId] === 'number';
  }

  /**
   * 调度合成 id 首次出现时挂默认订阅集。已播种则不再补（退订不复活）；
   * 未播种时对已有等价订阅跳过（幂等）。Worker 会话不会走到这里。
   */
  ensureOrchestratorDefaults(
    workspaceId: string,
    now = Date.now()
  ): { added: FactSubscription[]; reason: OrchestratorDefaultPlanReason | 'empty' } {
    const ws = workspaceId.trim();
    const orchId = orchestratorSessionId(ws);
    if (!orchId) return { added: [], reason: 'empty' };
    const existing = this.listSubscriptions(orchId);
    const seeded = this.isDefaultSeeded(orchId);
    const plan = planOrchestratorDefaultSubscriptions({
      subscriberSessionId: orchId,
      workspaceId: ws,
      existing,
      seeded
    });
    const added: FactSubscription[] = [];
    let allAdded = true;
    for (const kind of plan.kindsToAdd) {
      const entry = this.addSubscription({
        subscriberSessionId: orchId,
        query: buildOrchestratorDefaultQuery(kind, ws),
        createdAt: now
      });
      if ('ok' in entry && entry.ok === false) {
        // 撞订阅上限：没加全不能标 seeded——否则默认集永久残缺、退订也不复活
        allAdded = false;
        break;
      }
      if ('id' in entry) added.push(entry);
    }
    if (!seeded && allAdded) {
      this.data.defaultSeeded[orchId] = now;
      this.persist();
    }
    return { added, reason: plan.reason };
  }
}

function isFactShape(v: unknown): v is RuntimeFact {
  if (!v || typeof v !== 'object') return false;
  const f = v as RuntimeFact;
  return typeof f.id === 'string' && typeof f.kind === 'string' && typeof f.ts === 'number';
}

function parseDefaultSeeded(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && k && typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function parseStallEpochs(raw: unknown): Record<string, StallEpochRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, StallEpochRecord> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const rec = v as Partial<StallEpochRecord> | null;
    const startedOk = rec?.runtimeStartedAt === null || typeof rec?.runtimeStartedAt === 'number';
    if (
      typeof k === 'string' &&
      k &&
      rec &&
      typeof rec === 'object' &&
      typeof rec.lastActivityAt === 'number' &&
      Number.isFinite(rec.lastActivityAt) &&
      startedOk
    ) {
      out[k] = { lastActivityAt: rec.lastActivityAt, runtimeStartedAt: rec.runtimeStartedAt! };
    }
  }
  return out;
}

function isSubscriptionShape(v: unknown): v is FactSubscription {
  if (!v || typeof v !== 'object') return false;
  const s = v as FactSubscription;
  return (
    typeof s.id === 'string' &&
    typeof s.subscriberSessionId === 'string' &&
    !!s.query &&
    typeof s.query === 'object' &&
    typeof s.createdAt === 'number'
  );
}
