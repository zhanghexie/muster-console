import path from 'node:path';
import { writeJsonAtomic, writeJsonAtomicSync } from './atomicJson';

const MERGE_MS = 200;

type Pending = { data: unknown; timer: ReturnType<typeof setTimeout> };

/**
 * 同文件 200ms 内合并为一次异步原子写；before-quit 时 flushSync。
 *
 * 每个文件维护写序号：异步写落盘（rename）前若已被更新的写或 flushSync 超越，
 * 就丢弃在途的旧数据，避免退出瞬间旧内容盖掉新内容。
 */
export class PersistQueue {
  private pending = new Map<string, Pending>();
  private seq = new Map<string, number>();
  /** Serializes every asynchronous commit to the same target. */
  private tails = new Map<string, Promise<void>>();
  /** Invalidates strict commits on delete, synchronous replacement or newer strict work. */
  private strictEpoch = new Map<string, number>();

  constructor(private dir: string, private readonly options: { compact?: boolean; resolveFile?: (file: string) => string } = {}) {}

  private resolveFile(file: string): string {
    return this.options.resolveFile?.(file) ?? path.join(this.dir, file);
  }

  private bump(abs: string): number {
    const next = (this.seq.get(abs) ?? 0) + 1;
    this.seq.set(abs, next);
    return next;
  }

  private bumpStrict(abs: string): number {
    const next = (this.strictEpoch.get(abs) ?? 0) + 1;
    this.strictEpoch.set(abs, next);
    return next;
  }

  private enqueue(abs: string, action: () => void | Promise<void>): Promise<void> {
    const previous = this.tails.get(abs) ?? Promise.resolve();
    const result = previous.then(action);
    const tail = result.catch(() => {});
    this.tails.set(abs, tail);
    void tail.then(() => { if (this.tails.get(abs) === tail) this.tails.delete(abs); });
    return result;
  }

  private cancelPending(abs: string): void {
    const prev = this.pending.get(abs);
    if (prev) clearTimeout(prev.timer);
    this.pending.delete(abs);
  }

  write(file: string, data: unknown): void {
    const abs = this.resolveFile(file);
    const prev = this.pending.get(abs);
    if (prev) clearTimeout(prev.timer);
    const mySeq = this.bump(abs);
    const timer = setTimeout(() => {
      this.pending.delete(abs);
      void this.enqueue(abs, () => this.writeFile(abs, data, mySeq));
    }, MERGE_MS);
    timer.unref?.();
    this.pending.set(abs, { data, timer });
  }

  /**
   * 立即同步落盘（P9 注册表：prompt-tasks 等不能只靠 200ms 防抖）。
   * 取消该文件待写定时器，并作废在途异步写。
   */
  writeNow(file: string, data: unknown): void {
    const abs = this.resolveFile(file);
    this.cancelPending(abs);
    this.bumpStrict(abs);
    this.bump(abs);
    try {
      writeJsonAtomicSync(abs, data, this.options.compact ? 0 : 2);
    } catch (err) {
      console.error('[persist] writeNow failed', abs, err);
    }
  }

  /** 丢弃某文件待写与在途的内容（文件即将被删除时用，避免写回把它复活） */
  drop(file: string): void {
    const abs = this.resolveFile(file);
    this.cancelPending(abs);
    this.bumpStrict(abs);
    this.bump(abs);
  }

  /**
   * Wait for older async renames, write a fresh snapshot, and run a synchronous
   * commit hook without yielding in between. A drop invalidates this request;
   * by default a newer strict request does too. Ordinary writes queued while waiting are superseded
   * by the freshly captured snapshot; subsequent writes remain ordered after it.
   * This confirms process-crash ordering, not power-loss durability (no fsync).
   */
  writeStrict(file: string, snapshot: () => unknown, commit: () => void = () => {}, options?: { coexist?: boolean }): Promise<void> {
    return this.runStrict(file, () => {
      writeJsonAtomicSync(this.resolveFile(file), snapshot(), this.options.compact ? 0 : 2);
      commit();
    }, options);
  }

  /** Run a synchronous file operation after earlier async commits settle. */
  runStrict(file: string, action: () => void, options?: { coexist?: boolean }): Promise<void> {
    const abs = this.resolveFile(file);
    // Shared registries may have independent callers. They serialize on the
    // same tail without cancelling each other; drop/replacement still cancels.
    const epoch = options?.coexist ? (this.strictEpoch.get(abs) ?? 0) : this.bumpStrict(abs);
    this.cancelPending(abs);
    this.bump(abs);
    return this.enqueue(abs, () => {
      if ((this.strictEpoch.get(abs) ?? 0) !== epoch) throw new Error('持久化操作已被取消或替代');
      this.cancelPending(abs);
      this.bump(abs);
      action();
    });
  }

  flushSync(): void {
    for (const [abs, p] of this.pending) {
      clearTimeout(p.timer);
      // 让任何在途异步写作废，避免它的 rename 落在同步写之后
      this.bumpStrict(abs);
      this.bump(abs);
      try {
        writeJsonAtomicSync(abs, p.data, this.options.compact ? 0 : 2);
      } catch (err) {
        console.error('[persist] flush failed', abs, err);
      }
    }
    this.pending.clear();
  }

  /** Await write-behind commits without blocking the main process event loop. */
  async flush(): Promise<void> {
    while (this.pending.size > 0 || this.tails.size > 0) {
      for (const [abs, pending] of this.pending) {
        clearTimeout(pending.timer);
        this.pending.delete(abs);
        const mySeq = this.seq.get(abs) ?? 0;
        void this.enqueue(abs, () => this.writeFile(abs, pending.data, mySeq));
      }
      const tails = [...this.tails.values()];
      if (tails.length) await Promise.all(tails);
    }
  }

  private async writeFile(abs: string, data: unknown, mySeq: number): Promise<void> {
    if (this.seq.get(abs) !== mySeq) return;
    try {
      await writeJsonAtomic(abs, data, () => this.seq.get(abs) === mySeq, this.options.compact ? 0 : 2);
    } catch (err) {
      console.error('[persist] write failed', abs, err);
    }
  }
}
