import { app } from 'electron';
import path from 'node:path';
import { DesktopIndicatorWindow } from '../../../src/main/desktop/desktopIndicatorWindow';
import type { DesktopIndicatorSnapshot } from '../../../src/shared/desktopIndicator';
import { builtinTheme } from '../../../src/shared/theme';

const labels = process.env.MUSTER_TEST_LANGUAGE === 'en'
  ? { active: 'AI is using your computer', stopping: 'Stopping computer use', unknown: 'Computer action outcome unknown',
    escape: 'Press Esc to stop', stop: 'Stop', escapeUnavailable: 'Use Stop to end' }
  : { active: 'AI 正在操作电脑', stopping: '正在停止', unknown: '结果未知', escape: 'Esc 停止',
    stop: '停止', escapeUnavailable: '请点停止' };
let indicator: DesktopIndicatorWindow;
if (process.env.MUSTER_TEST_USER_DATA) app.setPath('userData', process.env.MUSTER_TEST_USER_DATA);
app.whenReady().then(async () => {
  const snapshot: DesktopIndicatorSnapshot = { revision: 1, state: 'active', target: '测试窗口',
    escapeAvailable: process.env.MUSTER_TEST_ESCAPE !== 'unavailable', labels,
    theme: builtinTheme(process.env.MUSTER_TEST_THEME === 'light' ? 'light' : 'dark')! };
  indicator = new DesktopIndicatorWindow(async () => {
    await indicator.show({ ...snapshot, revision: 2, state: 'stopping' });
  }, reason => { console.error(reason); app.exit(1); }, path.resolve('out/preload/desktopIndicator.js'), path.resolve('out/renderer'));
  indicator.registerIpc();
  await indicator.show(snapshot);
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
