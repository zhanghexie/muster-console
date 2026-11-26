/** Real Electron/preload/trust dialog/runtime; isolated fixtures, no model service. */
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const nodeRequire = createRequire(__filename);

test('cancel during child trust and reject revoked recovery through real app', async () => {
  test.setTimeout(90000);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-e2e-'));
  const workspace = path.join(cwd, 'workspace');
  const ud = path.join(cwd, '.dev-sandbox/userData');
  fs.mkdirSync(ud, { recursive: true });
  const marker = path.join(cwd, 'child-executed');
  const definition = (name: string, script: string) => {
    const dir = path.join(workspace, '.muster/workflows', name);
    fs.mkdirSync(dir, {recursive:true});
    const doc = `---\nname: ${name}\ndescription: isolated workflow acceptance\n---\n`;
    fs.writeFileSync(path.join(dir,'WORKFLOW.md'),doc);
    fs.writeFileSync(path.join(dir,'run.mjs'),script);
    return createHash('sha256').update(doc).update('\0').update(script).digest('hex').slice(0,16);
  };
  const fingerprint = definition('parent', `export default async wf => {await wf.ask('continue',{to:'human'}); return wf.call('child',{});};`);
  definition('child', `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'executed'); export default async wf => wf.ask('child');`);
  const runFile = path.join(workspace,'.muster/scheduler/workflow-runs/wf-parent.json');
  fs.mkdirSync(path.dirname(runFile),{recursive:true});
  const seed = () => fs.writeFileSync(runFile,JSON.stringify({version:1,runId:'wf-parent',name:'parent',workspaceId:'workflow-test',depth:0,status:'running',args:{},state:{},fingerprint,maxDelegates:10,maxHours:24,startedAt:Date.now(),updatedAt:Date.now(),log:[],memo:{},delegates:0,humanWaitMs:0,resumes:0,trigger:'manual'}));
  const configure = (trusted: boolean) => {
    fs.writeFileSync(path.join(ud,'config.json'),JSON.stringify({locale:'zh-CN',themeId:'dark',activeWorkspaceId:'workflow-test',defaultCwd:workspace,workspaces:[{id:'workflow-test',name:'Workflow test',path:workspace}],extensionTrust:trusted?{'workflow-test':{'workflow:parent':fingerprint}}:{},webAccess:{enabled:false},mcp:{enabled:false,servers:[]}}));
    fs.writeFileSync(path.join(ud,'sessions.json'),'[]');
  };
  const env = {...process.env,MUSTER_SANDBOX:'1',MUSTER_INSTANCE_ID:path.basename(cwd)} as Record<string,string>;
  for (const key of ['ELECTRON_RENDERER_URL','MUSTER_DEVTOOLS_PORT','MUSTER_WEB_PORT','MUSTER_NO_SANDBOX']) delete env[key];
  let app: ElectronApplication | undefined;
  const close = async () => {
    if (!app) return;
    const proc = app.process();
    try { await app.close(); }
    finally {
      if (proc.exitCode === null && proc.pid) {
        if (process.platform === 'win32') {
          try { execFileSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore',windowsHide:true}); } catch { /* already exited */ }
        } else proc.kill();
      }
      app = undefined;
    }
  };
  const launch = async () => {
    app = await _electron.launch({executablePath:nodeRequire('electron'),args:[repoRoot,'--disable-gpu','--in-process-gpu'],cwd,env,timeout:30000});
    const win = await app.firstWindow();
    await win.locator('.app-shell').waitFor({timeout:30000});
    return win;
  };
  try {
    configure(true);
    seed();
    const win = await launch();
    await expect.poll(async () => (await win.evaluate(() => window.api.workflow.overview('workflow-test'))).active[0]?.pendingAsk?.question).toBe('continue');
    const overview = await win.evaluate(() => window.api.workflow.overview('workflow-test'));
    await win.evaluate(async askId => window.api.workflow.answer('workflow-test','wf-parent',askId,'go'),overview.active[0].pendingAsk!.askId);
    const dialog = win.locator('.confirm-modal');
    await expect(dialog).toContainText('首次运行工作流：child');
    const cancelled = await win.evaluate(() => window.api.workflow.cancel('workflow-test','wf-parent',true));
    expect(cancelled.status).toBe('cancelled');
    await dialog.getByRole('button',{name:'确认执行',exact:true}).click();
    await dialog.waitFor({state:'hidden'});
    await expect.poll(async () => (await win.evaluate(() => window.api.workflow.overview('workflow-test'))).recent.find(r=>r.runId==='wf-parent')?.status).toBe('cancelled');
    await close(); // complete any pending callbacks before inspecting durable state
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readdirSync(path.dirname(runFile)).filter(n=>n.endsWith('.json'))).toEqual(['wf-parent.json']);
    expect(JSON.parse(fs.readFileSync(runFile,'utf8')).status).toBe('cancelled');

    configure(false);
    seed();
    const restarted = await launch();
    await expect.poll(async () => (await restarted.evaluate(() => window.api.workflow.overview('workflow-test'))).recent[0]?.status).toBe('interrupted');
    expect((await restarted.evaluate(() => window.api.workflow.overview('workflow-test'))).recent[0].error).toContain('信任已撤销');
    expect(fs.existsSync(marker)).toBe(false);
    await expect(restarted.locator('.confirm-modal')).toHaveCount(0);
  } finally {
    await close();
    fs.rmSync(cwd,{recursive:true,force:true});
  }
});
