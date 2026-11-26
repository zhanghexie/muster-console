/** Opt-in real Cursor ACP probe. It may use account quota; never runs in daily tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

if (process.env.MUSTER_TEST_REVIEW_CURSOR !== '1') {
  console.log('turn-changes-cursor-live: skipped (set MUSTER_TEST_REVIEW_CURSOR=1)');
  process.exit(0);
}
const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive:true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-cursor-live-'));
const work = path.join(tmp, 'work'); fs.mkdirSync(work);
const target = path.join(work, 'sample.txt'); fs.writeFileSync(target, 'before\n');
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { AcpRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/driver.ts')));
const { resolveAcpLaunch } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/agents.ts')));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const service = new TurnChangeService(path.join(tmp, 'store'));
const tracker = service.begin('gui:cursor', 'probe', work, [work]);
let conn;
try {
  const driver = new AcpRuntimeDriver({config:{get:()=>({})}}, {userDataDir:tmp}, {
    // Keep the real CLI inside its own sandbox; do not enable --force or --yolo.
    resolveLaunch: id => resolveAcpLaunch(id, {args:['--sandbox','enabled','acp']})
  });
  conn = await driver.connect({sessionId:'review-cursor-probe',cwd:work,acpAgent:'cursor',systemPromptAppend:'',
    mode:'default',planExecuting:false,permissionMode:'ask',modeController:{},hostTools:[],
    getTurnId:()=> 'probe-turn',getPolicyState:()=>({mode:'default',planExecuting:false}),
    requestApproval:async request => {
      const raw = request.input?.path ?? request.input?.file_path ?? request.input?.filePath ?? '';
      const resolved = typeof raw === 'string' ? path.resolve(work, raw) : '';
      console.log(`cursor approval: ${request.toolName}; isolated target=${resolved === target}`);
      return {approved:/edit|write/i.test(request.toolName) && resolved === target};
    },log:(_level,message)=>console.log(`cursor: ${String(message).slice(0,300)}`)});
  const events=[];
  let resolveDone; const done = new Promise(resolve=>{resolveDone=resolve;});
  const pump = (async()=>{for await (const event of conn.events) {
    events.push(event);
    if ((event.type==='tool-start'||event.type==='tool-update') && !event.reviewLate)
      void tracker.toolStart(event.toolCallId,event.toolName,event.input,event.toolKind);
    if (event.type==='tool-result') void tracker.toolEnd(event.toolCallId,event.ok,event.patch,false,event.reviewChanges);
    if (event.type==='review-warning') tracker.noteRootFailure(event.message);
    if (event.type==='turn-complete'||event.type==='error') {resolveDone(event); break;}
  }})();
  await conn.send('In this isolated test directory, use your native file editing tool to change sample.txt from "before" to "after". Edit only that file. Do not run a shell or access other paths.');
  let timer;
  const result = await Promise.race([done,new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error('Cursor ACP probe timed out')),90_000).unref(); })]).finally(()=>clearTimeout(timer));
  if (result.type==='error') throw new Error(result.message);
  if (fs.readFileSync(target,'utf8').trim() !== 'after') {
    console.log('cursor event types:', events.map(event => event.type === 'tool-start' || event.type === 'tool-result' ? `${event.type}:${event.toolName}` : event.type).join(', '));
    console.log('cursor response:', events.filter(event=>event.type==='text-delta').map(event=>event.delta).join('').slice(0,1000));
    throw new Error('real Cursor did not edit the isolated fixture');
  }
  const summary = await tracker.finish();
  assert(summary.files.some(file=>file.path==='sample.txt'),'real Cursor edit must appear in review');
  const diff = service.diff(summary.id,'gui:cursor','probe','sample.txt');
  assert.match(diff,/-before/); assert.match(diff,/\+after/);
  console.log(`turn-changes-cursor-live: real ACP edit captured (${summary.files[0].origin}); events=${events.length}`);
  await conn.close(); await pump;
} finally {
  await conn?.close(); await tracker.ready; service.dispose();
  assert.equal(path.dirname(tmp),path.join(root,'.tmp'));
  await fs.promises.rm(tmp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
