/**
 * 调度订阅策略（agent-comms-evolution-plan C1）：调度「听什么、多重要才叫醒我」从事件泵的
 * 硬编码判断挪成每工作区一份声明式规则，调度自己可读可改（scheduler.policy.get/set）。
 * 纯函数，无 process。
 *
 * 判定顺序：用户规则（策略文件，按序首中）→ 内置默认规则（= 改造前的硬编码行为）→
 * 底线层兜底（底线事件无论规则怎么写都唤醒；底线清单只改代码，不进策略文件）。
 *
 * 动作：wake=入队并按合并窗口唤醒调度；digest=不单独唤醒，捎带进下一次唤醒消息；
 * mute=丢弃（纯观测事件仍刷新心跳活动，由事件泵负责）。
 */
import {
  isOrchEventKind,
  ORCH_EVENT_KINDS,
  ORCH_WAKE_DEFAULTS,
  orchEventKindLabel,
  type OrchEventKind
} from './notifyQueue';
import { ORCH_GUARD_DEFAULTS } from './orchestratorGuards';

export const SUBSCRIPTION_POLICY_FILE = '.muster/scheduler/subscription-policy.json';
export const SUBSCRIPTION_POLICY_HISTORY_FILE = '.muster/scheduler/subscription-policy.history.jsonl';

export const POLICY_ACTIONS = ['wake', 'digest', 'mute'] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

/** 事件泵交给策略判定的事件视图（字段按事件种类选填） */
export interface PolicyEventView {
  kind: OrchEventKind;
  /** phase：needs_you/done/error；fact 的 session.phase：相位值 */
  trigger?: string;
  /** fact：订阅事实种类（session.phase / pipeline.verdict / event.<id> …） */
  factKind?: string;
  sessionId?: string;
  /** 事件所属会话是否编排会话 */
  orchestrated?: boolean;
}

type StrOrList = string | string[];

/** 规则匹配条件：写了的字段全部命中才算命中；字符串字段可给数组表示「任一」；空对象匹配一切 */
export interface PolicyMatch {
  kind?: OrchEventKind | OrchEventKind[];
  trigger?: StrOrList;
  factKind?: StrOrList;
  sessionId?: StrOrList;
  orchestrated?: boolean;
}

const STRING_MATCH_FIELDS = ['kind', 'trigger', 'factKind', 'sessionId'] as const;
const BOOL_MATCH_FIELDS = ['orchestrated'] as const;
const MATCH_FIELDS: readonly string[] = [...STRING_MATCH_FIELDS, ...BOOL_MATCH_FIELDS];

export interface PolicyRule {
  id: string;
  match: PolicyMatch;
  action: PolicyAction;
  note?: string;
}

export interface PolicyTiming {
  mergeWindowMs?: number;
  maxWaitMs?: number;
}

export interface PolicyGuards {
  heartbeatMs?: number;
  needsYouMs?: number;
}

export interface SubscriptionPolicy {
  version: 1;
  rules: PolicyRule[];
  timing: PolicyTiming;
  guards: PolicyGuards;
  updatedAt?: number;
  updatedBy?: string;
  reason?: string;
}

export const POLICY_MAX_RULES = 40;
const POLICY_MAX_LIST = 12;
const POLICY_NOTE_MAX = 200;
const POLICY_REASON_MAX = 300;
const POLICY_ID_MAX = 64;
const BUILTIN_ID_PREFIX = 'builtin.';

export const POLICY_TIMING_BOUNDS: Record<keyof Required<PolicyTiming>, readonly [number, number]> = {
  mergeWindowMs: [5_000, 120_000],
  maxWaitMs: [5_000, 300_000]
};

export const POLICY_GUARD_BOUNDS: Record<keyof Required<PolicyGuards>, readonly [number, number]> = {
  heartbeatMs: [5 * 60_000, 24 * 3_600_000],
  needsYouMs: [5 * 60_000, 4 * 3_600_000],
};

export function emptySubscriptionPolicy(): SubscriptionPolicy {
  return { version: 1, rules: [], timing: {}, guards: {} };
}

/** 内置默认规则：逐条对应改造前事件泵的硬编码行为（shouldUplinkOrchEvent + 任务翻转发射门） */
export const BUILTIN_POLICY_RULES: readonly PolicyRule[] = [
  {
    id: 'builtin.phase-wake',
    match: { kind: 'phase', trigger: ['needs_you', 'error'] },
    action: 'wake',
    note: 'Worker 等人或出错'
  },
  {
    id: 'builtin.phase-rest',
    match: { kind: 'phase' },
    action: 'mute',
    note: 'phase→done 是正常观测，显式结果通过会话邮箱交付'
  },
  {
    id: 'builtin.turn-end',
    match: { kind: 'turn_end' },
    action: 'mute',
    note: '回合结束是纯观测，只刷新心跳活动'
  },
  {
    id: 'builtin.commit',
    match: { kind: 'commit' },
    action: 'mute',
    note: '隔离树提交是纯观测'
  },
  {
    id: 'builtin.fact-orch-phase',
    match: { kind: 'fact', factKind: 'session.phase', orchestrated: true, trigger: ['needs_you', 'done', 'error'] },
    action: 'mute',
    note: '编排会话的这三种相位已由 phase 事件覆盖，免重复'
  },
  {
    id: 'builtin.workflow-wake',
    match: { kind: 'workflow', trigger: ['ask', 'failed', 'interrupted', 'completed', 'trigger_blocked'] },
    action: 'wake',
    note: '工作流问你、失败、中断、完成、触发被挡都要你处理'
  },
  {
    id: 'builtin.workflow-progress',
    match: { kind: 'workflow' },
    action: 'digest',
    note: '工作流启动、阶段推进、问用户（用户在面板上直接答）只捎带'
  },
  {
    id: 'builtin.default',
    match: {},
    action: 'wake',
    note: '其余事件（守卫、补位、收口提醒、订阅事实……）唤醒'
  }
];

/** 底线层：需要人、失败、安全相关的信号，任何规则都不能静音或降为顺带 */
export const POLICY_FLOOR: readonly { match: PolicyMatch; why: string }[] = [
  { match: { kind: 'phase', trigger: ['needs_you', 'error'] }, why: '编排会话等人或出错' },
  { match: { kind: 'needs_you_stale' }, why: '等人超时无人处理' },
  { match: { kind: 'turn_error' }, why: 'Worker 回合因网络/传输失败' },
  { match: { kind: 'merge_blocked' }, why: '合入被主仓脏文件挡住' },
  { match: { kind: 'dim_gate_red' }, why: '交付被维度门挡下' },
  { match: { kind: 'workflow', trigger: ['ask', 'failed', 'interrupted'] }, why: '工作流等你答复或失败/中断' }
];

function asList(v: StrOrList | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v : [v];
}

function fieldMatches(want: StrOrList | undefined, got: string | undefined): boolean {
  const list = asList(want);
  if (!list) return true;
  const g = got?.trim().toLowerCase();
  if (!g) return false;
  return list.some((w) => w.trim().toLowerCase() === g);
}

export function matchPolicyRule(match: PolicyMatch, view: PolicyEventView): boolean {
  for (const f of STRING_MATCH_FIELDS) {
    if (!fieldMatches(match[f] as StrOrList | undefined, view[f] as string | undefined)) return false;
  }
  for (const f of BOOL_MATCH_FIELDS) {
    if (match[f] !== undefined && (view[f] === true) !== match[f]) return false;
  }
  return true;
}

export function isPolicyFloorEvent(view: PolicyEventView): boolean {
  return POLICY_FLOOR.some((f) => matchPolicyRule(f.match, view));
}

export interface PolicyDecision {
  action: PolicyAction;
  ruleId: string;
  /** 规则判为 mute/digest 但事件属底线层，被强制改回 wake */
  floorOverride: boolean;
}

export function decidePolicyAction(
  view: PolicyEventView,
  policy?: SubscriptionPolicy | null
): PolicyDecision {
  const rules = [...(policy?.rules ?? []), ...BUILTIN_POLICY_RULES];
  const hit = rules.find((r) => matchPolicyRule(r.match, view)) ?? BUILTIN_POLICY_RULES[BUILTIN_POLICY_RULES.length - 1]!;
  if (hit.action !== 'wake' && isPolicyFloorEvent(view)) {
    return { action: 'wake', ruleId: hit.id, floorOverride: true };
  }
  return { action: hit.action, ruleId: hit.id, floorOverride: false };
}

// ---------------------------------------------------------------------------
// 生效值
// ---------------------------------------------------------------------------

export function effectivePolicyTiming(policy?: SubscriptionPolicy | null): Required<PolicyTiming> {
  const mergeWindowMs = policy?.timing.mergeWindowMs ?? ORCH_WAKE_DEFAULTS.mergeWindowMs;
  const maxWaitMs = Math.max(mergeWindowMs, policy?.timing.maxWaitMs ?? ORCH_WAKE_DEFAULTS.maxWaitMs);
  return { mergeWindowMs, maxWaitMs };
}

export function effectivePolicyGuards(policy?: SubscriptionPolicy | null): Required<PolicyGuards> {
  return {
    heartbeatMs: policy?.guards.heartbeatMs ?? ORCH_GUARD_DEFAULTS.heartbeatMs,
    needsYouMs: policy?.guards.needsYouMs ?? ORCH_GUARD_DEFAULTS.needsYouMs,
  };
}

// ---------------------------------------------------------------------------
// 解析与校验：读文件宽容（坏条目丢弃并告警）；工具写入严格（有告警即拒写，见 host）
// ---------------------------------------------------------------------------

export interface PolicyParseResult {
  policy: SubscriptionPolicy;
  /** 输入有错（条目被丢弃/字段被忽略或钳位）：工具写入时据此拒写 */
  warnings: string[];
  /** 仅告知不拒写（如规则可能命中底线事件，底线部分仍会唤醒） */
  notices: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampMs(
  v: unknown,
  bounds: readonly [number, number],
  label: string,
  warnings: string[]
): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    warnings.push(`${label} 必须是毫秒数，已忽略`);
    return undefined;
  }
  const [lo, hi] = bounds;
  const n = Math.round(v);
  if (n < lo || n > hi) {
    warnings.push(`${label}=${n} 超出范围 [${lo}, ${hi}]，已钳到边界`);
    return Math.min(hi, Math.max(lo, n));
  }
  return n;
}

function parseStringField(
  field: (typeof STRING_MATCH_FIELDS)[number],
  v: unknown,
  where: string,
  warnings: string[]
): StrOrList | null {
  const list = Array.isArray(v) ? v : [v];
  if (list.length === 0 || list.length > POLICY_MAX_LIST) {
    warnings.push(`${where}.${field} 需要 1–${POLICY_MAX_LIST} 个值`);
    return null;
  }
  const out: string[] = [];
  for (const x of list) {
    if (typeof x !== 'string' || !x.trim()) {
      warnings.push(`${where}.${field} 只能是非空字符串或字符串数组`);
      return null;
    }
    const s = x.trim();
    if (field === 'kind' && !isOrchEventKind(s)) {
      warnings.push(`${where}.kind 未知事件种类「${s}」（可用：${ORCH_EVENT_KINDS.join('/')}）`);
      return null;
    }
    out.push(s);
  }
  return Array.isArray(v) ? out : out[0]!;
}

/** 解析一个匹配条件（订阅策略规则与工作流 waitFor 共用；有错返回 null 并写 warnings） */
export function parsePolicyMatch(raw: unknown, where: string, warnings: string[]): PolicyMatch | null {
  return parseMatch(raw, where, warnings);
}

function parseMatch(raw: unknown, where: string, warnings: string[]): PolicyMatch | null {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    warnings.push(`${where}.match 必须是对象`);
    return null;
  }
  const unknown = Object.keys(raw).filter((k) => !MATCH_FIELDS.includes(k));
  if (unknown.length) {
    // 拼错的字段若被忽略，规则会意外放宽到匹配一切——宁可整条丢弃
    warnings.push(`${where}.match 有未知字段 ${unknown.join(', ')}（可用：${MATCH_FIELDS.join('/')}），整条规则丢弃`);
    return null;
  }
  const match: PolicyMatch = {};
  for (const f of STRING_MATCH_FIELDS) {
    if (raw[f] === undefined) continue;
    const v = parseStringField(f, raw[f], where, warnings);
    if (v === null) return null;
    (match as Record<string, unknown>)[f] = v;
  }
  for (const f of BOOL_MATCH_FIELDS) {
    if (raw[f] === undefined) continue;
    if (typeof raw[f] !== 'boolean') {
      warnings.push(`${where}.match.${f} 必须是 true/false`);
      return null;
    }
    match[f] = raw[f] as boolean;
  }
  return match;
}

function mayTouchFloor(match: PolicyMatch): boolean {
  const kinds = asList(match.kind as StrOrList | undefined);
  return POLICY_FLOOR.some((f) => {
    const fk = f.match.kind as string;
    return !kinds || kinds.some((k) => k.toLowerCase() === fk);
  });
}

export function parseSubscriptionPolicy(raw: unknown): PolicyParseResult {
  const warnings: string[] = [];
  const notices: string[] = [];
  const policy = emptySubscriptionPolicy();
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { policy, warnings: ['策略文件不是合法 JSON，按空策略（全部内置默认）处理'], notices };
    }
  }
  if (obj === undefined || obj === null) return { policy, warnings, notices };
  if (!isPlainObject(obj)) {
    return { policy, warnings: ['策略必须是 JSON 对象，按空策略处理'], notices };
  }

  if (obj.rules !== undefined) {
    if (!Array.isArray(obj.rules)) {
      warnings.push('rules 必须是数组，已忽略');
    } else {
      let list = obj.rules;
      if (list.length > POLICY_MAX_RULES) {
        warnings.push(`rules 最多 ${POLICY_MAX_RULES} 条，超出部分已丢弃`);
        list = list.slice(0, POLICY_MAX_RULES);
      }
      const seen = new Set<string>();
      list.forEach((r, i) => {
        const where = `rules[${i}]`;
        if (!isPlainObject(r)) {
          warnings.push(`${where} 必须是对象，已丢弃`);
          return;
        }
        const action = typeof r.action === 'string' ? r.action.trim() : '';
        if (!(POLICY_ACTIONS as readonly string[]).includes(action)) {
          warnings.push(`${where}.action 必须是 ${POLICY_ACTIONS.join('/')}，已丢弃`);
          return;
        }
        const match = parseMatch(r.match, where, warnings);
        if (!match) return;
        let id = typeof r.id === 'string' ? r.id.trim().slice(0, POLICY_ID_MAX) : '';
        if (!id) id = `rule-${i + 1}`;
        if (id.startsWith(BUILTIN_ID_PREFIX)) {
          warnings.push(`${where}.id「${id}」使用了保留前缀 builtin.，已改名`);
          id = `user.${id.slice(BUILTIN_ID_PREFIX.length)}`;
        }
        let uniq = id;
        for (let n = 2; seen.has(uniq); n++) uniq = `${id}-${n}`;
        seen.add(uniq);
        const rule: PolicyRule = { id: uniq, match, action: action as PolicyAction };
        if (typeof r.note === 'string' && r.note.trim()) rule.note = r.note.trim().slice(0, POLICY_NOTE_MAX);
        if (rule.action !== 'wake' && mayTouchFloor(match)) {
          notices.push(`${where}（${uniq}）可能命中底线事件；底线事件（${POLICY_FLOOR.map((f) => f.why).join('、')}）仍会唤醒`);
        }
        policy.rules.push(rule);
      });
    }
  }

  if (obj.timing !== undefined) {
    if (!isPlainObject(obj.timing)) {
      warnings.push('timing 必须是对象，已忽略');
    } else {
      const mergeWindowMs = clampMs(obj.timing.mergeWindowMs, POLICY_TIMING_BOUNDS.mergeWindowMs, 'timing.mergeWindowMs', warnings);
      let maxWaitMs = clampMs(obj.timing.maxWaitMs, POLICY_TIMING_BOUNDS.maxWaitMs, 'timing.maxWaitMs', warnings);
      const window = mergeWindowMs ?? ORCH_WAKE_DEFAULTS.mergeWindowMs;
      if (maxWaitMs !== undefined && maxWaitMs < window) {
        warnings.push(`timing.maxWaitMs 不能小于合并窗口（${window}），已抬到窗口值`);
        maxWaitMs = window;
      }
      if (mergeWindowMs !== undefined) policy.timing.mergeWindowMs = mergeWindowMs;
      if (maxWaitMs !== undefined) policy.timing.maxWaitMs = maxWaitMs;
    }
  }

  if (obj.guards !== undefined) {
    if (!isPlainObject(obj.guards)) {
      warnings.push('guards 必须是对象，已忽略');
    } else {
      for (const key of Object.keys(POLICY_GUARD_BOUNDS) as (keyof PolicyGuards)[]) {
        const v = clampMs(obj.guards[key], POLICY_GUARD_BOUNDS[key], `guards.${key}`, warnings);
        if (v !== undefined) policy.guards[key] = v;
      }
      const unknown = Object.keys(obj.guards).filter((k) => !(k in POLICY_GUARD_BOUNDS));
      if (unknown.length) warnings.push(`guards 有未知字段 ${unknown.join(', ')}，已忽略（开关守卫请用 rules 把对应 kind 设为 mute）`);
    }
  }

  if (typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)) policy.updatedAt = obj.updatedAt;
  if (typeof obj.updatedBy === 'string' && obj.updatedBy.trim()) policy.updatedBy = obj.updatedBy.trim().slice(0, POLICY_ID_MAX);
  if (typeof obj.reason === 'string' && obj.reason.trim()) policy.reason = obj.reason.trim().slice(0, POLICY_REASON_MAX);
  return { policy, warnings, notices };
}

// ---------------------------------------------------------------------------
// 给调度看的生效策略全貌（scheduler.policy.get）
// ---------------------------------------------------------------------------

export interface PolicyRuleStat {
  hits: number;
  lastAt: number;
  byAction: Partial<Record<PolicyAction, number>>;
}

export function describeSubscriptionPolicy(
  policy: SubscriptionPolicy,
  extras: { stats?: Record<string, PolicyRuleStat>; warnings?: string[] } = {}
): Record<string, unknown> {
  return {
    file: SUBSCRIPTION_POLICY_FILE,
    order: '用户规则按序首中 → 内置默认规则按序首中 → 底线事件无论命中什么都唤醒',
    actions: {
      wake: '入队，按合并窗口唤醒你',
      digest: '不单独唤醒，捎带进下一次唤醒消息的「顺带」段',
      mute: '丢弃'
    },
    matchFields:
      'kind（事件种类，可数组）/ trigger（phase 相位或 event.subscription 的事件类型）/ factKind（fact 的订阅种类或 event.subscription 的来源）/ sessionId / orchestrated；workflow 的 trigger 为 started/phase/ask/ask_human/completed/failed/interrupted/trigger_blocked；写了的字段全部命中，字符串可给数组表示任一',
    eventKinds: Object.fromEntries(ORCH_EVENT_KINDS.map((k) => [k, orchEventKindLabel(k)])),
    userRules: policy.rules,
    builtinRules: BUILTIN_POLICY_RULES,
    floor: POLICY_FLOOR.map((f) => ({ match: f.match, why: f.why })),
    timing: {
      effective: effectivePolicyTiming(policy),
      defaults: { mergeWindowMs: ORCH_WAKE_DEFAULTS.mergeWindowMs, maxWaitMs: ORCH_WAKE_DEFAULTS.maxWaitMs },
      bounds: POLICY_TIMING_BOUNDS
    },
    guards: {
      effective: effectivePolicyGuards(policy),
      defaults: {
        heartbeatMs: ORCH_GUARD_DEFAULTS.heartbeatMs,
        needsYouMs: ORCH_GUARD_DEFAULTS.needsYouMs,
      },
      bounds: POLICY_GUARD_BOUNDS
    },
    ...(policy.updatedAt ? { updatedAt: policy.updatedAt } : {}),
    ...(policy.reason ? { reason: policy.reason } : {}),
    stats: extras.stats ?? {},
    ...(extras.warnings?.length ? { warnings: extras.warnings } : {})
  };
}

/** 落盘形态（稳定键序，便于人读与比对） */
export function serializeSubscriptionPolicy(policy: SubscriptionPolicy): Record<string, unknown> {
  return {
    version: 1,
    ...(policy.reason ? { reason: policy.reason } : {}),
    ...(policy.updatedAt ? { updatedAt: policy.updatedAt } : {}),
    ...(policy.updatedBy ? { updatedBy: policy.updatedBy } : {}),
    rules: policy.rules,
    timing: policy.timing,
    guards: policy.guards
  };
}
