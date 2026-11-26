import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CLI_COMMANDS, CLI_EXIT_CODES, CLI_PROTOCOL_VERSION, CliError, cliCommand, cliSchema, validateCliArgs } from '../../shared/cli';
import { PRODUCT_CLI_NAME, PRODUCT_NAME } from '../../shared/productIdentity';
import { cliDiscoveryHome, readCliInstances, selectCliInstance } from './discovery';

function help(words: string[]) {
  const name = words.join(' '), matches = CLI_COMMANDS.filter(command => !name || command.name === name || command.name.startsWith(`${name} `));
  if (!matches.length) throw new CliError('invalid_arguments', `Unknown command: ${name}`);
  return [`${PRODUCT_NAME} CLI — submit tasks to the running local workbench scheduler.`, `Usage: ${PRODUCT_CLI_NAME} <command> [options]`, '', ...matches.flatMap(command => [
    `${command.name}${command.positional ? ` <${command.positional}>` : ''} — ${command.description}`,
    ...Object.entries(command.options).map(([key, value]) => `  --${key} <${value.type}>${value.required ? ' (required)' : ''}: ${value.description}${value.default === undefined ? '' : ` (default ${value.default})`}`),
    `  Example: ${command.example}`, ''
  ]), 'Global: --json (default), --human, --instance ID, --help', 'Text input: exactly one of --text TEXT, --file PATH (UTF-8), --stdin.', `Discovery: ${PRODUCT_CLI_NAME} capabilities --json; ${PRODUCT_CLI_NAME} schema "run submit" --json.`, 'The workbench must be running. Existing terminals/Agent apps may need reopening after installation.', `Exit codes: ${JSON.stringify(CLI_EXIT_CODES)}`].join('\n');
}
async function stdinText() {
  if (process.stdin.isTTY) throw new CliError('invalid_arguments', '--stdin requires piped input');
  let value = '', bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const part of process.stdin) { bytes += Buffer.byteLength(part); if (bytes > 1048576) throw new CliError('invalid_arguments', 'Standard input exceeds 1 MiB'); value += part; }
  return value;
}
export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  let human = false;
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, human ? 2 : undefined)}\n`);
  try {
    const words: string[] = [], values: Record<string, string> = {}, flags = new Set<string>();
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '-h') { flags.add('help'); continue; }
      if (!arg.startsWith('--')) { words.push(arg); continue; }
      const [key, ...suffix] = arg.slice(2).split('=');
      if (Object.hasOwn(values, key) || flags.has(key)) throw new CliError('invalid_arguments', `Duplicate option: --${key}`);
      if (['help', 'json', 'human', 'stdin'].includes(key)) { if (suffix.length) throw new CliError('invalid_arguments', `--${key} takes no value`); flags.add(key); continue; }
      const value = suffix.length ? suffix.join('=') : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new CliError('invalid_arguments', `--${key} requires a value`);
      values[key] = value;
    }
    human = flags.has('human');
    if (human && flags.has('json')) throw new CliError('invalid_arguments', 'Choose --human or --json');
    if (flags.has('help') || !words.length) { process.stdout.write(`${help(words)}\n`); return 0; }
    const definition = [...CLI_COMMANDS].sort((a, b) => b.name.split(' ').length - a.name.split(' ').length).find(command => command.name.split(' ').every((word, index) => words[index] === word));
    if (!definition) throw new CliError('invalid_arguments', `Unknown command: ${words.join(' ')}`, `Run ${PRODUCT_CLI_NAME} --help`);
    const rest = words.slice(definition.name.split(' ').length), args: Record<string, unknown> = {};
    if (definition.positional) { if (!rest.length) throw new CliError('invalid_arguments', `Missing ${definition.positional}`); if (definition.name !== 'schema' && rest.length !== 1) throw new CliError('invalid_arguments', 'Unexpected positional arguments'); args[definition.positional] = rest.join(' '); }
    else if (rest.length) throw new CliError('invalid_arguments', 'Unexpected positional arguments');
    const instanceId = values.instance; delete values.instance;
    if (flags.has('stdin') || values.file !== undefined) {
      if (!['run submit', 'run reply'].includes(definition.name) || [flags.has('stdin'), values.file !== undefined, values.text !== undefined].filter(Boolean).length !== 1) throw new CliError('invalid_arguments', 'Use exactly one text source: --text, --file or --stdin');
      if (values.file !== undefined) { if (fs.statSync(values.file).size > 1048576) throw new CliError('invalid_arguments', 'Input file exceeds 1 MiB'); args.text = fs.readFileSync(values.file, 'utf8').replace(/^\uFEFF/, ''); delete values.file; }
      else args.text = await stdinText();
    }
    for (const [key, value] of Object.entries(values)) { const option = definition.options[key]; args[key] = option?.type === 'integer' && /^\d+$/.test(value) ? Number(value) : value; }
    const validated = validateCliArgs(definition, args);
    if (definition.name === 'capabilities') { output({ ok: true, result: { protocolVersion: CLI_PROTOCOL_VERSION, commands: CLI_COMMANDS.map(cliSchema), exitCodes: CLI_EXIT_CODES } }); return 0; }
    if (definition.name === 'schema') { output({ ok: true, result: cliSchema(cliCommand(String(validated.command))) }); return 0; }
    const instance = selectCliInstance(readCliInstances(cliDiscoveryHome()), instanceId);
    const deadline = Date.now() + Number(validated.timeout ?? 0) * 1000;
    let envelope: { ok: boolean; result?: Record<string, unknown>; error?: { code: string; message: string; hint?: string } };
    do {
      const requestArgs = definition.name === 'run wait' ? { ...validated, timeout: Math.min(25, Math.max(0, Math.ceil((deadline - Date.now()) / 1000))) } : validated;
      let response: Response;
      try { response = await fetch(`http://127.0.0.1:${instance.port}/v1/command`, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${instance.token}` }, body: JSON.stringify({ command: definition.name, args: requestArgs }), signal: AbortSignal.timeout(30000) }); }
      catch { throw new CliError('connection_failed', `Cannot reach local workbench ${instance.id}`, `Restart the workbench or run ${PRODUCT_CLI_NAME} doctor. Submitted tasks are not automatically retried.`); }
      envelope = await response.json() as typeof envelope;
      if (!envelope || typeof envelope.ok !== 'boolean') throw new CliError('invalid_response', 'Invalid CLI response from workbench');
      if (!envelope.ok) throw new CliError(envelope.error?.code ?? 'host_error', envelope.error?.message ?? 'Workbench request failed', envelope.error?.hint);
    } while (definition.name === 'run wait' && envelope.result?.timedOut && Date.now() < deadline);
    output(envelope);
    if (definition.name === 'run wait' || definition.name === 'run result') {
      const result = envelope.result!;
      if (result.timedOut) return 7;
      return ({ delivered: 0, waiting: 3, failed: 4, cancelled: 5, interrupted: 6 } as Record<string, number>)[String(result.state)] ?? 3;
    }
    if (definition.name === 'run cancel' && Array.isArray(envelope.result?.cancellationErrors) && envelope.result.cancellationErrors.length) return 1;
    return 0;
  } catch (error) {
    const issue = error instanceof CliError ? error : new CliError('cli_error', error instanceof Error ? error.message : String(error));
    output({ ok: false, error: { code: issue.code, message: issue.message, hint: issue.hint } });
    return issue.code === 'invalid_arguments' ? 2 : 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runCli().then(code => { process.exitCode = code; });
