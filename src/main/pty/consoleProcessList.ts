import { fork, type ForkOptions } from 'node:child_process';
import { createRequire } from 'node:module';

/** node-pty's default console probe forks without windowsHide. Keep the native
 * query in a hidden Node helper with bounded lifetime, including in Electron. */
export function hiddenConsoleProcessList(pid: number, options: {
  launch?: typeof fork; helper?: string; timeoutMs?: number;
} = {}): Promise<number[]> {
  return new Promise(resolve => {
    let child: ReturnType<typeof fork>;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (pids: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(pids);
      try { child?.kill(); } catch { /* Already exited. */ }
    };
    try {
      const helper = options.helper ?? createRequire(import.meta.url).resolve('node-pty/lib/conpty_console_list_agent.js');
      const childOptions: ForkOptions & { windowsHide: boolean } = {
        windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      };
      child = (options.launch ?? fork)(helper, [String(pid)], childOptions);
      child.once('error', () => finish([pid]));
      child.once('exit', () => finish([pid]));
      child.once('message', (message: unknown) => {
        const values = (message as { consoleProcessList?: unknown })?.consoleProcessList;
        finish(Array.isArray(values) && values.every(value => Number.isSafeInteger(value) && value > 0) ? values : [pid]);
      });
      timer = setTimeout(() => finish([pid]), options.timeoutMs ?? 2000);
      timer.unref?.();
    } catch { finish([pid]); }
  });
}
