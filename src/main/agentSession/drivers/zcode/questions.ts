import type { GuiUserQuestionOutcome, GuiUserQuestionRequest } from '../../types';
import { asZCodeRecord as object, zcodeString as string } from './process';

type Question = {
  id: string;
  text: string;
  multiSelect: boolean;
  options: Map<string, string>;
};

export interface ZCodeQuestionnaire {
  request: GuiUserQuestionRequest;
  questions: Question[];
}

/** Map only the official AskUserQuestion form, not plan approval or MCP elicitation. */
export function parseZCodeQuestionnaire(params: Record<string, unknown>): ZCodeQuestionnaire {
  const schema = object(params.schema);
  const name = string(params.toolName) || string(schema.toolName);
  if (name.toLowerCase() !== 'askuserquestion' || schema.interaction !== undefined) {
    throw new Error('当前 ZCode 交互不是受支持的普通问卷');
  }
  const displayed = params.questions;
  const original = object(params.input).questions;
  if (!Array.isArray(displayed) || !Array.isArray(original) || displayed.length < 1 ||
      displayed.length > 4 || displayed.length !== original.length) {
    throw new Error('ZCode 问卷缺少可核对的原始问题');
  }
  const seen = new Set<string>();
  const questions: Question[] = [];
  const request: GuiUserQuestionRequest = { questions: [] };
  for (let index = 0; index < displayed.length; index++) {
    const row = object(displayed[index]), raw = object(original[index]);
    const text = string(row.question), originalText = string(raw.question);
    if (!text.trim() || text !== originalText || text.length > 16_384 || seen.has(text)) {
      throw new Error('ZCode 问卷问题重复或与原始内容不一致');
    }
    seen.add(text);
    if (!Array.isArray(row.options) || row.options.length < 1 || row.options.length > 20) {
      throw new Error('ZCode 问卷选项无效');
    }
    const options = new Map<string, string>();
    const rendered: Array<{ label: string; description?: string }> = [];
    for (const value of row.options) {
      const option = object(value), label = string(option.label), selectedValue = string(option.value);
      if (!label.trim() || !selectedValue.trim() || label.length > 1024 || selectedValue.length > 1024 || options.has(label)) {
        throw new Error('ZCode 问卷选项重复或缺少值');
      }
      options.set(label, selectedValue);
      const description = string(option.description);
      const preview = string(option.preview);
      const detail = [description, preview].filter(Boolean).join('\n');
      if (detail.length > 16_384) throw new Error('ZCode 问卷选项说明过长');
      rendered.push({ label, ...(detail ? { description: detail } : {}) });
    }
    const id = `zcode-q${index + 1}`;
    const multiSelect = row.multiSelect === true;
    questions.push({ id, text, multiSelect, options });
    request.questions.push({ id, question: text, ...(string(row.header) ? { header: string(row.header) } : {}),
      options: rendered, ...(multiSelect ? { multiSelect: true } : {}) });
  }
  return { request, questions };
}

/** ZCode's broker indexes answers by the exact original question text. */
export function formatZCodeQuestionnaireAnswer(form: ZCodeQuestionnaire, result: GuiUserQuestionOutcome): Record<string, unknown> {
  if (result.kind === 'aborted') return { action: 'cancel' };
  if (result.answers.length !== form.questions.length) throw new Error('ZCode 问卷答案不完整');
  const answers: Record<string, string> = Object.create(null) as Record<string, string>;
  const seenIds = new Set<string>();
  for (const answer of result.answers) {
    const question = form.questions.find(item => item.id === answer.id);
    if (!question || seenIds.has(answer.id)) throw new Error('ZCode 问卷答案不属于当前请求');
    seenIds.add(answer.id);
    const values = answer.selected.map(label => {
      const value = question.options.get(label);
      if (!value) throw new Error('ZCode 问卷包含未知选项');
      return value;
    });
    if (new Set(answer.selected).size !== answer.selected.length) throw new Error('ZCode 问卷重复选择选项');
    if (answer.custom?.trim()) values.push(answer.custom.trim());
    if (!values.length || (!question.multiSelect && values.length !== 1)) throw new Error('ZCode 问卷答案数量无效');
    answers[question.text] = values.join(', ');
  }
  return { action: 'accept', content: { answers } };
}
