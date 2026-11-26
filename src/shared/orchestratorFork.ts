/**
 * 调度会话 fork：截点 / 种子 / 新会话绑定（纯函数，零 Node API）。
 * 主进程 Orchestrator.forkSession 与 test/orchestrator-fork.mjs 共用。
 */
import type { ChatMessage } from './types';
import { t } from './i18n';

export interface OrchestratorForkSeed {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface OrchestratorForkPlan {
  ok: boolean;
  error?: string;
  copied?: ChatMessage[];
  seeds?: OrchestratorForkSeed[];
  title?: string;
}

export interface OrchestratorForkBind {
  display: ChatMessage[];
  piSessionFile: string;
  originalSessionFile?: string;
  queue: [];
  resetPiOnNextSend: false;
}

export interface OrchestratorForkSeedPayload {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string }>;
  timestamp: number;
  api?: string;
  provider?: string;
  model?: string;
  usage?: typeof FORK_ZERO_USAGE;
  stopReason?: 'stop';
}

/** 与 GUI Pi driver 同款：种子 assistant 的占位用量 */
export const FORK_ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

/** 取进引擎的正文：助手优先 parts 文本，否则 content；空串=跳过 */
export function orchestratorForkSeedText(m: ChatMessage): string {
  if (m.local) return '';
  if (m.role === 'user') return (m.content ?? '').trim();
  const fromParts = (m.parts ?? [])
    .filter((p) => p.kind === 'text')
    .map((p) => p.text ?? '')
    .join('\n\n')
    .trim();
  return fromParts || (m.content ?? '').trim();
}

/** 复制到新会话的 UI 消息：剥 queued / 计划卡 / 提问卡 / 重试提示 */
export function cloneOrchestratorForkMessage(m: ChatMessage): ChatMessage {
  const clone: ChatMessage = {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt
  };
  if (m.parts) clone.parts = structuredClone(m.parts);
  if (m.images) clone.images = m.images.map((img) => ({ ...img }));
  if (m.thinking) clone.thinking = m.thinking;
  if (m.toolCalls) clone.toolCalls = structuredClone(m.toolCalls);
  if (m.displayItems) clone.displayItems = structuredClone(m.displayItems);
  if (m.aborted) clone.aborted = true;
  if (m.error) clone.error = m.error;
  if (m.host) clone.host = true;
  if (m.source === 'scheduler' || m.source === 'agent') clone.source = m.source;
  if (m.source === 'agent' && m.sourceAgent) clone.sourceAgent = { ...m.sourceAgent };
  return clone;
}

export function toOrchestratorForkSeeds(messages: readonly ChatMessage[]): OrchestratorForkSeed[] {
  const seeds: OrchestratorForkSeed[] = [];
  for (const m of messages) {
    const text = orchestratorForkSeedText(m);
    if (!text) continue;
    seeds.push({ role: m.role, text, ts: m.createdAt });
  }
  return seeds;
}

export function forkedOrchestratorTitle(copied: readonly ChatMessage[]): string {
  const first = copied.find((m) => m.role === 'user' && !m.host && m.content.trim());
  const name = (first?.content ?? '').trim().slice(0, 40) || t('调度');
  return t('Fork · {{name}}', { name });
}

/**
 * 截到 fork 点（含该消息）并产出种子。busy / 空会话 / 缺切点 /
 * 截点前剥完 local 后无可带正文 → 失败（error 必有值）。
 * 原会话消息数组不修改。
 */
export function planOrchestratorFork(input: {
  busy: boolean;
  messages: readonly ChatMessage[];
  uptoMessageId: string;
}): OrchestratorForkPlan {
  if (input.busy) {
    return { ok: false, error: t('当前回合进行中，请等回合结束再 fork') };
  }
  if (!input.messages.length) {
    return { ok: false, error: t('会话还没有消息，直接发消息即可') };
  }
  const cut = input.messages.findIndex((m) => m.id === input.uptoMessageId);
  if (cut < 0) {
    return { ok: false, error: t('fork 点不存在（消息可能已被清空）') };
  }
  const copied = input.messages
    .slice(0, cut + 1)
    .filter((m) => !m.local)
    .map(cloneOrchestratorForkMessage);
  const seeds = toOrchestratorForkSeeds(copied);
  if (!seeds.length) {
    return { ok: false, error: t('分叉点之前没有可带上的正文消息') };
  }
  return {
    ok: true,
    copied,
    seeds,
    title: forkedOrchestratorTitle(copied)
  };
}

/** 新会话绑定：切到新 Pi 文件，记下原文件（原会话不动、可从历史抽屉打开） */
export function bindOrchestratorFork(args: {
  copied: ChatMessage[];
  newSessionFile: string;
  originalSessionFile?: string;
}): OrchestratorForkBind {
  return {
    display: args.copied,
    piSessionFile: args.newSessionFile,
    ...(args.originalSessionFile ? { originalSessionFile: args.originalSessionFile } : {}),
    queue: [],
    resetPiOnNextSend: false
  };
}

/** SessionManager.appendMessage 载荷（工具调用不进种子，正文保真） */
export function forkSeedAppendPayloads(
  seeds: readonly OrchestratorForkSeed[],
  modelMeta: { api: string; provider: string; model: string }
): OrchestratorForkSeedPayload[] {
  return seeds.map((seed) => {
    if (seed.role === 'user') {
      return { role: 'user', content: seed.text, timestamp: seed.ts || Date.now() };
    }
    return {
      role: 'assistant',
      content: [{ type: 'text', text: seed.text }],
      api: modelMeta.api,
      provider: modelMeta.provider,
      model: modelMeta.model,
      usage: FORK_ZERO_USAGE,
      stopReason: 'stop',
      timestamp: seed.ts || Date.now()
    };
  });
}

/** A lazy semantic prefix: callers may write a large archive without retaining
 * another array of message bodies or seed payloads. */
export function* iterateOrchestratorForkMessages(messages: readonly ChatMessage[], end = messages.length): IterableIterator<ChatMessage> {
  for (let index = 0; index < Math.min(end, messages.length); index++) {
    const message = messages[index];
    if (!message.local) yield message;
  }
}

export function* iterateOrchestratorForkSeeds(messages: Iterable<ChatMessage>): IterableIterator<OrchestratorForkSeed> {
  for (const message of messages) {
    const text = orchestratorForkSeedText(message);
    if (text) yield { role: message.role, text, ts: message.createdAt };
  }
}

export function planOrchestratorForkRange(input: { busy: boolean; messages: readonly ChatMessage[]; uptoMessageId: string }): {ok: boolean; end?: number; title?: string; error?: string} {
  if (input.busy) return {ok: false, error: t('当前回合进行中，请等回合结束再 fork')};
  if (!input.messages.length) return {ok: false, error: t('会话还没有消息，直接发消息即可')};
  const cut = input.messages.findIndex(message => message.id === input.uptoMessageId);
  if (cut < 0) return {ok: false, error: t('fork 点不存在（消息可能已被清空）')};
  let firstUser: ChatMessage | undefined;
  let hasSeed = false;
  for (const message of iterateOrchestratorForkMessages(input.messages, cut + 1)) {
    if (!firstUser && message.role === 'user' && !message.host && message.content.trim()) firstUser = message;
    if (orchestratorForkSeedText(message)) hasSeed = true;
  }
  if (!hasSeed) return {ok: false, error: t('分叉点之前没有可带上的正文消息')};
  return {ok: true, end: cut + 1, title: forkedOrchestratorTitle(firstUser ? [firstUser] : [])};
}
