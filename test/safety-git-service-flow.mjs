import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { simpleGit } from 'simple-git';
import ts from 'typescript';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-git-flow-'));
const compile = createSharedCompiler(process.cwd(),path.join(directory,'compiled'));
const { __setPiSdkForTests } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/piSdk.ts')));
const { createSafetyPiReviewer } = await import(pathToFileURL(compile('main/safety/pi.ts')));
const { createSafetyService } = await import(pathToFileURL(compile('main/safety/service.ts')));
const { createSafetyGitEvidenceCollector } = await import(pathToFileURL(compile('main/safety/evidence.ts')));
const pi = await import('@earendil-works/pi-coding-agent'); __setPiSdkForTests(pi);
let service, reviewer, collector, step = 0, offset = 0;
const bodies = [];
const findPayload = value => {
  if (typeof value === 'string') { try { return findPayload(JSON.parse(value)); } catch { return undefined; } }
  if (!value || typeof value !== 'object') return undefined;
  if (value.turnSource === 'system_approval' && value.gitEvidence) return value;
  return Object.values(value).map(findPayload).find(Boolean);
};
const server = http.createServer(async (req,res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
  const payload=findPayload(body); assert.ok(payload,'the real service must supply a bound Git summary');
  assert.equal(JSON.stringify(body).includes('fixture-api-secret'),false);
  const index=step++;
  const args=index===0 ? {requestId:payload.requestId,action:'files',repositoryId:'repo-0',part:'diff'}
    : index===1 ? {requestId:payload.requestId,action:'read',repositoryId:'repo-0',part:'diff',fileId:0,offset}
    : {requestId:payload.requestId,fingerprint:payload.fingerprint,generation:payload.generation,verdict:'allow',reason:'fixture inspected selected code'};
  res.writeHead(200,{'content-type':'text/event-stream'});
  const write=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  write({role:'assistant',content:''});
  if(index<3){write({tool_calls:[{index:0,id:`call-${index}`,type:'function',function:{name:index<2?'safety_evidence':'safety_decide',arguments:JSON.stringify(args)}}]});write({},'tool_calls');}
  else {write({content:'Done'});write({},'stop');}
  res.end('data: [DONE]\n\n');
});
try {
  const repo=path.join(directory,'repo'); fs.mkdirSync(repo);
  const git=(...args)=>execFileSync('git',args,{cwd:repo,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-q','-b','main'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(repo,'code.txt'),'base\n'); git('add','.'); git('commit','-qm','base'); git('checkout','-qb','feature');
  fs.writeFileSync(path.join(repo,'code.txt'),`${'synthetic code line\n'.repeat(3000)}END-OF-REAL-GIT-DIFF fixture-api-secret\n`);
  git('commit','-qam','feature');
  const src=ts.createSourceFile('service.ts',fs.readFileSync('src/main/git/service.ts','utf8'),ts.ScriptTarget.Latest,true);
  const cls=src.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='GitService');
  const method=cls.members.find(n=>n.name?.getText(src)==='approvalEvidence').getText(src);
  const code=ts.transpileModule(`class Probe { ${method} }; exports.Probe=Probe;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={}; new Function('exports','fs','path','createHash',code)(exports,fsp,path,createHash);
  const probe=new exports.Probe();probe.assertAllowed=async()=>repo;probe.client=()=>simpleGit(repo);
  probe.status=async()=>{const s=await simpleGit(repo).status();return {branch:s.current,files:s.files};};
  let captured;const evidence=await probe.approvalEvidence(repo,'main','feature',value=>{captured=value;});
  assert.ok(captured.diff.length>48000);assert.equal(evidence.diff.truncated,true);
  offset=captured.diff.indexOf('END-OF-REAL-GIT-DIFF')-400;assert.ok(offset>48000);
  collector=createSafetyGitEvidenceCollector();collector.capture('session',repo,captured);
  const source=collector.finish(JSON.stringify({sessions:[{session:{id:'session',name:'Fixture'},repositories:[evidence]}]}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={llm:{activeProviderId:'fixture',activeModelId:'fixture',providers:[{id:'fixture',name:'fixture',api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'fixture-api-secret',models:[{id:'fixture',contextWindow:32000}]}]}};
  reviewer=createSafetyPiReviewer({config:()=>config,directory});
  let humanCalls=0;
  service=createSafetyService({userDataPath:directory,reviewer,humanConfirm:async()=>{humanCalls++;return false;}});
  const decision=await service.authorize({workspaceId:'ws',source:'catalog',action:'sessions.integrateWorktree',args:{sessionId:'session'},gitEvidence:source});
  assert.equal(decision.allowed,true);assert.equal(humanCalls,0);
  assert.equal(service.snapshot('ws').records[0].status,'allowed');
  assert.equal(JSON.stringify(bodies[0]).includes('END-OF-REAL-GIT-DIFF'),false,'initial request contains no code body');
  assert.match(JSON.stringify(bodies[2]),/END-OF-REAL-GIT-DIFF/,'the model can request diff content beyond the old preview');
  const snapshot = service.snapshot('ws');
  const evidenceTool = snapshot.messages.flatMap(message => message.parts ?? [])
    .find(part => part.kind === 'tool' && part.tool.name === 'safety_evidence');
  assert.equal(evidenceTool?.tool.status, 'ok', 'the transcript still records the evidence call outcome');
  assert.equal(evidenceTool?.tool.output, undefined, 'the evidence tool body stays request-scoped');
  assert.doesNotMatch(JSON.stringify(snapshot), /END-OF-REAL-GIT-DIFF/);
  const auditRoot = path.join(directory, 'safety');
  const [workspace] = fs.readdirSync(auditRoot);
  assert.doesNotMatch(fs.readFileSync(path.join(auditRoot, workspace, 'conversation.json'), 'utf8'), /END-OF-REAL-GIT-DIFF/);
  console.log('real Git to safety service and SDK evidence-tool flow passed');
} finally {
  service?.dispose();reviewer?.dispose?.();collector?.clear();__setPiSdkForTests(null);
  if(server.listening) await new Promise(resolve=>server.close(resolve));
  fs.rmSync(directory,{recursive:true,force:true});
}
