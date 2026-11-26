/**
 * 开发模式但不启用隔离沙箱，使用正式 Muster userData（由 Electron 按 Windows/macOS/Linux 解析）。
 * 运行: npm run dev:no-sandbox
 */
import { runElectronVite } from './run-electron-vite.mjs';

process.env.MUSTER_NO_SANDBOX = '1';
console.log('[dev:no-sandbox] 不启用隔离沙箱，使用真实 userData');
await runElectronVite();
