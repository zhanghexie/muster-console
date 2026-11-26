import { inboundMcpLaunchFromEntry, type InboundMcpEngineFile, type InboundMcpLaunch } from '../../shared/inboundMcp';
import { winCmdLaunchArgs } from '../encoding/winUtf8';

export function harnessMcpEntry(launch: InboundMcpLaunch, file: InboundMcpEngineFile): Record<string, unknown> {
  const standard = { command: launch.command, args: launch.args, ...(Object.keys(launch.env ?? {}).length ? { env: launch.env } : {}) };
  switch (file.entryStyle) {
    case 'command-array': return { type: 'local', command: [launch.command, ...launch.args], ...(Object.keys(launch.env ?? {}).length ? { environment: launch.env } : {}) };
    case 'copilot': return { type: 'local', ...standard, tools: ['*'] };
    case 'stdio-type': return { type: 'stdio', ...standard, enabled: true };
    case 'stdio-transport': return { transport: 'stdio', enabled: true, ...standard };
    case 'cline-shell':
    case 'stdio-transport-shell': {
      if ([launch.command, ...launch.args].some(arg => /[%!\r\n]/.test(arg))) throw new Error('Windows MCP shell cannot safely represent %, ! or line breaks in paths; use an installation path without these characters');
      return { ...(file.entryStyle === 'stdio-transport-shell' ? { transport: 'stdio', enabled: true } : {}), command: 'cmd.exe', args: winCmdLaunchArgs([launch.command, ...launch.args]), ...(standard.env ? { env: standard.env } : {}) };
    }
    default: return standard;
  }
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export function matchesHarnessMcpEntry(value: unknown, launch: InboundMcpLaunch, file: InboundMcpEngineFile): boolean {
  return JSON.stringify(canonical(value)) === JSON.stringify(canonical(harnessMcpEntry(launch, file)));
}

/** Strip only our exact engine-specific fields, retaining strict ownership checks. */
export function harnessMcpLaunch(value: unknown, file?: InboundMcpEngineFile): InboundMcpLaunch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const only = (keys: string[]): boolean => Object.keys(entry).every(key => keys.includes(key));
  const { command, args, env } = entry;
  switch (file?.entryStyle) {
    case 'cline-shell': return null; // Ownership compares the exact generated shell argv, never reparses shell text.
    case 'command-array':
      if (!only(['type', 'command', 'environment']) || entry.type !== 'local' || !Array.isArray(command) || !command.length) return null;
      return inboundMcpLaunchFromEntry({ command: command[0], args: command.slice(1), ...(entry.environment !== undefined ? { env: entry.environment } : {}) });
    case 'copilot':
      if (!only(['type', 'command', 'args', 'env', 'tools']) || entry.type !== 'local' || JSON.stringify(entry.tools) !== '["*"]') return null;
      break;
    case 'stdio-type':
      if (!only(['type', 'command', 'args', 'env', 'enabled']) || entry.type !== 'stdio' || entry.enabled !== true) return null;
      break;
    case 'stdio-transport-shell': // Also recognize a previously owned, unwrapped transport entry for safe upgrade.
    case 'stdio-transport':
      if (!only(['transport', 'enabled', 'command', 'args', 'env']) || entry.transport !== 'stdio' || entry.enabled !== undefined && entry.enabled !== true) return null;
      break;
    default: return inboundMcpLaunchFromEntry(value);
  }
  return inboundMcpLaunchFromEntry({ command, args, ...(env !== undefined ? { env } : {}) });
}
