/** 远程工作台等待已有 PTY 会话就绪。 */
export const BIND_READY_POLL_MS = 250;
export const BIND_READY_TIMEOUT_MS = 60_000;

export function isBoundTerminalReady(opts: {
  ptyRunning: boolean;
  status?: string;
  lifecycle?: string;
}): boolean {
  if (!opts.ptyRunning) return false;
  if (opts.status === 'starting' || opts.lifecycle === 'starting') return false;
  if (opts.lifecycle === 'exited') return false;
  return true;
}
