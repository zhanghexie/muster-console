import { projectHostToolRoster, type ProjectedHostTool } from '../../../shared/hostToolProjection';
import { buildHostLlmRun } from './hostLlmRun';
import { HOST_ASK_DEF, HOST_SESSION_UPDATE_DEF } from './hostMerged';
import type { ToolDef } from './types';

/** Internal source schemas for projected entries whose public names combine or split tools. */
const SCHEMA_SOURCE: Readonly<Record<string, string>> = {
  'host.sessions.select': 'sessions.select',
  'host.sessions.recover': 'sessions.recoverInterrupted',
  'host.sessions.restart': 'sessions.restartConversation',
  'host.sessions.review': 'sessions.review'
};
const UPDATE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'sessions.rename': ['name'], 'sessions.setPinned': ['pinned'], 'sessions.setArchived': ['archived'],
  'sessions.setOrchestrated': ['orchestrated'], 'sessions.setModel': ['model'], 'sessions.setThinking': ['thinking'],
  'sessions.run': ['pinned', 'orchestrated', 'model', 'thinking']
};

function sessionUpdateDefinition(sources: readonly string[]): ToolDef {
  const fields = [...new Set(sources.flatMap(source => UPDATE_FIELDS[source] ?? []))];
  if (!fields.length) throw new Error('Session update projection has no authorized source');
  const properties = HOST_SESSION_UPDATE_DEF.parameters.properties;
  return { ...HOST_SESSION_UPDATE_DEF, parameters: { ...HOST_SESSION_UPDATE_DEF.parameters,
    properties: Object.fromEntries(['sessionId', ...fields].map(field => [field, properties[field]])),
    anyOf: fields.map(field => ({ required: [field] }))
  } as ToolDef['parameters'] };
}

function askDefinition(role: 'scheduler' | 'worker', sources: readonly string[]): ToolDef {
  const kinds = role === 'worker' ? ['confirm', 'text', 'choice'] : [
    ...(sources.includes('ui.confirm') ? ['confirm'] : []),
    ...(sources.includes('ui.prompt') ? ['text'] : []),
    ...(sources.includes('askQuestion') ? ['choice'] : [])
  ];
  if (!kinds.length) throw new Error('Question projection has no authorized source');
  return { ...HOST_ASK_DEF, parameters: { ...HOST_ASK_DEF.parameters,
    properties: { ...HOST_ASK_DEF.parameters.properties, kind: { type: 'string', enum: kinds } },
    oneOf: HOST_ASK_DEF.parameters.oneOf?.filter(variant => {
      const properties = variant.properties as Record<string, { const?: string }> | undefined;
      return !!properties?.kind?.const && kinds.includes(properties.kind.const);
    })
  } };
}

function reviewDefinition(source: ToolDef, sources: readonly string[]): ToolDef {
  if (!sources.includes('sessions.review')) {
    throw new Error('Batch review requires the original review permission and confirmation');
  }
  if (!sources.includes('sessions.completeAndArchive')) return source;
  return { ...source,
    description: `${source.description} Batch targets are prevalidated atomically.`,
    parameters: { ...source.parameters, additionalProperties: false,
      properties: { ...source.parameters.properties,
        sessionIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Batch targets, for processed only.' } },
      required: ['decision'],
      oneOf: [
        { required: ['sessionId'], not: { required: ['sessionIds'] } },
        { required: ['sessionIds'], properties: { decision: { const: 'processed' } },
          not: { anyOf: [{ required: ['sessionId'] }, { required: ['skipDimensionGate'] }] } }
      ]
    }
  };
}

export interface ProjectedHostDefinition extends ProjectedHostTool {
  def: ToolDef;
}

/**
 * Construct the next catalog without registering it. Source IDs retain their own policy and
 * binding; the projected schema alone is never an authorization to execute an operation.
 * A missing source schema aborts the whole projection rather than silently dropping a tool.
 */
export function projectHostDefinitions(
  role: 'scheduler' | 'worker', ids: readonly string[], resolve: (source: string) => ToolDef | undefined,
  options: { hasQuestionChannel?: boolean } = {}
): ProjectedHostDefinition[] {
  if (role !== 'scheduler' && role !== 'worker') throw new Error('Invalid host catalog role');
  if (role === 'worker' && !options.hasQuestionChannel && ids.some(id => ['askQuestion', 'ui.confirm', 'ui.prompt'].includes(id))) {
    throw new Error('Worker question channel is unavailable');
  }
  const sources = role === 'worker' && options.hasQuestionChannel ? [...ids, 'askQuestion'] : [...ids];
  const result = projectHostToolRoster(sources).map(entry => {
    let def: ToolDef | undefined;
    if (entry.name === 'host.ask') def = askDefinition(role, entry.sources);
    else if (entry.name === 'host.sessions.update') def = sessionUpdateDefinition(entry.sources);
    else if (entry.name === 'host.llm.run') def = buildHostLlmRun(role === 'worker' || entry.allowedActions ? 'worker' : 'scheduler',
      entry.sources.includes('llm.quota')).def;
    else def = resolve(SCHEMA_SOURCE[entry.name] ?? entry.sources[0]);
    if (!def) throw new Error(`Missing schema for projected host tool: ${entry.name}`);
    if (entry.name === 'host.sessions.review') def = reviewDefinition(def, entry.sources);
    return { ...entry, def: { ...def, name: entry.name } };
  });
  const apiNames = new Map<string, string>();
  for (const entry of result) {
    const apiName = entry.name.replace(/\./g, '_');
    const existing = apiNames.get(apiName);
    if (existing && existing !== entry.name) throw new Error(`Host API name collision: ${existing} and ${entry.name}`);
    apiNames.set(apiName, entry.name);
  }
  return result;
}
