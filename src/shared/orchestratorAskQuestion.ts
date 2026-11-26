/**
 * 调度 Agent askQuestion：挂卡 / 结算 / 重启消毒的纯函数。
 * 零运行时依赖，供 Orchestrator 与离线测试共用。
 */
import { containsNoteAnnotation } from './noteAnnotations';
import type { ChatMessage, ChatUserQuestionView } from './types';
import type { CursorAskQuestionMapped } from './cursorAskQuestion';

export type OrchestratorAskOutcome =
  | { kind: 'answered'; answers: Array<{ id: string; selected: string[]; custom?: string }> }
  | { kind: 'aborted'; reason?: 'superseded' };

/**
 * 提问待答时的等待态快照。另一单的 needs_you 状态通道可订阅；
 * 本期只预留形状，不改看板相位。
 */
export type OrchestratorHumanWait = {
  workspaceId: string;
  reason: 'askQuestion';
  questionId: string;
  since: number;
};

export function buildAskQuestionCard(
  questionId: string,
  mapped: CursorAskQuestionMapped,
  anchorPartIndex?: number
): ChatUserQuestionView {
  return {
    questionId,
    questions: mapped.questions,
    status: 'pending',
    ...(anchorPartIndex != null ? { anchorPartIndex } : {})
  };
}

/** 在途 assistant 上挂提问卡；清除该回合已有建议，避免与作答混淆。 */
export function attachAskQuestionCard(
  assistant: ChatMessage,
  card: ChatUserQuestionView
): ChatMessage {
  assistant.userQuestion = card;
  delete assistant.suggestedReplies;
  return assistant;
}

export function settleAskQuestionCard(
  message: ChatMessage,
  questionId: string,
  outcome: OrchestratorAskOutcome
): ChatMessage | null {
  if (message.userQuestion?.questionId !== questionId) return null;
  message.userQuestion =
    outcome.kind === 'answered'
      ? { ...message.userQuestion, status: 'answered', answers: outcome.answers }
      : { ...message.userQuestion, status: 'aborted', abortReason: outcome.reason };
  // 清除旧版本随卡产生的建议。
  delete message.suggestedReplies;
  return message;
}

/** 重启/装载：悬挂 pending 卡无人应答，翻 aborted，避免假待答；
 *  随卡产生的建议输入一并剥离（无人应答=建议无处投递） */
export function sanitizeRestoredAskQuestions(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.userQuestion?.status !== 'pending') return m;
    changed = true;
    const stripped = { ...m, userQuestion: { ...m.userQuestion, status: 'aborted' as const } };
    delete stripped.suggestedReplies;
    return stripped;
  });
  return changed ? next : messages;
}

/** 单题、单行且精确命中唯一选项才快捷作答；批注和自由文本走普通消息。
 * 自定义回答只通过卡内输入提交，不从聊天输入推断用户意图。
 */
export function answerFromText(
  card: Pick<ChatUserQuestionView, 'questions'>,
  text: string
): Array<{ id: string; selected: string[]; custom?: string }> | null {
  const qs = card.questions;
  if (qs.length !== 1) return null;
  const trimmed = text.trim();
  if (!trimmed || /[\r\n]/.test(trimmed) || trimmed.startsWith('>') || containsNoteAnnotation(trimmed)) return null;
  const q = qs[0]!;
  const hit = (q.options ?? []).filter((o) => o.label === trimmed).length === 1;
  return hit
    ? [{ id: q.id, selected: [trimmed] }]
    : null;
}

export function dispatchWaitState(m: ChatMessage | null | undefined): 'question' | null {
  if (!m || m.role !== 'assistant') return null;
  return m.userQuestion?.status === 'pending' ? 'question' : null;
}

/** 当前回合 assistant（跳过排队用户消息垫在后面的情况：从尾部找最近非 queued assistant） */
export function findAskQuestionAnchor(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && !m.queued) return m;
  }
  return undefined;
}
