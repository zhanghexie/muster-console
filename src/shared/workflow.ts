/**
 * 轻量动态工作流（docs/plans/implemented/dynamic-workflow-plan.md W1）：纯函数与合同常量。无 process。
 *
 * 一个工作流 = `.muster/workflows/<name>/` 下的 WORKFLOW.md（给调度看的说明 + 扁平
 * frontmatter）与 run.mjs（`export default async function (wf, args)`，只做机械步骤）。
 * 判断经 wf.ask 交还调度；run 记录落 `.muster/scheduler/workflow-runs/`，重启后从头
 * 重跑脚本，delegate/ask/waitFor/call 按「种类 + 参数 + 第几次出现」自动记账跳过已完成步骤。
 */
import { matchPolicyRule, parsePolicyMatch, type PolicyEventView, type PolicyMatch } from './subscriptionPolicy';
import type { CursorAskQuestionMapped } from './cursorAskQuestion';
import type { TaskSchedule } from './types';
import { WORKFLOW_DOC_FILE } from './workflowCommand';

export { WORKFLOWS_DIR, WORKFLOW_DOC_FILE, WORKFLOW_SCRIPT_FILE } from './workflowCommand';
export const WORKFLOW_RUNS_DIR = '.muster/scheduler/workflow-runs';
export const WORKFLOW_TRIGGER_STATE_FILE = '.muster/scheduler/workflow-triggers.json';
/** 扩展信任表里工作流条目的键前缀（与扩展 id 共用 extensionTrust[ws] 命名空间） */
export const WORKFLOW_TRUST_PREFIX = 'workflow:';

export const WORKFLOW_LIMITS = {
  /** 每工作区同时运行的顶层 run 上限（子工作流不计） */
  maxActiveRuns: 3,
  /** 子工作流嵌套层数上限（顶层为 0） */
  maxDepth: 3,
  defaultMaxDelegates: 10,
  ceilingMaxDelegates: 30,
  defaultMaxHours: 24,
  ceilingMaxHours: 72,
  logMax: 200,
  logTextMax: 500,
  readMaxBytes: 256 * 1024,
  globMaxResults: 500,
  runOutputMax: 64 * 1024,
  runDefaultTimeoutMs: 10 * 60_000,
  runMaxTimeoutMs: 60 * 60_000,
  waitMaxTimeoutMs: 7 * 86_400_000,
  questionMax: 2000,
  answerMax: 4000,
  optionsMax: 12,
  resultMaxChars: 16 * 1024,
  stateMaxChars: 256 * 1024,
  /** 每工作区保留的已结束顶层 run 条数 */
  runRetainCount: 50,
  /** 已结束超过这么久的 run 记录删除 */
  runRetainMs: 30 * 86_400_000,
  /** 事件触发默认冷却（分钟） */
  defaultCooldownMin: 10,
  /** 定时触发 every 的最小间隔（分钟） */
  minScheduleEveryMin: 5,
  /** 工作流自己派出的会话/任务在这么久内产生的事件不触发工作流（防连锁） */
  ownedTtlMs: 12 * 3_600_000
} as const;

export const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** wf.tool 禁止通过工作流入口启动新 run；子工作流应使用 wf.call。 */
export const WORKFLOW_TOOL_DENYLIST: readonly string[] = ['workflow.run'];

// ---------------------------------------------------------------------------
// WORKFLOW.md
// ---------------------------------------------------------------------------

export interface WorkflowArgSpec {
  name: string;
  optional: boolean;
}

export interface WorkflowDef {
  name: string;
  description: string;
  args: WorkflowArgSpec[];
  maxDelegates: number;
  maxHours: number;
  /** 定时触发（frontmatter schedule） */
  schedule?: TaskSchedule;
  /** 事件触发（frontmatter on，语法同 wf.waitFor 的 match） */
  on?: PolicyMatch;
  /** 事件触发冷却（分钟） */
  cooldownMin: number;
  /** frontmatter 之后的正文（给调度的使用说明） */
  body: string;
}

export interface WorkflowDocParse {
  def?: WorkflowDef;
  /** 致命错误：有则工作流不可用 */
  errors: string[];
  /** 非致命（值被钳位/忽略） */
  warnings: string[];
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseLimit(
  raw: string | undefined,
  key: string,
  dflt: number,
  ceiling: number,
  warnings: string[]
): number {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warnings.push(`${key}=${raw} 不是正数，按默认 ${dflt}`);
    return dflt;
  }
  if (n > ceiling) {
    warnings.push(`${key}=${n} 超过宿主上限 ${ceiling}，按 ${ceiling}`);
    return ceiling;
  }
  return key === 'maxDelegates' ? Math.max(1, Math.floor(n)) : n;
}

export function parseWorkflowArgSpecs(raw: string | undefined): WorkflowArgSpec[] {
  if (!raw) return [];
  const s = raw.trim().replace(/^\[|\]$/g, '');
  const out: WorkflowArgSpec[] = [];
  const seen = new Set<string>();
  for (const part of s.split(',')) {
    const p = unquote(part);
    if (!p) continue;
    const optional = p.endsWith('?');
    const name = optional ? p.slice(0, -1).trim() : p;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, optional });
  }
  return out;
}

export function parseWorkflowDoc(raw: string, dirName: string): WorkflowDocParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = raw.replace(/^\uFEFF/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) {
    return { errors: [`${WORKFLOW_DOC_FILE} 缺少 frontmatter（--- 包围的 name/description 等键）`], warnings };
  }
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    fm[line.slice(0, i).trim()] = unquote(line.slice(i + 1));
  }
  const name = fm.name?.trim() || dirName;
  if (!WORKFLOW_NAME_RE.test(name)) {
    errors.push(`name「${name}」只能用小写字母、数字、连字符（≤48 字符）`);
  } else if (name !== dirName) {
    errors.push(`name「${name}」须与目录名「${dirName}」一致`);
  }
  const description = fm.description?.trim() ?? '';
  if (!description) errors.push('description 必填：一句话说明何时用这个工作流');
  if (errors.length) return { errors, warnings };
  const args = parseWorkflowArgSpecs(fm.args);
  const required = args.filter((a) => !a.optional).map((a) => a.name);
  let schedule: TaskSchedule | undefined;
  if (fm.schedule?.trim()) {
    const r = parseWorkflowSchedule(fm.schedule);
    if (r.error) warnings.push(`schedule 未生效：${r.error}`);
    else if (required.length) warnings.push(`schedule 未生效：定时触发不带参数，但声明了必填参数 ${required.join(', ')}`);
    else schedule = r.schedule;
  }
  let on: PolicyMatch | undefined;
  if (fm.on?.trim()) {
    const r = parseWorkflowOn(fm.on);
    if (r.error) warnings.push(`on 未生效：${r.error}`);
    else if (required.some((n) => n !== 'event')) {
      warnings.push(`on 未生效：事件触发只传 event 参数，但声明了必填参数 ${required.filter((n) => n !== 'event').join(', ')}`);
    } else on = r.match;
  }
  let cooldownMin: number = WORKFLOW_LIMITS.defaultCooldownMin;
  if (fm.cooldown?.trim()) {
    const n = Number(fm.cooldown);
    if (Number.isFinite(n) && n >= 1) cooldownMin = Math.floor(n);
    else warnings.push(`cooldown=${fm.cooldown} 不是 ≥1 的分钟数，按默认 ${WORKFLOW_LIMITS.defaultCooldownMin}`);
  }
  return {
    def: {
      name,
      description,
      args,
      maxDelegates: parseLimit(
        fm.maxDelegates,
        'maxDelegates',
        WORKFLOW_LIMITS.defaultMaxDelegates,
        WORKFLOW_LIMITS.ceilingMaxDelegates,
        warnings
      ),
      maxHours: parseLimit(fm.maxHours, 'maxHours', WORKFLOW_LIMITS.defaultMaxHours, WORKFLOW_LIMITS.ceilingMaxHours, warnings),
      ...(schedule ? { schedule } : {}),
      ...(on ? { on } : {}),
      cooldownMin,
      body: text.slice(m[0].length).trim()
    },
    errors,
    warnings
  };
}

// ---------------------------------------------------------------------------
// 触发（frontmatter schedule / on）
// ---------------------------------------------------------------------------

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function normHHMM(s: string): string | null {
  const m = HHMM_RE.exec(s.trim());
  return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : null;
}

/** `daily 02:00` / `weekly 1,3,5 09:30`（0=周日）/ `every 30m` · `every 2h` */
export function parseWorkflowSchedule(raw: string): { schedule?: TaskSchedule; error?: string } {
  const parts = raw.trim().split(/\s+/);
  const kind = parts[0]?.toLowerCase();
  const hint = '写法：daily 02:00 / weekly 1,3,5 09:30（0=周日）/ every 30m / every 2h';
  if (kind === 'daily' && parts.length === 2) {
    const time = normHHMM(parts[1]!);
    return time ? { schedule: { kind: 'daily', time } } : { error: `时间「${parts[1]}」不是 HH:mm。${hint}` };
  }
  if (kind === 'weekly' && parts.length === 3) {
    const days = parts[1]!.split(',').map((d) => Number(d.trim()));
    const time = normHHMM(parts[2]!);
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { error: `星期「${parts[1]}」须是 0–6 的逗号列表。${hint}` };
    if (!time) return { error: `时间「${parts[2]}」不是 HH:mm。${hint}` };
    return { schedule: { kind: 'weekly', time, weekdays: [...new Set(days)].sort() } };
  }
  if (kind === 'every' && parts.length === 2) {
    const m = /^(\d+)(m|h)$/i.exec(parts[1]!);
    if (!m) return { error: `间隔「${parts[1]}」须形如 30m / 2h。${hint}` };
    const minutes = Number(m[1]) * (m[2]!.toLowerCase() === 'h' ? 60 : 1);
    if (minutes < WORKFLOW_LIMITS.minScheduleEveryMin) return { error: `间隔至少 ${WORKFLOW_LIMITS.minScheduleEveryMin} 分钟` };
    return { schedule: { kind: 'interval', intervalMinutes: minutes } };
  }
  return { error: `无法识别「${raw.trim()}」。${hint}` };
}

export function describeWorkflowSchedule(s: TaskSchedule): string {
  if (s.kind === 'daily') return `每天 ${s.time}`;
  if (s.kind === 'weekly') return `每周 ${s.weekdays.join(',')} ${s.time}`;
  if (s.kind === 'interval') return s.intervalMinutes % 60 === 0 ? `每 ${s.intervalMinutes / 60} 小时` : `每 ${s.intervalMinutes} 分钟`;
  return `一次 ${s.at}`;
}

/** frontmatter on：一行 JSON，语法同 wf.waitFor；kind 必填且不能是 workflow（防连锁） */
export function parseWorkflowOn(raw: string): { match?: PolicyMatch; error?: string } {
  let o: unknown;
  try {
    o = JSON.parse(raw.trim());
  } catch {
    return { error: '须是一行 JSON，如 {"kind":"phase","trigger":"needs_you"}' };
  }
  const { match, errors } = parseWaitMatch(o);
  if (!match) return { error: errors.join('；') };
  const kinds = Array.isArray(match.kind) ? match.kind : [match.kind];
  if (kinds.some((k) => String(k).toLowerCase() === 'workflow')) return { error: '不能由 workflow 事件触发（防工作流互相连锁）' };
  return { match };
}

/** 启动参数校验：必填缺失即错；多给的参数放行（脚本自行忽略） */
export function validateWorkflowArgs(def: WorkflowDef, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const a of def.args) {
    if (a.optional) continue;
    const v = args[a.name];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
      errors.push(`缺少必填参数 ${a.name}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// run 记录
// ---------------------------------------------------------------------------

export const WORKFLOW_RUN_STATUSES = ['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export function isWorkflowRunActive(status: WorkflowRunStatus): boolean {
  return status === 'running' || status === 'waiting';
}

export interface WorkflowPendingAsk {
  askId: string;
  /** 记账键：答复写进 memo[key]，重跑时同一步直接拿到 */
  key: string;
  to: 'scheduler' | 'human';
  question: string;
  options?: string[];
  multi?: boolean;
  since: number;
}

export interface WorkflowLogEntry {
  ts: number;
  text: string;
}

export interface WorkflowRunRecord {
  version: 1;
  runId: string;
  name: string;
  workspaceId: string;
  parentRunId?: string;
  depth: number;
  status: WorkflowRunStatus;
  args: Record<string, unknown>;
  state: Record<string, unknown>;
  /** 启动时 WORKFLOW.md + run.mjs 的内容指纹；续跑时不一致则标记中断 */
  fingerprint: string;
  maxDelegates: number;
  maxHours: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  phase?: string;
  /** 当前在等什么（一行描述，给 workflow.get 与面板看） */
  waiting?: string;
  pendingAsk?: WorkflowPendingAsk;
  log: WorkflowLogEntry[];
  /** 自动记账：记账键 → 该步结果 */
  memo: Record<string, unknown>;
  delegates: number;
  /** 等人答复累计毫秒（不计入存活时长） */
  humanWaitMs: number;
  humanWaitSince?: number;
  /** 进程重启后被续跑的次数 */
  resumes: number;
  /** 怎么起的：人/调度手动、定时、事件 */
  trigger?: WorkflowRunTrigger;
  /** 本 run 派出的会话 id（取消时可一并关闭；其事件不触发工作流） */
  sessions?: string[];
  /** 本 run 派活落表的任务 id */
  tasks?: string[];
  result?: unknown;
  error?: string;
}

export type WorkflowRunTrigger = 'manual' | 'schedule' | 'event';

function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && !!x);
  return out.length ? out : undefined;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

/** 读盘宽容解析：关键字段缺失返回 null（坏记录跳过，不挡其它 run） */
export function parseWorkflowRunRecord(raw: unknown): WorkflowRunRecord | null {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(o)) return null;
  const runId = typeof o.runId === 'string' ? o.runId : '';
  const name = typeof o.name === 'string' ? o.name : '';
  const workspaceId = typeof o.workspaceId === 'string' ? o.workspaceId : '';
  const status = o.status as WorkflowRunStatus;
  if (!runId || !name || !workspaceId || !(WORKFLOW_RUN_STATUSES as readonly string[]).includes(status)) return null;
  const pa = isObj(o.pendingAsk) ? o.pendingAsk : undefined;
  const pendingAsk: WorkflowPendingAsk | undefined =
    pa && typeof pa.askId === 'string' && typeof pa.key === 'string' && typeof pa.question === 'string'
      ? {
          askId: pa.askId,
          key: pa.key,
          to: pa.to === 'human' ? 'human' : 'scheduler',
          question: pa.question,
          ...(Array.isArray(pa.options) ? { options: pa.options.filter((x): x is string => typeof x === 'string') } : {}),
          ...(pa.multi === true ? { multi: true } : {}),
          since: num(pa.since, Date.now())
        }
      : undefined;
  const startedAt = num(o.startedAt, 0);
  return {
    version: 1,
    runId,
    name,
    workspaceId,
    ...(typeof o.parentRunId === 'string' && o.parentRunId ? { parentRunId: o.parentRunId } : {}),
    depth: num(o.depth, 0),
    status,
    args: isObj(o.args) ? o.args : {},
    state: isObj(o.state) ? o.state : {},
    fingerprint: typeof o.fingerprint === 'string' ? o.fingerprint : '',
    maxDelegates: num(o.maxDelegates, WORKFLOW_LIMITS.defaultMaxDelegates),
    maxHours: num(o.maxHours, WORKFLOW_LIMITS.defaultMaxHours),
    startedAt,
    updatedAt: num(o.updatedAt, startedAt),
    ...(typeof o.endedAt === 'number' ? { endedAt: o.endedAt } : {}),
    ...(typeof o.phase === 'string' && o.phase ? { phase: o.phase } : {}),
    ...(typeof o.waiting === 'string' && o.waiting ? { waiting: o.waiting } : {}),
    ...(pendingAsk ? { pendingAsk } : {}),
    log: Array.isArray(o.log)
      ? o.log.filter((e): e is WorkflowLogEntry => isObj(e) && typeof e.text === 'string' && typeof e.ts === 'number')
      : [],
    memo: isObj(o.memo) ? o.memo : {},
    delegates: num(o.delegates, 0),
    humanWaitMs: num(o.humanWaitMs, 0),
    ...(typeof o.humanWaitSince === 'number' ? { humanWaitSince: o.humanWaitSince } : {}),
    resumes: num(o.resumes, 0),
    ...(o.trigger === 'manual' || o.trigger === 'schedule' || o.trigger === 'event' ? { trigger: o.trigger } : {}),
    ...(strList(o.sessions) ? { sessions: strList(o.sessions) } : {}),
    ...(strList(o.tasks) ? { tasks: strList(o.tasks) } : {}),
    ...('result' in o ? { result: o.result } : {}),
    ...(typeof o.error === 'string' ? { error: o.error } : {})
  };
}

/** wf.run 的日志行只记程序名与参数段数：run 日志会持久化并回传调度模型，参数里可能有密钥 */
export function workflowRunCommandLog(cmd: string, args: readonly string[]): string {
  const parts = args.length ? [cmd.trim(), ...args] : cmd.trim().split(/\s+/);
  const program = parts[0] ?? '';
  const rest = parts.length - 1;
  return rest > 0 ? `命令：${program}（${rest} 段参数不落日志）` : `命令：${program}`;
}

export function appendWorkflowLog(rec: WorkflowRunRecord, ts: number, text: string): void {
  const t = String(text).replace(/\s+/g, ' ').trim().slice(0, WORKFLOW_LIMITS.logTextMax);
  if (!t) return;
  rec.log.push({ ts, text: t });
  if (rec.log.length > WORKFLOW_LIMITS.logMax) rec.log.splice(0, rec.log.length - WORKFLOW_LIMITS.logMax);
}

// ---------------------------------------------------------------------------
// 自动记账键
// ---------------------------------------------------------------------------

/** 键序稳定的 JSON（对象键排序），同内容不同键序得同一串 */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** FNV-1a 32 位（记账键只需区分同一 run 内的步骤，不做安全用途） */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export type WorkflowMemoKind = 'delegate' | 'ask' | 'waitFor' | 'call' | 'run';

/** delegate 记账占位：已发出派活但结果未落盘（崩溃重跑时据此按会话创建标识找回，不重复派） */
export const WORKFLOW_MEMO_PENDING = '__pending';

/** 派活的确定性创建标识：同一 run 同一步重跑得同一个 id，会话元数据里查得到即说明已派过 */
export function workflowDelegateTaskId(runId: string, memoKey: string): string {
  return `wf-${fnv1a(`${runId}\n${memoKey}`)}${fnv1a(`${memoKey}\n${runId}`)}`;
}

/**
 * 运行记录保留：已结束的顶层 run 按结束时间保留最近 keep 条，且结束超过 maxAgeMs 的删除；
 * 子 run 跟随父 run（父仍活跃的不删；父被删或已不在时按同样的时长规则）。返回要删的 runId。
 */
export function selectWorkflowRunsToPrune(
  records: WorkflowRunRecord[],
  now: number,
  opts: { keep?: number; maxAgeMs?: number } = {}
): string[] {
  const keep = opts.keep ?? WORKFLOW_LIMITS.runRetainCount;
  const maxAgeMs = opts.maxAgeMs ?? WORKFLOW_LIMITS.runRetainMs;
  const byId = new Map(records.map((r) => [r.runId, r]));
  const endedAt = (r: WorkflowRunRecord): number => r.endedAt ?? r.updatedAt;
  const prune = new Set<string>();
  const top = records
    .filter((r) => !r.parentRunId && !isWorkflowRunActive(r.status))
    .sort((a, b) => endedAt(b) - endedAt(a));
  top.forEach((r, i) => {
    if (i >= keep || now - endedAt(r) > maxAgeMs) prune.add(r.runId);
  });
  for (const r of records) {
    if (!r.parentRunId || isWorkflowRunActive(r.status)) continue;
    const parent = byId.get(r.parentRunId);
    if (parent && isWorkflowRunActive(parent.status)) continue;
    if ((parent && prune.has(parent.runId)) || (!parent && now - endedAt(r) > maxAgeMs)) prune.add(r.runId);
  }
  return [...prune];
}

/** 同种类同参数在一次执行里第 n 次出现 → `kind:hash#n`（重跑时按同样顺序命中） */
export class WorkflowMemoCounter {
  private seen = new Map<string, number>();
  next(kind: WorkflowMemoKind, payload: unknown): string {
    const base = `${kind}:${fnv1a(stableStringify(payload))}`;
    const n = (this.seen.get(base) ?? 0) + 1;
    this.seen.set(base, n);
    return `${base}#${n}`;
  }
}

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

/** 存活时长：自启动起算，扣除等人答复的时间 */
export function workflowActiveMs(rec: WorkflowRunRecord, now: number): number {
  const waiting = rec.humanWaitSince !== undefined ? Math.max(0, now - rec.humanWaitSince) : 0;
  return Math.max(0, now - rec.startedAt - rec.humanWaitMs - waiting);
}

/** 超限返回原因（run 据此失败并唤醒调度），未超返回 null */
export function workflowBudgetError(
  rec: WorkflowRunRecord,
  now: number,
  opts: { addingDelegate?: boolean } = {}
): string | null {
  if (opts.addingDelegate && rec.delegates + 1 > rec.maxDelegates) {
    return `派活次数将超过上限 ${rec.maxDelegates}（WORKFLOW.md 的 maxDelegates）`;
  }
  if (workflowActiveMs(rec, now) > rec.maxHours * 3_600_000) {
    return `运行时长超过上限 ${rec.maxHours} 小时（WORKFLOW.md 的 maxHours；等人答复的时间不计）`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

export function parseWaitMatch(raw: unknown): { match?: PolicyMatch; errors: string[] } {
  const errors: string[] = [];
  const match = parsePolicyMatch(raw, 'waitFor', errors);
  if (!match) return { errors };
  if (!match.kind) return { errors: ['waitFor 的 match 必须写 kind（如 phase / fact）'] };
  return { match, errors };
}

export function matchWaitEvent(match: PolicyMatch, view: PolicyEventView): boolean {
  return matchPolicyRule(match, view);
}

function oneOf(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return (Array.isArray(v) ? v : [v]).map((x) => x.trim().toLowerCase());
}

/** 先查现状（会话相位）：match 为 kind 含 phase + 单个 sessionId + trigger，会话当前相位已命中就不用等 */
export function phaseSnapshotSatisfies(match: PolicyMatch, session: { id: string; phase: string }): boolean {
  const kinds = oneOf(match.kind as string | string[] | undefined);
  const ids = oneOf(match.sessionId);
  const trig = oneOf(match.trigger);
  if (!kinds?.includes('phase') || !ids || !trig) return false;
  return ids.includes(session.id.toLowerCase()) && trig.includes(session.phase.toLowerCase());
}

/** match 指向的单个会话 id（相位快照用） */
export function waitMatchSessionId(match: PolicyMatch): string | undefined {
  const ids = match.sessionId === undefined ? [] : Array.isArray(match.sessionId) ? match.sessionId : [match.sessionId];
  return ids.length === 1 ? ids[0] : undefined;
}

export function describeWaitMatch(match: PolicyMatch): string {
  return Object.entries(match)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : String(v)}`)
    .join(' ');
}

// ---------------------------------------------------------------------------
// 问人
// ---------------------------------------------------------------------------

export function buildHumanAskMapped(name: string, ask: WorkflowPendingAsk): CursorAskQuestionMapped {
  return {
    questions: [
      {
        id: 'answer',
        question: ask.question,
        header: `工作流 ${name}`,
        ...(ask.options?.length ? { options: ask.options.map((label) => ({ label })) } : {}),
        ...(ask.multi ? { multiSelect: true } : {})
      }
    ]
  };
}

/** 问题卡作答 → 脚本拿到的答案：单选为字符串，multi 为字符串数组；自定义作答并入。
 *  空选（含 multi）一律算未作答，与工作流面板禁止空提交一致。 */
export function humanAnswerFromOutcome(
  outcome: { kind: 'answered'; answers: Array<{ id: string; selected: string[]; custom?: string }> } | { kind: 'aborted' },
  ask: WorkflowPendingAsk
): { ok: true; answer: string | string[] } | { ok: false } {
  if (outcome.kind !== 'answered') return { ok: false };
  const a = outcome.answers.find((x) => x.id === 'answer') ?? outcome.answers[0];
  if (!a) return { ok: false };
  const picked = [...a.selected];
  const custom = a.custom?.trim();
  if (custom) picked.push(custom);
  if (!picked.length) return { ok: false };
  return { ok: true, answer: ask.multi ? picked : picked[0]! };
}

// ---------------------------------------------------------------------------
// 给调度看的 run 概览
// ---------------------------------------------------------------------------

export function describeWorkflowRun(rec: WorkflowRunRecord, now: number, opts: { logTail?: number } = {}): Record<string, unknown> {
  const tail = opts.logTail ?? 10;
  return {
    runId: rec.runId,
    name: rec.name,
    status: rec.status,
    ...(rec.parentRunId ? { parentRunId: rec.parentRunId } : {}),
    ...(rec.trigger && rec.trigger !== 'manual' ? { trigger: rec.trigger } : {}),
    ...(rec.phase ? { phase: rec.phase } : {}),
    ...(rec.waiting ? { waiting: rec.waiting } : {}),
    ...(rec.sessions?.length ? { sessions: rec.sessions } : {}),
    ...(rec.pendingAsk
      ? {
          pendingAsk: {
            askId: rec.pendingAsk.askId,
            to: rec.pendingAsk.to,
            question: rec.pendingAsk.question,
            ...(rec.pendingAsk.options ? { options: rec.pendingAsk.options } : {}),
            ...(rec.pendingAsk.multi ? { multi: true } : {})
          }
        }
      : {}),
    args: rec.args,
    delegates: `${rec.delegates}/${rec.maxDelegates}`,
    activeMinutes: Math.round(workflowActiveMs(rec, now) / 60_000),
    maxHours: rec.maxHours,
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
    ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
    ...(rec.resumes ? { resumes: rec.resumes } : {}),
    ...(tail > 0 && rec.log.length ? { log: rec.log.slice(-tail) } : {}),
    ...('result' in rec ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {})
  };
}

// ---------------------------------------------------------------------------
// 触发状态（.muster/scheduler/workflow-triggers.json）
// ---------------------------------------------------------------------------

export interface WorkflowTriggerEntry {
  /** 定时基准：某指纹已信任后首次看到的时刻（改内容 / 重新信任即重置，不补跑信任前的时段） */
  anchorAt?: number;
  anchorFingerprint?: string;
  lastFiredAt?: number;
  lastEventAt?: number;
  /** 已为该指纹报过 trigger_blocked（每个指纹只报一次） */
  blockedFingerprint?: string;
  lastSkip?: { at: number; reason: string };
  /** 用户在面板停用了触发（文件不动，可随时恢复） */
  disabled?: boolean;
}

export type WorkflowTriggerState = Record<string, WorkflowTriggerEntry>;

export function parseWorkflowTriggerState(raw: unknown): WorkflowTriggerState {
  let o: unknown = raw;
  if (typeof raw === 'string') {
    try {
      o = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!isObj(o)) return {};
  const out: WorkflowTriggerState = {};
  for (const [name, v] of Object.entries(o)) {
    if (!WORKFLOW_NAME_RE.test(name) || !isObj(v)) continue;
    const e: WorkflowTriggerEntry = {};
    for (const k of ['anchorAt', 'lastFiredAt', 'lastEventAt'] as const) if (typeof v[k] === 'number') e[k] = v[k] as number;
    for (const k of ['anchorFingerprint', 'blockedFingerprint'] as const) if (typeof v[k] === 'string') e[k] = v[k] as string;
    const s = v.lastSkip;
    if (isObj(s) && typeof s.at === 'number' && typeof s.reason === 'string') e.lastSkip = { at: s.at, reason: s.reason };
    if (v.disabled === true) e.disabled = true;
    out[name] = e;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 面板视图（主进程组装，渲染层 import type）
// ---------------------------------------------------------------------------

export type WorkflowTrustState = 'trusted' | 'changed' | 'never';

export interface WorkflowOverviewItem {
  name: string;
  description?: string;
  args?: string[];
  fingerprint: string;
  trust: WorkflowTrustState;
  schedule?: string;
  on?: string;
  cooldownMin?: number;
  triggersDisabled?: boolean;
  nextDueAt?: number;
  lastFiredAt?: number;
  lastSkip?: { at: number; reason: string };
  errors?: string[];
  warnings?: string[];
}

export interface WorkflowRunView {
  runId: string;
  name: string;
  status: WorkflowRunStatus;
  trigger?: WorkflowRunTrigger;
  parentRunId?: string;
  phase?: string;
  waiting?: string;
  pendingAsk?: { askId: string; to: 'scheduler' | 'human'; question: string; options?: string[]; multi?: boolean };
  delegates: string;
  activeMinutes: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  sessions?: string[];
  log: WorkflowLogEntry[];
  result?: unknown;
  error?: string;
}

export interface WorkflowOverview {
  workflows: WorkflowOverviewItem[];
  active: WorkflowRunView[];
  recent: WorkflowRunView[];
}

export function workflowRunView(rec: WorkflowRunRecord, now: number, logTail = 30): WorkflowRunView {
  const pa = rec.pendingAsk;
  return {
    runId: rec.runId,
    name: rec.name,
    status: rec.status,
    ...(rec.trigger ? { trigger: rec.trigger } : {}),
    ...(rec.parentRunId ? { parentRunId: rec.parentRunId } : {}),
    ...(rec.phase ? { phase: rec.phase } : {}),
    ...(rec.waiting ? { waiting: rec.waiting } : {}),
    ...(pa
      ? {
          pendingAsk: {
            askId: pa.askId,
            to: pa.to,
            question: pa.question,
            ...(pa.options ? { options: pa.options } : {}),
            ...(pa.multi ? { multi: true } : {})
          }
        }
      : {}),
    delegates: `${rec.delegates}/${rec.maxDelegates}`,
    activeMinutes: Math.round(workflowActiveMs(rec, now) / 60_000),
    startedAt: rec.startedAt,
    updatedAt: rec.updatedAt,
    ...(rec.endedAt ? { endedAt: rec.endedAt } : {}),
    ...(rec.sessions?.length ? { sessions: rec.sessions } : {}),
    log: logTail > 0 ? rec.log.slice(-logTail) : [],
    ...('result' in rec ? { result: rec.result } : {}),
    ...(rec.error ? { error: rec.error } : {})
  };
}

// ---------------------------------------------------------------------------
// wf.glob
// ---------------------------------------------------------------------------

/** 简易 glob → 正则（`**` 跨目录、`*` `?` 不跨 `/`、`{a,b}` 任一）；路径分隔统一为 `/` */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  let inBrace = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inBrace = true;
      re += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace = false;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

export function formatWorkflowEventDetail(name: string, runId: string, text: string): string {
  return `${name}（${runId}）${text}`;
}
