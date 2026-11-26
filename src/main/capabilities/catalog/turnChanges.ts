import type { ToolDef } from './types';
import { TURN_CHANGES_SKILL_PATH } from '../../metaAgent/hostSkillPaths';

export const TURN_CHANGES_TOOL_DEFS: ToolDef[] = [{
  name: 'turnChanges.trackFiles', dangerous: false,
  description: `Register exact files before and after edits that lack a trusted pre-write hook, including commands and external harnesses. Read ${TURN_CHANGES_SKILL_PATH} for usage. Registration does not grant write permission.`,
  parameters: { type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['begin', 'complete'] },
      paths: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1 } },
      rootId: { type: 'string', minLength: 1, description: 'Optional for begin only. Select another writable root.' },
      captureId: { type: 'string', minLength: 1, description: 'Required for complete only. Use the ID returned by begin.' }
    }, required: ['action', 'paths']
  }
}];
