/** Real renderer, preload and IPC with isolated userData and a controllable scan. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

test('opening storage does not scan; user starts each scan and cleanup does not rescan', async () => {
  const root = path.resolve(__dirname, '../..'), temporary = path.join(root, '.tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporary, 'storage-manual-e2e-'));
  const userData = path.join(fixture, 'userData'), bundle = path.join(fixture, 'storage.cjs'), bootstrap = path.join(fixture, 'bootstrap.cjs');
  fs.mkdirSync(userData);
  buildSync({ stdin: { contents: "export { registerLocalStorageIpc } from './src/main/ipc/localStorage'; export { ThemeService } from './src/main/themes'; export { StorageInventory } from './src/main/storage/inventory';", resolveDir: root, sourcefile: 'storage-ipc-entry.ts', loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['electron'], logLevel: 'silent' });
  buildSync({ entryPoints: [path.join(root, 'test/fixtures/local-storage-electron.tsx')], outfile: path.join(fixture, 'pane.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file', '.webp': 'file' }, logLevel: 'silent' });
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="pane.css"></head><body><div id="root"></div><script src="pane.js"></script></body></html>');
  fs.writeFileSync(bootstrap, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(userData)});
let win;
app.whenReady().then(async()=>{
  const modules=require(${JSON.stringify(bundle)});
  let state={workspaces:[],themeId:'dark',activeWorkspaceId:''};
  const config={get:()=>state,update:patch=>{state={...state,...patch}}};
  const themes=new modules.ThemeService(${JSON.stringify(userData)},config);
  themes.create('Fixture theme');
  themes.create('Second theme');
  globalThis.__scanCount=0;
  const gate=new Promise(resolve=>{globalThis.__releaseScan=resolve});
  const originalScan=modules.StorageInventory.prototype.scan;
  modules.StorageInventory.prototype.scan=async function(){globalThis.__scanCount++;await gate;return originalScan.call(this)};
  modules.registerLocalStorageIpc({config,sessions:{rootDependencyRoster:()=>[]},themes,getWindow:()=>win});
  win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.join(root, 'out/preload/index.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
  await win.loadFile(${JSON.stringify(path.join(fixture, 'index.html'))});
});
`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--no-sandbox'], cwd: fixture, env, timeout: 30000 });
    const page = await app.firstWindow();
    const scanCount = () => app!.evaluate(() => (globalThis as typeof globalThis & { __scanCount: number }).__scanCount);
    await expect(page.getByText('尚未扫描')).toBeVisible();
    expect(await scanCount()).toBe(0);
    await page.getByRole('button', { name: '开始扫描' }).click();
    await expect(page.getByText('正在扫描本机存储…')).toBeVisible();
    await expect(page.locator('.brand-loader-orbit')).toBeVisible();
    expect(await scanCount()).toBe(1);
    await app.evaluate(() => (globalThis as typeof globalThis & { __releaseScan: () => void }).__releaseScan());
    await page.getByRole('navigation', { name: '存储类别' }).getByRole('button', { name: /^主题/ }).click();
    await page.getByRole('checkbox', { name: '选择 Fixture theme' }).check();
    await page.getByRole('button', { name: '检查清理影响' }).click();
    await page.getByRole('dialog', { name: '确认清理所选项目？' }).getByRole('button', { name: '确认清理' }).click();
    await expect(page.getByText('已完成 1 项')).toBeVisible();
    await expect(page.getByRole('navigation', { name: '存储类别' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '选择 Fixture theme' })).toHaveCount(0);
    expect(await scanCount()).toBe(1);
    await page.getByRole('checkbox', { name: '选择 Second theme' }).check();
    await page.getByRole('button', { name: '检查清理影响' }).click();
    await page.getByRole('dialog', { name: '确认清理所选项目？' }).getByRole('button', { name: '确认清理' }).click();
    await expect(page.getByRole('checkbox', { name: '选择 Second theme' })).toHaveCount(0);
    expect(await scanCount()).toBe(1);
    await page.getByRole('button', { name: '重新扫描' }).click();
    await expect(page.getByRole('navigation', { name: '存储类别' })).toBeVisible();
    expect(await scanCount()).toBe(2);
    expect(fs.readdirSync(path.join(userData, 'themes'))).toEqual([]);
  } finally {
    if (app) {
      const child = app.process();
      await app.close();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Electron fixture did not exit before cleanup')), 10000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
        });
      }
    }
    const target = path.resolve(fixture), parent = path.resolve(temporary);
    expect(target.startsWith(`${parent}${path.sep}storage-manual-e2e-`)).toBe(true);
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
