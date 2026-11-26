/**
 * 会话历史面板（ChatHistoryPanel）的停靠点模型：每条用户消息一条，附该轮助手
 * 回复的末段正文（原左缘对话导航条复用同一模型，名字保留）。
 * 纯函数、仅 type-only 依赖（test/turn-rail.mjs 即时转译导入锁行为）。
 * 入参是最小结构类型：GuiChatMessage（ts/parts）与 ChatMessage（createdAt/content，parts 可选）两种会话消息模型都满足。
 */

/** 两种会话消息模型（GuiChatMessage / ChatMessage）公共形状的最小结构类型 */
export interface TurnRailSourceMessage {
  id: string;
  role: 'user' | 'assistant';
  queued?: boolean;
  /** 宿主注入（编排事件/审计副本）：进模型但不是人发的用户回合 */
  host?: boolean;
  /** /status 等本地回显，不属于 AI 回复 */
  local?: boolean;
  /** 历史调度来源消息：引擎是 user 回合，但不是人手打 */
  source?: string;
  /** Harness 透明插话（'host'=宿主静默插话，不是停靠点级用户回合） */
  steering?: string;
  /** GuiChatMessage 用 ts、ChatMessage 用 createdAt */
  ts?: number;
  createdAt?: number;
  /** 调度消息可能仅有 content、没有 parts */
  content?: string;
  parts?: ReadonlyArray<{ kind: string; text?: string }>;
  images?: ReadonlyArray<unknown>;
}

/** 引擎侧用户回合（含调度注入）；宿主通栏与静默插话除外。贴底 / 重试界线用这个。 */
export function isUserTurnMessage(m: { role?: string; host?: boolean; steering?: string }): boolean {
  return m.role === 'user' && !m.host && m.steering !== 'host';
}

/** 人在输入框手打的用户消息（非宿主通栏、非调度注入）。历史停靠点用这个。 */
export function isHumanUserMessage(m: { role?: string; host?: boolean; source?: string; steering?: string }): boolean {
  return isUserTurnMessage(m) && m.source !== 'scheduler' && m.source !== 'agent';
}

export interface AbortedTurnScanMessage {
  id: string;
  role: 'user' | 'assistant';
  aborted?: boolean;
  queued?: boolean;
  host?: boolean;
  source?: string;
  steering?: string;
  local?: boolean;
}

export interface AbortedTurnLocation {
  userIdx: number;
  assistantIdx: number;
  userMessageId: string;
  assistantMessageId: string;
}

/**
 * 定位最近一轮被用户手动终止（assistant.aborted）的回合及其对应的用户输入消息：
 * - 从尾部往前跳过排队（queued）、本地回显（local）与宿主静默插话（steering:'host'）；
 * - 若尾部最近一条非跳过消息不是带 aborted 的 assistant，说明末轮未终止或已有新输入，返回 null；
 * - 从该 aborted assistant 往前找同轮的用户输入消息（跳过 queued/local/steering:'host'，
 *   遇到上一轮 assistant 或非人工用户消息即停止），命中人工用户消息（isHumanUserMessage）则返回其下标与 id。
 */
export function locateAbortedTurn(
  messages: readonly AbortedTurnScanMessage[],
  targetUserMessageId?: string
): AbortedTurnLocation | null {
  let assistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.queued || m.local || m.steering === 'host') continue;
    if (m.role !== 'assistant' || !m.aborted) return null;
    assistantIdx = i;
    break;
  }
  if (assistantIdx < 0) return null;
  for (let j = assistantIdx - 1; j >= 0; j--) {
    const u = messages[j]!;
    if (u.queued || u.local || u.steering === 'host') continue;
    if (u.role === 'assistant') return null;
    if (!isHumanUserMessage(u)) return null;
    if (targetUserMessageId && u.id !== targetUserMessageId) return null;
    return {
      userIdx: j,
      assistantIdx,
      userMessageId: u.id,
      assistantMessageId: messages[assistantIdx]!.id
    };
  }
  return null;
}

export interface TurnRailStop {
  /** 用户消息 id（消息锚点 data-mid 与 React key 共用） */
  id: string;
  ts: number;
  /** 用户消息纯文本（空串 = 仅图片附件） */
  prompt: string;
  /** 该轮助手回复的最后一个非空 text part；旧调度消息无 parts 时回退 content */
  reply: string;
  /** 用户消息是否带图片附件 */
  hasImages: boolean;
}

function textOf(m: TurnRailSourceMessage): string {
  const text = (m.parts ?? [])
    .filter((p) => p.kind === 'text')
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  return text || m.content?.trim() || '';
}

function lastTextPartOf(m: TurnRailSourceMessage): string {
  const parts = m.parts ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]!;
    if (part.kind === 'text' && part.text?.trim()) return part.text.trim();
  }
  return m.content?.trim() || '';
}

export function getTurnRailPrompt(m: TurnRailSourceMessage): Omit<TurnRailStop, 'reply'> | null {
  if (!isHumanUserMessage(m) || m.queued) return null;
  const prompt = textOf(m);
  const hasImages = !!m.images?.length;
  if (!prompt && !hasImages) return null;
  return { id: m.id, ts: m.ts ?? m.createdAt ?? 0, prompt, hasImages };
}

/**
 * 从消息流提取导航停靠点：非 queued 且有正文/图片的用户消息各一格；
 * 回复摘录取该轮内（到下一条人工用户消息为止）最后一段助手正文。
 */
export function buildTurnRailStops(messages: readonly TurnRailSourceMessage[]): TurnRailStop[] {
  const stops: TurnRailStop[] = [];
  for (let i = 0; i < messages.length; i++) {
    const entry = getTurnRailPrompt(messages[i]!);
    if (!entry) continue;
    let reply = '';
    for (let j = i + 1; j < messages.length; j++) {
      const a = messages[j]!;
      if (isHumanUserMessage(a) && !a.queued) break;
      if (a.role === 'assistant' && !a.local) {
        const text = lastTextPartOf(a);
        if (text) reply = text;
      }
    }
    stops.push({ ...entry, reply });
  }
  return stops;
}
