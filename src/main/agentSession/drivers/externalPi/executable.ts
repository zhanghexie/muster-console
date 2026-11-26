import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { lookOnPath } from '../acp/agents';
import { winCmdLaunchArgs } from '../../../encoding/winUtf8';

export type ExternalPiId = 'pi-external' | 'omp';

function bunBinDirectories(): string[] {
  const configured = process.env.BUN_INSTALL?.trim();
  return [
    ...(configured && path.isAbsolute(configured) ? [path.join(configured, 'bin')] : []),
    path.join(os.homedir(), '.bun', 'bin')
  ];
}

const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
};

function usesBunShebang(executable: string): boolean {
  if (process.platform === 'win32') return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(executable, 'r');
    const prefix = Buffer.alloc(256);
    const length = fs.readSync(fd, prefix, 0, prefix.length, 0);
    return /^#!\s*\/usr\/bin\/env\s+(?:-S\s+)?bun(?:\s|$)/.test(prefix.subarray(0, length).toString('utf8'));
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Extend only the child PATH when it uses the user's Bun global installation. */
export function externalPiLaunchEnvironment(executable: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const executableDir = path.dirname(executable);
  const directories = bunBinDirectories();
  const scriptNeedsBun = usesBunShebang(executable);
  const bunDir = directories.find(dir => samePath(dir, executableDir)) ?? (scriptNeedsBun ? [executableDir, ...directories].find(dir => {
    try { const file = path.join(dir, 'bun'); if (!fs.statSync(file).isFile()) return false; fs.accessSync(file, fs.constants.X_OK); return true; }
    catch { return false; }
  }) : undefined);
  if (!bunDir) return env;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const entries = (env[pathKey] ?? '').split(path.delimiter).filter(Boolean);
  if (!entries.some(entry => samePath(entry.trim().replace(/^"(.*)"$/, '$1'), bunDir))) entries.push(bunDir);
  env[pathKey] = entries.join(path.delimiter);
  return env;
}

/** A visible shebang allows preflight to reject a missing interpreter. */
export function validateExternalPiEnvironment(executable: string): void {
  if (!usesBunShebang(executable)) return;
  const env = externalPiLaunchEnvironment(executable);
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  const found = (env[pathKey] ?? '').split(path.delimiter).filter(Boolean).some(dir => {
    try { const file = path.join(dir.trim().replace(/^"(.*)"$/, '$1'), 'bun');
      if (!fs.statSync(file).isFile()) return false; fs.accessSync(file, fs.constants.X_OK); return true; }
    catch { return false; }
  });
  if (!found) throw new Error('外部引擎启动脚本需要 Bun，但当前工作台找不到 bun；请安装 Bun 或修正 PATH 后重启工作台');
}

/** The user's installation is independent from the bundled muster engine. */
export function resolveExternalPiExecutable(id: ExternalPiId, preferred?: string): string | null {
  const override = preferred?.trim();
  if (override) {
    if (!path.isAbsolute(override) || /[\u0000-\u001f]/.test(override)) return null;
    try {
      if (!fs.statSync(override).isFile()) return null;
      if (process.platform !== 'win32') fs.accessSync(override, fs.constants.X_OK);
      return override;
    } catch { return null; }
  }
  const name = id === 'omp' ? 'omp' : 'pi';
  const hit = lookOnPath([name]);
  if (hit) return hit;
  const home = os.homedir();
  const roots: string[] = process.platform === 'win32'
    ? [process.env.APPDATA && path.join(process.env.APPDATA, 'npm'), path.join(home, '.local', 'bin')].filter((p): p is string => !!p)
    : [path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), '/usr/local/bin'];
  if (id === 'omp') {
    const custom = process.env.PI_INSTALL_DIR?.trim();
    if (custom && path.isAbsolute(custom)) roots.push(custom);
    if (process.platform === 'win32' && process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'omp'));
    if (process.platform === 'darwin') roots.push('/opt/homebrew/bin');
    if (process.platform === 'linux') roots.push('/home/linuxbrew/.linuxbrew/bin', path.join(home, '.linuxbrew', 'bin'));
    roots.push(...bunBinDirectories());
  }
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  return lookOnPath(roots.flatMap(root => extensions.map(ext => path.join(root, name + ext))));
}

export function externalPiLaunchArgs(executable: string, args: string[]): { command: string; args: string[] } {
  validateExternalPiEnvironment(executable);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    // cmd expands percent expressions even inside quotes. Refuse ambiguous paths.
    if ([executable, ...args].some(value => value.includes('%'))) throw new Error('外部 Pi 启动路径包含 %，请使用不含 % 的可执行文件和临时目录');
    return { command: 'cmd.exe', args: winCmdLaunchArgs([executable, ...args]) };
  }
  return { command: executable, args };
}
