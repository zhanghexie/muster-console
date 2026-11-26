import { spawn, execFileSync } from 'node:child_process';

/** Kill the command's tree on timeout, including browser/Git grandchildren. */
function stopTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
}

/** Direct framework CLIs get the same ceiling as npm wrappers. */
export function armProcessDeadline(deadline, label) {
  const timer = setTimeout(() => {
    console.error(`${label}：时间预算已用完，已终止测试进程树；验证未完成。`);
    stopTree({ pid: process.pid, kill: () => process.exit(1) });
  }, Math.max(1, deadline - Date.now()));
  timer.unref();
  return () => clearTimeout(timer);
}

export function execute(file, args, { timeoutMs = 0, onOutput, ...options } = {}) {
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn(file, args, { ...options, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; stopTree(child); }, timeoutMs) : null;
    const collect = data => { out += data; onOutput?.(data); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const finish = (code, error = '') => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 1 : code, out: out + error, ms: Date.now() - started, timedOut });
    };
    child.on('error', error => {
      const message = String(error);
      onOutput?.(`${message}\n`);
      finish(1, message);
    });
    child.on('close', code => finish(code ?? 1));
  });
}
