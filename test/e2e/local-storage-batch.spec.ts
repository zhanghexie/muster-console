/** Batch selection and cleanup over real Electron preload / IPC with isolated data. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSync } from 'esbuild';

test('cleans a batch larger than 200 and reports a failed session independently from its attachment', async () => {
  const root = path.resolve(__dirname, '../..'), temporary = path.join(root, '.tmp');
  fs.mkdirSync(temporary, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(temporary, 'storage-batch-e2e-'));
  const userData = path.join(fixture, 'userData'), bundle = path.join(fixture, 'storage.cjs'), bootstrap = path.join(fixture, 'bootstrap.cjs');
  const attachment = path.join(userData, 'conversation-attachments', createHash('sha256').update('gui:bulk-7').digest('hex').slice(0, 20));
  fs.mkdirSync(attachment, { recursive: true });
  fs.writeFileSync(path.join(attachment, 'file.txt'), 'fixture attachment');
  buildSync({ stdin: { contents: "export { registerLocalStorageIpc } from './src/main/ipc/localStorage'; export { StorageInventory } from './src/main/storage/inventory';", resolveDir: root, sourcefile: 'storage-batch-entry.ts', loader: 'ts' },
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
  const rows=Array.from({length:225},(_,i)=>({id:'bulk-'+i,type:'terminal',name:'Batch '+i,createdAt:i,workspaceId:'ws',archived:true,status:'exited'}));
  globalThis.__scanCount=0; globalThis.__attempts=[];
  const originalScan=modules.StorageInventory.prototype.scan;
  modules.StorageInventory.prototype.scan=async function(){globalThis.__scanCount++;return originalScan.call(this)};
  const sessions={rootDependencyRoster:()=>structuredClone(rows),deleteLocalStorageSession:async(id)=>{
    globalThis.__attempts.push(id); if(id==='bulk-7') throw new Error('fixture session refused');
    rows.splice(rows.findIndex(row=>row.id===id),1);
  }};
  const config={get:()=>({workspaces:[{id:'ws',name:'Workspace'}]})};
  modules.registerLocalStorageIpc({config,sessions,themes:{list:()=>[]},getWindow:()=>win});
  win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.join(root, 'out/preload/index.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
  await win.loadFile(${JSON.stringify(path.join(fixture, 'index.html'))});
});
`);
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata') };
  delete env.ELECTRON_RUN_AS_NODE;
  let electron: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--no-sandbox'], cwd: fixture, env, timeout: 30000 });
    const page = await electron.firstWindow();
    expect(await electron.evaluate(() => (globalThis as typeof globalThis & { __scanCount: number }).__scanCount)).toBe(0);
    await page.getByRole('button', { name: '开始扫描' }).click();
    const categories = page.getByRole('navigation', { name: '存储类别' });
    await categories.getByRole('button', { name: /^会话/ }).click();
    const search = page.getByRole('searchbox', { name: '搜索存储项目' });
    await search.fill('Batch 224');
    await page.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }).check();
    await search.fill('');
    await page.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }).check();
    await expect(page.getByText(/已选择 225 项/)).toBeVisible();
    await categories.getByRole('button', { name: /^聊天附件/ }).click();
    await page.getByRole('checkbox', { name: '全选当前结果中的可清理项目' }).check();
    await expect(page.getByText(/已选择 226 项/)).toBeVisible();
    await page.getByRole('button', { name: '检查清理影响' }).click();
    const dialog = page.getByRole('dialog', { name: '确认清理所选项目？' });
    await expect(dialog).toContainText('Batch 224');
    await dialog.getByRole('button', { name: '确认清理' }).click();
    const results = page.locator('.local-storage-results');
    await expect(results).toContainText('未完成 1 项');
    await expect(results).toContainText('已发起 224 项');
    await expect(results).toContainText('已完成 1 项');
    await expect(page.locator('.local-storage-result-list')).toHaveCount(0);
    await page.getByRole('button', { name: '查看未完成项目' }).click();
    await expect(page.locator('.local-storage-result-list')).toContainText('fixture session refused');
    await expect(categories).toBeVisible();
    expect(await electron.evaluate(() => (globalThis as typeof globalThis & { __attempts: string[] }).__attempts.length)).toBe(225);
    expect(await electron.evaluate(() => (globalThis as typeof globalThis & { __scanCount: number }).__scanCount)).toBe(1);
    expect(fs.existsSync(attachment)).toBe(false);
  } finally {
    if (electron) {
      const child = electron.process();
      await electron.close();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Electron fixture did not exit before cleanup')), 10000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
          if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
        });
      }
    }
    const target = fs.realpathSync(fixture), parent = fs.realpathSync(temporary);
    expect(path.dirname(target)).toBe(parent);
    expect(path.basename(target).startsWith('storage-batch-e2e-')).toBe(true);
    fs.rmSync(target, { recursive: true, force: true });
  }
});
