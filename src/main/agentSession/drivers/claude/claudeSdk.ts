/**
 * Claude Agent SDK 动态加载（GUI Worker 用）：
 * - SDK 是 ESM-only，主 bundle 是 CJS：必须走 native dynamic import（同 piSdk 先例）；
 * - query/tool/createSdkMcpServer 的可注入缝（SdkQueryHandle 形状参考 wmux ClaudeSdkAdapter），
 *   离线回放测试注入假实现，不碰真 SDK/子进程；
 * - 先解析用户 CLI 的绝对路径。开发版可在本机 CLI 缺失时使用 SDK 平台包。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Options,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage
} from '@anthropic-ai/claude-agent-sdk';

export type ClaudeSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

/** driver 需要的 query() 句柄形状：真 Query 满足它；测试传假的 */
export interface ClaudeQueryHandle extends AsyncIterable<SDKMessage> {
  setPermissionMode?(mode: import('@anthropic-ai/claude-agent-sdk').PermissionMode): Promise<void>;
  /** 中止当前回合（streaming-input 模式下受支持） */
  interrupt?(): Promise<unknown>;
  /** 强杀子进程并回收资源 */
  close?(): void;
}

export type ClaudeQueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => ClaudeQueryHandle;

let cached: ClaudeSdkModule | null = null;

export async function loadClaudeSdk(): Promise<ClaudeSdkModule> {
  if (cached) return cached;
  cached = (await import('@anthropic-ai/claude-agent-sdk')) as ClaudeSdkModule;
  return cached;
}

interface ClaudeExecutableDiscoveryOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (file: string) => boolean;
}

/** Follow the user's PATH first, then check standard installations for desktop launches. */
export function resolveUserClaudeExecutable(options: ClaudeExecutableDiscoveryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const paths = isWindows ? path.win32 : path.posix;
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const envValue = (name: string) => env[name] ?? (isWindows
    ? Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] : undefined);
  const isExecutable = options.isExecutable ?? ((file: string): boolean => {
    try {
      if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
      fs.accessSync(file, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const executable = isWindows ? 'claude.exe' : 'claude';

  const npmEntry = (bin: string): string | undefined => {
    const modules = paths.basename(bin).toLowerCase() === '.bin'
      ? paths.dirname(bin) : paths.join(bin, 'node_modules');
    const root = paths.join(modules, '@anthropic-ai', 'claude-code');
    return [paths.join(root, 'bin', 'claude.exe'), paths.join(root, 'cli.js')].find(isExecutable);
  };

  for (const entry of (envValue('PATH') ?? '').split(paths.delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!paths.isAbsolute(dir)) continue;
    const candidate = paths.join(dir, executable);
    if (isExecutable(candidate)) return candidate;
    // The SDK spawns directly. Resolve known npm shims to the actual program.
    if (isWindows && ['claude.cmd', 'claude.bat'].some(shim => isExecutable(paths.join(dir, shim)))) {
      const entry = npmEntry(dir);
      if (entry) return entry;
    }
  }

  const localInstall = paths.join(home, '.local', 'bin', executable);
  if (isExecutable(localInstall)) return localInstall;
  if (isWindows) {
    const localAppData = envValue('LOCALAPPDATA');
    const wingetRoots = [localAppData && paths.join(localAppData, 'Microsoft'), envValue('PROGRAMFILES')];
    for (const base of wingetRoots) {
      if (!base || !paths.isAbsolute(base)) continue;
      const candidate = paths.join(base, 'WinGet', 'Links', executable);
      if (isExecutable(candidate)) return candidate;
    }
    const appData = envValue('APPDATA');
    return appData && paths.isAbsolute(appData) ? npmEntry(paths.join(appData, 'npm')) ?? null : null;
  }
  const bins = [paths.join(home, '.npm-global', 'bin'), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin'];
  return bins.map(dir => paths.join(dir, executable)).find(isExecutable) ?? null;
}

/** 打包态判定（electron 主进程内）；测试环境走 deps 注入不经过这里 */
async function appIsPackaged(): Promise<boolean> {
  try {
    const electron = (await import('electron')) as { app?: { isPackaged?: boolean } };
    return electron.app?.isPackaged === true;
  } catch {
    return false;
  }
}

/**
 * claude 可执行文件决策：dev 优先用户安装、回落 SDK 平台包（node_modules 内建）；
 * 打包版只认用户安装（平台包不随应用分发），找不到返回 undefined 并由调用方报引导错误。
 */
export async function resolveClaudeExecutable(options: ClaudeExecutableDiscoveryOptions & { packaged?: boolean } = {}): Promise<{
  /** 打包版找不到用户安装时为 false（dev 永远 true——回落 SDK 内建） */
  ok: boolean;
  /** 有值即传给 SDK pathToClaudeCodeExecutable；undefined = 用 SDK 默认解析 */
  executable?: string;
  packaged: boolean;
}> {
  const packaged = options.packaged ?? await appIsPackaged();
  const exe = resolveUserClaudeExecutable(options);
  if (exe) return { ok: true, executable: exe, packaged };
  if (packaged) return { ok: false, packaged };
  return { ok: true, packaged };
}

/** 便于测试与 streamMap 共用的窄类型再导出 */
export type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  SDKPartialAssistantMessage
};
