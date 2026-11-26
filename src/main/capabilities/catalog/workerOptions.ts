import type { ToolDef } from './types';

export const WORKER_OPTIONS_TOOL_DEFS: ToolDef[] = [{
  name: 'workers.options', summary: 'Read Worker tiers and model options', dangerous: false,
  description: 'Read Worker choices for the current source, without starting model discovery. Default: configured tiers and their descriptions. Use mode=harnesses for registered GUI/CLI choices, or mode=models with harnessId and surface for cached model options and exact targetRef. For custom parameters, pass modelId, providerId and modelParameters (GUI; Kimi CLI uses its advertised ACP reasoning) or reasoning (supported CLI). Pass tierId or targetRef unchanged to host.sessions.create. Unknown catalog requires manual refresh in Settings.',
  parameters: { type: 'object', properties: {
    mode: { type: 'string', enum: ['tiers', 'harnesses', 'models', 'native-settings'],
      description: 'native-settings reads the external GUI Harness configuration directory for this source.' },
    harnessId: { type: 'string' }, surface: { type: 'string', enum: ['gui', 'cli'] },
    rootId: { type: 'string', description: 'Registered source in the current workspace; a Worker is bound to its own source.' },
    rootsRevision: { type: 'integer' }, cwd: { type: 'string' },
    q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 8 }, offset: { type: 'integer', minimum: 0 },
    modelId: { type: 'string' }, providerId: { type: 'string' },
    parameterId: { type: 'string', description: 'For an exact model, read additional options of this parameter.' },
    optionOffset: { type: 'integer', minimum: 0 },
    modelParameters: { type: 'object', additionalProperties: { type: 'string' }, maxProperties: 32 }, reasoning: { type: 'string' }
  } }
}, {
  name: 'workers.context', summary: 'Read earlier context after a Worker Harness switch', dangerous: false,
  description: 'Read the calling Worker’s existing transcript and completed tool results after an automatic Harness switch. Follow nextBefore for earlier messages; pass messageId and bodyOffset for the full original text of one message. This is existing context, with no new permissions.',
  parameters: { type: 'object', properties: {
    before: { type: 'integer', minimum: 0 }, messageId: { type: 'string' }, bodyOffset: { type: 'integer', minimum: 0 }
  } }
}];
