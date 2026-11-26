/**
 * 无头 LLM 读屏分类：门控纯函数（主进程调 LLM 前先问这里）。
 * 不依赖 process / node:，渲染层也可引用常量。
 */
import type { SessionActivity, SessionPhase, SessionPhaseKind } from './types';
import { hasRunningExecution, isFreshActive, PTY_WORKING_SILENCE_IDLE_MS } from './sessionActivity';

export const SCREEN_CLASSIFY_GRACE_MS = 90_000;
export const SCREEN_CLASSIFY_STALE_MS = 5 * 60_000;
export const SCREEN_CLASSIFY_MIN_INTERVAL_MS = 45_000;
/** 喂给分类器的纯文本上限（与旧 detect 窗口同量级） */
export const SCREEN_CLASSIFY_MAX_CHARS = 12_000;

const PHASES = new Set<string>(['idle', 'needs_you', 'done']);

export interface ScreenClassifyCheapInput {
  now: number;
  createdAt: number;
  lifecycle?: string;
  activity?: SessionActivity;
  phase?: SessionPhase;
  lastClassifyAt?: number;
  inFlight?: boolean;
  nextAllowedAt?: number;
}

export interface ScreenClassifyGateInput extends ScreenClassifyCheapInput {
  lastHash?: string;
  currentHash: string;
}

export type ScreenClassifySkipReason =
  | 'exited'
  | 'in_flight'
  | 'hash_unchanged'
  | 'interval'
  | 'backoff'
  | 'fresh_hook_active'
  | 'hook_idle'
  | 'hook_needs_you'
  | 'model_terminal'
  | 'signals_fresh'
  | 'grace';

export function hashScreenText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

export function parseScreenClassifyOutput(raw: string): SessionPhaseKind | 'unknown' {
  const token = raw
    .trim()
    .split(/[\s,，。:：]/)[0]
    ?.toLowerCase()
    .replace(/[^a-z_]/g, '');
  if (token && PHASES.has(token)) return token as SessionPhaseKind;
  return 'unknown';
}

/**
 * 不读 pty 就能否决的门（500ms 轮询热路径）。
 */
export function shouldScreenClassifyCheap(
  input: ScreenClassifyCheapInput
): { ok: true } | { ok: false; reason: ScreenClassifySkipReason } {
  if (input.lifecycle === 'exited') return { ok: false, reason: 'exited' };
  if (input.inFlight) return { ok: false, reason: 'in_flight' };
  if (input.nextAllowedAt !== undefined && input.now < input.nextAllowedAt) {
    return { ok: false, reason: 'backoff' };
  }
  if (
    input.lastClassifyAt !== undefined &&
    input.now - input.lastClassifyAt < SCREEN_CLASSIFY_MIN_INTERVAL_MS
  ) {
    return { ok: false, reason: 'interval' };
  }

  const act = input.activity?.kind;
  const actTs = input.activity?.ts;
  const actAge = actTs !== undefined ? input.now - actTs : Infinity;
  if (act === 'idle') return { ok: false, reason: 'hook_idle' };
  if (act === 'blocked' || act === 'waiting_input') {
    return { ok: false, reason: 'hook_needs_you' };
  }
  if (hasRunningExecution(input.activity) || isFreshActive(input.activity, input.now)) {
    return { ok: false, reason: 'fresh_hook_active' };
  }

  const modelPhase = input.phase?.source === 'model' ? input.phase : undefined;
  if (modelPhase && (modelPhase.value === 'done' || modelPhase.value === 'needs_you')) {
    return { ok: false, reason: 'model_terminal' };
  }

  const phaseAge = input.phase?.ts !== undefined ? input.now - input.phase.ts : Infinity;
  const newestSignalAge = Math.min(actAge, phaseAge);
  const hasAnySignal = input.activity !== undefined || input.phase !== undefined;
  const age = input.now - input.createdAt;

  if (!hasAnySignal) {
    if (age <= SCREEN_CLASSIFY_GRACE_MS) return { ok: false, reason: 'grace' };
    return { ok: true };
  }
  if (newestSignalAge >= (act === 'active' ? PTY_WORKING_SILENCE_IDLE_MS : SCREEN_CLASSIFY_STALE_MS)) return { ok: true };
  return { ok: false, reason: 'signals_fresh' };
}

/**
 * 第三档才允许调 LLM：前两路失效 + 文本变了 + 节流。
 */
export function shouldScreenClassify(
  input: ScreenClassifyGateInput
): { ok: true } | { ok: false; reason: ScreenClassifySkipReason } {
  const cheap = shouldScreenClassifyCheap(input);
  if (!cheap.ok) return cheap;
  if (input.lastHash !== undefined && input.lastHash === input.currentHash) {
    return { ok: false, reason: 'hash_unchanged' };
  }
  return { ok: true };
}
