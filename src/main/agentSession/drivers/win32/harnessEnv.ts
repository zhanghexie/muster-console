/**
 * Windows 隐藏控制台预加载：拼进 ELECTRON_RUN_AS_NODE 子进程的 NODE_OPTIONS。
 * Windows 子进程环境辅助函数（原 dsh/harnessEnv，保留通用实现和单测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { toUnpackedAsarPath } from '../../../asarPaths';
export { toUnpackedAsarPath } from '../../../asarPaths';

export const HIDE_CONSOLE_PRELOAD = 'hide-console.cjs';
export const KOFFI_ENV = 'MUSTER_DSH_KOFFI';

/**
 * 与 worker 定位预加载文件同一套双路径：
 * 打包后 __dirname=.../out/main，文件在 agentSession/drivers/win32/ 下；
 * 旧布局（out/main 旁的 bridge/）保留兜底。
 */
export function resolveConsolePreloadFile(fileName: string, fromDir: string): string | undefined {
  const candidates = [
    path.join(fromDir, 'bridge', fileName),
    path.join(fromDir, 'agentSession', 'drivers', 'win32', fileName)
  ];
  return candidates.find((c) => fs.existsSync(c));
}

/** NODE_OPTIONS 里的 --require 参数：正斜杠 + 空白路径加引号。 */
export function nodeOptionsRequire(file: string): string {
  const normalized = toUnpackedAsarPath(path.resolve(file)).replaceAll('\\', '/');
  const quoted = /[\s"]/.test(normalized) ? `"${normalized.replaceAll('"', '\\"')}"` : normalized;
  return `--require ${quoted}`;
}

export function withWin32HiddenConsole(
  env: Record<string, string>,
  opts: {
    preloadPath: string;
    koffiPath?: string;
    platform?: NodeJS.Platform;
  }
): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') return { ...env };
  const requireOpt = nodeOptionsRequire(opts.preloadPath);
  const existing = env.NODE_OPTIONS?.trim();
  const next: Record<string, string> = {
    ...env,
    NODE_OPTIONS: existing ? `${existing} ${requireOpt}` : requireOpt
  };
  if (opts.koffiPath) next[KOFFI_ENV] = toUnpackedAsarPath(opts.koffiPath);
  return next;
}
