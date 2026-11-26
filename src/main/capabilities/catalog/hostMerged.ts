import type { ToolDef } from './types';
import { CURSOR_ASK_QUESTION_SCHEMA } from '../../../shared/cursorAskQuestion';

const string = { type: 'string', minLength: 1 };
const kind = (value: string) => ({ type: 'string', const: value });
const questionProperties = CURSOR_ASK_QUESTION_SCHEMA.properties as Record<string, unknown>;

/** Staged definitions only. Register atomically with the global host.* migration. */
export const HOST_ASK_DEF: ToolDef = {
  name: 'host.ask', dangerous: false,
  description: 'Ask for a confirmation, text or structured choice. Cancellation and refusal are not consent.',
  parameters: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ['confirm', 'text', 'choice'] }, title: { type: 'string' },
      detail: { type: 'string' }, message: { type: 'string' }, defaultValue: { type: 'string' },
      placeholder: { type: 'string' }, multiline: { type: 'boolean' }, questions: questionProperties.questions },
    required: ['kind'],
    oneOf: [
      { type: 'object', properties: { kind: kind('confirm'), title: string, detail: { type: 'string' } }, required: ['kind', 'title'], additionalProperties: false },
      { type: 'object', properties: { kind: kind('text'), title: string, message: { type: 'string' }, defaultValue: { type: 'string' }, placeholder: { type: 'string' }, multiline: { type: 'boolean' } }, required: ['kind', 'title'], additionalProperties: false },
      // The enclosing schema validates the full questions shape. The branch
      // declares the property only to enforce which fields belong to choice.
      { type: 'object', properties: { kind: kind('choice'), title: { type: 'string' }, questions: {} }, required: ['kind', 'questions'], additionalProperties: false }
    ]
  }
};

export const HOST_SESSION_UPDATE_DEF: ToolDef = {
  name: 'host.sessions.update', dangerous: false,
  description: 'Update one or more session fields. Workers may rename themselves or archive direct children; other fields require scheduler identity. Partial failures report completed effects.',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      sessionId: { type: 'string', minLength: 1 }, name: string,
      pinned: { type: 'boolean' }, archived: { type: 'boolean' }, orchestrated: { type: 'boolean' },
      model: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false,
        properties: { providerId: string, modelId: string }, required: ['providerId', 'modelId'] }] },
      thinking: { enum: ['off', 'low', 'medium', 'high', 'max', null] }
    },
    anyOf: ['name', 'pinned', 'archived', 'orchestrated', 'model', 'thinking'].map(field => ({ required: [field] }))
  } as ToolDef['parameters']
};
