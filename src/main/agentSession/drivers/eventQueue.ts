/**
 * 简单异步事件队列：把回调式 SDK 事件桥成 AsyncIterable（driver 合同的 events）。
 * close 后缓冲仍可被消费完；再 push 无效（丢弃并告警，防泄漏）。
 */
const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buf: Array<{ value: T; bytes: number }> = [];
  private bufferedBytes = 0;
  private resolvers: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;
  private err: unknown = null;
  private readonly maxBufferedBytes: number;
  constructor(private readonly options: {
    maxBuffered?: number;
    maxBufferedBytes?: number;
    sizeOf?: (item: T) => number;
    onBuffered?: (size: number, bytes?: number) => void;
  } = {}) {
    const maxBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error('Agent event queue byte limit is invalid');
    }
    this.maxBufferedBytes = maxBytes;
  }

  get bufferedBytesCount(): number { return this.bufferedBytes; }

  push(item: T): void {
    if (this.closed) {
      console.warn('[agentSession] event queue closed; dropped push');
      return;
    }
    const pair = this.resolvers.shift();
    if (pair) pair.resolve({ value: item, done: false });
    else {
      if (this.buf.length >= (this.options.maxBuffered ?? Infinity)) throw new Error('Agent event queue backpressure limit exceeded');
      const bytes = Math.max(0, this.options.sizeOf?.(item) ?? this.defaultSizeOf(item));
      if (this.bufferedBytes + bytes > this.maxBufferedBytes) {
        throw new Error('Agent event queue byte backpressure limit exceeded');
      }
      this.buf.push({ value: item, bytes }); this.bufferedBytes += bytes; this.options.onBuffered?.(this.buf.length, this.bufferedBytes);
    }
  }

  /**
   * 以错误终止迭代（for-await 抛出）；已缓冲项不再投递。
   * 等待中的消费者必须收到 reject——resolve 成 done 会让 for-await 正常结束、
   * 错误被吞（worker 崩溃回合被当正常收口，2026-10-01 接入审查 P1-6）。
   */
  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.err = err;
    for (const pair of this.resolvers.splice(0)) pair.reject(err);
    this.buf = [];
    this.bufferedBytes = 0;
  }

  /** Fail only after already-buffered events are observed in their original order. */
  failAfterBuffered(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.err = err;
    // Normally a buffer and pending readers cannot coexist, but preserve that
    // ordering even if a consumer has issued multiple concurrent next() calls.
    while (this.buf.length && this.resolvers.length) {
      const entry = this.buf.shift()!;
      const value = entry.value;
      this.bufferedBytes = Math.max(0, this.bufferedBytes - entry.bytes);
      this.options.onBuffered?.(this.buf.length, this.bufferedBytes);
      this.resolvers.shift()!.resolve({ value, done: false });
    }
    if (!this.buf.length) {
      for (const pair of this.resolvers.splice(0)) pair.reject(err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pair of this.resolvers.splice(0)) pair.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const next = (): Promise<IteratorResult<T>> => {
      if (this.buf.length) {
        const entry = this.buf.shift()!;
        const value = entry.value;
        this.bufferedBytes = Math.max(0, this.bufferedBytes - entry.bytes);
        this.options.onBuffered?.(this.buf.length, this.bufferedBytes);
        return Promise.resolve({ value, done: false });
      }
      if (this.err) return Promise.reject(this.err);
      if (this.closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<T>>((resolve, reject) =>
        this.resolvers.push({ resolve, reject })
      );
    };
    return { next };
  }

  private defaultSizeOf(item: T): number {
    try { return Buffer.byteLength(JSON.stringify(item) ?? '', 'utf8'); }
    catch { return 0; }
  }
}
