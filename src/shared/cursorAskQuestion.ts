/**
 * Cursor GUI 结构化问卷：自定义 askQuestion → Host 提问卡。
 * 原生 SDK 在本地会直接拒绝 askQuestionInteractionQuery，必须换 customTools。
 * 纯函数，零依赖。
 */

export const CURSOR_ASK_QUESTION_NAME = 'askQuestion';

/** 与 Cursor IDE AskQuestion 接近的入参，方便模型按熟悉形状调用 */
export const CURSOR_ASK_QUESTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Questionnaire title' },
    questions: {
      type: 'array',
      minItems: 1,
      description: 'Question list',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string', minLength: 1, description: 'Question text' },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                description: { type: 'string' }
              },
              required: ['label']
            }
          },
          multiSelect: { type: 'boolean' }
        },
        required: ['question']
      }
    }
  },
  required: ['questions']
};

export type CursorAskQuestionMapped = {
  questions: Array<{
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

export function cursorAskQuestionToolDef(): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
} {
  return {
    name: CURSOR_ASK_QUESTION_NAME,
    description:
      'Ask the user a structured questionnaire (single/multi select, custom input allowed). Whenever the user must choose, confirm a plan, or trade off, call this tool instead of asking in plain prose.',
    inputSchema: CURSOR_ASK_QUESTION_SCHEMA
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function optionLabel(raw: unknown, index: number): { label: string; description?: string } | null {
  if (typeof raw === 'string' && raw.trim()) return { label: raw.trim() };
  const o = asRecord(raw);
  if (!o) return null;
  const label = String(o.label ?? o.id ?? o.value ?? '').trim() || `option ${index + 1}`;
  const description = typeof o.description === 'string' && o.description.trim() ? o.description : undefined;
  return description ? { label, description } : { label };
}

function mapOneQuestion(
  raw: unknown,
  index: number,
  header?: string
): CursorAskQuestionMapped['questions'][number] {
  if (typeof raw === 'string' && raw.trim()) {
    return { id: `q${index + 1}`, question: raw.trim(), ...(header ? { header } : {}) };
  }
  const q = asRecord(raw) ?? {};
  const id = String(q.id ?? `q${index + 1}`).trim() || `q${index + 1}`;
  const question = String(q.prompt ?? q.question ?? q.title ?? '').trim() || `question ${index + 1}`;
  const optsRaw = Array.isArray(q.options) ? q.options : [];
  const options = optsRaw.map(optionLabel).filter((x): x is { label: string; description?: string } => !!x);
  const multi = q.allow_multiple === true || q.multiSelect === true || q.allowMultiple === true;
  const detail = typeof q.detail === 'string' && q.detail.trim() ? q.detail.trim() : undefined;
  return {
    id,
    question,
    ...(header ? { header } : {}),
    ...(detail ? { detail } : {}),
    ...(options.length ? { options } : {}),
    ...(multi ? { multiSelect: true } : {})
  };
}

/** customTools args → Host 提问卡词表 */
export function mapCursorAskQuestionArgs(args: Record<string, unknown> | undefined): CursorAskQuestionMapped {
  const a = args ?? {};
  const title = typeof a.title === 'string' && a.title.trim() ? a.title.trim() : undefined;
  const list = Array.isArray(a.questions) ? a.questions : [];
  const questions = list.map((item, i) => mapOneQuestion(item, i, i === 0 ? title : undefined));
  if (!questions.length) {
    questions.push({
      id: 'q1',
      question: title || 'Please answer',
      ...(title ? { header: title } : {})
    });
  }
  return { questions };
}

export function formatCursorAskQuestionResult(outcome: {
  kind: 'answered' | 'aborted';
  answers?: Array<{ id: string; selected: string[]; custom?: string }>;
}): { ok: boolean; text: string } {
  if (outcome.kind === 'aborted') {
    return { ok: false, text: 'askQuestion was aborted before the user answered' };
  }
  return { ok: true, text: JSON.stringify({ answers: outcome.answers ?? [] }) };
}
