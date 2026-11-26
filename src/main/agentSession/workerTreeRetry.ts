/** Host-only read retry policy. No model notification or Git mutation belongs here. */
export interface WorkerTreeRetryOptions {
  /** Total attempts, bounded to 1..4; default: initial read plus three retries. */
  attempts?: number;
  /** Delay bounded to 150..300 ms; default 200 ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
export function isTransientWorkerTreeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /repository has an active Git operation: (?:index\.lock|HEAD\.lock|locked)$/.test(message.trim()) ||
    /worktree (?:repository operation|task [a-z -]+) already running$/.test(message.trim()) ||
    /Unable to create [^\r\n]+(?:index|HEAD)\.lock['"]?: File exists/i.test(message);
}
export async function retryWorkerTreeRead<T>(read: () => Promise<T>, options: WorkerTreeRetryOptions = {}): Promise<T> {
  const attempts = Number.isFinite(options.attempts) ? Math.min(4, Math.max(1, Math.floor(options.attempts!))) : 4;
  const delay = Number.isFinite(options.delayMs) ? Math.min(300, Math.max(150, options.delayMs!)) : 200;
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      const value = await read();
      if (attempt > 1) console.info('[workerTreeGuard] transient check recovered', { attempt });
      return value;
    } catch (error) {
      if (!isTransientWorkerTreeError(error) || attempt >= attempts) throw error;
      console.info('[workerTreeGuard] retrying transient check', { attempt });
      await sleep(delay);
    }
  }
}
