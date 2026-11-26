import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const project = path.resolve(import.meta.dirname, '..');
const run = await fs.mkdtemp(path.join(project, '.tmp/color-native-'));
const userData = path.join(run, '.dev-sandbox/userData');
const workspace = path.join(run, 'workspace');
const captures = path.join(project, 'output/color-system-native');
await fs.mkdir(userData, { recursive: true }); await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(captures, { recursive: true });
await fs.writeFile(path.join(workspace, 'SideToolsPanel.tsx'), await fs.readFile(path.join(project, 'src/renderer/src/panels/SideToolsPanel.tsx')));
await fs.writeFile(path.join(workspace, 'design.md'), '# 界面配色审核\n\n保持真实布局、字体与材质，只修正局部层级。\n');
await fs.mkdir(path.join(workspace, 'components'), { recursive: true });
await fs.writeFile(path.join(workspace, 'components', 'RightWorkspaceToolbar.tsx'), await fs.readFile(path.join(project, 'src/renderer/src/components/RightWorkspaceToolbar.tsx')));
const git = (...args) => execFileSync('git', ['-c','core.hooksPath=NUL',...args], { cwd: workspace, stdio: 'pipe' });
git('init'); git('add','.'); git('-c','user.name=Visual fixture','-c','user.email=fixture@local.invalid','commit','-m','visual fixture');
await fs.appendFile(path.join(workspace, 'SideToolsPanel.tsx'), '\n// Review: keep the original surfaces and improve local states.\n');
await fs.writeFile(path.join(userData, 'config.json'), JSON.stringify({ locale:'zh-CN', uiFont:'oppo', themeId:'dark', activeWorkspaceId:'color-native', workspaces:[{id:'color-native',name:'演示·游乐场',path:workspace,accent:'#b7667e',accentOff:false}], webAccess:{enabled:false}, mcp:{enabled:false,servers:[]} }));
await fs.writeFile(path.join(userData, 'sessions.json'),'[]');
const env={...process.env,MUSTER_SANDBOX:'1',MUSTER_INSTANCE_ID:`color-native-${process.pid}`};
for(const key of ['ELECTRON_RUN_AS_NODE','ELECTRON_RENDERER_URL','MUSTER_NO_SANDBOX','MUSTER_DEVTOOLS_PORT','MUSTER_WEB_PORT','MUSTER_DEV_MOBILE_WS','MUSTER_HOST','MUSTER_STATUS_URL']) delete env[key];
const report={source:'built production app with runtime CSS only',run,views:[],checks:[],errors:[]};
// The app probes the globally bound lark profile even with feishu.enabled=false.
// Block that one external adapter in this visual fixture before the real entry loads.
const cliOff=path.join(run,'lark-off.cjs');
await fs.writeFile(cliOff,'process.stdout.write(JSON.stringify({ok:false,error:{message:"Disabled in visual fixture"}}));process.exitCode=1;');
const bootstrap=path.join(run,'bootstrap.cjs');
await fs.writeFile(bootstrap,`const cp=require('node:child_process');const p=require('node:path');const original=cp.spawn;cp.spawn=function(file,args,options){if(p.basename(String(file)).toLowerCase()==='lark-cli.exe'){return original(process.execPath,[${JSON.stringify(cliOff)}],{...options,env:{...options?.env,ELECTRON_RUN_AS_NODE:'1'}});}return original(file,args,options);};require(${JSON.stringify(path.join(project,'out/main/index.js'))});`);
const app=await _electron.launch({executablePath:require('electron'),args:[bootstrap,'--force-device-scale-factor=1','--disable-renderer-backgrounding','--disable-background-timer-throttling'],cwd:run,env,timeout:30000});
let page;
try {
  page=await app.firstWindow(); page.setDefaultTimeout(9000); page.on('pageerror',e=>report.errors.push(e.message));
  await app.evaluate(({BrowserWindow,screen})=>{const w=BrowserWindow.getAllWindows()[0], area=screen.getDisplayMatching(w.getBounds()).workArea; w.webContents.setBackgroundThrottling(false);w.setBounds({x:area.x+30,y:area.y+30,width:Math.min(1440,area.width-60),height:Math.min(900,area.height-60)});w.showInactive();});
  await page.locator('.app-shell').waitFor({timeout:30000});
  const actualData=await app.evaluate(({app})=>app.getPath('userData'));
  assert.equal(path.resolve(actualData),path.resolve(userData),'App must use the separate fixture data directory');
  report.checks.push('isolated userData verified');
  await page.evaluate(()=>window.api.workspaceFile.patch({hVirtualScreen:true,hDock:'git',hTerminalRatio:.55,hGitRatio:.45,focusMode:false,leftColumnWidth:240},'color-native'));
  await page.reload();await page.locator('.app-shell').waitFor();
  const ids=await page.evaluate(async cwd=>{const base={runtime:'pi',force:true,guiMode:'auto',cwd,workspaceId:'color-native'};const one=await window.api.sessions.create({...base,name:'配色系统审核'});const two=await window.api.sessions.create({...base,name:'界面开发'});return [one.id,two.id];},workspace);
  await page.evaluate(id=>window.api.sessions.select(id),ids[0]);
  await page.keyboard.press('Escape');
  await page.locator('.composer-editable').first().waitFor();
  await app.evaluate(({BrowserWindow},payload)=>BrowserWindow.getAllWindows()[0].webContents.send('agentSession:event',payload),{kind:'sync',sessionId:ids[0],messages:[
    {id:'fixture-user',role:'user',ts:Date.now()-90000,parts:[{kind:'text',text:'先保留真实界面的材质和布局，看看标签、编辑器与输入区能否更统一。'}]},
    {id:'fixture-assistant',role:'assistant',ts:Date.now()-60000,parts:[{kind:'text',text:'这次在同一个真实窗口中比较原版和微调。\n\n- 保留现有背景、字体与信息密度。\n- 标签选中使用稍清楚的填充。\n- 工具条与内容面保持同一色相。\n\n```tsx\n<RightWorkspace>\n  <TabStrip />\n  <ContentToolbar />\n  <ContentView />\n</RightWorkspace>\n```\n\n正文、语法色和身份图像继续各自表达内容。'}]}
  ]});
  await page.getByText('这次在同一个真实窗口中比较原版和微调。',{exact:false}).waitFor();
  const pane=page.locator('.right-workspace');await pane.waitFor();
  await pane.getByRole('tablist',{name:'资源面板'}).getByRole('tab',{name:'文件',exact:true}).click();
  const row=name=>pane.locator(`.right-resource-page.is-shown .file-tree-row[title="${name}"]`);
  await row('design.md').dblclick(); await row('SideToolsPanel.tsx').dblclick();
  await pane.getByRole('button',{name:'编辑',exact:true}).click();
  await pane.locator('.right-content-page.is-shown .cm-content').waitFor();
  await page.locator('.chat-msg.assistant').last().scrollIntoViewIfNeeded();
  const layout=await page.locator('.center-panel').evaluate(el=>({center:el.getBoundingClientRect().x,sidebar:document.querySelector('.sessions-column')?.getBoundingClientRect().x,mainWidth:document.querySelector('.main-view').clientWidth}));
  assert.ok(layout.center>=0&&layout.sidebar>=0,'Both sessions and chat must be in the actual visible window');
  report.checks.push('session list and chat visible without virtual-screen crop');
  await page.locator('.composer-editable').first().fill('这里保留同一份输入草稿。');
  await page.addStyleTag({path:path.join(project,'docs/prototypes/color-system-native/color-system-native.css')});
  // Capture only this unfocused app. Desktop composition can include unrelated OS
  // overlays; use the real solid-frame fallback and leave Mica acceptance separate.
  await page.addStyleTag({content:'html[data-color-capture="solid"] .app-shell { background: var(--workspace-frame-color) !important; }'});
  await page.evaluate(()=>{document.documentElement.dataset.colorCapture='solid';});
  const geometry=()=>page.evaluate(()=>Object.fromEntries(['.chrome-bar','.center-panel','.right-workspace','.right-tabs-row','.right-current-row','.right-resources','.chat-input-shell'].map(s=>{const e=document.querySelector(s);if(!e)return [s,null];const r=e.getBoundingClientRect(),c=getComputedStyle(e);return [s,[r.x,r.y,r.width,r.height,c.fontFamily,c.fontSize,c.borderRadius]];})));
  const mode=async variant=>{await page.evaluate(variant=>{document.documentElement.dataset.colorStudy=variant;},variant);await page.evaluate(async()=>{await Promise.race([document.fonts.ready,new Promise(resolve=>setTimeout(resolve,1500))]);for(const animation of document.getAnimations())if(animation.effect?.getTiming().iterations!==Infinity)animation.finish();});};
  const capture=async(theme,view,variant)=>{
    await mode(variant);await page.mouse.move(1,1);
    const png=await page.screenshot({type:'png',timeout:12000});
    const jpeg=await page.screenshot({type:'jpeg',quality:70,timeout:12000});
    const name=`${theme}-${view}-${variant}`;
    await fs.writeFile(path.join(captures,name+'.png'),png);await fs.writeFile(path.join(captures,name+'.jpg'),jpeg);
    report.views.push({theme,view,variant,name,size:{width:png.readUInt32BE(16),height:png.readUInt32BE(20)}});console.log('Captured '+name);
  };
  for(const theme of ['dark','light']) {
    await page.evaluate(theme=>window.api.themes.activate(theme),theme);
    await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
    await page.evaluate(()=>{document.documentElement.style.setProperty('--study-reading',getComputedStyle(document.querySelector('.center-panel')).backgroundColor);});
    await mode('original');const before=await geometry();
    await capture(theme,'workbench','original');await capture(theme,'workbench','balanced');
    const after=await geometry();assert.deepEqual(after,before,'Colors must not alter actual UI geometry or typography');report.checks.push(theme+' workbench: geometry/fonts/radii unchanged');
    await page.keyboard.press('Control+,');
    await page.locator('.settings-page').waitFor();
    const appearance=page.getByRole('button',{name:'外观',exact:true});await appearance.click();
    await capture(theme,'settings','original');await capture(theme,'settings','balanced');
    await page.keyboard.press('Escape');await page.locator('.settings-page').waitFor({state:'detached'});
  }
  assert.equal(report.errors.length,0,JSON.stringify(report.errors));report.checks.push('no renderer errors');
  report.framing='background renderer screenshot, opaque fallback frame; native Mica not visually accepted';
  await fs.writeFile(path.join(captures,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({checks:report.checks,captures:report.views.length,run}));
} catch(error) {
  if(page){await page.screenshot({path:path.join(captures,'failure.png')}).catch(()=>{});console.log((await page.locator('body').innerText().catch(()=>'' )).slice(-4500));}
  throw error;
} finally {
  const proc=app.process();
  await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
  await Promise.race([app.close().catch(()=>{}),new Promise(resolve=>setTimeout(resolve,5000))]);
  if(proc.exitCode===null&&proc.pid){try{execFileSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore'});}catch{}}
}
