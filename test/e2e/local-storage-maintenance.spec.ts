/** Real renderer, preload and IPC with two Electron launches of one isolated profile. */
import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

test('cleans selected Other data on the next launch without deleting unselected data', async () => {
  const root = path.resolve(__dirname, '../..'), temporary = path.join(root, '.tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporary, 'storage-maintenance-e2e-'));
  const userData = path.join(fixture, 'userData'), bundle = path.join(fixture, 'storage.cjs'), bootstrap = path.join(fixture, 'bootstrap.cjs');
  const index = path.join(fixture, 'index.html'), preload = path.join(root, 'out/preload/index.js');
  const trimOutput = path.join(userData, 'trim-cache', 'old.txt'), usage = path.join(userData, 'usage-stats.json');
  fs.mkdirSync(path.dirname(trimOutput), { recursive: true });
  fs.writeFileSync(trimOutput, 'old output');
  fs.writeFileSync(usage, '{}');
  buildSync({ stdin: { contents: `
    export { registerLocalStorageIpc } from './src/main/ipc/localStorage';
    export { StartupStorageMaintenance } from './src/main/storage/startupMaintenance';`,
    resolveDir: root, sourcefile: 'storage-maintenance-entry.ts', loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['electron'], logLevel: 'silent' });
  buildSync({ entryPoints: [path.join(root, 'test/fixtures/local-storage-electron.tsx')], outfile: path.join(fixture, 'pane.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file', '.webp': 'file' }, logLevel: 'silent' });
  fs.writeFileSync(index, '<!doctype html><html><head><link rel="stylesheet" href="pane.css"></head><body><div id="root"></div><script src="pane.js"></script></body></html>');
  fs.writeFileSync(bootstrap, `
const {app,BrowserWindow,ipcMain}=require('electron');
const {registerLocalStorageIpc,StartupStorageMaintenance}=require(${JSON.stringify(bundle)});
app.setPath('userData',${JSON.stringify(userData)});
if(!app.requestSingleInstanceLock()) throw new Error('The test profile is already open');
const maintenance=new StartupStorageMaintenance(app.getPath('userData'),app.getPath('sessionData'));
const detachErrors=maintenance.detachQueued();
app.whenReady().then(async()=>{
  const purgeErrors=await maintenance.purgeDetached(new AbortController().signal);
  globalThis.fixtureErrors=[...detachErrors,...purgeErrors];
  // The driver observes the IPC before closing this process and starting its successor.
  ipcMain.handle('app:relaunch',()=>{ globalThis.fixtureRelaunchRequested=true; });
  const config={get:()=>({workspaces:[]})};
  let win;
  registerLocalStorageIpc({config,sessions:{rootDependencyRoster:()=>[]},themes:{list:()=>[]},getWindow:()=>win});
  win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
  await win.loadFile(${JSON.stringify(index)});
});
`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--no-sandbox'], cwd: fixture, env, timeout: 30000 });
  const close = async (app: ElectronApplication) => {
    const child = app.process();
    const exited = child.exitCode === null && child.signalCode === null
      ? once(child, 'exit', { signal: AbortSignal.timeout(10_000) }) : Promise.resolve([child.exitCode]);
    const [result] = await Promise.all([exited, app.close()]);
    return result[0];
  };
  const scanOther = async (page: Page, scanLabel = '开始扫描') => {
    await page.getByRole('button', { name: scanLabel }).click();
    await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^其他数据/ }).click();
  };
  const fixtureErrors = (app: ElectronApplication) => app.evaluate(() => (globalThis as typeof globalThis & { fixtureErrors: string[] }).fixtureErrors);
  let app: ElectronApplication | undefined;
  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.evaluate(() => localStorage.setItem('cleanup-fixture', 'persisted'));
    await app.evaluate(({ session }) => session.defaultSession.flushStorageData());
    await expect.poll(() => fs.existsSync(path.join(userData, 'Local Storage'))).toBe(true);
    const toolOutput = page.getByRole('checkbox', { name: '选择 工具结果全文缓存' });
    const webData = page.getByRole('checkbox', { name: '选择 工作台界面本地数据' });
    await scanOther(page);
    expect(await fixtureErrors(app)).toEqual([]);
    await expect(page.getByRole('checkbox', { name: '选择 使用统计和明细' })).toBeEnabled();
    await toolOutput.check();
    await webData.check();
    await page.getByRole('button', { name: '检查清理影响' }).click();
    const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
    await expect(dialog).toContainText('下次启动时清理');
    await expect(dialog).toContainText('未发送草稿');
    await dialog.getByRole('button', { name: '确认清理' }).click();
    await expect(page.getByText('2 项等待重启清理')).toBeVisible();
    expect(fs.readFileSync(trimOutput, 'utf8')).toBe('old output');
    expect(await page.evaluate(() => localStorage.getItem('cleanup-fixture'))).toBe('persisted');

    await scanOther(page, '重新扫描');
    await expect(toolOutput).toBeDisabled();
    await page.getByRole('button', { name: '重启并清理' }).click();
    await expect.poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { fixtureRelaunchRequested?: boolean }).fixtureRelaunchRequested)).toBe(true);
    expect(await close(app)).toBe(0);
    app = undefined;

    app = await launch();
    const reopened = await app.firstWindow();
    await scanOther(reopened);
    expect(await fixtureErrors(app)).toEqual([]);
    await expect(reopened.getByRole('checkbox', { name: '选择 工具结果全文缓存' })).toHaveCount(0);
    await expect(reopened.getByRole('button', { name: '重启并清理' })).toHaveCount(0);
    expect(fs.existsSync(trimOutput)).toBe(false);
    expect(await reopened.evaluate(() => localStorage.getItem('cleanup-fixture'))).toBeNull();
    expect(fs.readFileSync(usage, 'utf8')).toBe('{}');
    expect(fs.readdirSync(path.join(userData, '.storage-maintenance'))).toEqual([]);
  } finally {
    if (app) await close(app);
    expect(path.dirname(fixture)).toBe(temporary);
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
