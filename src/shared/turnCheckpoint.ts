/**
 * 轮内增量 checkpoint 元信息（zcode-adopt-batch-d D4 / S2.4）。
 * Assistant 行带 checkpointState/checkpointReason（tool_completed|part_boundary|
 * periodic）——撤销粒度到工具边界，不是只在轮末。rewind 入口收敛到编辑历史
 * （不独立 /rewind 命令）；fork/rewind 全实现后置。
 * 零依赖（test/*.mjs 即时转译导入）。
 */

/* ─────────────────── checkpoint 元信息 ─────────────────── */

/** 轮内增量 checkpoint 态：partial = 轮内可回退点；settled = 轮末收口 */
export type CheckpointState = 'partial' | 'settled';

/** checkpoint 落账原因：工具边界 / 片段边界 / 周期 */
export type CheckpointReason = 'tool_completed' | 'part_boundary' | 'periodic';

export const CHECKPOINT_STATES: readonly CheckpointState[] = ['partial', 'settled'];
export const CHECKPOINT_REASONS: readonly CheckpointReason[] = [
  'tool_completed',
  'part_boundary',
  'periodic'
];

/** 周期 checkpoint 最小间隔（ms；轮内无事件时的兜底打点） */
export const PERIODIC_CHECKPOINT_INTERVAL_MS = 30_000;

/** 单条 assistant 行的 checkpoint 条数上限（元信息 ~100B/条；超限丢最旧，防超长工具轮无界膨胀） */
export const CHECKPOINT_MAX_PER_MESSAGE = 200;

/** 落在 assistant 行上的单条 checkpoint 元信息 */
export interface TurnCheckpoint {
  state: CheckpointState;
  reason: CheckpointReason;
  /** 落账时刻 */
  at: number;
  /** 轮内序号（1-based，便于回放/对账） */
  seq: number;
  /** 关联工具卡（reason=tool_completed 时必填） */
  toolCallId?: string;
}

/** 可落账的消息最小面（GuiChatMessage / 测试构造都满足） */
export interface CheckpointableMessage {
  checkpoints?: TurnCheckpoint[];
  checkpointState?: CheckpointState;
  checkpointReason?: CheckpointReason;
}

export function parseCheckpointReason(v: unknown): CheckpointReason | null {
  return typeof v === 'string' && (CHECKPOINT_REASONS as readonly string[]).includes(v)
    ? (v as CheckpointReason)
    : null;
}

export function parseCheckpointState(v: unknown): CheckpointState | null {
  return typeof v === 'string' && (CHECKPOINT_STATES as readonly string[]).includes(v)
    ? (v as CheckpointState)
    : null;
}

/** 事件 → reason 归类（tool 完成 / 片段边界 / 周期兜底） */
export function classifyCheckpointReason(input: {
  kind: 'tool_completed' | 'part_boundary' | 'periodic';
}): CheckpointReason {
  return input.kind;
}

/**
 * 是否该打周期 checkpoint：无历史即打；距上一条 ≥ 间隔即打。
 */
export function shouldPeriodicCheckpoint(
  last: TurnCheckpoint | null | undefined,
  now: number
): boolean {
  if (!last) return true;
  return now - last.at >= PERIODIC_CHECKPOINT_INTERVAL_MS;
}

/**
 * checkpoint 落账：把元信息追加到 assistant 行（checkpoints[]）并同步
 * 行级摘要字段（checkpointState/Reason——「Assistant 行带」的契约形状）。
 * 轮内增量点恒为 partial；settled 仅轮末收口调用（reason 保留最后一次）。
 */
export function stampCheckpoint(
  msg: CheckpointableMessage,
  input: {
    reason: CheckpointReason;
    at: number;
    state?: CheckpointState;
    toolCallId?: string;
  }
): TurnCheckpoint {
  const reason = parseCheckpointReason(input.reason) ?? 'part_boundary';
  const state: CheckpointState = input.state === 'settled' ? 'settled' : 'partial';
  const prev = msg.checkpoints ?? [];
  const kept = prev.length >= CHECKPOINT_MAX_PER_MESSAGE
    ? prev.slice(prev.length - CHECKPOINT_MAX_PER_MESSAGE + 1)
    : prev;
  const mark: TurnCheckpoint = {
    state,
    reason,
    at: Number(input.at) || 0,
    // seq 按已落账的最大值单调 +1（裁剪最旧后不回退）
    seq: (prev[prev.length - 1]?.seq ?? 0) + 1,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {})
  };
  msg.checkpoints = [...kept, mark];
  msg.checkpointState = state;
  msg.checkpointReason = reason;
  return mark;
}

/** 轮末收口：盖 settled（无中间 checkpoint 时补一条轮末点） */
export function settleCheckpoints(msg: CheckpointableMessage, at: number): TurnCheckpoint {
  const prev = msg.checkpoints ?? [];
  const last = prev[prev.length - 1];
  if (last && last.state === 'settled') return last;
  return stampCheckpoint(msg, {
    reason: last ? last.reason : 'part_boundary',
    at,
    state: 'settled'
  });
}

/* ─────────────────── rewind 入口收敛到编辑历史 ─────────────────── */

/**
 * 产品裁决：独立 /rewind 命令已死——rewind 只走编辑历史入口（编辑用户
 * 消息 = editUserQuery 的 UI 入口），不再提供 slash 命令通道。
 */
export const HAS_STANDALONE_REWIND_COMMAND = false;

/** 被禁用的独立 rewind 命令名（契约词表，供命令注册表拒绝用） */
export const FORBIDDEN_REWIND_COMMANDS: readonly string[] = ['rewind', '/rewind'];

export function isStandaloneRewindCommand(name: string): boolean {
  const n = (name ?? '').trim().replace(/^\//, '').toLowerCase();
  return FORBIDDEN_REWIND_COMMANDS.includes(n) || FORBIDDEN_REWIND_COMMANDS.includes(`/${n}`);
}

/** 编辑历史里的一条 rewind 入口（用户消息停靠点） */
export interface RewindEditEntry {
  userMessageId: string;
  ts: number;
  /** 该编辑点之后最近的一个工具边界 checkpoint（可回退目标） */
  checkpoint?: TurnCheckpoint;
}

/** 可提取 rewind 入口的消息最小面 */
export interface RewindScanMessage {
  id: string;
  role: string;
  ts?: number;
  createdAt?: number;
  /** 宿主注入/调度注入不是人手编辑点 */
  host?: boolean;
  source?: string;
  queued?: boolean;
  checkpoints?: TurnCheckpoint[];
}

function messageTs(m: RewindScanMessage): number {
  return typeof m.ts === 'number' ? m.ts : typeof m.createdAt === 'number' ? m.createdAt : 0;
}

/** 人在输入框手打的用户消息（非宿主通栏、非调度注入、非排队） */
export function isHumanUserMessage(m: RewindScanMessage): boolean {
  return m.role === 'user' && !m.host && m.source !== 'scheduler' && m.source !== 'agent' && !m.queued;
}

/**
 * 从消息流提取 rewind 入口：每个人手用户消息一条；checkpoint 取该消息
 * 之后（到下一条用户消息前）最后一个工具边界/增量点，作为可回退目标。
 */
export function listRewindEditEntries(
  messages: readonly RewindScanMessage[]
): RewindEditEntry[] {
  const out: RewindEditEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (!isHumanUserMessage(m)) continue;
    let checkpoint: TurnCheckpoint | undefined;
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j]!;
      if (isHumanUserMessage(n)) break;
      const marks = n.checkpoints ?? [];
      const last = marks[marks.length - 1];
      if (last && last.reason === 'tool_completed') checkpoint = last;
    }
    out.push({
      userMessageId: m.id,
      ts: messageTs(m),
      ...(checkpoint ? { checkpoint } : {})
    });
  }
  return out;
}

/**
 * 解析 rewind 目标：只接受编辑历史入口（用户消息 id），拒绝独立命令名。
 * 返回入口条目；找不到返回 null。
 */
export function resolveRewindEntry(
  messages: readonly RewindScanMessage[],
  userMessageId: string
): RewindEditEntry | null {
  const id = (userMessageId ?? '').trim();
  if (!id || isStandaloneRewindCommand(id)) return null;
  return listRewindEditEntries(messages).find((e) => e.userMessageId === id) ?? null;
}
