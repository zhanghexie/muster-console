import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root=process.cwd(), tmp=fs.mkdtempSync(path.join(os.tmpdir(),'host-tools-retirement-'));
const compile=createSharedCompiler(root,tmp), load=p=>import(pathToFileURL(compile(p)).href);
try {
  // The current delegation module imports Electron's app at module load time;
  // this Node-only contract test exercises argument validation, not Electron.
  const electronStub=path.join(tmp,'node_modules','electron');fs.mkdirSync(electronStub,{recursive:true});
  fs.writeFileSync(path.join(electronStub,'package.json'),JSON.stringify({type:'module',exports:'./index.mjs'}));
  fs.writeFileSync(path.join(electronStub,'index.mjs'),"export const app={getPath:()=>''}; export const shell={}; export const webContents={}; export const dialog={}; export const ipcMain={}; export const BrowserWindow={}; export const safeStorage={}; export const net={}; export const nativeTheme={}; export const protocol={}; export const session={}; export const Notification={}; export const powerMonitor={}; export const powerSaveBlocker={};");
  const {TOOL_DEFS}=await load('main/capabilities/catalog/registry.ts');
  const {residentHostToolIds}=await load('shared/toolDiscovery.ts');
  const {listHostToolIds}=await load('shared/hostTools/index.ts');
  const {inboundMcpToolDefs}=await load('main/inboundMcp/toolList.ts');
  const {projectHostToolRoster}=await load('shared/hostToolProjection.ts');
  const resident=new Set(residentHostToolIds('worker'));
  // Worker 常驻清单 × preset；记忆族新增 journal/correct/correctionStatus。
  // PTY 去记忆 remember/confirm、后台和 REPL；ACP 使用宿主记忆并保留智能界面差分。
  // 反馈历史读取与 AI 查重判断同样投影到每个 preset。
  for(const preset of ['gui-full', 'pty-allowlist', 'acp-subset']){
    const expected=new Set(listHostToolIds(preset).filter(id=>resident.has(id)));
    const exposed=inboundMcpToolDefs(preset);
    const projected=projectHostToolRoster([...expected,...(preset==='pty-allowlist'?['askQuestion']:[])]);
    assert.deepEqual(new Set(exposed.map(t=>t.name)),new Set(projected.map(t=>t.name.replaceAll('.','_'))),`${preset} 投影 = 清单 ∩ preset`);
    assert.ok(!exposed.some(t=>t.name==='tools_search'||t.name==='tools_call'),`${preset} 不再投影发现层代理`);
    assert.ok(exposed.some(t=>t.name==='host_browser_run'),`${preset} 投影 host.browser.run 单入口`);
    assert.ok(exposed.some(t=>t.name==='host_extensions_run'),`${preset} exposes extension authoring`);
  }
  assert.ok(resident.has('bgtasks.shell')&&resident.has('node_repl.js')&&resident.has('memory.remember'),'GUI 专属三族在清单内（preset 差分负责收窄）');
  assert.ok(!listHostToolIds('pty-allowlist').includes('node_repl.js')&&!listHostToolIds('pty-allowlist').includes('memory.remember'),'PTY preset 缺席项由 preset 求交剔除');
  assert.ok(listHostToolIds('acp-subset').includes('memory.search')&&!listHostToolIds('acp-subset').includes('ui.render'),'ACP 开放记忆并保留部件边界');
  const names=TOOL_DEFS.map(t=>t.name);
  assert.equal(new Set(names).size,names.length);
  // B1：静态定义 120→122（mcp.search / mcp.call 两中转工具入册）；R2：122→123（browser.run 入册）；
  // R3b：123→130（八域 run 入口入册 +8；extensions.run 同名原 def 被入口内化剥除 -1）；
  // R5：130→128（tools.search / tools.call 两条目随发现层退役出册）
  for (const name of ['feedback.history', 'feedback.propose', 'feedback.assess', 'extensions.run'])
    assert.ok(names.includes(name), `static catalog retains ${name}`);
  assert.deepEqual(names.filter(n=>n.startsWith('mcp.')), ['mcp.search','mcp.call']);
  assert.ok(!names.some(n=>/^(tasks\.|codeAnalysis\.|facts\.)/.test(n)));
  const retired = ['chat.injectBrief','sessions.requestCapability','sessions.list','sessions.get','sessions.find','sessions.close',
    'sessions.askScheduler','sessions.reportParent','sessions.reply','chat.tail','chat.renameSession','workers.status','share.list',
    'app.getToolHelp','app.getCapabilityCatalog','ui.select','ui.multiSelect','ui.menu','browser.help','browser.resetViewport','terminal.open','terminal.resize','terminal.getStatus'];
  const handlers = Object.assign({}, ...(await Promise.all(['sessions','chat','awareness','misc'].map(async file => {
    const module = await load(`main/capabilities/hosts/${file}.ts`);
    return Object.assign({}, ...Object.values(module).filter(value => value && typeof value === 'object'));
  }))));
  const { searchHostToolDirectory } = await load('main/capabilities/catalog.ts');
  const terminalSource = fs.readFileSync(path.join(root, 'src/main/capabilities/hosts/terminal.ts'), 'utf8');
  const browserSource = fs.readFileSync(path.join(root, 'src/main/capabilities/hosts/browser.ts'), 'utf8');
  for(const name of retired) {
    assert.ok(!names.includes(name), name + ' no catalog alias');
    assert.equal(handlers[name], undefined, name + ' no executable handler');
    assert.throws(() => searchHostToolDirectory(TOOL_DEFS, { name }), /available directory/);
    if (name.startsWith('terminal.')) assert.ok(!terminalSource.includes(`'${name}':`), name + ' no terminal handler');
    if (name.startsWith('browser.')) assert.ok(!browserSource.includes(`'${name}':`), name + ' no browser handler');
  }
  const create=TOOL_DEFS.find(t=>t.name==='sessions.create').parameters;
  for(const name of ['task','asSubagent','target','isolation','isolationGroups','rootId','cwd'])assert.ok(name in create.properties,name);
  // 配置面已收归引用：create 不再接受任何内联模型/权限/启动覆盖。
  for(const name of ['model','thinking','modelParameters','nativeConfig','configurePermissions','guiMode','cliLaunchOptions','runtime','acpPresetId','piModeId'])assert.ok(!(name in create.properties),name+' must not be a create parameter');
  assert.equal(create.additionalProperties,false,'unknown create parameters must fail instead of being ignored');
  // 精确键集：将来新增任何不在禁用列表里的内联配置字段（例如 sandboxMode）也会被这条拦住。
  assert.deepEqual(Object.keys(create.properties).sort(),
    ['asSubagent','cwd','force','inherit','isolation','isolationGroups','name','rootId','rootsRevision','select','target','task','workspaceId'],
    'sessions.create exposes exactly the task/location/routing surface');
  for(const name of ['trackTask','locks','agentTaskId','parentSessionId','repoSet','characterId','shellProfileId'])assert.ok(!(name in create.properties));
  for (const args of [{repoSet:[]}, {task:'work',repoSet:['plugin']}, {asSubagent:true,repoSet:[]}]) await assert.rejects(handlers['sessions.create']({}, args), /removed the top-level repoSet.*isolationGroups/, 'retired argument rejected before any resources are created');
  assert.ok(!create.required?.includes('task'));
  assert.match(TOOL_DEFS.find(t=>t.name==='sessions.readMessages').description,/batch unread bodies/);
  assert.doesNotMatch(TOOL_DEFS.find(t=>t.name==='sessions.observe').description,/chat.tail/);
  assert.equal(TOOL_DEFS.find(t=>t.name==='sessions.message').parameters.properties.interrupt.type,'boolean');
  const policyMatch = TOOL_DEFS.find(t=>t.name==='scheduler.policy.set').parameters.properties.rules.items.properties.match.description;
  for (const field of ['to', 'from', 'actorRole', 'builtinGate', 'taskId']) assert.ok(!policyMatch.split(/\s*\/\s*/).includes(field), 'no retired policy field: ' + field);
  assert.equal((await load('main/browser/browserHelp.ts')).browserToolHelp('browser.resetViewport'), undefined);
  const {buildHostIntro}=await load('shared/workerBrief.ts');
  const core=buildHostIntro();
  const { buildDefaultDispatcherAppendBody } = await load('main/agent/systemPrompt.ts');
  const prompt = buildDefaultDispatcherAppendBody();
  for (const name of retired.filter(name => !name.startsWith('ui.'))) assert.ok(!(core + prompt).includes(name), name + ' no prompt teaching');
  assert.match(prompt, /batch-returns unread bodies/);
  assert.ok(!/tasks\.(claim|update|delegate)|chat\.injectBrief|collab-tasks/.test(core));
  assert.doesNotMatch(core,/HOST(?:-EXT)?\.md|tools\.search/);
  console.log(`host-tools-simplification: OK (${names.length} static definitions, role residents, retired systems/parameters absent, creation/interrupt/protocol contracts)`);
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
