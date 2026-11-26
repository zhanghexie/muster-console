/** Real Electron preload, IPC, host tool, SQLite and production reminder component. */
import { test, expect, _electron } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { buildSync } from 'esbuild';

test('reminders survive restart and remain bound to GUI, CLI and scheduler conversations', async ({}, info) => {
  const root = path.resolve(__dirname, '../..');
  const fixture = path.join(info.outputDir, 'reminder-fixture');
  const userData = path.join(fixture, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const mainBundle = path.join(fixture, 'main.cjs');
  const preload = path.join(fixture, 'preload.cjs');
  const renderer = path.join(fixture, 'renderer.js');
  const bootstrap = path.join(fixture, 'bootstrap.cjs');
  const html = path.join(fixture, 'index.html');
  buildSync({ stdin: { contents: "export {registerSessionRemindersIpc} from './src/main/ipc/sessionReminders'; export {sessionRemindersHost} from './src/main/capabilities/hosts/sessionReminders'; export {runAsAgentSession,runAsAgentWorkspace,runAsSchedulerTool} from './src/main/agent/agentScope';", resolveDir: root, sourcefile: 'reminder-main-entry.ts', loader: 'ts' },
    outfile: mainBundle, bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['electron'], logLevel: 'silent' });
  buildSync({ entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: preload, bundle: true, platform: 'node', format: 'cjs', packages: 'external', external: ['electron'], logLevel: 'silent' });
  buildSync({ entryPoints: [path.join(root, 'test/fixtures/session-reminders-electron-renderer.tsx')], outfile: renderer,
    bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', alias: { '@workbench': root },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false' },
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' }, logLevel: 'silent' });
  fs.writeFileSync(html, '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script type="module" src="renderer.js"></script></body></html>');
  fs.writeFileSync(bootstrap, `
const {app,BrowserWindow}=require('electron');
app.setPath('userData',${JSON.stringify(userData)});
let win, schedulerFile='scheduler-a.jsonl';
app.whenReady().then(async()=>{
  const m=require(${JSON.stringify(mainBundle)});
  const ctx={
    sessions:{get:id=>['gui','cli'].includes(id)?{id}:undefined},
    workspaces:{list:()=>[{id:'ws'}]},
    agentSessions:{currentAssistantMessageId:id=>id==='gui'?'message-gui':null},
    orchestrator:{getHistory:()=>[],getCurrentSessionFile:()=>schedulerFile,currentAssistantMessageId:()=>'scheduler-message'},
    getWindow:()=>win
  };
  m.registerSessionRemindersIpc(ctx);
  globalThis.reminderFixture={
    add:(id,text)=>m.runAsAgentSession(id,async()=>m.sessionRemindersHost['ui.reminders'](ctx,{action:'add',text})),
    tryDelete:(id,reminderId)=>m.runAsAgentSession(id,async()=>{
      try { await m.sessionRemindersHost['ui.reminders'](ctx,{action:'delete',reminderId}); return 'unexpected success'; }
      catch (error) { return String(error); }
    }),
    addScheduler:text=>m.runAsAgentWorkspace('ws',()=>m.runAsSchedulerTool(async()=>m.sessionRemindersHost['ui.reminders'](ctx,{action:'add',text}))),
    switchScheduler:file=>{schedulerFile=file;win.webContents.send('agent:history',{workspaceId:'ws',messages:[]});}
  };
  win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:false}});
  await win.loadFile(${JSON.stringify(html)});
});
app.on('window-all-closed',()=>app.quit());
`);
  const env = { ...process.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const launch = () => _electron.launch({ executablePath: require('electron'), args: [bootstrap, '--disable-gpu'], cwd: fixture, env, timeout: 30000 });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    let trigger = page.getByRole('button', { name: '用户待办提醒', exact: true });
    await expect(page.locator('.agent-composer-toolbar').getByRole('button', { name: '用户待办提醒' })).toBeVisible();
    await expect(trigger.locator('.session-reminder-count')).toHaveCount(0);
    await app.evaluate(async () => (globalThis as any).reminderFixture.add('gui', '确认 GUI 样式'));
    const guiDelete = await app.evaluate(async () => (globalThis as any).reminderFixture.add('gui', '删除 GUI 提醒'));
    await expect(trigger).toContainText('2');
    expect(await app.evaluate(async id => (globalThis as any).reminderFixture.tryDelete('gui', id), guiDelete.item.id))
      .toContain('Choose list, add, complete, or reopen');
    await trigger.click();
    expect(await page.getByRole('dialog', { name: '用户待办提醒' }).evaluate(el => el.parentElement?.classList.contains('chat-input-shell'))).toBe(true);
    await expect(page.getByRole('checkbox', { name: '标记完成：确认 GUI 样式' })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看原消息' }).first()).toBeVisible();
    await page.getByRole('button', { name: '删除提醒：删除 GUI 提醒' }).click();
    await expect(trigger).toContainText('1');
    expect((await page.evaluate(() => window.api.sessionReminders.list({ kind: 'session', sessionId: 'gui' }))).items.map(item => item.text))
      .toEqual(['确认 GUI 样式']);

    await page.getByRole('button', { name: 'CLI', exact: true }).click();
    await expect(trigger.locator('.session-reminder-count')).toHaveCount(0);
    await trigger.click();
    await app.evaluate(async () => (globalThis as any).reminderFixture.add('cli', '确认 CLI 操作'));
    await app.evaluate(async () => (globalThis as any).reminderFixture.add('cli', '删除 CLI 提醒'));
    await expect(trigger).toContainText('2');
    await page.getByRole('button', { name: '删除提醒：删除 CLI 提醒' }).click();
    await expect(trigger).toContainText('1');
    await expect(page.getByRole('checkbox', { name: '标记完成：确认 CLI 操作' })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看原消息' })).toHaveCount(0);
    await page.getByRole('checkbox', { name: '标记完成：确认 CLI 操作' }).click();
    await expect(trigger.locator('.session-reminder-count')).toHaveCount(0);
    expect((await page.evaluate(() => window.api.sessionReminders.list({ kind: 'session', sessionId: 'cli' }))).items[0].completedBy).toBe('user');

    await page.getByRole('button', { name: '调度', exact: true }).click();
    await trigger.click();
    await app.evaluate(async () => (globalThis as any).reminderFixture.addScheduler('确认调度方案'));
    await app.evaluate(async () => (globalThis as any).reminderFixture.addScheduler('删除调度提醒'));
    await page.getByRole('button', { name: '删除提醒：删除调度提醒' }).click();
    await expect(page.getByRole('checkbox', { name: '标记完成：确认调度方案' })).toBeVisible();
    await app.evaluate(() => (globalThis as any).reminderFixture.switchScheduler('scheduler-b.jsonl'));
    await expect(trigger.locator('.session-reminder-count')).toHaveCount(0);
    await expect(page.getByText('确认调度方案')).toHaveCount(0);
    await app.evaluate(() => (globalThis as any).reminderFixture.switchScheduler('scheduler-a.jsonl'));
    await expect(page.getByText('确认调度方案')).toBeVisible();
    await app.close();

    app = await launch();
    page = await app.firstWindow();
    trigger = page.getByRole('button', { name: '用户待办提醒', exact: true });
    await expect(trigger).toContainText('1');
    await page.getByRole('button', { name: 'CLI', exact: true }).click();
    await trigger.click();
    await expect(page.getByRole('checkbox', { name: '重新打开：确认 CLI 操作' })).toBeChecked();
  } finally {
    await app.close().catch(() => {});
  }
});
