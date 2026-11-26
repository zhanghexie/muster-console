/**
 * 记忆文件读取错误分类（2026-10-02 审计 M3 修复）：
 *
 * 旧模式 `readTextSoft`（读异常一律返回 ''）在写前读取场景会把「读取失败」误当
 * 「空文件」，随后整文件重写覆盖旧内容（EIO/EACCES 一次即丢数据）。本模块把读取
 * 结果拆成三态，由调用方决定策略：
 *
 * - `missing`（ENOENT）：文件确认不存在——写入口允许当作初次空内容（可新建）；
 * - `ok`：真实读到内容（含真实空文件）；
 * - `error`（EIO/EACCES/EISDIR/…）：读取失败——**写入口必须中止**并返回可见失败，
 *   不得换路径、写空模板或清空文件。existsSync 不能替代（存在≠可读，检查与读取
 *   之间也会变化）。
 *
 * 策略边界：只读展示（注入/面板读取/速览）不必硬套写前策略——null/空回退仍是
 * 合法展示语义；本模块只提供统一分类原语（`readTextFile`）与写前读取便捷入口
 * （`readTextForWrite`，读取失败抛 `MemoryFileReadError`）。
 */
import fs from 'node:fs';

export type ReadTextOutcome =
  | { status: 'ok'; content: string }
  | { status: 'missing' }
  | { status: 'error'; code: string; message: string };

/** 读取失败异常（写前读取中止用；code 保留原始 errno） */
export class MemoryFileReadError extends Error {
  readonly code: string;
  readonly filePath: string;
  constructor(filePath: string, code: string, causeMessage: string) {
    super(`读取 ${filePath} 失败（${code}）：${causeMessage}——已中止写入，防止覆盖既有内容`);
    this.name = 'MemoryFileReadError';
    this.code = code;
    this.filePath = filePath;
  }
}

/** 三态读取原语：ENOENT=missing；其余异常=error（含目录占位/权限/IO） */
export function readTextFile(p: string): ReadTextOutcome {
  try {
    return { status: 'ok', content: fs.readFileSync(p, 'utf8') };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e?.code === 'ENOENT') return { status: 'missing' };
    return {
      status: 'error',
      code: e?.code ?? 'EUNKNOWN',
      message: String(e?.message ?? err)
    };
  }
}

/**
 * 写前读取：文件不存在按空内容放行（首次创建合法）；真实空文件原样返回；
 * 读取失败抛 `MemoryFileReadError`（调用方停止写入并传回可见失败）。
 */
export function readTextForWrite(p: string): string {
  const r = readTextFile(p);
  if (r.status === 'ok') return r.content;
  if (r.status === 'missing') return '';
  throw new MemoryFileReadError(p, r.code, r.message);
}
