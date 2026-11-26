import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import {
  formatMainLogLine,
  MAIN_LOG_MAX_BYTES,
  MAIN_LOG_NAME,
  type MainLogLevel
} from '../../shared/mainLog';
import { rotateIfNeeded } from '../../shared/rendererErrorLog';

export function mainLogPath(userDataDir: string): string {
  return path.join(userDataStorage(userDataDir).resolve('app', 'logs'), MAIN_LOG_NAME);
}

/**
 * 追加一行主进程日志。同步写：主进程日志低频（每秒至多几十行），
 * appendFileSync 的微秒级开销换取崩溃前最后一刻的日志不丢。
 * 自身失败必须静默——日志故障不能反过来影响业务。
 */
export function appendMainLog(
  userDataDir: string,
  level: MainLogLevel,
  message: string,
  maxBytes = MAIN_LOG_MAX_BYTES
): void {
  try {
    const file = mainLogPath(userDataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(
      () => fs.statSync(file).size,
      () => {
        const old = `${file}.old`;
        try {
          fs.unlinkSync(old);
        } catch {
          /* 无旧文件 */
        }
        fs.renameSync(file, old);
      },
      maxBytes
    );
    fs.appendFileSync(file, `${formatMainLogLine(Date.now(), level, message)}\n`, 'utf8');
  } catch {
    /* 日志失败静默：不能因为写日志把业务打断 */
  }
}

/** console 参数 → 单行文本（util.format 同 console.log 语义：占位符展开 + inspect） */
export function formatConsoleArgs(args: readonly unknown[]): string {
  return util
    .format(...args)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

/**
 * 接管主进程 console.*：先写文件再走原实现（stdout 在 dev 终端仍可见）。
 * 必须在 setupDevSandbox() 之后调用——userData 已重定向，沙盒日志落沙盒。
 * 之后全主进程的 console.log/warn/error（含 [fatal] uncaughtException 兜底、
 * [renderer gone] 死因）都自动有据可查。
 */
export function installMainConsoleCapture(userDataDir: string): void {
  const originals: Record<MainLogLevel, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };
  for (const level of Object.keys(originals) as MainLogLevel[]) {
    console[level] = (...args: unknown[]) => {
      appendMainLog(userDataDir, level, formatConsoleArgs(args));
      originals[level](...args);
    };
  }
}
