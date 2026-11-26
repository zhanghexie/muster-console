import type { GuiUserQuestionOutcome, GuiUserQuestionRequest } from '../../types';
import { t } from '../../../../shared/i18n';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

interface CursorQuestion { id: string; prompt: string; allowMultiple: boolean; options: Array<{ id: string; label: string }> }

/** Preserve option IDs even though the workbench question card returns labels. */
export function parseCursorQuestions(params: unknown): { request: GuiUserQuestionRequest; questions: CursorQuestion[] } {
  const raw = object(params);
  if (!Array.isArray(raw.questions) || raw.questions.length < 1 || raw.questions.length > 20) throw new Error('Cursor 提问格式无效');
  const questions = raw.questions.map(item => {
    const q = object(item), id = string(q.id), prompt = string(q.prompt);
    if (!id || !prompt || id.length > 200 || prompt.length > 4000 || !Array.isArray(q.options) || q.options.length < 1 || q.options.length > 30) throw new Error('Cursor 提问格式无效');
    const options = q.options.map(value => ({ id: string(object(value).id), label: string(object(value).label) }));
    if (options.some(option => !option.id || !option.label || option.id.length > 200 || option.label.length > 1000) ||
        new Set(options.map(option => option.id)).size !== options.length || new Set(options.map(option => option.label)).size !== options.length) throw new Error('Cursor 提问选项无效或重复');
    return { id, prompt, allowMultiple: q.allowMultiple === true, options };
  });
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('Cursor 提问 ID 重复');
  return { questions, request: { questions: questions.map(q => ({ id: q.id, question: q.prompt,
    ...(string(raw.title) ? { header: string(raw.title).slice(0, 200) } : {}), multiSelect: q.allowMultiple,
    options: q.options.map(option => ({ label: option.label })) })) } };
}

export function cursorQuestionResponse(questions: CursorQuestion[], outcome: GuiUserQuestionOutcome): Obj {
  if (outcome.kind !== 'answered') return { outcome: { outcome: 'cancelled' } };
  const answers = [];
  for (const q of questions) {
    const answer = outcome.answers.find(item => item.id === q.id);
    if (!answer || answer.custom?.trim() || !answer.selected.length || (!q.allowMultiple && answer.selected.length !== 1)) {
      return { outcome: { outcome: 'skipped', reason: 'Cursor 只接受所列选项' } };
    }
    const ids = answer.selected.map(label => q.options.find(option => option.label === label)?.id);
    if (ids.some(id => !id) || new Set(ids).size !== ids.length) return { outcome: { outcome: 'skipped', reason: '选项无效' } };
    answers.push({ questionId: q.id, selectedOptionIds: ids });
  }
  return { outcome: { outcome: 'answered', answers } };
}

export function cursorPlanQuestion(params: unknown): GuiUserQuestionRequest {
  const p = object(params), plan = string(p.plan);
  if (!plan || plan.length > 30000) throw new Error('Cursor 计划为空或过长');
  return { questions: [{ id: 'cursor-plan', question: string(p.name) || t('是否批准 Cursor 的计划？'), detail: plan,
    options: [{ label: t('批准') }, { label: t('拒绝') }] }] };
}

export function cursorPlanResponse(outcome: GuiUserQuestionOutcome, approveLabel = t('批准')): Obj {
  if (outcome.kind !== 'answered') return { outcome: { outcome: 'cancelled' } };
  const answer = outcome.answers.find(item => item.id === 'cursor-plan');
  return answer && !answer.custom?.trim() && answer.selected.length === 1 && answer.selected[0] === approveLabel
    ? { outcome: { outcome: 'accepted' } } : { outcome: { outcome: 'rejected', reason: '用户未批准计划' } };
}
