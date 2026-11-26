import { userDataStorage } from '../../runtimeKernel/storageRootResolver';
/**
 * 后台终端任务：把命令本身作为 PTY 进程 spawn（复用 PtyManager 的 scrollback 与
 * 合流广播；渲染层对未知 sessionId 的 pty:data 直接丢弃，隐藏零视觉成本）。
 * 退出码即任务结果；dev server 等长驻进程保持 running 直到被 kill。
 * 面板侧用真 xterm 直连 bg 键，实时输出 + 可打字介入。
 * C1：大输出落盘 outputPath 指针（截断保尾不回灌）；支持 timeoutMs 超时转后台。
 */
import fs from 'node:fs';
import { BackgroundPtyCleanupError } from '../../pty/backgroundOwner';
import path from 'node:path';
import type { AppContext } from '../../context';
import { t } from '../../../shared/i18n';
import { stripAnsiForDisplay as ansiStrip } from '../../detect/stripAnsi';
import { terminalTextTail } from '../../../shared/terminalCapture';
import {
  BG_OUTPUT_FILE_THRESHOLD,
  resolveShellTimeoutAction,
  truncateBgTextTail
} from '../../../shared/backgroundTasks';
import { bgCommandLaunch, bgPtyId, pickBgShellProfile } from '../../shell/bgLaunch';
import { listShellProfilesAsync } from '../../shell/profiles';
import type { BgTaskLaunchGuard } from './source';

export { bgPtyId };

export interface BgShellStart {
  /** 任务结束回调（kill 时不触发，manager 自己落 cancelled）；outputPath=大输出落盘路径 */
  onExit(exitCode: number, summaryTail: string, outputPath?: string): void;
  onFail(message: string): void;
  onCleanupFail?(message: string, exitCode: number, summary: string, outputPath?: string): void;
  /** 超时回调（仅 timeoutMs 模式）：manager 按 resolveShellTimeoutAction 决定 fail / 转后台 */
  onTimeout?(): void;
}

export interface BgShellHandle {
  kill(): void;
  close?(): Promise<void>;
}

/** 大输出全文落盘；返回 outputPath（未超阈值或写失败返回 undefined） */
export function writeShellOutput(userDataDir: string, taskId: string, fullOutput: string): string | undefined {
  if (fullOutput.length < BG_OUTPUT_FILE_THRESHOLD) return undefined;
  try {
    const dir = userDataStorage(userDataDir).resolve('app', 'bg-outputs');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${taskId}.log`);
    fs.writeFileSync(filePath, fullOutput, 'utf8');
    return filePath;
  } catch {
    return undefined;
  }
}

export async function startBgShell(
  ctx: AppContext,
  taskId: string,
  cwd: string,
  command: string,
  cb: BgShellStart,
  timeoutMs?: number,
  userDataDir?: string,
  guard?: BgTaskLaunchGuard
): Promise<BgShellHandle> {
  const profiles = await listShellProfilesAsync();
  await guard?.prepare();
  // 后台命令选档：auto = 有 Git Bash 优先（AppConfig.shell.bgShellMode，缺省 auto）；
  // 只影响后台任务，不改 profiles[0] 的终端默认语义
  const mode = ctx.config.get().shell?.bgShellMode ?? 'auto';
  const profile = pickBgShellProfile(profiles, mode);
  if (!profile) {
    cb.onFail(t('本机没有可用的 Shell 配置档'));
    return { kill: () => {} };
  }
  const launch = bgCommandLaunch(profile, command);
  const ptyId = bgPtyId(taskId);
  let settled = false;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const owned = await ctx.pty.spawnOwnedBackground(ptyId, launch, cwd, () => guard?.assertCurrent());
  const close = (): Promise<void> => {
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    return owned.close();
  };
  void owned.completed.then(exitCode => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    const fullRaw = ansiStrip(ctx.pty.getBuffer(ptyId) ?? '');
    const summary = truncateBgTextTail(terminalTextTail(fullRaw, 2000));
    const outputPath = userDataDir ? writeShellOutput(userDataDir, taskId, fullRaw) : undefined;
    cb.onExit(exitCode, summary, outputPath);
  }, error => {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (error instanceof BackgroundPtyCleanupError && cb.onCleanupFail) {
      const fullRaw = ansiStrip(ctx.pty.getBuffer(ptyId) ?? '');
      const summary = truncateBgTextTail(terminalTextTail(fullRaw, 2000));
      cb.onCleanupFail(String(error.cause ?? error), error.commandExitCode, summary, userDataDir ? writeShellOutput(userDataDir, taskId, fullRaw) : undefined);
    } else cb.onFail(t('后台命令清理失败：{{message}}', { message: String(error) }));
  });
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      if (settled) return;
      if (resolveShellTimeoutAction(command) === 'fail') {
        void close().then(() => cb.onFail(t('sleep 命令超时（预期行为）')), error => cb.onFail(t('后台命令清理失败：{{message}}', { message: String(error) })));
      } else cb.onTimeout?.();
    }, timeoutMs);
    timeoutTimer.unref?.();
  }
  return { close, kill() { void close().catch(error => console.error('[bgTasks] shell cleanup failed', error)); } };
}
