/**
 * 交接等待：idle 防抖 + 复查（对齐飞书 bridge 的 seenWorking → debounce idle）。
 * 自包含、零导入。
 */

export const HANDOVER_IDLE_DEBOUNCE_MS = 2500;
/** 空闲且无文档时的超时（仍在 working 不走这条） */
export const HANDOVER_TIMEOUT_MS = 150_000;
/** 含长时间回合的硬顶：到点即使仍 working 也放弃 */
export const HANDOVER_HARD_TIMEOUT_MS = 600_000;
export const HANDOVER_POLL_MS = 400;

export const HANDOVER_HEADINGS = [
  '任务背景与目标',
  '已完成与结论',
  '进行中与当前状态',
  '关键决策与理由',
  '坑与注意事项',
  '建议下一步'
] as const;

export type HandoverWaitPhase = 'wait-working' | 'wait-idle' | 'debounce' | 'done' | 'timeout';

export interface HandoverWaitState {
  phase: HandoverWaitPhase;
  seenWorking: boolean;
  idleSince: number | null;
  startedAt: number;
}

/** primed：调用方已发出交接指令，不必再等第一轮 working 边沿 */
export function createHandoverWait(now: number, primed = false): HandoverWaitState {
  return {
    phase: primed ? 'wait-idle' : 'wait-working',
    seenWorking: primed,
    idleSince: null,
    startedAt: now
  };
}

export type HandoverWaitAction = 'continue' | 'done' | 'timeout';

/**
 * 一轮轮询：必须先见过 working（或 primed），再在「空闲 + 文档就绪」上防抖；
 * 防抖期间若再次 working 或文档消失则重置计时。
 * 仍在 working 不走 150s 空闲超时；10 分钟硬顶始终生效。
 */
export function handoverWaitTick(
  state: HandoverWaitState,
  now: number,
  flags: { working: boolean; idle: boolean; fileReady: boolean },
  timeoutMs = HANDOVER_TIMEOUT_MS,
  debounceMs = HANDOVER_IDLE_DEBOUNCE_MS,
  hardTimeoutMs = HANDOVER_HARD_TIMEOUT_MS
): { state: HandoverWaitState; action: HandoverWaitAction } {
  if (now - state.startedAt >= hardTimeoutMs) {
    return { state: { ...state, phase: 'timeout' }, action: 'timeout' };
  }
  if (now - state.startedAt >= timeoutMs && !flags.working && !flags.fileReady) {
    return { state: { ...state, phase: 'timeout' }, action: 'timeout' };
  }
  let seenWorking = state.seenWorking;
  let idleSince = state.idleSince;
  let phase: HandoverWaitPhase = state.phase;
  if (flags.working) {
    seenWorking = true;
    idleSince = null;
    phase = 'wait-idle';
  }
  if (!seenWorking) {
    return { state: { ...state, seenWorking, idleSince, phase: 'wait-working' }, action: 'continue' };
  }
  if (flags.idle && flags.fileReady) {
    if (idleSince == null) idleSince = now;
    phase = 'debounce';
    if (now - idleSince >= debounceMs) {
      return {
        state: { phase: 'done', seenWorking, idleSince, startedAt: state.startedAt },
        action: 'done'
      };
    }
  } else {
    idleSince = null;
    phase = 'wait-idle';
  }
  return { state: { phase, seenWorking, idleSince, startedAt: state.startedAt }, action: 'continue' };
}

export function handoverFileReady(content: string | null | undefined): boolean {
  return typeof content === 'string' && content.trim().length > 0;
}

/** 文件或助手回复是否已经是一份可用的交接文档 */
export function handoverLooksComplete(text: string | null | undefined): boolean {
  if (!handoverFileReady(text)) return false;
  const s = String(text);
  const hits = HANDOVER_HEADINGS.filter((h) => s.includes(h)).length;
  if (hits >= 3) return true;
  return s.trim().length >= 400;
}
