import { app } from 'electron';
import path from 'node:path';
import { DesktopActivityRuntime } from '../../../src/main/desktop/desktopActivityRuntime';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import { WindowsEscapeMonitor, windowsEscapeScript } from '../../../src/main/desktop/windowsEscapeMonitor';

const labels = { active: 'AI 正在操作电脑', stopping: '正在停止', unknown: '结果未知', escape: 'Esc 停止',
  stop: '停止', escapeUnavailable: '请点停止' };
if (process.env.MUSTER_TEST_USER_DATA) app.setPath('userData', process.env.MUSTER_TEST_USER_DATA);
app.whenReady().then(async () => {
  const runtime = new DesktopActivityRuntime({ labels,
    // This fixture uses no real injected input; a production backend must supply real cleanup.
    releaseAll: async () => {},
    createIndicator(stop, unavailable) {
      const indicator = new DesktopIndicatorWindow(stop, unavailable,
        path.resolve('out/preload/desktopIndicator.js'), path.resolve('out/renderer'));
      indicator.registerIpc();
      return indicator;
    },
    ...(process.platform === 'win32' && process.env.MUSTER_TEST_REAL_ESCAPE_MONITOR === '1' ? {
      createEscapeMonitor(onEscape: () => void, onFailure: (reason: string) => void) {
        const monitor = new WindowsEscapeMonitor(windowsEscapeScript(path.resolve('out/main')), onEscape, onFailure);
        return { start: () => monitor.start(), stop: async () => { await monitor.stop(); (globalThis as any).__escapeMonitorStopped = true; } };
      }
    } : {})
  });
  app.once('before-quit', event => {
    event.preventDefault();
    void runtime.dispose().finally(() => app.exit(0));
  });
  runtime.turns.begin('fixture', 'turn-1', () => true);
  void runtime.turns.use('fixture', 'turn-1', '测试窗口', signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
  })).catch(() => {});
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
