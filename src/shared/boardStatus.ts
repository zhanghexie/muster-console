/**
 * 看板状态推导：显示状态从不落库。
 * 优先级：进程退出（done/error）→ hook 等待 → phase=done → scheduled →
 * 在途执行/新鲜 active → needs_you → idle phase → 输出 lifecycle（working/quiet）→ 默认 idle。
 * liveStatus.kind 不参与推导（胶囊与列拆开）。
 * 归档灰化不在这里：archived 由 sessionDisplayStatus / sessionBoardColumn 另判。
 */
import type {
  AgentLifecycle,
  SessionActivity,
  SessionMeta,
  SessionPhase,
  TerminalStatus
} from './types';
import { hasRunningExecution, isFreshActive, PTY_WORKING_SILENCE_IDLE_MS } from './sessionActivity';

/** 全局看板只展示顶层工作会话；子孙代理在父会话树中管理。归档列仍可展示顶层。 */
export function isGlobalBoardSession(s: Pick<SessionMeta, 'type' | 'launchKind' | 'parentSessionId'>): boolean {
  return s.type === 'terminal' && s.launchKind !== 'shell' && !s.parentSessionId?.trim();
}

/** no_signal 宽限：starting 超过此时长仍无任何权威信号 */
export const NO_SIGNAL_GRACE_MS = 90_000;

/**
 * activity=active 的新鲜度窗口：超过后不再一锤定音为 working。
 * Cursor CLI 等没有可靠 stop hook 的 runtime，active 没有对端清除信号。
 */
export const ACTIVITY_ACTIVE_FRESH_MS = PTY_WORKING_SILENCE_IDLE_MS;

export interface SessionFacts {
  type: 'terminal' | 'scheduled';
  lifecycle?: AgentLifecycle;
  ptyStatus?: TerminalStatus;
  activity?: SessionActivity;
  phase?: SessionPhase;
  firstSignalAt?: number;
  startedAt?: number;
  now: number;
  runtimePresence?: SessionMeta['runtimePresence'];
}

export type BoardZone = 'working' | 'needsYou' | 'done' | 'archived';

export type BoardStatus =
  | 'working'
  | 'idle'
  | 'quiet'
  | 'blocked'
  | 'waiting'
  | 'error'
  | 'no_signal'
  | 'done'
  | 'exited'
  | 'scheduled';

export const BOARD_ZONE_ORDER: BoardZone[] = ['working', 'needsYou', 'done', 'archived'];

/** 仅新用户回合清掉 phase=done；shell / preToolUse / sessionStart 视为工具链噪声。
 * opencode-turn / codex-turn：runtime 脚本监控从原生会话服务观测到新回合开始
 * （用户在 TUI 提交或宿主投信），语义等同 user-prompt-submit。 */
export function activityClearsDonePhase(kind: string, event?: string): boolean {
  return kind === 'active' && (event === 'user-prompt-submit' || event === 'gui-turn-start' || event === 'opencode-turn' || event === 'codex-turn');
}

/**
 * phase 写入粘性：用户手动标记（source=user）最高权威——model/llm 不得回退其 done/needs_you；
 * llm 亦不得回退 model 的 done/needs_you（既有规则）。user 写入永不被挡（可自行取消）。
 */
export function phaseWriteBlocked(
  prev: Pick<SessionPhase, 'value' | 'source'> | undefined,
  next: Pick<SessionPhase, 'source'>
): boolean {
  if (!prev) return false;
  if (next.source === 'user') return false;
  if (prev.value !== 'done' && prev.value !== 'needs_you') return false;
  if (prev.source === 'user') return true;
  return next.source === 'llm' && prev.source === 'model';
}

function hookActiveFresh(f: SessionFacts): boolean {
  return isFreshActive(f.activity, f.now);
}

export function deriveBoardStatus(f: SessionFacts): BoardStatus {
  if (f.runtimePresence === 'dormant') {
    return f.phase?.value === 'done' ? 'done' : f.phase?.value === 'needs_you' ? 'waiting' : 'idle';
  }
  const act = f.activity?.kind;
  // 已闭环盖过进程退出：合入后 GUI 闲置退出 / pty 退出不得把完成态打成「已退出」灰环。
  // hook 卡住态仍高于 done（Claude PermissionRequest）。未完成的 exited 仍一锤定音。
  const phase = f.phase?.value;
  const exited = f.lifecycle === 'exited' || f.ptyStatus === 'exited';
  if (exited) return phase === 'done' ? 'done' : 'error';
  if (act === 'blocked') return 'blocked';
  if (act === 'waiting_input') return 'waiting';
  if (phase === 'done') return 'done';
  if (f.type === 'scheduled') return 'scheduled';

  // hook active 不得盖过 done（Cursor shell / preToolUse 噪声）。
  // 新用户回合由 applyActivitySignal(user-prompt-submit) 清掉 phase 后再显示 working。
  if (hasRunningExecution(f.activity) || hookActiveFresh(f)) return 'working';

  if (phase === 'needs_you') return 'waiting';
  if (phase === 'idle') return 'idle';

  const lifecycle = f.lifecycle ?? (f.ptyStatus === 'running' ? 'working' : undefined);
  if (lifecycle === 'working') return 'working';
  if (lifecycle === 'quiet') return 'quiet';
  if (lifecycle === 'blocked') return 'blocked';

  const starting = lifecycle === 'starting' || f.ptyStatus === 'starting';
  if (
    starting &&
    f.firstSignalAt === undefined &&
    f.startedAt !== undefined &&
    f.now - f.startedAt > NO_SIGNAL_GRACE_MS
  ) {
    return 'no_signal';
  }
  return 'idle';
}

export function boardZoneOf(status: BoardStatus): BoardZone {
  switch (status) {
    case 'working':
    case 'idle':
    case 'quiet':
      return 'working';
    case 'blocked':
    case 'waiting':
    case 'error':
    case 'no_signal':
      return 'needsYou';
    case 'done':
      return 'done';
    case 'exited':
    case 'scheduled':
      return 'archived';
  }
}

export function boardStatusOfSession(s: SessionMeta, now: number = Date.now()): BoardStatus {
  return deriveBoardStatus({
    type: s.type,
    lifecycle: s.lifecycle,
    ptyStatus: s.status,
    activity: s.activity,
    phase: s.phase,
    firstSignalAt: s.firstSignalAt,
    startedAt: s.runtimeStartedAt ?? s.createdAt,
    runtimePresence: s.runtimePresence,
    now
  });
}

/** 左栏/看板图标：只有真正 archived 才灰化；未归档的 done+exited 走完成态。 */
export function sessionDisplayStatus(s: SessionMeta, now: number = Date.now()): BoardStatus {
  if (s.archived) return 'exited';
  return boardStatusOfSession(s, now);
}

/** 看板列：归档列只收 archived；done（含进程已退出）走已完成列。 */
export function sessionBoardColumn(s: SessionMeta, now: number = Date.now()): BoardZone {
  if (s.archived) return 'archived';
  return boardZoneOf(boardStatusOfSession(s, now));
}
