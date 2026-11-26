import type { ToolDef } from './types';
import { DESKTOP_SKILL_PATH } from '../../metaAgent/hostSkillPaths';

const text = { type: 'string', minLength: 1 };
const description = `See ${DESKTOP_SKILL_PATH} for capability and platform boundaries.`;
export const DESKTOP_TOOL_DEFS: ToolDef[] = [
  { name: 'desktop.list', description: `List desktop metadata, application discovery, or select a window for look with view=windows. ${description}`,
    dangerous: false, parameters: { type: 'object', additionalProperties: false, properties: { displayOffset: { type: 'integer', minimum: 0, maximum: 1000000 },
      windowOffset: { type: 'integer', minimum: 0, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 10 },
      view: { type: 'string', enum: ['metadata', 'applications', 'windows'] }, query: { type: 'string', maxLength: 128 },
      status: { type: 'string', enum: ['all', 'running', 'installed_not_running'] }, snapshotId: { type: 'string', minLength: 1, maxLength: 256 },
      offset: { type: 'integer', minimum: 0, maximum: 1000000 } } } },
  { name: 'desktop.look', description: `Capture a display, or observe a selected window. Window mode both returns Cua window pixels and a bounded semantic tree. ${description}`,
    dangerous: false, parameters: { type: 'object', additionalProperties: false, properties: { surfaceId: text, windowOffset: { type: 'integer', minimum: 0, maximum: 1000000 },
      mode: { type: 'string', enum: ['image', 'semantic', 'both'] }, windowId: text, snapshotId: text,
      offset: { type: 'integer', minimum: 0, maximum: 1000000 },
      region: { type: 'object', additionalProperties: false, properties: { x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 },
        width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } }, required: ['x', 'y', 'width', 'height'] },
      waitForStable: { type: 'object', additionalProperties: false, properties: { intervalMs: { type: 'integer', minimum: 20, maximum: 1000 },
        timeoutMs: { type: 'integer', minimum: 20, maximum: 5000 } }, required: ['intervalMs', 'timeoutMs'] } } } },
  { name: 'desktop.act', description: `Act on a selected window. Click in a Cua window capture with its captureId, or use a current semantic ref. Reuse the same requestId and arguments to avoid redispatch. ${description}`,
    dangerous: false, parameters: { type: 'object', additionalProperties: false, properties: { surfaceId: text, requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' },
      action: { type: 'string', enum: ['click', 'double_click', 'type', 'key', 'scroll', 'move', 'hover', 'drag', 'set_value'] },
      target: { type: 'object', additionalProperties: false, properties: { windowId: text, captureId: text,
        snapshotId: text, ref: text, value: { type: 'string', maxLength: 4096 }, delivery: { type: 'string', enum: ['foreground', 'background'] },
        x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, toX: { type: 'number', minimum: 0 }, toY: { type: 'number', minimum: 0 },
        button: { type: 'string', enum: ['left', 'right', 'middle'] }, delta: { type: 'integer', minimum: -12000, maximum: 12000 },
        axis: { type: 'string', enum: ['vertical', 'horizontal'] },
        text: { type: 'string', minLength: 1, maxLength: 1024 }, keys: { type: 'array', minItems: 1, maxItems: 8,
          items: { anyOf: [{ type: 'integer', minimum: 1, maximum: 255 }, { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }] } } }, required: ['windowId'] },
      verify: { type: 'boolean' } }, required: ['action', 'target', 'requestId'] } },
  { name: 'desktop.focus', description: `Bring a captured window to the foreground on Windows or macOS. Pass its windowId as surfaceId with a stable requestId. ${description}`,
    dangerous: false, parameters: { type: 'object', additionalProperties: false, properties: { surfaceId: text, requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' } }, required: ['surfaceId', 'requestId'] } },
  { name: 'desktop.launch', description: `Launch an installed app with a stable requestId. Windows accepts an absolute executable path. macOS accepts the bundle identifier from application discovery. ${description}`,
    dangerous: false, parameters: { type: 'object', additionalProperties: false, properties: { appId: text, requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._-]+$' } }, required: ['appId', 'requestId'] } }
];
