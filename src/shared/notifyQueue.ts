

export const ORCH_EVENT_KINDS = [
  'phase',
  'turn_end',
  'turn_error',
  'commit',
  'heartbeat_stale',
  'needs_you_stale',
  'slot_free',
  'merge_blocked',
  'settle_warn',
  'dim_gate_red',
  'fact',
  'event.subscription',
  'workflow'
] as const;

export type OrchEventKind = (typeof ORCH_EVENT_KINDS)[number];

export interface OrchEvent {
  id: string;
  kind: OrchEventKind;
  workspaceId: string;
  ts: number;
  /** 同窗口去重键：后到覆盖先到，保留最新 ts/detail */
  key: string;
  sessionId?: string;
  sessionName?: string;
  /** 一行摘要（已裁剪） */
  detail?: string;
}

export const ORCH_WAKE_DEFAULTS = {
  enabled: true,
  mergeWindowMs: 25_000,
  maxWaitMs: 45_000,
  maxEvents: 40,
  busyRetryMs: 2_000
} as const;

export const ORCH_EVENT_DETAIL_MAX = 240;

export function isOrchEventKind(v: unknown): v is OrchEventKind {
  return typeof v === 'string' && (ORCH_EVENT_KINDS as readonly string[]).includes(v);
}

/**
 * 实时上行分级（对照 docs/features/orchestrator-uplink-messages.md）。
 *
 * 降级不入队的只有三类：phase→done、turn_end、commit。
 * 其余 flush kind 全部保留（含 phase→error / turn_error / slot_free）。
 * 即时通道（邮箱收信 / requestIntegrate / 拉起通知 / 异常审计）不经本函数。
 */
export function shouldUplinkOrchEvent(
  kind: OrchEventKind,
  extra?: { phaseTrigger?: string }
): boolean {
  if (kind === 'phase') {
    const trigger = extra?.phaseTrigger?.trim();
    return trigger === 'needs_you' || trigger === 'error';
  }
  return kind !== 'commit' && kind !== 'turn_end';
}

export function clipOrchDetail(text: string | undefined): string | undefined {
  const s = text?.trim();
  if (!s) return undefined;
  return s.slice(0, ORCH_EVENT_DETAIL_MAX);
}

export function orchEventKey(kind: OrchEventKind, workspaceId: string, sessionId?: string, extra?: string): string {
  const sid = sessionId?.trim() || '-';
  const x = extra?.trim() || '';
  return x ? `${kind}:${workspaceId}:${sid}:${x}` : `${kind}:${workspaceId}:${sid}`;
}

export type EnqueueOrchResult = {
  queue: OrchEvent[];
  added: boolean;
  replaced: boolean;
};

/** 同 key 覆盖；超出 maxEvents 丢最旧。 */
export function enqueueOrchEvent(
  queue: readonly OrchEvent[],
  event: OrchEvent,
  maxEvents: number = ORCH_WAKE_DEFAULTS.maxEvents
): EnqueueOrchResult {
  const next = event.detail ? { ...event, detail: clipOrchDetail(event.detail) } : event;
  const idx = queue.findIndex((e) => e.key === next.key);
  if (idx >= 0) {
    const copy = queue.slice();
    copy[idx] = { ...copy[idx]!, ...next, id: copy[idx]!.id };
    return { queue: copy, added: false, replaced: true };
  }
  let copy = [...queue, next];
  if (copy.length > maxEvents) copy = copy.slice(copy.length - maxEvents);
  return { queue: copy, added: true, replaced: false };
}

export type FlushSchedule = {
  /** 距下次应 flush 的毫秒；null=队列空，不要定时 */
  delayMs: number | null;
  reason: 'empty' | 'window' | 'max-wait' | 'due';
};

/**
 * 合并窗口：从首条事件起算，等到 window；若持续有新事件，不超过 first+maxWait。
 * 无事件 → delayMs null（不唤醒）。
 */
export function nextOrchFlushDelay(opts: {
  now: number;
  firstAt: number | null;
  lastAt: number | null;
  windowMs?: number;
  maxWaitMs?: number;
}): FlushSchedule {
  const windowMs = opts.windowMs ?? ORCH_WAKE_DEFAULTS.mergeWindowMs;
  const maxWaitMs = opts.maxWaitMs ?? ORCH_WAKE_DEFAULTS.maxWaitMs;
  if (opts.firstAt == null || opts.lastAt == null) {
    return { delayMs: null, reason: 'empty' };
  }
  const dueWindow = opts.lastAt + windowMs;
  const dueMax = opts.firstAt + maxWaitMs;
  const due = Math.min(dueWindow, dueMax);
  const delay = due - opts.now;
  if (delay <= 0) return { delayMs: 0, reason: 'due' };
  return { delayMs: delay, reason: due === dueMax ? 'max-wait' : 'window' };
}

const KIND_LABEL: Record<OrchEventKind, string> = {
  phase: '相位',
  turn_end: '回合结束',
  turn_error: '回合失败',
  commit: '提交落树',
  heartbeat_stale: '心跳超时',
  needs_you_stale: 'needs_you 无人处理',
  slot_free: '可补位',
  merge_blocked: '合入被挡',
  settle_warn: '收口提醒',
  dim_gate_red: '维度门红灯',
  fact: '订阅',
  'event.subscription': '事件订阅',
  workflow: '工作流'
};

export function orchEventKindLabel(kind: OrchEventKind): string {
  return KIND_LABEL[kind];
}

/** 顺带段上限：digest 事件只随下一次唤醒捎带，不单独唤醒；超限丢最旧 */
export const ORCH_DIGEST_MAX = 20;

/** 解析一行 git reflog（`<old> <new> <who> <ts> <tz>\t<action>: <msg>`）为事件摘要，
 *  如 `commit: fix(ui): adjust workspace badge (0123456)`。纯文本解析不跑子进程；失败返回 null（调用方回落通用文案）。 */
export function formatReflogLine(line: string): string | null {
  const l = line.trim();
  if (!l) return null;
  const tab = l.indexOf('\t');
  const head = (tab < 0 ? l : l.slice(0, tab)).trim().split(/\s+/);
  const newHash = head[1] ?? '';
  if (!/^[0-9a-f]{7,40}$/i.test(newHash)) return null;
  const msg = tab < 0 ? '' : l.slice(tab + 1).trim();
  const short = newHash.slice(0, 7);
  return msg ? `${msg} (${short})` : `ref ${short}`;
}

export function formatOrchEventLine(e: OrchEvent): string {
  const who = e.sessionName?.trim() || e.sessionId || '';
  const whoBit = who ? ` · ${who}` : '';
  const detail = e.detail?.trim();
  return `- [${KIND_LABEL[e.kind]}]${whoBit}${detail ? `：${detail}` : ''}`;
}

/**
 * 聚合成一条调度系统消息。空队列返回空串（调用方不得 send）。
 * digest：订阅策略判为「顺带」的事件，只附在有唤醒事件的消息末尾，自身不构成唤醒。
 */
export function aggregateOrchEvents(
  events: readonly OrchEvent[],
  digest: readonly OrchEvent[] = []
): string {
  if (!events.length) return '';
  const lines = [
    `【编排事件 · ${events.length} 条】`,
    '以下为合并窗口内的可观测事件。一次处理即可；不要为巡检去 sessions.observe 全量侦察。',
    '可做：提醒验收、补位派活、sessions.integrate、或向人汇报。无动作则只汇总。',
    '---',
    ...events.map(formatOrchEventLine),
    '---',
    ...(digest.length
      ? [`顺带（订阅策略设为 digest，不单独唤醒 · ${digest.length} 条）：`, ...digest.map(formatOrchEventLine), '---']
      : []),
  ];
  return lines.join('\n');
}

export type OrchFlushDecision =
  | { action: 'skip'; reason: 'empty' | 'disabled' }
  | { action: 'hold'; reason: 'busy' | 'scheduler-awaiting-answer'; retryMs: number }
  | { action: 'send'; text: string };

/** 工作区相对路径是否像 git reflog（提交落树）。.git 通常被 fs skip，专用 watcher 仍可用。 */
export function isGitReflogRel(rel: string): boolean {
  const n = rel.replace(/\\/g, '/');
  return (
    n === '.git/logs/HEAD' ||
    n.endsWith('/.git/logs/HEAD') ||
    (n.startsWith('.git/worktrees/') && n.endsWith('/logs/HEAD'))
  );
}

/** 调度忙或有待答提问卡时保留归并队列，稍后重试。 */
export function decideOrchFlush(opts: {
  enabled: boolean;
  busy: boolean;
  events: readonly OrchEvent[];
  /** 订阅策略「顺带」事件：只随唤醒捎带，空 events 时不构成发送理由 */
  digest?: readonly OrchEvent[];
  schedulerAwaitingAnswer?: boolean;
  busyRetryMs?: number;
}): OrchFlushDecision {
  if (!opts.enabled) return { action: 'skip', reason: 'disabled' };
  if (!opts.events.length) return { action: 'skip', reason: 'empty' };
  const retryMs = opts.busyRetryMs ?? ORCH_WAKE_DEFAULTS.busyRetryMs;
  if (opts.busy) {
    return { action: 'hold', reason: 'busy', retryMs };
  }
  if (opts.schedulerAwaitingAnswer) {
    return { action: 'hold', reason: 'scheduler-awaiting-answer', retryMs };
  }
  const text = aggregateOrchEvents(opts.events, opts.digest);
  if (!text) return { action: 'skip', reason: 'empty' };
  return { action: 'send', text };
}
