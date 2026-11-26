import type { AgentSessionHost } from '../agentSession/host';
import type { GuiChatMessage } from '../../shared/guiWorker';

type Answer = { id: string; selected: string[]; custom?: string };
type Response = { ok: boolean; value?: { sessionId?: string; approvalId?: string; outcome?: string; answer?: { answers?: Answer[] } } };
type Interaction = {
  kind: 'approval' | 'question'; interactionId: string; rpcId: string; sessionId: string;
  payload: Record<string, unknown>; respond(response: Response): Promise<{ accepted: true }>;
};
type Resolution = { kind: Interaction['kind']; interactionId: string; sessionId: string; outcome: string };

export type MessagingInteractionCallbacks = Readonly<{
  onInteraction?: (interaction: Interaction) => unknown;
  onInteractionResolved?: (resolution: Resolution) => unknown;
}>;

function interactionError(code: 'interaction-not-pending' | 'interaction-bad-response'): Error {
  return Object.assign(new Error(code), { code });
}

export function observeMessagingInteractions(
  gui: AgentSessionHost, sessionId: string, assistantId: string, assertOwner: () => void,
  callbacks: MessagingInteractionCallbacks, signal: AbortSignal
): (message: GuiChatMessage) => void {
  let pending: Interaction | undefined;
  function publish(call: () => unknown): void { void Promise.resolve().then(() => { if (!signal.aborted) return call(); }).catch(() => {}); }

  return message => {
    if (message.id !== assistantId || !callbacks.onInteraction) return;
    const approval = message.approval;
    const question = message.userQuestion?.status === 'pending' ? message.userQuestion : undefined;
    const id = approval?.approvalId ?? question?.questionId;
    if (pending && pending.interactionId === id) return;
    if (pending) {
      const resolved = pending;
      pending = undefined;
      publish(() => callbacks.onInteractionResolved?.({ kind: resolved.kind, sessionId, interactionId: resolved.interactionId,
        outcome: message.userQuestion?.status === 'answered' ? 'answered' : 'resolved' }));
    }
    if (!id) return;
    const kind = approval ? 'approval' : 'question';
    const interaction: Interaction = Object.freeze({
      kind, sessionId, interactionId: id, rpcId: id,
      payload: Object.freeze(approval
        ? { type: 'approval/requested', sessionId, approvalId: id, callId: approval.toolCallId, toolName: approval.toolName }
        : { type: 'question/requested', sessionId, questions: question?.questions }),
      async respond(response: Response) {
        signal.throwIfAborted();
        assertOwner();
        if (pending !== interaction || gui.currentAssistantMessageId(sessionId) !== assistantId) throw interactionError('interaction-not-pending');
        if (response.ok && response.value?.sessionId !== sessionId) throw interactionError('interaction-bad-response');
        let accepted: boolean;
        if (approval) {
          const outcome = response.ok ? response.value?.outcome : 'unavailable';
          if ((response.ok && response.value?.approvalId !== id) || !['allowed-once', 'rejected', 'expired', 'unavailable'].includes(outcome ?? '')) {
            throw interactionError('interaction-bad-response');
          }
          const allow = outcome === 'allowed-once';
          const choice = approval.nativeChoices?.find(item => item.scope === 'once' &&
            (allow ? item.kind === 'allow_once' : item.kind === 'reject_once'));
          if (approval.nativeChoices?.length && !choice) throw interactionError('interaction-bad-response');
          accepted = gui.respondApproval(sessionId, id, allow, undefined, choice?.id);
        } else {
          const answers = response.value?.answer?.answers;
          if (response.ok && (!Array.isArray(answers) || answers.length !== question?.questions.length ||
              new Set(answers.map(answer => answer.id)).size !== answers.length || !answers.every(answer =>
                question.questions.some(item => item.id === answer.id) && Array.isArray(answer.selected) && answer.selected.length <= 32 &&
                answer.selected.every(value => typeof value === 'string' && value.length <= 2048) &&
                (answer.custom === undefined || (typeof answer.custom === 'string' && answer.custom.length <= 4096))))) {
            throw interactionError('interaction-bad-response');
          }
          accepted = gui.respondUserQuestion(sessionId, id, response.ok ? 'answer' : 'abort', answers);
        }
        if (!accepted) throw interactionError('interaction-not-pending');
        return { accepted: true as const };
      }
    });
    pending = interaction;
    publish(() => callbacks.onInteraction?.(interaction));
  };
}
