import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, CLI_PROTOCOL_VERSION } from '../../shared/cli';
import { PRODUCT_CLI_HOME_DIR, PRODUCT_CLI_HOME_ENV, PRODUCT_CLI_NAME, PRODUCT_NAME } from '../../shared/productIdentity';
export interface CliInstance { protocolVersion: number; id: string; pid: number; port: number; token: string; version: string; startedAt: number }
export function cliDiscoveryHome(env: NodeJS.ProcessEnv = process.env) { return env[PRODUCT_CLI_HOME_ENV] || path.join(os.homedir(), PRODUCT_CLI_HOME_DIR); }
export function readCliInstances(directory: string): CliInstance[] {
  let names: string[];
  try { names = fs.readdirSync(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^[a-zA-Z0-9_-]+\.json$/.test(name)).flatMap(name => {
    let value: CliInstance;
    try { value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); } catch { throw new CliError('discovery_corrupt', `Unreadable CLI instance descriptor: ${name}`, `Run ${PRODUCT_CLI_NAME} doctor; restart the workbench to refresh its descriptor`); }
    if (value.protocolVersion !== CLI_PROTOCOL_VERSION || !/^[a-zA-Z0-9_-]+$/.test(value.id) || !Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.token)) throw new CliError('discovery_corrupt', `Invalid CLI instance descriptor: ${name}`);
    try { process.kill(value.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return []; throw error; }
    return [value];
  });
}
export function selectCliInstance(instances: CliInstance[], id?: string): CliInstance {
  const matches = id ? instances.filter(instance => instance.id === id) : instances;
  if (!matches.length) throw new CliError('not_running', id ? `Local instance not running: ${id}` : 'No running local workbench found', `Start ${PRODUCT_NAME}; use the same Windows user. For a sandbox set ${PRODUCT_CLI_HOME_ENV} explicitly.`);
  if (matches.length !== 1) throw new CliError('ambiguous_instance', 'Multiple local workbenches are running', `Choose --instance ID: ${matches.map(instance => instance.id).join(', ')}`);
  return matches[0];
}
