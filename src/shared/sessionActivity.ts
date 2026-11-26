import type { AgentLifecycle, SessionActivity, StructuredActivityKind } from './types';

/** 明确在途执行不因静默失效；blocked/waiting 的执行仍保留，显示由等待原因决定。 */
export function hasRunningExecution(activity?: SessionActivity): boolean {
  return !!(activity?.guiTurn || activity?.pendingTools?.length || activity?.unpairedTools);
}

export function nextSessionActivity(
  previous: SessionActivity | undefined, kind: StructuredActivityKind, event: string | undefined,
  toolUseId: string | undefined, now: number
): SessionActivity {
  const newTurn = event === 'gui-turn-start' || event === 'user-prompt-submit';
  const pending = new Set(newTurn ? [] : previous?.pendingTools ?? []);
  let unpaired = newTurn ? 0 : previous?.unpairedTools ?? 0;
  if (event === 'shell-start') {
    if (toolUseId) pending.add(toolUseId);
    else unpaired++;
  } else if (event === 'shell-end') {
    if (toolUseId) pending.delete(toolUseId);
    else unpaired = Math.max(0, unpaired - 1);
  }
  return {
    kind, event: event?.slice(0, 64), ts: now,
    ...(kind !== 'idle' ? {
      guiTurn: event?.startsWith('gui-') ? true : previous?.guiTurn,
      pendingTools: [...pending], unpairedTools: unpaired
    } : {})
  };
}

/** 用于确认刚恢复的终端输出；过期只代表没有新输出。 */
export const PTY_OUTPUT_IDLE_MS = 750;

/**
 * 无权威执行事实时，working 静默满 30s 降为 quiet（等待输出），不能推断任务结束。
 * 保留旧常量名兼容消费方；有 GUI 回合/未结束 shell 的会话不使用此阈值。
 */
export const PTY_WORKING_SILENCE_IDLE_MS = 30_000;

/** Generic hook confidence is shared by lifecycle, board and screen fallback. */
export function isFreshActive(activity: SessionActivity | undefined, now: number): boolean {
  return activity?.kind === 'active' && Number.isFinite(activity.ts) &&
    now - activity.ts < PTY_WORKING_SILENCE_IDLE_MS;
}

export interface SessionMonitorFacts {
  type?: string;
  launchKind?: string;
  lifecycle?: string;
  runtimePresence?: 'dormant' | 'starting' | 'running' | 'exited';
  archived?: boolean;
  hidden?: boolean;
  phase?: string;
  activity?: SessionActivity;
  busy?: boolean;
  lastActivityAt?: number;
}

/** Silence can only suggest a stall in an actually active, unsettled runtime.
 * Explicit in-flight execution is slow/quiet work, not evidence of a stall.
 */
export function isSessionStallEligible(s: SessionMonitorFacts): boolean {
  if (s.archived || s.hidden || s.type === 'scheduled' || s.launchKind === 'shell') return false;
  if (s.runtimePresence !== undefined && s.runtimePresence !== 'running') return false;
  if (s.phase === 'idle' || s.phase === 'needs_you' || s.phase === 'done') return false;
  if (s.activity?.kind === 'idle' || s.activity?.kind === 'blocked' || s.activity?.kind === 'waiting_input') return false;
  if (s.busy || hasRunningExecution(s.activity)) return false;
  return s.lifecycle === 'working' || s.lifecycle === 'quiet';
}

export function sessionHasStalled(s: SessionMonitorFacts, now: number, stallMs: number): boolean {
  return isSessionStallEligible(s) && typeof s.lastActivityAt === 'number' &&
    Number.isFinite(s.lastActivityAt) && now - s.lastActivityAt >= stallMs;
}

export function isPtyOutputActive(
  lastOutputAt: number,
  now: number = Date.now(),
  idleMs: number = PTY_OUTPUT_IDLE_MS
): boolean {
  return lastOutputAt > 0 && now - lastOutputAt < idleMs;
}

/**
 * pty 输出启发式的生命周期迁移决策（纯函数，500ms 轮询热路径）。
 * 返回 null = 维持原状态（blocked/exited 不迁移；starting 无输出不迁移；
 * 从未输出不判 working）。阈值非对称：working 用长静默窗，其余用 750ms。
 */
export function nextPtyLifecycle(input: {
  lifecycle: AgentLifecycle;
  activity?: SessionActivity;
  lastOutputAt: number;
  now: number;
}): 'working' | 'quiet' | 'idle' | null {
  const { lifecycle, lastOutputAt, now } = input;
  if (lifecycle === 'blocked' || lifecycle === 'exited') return null;
  if (input.activity?.kind === 'waiting_input') return null;
  if (hasRunningExecution(input.activity)) return 'working';
  if (isFreshActive(input.activity, now)) return 'working';
  // A structured turn end outranks later recap/redraw bytes. New input/start facts revoke it.
  if (input.activity?.kind === 'idle') return 'idle';
  if (lifecycle === 'starting' && lastOutputAt <= 0) return null;
  if (lastOutputAt <= 0) return lifecycle === 'idle' ? 'idle' : 'quiet';
  const silence = now - lastOutputAt;
  const threshold =
    lifecycle === 'working' ? PTY_WORKING_SILENCE_IDLE_MS : PTY_OUTPUT_IDLE_MS;
  return silence < threshold ? 'working' : 'quiet';
}

/** 左栏是否画波形；非 working 一律留空 */
export function sessionListBusy(s: {
  type?: string;
  lifecycle?: string;
  status?: string;
  runtimePresence?: string;
}): boolean {
  if (s.type === 'scheduled') return false;
  if (s.runtimePresence === 'dormant' || s.runtimePresence === 'exited') return false;
  if (s.lifecycle) return s.lifecycle === 'working';
  return s.status === 'running';
}
