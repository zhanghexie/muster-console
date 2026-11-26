/**
 * 使用统计：主进程埋点计数（按本地日分桶），渲染层「使用统计」面板展示。
 * 纯函数 + 类型，主/渲染共用；禁止碰 process。
 */

export interface UsageActiveSession {
  name: string;
  runtime: string;
  workspaceId: string;
  lastActiveAt: number;
}
export interface UsageToolFailure {
  id: string;
  name: string;
  at: number;
  error: string;
  cancelled: boolean;
}

export function normalizeActiveSessions(raw: unknown): Record<string, UsageActiveSession> {
  const out: Record<string, UsageActiveSession> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as UsageActiveSession;
    if (typeof v.lastActiveAt !== 'number' || !Number.isFinite(v.lastActiveAt)) continue;
    out[id] = { name: typeof v.name === 'string' ? v.name : id,
      runtime: typeof v.runtime === 'string' ? v.runtime : 'unknown',
      workspaceId: typeof v.workspaceId === 'string' ? v.workspaceId : '', lastActiveAt: v.lastActiveAt };
  }
  return out;
}

/** 单日计数桶（key = YYYY-MM-DD，本地时区） */
export interface UsageDay {
  /** 有实际交互的会话，按 ID 去重；旧桶缺省为空。 */
  activeSessions?: Record<string, UsageActiveSession>;
  /** Agent 工作面板会话数（terminal launchKind=agent，含 GUI chat surface） */
  agentSessions: number;
  /** 本机 Shell 终端数 */
  shellSessions: number;
  /** Agent 会话按 runtime 细分 */
  sessionsByRuntime: Record<string, number>;
  /** 调度 Agent 执行回合数（send / 排队续发 / 重试都算一回合） */
  dispatchTurns: number;
  /** GUI Worker（chat surface）用户消息数（UI 发起） */
  guiWorkerSends: number;
  /** 壳层能力调用次数（executeTool 统一入口，按 Catalog dotName） */
  toolCalls: Record<string, number>;
  /** 能力调用失败/取消次数（按 dotName） */
  toolErrors: Record<string, number>;
  /** 定时任务无头 Agent 运行次数 */
  headlessRuns: number;
  headlessOk: number;
  headlessError: number;
  /** 看板 LLM 读屏（无头单次分类调用）次数 */
  screenReads: number;
  /** 扩展面板 ma.llm.chat 次数 */
  extLlmCalls: number;
  extLlmErrors: number;
  /** 按扩展 id 细分 */
  extLlmByExt: Record<string, number>;
}

export type UsageDays = Record<string, UsageDay>;

/** 调用明细（参数/返回）保留天数；计数桶永久落盘，不按此裁 */
export const USAGE_DETAIL_KEEP_DAYS = 30;
/** 调用明细条数上限（超出丢最旧；单条含完整 messages，须防失控循环撑爆磁盘） */
export const USAGE_LLM_CALLS_MAX_ENTRIES = 1000;

export function emptyUsageDay(): UsageDay {
  return {
    activeSessions: {},
    agentSessions: 0,
    shellSessions: 0,
    sessionsByRuntime: {},
    dispatchTurns: 0,
    guiWorkerSends: 0,
    toolCalls: {},
    toolErrors: {},
    headlessRuns: 0,
    headlessOk: 0,
    headlessError: 0,
    screenReads: 0,
    extLlmCalls: 0,
    extLlmErrors: 0,
    extLlmByExt: {}
  };
}

/** 时间戳 → 本地日 key（YYYY-MM-DD） */
export function usageDayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function asCount(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function asCountMap(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    const c = asCount(n);
    if (c > 0) out[k] = c;
  }
  return out;
}

/** 磁盘数据宽松归一：字段缺失/脏值不让统计面板崩 */
export function normalizeUsageDays(raw: unknown): UsageDays {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: UsageDays = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (!val || typeof val !== 'object') continue;
    const d = val as Record<string, unknown>;
    out[key] = {
      activeSessions: normalizeActiveSessions(d.activeSessions),
      agentSessions: asCount(d.agentSessions),
      shellSessions: asCount(d.shellSessions),
      sessionsByRuntime: asCountMap(d.sessionsByRuntime),
      dispatchTurns: asCount(d.dispatchTurns),
      guiWorkerSends: asCount(d.guiWorkerSends),
      toolCalls: asCountMap(d.toolCalls),
      toolErrors: asCountMap(d.toolErrors),
      headlessRuns: asCount(d.headlessRuns),
      headlessOk: asCount(d.headlessOk),
      headlessError: asCount(d.headlessError),
      screenReads: asCount(d.screenReads),
      extLlmCalls: asCount(d.extLlmCalls),
      extLlmErrors: asCount(d.extLlmErrors),
      extLlmByExt: asCountMap(d.extLlmByExt)
    };
  }
  return out;
}

/** 只丢掉未来日 key（时钟回拨/脏数据）；旧桶永久保留 */
export function dropFutureUsageDays(days: UsageDays, now: number): UsageDays {
  const today = usageDayKey(now);
  const out: UsageDays = {};
  for (const [key, day] of Object.entries(days)) {
    if (key <= today) out[key] = day;
  }
  return out;
}

/** 按窗口裁日桶（单测 / 可选清理；计数服务不再调用） */
export function pruneUsageDays(days: UsageDays, now: number, keepDays: number): UsageDays {
  const cutoff = addUsageDays(usageDayKey(now), -(keepDays - 1));
  const out: UsageDays = {};
  for (const [key, day] of Object.entries(days)) {
    if (key >= cutoff && key <= usageDayKey(now)) out[key] = day;
  }
  return out;
}

/** 日 key 上加减 n 天（日历算法；勿用 24h 乘法——DST 边界会产生重复/缺失日） */
export function addUsageDays(key: string, deltaDays: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + deltaDays);
  return usageDayKey(d.getTime());
}

/** 自定义日期范围支持的最大跨度（天，含端点）；防超长范围拖垮序列与载荷 */
export const MAX_USAGE_RANGE_DAYS = 366;
/** 无头运行 / 扩展 LLM 明细列表默认页大小 */
export const USAGE_PAGE_DEFAULT = 30;
/** 无头运行列表单次拉取硬上限（面板「加载更多」到顶后停） */
export const USAGE_RUNS_PAGE_MAX = 200;
/** 扩展 LLM 明细单次拉取硬上限 */
export const USAGE_LLM_PAGE_MAX = 100;

/** 起止日（含端点）升序逐日序列，缺天补零桶；非法或倒序范围返回空数组 */
export function rangeUsageDays(
  days: UsageDays,
  fromKey: string,
  toKey: string
): Array<{ date: string; day: UsageDay }> {
  const out: Array<{ date: string; day: UsageDay }> = [];
  const keyRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!keyRe.test(fromKey) || !keyRe.test(toKey) || fromKey > toKey) return out;
  let key = fromKey;
  while (key <= toKey && out.length < MAX_USAGE_RANGE_DAYS) {
    out.push({ date: key, day: days[key] ?? emptyUsageDay() });
    key = addUsageDays(key, 1);
  }
  return out;
}

/** 合并 [fromKey, toKey] 内已存在的日桶（不补零；窗口无数据即零桶） */
export function mergeUsageDaysInRange(days: UsageDays, fromKey: string, toKey: string): UsageDay {
  const list: UsageDay[] = [];
  for (const [key, day] of Object.entries(days)) {
    if (key >= fromKey && key <= toKey) list.push(day);
  }
  return mergeUsageDays(list);
}

/** 近 n 天（含今天）升序序列，缺天补零桶——趋势图直接用 */
export function recentUsageDays(
  days: UsageDays,
  now: number,
  n: number
): Array<{ date: string; day: UsageDay }> {
  const toKey = usageDayKey(now);
  return rangeUsageDays(days, addUsageDays(toKey, -(n - 1)), toKey);
}

export function sumCounts(map: Record<string, number>): number {
  let total = 0;
  for (const v of Object.values(map)) total += v;
  return total;
}

export interface UsageToolStat {
  name: string;
  count: number;
  errors: number;
}

/** 能力调用排行（次数降序，同次数按名称稳定排序） */
export function rankToolCalls(day: UsageDay, limit = 0): UsageToolStat[] {
  const rows = Object.entries(day.toolCalls).map(([name, count]) => ({
    name,
    count,
    errors: day.toolErrors[name] ?? 0
  }));
  rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** 多日合并（近 7 天排行等场景） */
export function mergeUsageDays(list: UsageDay[]): UsageDay {
  const out = emptyUsageDay();
  for (const d of list) {
    for (const [id, activity] of Object.entries(d.activeSessions ?? {})) {
      if (!out.activeSessions![id] || out.activeSessions![id].lastActiveAt < activity.lastActiveAt)
        out.activeSessions![id] = { ...activity };
    }
    out.agentSessions += d.agentSessions;
    out.shellSessions += d.shellSessions;
    out.dispatchTurns += d.dispatchTurns;
    out.guiWorkerSends += d.guiWorkerSends;
    out.headlessRuns += d.headlessRuns;
    out.headlessOk += d.headlessOk;
    out.headlessError += d.headlessError;
    out.screenReads += d.screenReads;
    out.extLlmCalls += d.extLlmCalls;
    out.extLlmErrors += d.extLlmErrors;
    for (const [k, v] of Object.entries(d.sessionsByRuntime)) {
      out.sessionsByRuntime[k] = (out.sessionsByRuntime[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(d.extLlmByExt)) {
      out.extLlmByExt[k] = (out.extLlmByExt[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(d.toolCalls)) {
      out.toolCalls[k] = (out.toolCalls[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(d.toolErrors)) {
      out.toolErrors[k] = (out.toolErrors[k] ?? 0) + v;
    }
  }
  return out;
}

// ---------- IPC 汇总载荷（usage:summary） ----------

/** 无头 Agent 运行条目（task-runs 联表任务名/工作区后的展示视图） */
export interface UsageHeadlessRun {
  id: string;
  taskId: string;
  taskName?: string;
  workspaceId?: string;
  status: 'running' | 'ok' | 'error';
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  /** 输出摘要（截断） */
  output?: string;
  error?: string;
  /** Pi 会话 jsonl 路径（调度面板可装载回看） */
  piSessionPath?: string;
}

/** 扩展 ma.llm.chat 一条调用明细（近 30 天、上限 1000 条；含请求参数与返回） */
export interface UsageLlmCall {
  id: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  extId: string;
  model?: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  temperature: number;
  /** 模型返回正文 */
  text?: string;
  error?: string;
}

export function normalizeUsageLlmCalls(raw: unknown): UsageLlmCall[] {
  if (!Array.isArray(raw)) return [];
  const out: UsageLlmCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    const startedAt = asCount(d.startedAt);
    if (!startedAt) continue;
    const id = typeof d.id === 'string' && d.id.trim() ? d.id.trim() : `llm-${startedAt}`;
    const extId = typeof d.extId === 'string' && d.extId.trim() ? d.extId.trim() : 'unknown';
    const messages: UsageLlmCall['messages'] = [];
    if (Array.isArray(d.messages)) {
      for (const m of d.messages) {
        if (!m || typeof m !== 'object') continue;
        const row = m as Record<string, unknown>;
        const role = row.role;
        if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
        if (typeof row.content !== 'string' || !row.content) continue;
        messages.push({ role, content: row.content });
      }
    }
    out.push({
      id,
      startedAt,
      durationMs: asCount(d.durationMs),
      ok: d.ok === true,
      extId,
      model: typeof d.model === 'string' && d.model.trim() ? d.model.trim() : undefined,
      messages,
      maxTokens: asCount(d.maxTokens) || 1024,
      temperature: typeof d.temperature === 'number' && Number.isFinite(d.temperature) ? d.temperature : 0.3,
      text: typeof d.text === 'string' && d.text ? d.text : undefined,
      error: typeof d.error === 'string' && d.error ? d.error : undefined
    });
  }
  return out;
}

/** 只留近 keepDays 个本地日（含今天）、最多 maxEntries 条（丢最旧）的调用明细 */
export function pruneUsageLlmCalls(
  calls: UsageLlmCall[],
  now: number,
  keepDays = USAGE_DETAIL_KEEP_DAYS,
  maxEntries = USAGE_LLM_CALLS_MAX_ENTRIES
): UsageLlmCall[] {
  const cutoff = addUsageDays(usageDayKey(now), -(keepDays - 1));
  const today = usageDayKey(now);
  return calls
    .filter((c) => {
      const key = usageDayKey(c.startedAt);
      return key >= cutoff && key <= today;
    })
    .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
    .slice(0, maxEntries);
}

/** usage:summary 查询参数（日历日口径，端点含入） */
export interface UsageSummaryQuery {
  fromKey: string;
  toKey: string;
  /** 无头运行列表分页 */
  runsOffset?: number;
  runsLimit?: number;
  /** 扩展 LLM 明细分页 */
  llmOffset?: number;
  llmLimit?: number;
}

/** 扩展 LLM 明细列表行（轻量：不带完整 messages，展开时按 id 单取详情） */
export interface UsageLlmCallRow {
  id: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  extId: string;
  model?: string;
  maxTokens: number;
  temperature: number;
  /** 预览（返回正文/错误/末条 user 消息，已折叠空白并截断） */
  preview: string;
}

/** 无头运行按任务聚合（范围内全量；task-runs 每任务仅滚动保留 50 条） */
export interface UsageHeadlessTaskStat {
  taskId: string;
  taskName?: string;
  workspaceId?: string;
  total: number;
  ok: number;
  error: number;
  /** 已完成运行的平均时长（无完成样本时缺省） */
  avgDurationMs?: number;
}

/** 扩展 LLM 按扩展聚合（范围内；明细仅保留 30 天/1000 条，更早调用不在聚合内） */
export interface UsageLlmExtStat {
  extId: string;
  calls: number;
  errors: number;
  /** 平均时长 */
  avgDurationMs?: number;
}

export interface UsageSummary {
  /** 近30天/1000条内的失败明细，按所选范围过滤。 */
  toolFailures?: UsageToolFailure[];
  generatedAt: number;
  todayKey: string;
  fromKey: string;
  toKey: string;
  /** 范围内逐日（升序、缺天补零；趋势图用） */
  rangeDays: Array<{ date: string; day: UsageDay }>;
  /** 范围合并桶（概览卡主值） */
  rangeTotal: UsageDay;
  /** 上一等长同期合并桶（环比；无历史即零桶） */
  prevTotal: UsageDay;
  /** 无头运行列表（范围内、倒序、分页） */
  headlessRuns: UsageHeadlessRun[];
  /** 范围内无头运行总数（分页截断时 > headlessRuns.length） */
  headlessTotal: number;
  /** 范围内进行中（running）的无头运行全量条数（不随分页截断；高频轮询判据） */
  headlessRunningTotal: number;
  /** 无头运行按任务聚合 */
  headlessByTask: UsageHeadlessTaskStat[];
  /** 扩展 LLM 明细行（范围内、倒序、分页） */
  llmCalls: UsageLlmCallRow[];
  llmCallsTotal: number;
  /** 扩展 LLM 按扩展聚合 */
  llmByExt: UsageLlmExtStat[];
}
