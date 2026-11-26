/**
 * 消息模型 → 转写视图的适配层：
 * - GUI 会话（GuiChatMessage）：parts/toolCall 映射 + 审批/提问卡插槽；
 * - 调度会话（ChatMessage 原生）：透传 + askQuestion 提问卡/等待态。
 * 路径链接化不再在映射层做（2026-09-11 起）：映射是纯同步、拿不到磁盘/交互上下文，
 * 语法包装出的死链只能靠点击 toast 兜底；现由 ChatMarkdownBody 在渲染层先渲染原文、
 * 批量 stat 后只把存在的候选包成链接（见 chatSurface/ChatMarkdownBody.tsx）。
 */
import type { ChatDisplayPart, ChatMessage } from '../../../shared/types';
import type { GuiChatMessage } from '../../../shared/guiWorker';
import {
  guiChatMessageEqual,
  guiMessageText,
  sanitizeSuggestedReplies
} from '../../../shared/guiWorker';
import type { TranscriptInlineCards, TranscriptModelBinding } from './ChatTranscript';
import { ApprovalCard, DispatchUserQuestionCard, UserQuestionCard } from './guiApprovalCards';
import { dispatchWaitState } from '../../../shared/orchestratorAskQuestion';
import { TurnChangesCard } from './TurnChangesCard';

export { guiMessageText, guiChatMessageEqual } from '../../../shared/guiWorker';
export { safeJson } from './safeJson';
import { toDisplayToolCall } from './guiToolDisplay';

/** GuiChatMessage → ChatMessage（调度消息视图形状）；text part 原样透传
 *  （路径链接化在渲染层 ChatMarkdownBody，stat 校验后只链真实存在的路径）。 */
export function toDisplayMessage(m: GuiChatMessage): ChatMessage {
  const parts: ChatDisplayPart[] | undefined = m.parts.map((p) =>
    p.kind === 'tool'
      ? { kind: 'tool' as const, toolCall: toDisplayToolCall(p.tool) }
      : p.kind === 'thinking'
        ? { kind: 'thinking' as const, text: p.text }
        : { kind: 'text' as const, text: p.text }
  );
  const last = m.harness?.calls?.at(-1);
  const usage = last?.usage;
  let outputNotice: ChatMessage['outputNotice'];
  if (m.role === 'assistant' && m.finishedAt && !m.error && !m.aborted) {
    if (last?.stopReason === 'length') outputNotice = 'length';
    else if (!last?.stopReason && usage && usage.outputTokens > 0 &&
      usage.outputTokens === usage.reasoningTokens && m.parts.at(-1)?.kind === 'thinking') {
      // Older records have usage but no provider finish reason. Only report what usage establishes.
      outputNotice = 'reasoning-only';
    }
  }
  return {
    ...(outputNotice ? { outputNotice } : {}),
    id: m.id,
    role: m.role,
    content: guiMessageText(m),
    parts,
    ...(m.displayItems?.length ? { displayItems: m.displayItems } : {}),
    ...(m.images?.length ? { images: m.images } : {}),
    createdAt: m.ts,
    ...(m.finishedAt !== undefined ? { finishedAt: m.finishedAt } : {}),
    ...(m.turnChanges ? { turnChanges: m.turnChanges } : {}),
    ...(m.plan ? { plan: m.plan } : {}),
    ...(m.error ? { error: m.error } : {}),
    ...(m.aborted ? { aborted: true } : {}),
    ...(m.retryHint ? { retryHint: m.retryHint } : {}),
    ...(m.queued ? { queued: true } : {}),
    ...(m.host ? { host: true } : {}),
    ...(m.source === 'scheduler' || m.source === 'agent' ? { source: m.source } : {}),
    ...(m.source === 'agent' && m.sourceAgent ? { sourceAgent: m.sourceAgent } : {}),
    ...(m.steering ? { steering: m.steering } : {}),
    ...(m.role === 'assistant' && m.suggestedReplies?.length
      ? { suggestedReplies: sanitizeSuggestedReplies(m.suggestedReplies) }
      : {})
  };
}

/** 末条 assistant 的人机等待态（贴底判定用）：审批 pending / 提问 pending */
export function guiWaitState(
  m: GuiChatMessage | null | undefined
): 'approval' | 'question' | null {
  if (!m || m.role !== 'assistant') return null;
  if (m.approval) return 'approval';
  if (m.userQuestion?.status === 'pending') return 'question';
  return null;
}

/** GUI 会话的转写模型绑定（映射/等价/等待态/审批提问卡） */
export function guiTranscriptBinding(sessionId: string): TranscriptModelBinding<GuiChatMessage> {
  return {
    toDisplay: (m) => toDisplayMessage(m),
    messagesEqual: guiChatMessageEqual,
    waitStateOf: guiWaitState,
    getInlineCards: (m) => guiInlineCards(sessionId, m),
    // Harness 透明（pi-trajectory-plan extension）：插话标记与回合计量直读消息字段
    steeringOf: (m) => m.steering,
    harnessOf: (m) => (m.role === 'assistant' ? m.harness : undefined),
    engineInputRefOf: (m) => m.role === 'user' ? m.engineInputRef : undefined
  };
}

/** 调度会话的转写模型绑定（ChatMessage 原生 + askQuestion 提问卡/等待态）。
 *  suggestedReplies 由 ChatSurfaceView 投影到输入区，不再渲染到消息气泡。 */
export function dispatchTranscriptBinding(workspaceId: string): TranscriptModelBinding<ChatMessage> {
  return {
    toDisplay: (m) => m,
    waitStateOf: dispatchWaitState,
    getInlineCards: (m) => dispatchInlineCards(workspaceId, m)
  };
}

export function dispatchInlineCards(workspaceId: string, m: ChatMessage): TranscriptInlineCards {
  const cards: TranscriptInlineCards = {};
  if (m.turnChanges) cards.changes = <TurnChangesCard summary={m.turnChanges} target={{ kind: 'dispatch', id: workspaceId, messageId: m.id }} />;
  if (m.userQuestion) {
    cards.question = <DispatchUserQuestionCard workspaceId={workspaceId} card={m.userQuestion} />;
    if (m.userQuestion.anchorPartIndex != null) {
      cards.questionAnchor = m.userQuestion.anchorPartIndex;
    }
  }
  return cards;
}

/** 审批/提问卡插槽内容（贴着所属 assistant 消息按 anchorPartIndex 插进 parts 流） */
export function guiInlineCards(
  sessionId: string,
  m: GuiChatMessage
): TranscriptInlineCards {
  const cards: TranscriptInlineCards = {};
  if (m.turnChanges) cards.changes = <TurnChangesCard summary={m.turnChanges} target={{ kind: 'gui', id: sessionId, messageId: m.id }} />;
  if (m.approval) {
    cards.approval = <ApprovalCard key={m.approval.approvalId} sessionId={sessionId} approval={m.approval} />;
    if (m.approval.anchorPartIndex != null) cards.approvalAnchor = m.approval.anchorPartIndex;
  }
  if (m.userQuestion) {
    cards.question = <UserQuestionCard sessionId={sessionId} card={m.userQuestion} />;
    if (m.userQuestion.anchorPartIndex != null) {
      cards.questionAnchor = m.userQuestion.anchorPartIndex;
    }
  }
  return cards;
}
