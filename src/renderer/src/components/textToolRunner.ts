/**
 * 文本工具运行状态单例（无 React 依赖，对齐 selectionMenuController 模式）。
 * 同一时刻只保留一个在途请求：新请求/关闭卡片即放弃旧结果（IPC 不可中断，
 * 超时由主进程 60s 兜底）；结果卡经 useSyncExternalStore 订阅。
 *
 * 流式：带 runId 发起，增量经 textTools:chunk 事件回来按 runId 对齐；
 * chunk 进 buffer，50ms 合批刷进状态（对齐 store.tsx 的 delta 合批思路），
 * invoke 的最终返回仍是权威全文。
 */
import { t } from '../../../shared/i18n';
import type { TextToolFunction, TextToolRunRequest } from '../../../shared/types';

export interface TextToolRunState {
  /** 递增序号：同卡片「重新生成」走新请求但复用定位 */
  seq: number;
  /** 当次请求 id：chunk 事件对齐用 */
  runId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  /** 流式期间为已收到的部分文本；完成后为权威全文 */
  result?: string;
  error?: string;
  /** 实际使用的「服务商 · 模型」——meta 事件先到（运行中就显示），完成时权威 */
  modelLabel: string;
  /** 模型进入思考段（reasoning_content）：正文尚无增量时的"在工作"信号 */
  reasoning?: boolean;
  /** 触发时浮条矩形（结果卡贴位） */
  barRect: DOMRect | null;
  /** 触发时的功能快照与原文（重新生成用） */
  fn: TextToolFunction;
  text: string;
}

let state: TextToolRunState | null = null;
const listeners = new Set<() => void>();
let inFlightSeq = 0;

/** chunk 合批：50ms 内的增量拼一次 emit，避免每 token 一次 React 渲染 */
let buffer = '';
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function emit(next: TextToolRunState | null): void {
  state = next;
  for (const fn of listeners) fn();
}

function flushBuffer(): void {
  flushTimer = null;
  if (!state || state.status !== 'running' || !buffer) return;
  emit({ ...state, result: (state.result ?? '') + buffer });
  buffer = '';
}

export function subscribeTextToolRun(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function readTextToolRun(): TextToolRunState | null {
  return state;
}

// 模块级订阅一次：只认当前在途请求的 runId
window.api.on('textTools:chunk', ({ runId, delta, modelLabel, reasoning }) => {
  if (!state || state.status !== 'running' || state.runId !== runId) return;
  if (modelLabel || reasoning) {
    emit({ ...state, modelLabel: modelLabel || state.modelLabel, reasoning: reasoning || state.reasoning });
  }
  if (!delta) return;
  buffer += delta;
  if (!flushTimer) flushTimer = setTimeout(flushBuffer, 50);
});

function newRunId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function startTextToolRun(fn: TextToolFunction, text: string, barRect: DOMRect | null): void {
  const seq = (state?.seq ?? 0) + 1;
  const runId = newRunId();
  inFlightSeq = seq;
  buffer = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const req: TextToolRunRequest = {
    name: fn.name,
    prompt: fn.prompt,
    providerId: fn.providerId,
    modelId: fn.modelId,
    text,
    runId,
    noThinking: fn.noThinking
  };
  emit({
    seq,
    runId,
    name: fn.name,
    status: 'running',
    modelLabel: '',
    reasoning: false,
    barRect,
    fn,
    text
  });
  window.api.textTools.run(req).then(
    (res) => {
      if (inFlightSeq !== seq) return;
      inFlightSeq = 0;
      emit({ ...state!, status: 'done', result: res.text, modelLabel: res.modelLabel });
    },
    (e: unknown) => {
      if (inFlightSeq !== seq) return;
      inFlightSeq = 0;
      emit({ ...state!, status: 'error', error: (e as Error)?.message || t('请求失败') });
    }
  );
}

/** 关闭结果卡：放弃在途结果 */
export function closeTextToolRun(): void {
  inFlightSeq = 0;
  buffer = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  emit(null);
}

/** 原样重跑（功能快照 + 原文 + 贴位不变） */
export function rerunTextTool(): void {
  if (!state) return;
  startTextToolRun(state.fn, state.text, state.barRect);
}
