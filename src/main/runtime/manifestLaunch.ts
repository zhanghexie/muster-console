import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath } from '../../shared/runtimePreflight';
import { winCmdLaunchArgs } from '../encoding/winUtf8';
import type { RuntimeManifest } from '../../shared/runtimeManifest';

export function manifestExecutable(command: string): string | null {
  const executable = (file: string): boolean => {
    try {
      if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) return false;
      if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  if (path.isAbsolute(command)) return executable(command) ? command : null;
  if (!/^[\w][\w.-]*$/.test(command)) throw new Error('Runtime command must be an absolute file path or a single program name');
  const home = os.homedir();
  const fallback = process.platform === 'win32'
    ? [process.env.APPDATA && path.join(process.env.APPDATA, 'npm')]
    : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
  const directories = [...(process.env.PATH ?? '').split(path.delimiter), ...fallback]
    .filter((dir): dir is string => !!dir).map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => path.isAbsolute(dir));
  return findOnPath([command], { pathEnv: directories.join(path.delimiter), exists: executable, join: path.join });
}

export function manifestLaunch(command: string, args: string[], platform: NodeJS.Platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    if (/[%"!\r\n]/.test(command) || args.some(arg => /[%"!\u0000-\u001f]/.test(arg))) {
      throw new Error('Windows batch launch cannot safely pass quotes, percent or exclamation marks, or control characters');
    }
    const cmd = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const launchArgs = winCmdLaunchArgs([command, ...args]);
    launchArgs.splice(1, 0, '/v:off');
    return { command: cmd, args: launchArgs, windowsVerbatimArguments: true as const };
  }
  return { command, args };
}

export function bindManifestCommands(manifest: RuntimeManifest): RuntimeManifest {
  const bound = structuredClone(manifest);
  for (const endpoint of [bound.terminal, bound.chat]) {
    if (!endpoint) continue;
    const executable = manifestExecutable(endpoint.command);
    if (!executable) throw new Error(`Runtime executable was not found: ${endpoint.command}`);
    manifestLaunch(executable, endpoint.args ?? []);
    endpoint.command = executable;
  }
  return bound;
}
