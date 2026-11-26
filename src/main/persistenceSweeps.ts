/**
 * 持久化清扫小工具（可靠性专项 P3：X2-F07 交接临时文件 / X3-F05 无界增长族）。
 * 只依赖 node 内置模块（无 electron），供 test 直接编译回归。
 * 硬约束：清扫必须廉价——只 readdir/stat 顶层，不做深度递归大扫描；单条失败跳过。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CAPTURE_KEEP, captureFilesToDelete } from '../shared/terminalCapture';

export interface SweepStaleOptions {
  maxAgeMs: number;
  now?: number;
  /** 只清名字命中的条目（缺省=目录内全部；目录本身应仅属本功能） */
  match?: RegExp;
}

/**
 * 顶层条目（文件或目录）mtime 超过 maxAgeMs 即删（evidence 7 天滚动 / inject 2h 同范式）。
 * 返回删除条数；目录不存在/不可读返回 0。
 */
export function sweepStaleEntries(dir: string, opts: SweepStaleOptions): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const now = opts.now ?? Date.now();
  let removed = 0;
  for (const name of names) {
    if (opts.match && !opts.match.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (now - fs.statSync(full).mtimeMs <= opts.maxAgeMs) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* 单条失败跳过 */
    }
  }
  return removed;
}

/** 交接临时文档目录（canvasLink 专用；文件名 randomUUID.md） */
export const HANDOVER_DIR_NAME = 'muster-handover';

export function handoverDir(): string {
  return path.join(os.tmpdir(), HANDOVER_DIR_NAME);
}

/** 启动清扫交接临时文档（X2-F07）：宿主崩溃残留只等得到这里，>2h 清（inject 同口径） */
export function sweepHandoverFiles(maxAgeMs = 2 * 60 * 60 * 1000, now = Date.now()): number {
  return sweepStaleEntries(handoverDir(), { maxAgeMs, now });
}

/** Pi 调度会话旧 jsonl 7 天滚动（X3-F05；活跃会话文件每次续聊都触碰 mtime，不会被误删） */
export function sweepPiSessionBucket(dir: string, now = Date.now()): number {
  return sweepStaleEntries(dir, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, now, match: /\.jsonl$/ });
}

/**
 * browser-captures 截图/录屏保留最新 keep 个/种类（X3-F05；terminal.ts pruneCaptureDir
 * 同范式：写路径调用，keep 照 terminal-captures 的 CAPTURE_KEEP=20）。
 */
export function pruneBrowserCaptures(dir: string, keep = CAPTURE_KEEP): number {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const entries = names.map((name) => {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return { name, mtimeMs };
  });
  const toDelete = new Set(captureFilesToDelete(entries, keep));
  for (const ext of ['.webm']) {
    const list = entries
      .filter((f) => f.name.toLowerCase().endsWith(ext))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    for (const f of list.slice(Math.max(0, keep))) toDelete.add(f.name);
  }
  let removed = 0;
  for (const name of toDelete) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    } catch {
      /* 单条失败跳过 */
    }
  }
  return removed;
}
