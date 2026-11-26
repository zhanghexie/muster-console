import type { AppContext } from '../context';

/** Initial mail is durable before this check. A slow launch must not invite a duplicate. */
export async function waitForSessionLaunch(
  ctx: AppContext, sessionId: string, timeoutMs = 8000
): Promise<'running' | 'starting'> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = ctx.sessions.get(sessionId);
    if (!current) throw new Error(`会话不存在：${sessionId}`);
    if (current.status === 'exited' || current.lifecycle === 'exited') {
      throw new Error(`会话 ${sessionId} 启动失败：${current.meta?.launchError ?? '进程已退出'}；原会话保留`);
    }
    if (ctx.pty.isRunning(sessionId)) return 'running';
    if (Date.now() >= deadline) return 'starting';
    await new Promise(resolve => setTimeout(resolve, Math.min(160, Math.max(1, deadline - Date.now()))));
  }
}
