export type HostAskRoute =
  | { tool: 'ui.confirm'; args: { title: string; detail?: string } }
  | { tool: 'ui.prompt'; args: { title: string; message?: string; defaultValue?: string; placeholder?: string; multiline?: boolean } }
  | { tool: 'askQuestion'; args: { title?: string; questions: unknown[] } };

/** Route the unified inquiry without turning cancellation into consent. */
export function routeHostAsk(value: unknown): HostAskRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ask parameters must be an object');
  const args = value as Record<string, unknown>;
  const allowed = (fields: readonly string[]): void => {
    if (Object.keys(args).some(key => !fields.includes(key))) throw new Error('Unexpected ask parameter');
  };
  const text = (key: string, required = false): string | undefined => {
    const value = args[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || (required && !value.trim())) throw new Error(`${key} must be ${required ? 'a non-empty' : 'a'} string`);
    return value;
  };
  if (args.kind === 'confirm') {
    allowed(['kind', 'title', 'detail']);
    const title = text('title', true)!;
    const detail = text('detail');
    return { tool: 'ui.confirm', args: { title, ...(detail === undefined ? {} : { detail }) } };
  }
  if (args.kind === 'text') {
    allowed(['kind', 'title', 'message', 'defaultValue', 'placeholder', 'multiline']);
    const title = text('title', true)!;
    const message = text('message'), defaultValue = text('defaultValue'), placeholder = text('placeholder');
    if (args.multiline !== undefined && typeof args.multiline !== 'boolean') throw new Error('multiline must be a boolean');
    return { tool: 'ui.prompt', args: { title, ...(message === undefined ? {} : { message }),
      ...(defaultValue === undefined ? {} : { defaultValue }), ...(placeholder === undefined ? {} : { placeholder }),
      ...(args.multiline === undefined ? {} : { multiline: args.multiline }) } };
  }
  if (args.kind === 'choice') {
    allowed(['kind', 'title', 'questions']);
    const title = text('title');
    if (!Array.isArray(args.questions) || !args.questions.length) throw new Error('questions must be a non-empty array');
    const ids = new Set<string>();
    for (const [index, question] of args.questions.entries()) {
      if (!question || typeof question !== 'object' || Array.isArray(question)) throw new Error('Each question must be an object');
      const q = question as Record<string, unknown>;
      if (typeof q.question !== 'string' || !q.question.trim()) throw new Error('Each question needs non-empty question text');
      if (q.id !== undefined && typeof q.id !== 'string') throw new Error('Question id must be a string');
      const id = typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${index + 1}`;
      if (ids.has(id)) throw new Error('Question ids must be unique after normalization');
      ids.add(id);
      if (q.multiSelect !== undefined && typeof q.multiSelect !== 'boolean') throw new Error('multiSelect must be a boolean');
      if (q.options !== undefined && (!Array.isArray(q.options) || q.options.some(option =>
        !option || typeof option !== 'object' || Array.isArray(option) || typeof option.label !== 'string' || !option.label.trim()))) {
        throw new Error('Question options require non-empty labels');
      }
      if (Array.isArray(q.options)) {
        const labels = q.options.map(option => (option as { label: string }).label.trim());
        if (new Set(labels).size !== labels.length) throw new Error('Question option labels must be unique after normalization');
      }
    }
    return { tool: 'askQuestion', args: { ...(title === undefined ? {} : { title }), questions: args.questions } };
  }
  throw new Error('kind must be confirm, text, or choice');
}

/** Keep the underlying channel's explicit cancellation or refusal result intact. */
export async function executeHostAsk(
  value: unknown,
  channels: {
    confirm: (args: Extract<HostAskRoute, { tool: 'ui.confirm' }>['args']) => Promise<unknown>;
    text: (args: Extract<HostAskRoute, { tool: 'ui.prompt' }>['args']) => Promise<unknown>;
    choice: (args: Extract<HostAskRoute, { tool: 'askQuestion' }>['args']) => Promise<unknown>;
  }
): Promise<unknown> {
  const route = routeHostAsk(value);
  switch (route.tool) {
    case 'ui.confirm': return channels.confirm(route.args);
    case 'ui.prompt': return channels.text(route.args);
    case 'askQuestion': return channels.choice(route.args);
  }
}
