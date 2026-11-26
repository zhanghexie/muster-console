import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * 合并登录 PATH：登录 shell 独有的目录（homebrew/nvm/…）前置补进当前 PATH。
 * 去重保序：已存在的目录不重复、当前 PATH 相对顺序不变。
 */
export function mergePathEntries(current: string, login: string): string {
  const cur = current.split(path.delimiter).filter(Boolean);
  const seen = new Set(cur);
  const add = login.split(path.delimiter).filter(Boolean).filter((d) => !seen.has(d));
  return [...add, ...cur].join(path.delimiter);
}

/** 从登录 shell 输出里取 PATH 值：交互 shell 可能往 stdout 打 motd/precmd 噪音，取含分隔符的最后一行 */
export function extractPathFromOutput(out: string): string | null {
  const lines = String(out ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // fish 等 shell 的列表是空格分隔：拼回冒号分隔
    const normalized = line.includes(path.delimiter) ? line : line.split(/\s+/).join(path.delimiter);
    if (normalized.split(path.delimiter).length >= 2) return normalized;
  }
  return null;
}

/**
 * macOS/Linux：GUI（Finder/Dock/desktop 启动器）启动的 Electron 不继承用户登录 shell 的
 * PATH——nvm、homebrew(/opt/homebrew/bin)、~/.local/bin 等全部不可见，靠 PATH 裸名探测的
 * CLI（claude/opencode/npx/lark-cli…）会整体 ENOENT。仅合并登录 shell 返回的 PATH。
 * Windows 使用继承路径。探测失败时保留原 PATH，调用方决定是否提示。
 */
async function mergeLoginShellEnv(): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const shell = process.env.SHELL || '/bin/zsh';
  const out = await new Promise<string | null>((resolve) => {
    try {
      execFile(
        shell,
        ['-ilc', 'printf %s "$PATH"'],
        { timeout: 5000 },
        (err, stdout) => resolve(err ? null : String(stdout))
      );
    } catch {
      resolve(null);
    }
  });
  const loginPath = out ? extractPathFromOutput(out) : null;
  if (!loginPath) return false;
  process.env.PATH = mergePathEntries(process.env.PATH ?? '', loginPath);
  return true;
}

let demoHostPath: Promise<boolean> | undefined;

/** Spawn the login shell while it still inherits the desktop user's environment. */
export function captureDemoLoginShellPath(): void {
  if (process.platform !== 'win32') demoHostPath ??= mergeLoginShellEnv();
}

/** Interactive demos need the captured PATH before accepting their first command. */
export async function prepareWorkbenchLoginShellPath(): Promise<void> {
  if (demoHostPath) {
    if (!await demoHostPath) console.warn('[demo] 未能读取登录 Shell 的 PATH，将使用启动时继承的工具路径。可从能找到目标命令的终端启动 Demo。');
    return;
  }
  void mergeLoginShellEnv();
}
