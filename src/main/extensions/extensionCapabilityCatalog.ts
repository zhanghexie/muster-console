import type { ToolDef } from '../capabilities/catalog/types';

const id = { type: 'string', description: 'Extension ID; lowercase letters, digits and hyphens.' };
const scope = { type: 'string', enum: ['global', 'project'], description: 'Global is portable across workspaces; project binds to the caller project.' };
const fingerprint = { type: 'string', description: 'Fingerprint of the currently approved package; required for updates.' };
const draftId = { type: 'string', description: 'Draft ID returned to this caller by create.' };
const filePath = { type: 'string', description: 'Package-relative file path; data, cache and Git metadata are excluded.' };
function definition(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], dangerous = false): ToolDef {
  return { name, description, dangerous, parameters: { type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) } };
}

/** Extension action schemas; these become the single source for the extensions.run domain. */
export const EXTENSION_EXTENSION_TOOL_DEFS: ToolDef[] = [
  definition('extensions.inspect', 'Inspect the caller workspace, management root and bound project before authoring.', {}),
  definition('extensions.list', 'List global and caller-project extensions, review and synchronization status.', {}),
  definition('extensions.bindProject', 'Bind a mapped project key to the caller project; replacing a binding requires its current root ID.', { mappingKey: { type: 'string' }, expectedRootId: { type: 'string' } }, ['mappingKey'], true),
  definition('extensions.create', 'Create an owned extension draft; choose global for reusable code or project for this project only.', { id, scope, mappingKey: { type: 'string', description: 'Explicit local binding for a project that has no portable relative path.' }, expectedFingerprint: fingerprint }, ['id', 'scope'], true),
  definition('extensions.write', 'Write one file into this caller’s extension draft; supply text or base64.', { draftId, path: filePath, text: { type: 'string' }, base64: { type: 'string' } }, ['draftId', 'path'], true),
  definition('extensions.removeFile', 'Remove one file from this caller’s extension draft.', { draftId, path: filePath }, ['draftId', 'path'], true),
  definition('extensions.submit', 'Validate and immediately review a complete draft, then publish it if approved.', { draftId, retryRejected: { type: 'boolean' } }, ['draftId'], true),
  definition('extensions.retryReview', 'Explicitly retry a rejected current extension review. Specify scope if a global and project package share this ID.', { id, scope }, ['id'], true)
];
