/** Finds the user's Codex CLI for GUI turns and model discovery. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import { findOnPath } from '../../../../shared/runtimePreflight';

export interface CodexExecutableDiscoveryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  execPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Must accept executable files, not directories or npm shell shims. */
  isExecutable?: (file: string) => boolean;
  /**
   * Injected where/which results (absolute paths). Tests stub this so discovery
   * stays hermetic. Production only runs the OS lookup when isExecutable is also default.
   */
  lookupOnPath?: (command: string) => string[];
  /** Fixture for the Windows desktop's versioned per-user bin directory. */
  listDesktopVersions?: (root: string) => Array<{ name: string; mtimeMs: number }>;
}

const WIN_SHIM_EXT = /\.(cmd|bat|ps1)$/i;

function isWindowsShim(file: string): boolean {
  return WIN_SHIM_EXT.test(file);
}

/**
 * PATH/where 可能先撞到 npm/安装器的 .cmd：spawn 不能直接运行，取同目录原生 exe，否则跳过。
 * 官方安装器无扩展名变体本身可 spawn 时原样返回。
 */
export function resolveCodexShimToNative(
  file: string,
  opts: {
    platform: NodeJS.Platform;
    join: (...parts: string[]) => string;
    dirname: (p: string) => string;
    isExecutable: (file: string) => boolean;
  }
): string | null {
  if (!isWindowsShim(file)) {
    return opts.isExecutable(file) ? file : null;
  }
  const sibling = opts.join(opts.dirname(file), 'codex.exe');
  if (opts.isExecutable(sibling)) return sibling;
  const stripped = file.replace(WIN_SHIM_EXT, '.exe');
  if (stripped !== file && opts.isExecutable(stripped)) return stripped;
  return null;
}

export function parseWhereWhichOutput(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line) return false;
    return !/^info:/i.test(line);
  });
}

function defaultLookupOnPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  try {
    if (platform === 'win32') {
      const out = execFileSync('where.exe', [command], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 4000,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      return parseWhereWhichOutput(String(out));
    }
    const out = execFileSync('which', ['-a', command], {
      encoding: 'utf8',
      timeout: 4000,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return parseWhereWhichOutput(String(out));
  } catch {
    return [];
  }
}

const desktopVersion = /^[a-f0-9]{8,64}$/i;

function workbenchBin(execPath: string, paths: typeof path.posix): string | undefined {
  for (let dir = paths.dirname(execPath); dir !== paths.dirname(dir); dir = paths.dirname(dir)) {
    const parent = paths.dirname(dir);
    if (paths.basename(dir).toLowerCase() === 'electron' && paths.basename(parent).toLowerCase() === 'node_modules') {
      return paths.join(parent, '.bin');
    }
  }
}

function listWindowsDesktopVersions(root: string): Array<{ name: string; mtimeMs: number }> {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isDirectory() || !desktopVersion.test(entry.name)) return [];
      try {
        return [{ name: entry.name, mtimeMs: fs.statSync(path.join(root, entry.name)).mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function resolveUserCodexExecutable(options: CodexExecutableDiscoveryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const bundledBin = workbenchBin(options.execPath ?? process.execPath, paths);
  const pathKey = (dir: string) => platform === 'win32' ? paths.resolve(dir).toLowerCase() : paths.resolve(dir);
  const isWorkbenchBin = (dir: string) => bundledBin !== undefined && pathKey(dir) === pathKey(bundledBin);
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const isExecutable = options.isExecutable ?? ((file: string) => {
    try {
      if (!fs.statSync(file).isFile()) return false;
      fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch { return false; }
  });
  const acceptPathHit = (file: string | null): string | null => {
    if (!file || isWorkbenchBin(paths.dirname(file))) return null;
    return resolveCodexShimToNative(file, {
      platform,
      join: paths.join,
      dirname: paths.dirname,
      isExecutable
    });
  };
  const machine = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null;
  const target = machine && (platform === 'win32' ? `${machine}-pc-windows-msvc`
    : platform === 'darwin' ? `${machine}-apple-darwin` : platform === 'linux' ? `${machine}-unknown-linux-musl` : null);
  const npmCandidates = (prefix: string): string[] => {
    if (!target) return [];
    const modules = paths.join(prefix, 'node_modules');
    const cli = paths.join(modules, '@openai', 'codex');
    const native = `codex-${platform}-${arch}`;
    return [cli, paths.join(cli, 'node_modules', '@openai', native), paths.join(modules, '@openai', native)]
      .flatMap(root => ['bin', 'codex'].map(directory => paths.join(root, 'vendor', target, directory, executableName)));
  };
  // Follow PATH in order, including npm's .cmd launcher. A launcher is never
  // spawned directly; resolve its sibling or colocated native vendor instead.
  // Otherwise an older Desktop installation could silently override the CLI
  // the user actually selected on PATH.
  const envValue = (key: string): string | undefined => env[key] ?? (platform === 'win32'
    ? Object.entries(env).find(([name]) => name.toUpperCase() === key)?.[1] : undefined);
  const pathPrefixes = (envValue('PATH') ?? '').split(paths.delimiter)
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1')).filter(dir => !!dir && !isWorkbenchBin(dir));
  for (const prefix of pathPrefixes) {
    const onPath = findOnPath([platform === 'win32' ? 'codex' : executableName], { platform, pathEnv: prefix,
      ...(platform === 'win32' ? { pathExt: (envValue('PATHEXT') || '.exe;.cmd;.bat;.com').toLowerCase() } : {}),
      join: paths.join, exists: isExecutable });
    const fromPath = acceptPathHit(onPath);
    if (fromPath) return fromPath;
    if (platform === 'win32' && onPath && isWindowsShim(onPath)) {
      const vendor = npmCandidates(prefix).find(isExecutable);
      if (vendor) return vendor;
    }
  }
  const candidates = [paths.join(home, '.local', 'bin', executableName)];
  const localAppData = envValue('LOCALAPPDATA');
  if (platform === 'win32' && localAppData) {
    for (const root of [
      paths.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      paths.join(localAppData, 'OpenAI', 'Codex', 'bin')
    ]) {
      // Official installer: native .exe plus the extensionless variant the installer/docs mention.
      candidates.push(paths.join(root, executableName), paths.join(root, 'codex'));
    }
  }
  // npm's .cmd and extensionless files are launchers, not directly spawnable executables.
  // Resolve the user's installed native platform package beside those launchers.
  const appData = envValue('APPDATA');
  const prefixes = [...new Set([
    ...(appData ? [paths.join(appData, 'npm')] : []),
    ...pathPrefixes
  ])];
  for (const prefix of prefixes) candidates.push(...npmCandidates(prefix));
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }

  // Desktop launches do not necessarily inherit the user's interactive-shell PATH.
  if (platform === 'darwin') {
    for (const root of [paths.join(home, 'Applications'), '/Applications']) {
      for (const bundle of ['ChatGPT.app', 'Codex.app']) {
        const resources = paths.join(root, bundle, 'Contents', 'Resources');
        for (const executable of [
          paths.join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
          paths.join(resources, 'codex')
        ]) {
          if (isExecutable(executable)) return executable;
        }
      }
    }
  } else if (platform === 'win32' && localAppData) {
    const root = paths.join(localAppData, 'OpenAI', 'Codex', 'bin');
    const versions = (options.listDesktopVersions ?? (options.isExecutable ? () => [] : listWindowsDesktopVersions))(root)
      .filter(version => desktopVersion.test(version.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    for (const version of versions) {
      const executable = paths.join(root, version.name, executableName);
      if (isExecutable(executable)) return executable;
    }
  }
  if (platform === 'darwin' || platform === 'linux') {
    const bins = platform === 'darwin' && arch === 'arm64' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
      : ['/usr/local/bin', '/usr/bin'];
    const executable = bins.map(bin => paths.join(bin, executableName)).find(isExecutable);
    if (executable) return executable;
  }

  // Last resort: OS where/which. Packaged Electron PATH is often stripped, so this
  // cannot replace the official-dir candidates; it only catches custom installs.
  // Tests that inject isExecutable stay hermetic unless they also inject lookupOnPath.
  const hits = options.lookupOnPath
    ? options.lookupOnPath('codex')
    : options.isExecutable
      ? []
      : defaultLookupOnPath('codex', platform, env);
  for (const hit of hits) {
    const resolved = acceptPathHit(hit);
    if (resolved) return resolved;
  }
  return null;
}

async function appIsPackaged(): Promise<boolean> {
  try {
    const electron = (await import('electron')) as { app?: { isPackaged?: boolean } };
    return electron.app?.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * dev 与打包版都只认明确发现的用户原生 CLI，找不到返回 ok:false。
 */
export async function resolveCodexExecutable(options: CodexExecutableDiscoveryOptions & { packaged?: boolean } = {}): Promise<{
  ok: boolean;
  executable?: string;
  packaged: boolean;
}> {
  const packaged = options.packaged ?? await appIsPackaged();
  const exe = resolveUserCodexExecutable(options);
  if (exe) return { ok: true, executable: exe, packaged };
  return { ok: false, packaged };
}
