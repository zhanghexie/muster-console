import { createAnsiTextStream } from '../detect/stripAnsi';

export type TerminalOutputEvent =
  | { type: 'data'; data: string }
  | { type: 'exited' | 'stopped' | 'replaced'; exitCode?: number };

export interface TerminalOutputSource {
  observeOutput(sessionId: string, listener: (event: TerminalOutputEvent) => void, after?: string): {
    running: boolean; backlog: string; prefix?: string; exitCode?: number; dispose(): void;
  };
}

export interface TerminalWaitCondition { text?: string; quietMs?: number; timeoutMs?: number }
export interface TerminalWaitResult {
  reason: 'text' | 'quiet' | 'timeout' | 'exited' | 'stopped' | 'replaced' | 'not_running';
  elapsedMs: number;
  exitCode?: number;
}

/** Observe only new output, or output after an explicit cursor. Silence does not prove completion. */
export async function waitForTerminalOutput(
  source: TerminalOutputSource, sessionId: string, condition: TerminalWaitCondition,
  options: { after?: string; signal?: AbortSignal } = {}
): Promise<TerminalWaitResult> {
  const { text, quietMs, timeoutMs = 15_000 } = condition;
  if ((text !== undefined) === (quietMs !== undefined)) throw new Error('waitFor 需要 text 或 quietMs，且只能选一项');
  if (text !== undefined && (typeof text !== 'string' || !text.length || text.length > 2000)) throw new Error('waitFor.text 需要 1–2000 字符');
  if (quietMs !== undefined && (!Number.isInteger(quietMs) || quietMs < 50 || quietMs > 5000)) throw new Error('quietMs 需要为 50–5000 的整数');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('timeoutMs 需要为 1–30000 的整数');
  const started = Date.now();
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const textStream = createAnsiTextStream();
    let carry = '', settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined, quiet: ReturnType<typeof setTimeout> | undefined;
    let observation: ReturnType<TerminalOutputSource['observeOutput']> | undefined;
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(quiet);
      observation?.dispose();
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (reason: TerminalWaitResult['reason'], exitCode?: number) => {
      if (settled) return;
      settled = true; cleanup();
      resolve({ reason, elapsedMs: Date.now() - started, ...(exitCode !== undefined ? { exitCode } : {}) });
    };
    const abort = () => {
      if (settled) return;
      settled = true; cleanup(); reject(new Error('已取消'));
    };
    const resetQuiet = () => {
      clearTimeout(quiet);
      if (quietMs !== undefined) quiet = setTimeout(() => finish('quiet'), quietMs);
    };
    const receive = (data: string) => {
      // Bound memory even for a continuously repainting TUI; match across PTY chunk boundaries.
      if (text !== undefined) {
        const appended = carry + textStream.push(data);
        if (appended.includes(text)) finish('text');
        carry = text.length > 1 ? appended.slice(-(text.length - 1)) : '';
      }
      if (!settled) resetQuiet();
    };
    try {
      observation = source.observeOutput(sessionId, event => {
        if (event.type === 'data') receive(event.data);
        else finish(event.type, event.exitCode);
      }, options.after);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) { abort(); return; }
      // Warm parser state without matching historical text (the cursor can bisect OSC/CSI).
      if (observation.prefix) textStream.push(observation.prefix);
      if (observation.backlog) receive(observation.backlog);
      if (settled) return;
      if (!observation.running) { finish('not_running', observation.exitCode); return; }
      timeout = setTimeout(() => finish('timeout'), timeoutMs);
      resetQuiet();
    } catch (error) { settled = true; cleanup(); reject(error); }
  });
}
