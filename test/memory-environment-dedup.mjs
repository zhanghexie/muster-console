import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';

const scratch=path.resolve('.tmp');fs.mkdirSync(scratch,{recursive:true});
const temp=fs.mkdtempSync(path.join(scratch,'memory-environment-dedup-'));
const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
const load=file=>import(pathToFileURL(compile(file)));
const {setMemoryEnvironmentProvider,captureMemoryEnvironment,checkMemoryEnvironment}=await load('main/memory/environment.ts');
const {KnowledgeStore}=await load('main/memory/knowledgeStore.ts');
const {compactKnowledge,boundedTextPage}=await load('main/memory/readProjection.ts');
const {formatKnowledgeHits}=await load('main/memory/knowledgeRecall.ts');
const {prepareRecall,finishRecall,piRecallEpoch}=await load('main/memory/recallDedup.ts');
let store;
try {
  let limits={appVersion:'1.0',executorResultMaxChars:'12000'};
  setMemoryEnvironmentProvider(()=>limits);
  const captured=captureMemoryEnvironment(['executorResultMaxChars','appVersion']);
  assert.deepEqual(captured,[{key:'appVersion',value:'1.0'},{key:'executorResultMaxChars',value:'12000'}]);
  assert.throws(()=>captureMemoryEnvironment(['invented']),/未知环境依赖/);
  assert.throws(()=>captureMemoryEnvironment(['mcpHubMaxChars']),/不可用/);
  store=new KnowledgeStore(path.join(temp,'knowledge'));
  const source='真实工具结果显示输出预算会限制执行器返回的完整内容。';
  const lesson={kind:'reusable_lesson',summary:'查询时注意执行器输出预算',problem:'长结果被整体省略',action:'分页检索',rationale:'工具返回观察',applicability:['执行器'],exceptions:[],expectedFutureUse:'避免结果过大',environment:[{key:'appVersion',value:'forged'}]};
  const context={namespace:'worker',origin:'worker',sourceText:source,evidence:[{id:'observation',source:'tool',eventTime:1,verification:'unverified'}],environment:captured};
  const receipt=store.commitCuratorDecision({operationId:'op',candidateId:'c',policyVersion:'p',decision:'save',draft:lesson,sourceQuote:source,reason:'核对结果',deletionComparisons:[]},context);
  assert.deepEqual(receipt.record.environment,captured,'only host-captured values are stored, never model-provided values');
  assert.equal(checkMemoryEnvironment(receipt.record).state,'current');
  limits={appVersion:'2.0',executorResultMaxChars:'12000'};
  assert.equal(compactKnowledge(receipt.record).environmentCheck.state,'stale');
  assert.deepEqual(compactKnowledge(receipt.record).environmentCheck.dependencies[0],{key:'appVersion',recorded:'1.0',current:'2.0'});
  const recalled=formatKnowledgeHits([{record:receipt.record,applicability:'needs_check'}]);
  assert.match(recalled,/环境参数可能已变化/);assert.match(recalled,/执行器/);assert.doesNotMatch(recalled,/分页检索/,'automatic recall leaves details for memory.get');
  assert.equal(JSON.parse(boundedTextPage(receipt.record,'details',0,5000).text).environmentCheck.state,'stale');
  limits={};assert.equal(checkMemoryEnvironment(receipt.record).state,'unknown');
  assert.equal(checkMemoryEnvironment({...receipt.record,environment:undefined,summary:'MCP_CALL_RESULT_MAX_CHARS=11500'}).state,'untracked');
  assert.equal(checkMemoryEnvironment({...receipt.record,environment:undefined,summary:'查询经验',applicability:['executor 12000']} ).state,'untracked','legacy numeric parameters in conditions also require verification');
  const core=store.submit({kind:'stable_constraint',summary:'核对当前输出预算',applicability:[],environment:captured},
    {namespace:'worker',origin:'user',explicit:true,evidence:[{id:'user',source:'user',eventTime:1,verification:'user_confirmed'}]}).record;
  assert.equal(store.core('worker'),'','unavailable environment cannot enter core as an unconditional rule');
  limits={appVersion:'1.0',executorResultMaxChars:'12000'};assert.match(store.core('worker'),/核对当前输出预算/);
  assert.equal(core.status,'active','staleness is a read-time warning, not destructive mutation');

  const owner={},connection={},text='### 相关记忆参考\n核对适用条件。\n- [abc r1] 记忆结论\n  适用：条件 A；例外：情况 B\n  依据：未经独立验证';
  assert.equal(prepareRecall(owner,connection,'epoch1','turn1',text),text);
  finishRecall(owner,connection,'epoch1','turn1',true);
  const short=prepareRecall(owner,connection,'epoch1','turn2',text);
  assert.match(short,/上一轮已提供/);assert.match(short,/依据：未经独立验证/);assert.doesNotMatch(short,/条件 A/);
  finishRecall(owner,connection,'epoch1','turn2',false);
  assert.equal(prepareRecall(owner,connection,'epoch1','turn3',text),text,'failed delivery cannot suppress the next turn');
  finishRecall(owner,connection,'epoch1','turn3',true);
  assert.equal(prepareRecall(owner,connection,'epoch2','turn4',text),text,'compaction invalidates previous context');
  finishRecall(owner,connection,'epoch2','turn4',true);
  assert.equal(prepareRecall(owner,connection,'epoch2','turn5',text.replace('条件 A','新条件')),text.replace('条件 A','新条件'),'changed boundaries are sent in full');
  finishRecall(owner,connection,'epoch2','turn5',true);
  assert.equal(prepareRecall(owner,{},'epoch2','turn6',text),text,'a rebuilt connection starts a fresh context');
  const entries=[];const session={sessionManager:{getEntries:()=>entries}};
  assert.equal(piRecallEpoch(session),'[]');entries.push({type:'compaction',id:'x'});assert.equal(piRecallEpoch(session),'["x"]');
  assert.equal(piRecallEpoch({}),undefined,'an unknown compaction state disables shortening');
  console.log('memory-environment-dedup: host-bound values, stale warnings, protected core and confirmed-context recall passed');
} finally {
  setMemoryEnvironmentProvider(undefined);store?.close();
  assert.equal(path.dirname(path.resolve(temp)),scratch);fs.rmSync(temp,{recursive:true,force:true});
}
