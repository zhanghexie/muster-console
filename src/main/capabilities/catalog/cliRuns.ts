import { CLI_LAUNCH_OPTIONS_SCHEMA } from '../../../shared/cliLaunchOptions';
import type { ToolDef } from './types';
import { isolationProperty } from '../../../shared/sessionIsolation';
import { worktreeSelectionProperty } from './worktreeSelection';
import { NATIVE_CONFIG_INTENT_SCHEMA } from '../../../shared/nativeSessionConfig';
const runId = { type: 'string', description: 'External CLI run ID from the task notification; never infer from current UI' };
const string = (description: string) => ({ type: 'string', description });
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name: `runs.${name}`, description, dangerous: false, parameters: { type: 'object', properties, required } };
}
export const CLI_RUN_TOOL_DEFS: ToolDef[] = [
  tool('get', 'Read an external CLI task: latest instructions, executor, and waiting items. Scheduler only, strictly bound to the current tool workspace.', { runId }, ['runId']),
  tool('delegate', 'Delegate a dedicated Worker for an external CLI task, auto-linking task and session without stealing focus. Prefer GUI; CLI Workers are not recommended and require an explicit runtime. Use this instead of sessions.create for such tasks. Task parameters match sessions.create; call dispatch.run with action "get" first to confirm the current instructions.', {
    runId, task: string('Self-contained worker brief'), runtime: string('Enabled runtime ID; omit for configured GUI or pi. Specify a CLI ID explicitly to use it.'), name: string('Worker name'), rootId: string('Workspace source root ID'), cwd: string('Absolute working directory inside selected root'),
    isolation: isolationProperty, isolationGroups: worktreeSelectionProperty,
    rootsRevision: { type: 'integer', description: 'Workspace source root revision' },
    configurePermissions: { type: 'boolean', description: 'Enable explicit permission configuration and review. Defaults to false (automatic maximum permissions).' },
    guiMode: { type: 'string', enum: ['default', 'ask', 'plan', 'auto'], description: 'Muster Core session permission.' },
    cliLaunchOptions: { ...CLI_LAUNCH_OPTIONS_SCHEMA, description: 'Native CLI launch options. Set configurePermissions to true to apply explicit permission values.' },
    nativeConfig: { ...NATIVE_CONFIG_INTENT_SCHEMA, description: 'External GUI Harness settings from host.workers.options (mode: native-settings).' },
    acpPresetId: string('ACP product preset identity'),
    model: { type: 'object', properties: { providerId: string('Provider ID'), modelId: string('Model ID') }, required: ['providerId', 'modelId'] }
  }, ['runId', 'task', 'isolation']),
  tool('progress', 'Record progress or a pending human-action entry for an external CLI task; does not mean the task is delivered.', { runId, text: string('Progress and any required human action') }, ['runId', 'text']),
  tool('ask', 'Ask the external calling agent for more information; returns question.id, answered by the caller via CLI run reply. Not a substitute for user approval or authorization.', { runId, question: string('Specific question to the caller') }, ['runId', 'question']),
  tool('deliver', 'Explicitly deliver an external CLI task: summary, absolute artifact paths, and verification notes. Confirm first that all linked Workers are accepted or finished and pending questions and appended instructions are handled. This tool does not integrate, archive, or bypass human confirmation.', {
    runId, summary: string('Final answer and deliverables'), artifacts: { type: 'array', items: { type: 'string' }, description: 'Absolute paths, or []' }, verification: string('Checks actually performed and any unverified limits')
  }, ['runId', 'summary', 'artifacts', 'verification']),
  tool('fail', 'Explicitly mark an external CLI task failed with the reason; never fake success or auto-redelegate.', { runId, error: string('Failure and recovery guidance') }, ['runId', 'error'])
];
