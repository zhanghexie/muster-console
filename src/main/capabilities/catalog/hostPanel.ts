import { RIGHT_PANEL_LAYOUTS } from '../../../shared/rightPanelLayout';
import type { ToolDef } from './types';

const text = { type: 'string', minLength: 1 };
const workspaceId = { type: 'string', minLength: 1 };
const fileRef = { type: 'object', additionalProperties: false,
  properties: { workspaceId: text, rootId: text, relativePath: text }, required: ['workspaceId', 'rootId', 'relativePath'] };
const pane = { oneOf: [
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'session' }, sessionId: text }, required: ['kind', 'sessionId'] },
  { type: 'object', additionalProperties: false, properties: { kind: { const: 'utility' }, sel: text }, required: ['kind', 'sel'] }
] };
const ratio = { type: 'number', minimum: 0.2, maximum: 0.8 };
const placement = { type: 'string', enum: ['right', 'center'] };
const openCommon = { workspaceId, focus: { type: 'boolean' }, placement };
const openFields = {
  path: text, fileRef, line: { type: 'integer', minimum: 1 }, repoPath: text, filePath: text,
  staged: { type: 'boolean' }, untracked: { type: 'boolean' }, messageId: text,
  owner: { type: 'object', additionalProperties: false, properties: { kind: { enum: ['gui', 'dispatch'] }, id: text }, required: ['kind', 'id'] },
  browserId: text, sessionId: text, sel: text, nodeId: text
};
type OpenField = keyof typeof openFields;
const openCase = (kind: string, required: OpenField[] = [], optional: OpenField[] = []) => ({
  properties: { kind: { const: kind } },
  propertyNames: { enum: ['kind', ...Object.keys(openCommon), ...required, ...optional] },
  ...(required.length ? { required } : {})
});
const openCases = [
  { ...openCase('file', [], ['path', 'fileRef', 'line']), oneOf: [{ required: ['path'] }, { required: ['fileRef'] }] },
  openCase('diff', ['repoPath', 'filePath', 'staged'], ['untracked']),
  openCase('git', ['repoPath']),
  openCase('review', ['owner'], ['messageId', 'repoPath', 'filePath']),
  openCase('browser', ['browserId']),
  openCase('session', ['sessionId']),
  openCase('utility', ['sel']),
  openCase('extension', ['nodeId']),
  openCase('settings')
];

/** Public panel contract; unsupported placements fail explicitly. */
export const HOST_PANEL_DEFS: readonly ToolDef[] = [
  { name: 'host.panel.list', description: 'Read the caller workspace layout, tabs, focus and editor state.', dangerous: false,
    parameters: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'host.panel.open', description: 'Open a view without taking focus unless requested. Browser views support the right panel only; center placement is rejected.', dangerous: false,
    parameters: { type: 'object', required: ['kind'],
      properties: { ...openCommon, kind: { type: 'string', enum: openCases.map(entry => entry.properties.kind.const) }, ...openFields },
      oneOf: openCases } },
  { name: 'host.panel.split', description: 'Arrange existing views in the center or right workspace.', dangerous: false,
    parameters: { type: 'object', additionalProperties: false, required: ['layoutId'], properties: {
      workspaceId, placement, panes: { type: 'array', minItems: 2, maxItems: 3, items: pane },
      tabIds: { type: 'array', minItems: 2, maxItems: 3, uniqueItems: true, items: text },
      layoutId: { type: 'string', enum: ['halves', 'wide', 'stack', 'focus', 'focus-mirror', 'thirds'] },
      ratio, ratios: { type: 'array', minItems: 2, maxItems: 2, items: ratio }
    }, oneOf: [
      { required: ['panes'], properties: { placement: { const: 'center' } },
        not: { anyOf: [{ required: ['tabIds'] }, { required: ['ratio'] }, { required: ['ratios'] }] } },
      { required: ['placement', 'tabIds'], properties: { placement: { const: 'right' }, layoutId: { enum: RIGHT_PANEL_LAYOUTS.map(layout => layout.id) } },
        not: { anyOf: [{ required: ['panes'] }, { required: ['ratio', 'ratios'] }] } }
    ] } },
  { name: 'host.panel.focus', description: 'Focus exactly one right tab, center target or workspace axis.', dangerous: false,
    parameters: { type: 'object', additionalProperties: false, properties: { workspaceId, tabId: text,
      page: { type: 'string', enum: ['terminal', 'git'] }, target: pane }, oneOf: [
      { required: ['tabId'] }, { required: ['page'] }, { required: ['target'] }
    ] } },
  { name: 'host.panel.close', description: 'Close a view or collapse a split without stopping its session.', dangerous: false,
    parameters: { type: 'object', additionalProperties: false, properties: { workspaceId, tabId: text, target: pane,
      placement, slot: { type: 'integer', minimum: 0, maximum: 2 } }, oneOf: [
      { required: ['tabId'], not: { anyOf: [{ required: ['target'] }, { required: ['placement'] }, { required: ['slot'] }] } },
      { required: ['target'], not: { anyOf: [{ required: ['tabId'] }, { required: ['placement'] }, { required: ['slot'] }] } },
      { required: ['placement', 'slot'], properties: { placement: { const: 'center' } }, not: { anyOf: [{ required: ['tabId'] }, { required: ['target'] }] } },
      { required: ['placement'], properties: { placement: { const: 'right' } }, not: { anyOf: [{ required: ['tabId'] }, { required: ['target'] }] } }
    ] } }
];
