import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'launch-configuration-'));
try {
 const compile=createSharedCompiler(process.cwd(),tmp);
 const read=async name=>import(pathToFileURL(compile(name)).href);
 const {resolveLaunchConfiguration: resolve}=await read('shared/guiInheritMeta.ts');
 const chat=id=>['pi','cursor','codex-gui','claude','acp'].includes(id);
 const parent={runtime:'pi',modelOverride:{providerId:'p',modelId:'m'},thinkingLevel:'high',guiMode:'ask',modelParameters:{reasoning:'high'}};
 const run=(input={},p=parent)=>resolve(input,p,'pi',chat);
 // An omitted runtime must never silently inherit a CLI, even when it is the configured default.
 assert.equal(resolve({},undefined,'codex',chat).runtime,'pi');
 assert.equal(resolve({}, {runtime:'codex'}, 'codex',chat).runtime,'pi');
 assert.equal(resolve({}, {runtime:'codex'}, 'codex-gui',chat).runtime,'codex-gui');
 assert.equal(resolve({}, parent, 'codex',chat).runtime,'pi');
 assert.equal(resolve({runtime:'codex'},parent,'pi',chat).runtime,'codex');
 assert.equal(resolve({runtime:'codex-gui'},parent,'codex',chat).runtime,'codex-gui');
 assert.deepEqual(run().inheritMeta.modelParameters,parent.modelParameters);
 assert.equal(run().inheritMeta.thinkingLevel,undefined);
 assert.deepEqual(run({modelParameters:{}}).inheritMeta.modelParameters,{});
 assert.equal(run({thinking:'low'}).inheritMeta.thinkingLevel,'low');
 assert.equal(run({thinking:'low'}).inheritMeta.modelParameters,undefined);
 assert.equal(run({runtime:'codex-gui'}).inheritMeta?.modelParameters,undefined);
 assert.equal(run({runtime:'codex'}).inheritMeta,undefined);
 assert.equal(run({model:{providerId:'p',modelId:'other'}}).inheritMeta.modelParameters,undefined);
 for(const input of [{runtime:'codex',model:{providerId:'p',modelId:'m'}},{runtime:'cursor',thinking:'high'},
  {runtime:'codex',guiMode:'auto',configurePermissions:true},{runtime:'codex',modelParameters:{x:'v'}},{runtime:'cursor',piModeId:'x'},
  {thinking:'low',modelParameters:{}},{modelParameters:{x:1}},{model:{providerId:'p'}}]) assert.throws(()=>run(input));
 const { getToolDef }=await read('main/capabilities/catalog/api.ts');
 assert.equal(getToolDef('sessions.create').parameters.properties.shellProfileId,undefined);
 const shell=getToolDef('terminal.create');
 assert.deepEqual(shell.parameters.required,['shellProfileId']);
 for(const osShell of ['powershell','pwsh','cmd','git-bash','wsl','zsh','bash']) assert.ok(shell.parameters.properties.shellProfileId.enum.includes(osShell));
 for(const k of ['runtime','task','model','thinking','asSubagent','isolation']) assert.equal(shell.parameters.properties[k],undefined);
 const {residentHostToolIds}=await read('shared/toolDiscovery.ts');
 for(const role of ['worker','scheduler']) assert.ok(residentHostToolIds(role).includes('terminal.create'));
 const {validateLaunchParameters}=await read('main/agentSession/host/modelParameters.ts');
 const {t}=await read('shared/i18n/index.ts');
 let unavailable=false;
 const host={ctx:{config:{get:()=>({workspace:tmp})}},drivers:new Map([['pi',{
   describeModelParameters:async()=>{if(unavailable) throw new Error('discovery offline');return {runtimeId:'pi',providerId:'p',modelId:'m',parameters:[{id:'reasoning',semantic:'reasoning',label:'Thinking',apply:'next-turn',supportsDefault:true,options:[{value:'low',label:'Low'}]}]};}
 }]])};
 await validateLaunchParameters(host,{runtimeId:'pi'},{thinkingLevel:'low'});
 await validateLaunchParameters(host,{runtimeId:'pi'},{modelParameters:{reasoning:'low'}});
 await assert.rejects(()=>validateLaunchParameters(host,{runtimeId:'pi'},{thinkingLevel:'high'}),(e)=>e.message===t('模型不支持 thinking={{level}}',{level:'high'}));
 await assert.rejects(()=>validateLaunchParameters(host,{runtimeId:'pi'},{modelParameters:{unknown:'x'}}),/Unsupported/);
 unavailable=true;
 // discovery 不可用按「服务坏了」归类并内嵌原始原因，与「配置非法」区分
 await assert.rejects(()=>validateLaunchParameters(host,{runtimeId:'pi'},{modelParameters:{reasoning:'low'}}),(e)=>e.message===t('参数发现服务不可用（{{warning}}），请稍后重试',{warning:'discovery offline'}));
 console.log('launch-configuration: inheritance, runtime/model boundaries, explicit validation, shell separation passed');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
