import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedLaunch, ShellProfile, ShellProfileId } from '../../shared/types';
import { isShellProfileId } from '../../shared/types';
import { CMD_UTF8_ARGS, POWERSHELL_UTF8_BOOT } from '../encoding/winUtf8';
import { t } from '../../shared/i18n';

export interface ShellProbeDeps {
  exists: (filePath: string) => boolean;
  which: (command: string) => string | null;
  hasWslDistro: () => boolean;
  env: NodeJS.ProcessEnv;
  /** 平台判定（默认 process.platform）；测试注入 'darwin'/'linux' 走 POSIX 分支 */
  platform?: NodeJS.Platform;
  /**
   * 用户在设置页手工指定的 Git Bash 路径（settings 页 Shell 区块维护）。
   * 非空且存在时探测直接返回该值（优先于一切自动探测）；不存在时忽略并回落自动探测。
   * 缺省走进程内 manualGitBashPath（由 ConfigManager 在加载/更新配置时注入）。
   */
  manualGitBashPath?: string | null;
}

/** 配置档显示名（仅展示；匹配一律走 id） */
const PROFILE_LABELS: Record<ShellProfileId, string> = {
  powershell: 'Windows PowerShell',
  pwsh: 'PowerShell',
  cmd: t('命令提示符'),
  'git-bash': 'Git Bash',
  wsl: 'WSL',
  zsh: 'zsh',
  bash: 'bash'
};

function defaultExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** 在 PATH 中找可执行文件；Windows 下补 .exe */
function defaultWhich(command: string): string | null {
  const pathEnv = process.env.PATH ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  const names =
    process.platform === 'win32' && !path.extname(command)
      ? exts.map((e) => command + e.toLowerCase())
      : [command];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      if (defaultExists(full)) return full;
    }
  }
  return null;
}

function defaultHasWslDistro(): boolean {
  try {
    const out = execFileSync('wsl.exe', ['-l', '-q'], {
      encoding: 'buffer',
      timeout: 4000,
      windowsHide: true
    }) as Buffer;
    return wslDistroTextHasEntry(out);
  } catch {
    return false;
  }
}

/** wsl -l 默认 UTF-16LE 输出；有非空行即存在发行版 */
function wslDistroTextHasEntry(out: Buffer): boolean {
  const text = out.toString('utf16le').replace(/\0/g, '');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l.length > 0);
}

function defaultDeps(): ShellProbeDeps {
  return {
    exists: defaultExists,
    which: defaultWhich,
    hasWslDistro: defaultHasWslDistro,
    env: process.env,
    platform: process.platform,
    manualGitBashPath: manualGitBashOverride
  };
}

function depsPlatform(d: ShellProbeDeps): NodeJS.Platform {
  return d.platform ?? process.platform;
}

function firstExisting(candidates: string[], exists: (p: string) => boolean): string | null {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return null;
}

function resolvePowerShell(deps: ShellProbeDeps): ShellProfile | null {
  const root = deps.env.SystemRoot || deps.env.SYSTEMROOT || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!deps.exists(full)) return null;
  return {
    id: 'powershell',
    label: PROFILE_LABELS.powershell,
    command: full,
    args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_UTF8_BOOT]
  };
}

function resolvePwsh(deps: ShellProbeDeps): ShellProfile | null {
  const candidates = [
    deps.which('pwsh'),
    path.join(deps.env['ProgramFiles'] || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(deps.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe')
  ].filter((x): x is string => !!x);
  const full = firstExisting(candidates, deps.exists);
  if (!full) return null;
  return {
    id: 'pwsh',
    label: PROFILE_LABELS.pwsh,
    command: full,
    args: ['-NoLogo', '-NoExit', '-Command', POWERSHELL_UTF8_BOOT]
  };
}

function resolveCmd(deps: ShellProbeDeps): ShellProfile | null {
  const root = deps.env.SystemRoot || deps.env.SYSTEMROOT || 'C:\\Windows';
  const full = path.join(root, 'System32', 'cmd.exe');
  const resolved = deps.exists(full) ? full : deps.which('cmd');
  if (!resolved) return null;
  return {
    id: 'cmd',
    label: PROFILE_LABELS.cmd,
    command: resolved,
    args: [...CMD_UTF8_ARGS]
  };
}

/**
 * Git Bash 探测（供终端 profile 与 Pi shellPath 同步共用）。
 * 候选顺序：
 * 0. 用户手工指定（设置页 Shell 区块 → AppConfig.shell.manualGitBashPath；存在才生效）
 * 1. 标准安装位置（Program Files / LOCALAPPDATA Programs）
 * 2. PATH 上 git.exe 的兄弟 bash：`<root>\cmd\git.exe → <root>\bin\bash.exe`、
 *    `<root>\mingw64\bin\git.exe → <root>\usr\bin\bash.exe`（覆盖自定义安装盘如 D:\Git）
 * 3. PATH 上的 bash（排除 WindowsApps 里的 WSL 占位 stub，它不是真 bash）
 *
 * 默认探测（不传 deps）走进程级缓存；显式传 deps 供测试注入，不进缓存。
 */
export function detectGitBashPath(deps: Partial<ShellProbeDeps> = {}): string | null {
  if (!deps || Object.keys(deps).length === 0) {
    if (cachedGitBash !== undefined) return cachedGitBash;
    cachedGitBash = detectGitBashPathWith(defaultDeps());
    return cachedGitBash;
  }
  return detectGitBashPathWith({ ...defaultDeps(), ...deps });
}

function detectGitBashPathWith(d: ShellProbeDeps): string | null {
  if (depsPlatform(d) !== 'win32') return null;
  // 0. 用户手工指定优先；路径不存在（卸载/改名）则忽略回落自动探测
  const manual = typeof d.manualGitBashPath === 'string' ? d.manualGitBashPath.trim() : '';
  if (manual && d.exists(manual)) return manual;
  const pf = d.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = d.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = d.env.LOCALAPPDATA || '';
  const standard = [
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf, 'Git', 'usr', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'usr', 'bin', 'bash.exe'),
    local ? path.join(local, 'Programs', 'Git', 'bin', 'bash.exe') : ''
  ];
  const hit = firstExisting(standard, d.exists);
  if (hit) return hit;

  const git = d.which('git');
  if (git) {
    const gitDir = path.dirname(git);
    const root = path.dirname(gitDir);
    const fromGit = [
      // D:\Git\cmd\git.exe → D:\Git\bin\bash.exe
      path.join(root, 'bin', 'bash.exe'),
      // <root>\mingw64\bin\git.exe → <root>\usr\bin\bash.exe
      path.join(root, 'usr', 'bin', 'bash.exe'),
      // 便携版偶尔直接 <root>\git.exe
      path.join(gitDir, 'bin', 'bash.exe')
    ];
    const found = firstExisting(fromGit, d.exists);
    if (found) return found;
  }

  const bash = d.which('bash');
  // WindowsApps\bash.exe 是 WSL 启动器 stub（0 字节重解析点），pi/终端都不能当真 bash 用
  if (bash && !/\\WindowsApps\\/i.test(bash)) {
    if (d.exists(bash)) return bash;
  }
  return null;
}

function resolveGitBash(deps: ShellProbeDeps): ShellProfile | null {
  const full = detectGitBashPath(deps);
  if (!full) return null;
  // ConPTY 下先切 UTF-8 代码页，再 exec 回交互 login shell（避免 Ink/CLI 原始 UTF-8 被当 GBK）
  return {
    id: 'git-bash',
    label: PROFILE_LABELS['git-bash'],
    command: full,
    args: ['-lc', 'chcp.com 65001 >/dev/null 2>&1; exec "$BASH" --login -i']
  };
}

function resolveWsl(deps: ShellProbeDeps): ShellProfile | null {
  const root = deps.env.SystemRoot || deps.env.SYSTEMROOT || 'C:\\Windows';
  const full = path.join(root, 'System32', 'wsl.exe');
  const resolved = deps.exists(full) ? full : deps.which('wsl');
  if (!resolved) return null;
  if (!deps.hasWslDistro()) return null;
  return { id: 'wsl', label: PROFILE_LABELS.wsl, command: resolved, args: [] };
}

/** POSIX：zsh（macOS 默认）。$SHELL 指向 zsh 时优先，再探常见绝对路径，最后 PATH */
function resolveZsh(deps: ShellProbeDeps): ShellProfile | null {
  if (depsPlatform(deps) === 'win32') return null;
  const candidates = [
    deps.env.SHELL?.endsWith('/zsh') ? deps.env.SHELL : '',
    '/bin/zsh',
    '/usr/bin/zsh',
    '/usr/local/bin/zsh',
    '/opt/homebrew/bin/zsh',
    deps.which('zsh') ?? ''
  ];
  const full = firstExisting(candidates, deps.exists);
  if (!full) return null;
  // -l：login shell，与 Terminal.app 一致（读 /etc/zprofile、~/.zprofile 拿用户 PATH）
  return { id: 'zsh', label: PROFILE_LABELS.zsh, command: full, args: ['-l'] };
}

/** POSIX：bash（多数 Linux 发行版默认）。$SHELL 指向 bash 时优先 */
function resolveBash(deps: ShellProbeDeps): ShellProfile | null {
  if (depsPlatform(deps) === 'win32') return null;
  const candidates = [
    deps.env.SHELL?.endsWith('/bash') ? deps.env.SHELL : '',
    '/bin/bash',
    '/usr/bin/bash',
    '/usr/local/bin/bash',
    '/opt/homebrew/bin/bash',
    deps.which('bash') ?? ''
  ];
  const full = firstExisting(candidates, deps.exists);
  if (!full) return null;
  return { id: 'bash', label: PROFILE_LABELS.bash, command: full, args: ['-l'] };
}

type ProfileResolver = (deps: ShellProbeDeps) => ShellProfile | null;

/** 核心解析：给定 deps 现算（测试注入与冷缓存兜底共用，不碰缓存）。
 * POSIX 平台 zsh/bash 排最前（后台 shell 任务取 profiles[0]，默认应为系统 shell） */
function resolveProfilesWith(d: ShellProbeDeps): ShellProfile[] {
  const posix: ProfileResolver[] = [resolveZsh, resolveBash];
  const windows: ProfileResolver[] = [
    resolvePowerShell,
    resolvePwsh,
    resolveCmd,
    resolveGitBash,
    resolveWsl
  ];
  const ordered = depsPlatform(d) === 'win32' ? [...windows, ...posix] : [...posix, ...windows];
  const out: ShellProfile[] = [];
  for (const resolve of ordered) {
    const p = resolve(d);
    if (p) out.push(p);
  }
  return out;
}

/**
 * 按需探测本机可用 Shell；不存在的配置档静默跳过。
 * 默认探测（不传 deps）走进程级缓存：昂贵项（wsl.exe 最坏 4s、PATH×PATHEXT 全扫）
 * 一次进程内不重复；冷缓存时同步兜底现算一次并顺手触发后台预热。
 */
export function listShellProfiles(deps: Partial<ShellProbeDeps> = {}): ShellProfile[] {
  if (!deps || Object.keys(deps).length === 0) {
    if (cachedProfiles) return cachedProfiles.map(cloneProfile);
    void warmProfiles();
    cachedProfiles = resolveProfilesWith(defaultDeps());
    return cachedProfiles.map(cloneProfile);
  }
  return resolveProfilesWith({ ...defaultDeps(), ...deps });
}

/** 异步版：能 await 的调用方优先用它（冷启动不阻塞主线程） */
export async function listShellProfilesAsync(): Promise<ShellProfile[]> {
  if (cachedProfiles) return cachedProfiles.map(cloneProfile);
  const warmed = await warmProfiles();
  if (warmed.length > 0) return warmed.map(cloneProfile);
  // 预热失败（极罕见）：退回同步现算
  return listShellProfiles();
}

function cloneProfile(p: ShellProfile): ShellProfile {
  return { ...p, args: [...p.args] };
}

export function resolveShellLaunch(
  id: string,
  deps: Partial<ShellProbeDeps> = {}
): ResolvedLaunch {
  if (!isShellProfileId(id)) throw new Error(t('未知 Shell 配置档: {{id}}', { id }));
  const profile = listShellProfiles(deps).find((p) => p.id === id);
  if (!profile) throw new Error(t('本机未找到 Shell: {{name}}', { name: PROFILE_LABELS[id] }));
  return { command: profile.command, args: [...profile.args] };
}

/** 异步版 resolveShellLaunch：sessions 拉起 shell 会话用，避免冷缓存时同步探测 */
export async function resolveShellLaunchAsync(id: string): Promise<ResolvedLaunch> {
  if (!isShellProfileId(id)) throw new Error(t('未知 Shell 配置档: {{id}}', { id }));
  const profile = (await listShellProfilesAsync()).find((p) => p.id === id);
  if (!profile) throw new Error(t('本机未找到 Shell: {{name}}', { name: PROFILE_LABELS[id] }));
  return { command: profile.command, args: [...profile.args] };
}

// ---------- 进程级缓存与异步预热 ----------

/** 默认探测结果缓存（undefined = 尚未探测；null = 探过且无 Git Bash） */
let cachedGitBash: string | null | undefined;
let cachedProfiles: ShellProfile[] | null = null;
let warmPromise: Promise<ShellProfile[]> | null = null;

/**
 * 用户手工指定的 Git Bash 路径（null = 未指定/已清空）。
 * 写入方：ConfigManager 在加载/更新 AppConfig.shell.manualGitBashPath 时调用。
 */
let manualGitBashOverride: string | null = null;

/**
 * 设置/清除手工 Git Bash 路径；变化时作废探测缓存（含后台预热），下次探测重算。
 * 空串/undefined = 清除（回落自动探测）。
 */
export function setManualGitBashPath(raw: string | null | undefined): void {
  const next = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  if (next === manualGitBashOverride) return;
  manualGitBashOverride = next;
  cachedGitBash = undefined;
  cachedProfiles = null;
  warmPromise = null;
}

/** 当前手工指定值（未指定为 null；供设置页/诊断展示） */
export function getManualGitBashPath(): string | null {
  return manualGitBashOverride;
}

async function existsAsync(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** defaultWhich 的异步版：fs.promises 扫 PATH×PATHEXT，不堵主线程 */
async function whichAsync(command: string): Promise<string | null> {
  const pathEnv = process.env.PATH ?? '';
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  const names =
    process.platform === 'win32' && !path.extname(command)
      ? exts.map((e) => command + e.toLowerCase())
      : [command];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      if (await existsAsync(path.join(dir, name))) return path.join(dir, name);
    }
  }
  return null;
}

/** 异步探测 wsl 发行版；失败/超时按「无 WSL」处理，不抛错 */
function hasWslDistroAsync(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(
        'wsl.exe',
        ['-l', '-q'],
        { encoding: 'buffer', timeout: 4000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            resolve(false);
            return;
          }
          const buf = typeof stdout === 'string' ? Buffer.from(stdout, 'utf16le') : stdout;
          resolve(wslDistroTextHasEntry(buf));
        }
      );
    } catch {
      resolve(false);
    }
  });
}

/**
 * 异步探好昂贵事实（wsl / PATH×PATHEXT 扫描），再交给现有同步解析器：
 * 解析器剩余的少量定点 existsSync 可忽略，逻辑零复制。
 */
async function probeFactsDeps(): Promise<ShellProbeDeps> {
  const commands = ['pwsh', 'cmd', 'wsl', 'git', 'bash'];
  const found = await Promise.all(commands.map((c) => whichAsync(c)));
  const whichMap = new Map<string, string | null>(commands.map((c, i) => [c, found[i] ?? null]));
  const wslPath = whichMap.get('wsl') ?? null;
  const wslOk = !!wslPath && (await hasWslDistroAsync());
  const existsMemo = new Map<string, boolean>();
  return {
    exists: (p: string) => {
      let v = existsMemo.get(p);
      if (v === undefined) {
        v = defaultExists(p);
        existsMemo.set(p, v);
      }
      return v;
    },
    which: (c) => whichMap.get(c) ?? defaultWhich(c),
    hasWslDistro: () => wslOk,
    env: process.env,
    platform: process.platform,
    manualGitBashPath: manualGitBashOverride
  };
}

async function warmupProfilesOnce(): Promise<ShellProfile[]> {
  try {
    const deps = await probeFactsDeps();
    cachedProfiles = resolveProfilesWith(deps);
    cachedGitBash = detectGitBashPathWith(deps);
    return cachedProfiles;
  } catch {
    // 预热失败不落缓存：后续同步调用按旧路径现算兜底
    return [];
  }
}

function warmProfiles(): Promise<ShellProfile[]> {
  warmPromise ??= warmupProfilesOnce();
  return warmPromise;
}

// 模块加载即后台预热一次：进程内后续 shell 探测全部命中缓存，
// 主线程不再被 wsl.exe / PATH 扫描阻塞（同步 API 保留给无法 await 的调用方）
void warmProfiles();

export function shellProfileLabel(id: ShellProfileId): string {
  return PROFILE_LABELS[id];
}
