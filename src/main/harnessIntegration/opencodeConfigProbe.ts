import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { extractCliToken } from '../../shared/runtimePreflight';
import { resolveAcpLaunch } from '../agentSession/drivers/acp/agents';
import { winCmdLaunchArgs } from '../encoding/winUtf8';
import type { OpenCodeMcpLayout } from './opencode';

const exec = promisify(execFile);

/** Determine whether OpenCode actually reads a flat MCP map, using a throwaway configuration. */
export async function probeOpenCodeMcpLayout(): Promise<OpenCodeMcpLayout> {
  let directory: string | undefined;
  try {
    const launch = resolveAcpLaunch('opencode');
    if ('error' in launch) return 'nested';
    const argv = ['--pure', 'debug', 'config'];
    const cmdShim = /^cmd(?:\.exe)?$/i.test(launch.command);
    const args = cmdShim ? winCmdLaunchArgs([extractCliToken(launch), ...argv]) : argv;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-config-'));
    const file = path.join(directory, 'opencode.json');
    await fs.writeFile(file, JSON.stringify({ mcp: { muster_layout_probe: { type: 'local', command: ['node'], enabled: false } } }));
    const env = {
      ...process.env,
      HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
      XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory, XDG_STATE_HOME: directory,
      OPENCODE_CONFIG: file, OPENCODE_CONFIG_DIR: '', OPENCODE_CONFIG_CONTENT: '',
      OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1'
    };
    // winCmdLaunchArgs already quotes the shim path for cmd.exe.
    const { stdout } = await exec(launch.command, args, { cwd: directory, env, timeout: 3000, maxBuffer: 256 * 1024,
      windowsHide: true, windowsVerbatimArguments: cmdShim });
    const config = JSON.parse(stdout);
    if (config?.mcp?.muster_layout_probe?.type === 'local') return 'flat';
  } catch { /* Newer CLIs use a nested map and may omit the legacy config inspection command. */ }
  finally { if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {}); }
  return 'nested';
}
