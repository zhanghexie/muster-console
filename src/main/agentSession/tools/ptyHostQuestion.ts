import type { GuiUserQuestionOutcome, GuiUserQuestionRequest } from '../types';
import type { UiBridge } from '../../uiBridge';
import { UI_DIALOG_DETAIL_MAX, UI_DIALOG_ITEMS_MAX, UI_DIALOG_LABEL_MAX, UI_DIALOG_MESSAGE_MAX, UI_DIALOG_TITLE_MAX } from '../../../shared/uiDialog';
import { t } from '../../../shared/i18n';

/** Reuse host dialogs for a PTY Worker without attributing its question to the scheduler. */
export async function requestPtyHostQuestion(ui: Pick<UiBridge, 'prompt' | 'select' | 'multiSelect'>, sessionName: string,
  request: GuiUserQuestionRequest, signal?: AbortSignal): Promise<GuiUserQuestionOutcome> {
  if (!sessionName.trim() || !Array.isArray(request?.questions) || !request.questions.length) throw new Error('Invalid PTY question');
  const title = `${sessionName} · ${t('Agent 提问')}`;
  if (title.length > UI_DIALOG_TITLE_MAX) throw new Error('PTY question title is too long');
  const answers: Array<{ id: string; selected: string[]; custom?: string }> = [];
  for (const question of request.questions) {
    signal?.throwIfAborted();
    const message = [question.question, question.detail].filter(Boolean).join('\n\n');
    if (!question.id || !message.trim() || message.length > UI_DIALOG_MESSAGE_MAX) throw new Error('PTY question text is invalid or too long');
    const options = question.options ?? [];
    if (options.length >= UI_DIALOG_ITEMS_MAX || options.some(option => !option.label?.trim() || option.label.length > UI_DIALOG_LABEL_MAX ||
      (option.description?.length ?? 0) > UI_DIALOG_DETAIL_MAX)) throw new Error('PTY question options are invalid or too long');
    if (question.textInput || !options.length) {
      const value = await ui.prompt({ title, message, ...question.textInput });
      signal?.throwIfAborted();
      if (value === null) return { kind: 'aborted' };
      answers.push({ id: question.id, selected: [], custom: value });
      continue;
    }
    const items = [...options.map((option, index) => ({ id: `option-${index}`, label: option.label,
      ...(option.description ? { detail: option.description } : {}) })), { id: 'custom', label: t('自定义') }];
    const chosen = question.multiSelect ? await ui.multiSelect({ title, message, items }) : await ui.select({ title, message, items });
    signal?.throwIfAborted();
    if (chosen === null) return { kind: 'aborted' };
    const ids = Array.isArray(chosen) ? chosen : [chosen];
    if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !items.some(item => item.id === id)) ||
        (!question.multiSelect && ids.length !== 1)) throw new Error('Invalid PTY question response');
    const selected = ids.filter(id => id !== 'custom').map(id => options[Number(id.slice('option-'.length))].label);
    if (ids.includes('custom')) {
      const custom = await ui.prompt({ title, message, placeholder: t('自定义回答…') });
      signal?.throwIfAborted();
      if (custom === null || !custom.trim()) return { kind: 'aborted' };
      answers.push({ id: question.id, selected, custom });
    } else answers.push({ id: question.id, selected });
  }
  return { kind: 'answered', answers };
}
