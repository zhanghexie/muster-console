/**
 * ACP 脑「配置即接入」：接新 agent = 加一条预设，不改通用 driver。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { winCmdLaunchArgs } from '../../../encoding/winUtf8';
import { findOnPath } from '../../../../shared/runtimePreflight';
import { HARNESS_CATALOG } from '../../../../shared/harnessCatalog';
import { registeredRuntimeManifests } from '../../../runtime/manifestCatalog';
import { manifestExecutable, manifestLaunch } from '../../../runtime/manifestLaunch';
import type { AcpMcpPermissionMetadata } from '../../../../shared/runtimeManifest';

export type AcpAgentId = string;

export interface AcpAgentPreset {
  id: AcpAgentId;
  name: string;
  description: string;
  /** argv[0] 可执行文件候选（PATH 名或绝对路径） */
  commands: string[];
  args: string[];
  fallback?: Pick<AcpAgentPreset, 'commands' | 'args'>;
  manifest?: boolean;
  installUrl?: string;
  mcpPermissionMetadata?: AcpMcpPermissionMetadata;
}

/** Built-in ACP launchers share their identity and arguments with the product catalogue. */
export const ACP_AGENT_PRESETS: readonly AcpAgentPreset[] = HARNESS_CATALOG
  .filter(entry => entry.transport === 'acp' && entry.integration === 'builtin' && !!entry.acpPresetId)
  .map(entry => ({
    id: entry.acpPresetId!,
    name: entry.name,
    description: `${entry.name} ACP（stdio JSON-RPC）`,
    commands: [...entry.commands],
    args: [...entry.args],
    ...(entry.acpFallback ? { fallback: { commands: [...entry.acpFallback.commands], args: [...entry.acpFallback.args] } } : {}),
    installUrl: entry.installUrl
  }));

export function getAcpPresets(userDataDir?: string): AcpAgentPreset[] {
  const declared = registeredRuntimeManifests(userDataDir).flatMap(manifest => manifest.chat ? [{
    id: manifest.id, name: manifest.label, description: `${manifest.label} ACP（stdio JSON-RPC）`,
    commands: [manifest.chat.command], args: manifest.chat.args ?? [], manifest: true, installUrl: manifest.installUrl,
    mcpPermissionMetadata: manifest.chat.mcpPermissionMetadata
  }] : []);
  return [...ACP_AGENT_PRESETS, ...declared];
}

/** Only catalogued ACP presets are selectable. */
export function isAcpAgentId(value: string, presets: AcpAgentPreset[] = [...ACP_AGENT_PRESETS]): boolean {
  return presets.some(preset => preset.id === value);
}

export function lookOnPath(names: string[]): string | null {
  const isFile = (file: string): boolean => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  for (const name of names) {
    if (path.isAbsolute(name) && isFile(name)) return name;
  }
  return findOnPath(names.filter((name) => !path.isAbsolute(name)), {
    platform: process.platform,
    pathEnv: (process.env.PATH ?? '').split(path.delimiter).map((dir) => dir.trim().replace(/^"(.*)"$/, '$1')).join(path.delimiter),
    pathExt: process.env.PATHEXT,
    exists: isFile,
    join: path.join
  });
}

/** Probe common per-user launcher locations when the app inherited an older PATH. */
function findPresetExecutable(preset: AcpAgentPreset, commands: string[]): string | null {
  if (preset.manifest) return manifestExecutable(commands[0]);
  const found = lookOnPath(commands);
  // A user override is trusted as a complete launch configuration. Do not substitute
  // a different executable merely because it shares a builtin id.
  if (found || !ACP_AGENT_PRESETS.includes(preset)) return found;
  const home = os.homedir();
  const roots = process.platform === 'win32'
    ? [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), path.join(home, '.local', 'bin')].filter((p): p is string => !!p)
    : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin'];
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  const candidates = roots.flatMap(root => commands.flatMap(command =>
    extensions.map(ext => path.join(root, command + (path.extname(command) ? '' : ext)))
  ));
  // The official Windows installer puts its shims here; the desktop may have
  // inherited PATH before the installation updated the user's environment.
  if (preset.id === 'cursor' && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dir = path.join(process.env.LOCALAPPDATA, 'cursor-agent');
    candidates.push(...['cursor-agent.exe', 'cursor-agent.cmd', 'cursor-agent.bat'].map(file => path.join(dir, file)));
  }
  if (preset.id === 'qwen' && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dir = path.join(process.env.LOCALAPPDATA, 'qwen-code', 'bin');
    candidates.push(...['qwen.exe', 'qwen.cmd', 'qwen.bat'].map(file => path.join(dir, file)));
  }
  if (preset.id === 'antigravity' && commands.includes('agy')) {
    candidates.unshift(...antigravityWindowsInstallCandidates(process.platform, process.env.LOCALAPPDATA));
  }
  if (preset.id === 'mimo-code') candidates.push(...mimoInstallCandidates(process.platform, home));
  if (preset.id === 'opencode') {
    if (process.platform === 'win32') {
      for (const dir of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
        if (dir) candidates.push(path.join(dir, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
      }
    } else {
      candidates.push('/usr/local/lib/node_modules/opencode-ai/bin/opencode', path.join(home, '.opencode', 'bin', 'opencode'));
    }
  }
  if (preset.id === 'deepseek') {
    // Desktop bundles the same dsh launcher without necessarily registering it on PATH.
    if (process.platform === 'win32') {
      for (const root of [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
        process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
        if (root) candidates.push(path.join(root, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
      }
    } else if (process.platform === 'darwin') {
      for (const root of ['/Applications', path.join(home, 'Applications')]) {
        candidates.push(path.join(root, 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'));
      }
    } else if (process.platform === 'linux') {
      for (const root of ['/opt/DeepSeek Harness', '/opt/deepseek-harness', '/usr/local/lib/deepseek-harness']) {
        candidates.push(path.join(root, 'resources', 'runtime', 'cli', 'bin', 'dsh'));
      }
    }
  }
  return lookOnPath(candidates);
}

function findPresetLaunch(preset: AcpAgentPreset): { executable: string; args: string[] } | null {
  const executable = findPresetExecutable(preset, preset.commands);
  if (executable) return { executable, args: preset.args };
  if (!preset.fallback) return null;
  const fallback = findPresetExecutable(preset, preset.fallback.commands);
  return fallback ? { executable: fallback, args: preset.fallback.args } : null;
}

export function antigravityWindowsInstallCandidates(platform: NodeJS.Platform, localAppData?: string): string[] {
  return platform === 'win32' && localAppData ? [path.win32.join(localAppData, 'agy', 'bin', 'agy.exe')] : [];
}

/** Official MiMo Code installers use this same home-relative location on all platforms. */
export function mimoInstallCandidates(platform: NodeJS.Platform, home: string): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  return [paths.join(home, '.mimocode', 'bin', platform === 'win32' ? 'mimo.exe' : 'mimo')];
}

export function resolveAcpLaunch(
  agentId: AcpAgentId,
  overrides?: { command?: string; args?: string[]; },
  presets?: AcpAgentPreset[]
): { command: string; args: string[]; executable?: string; } | { error: string; } {
  const list = presets ?? ACP_AGENT_PRESETS;
  const preset = list.find((p) => p.id === agentId);
  if (!preset) {
    return { error: `Unknown ACP agent: ${agentId}` };
  }
  const overrideCommand = overrides?.command?.trim();
  if (overrideCommand) {
    const filename = path.basename(overrideCommand);
    const commandName = process.platform === 'win32' ? filename.toLowerCase().replace(/\.(exe|cmd|bat)$/, '') : filename;
    const args = preset.fallback?.commands.includes(commandName) ? preset.fallback.args : preset.args;
    return wrapCmdShimIfNeeded(overrideCommand, overrides?.args ?? args);
  }
  const launch = findPresetLaunch(preset);
  if (!launch) {
    const names = [...preset.commands, ...(preset.fallback?.commands ?? [])];
    return {
      error: `Cannot find ${preset.name} executable (${names.join('/')}). Install it and ensure it is on PATH. ACP never fills vendor API keys — run the CLI's own login/setup first.`
    };
  }
  const args = overrides?.args ?? launch.args;
  if (preset.manifest) {
    try { return { ...manifestLaunch(launch.executable, args), executable: launch.executable }; }
    catch (error) { return { error: (error as Error).message }; }
  }
  return wrapCmdShimIfNeeded(launch.executable, args);
}

/**
 * npm 全局安装的 CLI 多为 `.cmd` shim：Node 的 spawn 不能直接执行（EINVAL，Node 官方
 * 要求经 cmd.exe）——PATH 探测（PATHEXT）认得的 .cmd/.bat 必须包一层（N-1，与 pty
 * runtime 的 wrapWinCmd 同配方：chcp 输出重定向 nul，不污染 NDJSON 管道）。
 */
export function wrapCmdShimIfNeeded(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; executable?: string; } | { error: string; } {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    if ([command, ...args].some(value => value.includes('%'))) {
      return { error: 'ACP 启动命令或参数包含 %，Windows cmd 会展开环境变量；请修改配置后重试' };
    }
    return { command: 'cmd.exe', args: winCmdLaunchArgs([command, ...args]), executable: command };
  }
  return { command, args, executable: command };
}

export function defaultAcpAgentId(preferred?: string, presets?: AcpAgentPreset[]): AcpAgentId {
  const available = presets ?? [...ACP_AGENT_PRESETS];
  if (preferred) return preferred;
  // Cursor has a dedicated product entry; do not silently rebind existing
  // generic ACP sessions (including their resume tokens) to the new preset.
  for (const p of available.filter(item => item.id !== 'cursor' && !item.manifest)) {
    if (findPresetLaunch(p)) return p.id;
  }
  return 'opencode';
}
