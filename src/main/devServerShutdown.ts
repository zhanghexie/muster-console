/**
 * 开发态：关窗口后必须把 electron-vite（占 5188）一起带走。
 * electron-vite 虽有 `electron.on('close', process.exit)`，Windows 上关窗后
 * 主进程偶发挂起，Vite 开发服继续 LISTENING，下次启动报 Port 5188 already in use。
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';

function killViteParent(): void {
  if (app.isPackaged) return;
  if (process.env.NODE_ENV_ELECTRON_VITE !== 'development') return;
  const ppid = process.ppid;
  if (!ppid || ppid <= 4) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(ppid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        detached: true
      }).unref();
    } else {
      process.kill(ppid, 'SIGTERM');
    }
  } catch {
    /* 父进程已退出 */
  }
}

export function installDevServerShutdown(): void {
  app.on('window-all-closed', () => {
    app.quit();
    // 守卫不能省：打包态走优雅退出（给 flush 留时间），强退只留给开发态的 vite 回收
    if (app.isPackaged || process.env.NODE_ENV_ELECTRON_VITE !== 'development') return;
    setTimeout(() => {
      killViteParent();
      app.exit(0);
    }, 1500).unref();
  });
  if (!app.isPackaged) {
    app.on('quit', () => killViteParent());
  }
}
