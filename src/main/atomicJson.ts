import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * JSON 原子落盘：写同目录临时文件后 rename 覆盖目标。
 *
 * 直接 writeFile 目标文件时，进程在写一半被杀（用户强退、崩溃、断电）会留下
 * 截断的 JSON，下次启动解析失败即静默回退到空数据——会话表 / 配置 / 聊天历史
 * 都会丢。rename 在同一卷上是原子的，因此目标文件要么是旧内容要么是新内容。
 */

let tmpSeq = 0;

function tmpPathFor(abs: string): string {
  tmpSeq = (tmpSeq + 1) % 0xffff;
  return `${abs}.${process.pid}-${tmpSeq}.tmp`;
}

/** Windows 杀软/索引器瞬时锁：EPERM/EACCES/EBUSY 小间隔重试（panelStore 等共享此语义） */
const RENAME_RETRY_ERRNO = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_MAX = 5;
const RENAME_RETRY_DELAY_MS = 15;

/** 同步路径的短睡眠：Atomics.wait 真阻塞，不占 CPU 自旋 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tmp: string, abs: string): void {
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(tmp, abs);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (i >= RENAME_RETRY_MAX || !code || !RENAME_RETRY_ERRNO.has(code)) throw err;
      sleepSync(RENAME_RETRY_DELAY_MS);
    }
  }
}

export function writeTextAtomicSync(abs: string, text: string, options?: { mode?: number }): void {
  writeBytesAtomicSync(abs, text, options);
}

/** Same publication and Windows retry semantics for derived binary indexes. */
export function writeBytesAtomicSync(abs: string, data: string | Uint8Array, options?: { mode?: number }): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = tmpPathFor(abs);
  try {
    fs.writeFileSync(tmp, data, options?.mode === undefined ? 'utf8' : { encoding: 'utf8', mode: options.mode });
    renameWithRetry(tmp, abs);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能压根没建出来 */
    }
    throw err;
  }
}

export function writeJsonAtomicSync(abs: string, data: unknown, space = 2): void {
  writeTextAtomicSync(abs, `${JSON.stringify(data, null, space)}\n`);
}

/**
 * @param shouldCommit 紧接 rename 前求值；返回 false 则丢弃本次写。
 *   用于「异步写在途时又来了更新的写」——旧数据不能覆盖新数据。
 */
export async function writeJsonAtomic(
  abs: string,
  data: unknown,
  shouldCommit?: () => boolean,
  space = 2
): Promise<void> {
  const json = JSON.stringify(data, null, space);
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  const tmp = tmpPathFor(abs);
  try {
    await fs.promises.writeFile(tmp, json, 'utf-8');
    for (let i = 0; ; i += 1) {
      if (shouldCommit && !shouldCommit()) {
        await fs.promises.unlink(tmp);
        return;
      }
      try {
        await fs.promises.rename(tmp, abs);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (i >= RENAME_RETRY_MAX || !code || !RENAME_RETRY_ERRNO.has(code)) throw err;
        await sleep(RENAME_RETRY_DELAY_MS);
      }
    }
  } catch (err) {
    try {
      await fs.promises.unlink(tmp);
    } catch {
      /* 临时文件可能压根没建出来 */
    }
    throw err;
  }
}
