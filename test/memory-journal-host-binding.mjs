import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'journal-host-binding-'));
try {
  const executor=fs.readFileSync('src/main/capabilities/executor.ts','utf8');
  const otherHosts=new Map([...executor.matchAll(/import \{([^}]+)\} from '\.\/hosts\/([^']+)'/g)]
    .filter(match=>match[2]!=='memory').map(match=>[match[2],match[1].split(',').map(s=>s.trim())]));
  const bundle=path.join(temp,'api.cjs');
  await build({stdin:{contents:`
    export {buildCatalogHostTools} from './src/main/agentSession/tools/catalogHostTools';
    export {executeTool} from './src/main/capabilities/executor';
    export {runAsAgentWorkspace,runAsSchedulerTool} from './src/main/agent/agentScope';
    export {setMemoryService} from './src/main/memory/serviceRef';
    export {readJournalDay,hasJournalForActor} from './src/main/memory/journal';
  `,resolveDir:process.cwd()},outfile:bundle,bundle:true,platform:'node',format:'cjs',packages:'external',plugins:[{
    name:'unrelated-services',setup(b){
      b.onResolve({filter:/^\.\/hosts\//},args=>{
        const name=args.path.slice('./hosts/'.length);
        if(args.importer.endsWith('executor.ts')&&otherHosts.has(name))return {path:name,namespace:'unused-host'};
      });
      b.onLoad({filter:/.*/,namespace:'unused-host'},args=>({contents:otherHosts.get(args.path).map(name=>`export const ${name}={};`).join('\n'),loader:'js'}));
      const stubs={
        'memory/curatorBindings':'export function bindMemoryCurator() {} export function memoryCurator(){throw Error("unused")}',
        'memory/knowledgeTools':'export function noteKnowledge(){throw Error("unused")} export function rememberKnowledge(){throw Error("unused")} export function correctKnowledge(){throw Error("unused")}',
        'git/identity':'export async function readGitIdentity(){return null}',
        'browser/turnShotCapture':'export function recordBrowserToolUse(){}',
        'safety/bindings':'export function authorizeSafetyOperation(){throw Error("unused")}',
        'extensions/safetyEvidence':'export function extensionSafetyEvidence(){throw Error("unused")}'
      };
      b.onResolve({filter:/memory\/curatorBindings$|memory\/knowledgeTools$|git\/identity$|browser\/turnShotCapture$|safety\/bindings$|extensions\/safetyEvidence$/},args=>{
        const key=Object.keys(stubs).find(key=>args.path.endsWith(key));return {path:key,namespace:'fixture'};
      });
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'js'}));
    }
  }]});
  const api=createRequire(import.meta.url)(bundle);
  const roots={one:path.join(temp,'one'),two:path.join(temp,'two')};
  const sessions={a:{id:'a',workspaceId:'one',cwd:roots.one},b:{id:'b',workspaceId:'two',cwd:roots.two},orphan:{id:'orphan'}};
  const ctx={sessions:{get:id=>sessions[id]},config:{get:()=>({activeWorkspaceId:'two',workspaces:Object.entries(roots).map(([id,root])=>({id,path:root}))})}};
  api.setMemoryService({});
  const tools=api.buildCatalogHostTools(ctx),journal=tools.find(tool=>tool.id==='memory.journal');
  const input={topic:'身份回归',status:'已完成',problem:'GUI未绑定workspace ALS',points:['使用会话所属工作区']};
  const call=(id,args=input)=>journal.execute(args,{sessionId:id}).then(JSON.parse);
  // Actual GUI adapter -> actor binding -> executor session ALS -> host -> SQLite/Markdown.
  // No workspace ALS: this is the user-reported production path.
  const a=await call('a',{...input,workspaceId:'two',__actorSessionId:'b'});
  assert.equal(a.ok,true,JSON.stringify(a));assert.equal(a.result.saved,true);
  assert.equal(api.hasJournalForActor(roots.one,'a'),true);
  assert.equal(fs.existsSync(roots.two),false,'active UI workspace and forged arguments cannot redirect the write');
  assert.match(api.readJournalDay(roots.one,a.result.day).content,/身份回归/);
  const retry=await call('a');assert.equal(retry.result.entryId,a.result.entryId);
  const [same,other]=await Promise.all([
    api.runAsAgentWorkspace('two',()=>call('a')),
    call('b',{...input,topic:'另一区域'})
  ]);
  assert.equal(same.result.entryId,a.result.entryId,'session wins over stale workspace ALS');
  assert.equal(other.ok,true);assert.equal(api.hasJournalForActor(roots.two,'b'),true);
  const search=tools.find(tool=>tool.id==='memory.search');
  const recalled=JSON.parse(await search.execute({query:'身份回归',mode:'journal',workspaceId:'two'},{sessionId:'a'}));
  assert.equal(recalled.ok,true);assert.equal(recalled.result.hits.length,1);
  for(const id of ['missing','orphan'])assert.equal((await call(id)).ok,false,'invalid actors fail closed');
  assert.equal((await call('b',{...input,entryId:a.result.entryId,revision:1})).ok,false,'other workspace cannot edit this entry');
  assert.equal((await call('a',{...input,points:{text:'wrong'}})).ok,false,'object points do not save');
  assert.equal((await call('a',{...input,points:[{text:'wrong'}]})).ok,false,'points must be strings');
  assert.equal((await api.executeTool(ctx,'memory.journal',JSON.stringify({...input,workspaceId:'one'}))).ok,false,'model workspace alone is not identity');
  const scheduled=await api.runAsAgentWorkspace('one',()=>api.runAsSchedulerTool(()=>api.executeTool(ctx,'memory.journal',JSON.stringify({...input,topic:'调度记录'}))));
  assert.equal(scheduled.ok,true);assert.equal(api.hasJournalForActor(roots.one,'scheduler:one'),true);
  console.log('memory-journal-host-binding: GUI adapter/executor writes and recalls; scope isolation, scheduler, malformed points passed');
} finally {
  assert.equal(path.dirname(path.resolve(temp)),scratch);
  assert.ok(path.basename(temp).startsWith('journal-host-binding-'));
  fs.rmSync(temp,{recursive:true,force:true});
}
