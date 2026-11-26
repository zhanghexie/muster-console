/** Distinguish a host deadline from an upstream error with identical text. */
export class BoundedAcpRequestError extends Error {
  constructor(readonly label: string, readonly reason: 'timeout' | 'cancelled') {
    super(`${label} ${reason === 'timeout' ? '超时' : '已取消'}`);
  }
}

/** A deadline also cancels the caller's wait; ownership of cleanup stays with the caller. */
export function boundedAcpRequest<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) { reject(new BoundedAcpRequestError(label, 'cancelled')); return; }
    const timer = setTimeout(() => finish(new BoundedAcpRequestError(label, 'timeout')), timeoutMs);
    timer.unref?.();
    const onAbort = (): void => finish(new BoundedAcpRequestError(label, 'cancelled'));
    const finish = (error?: Error, value?: T): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value as T);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(value => finish(undefined, value), error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
