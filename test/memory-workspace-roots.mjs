import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(project, '.tmp'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(project, '.tmp', 'memory-workspace-roots-'));
const compile = createSharedCompiler(project, fixture);
const load = file => import(pathToFileURL(compile(file)).href);
const stub = (file, source) => fs.writeFileSync(compile(file), source);
try {
  // Compile production entrypoints first; replace only collaborators which would
  // start the app or write a database. Workspace resolution remains the real code.
  compile('main/memory/runtime.ts');
  stub('main/config.ts', 'export function resolveLlmConfigWithReload() { return {resolved:{provider:{api:"openai-responses"},openai:{baseUrl:"https://fixture.invalid",apiKey:"fixture"},model:{id:"fixture"}}}; }');
  const runtime = await load('main/memory/runtime.ts');
  const { resolveMemoryWorkspaceRoot } = runtime;
  const workspace = { id: 'ws', name: 'multi', path: 'E:/source-b', controlRoot: 'D:/control-a',
    roots: [{ id: 'a', path: 'D:/control-a' }, { id: 'b', path: 'E:/source-b' }], defaultRootId: 'b' };
  const ctx = overrides => ({ config: { get: () => ({ activeWorkspaceId: 'ws', workspace: 'E:/source-b', workspaces: [{ ...workspace, ...overrides }] }) } });
  assert.equal(resolveMemoryWorkspaceRoot(ctx()), 'D:/control-a');
  assert.equal(resolveMemoryWorkspaceRoot(ctx({ path: 'F:/source-c' }), 'ws'), 'D:/control-a');
  assert.equal(resolveMemoryWorkspaceRoot(ctx(), 'ws', ' G:/explicit '), 'G:/explicit');
  for (const id of ['missing', ' ']) assert.equal(resolveMemoryWorkspaceRoot(ctx(), id), null);
  assert.equal(resolveMemoryWorkspaceRoot(ctx({ rootsError: 'bad' }), 'ws'), null);
  assert.equal(resolveMemoryWorkspaceRoot(ctx({ controlRoot: undefined, roots: undefined }), 'ws'), 'E:/source-b');

  compile('main/capabilities/hosts/memory.ts'); compile('main/capabilities/hosts/intents.ts');
  stub('main/memory/curatorBindings.ts','export function bindMemoryCurator() {} export function memoryCurator(){throw Error("unused")}');
  stub('main/memory/knowledgeTools.ts', 'export function correctKnowledge(){throw Error("unused")} export function noteKnowledge(svc,root,text,scope,keys) { globalThis.memoryRootFixture.calls.push(["note",root,scope,keys]); return {queued:false}; } export function rememberKnowledge(svc,root,text,call,scope,keys) { globalThis.memoryRootFixture.calls.push(["remember",root,scope,keys]); return {results:[]}; }');
  stub('main/git/identity.ts', 'export async function readGitIdentity(root) { return {root,branch:"main"}; }');
  stub('main/memory/intentTool.ts', 'export function runIntentTool(db, args) { globalThis.memoryRootFixture.calls.push(["intent", db.root, args]); }');
  stub('main/agent/agentScope.ts', 'export function currentAgentSessionId(){return undefined;} export function isSchedulerInvocation() { return true; } export function currentAgentWorkspaceId(){return globalThis.memoryRootFixture.workspaceId;}');
  const calls = [];
  globalThis.memoryRootFixture = { calls, workspaceId:'ws', service: { queryKnowledge: async (root,query) => { calls.push(['search', root,query]); return []; },knowledge:root=>({integrityIssues:()=>[],policyAllows:()=>true,list:()=>{calls.push(['list',root]);return {records:[]};}}),
    init: root => ({ root }) } };
  runtime.setMemoryService(globalThis.memoryRootFixture.service);
  const { memoryHost } = await load('main/capabilities/hosts/memory.ts');
  const { intentsHost } = await load('main/capabilities/hosts/intents.ts');
  await memoryHost['memory.search'](ctx(), { query: 'test' });
  await memoryHost['memory.list'](ctx(), {});
  await memoryHost['memory.note'](ctx(), { text: 'note', searchKeys: ['note'] });
  await memoryHost['memory.remember'](ctx(), { text: 'remember', searchKeys: ['remember'] });
  intentsHost.intent(ctx(), { action: 'list' });
  assert.deepEqual(calls.map(([kind, root]) => [kind, root]),
    ['search', 'search', 'search', 'list', 'list', 'list', 'note', 'remember', 'intent'].map(kind => [kind, 'D:/control-a']));
  assert.equal(calls.find(c=>c[0]==='search')[2].repoKey,'E:/source-b');
  assert.equal(calls.find(c=>c[0]==='note')[2].repoKey,'E:/source-b');
  assert.deepEqual(calls.find(c=>c[0]==='note')[3],['note']);
  assert.deepEqual(calls.find(c=>c[0]==='remember')[3],['remember']);
  const {knowledgeRepoKey}=await load('main/memory/knowledgePolicy.ts');
  const record={id:'historical',namespace:'scheduler',revision:1,kind:'stable_constraint',status:'active',summary:'分支记录',applicability:[],evidence:[],repoKey:knowledgeRepoKey('E:/source-b'),branch:'feature/a'};
  globalThis.memoryRootFixture.service.queryKnowledge=async(_root,query)=>query.namespace==='scheduler'?[{record,reason:'fixture'}]:[];
  globalThis.memoryRootFixture.service.knowledge=()=>({integrityIssues:()=>[],policyAllows:()=>true,list:()=>({records:[record]})});
  const searched=await memoryHost['memory.search'](ctx(),{query:'记录'});
  assert.equal(searched.hits[0].branch,'feature/a');
  assert.match(searched.hits[0].branchNotice,/记录于 feature\/a 分支，当前为 main 分支/);
  const listed=await memoryHost['memory.list'](ctx(),{});
  assert.match(listed.entries[0].branchNotice,/记录于 feature\/a 分支，当前为 main 分支/);
  const long={...record,id:'long',summary:'长证据',updatedAt:2,evidence:Array.from({length:7},(_,i)=>({id:`e${i}`,source:'tool',eventTime:1,verification:'unverified',excerpt:'证据"\\\n'.repeat(350)}))};
  const profile={...long,id:'profile',namespace:'profile',repoKey:undefined,branch:undefined,summary:'个人偏好',updatedAt:3};
  const scheduler={...long,id:'private-scheduler',namespace:'scheduler',repoKey:knowledgeRepoKey('E:/source-b'),updatedAt:4};
  const rows={worker:[long],scheduler:[scheduler],profile:[profile]};
  globalThis.memoryRootFixture.service.queryKnowledge=async(_root,query)=>(rows[query.namespace]??[]).map(record=>({record,reason:'fixture'}));
  globalThis.memoryRootFixture.service.knowledge=(_root,ns)=>({integrityIssues:()=>[],policyAllows:()=>true,list:()=>({records:rows[ns]??[]})});
  const compact=await memoryHost['memory.search'](ctx(),{query:'证据'});
  assert.ok(JSON.stringify({ok:true,result:compact}).length<12000,'long evidence never overflows the executor envelope');
  assert.equal(compact.hits.length,2);assert.equal(compact.hits[0].evidence.count,7);
  assert.equal(compact.hits[0].evidence[0],undefined,'search returns evidence summary, not raw excerpts');
  const escaped={...scheduler,id:'escaped',summary:'\u0001'.repeat(500),branch:'\u0002'.repeat(300),applicability:['\u0003'.repeat(300),'\u0004'.repeat(300)],
    exceptions:['\u0005'.repeat(300),'\u0006'.repeat(300)],evidence:Array.from({length:8},(_,i)=>({id:`escaped-${i}`,source:'\u0007'.repeat(1000),eventTime:1,verification:'unverified'}))};
  globalThis.memoryRootFixture.service.queryKnowledge=async(_root,query)=>query.namespace==='scheduler'?[{record:escaped,reason:'fixture'}]:[];
  const tiny=await memoryHost['memory.search'](ctx(),{query:'escaped'});
  assert.equal(tiny.hits[0].id,'escaped');assert.equal(tiny.hits[0].conditionsTruncated,true);
  assert.ok(JSON.stringify({ok:true,result:tiny}).length<12000,'escape-heavy metadata still produces a usable bounded hit');
  globalThis.memoryRootFixture.service.queryKnowledge=async(_root,query)=>(rows[query.namespace]??[]).map(record=>({record,reason:'fixture'}));
  const page=await memoryHost['memory.list'](ctx(),{limit:1});
  assert.deepEqual(page.scope,['scheduler','profile','host']);assert.equal(page.total,2);assert.equal(page.nextOffset,1);
  const nextPage=await memoryHost['memory.list'](ctx(),{limit:1,offset:page.nextOffset});
  assert.notEqual(page.entries[0].id,nextPage.entries[0].id);
  let position=0,joined='';
  do {const part=await memoryHost['memory.get'](ctx(),{id:'profile',namespace:'profile',revision:1,section:'evidence',offset:position,maxChars:5000});
    assert.ok(JSON.stringify({ok:true,result:part}).length<12000);joined+=part.text;position=part.nextOffset;
  } while(position!==null);
  assert.deepEqual(JSON.parse(joined),profile.evidence,'exact evidence is reconstructable across bounded pages');
  await assert.rejects(()=>memoryHost['memory.get'](ctx(),{id:'profile',revision:99}),/版本已变化/);
  await assert.rejects(()=>memoryHost['memory.get'](ctx(),{id:'profile',section:'evidence',offset:10}),/必须指定.*revision/,'continuations must pin a revision');
  await assert.rejects(()=>memoryHost['memory.get'](ctx(),{id:'long',namespace:'worker'}),/不可见/);
  const crowded=Object.fromEntries(['scheduler','profile','host'].map(namespace=>[namespace,Array.from({length:25},(_,i)=>({record:{...profile,id:`${namespace}-${i}`,namespace},reason:'fixture'}))]));
  globalThis.memoryRootFixture.service.queryKnowledge=async(_root,query)=>crowded[query.namespace]??[];
  let cursor=0;const ids=[];
  do{const result=await memoryHost['memory.search'](ctx(),{query:'证据',limit:10,offset:cursor});
    assert.ok(result.queryLimitReached);ids.push(...result.hits.map(hit=>hit.id));cursor=result.nextOffset;
  }while(cursor!==null);
  assert.equal(ids.length,60,'each scope is capped at the addressable 20-result search window');assert.equal(new Set(ids).size,60);
  globalThis.memoryRootFixture.service.knowledge=()=>({integrityIssues:()=>[{id:record.id,reason:'missing'}],policyAllows:()=>false,list:()=>({records:[record]})});
  const degraded=await memoryHost['memory.list'](ctx(),{});
  assert.equal(degraded.entries.length,0);assert.equal(degraded.integrityIssues[0].id,record.id);
  await memoryHost['memory.list'](ctx(),{workspaceId:'forged'}); // Caller arguments cannot override host identity.
  globalThis.memoryRootFixture.workspaceId='missing';await assert.rejects(()=>memoryHost['memory.list'](ctx(),{}),/workspace/);
  globalThis.memoryRootFixture.workspaceId=undefined;await assert.rejects(()=>memoryHost['memory.list'](ctx(),{}),/宿主绑定/);
  console.log('ok: memory runtime/tool routes preserve control root and reject unknown workspace');
} finally {
  delete globalThis.memoryRootFixture;
  fs.rmSync(fixture, { recursive: true, force: true });
}
