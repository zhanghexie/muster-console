import { randomUUID } from 'node:crypto';
import type { Store } from '../store';
import type { QuotaSample } from '../../shared/llmQuota';
import {
  dropFutureUsageDays,
  emptyUsageDay,
  normalizeUsageDays,
  normalizeUsageLlmCalls,
  pruneUsageLlmCalls,
  usageDayKey,
  type UsageActiveSession,
  type UsageToolFailure,
  type UsageDay,
  type UsageDays,
  type UsageLlmCall,
  type UsageLlmCallRow,
  type UsageLlmExtStat
} from '../../shared/usageStats';

export interface RecordExtLlmCallArgs {
  extId: string;
  model?: string;
  messages: UsageLlmCall['messages'];
  maxTokens: number;
  temperature: number;
  ok: boolean;
  text?: string;
  error?: string;
  durationMs: number;
  startedAt?: number;
}

/**
 * 错误文本脱敏链（usage-stats F-01）：屏蔽错误文本中常见的凭据形式。
 * recordToolCall 与 recordExtLlmCall 共用——扩展 LLM 调用失败的错误串（LLM SDK/
 * 网关原文，可能含请求 URL、上游回显的 key 片段）落 usage-llm-calls.json 前同样
 * 过滤，两类明细不再双口径。
 */
function redactErrorText(raw: string): string {
  return raw
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [REDACTED]')
    // 先处理带引号的完整值，避免带空格或转义字符的凭据只被遮掉一半。
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|authorization|password)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, '$1"[REDACTED]"')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|authorization|password)["']?\s*[=:]\s*)(?!["'])[^\r\n,;&]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 2000);
}

/**
 * 使用统计服务：主进程各埋点（会话创建 / 调度回合 / 能力调用 / 无头运行 / LLM 读屏 / 扩展 LLM）
 * 的统一计数入口。按本地日分桶，计数永久落盘 userData/usage-stats.json；
 * 调用明细（参数/返回）另存 usage-llm-calls.json，只留近 30 天、上限 1000 条。
 * 埋点只做内存自增 + 排队写盘，绝不抛错影响业务路径。
 */
export class UsageStatsService {
  private days: UsageDays;
  private llmCalls: UsageLlmCall[];
  private toolFailures: UsageToolFailure[] = [];
  private modelCalls: QuotaSample[] = [];

  constructor(private store: Store) {
    const now = Date.now();
    const failures = store.loadUsageToolFailures?.();
    this.toolFailures = this.pruneToolFailures(Array.isArray(failures) ? failures : []);
    try { store.saveUsageToolFailures?.(this.toolFailures); } catch { /* 统计不影响启动 */ }
    this.days = dropFutureUsageDays(normalizeUsageDays(store.loadUsageStats()), now);
    this.llmCalls = pruneUsageLlmCalls(normalizeUsageLlmCalls(store.loadUsageLlmCalls()), now);
  }

  private today(): UsageDay {
    const key = usageDayKey(Date.now());
    let day = this.days[key];
    if (!day) {
      day = emptyUsageDay();
      this.days[key] = day;
    }
    return day;
  }

  private persistDays(): void {
    try {
      this.store.saveUsageStats(this.days);
    } catch {
      /* 统计落盘失败不影响业务 */
    }
  }

  private persistLlmCalls(): void {
    try {
      this.store.saveUsageLlmCalls(this.llmCalls);
    } catch {
      /* 明细落盘失败不影响业务 */
    }
  }

  recordSessionCreated(kind: 'agent' | 'shell', runtime?: string): void {
    const day = this.today();
    if (kind === 'shell') {
      day.shellSessions += 1;
    } else {
      day.agentSessions += 1;
      const key = runtime?.trim() || 'unknown';
      day.sessionsByRuntime[key] = (day.sessionsByRuntime[key] ?? 0) + 1;
    }
    this.persistDays();
  }

  recordDispatchTurn(): void {
    this.today().dispatchTurns += 1;
    this.persistDays();
  }

  recordGuiWorkerSend(): void {
    this.today().guiWorkerSends += 1;
    this.persistDays();
  }

  recordSessionActivity(id: string, info: Omit<UsageActiveSession, 'lastActiveAt'>): void {
    const day = this.today();
    const active = day.activeSessions ??= {};
    active[id] = { ...info, lastActiveAt: Date.now() };
    this.persistDays();
  }

  private pruneToolFailures(rows: UsageToolFailure[]): UsageToolFailure[] {
    const now = Date.now();
    const cutoff = now - 30 * 86400000;
    return rows.filter(r => r && typeof r.id === 'string' && typeof r.name === 'string'
      && typeof r.error === 'string' && Number.isFinite(r.at) && r.at >= cutoff && r.at <= now)
      .sort((a, b) => b.at - a.at).slice(0, 1000)
      .map(r => ({ id: r.id, name: r.name, at: r.at, error: r.error.slice(0, 2000), cancelled: !!r.cancelled }));
  }

  getToolFailures(fromKey: string, toKey: string): UsageToolFailure[] {
    const kept = this.pruneToolFailures(this.toolFailures);
    if (kept.length !== this.toolFailures.length) {
      try { this.store.saveUsageToolFailures?.(kept); } catch { /* 统计不影响查询 */ }
    }
    this.toolFailures = kept;
    return this.toolFailures.filter(r => { const key = usageDayKey(r.at); return key >= fromKey && key <= toKey; })
      .map(r => ({ ...r }));
  }

  recordToolCall(name: string, ok: boolean, detail?: { error?: string; cancelled?: boolean }): void {
    const day = this.today();
    day.toolCalls[name] = (day.toolCalls[name] ?? 0) + 1;
    if (!ok) {
      day.toolErrors[name] = (day.toolErrors[name] ?? 0) + 1;
      // 不保存参数或结果；错误文本过共用脱敏链（见 redactErrorText）。
      const error = redactErrorText(
        detail?.error || (detail?.cancelled ? '已取消' : '调用失败，未提供原因')
      );
      this.toolFailures = this.pruneToolFailures([{ id: randomUUID(), name, at: Date.now(), error,
        cancelled: !!detail?.cancelled }, ...this.toolFailures]);
      try { this.store.saveUsageToolFailures?.(this.toolFailures); } catch { /* 不影响能力执行 */ }
    }
    this.persistDays();
  }

  recordHeadlessRun(ok: boolean): void {
    const day = this.today();
    day.headlessRuns += 1;
    if (ok) day.headlessOk += 1;
    else day.headlessError += 1;
    this.persistDays();
  }

  recordScreenRead(): void {
    this.today().screenReads += 1;
    this.persistDays();
  }

  recordExtLlmCall(args: RecordExtLlmCallArgs): void {
    const now = Date.now();
    const day = this.today();
    day.extLlmCalls += 1;
    if (!args.ok) day.extLlmErrors += 1;
    const extKey = args.extId.trim() || 'unknown';
    day.extLlmByExt[extKey] = (day.extLlmByExt[extKey] ?? 0) + 1;
    this.persistDays();

    const entry: UsageLlmCall = {
      id: randomUUID().slice(0, 12),
      startedAt: args.startedAt && args.startedAt > 0 ? args.startedAt : now - Math.max(0, args.durationMs),
      durationMs: Math.max(0, Math.floor(args.durationMs)),
      ok: args.ok,
      extId: extKey,
      model: args.model?.trim() || undefined,
      messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      text: args.text,
      // F-01：扩展 LLM 错误串落盘前过共用脱敏链（Bearer/键值对/sk- 前缀），截断 2000
      error: args.error ? redactErrorText(args.error) : undefined
    };
    this.llmCalls = pruneUsageLlmCalls([entry, ...this.llmCalls], now);
    this.persistLlmCalls();
  }

  /** 全部日桶（副本，IPC 汇总用） */
  getDays(): UsageDays {
    return JSON.parse(JSON.stringify(this.days)) as UsageDays;
  }

  /** Worker 引擎每次模型请求的轻量观测；不污染扩展计数、不保存正文。 */
  recordModelCall(sample: QuotaSample): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.modelCalls = [...this.modelCalls.filter(s => s.startedAt >= cutoff), { ...sample }].slice(-10000);
  }

  peekModelCalls(): QuotaSample[] {
    return this.modelCalls.map(s => ({ ...s }));
  }

  /** R11：近窗失败率用（不含 messages 正文） */
  peekLlmCalls(): Array<Pick<UsageLlmCall, 'ok' | 'error' | 'startedAt' | 'model'>> {
    return this.llmCalls.map((c) => ({
      ok: c.ok,
      error: c.error,
      startedAt: c.startedAt,
      model: c.model
    }));
  }

  /** 单条调用明细（展开详情用；不在保留窗口内的返回 null） */
  getLlmCall(id: string): UsageLlmCall | null {
    return pruneUsageLlmCalls(this.llmCalls, Date.now()).find((c) => c.id === id) ?? null;
  }

  /** 范围内明细分页（倒序；行轻量化不带完整 messages，降轮询载荷） */
  getLlmCallsRange(
    fromKey: string,
    toKey: string,
    offset = 0,
    limit = 100
  ): { rows: UsageLlmCallRow[]; total: number } {
    const inRange = pruneUsageLlmCalls(this.llmCalls, Date.now()).filter((c) => {
      const key = usageDayKey(c.startedAt);
      return key >= fromKey && key <= toKey;
    });
    const rows = inRange.slice(offset, offset + limit).map((c) => {
      const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
      const previewRaw = c.error ?? c.text ?? lastUser?.content ?? '';
      const flat = previewRaw.replace(/\s+/g, ' ').trim();
      const preview = flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
      return {
        id: c.id,
        startedAt: c.startedAt,
        durationMs: c.durationMs,
        ok: c.ok,
        extId: c.extId,
        model: c.model,
        maxTokens: c.maxTokens,
        temperature: c.temperature,
        preview
      };
    });
    return { rows, total: inRange.length };
  }

  /** 范围内按扩展聚合（次数/失败/平均时长；明细只保留 30 天，更早调用不在内） */
  getLlmByExtRange(fromKey: string, toKey: string): UsageLlmExtStat[] {
    const inRange = pruneUsageLlmCalls(this.llmCalls, Date.now()).filter((c) => {
      const key = usageDayKey(c.startedAt);
      return key >= fromKey && key <= toKey;
    });
    const byExt = new Map<string, UsageLlmExtStat & { durSum: number; durCount: number }>();
    for (const c of inRange) {
      let stat = byExt.get(c.extId);
      if (!stat) {
        stat = { extId: c.extId, calls: 0, errors: 0, durSum: 0, durCount: 0 };
        byExt.set(c.extId, stat);
      }
      stat.calls += 1;
      if (!c.ok) stat.errors += 1;
      stat.durSum += c.durationMs;
      stat.durCount += 1;
    }
    const out = [...byExt.values()].map(({ durSum, durCount, ...stat }) => ({
      ...stat,
      avgDurationMs: durCount ? Math.round(durSum / durCount) : undefined
    }));
    out.sort((a, b) => b.calls - a.calls || a.extId.localeCompare(b.extId));
    return out;
  }
}
