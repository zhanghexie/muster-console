/** Public CLI contract. Help, discovery, parsing and server validation share this table. */
import { PRODUCT_CLI_NAME } from './productIdentity';
export const CLI_PROTOCOL_VERSION = 1;
export type CliOption = { type: 'string' | 'integer'; description: string; required?: boolean; default?: number; min?: number; max?: number };
export type CliCommand = { name: string; description: string; positional?: string; options: Record<string, CliOption>; example: string; local?: boolean };
const workspace: CliOption = { type: 'string', description: 'Explicit workspace ID', required: true };
const text: CliOption = { type: 'string', description: 'Task or reply text; alternatively use --file PATH or --stdin' };
const limit: CliOption = { type: 'integer', description: 'Page size', default: 40, min: 1, max: 200 };
const offset: CliOption = { type: 'integer', description: 'Page offset', default: 0, min: 0, max: 1_000_000 };
export const CLI_COMMANDS: readonly CliCommand[] = [
  { name: 'status', description: 'Connected local instance, version and available workspaces', options: {}, example: `${PRODUCT_CLI_NAME} status` },
  { name: 'doctor', description: 'Diagnose local discovery, instance selection and connection', options: {}, example: `${PRODUCT_CLI_NAME} doctor` },
  { name: 'capabilities', description: 'List supported commands and output conventions (offline)', options: {}, example: `${PRODUCT_CLI_NAME} capabilities --json`, local: true },
  { name: 'schema', description: 'Describe one command, its arguments, result and errors (offline)', positional: 'command', options: {}, example: `${PRODUCT_CLI_NAME} schema "run submit" --json`, local: true },
  { name: 'workspace list', description: 'List accessible workspaces without changing the active workspace', options: { limit, offset }, example: `${PRODUCT_CLI_NAME} workspace list` },
  { name: 'run submit', description: 'Submit a task to the workspace scheduler; returns a persistent runId', options: { workspace, text, 'idempotency-key': { type: 'string', description: 'Reuse the same key on retries; different content is rejected' } }, example: `${PRODUCT_CLI_NAME} run submit --workspace <id> --file task.md --idempotency-key task-001` },
  { name: 'run list', description: 'List runs in an explicit workspace', options: { workspace, limit, offset }, example: `${PRODUCT_CLI_NAME} run list --workspace <id>` },
  { name: 'run get', description: 'Read state, linked workers, progress and outstanding question', positional: 'runId', options: {}, example: `${PRODUCT_CLI_NAME} run get <runId>` },
  { name: 'run wait', description: 'Wait for delivery, failure, cancellation, interruption or a question; timeout does not cancel', positional: 'runId', options: { timeout: { type: 'integer', description: 'Total wait in seconds', default: 120, min: 0, max: 43200 } }, example: `${PRODUCT_CLI_NAME} run wait <runId> --timeout 120` },
  { name: 'run result', description: 'Read explicit scheduler delivery; never guesses from the last chat message', positional: 'runId', options: {}, example: `${PRODUCT_CLI_NAME} run result <runId>` },
  { name: 'run logs', description: 'Read incremental source-labelled task events and worker transcript tails', positional: 'runId', options: { after: { type: 'integer', description: 'Last event sequence previously received', default: 0, min: 0, max: Number.MAX_SAFE_INTEGER }, limit }, example: `${PRODUCT_CLI_NAME} run logs <runId> --after 0` },
  { name: 'run reply', description: 'Answer the current question or append instructions; cannot approve human-only actions', positional: 'runId', options: { text, 'question-id': { type: 'string', description: 'Required when answering an outstanding question' }, 'idempotency-key': { type: 'string', description: 'Deduplicate a retried reply' } }, example: `${PRODUCT_CLI_NAME} run reply <runId> --question-id <id> --text "Use option A"` },
  { name: 'run cancel', description: 'Cancel this run and interrupt only its exclusively linked workers', positional: 'runId', options: {}, example: `${PRODUCT_CLI_NAME} run cancel <runId>` },
  { name: 'open', description: 'Open the run workspace scheduler in the desktop workbench for human handoff', positional: 'runId', options: {}, example: `${PRODUCT_CLI_NAME} open <runId>` }
];
export const CLI_EXIT_CODES = { success: 0, connectionOrHostError: 1, invalidArguments: 2, needsResponseOrNotReady: 3, failed: 4, cancelled: 5, interrupted: 6, timeout: 7 };
export const CLI_STATES = ['queued', 'running', 'waiting', 'delivered', 'failed', 'cancelled', 'interrupted'] as const;
export type CliRunState = typeof CLI_STATES[number];
export const CLI_TERMINAL_STATES: readonly CliRunState[] = ['delivered', 'failed', 'cancelled', 'interrupted'];
export class CliError extends Error {
  constructor(public code: string, message: string, public hint?: string) { super(message); }
}
export function cliCommand(name: string): CliCommand {
  const def = CLI_COMMANDS.find(command => command.name === name);
  if (!def) throw new CliError('invalid_arguments', `Unknown command: ${name}`, `Run ${PRODUCT_CLI_NAME} --help`);
  return def;
}
export function validateCliArgs(def: CliCommand, input: unknown): Record<string, string | number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('invalid_arguments', 'Arguments must be an object');
  const args = input as Record<string, unknown>;
  const specs = { ...def.options, ...(def.positional ? { [def.positional]: { type: 'string', required: true, description: '' } as CliOption } : {}) };
  for (const key of Object.keys(args)) if (!(key in specs)) throw new CliError('invalid_arguments', `Unknown argument: ${key}`);
  const result: Record<string, string | number> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const value = args[key] ?? spec.default;
    if (value === undefined) { if (spec.required) throw new CliError('invalid_arguments', `Missing ${key}`); continue; }
    if (spec.type === 'string') {
      if (typeof value !== 'string' || !value.trim() || value.length > 262144) throw new CliError('invalid_arguments', `Invalid ${key}`);
    } else if (!Number.isSafeInteger(value) || Number(value) < (spec.min ?? 0) || Number(value) > (spec.max ?? Number.MAX_SAFE_INTEGER)) throw new CliError('invalid_arguments', `Invalid ${key}`);
    result[key] = value as string | number;
  }
  if (['run submit', 'run reply'].includes(def.name) && !result.text) throw new CliError('invalid_arguments', 'Task/reply text is required', 'Use --text, --file or --stdin');
  return result;
}
export function cliSchema(def: CliCommand) {
  return { protocolVersion: CLI_PROTOCOL_VERSION, ...def, globals: ['--json (default)', '--human', '--instance ID', '--help'], textInput: ['--text TEXT', '--file PATH (UTF-8)', '--stdin'],
    result: { envelope: '{ok:true,result:...} | {ok:false,error:{code,message,hint?}}', command: def.name,
      fields: def.name === 'run logs' ? ['events', 'nextCursor', 'hasMore', 'truncated'] : def.name.startsWith('run ') ? ['runId', 'workspaceId', 'state', 'workers', 'question?', 'result?', 'error?', 'revision'] : ['command-specific result'],
      states: CLI_STATES, delivery: '{summary:string,artifacts:string[],verification:string}', question: '{id:string,text:string}' }, exitCodes: CLI_EXIT_CODES };
}
