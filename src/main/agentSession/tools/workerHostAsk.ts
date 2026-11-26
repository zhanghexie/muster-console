import { routeHostAsk } from '../../../shared/hostAsk';
import { mapCursorAskQuestionArgs } from '../../../shared/cursorAskQuestion';
import { normalizePromptArgs } from '../../../shared/uiDialog';
import { t } from '../../../shared/i18n';
import { HOST_ASK_DEF } from '../../capabilities/catalog/hostMerged';
import type { GuiHostTool, GuiUserQuestionOutcome, GuiUserQuestionRequest } from '../types';

/** Staged Worker adapter: the question channel supplies the bound session identity. */
export async function executeWorkerHostAsk(value: unknown,
  request: (question: GuiUserQuestionRequest, signal?: AbortSignal) => Promise<GuiUserQuestionOutcome>, signal?: AbortSignal): Promise<unknown> {
  if (typeof request !== 'function') throw new Error('Worker question channel is unavailable');
  signal?.throwIfAborted();
  const route = routeHostAsk(value);
  if (route.tool === 'askQuestion') {
    const outcome = await request(mapCursorAskQuestionArgs(route.args), signal);
    signal?.throwIfAborted();
    if (outcome.kind !== 'answered') throw new Error('Question was aborted before the user answered');
    return { answers: outcome.answers };
  }
  if (route.tool === 'ui.confirm') {
    const approve = t('确认'), deny = t('拒绝');
    const outcome = await request({ questions: [{ id: 'host-confirm', question: route.args.title,
      ...(route.args.detail === undefined ? {} : { detail: route.args.detail }), options: [{ label: approve }, { label: deny }] }] }, signal);
    signal?.throwIfAborted();
    if (outcome.kind !== 'answered') return { confirmed: false, cancelled: true };
    const answers = outcome.answers.filter(answer => answer.id === 'host-confirm');
    const answer = answers.length === 1 ? answers[0] : undefined;
    return { confirmed: !!answer && answer.custom === undefined && answer.selected.length === 1 && answer.selected[0] === approve };
  }
  const prompt = normalizePromptArgs(route.args);
  const outcome = await request({ questions: [{ id: 'host-text', question: prompt.title,
    ...(prompt.message ? { detail: prompt.message } : {}),
    textInput: { ...(prompt.defaultValue === undefined ? {} : { defaultValue: prompt.defaultValue }),
      ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
      ...(prompt.multiline === undefined ? {} : { multiline: prompt.multiline }) } }] }, signal);
  signal?.throwIfAborted();
  if (outcome.kind !== 'answered') return { cancelled: true, value: null };
  const answers = outcome.answers.filter(answer => answer.id === 'host-text');
  const answer = answers.length === 1 ? answers[0] : undefined;
  if (!answer || answer.selected.length !== 0 || typeof answer.custom !== 'string') return { cancelled: true, value: null };
  return { cancelled: false, value: answer.custom };
}

/** Prepared for atomic registration; no legacy questionnaire alias is added here. */
export function buildWorkerHostAskTool(sessionId: string,
  request?: (question: GuiUserQuestionRequest, signal?: AbortSignal) => Promise<GuiUserQuestionOutcome>): GuiHostTool | null {
  if (!request) return null;
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Worker session identity is required');
  return {
    id: HOST_ASK_DEF.name,
    label: HOST_ASK_DEF.name,
    description: HOST_ASK_DEF.description,
    parameters: HOST_ASK_DEF.parameters as Record<string, unknown>,
    permissionClass: 'status',
    async execute(args, context) {
      if (context.sessionId !== sessionId) throw new Error('Worker question session changed');
      return JSON.stringify(await executeWorkerHostAsk(args, request, context.signal));
    }
  };
}
