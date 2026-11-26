import fs from 'node:fs';
import path from 'node:path';
import type { HarnessMcpDialect } from '../../shared/harnessIntegration';
import type { InboundMcpEngineFile } from '../../shared/inboundMcp';
import { assertHarnessMcpPublicPath } from './publicPath';
import type { HarnessPathContext } from './resolve';

type Profile = Pick<InboundMcpEngineFile, 'path' | 'format' | 'serversKey' | 'entryStyle' | 'requiresMcpEnabled' | 'rootDefaults'>;
/** Fixed engine adapters; declarations cannot inject environment reads or executable code. */
export function builtinMcpFile(dialect: Exclude<HarnessMcpDialect, 'opencode'>, context: HarnessPathContext): Profile {
  const platform = context.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const env = context.env ?? process.env;
  const join = (...parts: string[]): string => paths.join(...parts);
  const absolute = (value: string, name: string): string => {
    const expanded = /^~[\\/]/.test(value) ? join(context.homeDir, value.slice(2)) : value;
    if (!paths.isAbsolute(expanded)) throw new Error(`${name} must be an absolute path; configuration was preserved`);
    assertHarnessMcpPublicPath(expanded);
    return expanded;
  };
  const root = (variable: string, fallback: string): string => absolute(env[variable]?.trim() || fallback, variable);
  const xdg = (): string => context.configDir ?? root('XDG_CONFIG_HOME', join(context.homeDir, '.config'));
  const file = (filename: string, options: Omit<Profile, 'path'> = {}): Profile => ({ path: absolute(filename, dialect), format: 'json', ...options });
  const candidates = (directory: string, names: string[]): string => {
    const files = names.map(name => absolute(join(directory, name), dialect));
    const existing = files.filter(filename => fs.existsSync(filename));
    if (existing.length > 1) throw new Error(`${dialect}: multiple configuration files exist (${names.join(', ')}); merge them before retrying`);
    return existing[0] ?? files[0]!;
  };
  switch (dialect) {
    case 'kimi': {
      const current = join(context.homeDir, '.kimi-code');
      const legacy = join(context.homeDir, '.kimi');
      if (env.KIMI_CODE_HOME?.trim()) return file(join(root('KIMI_CODE_HOME', current), 'mcp.json'));
      if (env.KIMI_SHARE_DIR?.trim()) return file(join(root('KIMI_SHARE_DIR', legacy), 'mcp.json'));
      const directory = fs.existsSync(current) || !fs.existsSync(legacy) ? current : legacy;
      return file(join(directory, 'mcp.json'));
    }
    case 'grok': return file(join(root('GROK_HOME', join(context.homeDir, '.grok')), 'config.toml'), { format: 'toml', serversKey: ['mcp_servers'] });
    case 'commandcode': return file(join(context.homeDir, '.commandcode', 'mcp.json'), { entryStyle: platform === 'win32' ? 'stdio-transport-shell' : 'stdio-transport' });
    case 'cline': return file(env.CLINE_MCP_SETTINGS_PATH || join(context.homeDir, '.cline', 'data', 'settings', 'cline_mcp_settings.json'), platform === 'win32' ? { entryStyle: 'cline-shell' } : {});
    case 'copilot': return file(join(root('COPILOT_HOME', join(context.homeDir, '.copilot')), 'mcp-config.json'), { entryStyle: 'copilot' });
    case 'kilo': {
      if (env.KILO_CONFIG_CONTENT || env.KILO_CONFIG_DIR) throw new Error('Kilo custom config content/directory may override global MCP; use a config file or remove that override');
      return file(env.KILO_CONFIG || candidates(join(xdg(), 'kilo'), ['kilo.json', 'kilo.jsonc', 'config.json']), { format: 'jsonc', serversKey: ['mcp'], entryStyle: 'command-array' });
    }
    case 'devin': {
      const directory = platform === 'win32' ? join(context.configDir ?? root('APPDATA', join(context.homeDir, 'AppData', 'Roaming')), 'devin') : join(xdg(), 'devin');
      const current = file(join(directory, 'mcp_config.json'), { format: 'jsonc' });
      const legacy = file(join(directory, 'config.json'), { format: 'jsonc' });
      return fs.existsSync(current.path) || !fs.existsSync(legacy.path) ? current : legacy;
    }
    case 'hermes': return file(join(root('HERMES_HOME', join(context.homeDir, '.hermes')), 'config.yaml'), { format: 'yaml', serversKey: ['mcp_servers'] });
    case 'muse': return file(join(xdg(), 'muse', 'settings.json'), { serversKey: ['mcp_servers'], entryStyle: 'stdio-transport', rootDefaults: { schema_version: 1 } });
    case 'zcode': return file(join(context.homeDir, '.zcode', 'cli', 'config.json'), { serversKey: ['mcp', 'servers'], entryStyle: 'stdio-type', requiresMcpEnabled: true });
    case 'mimo': {
      if (env.MIMOCODE_CONFIG_CONTENT || env.MIMOCODE_CONFIG_DIR) throw new Error('MiMo custom config content/directory may override global MCP; use a config file or remove that override');
      const directory = env.MIMOCODE_HOME ? join(root('MIMOCODE_HOME', ''), 'config') : join(xdg(), 'mimocode');
      return file(env.MIMOCODE_CONFIG || candidates(directory, ['mimocode.json', 'mimocode.jsonc', 'config.json']), { format: 'jsonc', serversKey: ['mcp'], entryStyle: 'command-array' });
    }
    case 'qwen': return file(join(root('QWEN_HOME', join(context.homeDir, '.qwen')), 'settings.json'), { serversKey: ['mcpServers'] });
  }
}
