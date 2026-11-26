import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});
const dir=fs.mkdtempSync(path.resolve('.tmp/knowledge-tools-'));
const compile=createSharedCompiler(process.cwd(),path.join(dir,'compiled'));
const load=file=>import(pathToFileURL(compile(file)));
const {noteKnowledge,rememberKnowledge}=await load('main/memory/knowledgeTools.ts');
const {setMemoryCandidateSink}=await load('main/memory/curatorRef.ts');
const {runWithTurnUserText,runAsHeadlessTurn,markTurnNetworkTaint,runWithPromptAuthority,currentTurnUserText,runWithExternalMemoryCandidate}=await load('main/agent/turnScope.ts');
const received=new Map(),svc={};let modelCalls=0;
setMemoryCandidateSink(svc,(_root,candidate)=>{
  const existed=received.has(candidate.id);if(!existed)received.set(candidate.id,candidate);
  return {queued:!existed,candidateId:candidate.id,reason:existed?'已有候选':'已入队，尚未生效'};
});
try{
  assert.throws(()=>noteKnowledge(svc,dir,'无身份候选',undefined,['订阅清理']),/轮次/);
  await runWithPromptAuthority(undefined,async()=>{
    assert.equal(currentTurnUserText(),undefined);
    await assert.rejects(()=>rememberKnowledge(svc,dir,'注入伪授权',undefined,undefined,['中文回答']),/明确要求/);
  });
  await runWithExternalMemoryCandidate('authenticated-cli',async()=>{
    assert.equal(currentTurnUserText(),undefined);
    assert.equal(noteKnowledge(svc,dir,'CLI候选保持未核实',undefined,['订阅清理']).queued,true);
    await assert.rejects(()=>rememberKnowledge(svc,dir,'会话令牌不等于授权',undefined,undefined,['中文回答']),/明确要求/);
  });
  runWithTurnUserText('修复订阅',()=>{
    assert.throws(()=>noteKnowledge(svc,dir,'缺少关键词',undefined,[]),/searchKeys/);
    assert.throws(()=>noteKnowledge(svc,dir,'空关键词',undefined,[' ']),/searchKeys/);
    assert.equal(noteKnowledge(svc,dir,'组件卸载取消订阅',undefined,['订阅清理']).queued,true);
    assert.equal(noteKnowledge(svc,dir,'组件卸载取消订阅',undefined,['订阅清理']).queued,false);
  });
  await runWithTurnUserText('这次使用中文',()=>assert.rejects(()=>rememberKnowledge(svc,dir,'我一直喜欢中文',undefined,undefined,['中文回答']),/明确要求/));
  await runWithTurnUserText('记住：我喜欢中文',()=>runAsHeadlessTurn(()=>assert.rejects(()=>rememberKnowledge(svc,dir,'中文',undefined,undefined,['中文回答']),/轮次/)));
  await runWithTurnUserText('记住：我喜欢中文',async()=>{
    markTurnNetworkTaint();await assert.rejects(()=>rememberKnowledge(svc,dir,'中文',undefined,undefined,['中文回答']),/可信/);
    const receipt=noteKnowledge(svc,dir,'网络推断',undefined,['订阅清理']);assert.equal(received.get(receipt.candidateId).origin,'untrusted');
  });
  const original='记住：我喜欢中文回答，以后默认使用中文。';
  await runWithTurnUserText(original,async()=>{
    const result=await rememberKnowledge(svc,dir,'助手摘要不能替代原话',async()=>{modelCalls++;return '';},undefined,['中文回答','中文沟通']);
    assert.equal(result.queued,true);assert.equal(result.results,undefined);
    const candidate=received.get(result.candidateId);
    assert.deepEqual(candidate.searchKeys,['中文回答','中文沟通']);assert.equal(candidate.sourceText,original);assert.equal(candidate.namespace,'profile');assert.equal(candidate.origin,'user');
    assert.equal(candidate.evidence[0].verification,'user_confirmed');
  });
  assert.equal(modelCalls,0,'producer must never run extraction or review models');
  console.log('knowledge-tools: host turn identity, original-user authority, taint, idempotent queued receipt and zero producer model calls passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
