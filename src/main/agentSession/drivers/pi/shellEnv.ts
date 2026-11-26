/**
 * GUI Pi 会话的 shell 环境解析（纯逻辑，测试可注入 deps）。
 *
 * 背景（bug 三件套 A/B）：
 * - driver.connect() 用 SettingsManager.inMemory(input.piSettings) 构造设置，不读
 *   隔离目录 settings.json——syncPiShellPath 写入的 shellPath 对 GUI 会话完全无效；
 * - pi 的裸探测只认 Program Files 两处标准位置 + `where bash.exe`：自定义安装盘
 *   （如 D:\Git）探不到，PATH 上第一个 bash 还可能是 WindowsApps 的 WSL 占位 stub。
 *   结果：bash 工具每次调用抛 "No bash shell found"。
 *
 * 这里把「显式传入 > 隔离目录 settings.json（手工值/同步值）> 宿主 detectGitBashPath」
 * 合并进 inMemory settings；本机确实无 bash 时不再裸抛——调用方（driver）用 pi 自带的
 * powershell 原生工具替换 bash，并把 promptNote 追加进系统提示。
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectGitBashPath } from '../../../shell/profiles';

/** bash 不可用时追加进系统提示的引导段（模型面） */
export const NO_BASH_PROMPT_NOTE = [
  '本机没有可用的 bash（未检测到 Git Bash）：不要尝试 bash 语法，也不要预期 bash 工具可用；',
  '需要执行 shell 命令时一律使用 powershell 工具（PowerShell 语法）。',
  'No usable bash on this machine: do not use bash syntax; run all shell commands via the powershell tool (PowerShell syntax).'
].join('\n');

export interface PiShellEnv {
  /** 合并后的 pi settings（未显式给 shellPath 且有解析结果时补上） */
  settings: Record<string, unknown>;
  /** 本会话是否有可用 bash（非 win32 恒 true；win32 看解析链是否命中） */
  bashAvailable: boolean;
  /** bash 不可用时的系统提示追加段；可用时缺省 */
  promptNote?: string;
}

export interface PiShellEnvInput {
  /** 模式/调用方显式透传的 pi settings（其 shellPath 是最高优先级，尊重用户手工值） */
  piSettings?: Record<string, unknown>;
  /** GUI 会话隔离 agent 目录（syncPiShellPath 的写入目标） */
  agentDir: string;
  /** 平台判定（默认 process.platform；测试注入） */
  platform?: NodeJS.Platform;
  /** 宿主 Git Bash 探测（默认真实现；测试注入） */
  detect?: () => string | null;
  /** settings.json 读取（默认 fs.readFileSync；测试注入） */
  readFile?: (filePath: string) => string;
  /** 存在性校验（默认 fs.existsSync；测试注入）——文件档死值回落探测的关键 */
  exists?: (filePath: string) => boolean;
}

/** 读隔离目录 settings.json 里的 shellPath（手工值/同步值；不存在或非法返回 null） */
function readShellPathFromFile(
  agentDir: string,
  readFile: (filePath: string) => string
): string | null {
  try {
    const raw = readFile(path.join(agentDir, 'settings.json'));
    const parsed = JSON.parse(raw) as { shellPath?: unknown };
    const v = typeof parsed.shellPath === 'string' ? parsed.shellPath.trim() : '';
    return v || null;
  } catch {
    return null;
  }
}

/**
 * 解析 GUI Pi 会话的 shell 环境。
 * 优先级：piSettings.shellPath（显式）> 隔离目录 settings.json 的 shellPath
 * （存在性校验通过才采信，syncPiShellPath 已尊重其中手工值）> detectGitBashPath()。
 * 全部落空（win32）→ bashAvailable=false + promptNote。
 */
export function resolvePiShellEnv(input: PiShellEnvInput): PiShellEnv {
  const platform = input.platform ?? process.platform;
  const settings: Record<string, unknown> = { ...(input.piSettings ?? {}) };
  // 非 Windows：pi 自身能找到 /bin/bash 等系统 shell，不做任何干预
  if (platform !== 'win32') return { settings, bashAvailable: true };

  const explicit = typeof settings.shellPath === 'string' ? settings.shellPath.trim() : '';
  if (explicit) return { settings, bashAvailable: true };

  const readFile = input.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
  const exists = input.exists ?? ((p: string) => fs.existsSync(p));
  // 文件档值必须存在才采信：Git 挪盘/卸载后死值不得压过最新探测（解冻结，评审返工②）
  const fromFile = readShellPathFromFile(input.agentDir, readFile);
  if (fromFile && exists(fromFile)) {
    settings.shellPath = fromFile;
    return { settings, bashAvailable: true };
  }

  const detect = input.detect ?? detectGitBashPath;
  const detected = detect();
  if (detected) {
    settings.shellPath = detected;
    return { settings, bashAvailable: true };
  }

  return { settings, bashAvailable: false, promptNote: NO_BASH_PROMPT_NOTE };
}
