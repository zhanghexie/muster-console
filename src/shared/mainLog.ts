/**
 * 主进程文件日志（黑匣子）的纯格式化层：零依赖、离线自测共用。
 * 落盘与 console 接管在 main/logs/mainLog.ts。
 *
 * 背景（2026-09-25 黑屏排查）：安装版没有终端，主进程 console.* 全部蒸发；
 * render-process-gone 只有 console.error 一条，渲染进程死了连死因（reason）
 * 都无处可查。此文件 + main/logs/mainLog.ts 让主进程日志有据可查。
 */

export const MAIN_LOG_NAME = 'main.log';
/** 单文件 1MB 滚到 .old（主进程日志量大于 renderer-errors 的 256KB 档） */
export const MAIN_LOG_MAX_BYTES = 1024 * 1024;

export type MainLogLevel = 'log' | 'info' | 'warn' | 'error';

export function formatMainLogLine(ts: number, level: MainLogLevel, message: string): string {
  const stamp = new Date(ts).toISOString();
  const text = message.replace(/\s+$/, '');
  return `${stamp} [${level}] ${text}`;
}
