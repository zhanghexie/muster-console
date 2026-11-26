/** Real scheduler send pipeline + autonomy gate, replacing only unrelated memory IO. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mailbox-scheduler-'));
let gateQueue;
try{
 const compile=createSharedCompiler(process.cwd(),tmp);
 const entry=compile('main/agent/orchestrator/sendPipeline.ts');
 fs.writeFileSync(path.join(tmp,'main/memory/runtime.mjs'),'export const resolveMemoryWorkspaceRoot=()=>null;export const getMemoryService=()=>null;');
 const {send}=await import(pathToFileURL(entry));
 const {sendMailboxWake}=await import(pathToFileURL(compile('main/messages/transport.ts')));
 const {createTurnGateWiring}=await import(pathToFileURL(compile('main/agent/orchestrator/turnGate.ts')));
 const bucket={display:[],queue:[],busy:false};let starts=0,admitted=0,skipped=0,needed=true;
 const o={ctx:{notify:{push(){throw new Error('mail wake must not hit queue-full notifications');}}},
  ensureBucket:()=>bucket,checkSendImages:()=>({ok:true}),maybeIdleMicrocompact:async()=>{},persistBucket(){},emit(){},
  startTurn:async()=>{bucket.busy=true;starts++;}};
 let gatedSend;
 const wiring=createTurnGateWiring(()=>({enabled:true,cap:1,leaseMs:10000}),(item,token)=>{
   gatedSend=send(o,item.text,item.workspaceId,undefined,{host:true,gateToken:token,messageId:item.messageId,
    requireIdle:item.requireIdle,schedulerWake:item.schedulerWake,beforeStart:item.beforeStart,onAccepted:item.onAccepted,
    onSkipped:item.onSkipped,notification:item.notification});
 });Object.assign(o,wiring);
 gateQueue=wiring.gateQueue;
 const held=wiring.turnGate.tryAcquire();
 const opts={host:true,requireIdle:true,messageId:'mail-wake',beforeStart:()=>{if(needed)admitted++;return needed;},onSkipped:()=>skipped++};
 await send(o,'host mailbox wake','ws',undefined,opts);
 assert.equal(wiring.gateQueue.pendingCount,1);assert.equal(bucket.display.length,0);assert.equal(admitted,0);
 bucket.busy=true;bucket.queue=Array.from({length:8},()=>({text:'queued user'}));
 wiring.turnGate.release(held);wiring.gateQueue.drain();await gatedSend;
 assert.equal(skipped,1);assert.equal(bucket.queue.length,8);assert.equal(starts,0,'deferred wake cannot enter a busy/full input queue');
 bucket.busy=false;bucket.queue=[];
 await send(o,'host mailbox wake','ws',undefined,opts);await gatedSend;
 assert.equal(starts,1);assert.equal(admitted,1);assert.equal(bucket.display[0].host,true);assert.equal(bucket.display[0].id,'mail-wake');
 await send(o,'same wake','ws',undefined,opts);assert.equal(starts,1,'stable wake ID cannot start another turn');
 bucket.busy=false;wiring.turnGate.release(bucket.gateToken);bucket.gateToken=undefined;
 needed=false;await send(o,'old read mail','ws',undefined,{...opts,messageId:'read-mail'});await gatedSend;
 assert.equal(starts,1);assert.equal(skipped,2,'actual admission rechecks stale read mail');
 needed=true;
 const notification={prepare:()=>({ids:['event'],summary:'收到 3 条 RSS 更新',content:'PRIVATE MODEL MATERIAL'}),accepted(){}};
 let forwarded;
 o.startTurn=async(_bucket,_ws,_text,_images,_host,value)=>{forwarded=value;};
 const displayCount=bucket.display.length, secondHold=wiring.turnGate.tryAcquire();
 await send(o,'', 'ws', undefined, {...opts,messageId:'native-host',notification});
 assert.equal(wiring.gateQueue.pendingCount,1);
 wiring.turnGate.release(secondHold);wiring.gateQueue.drain();await gatedSend;
 assert.deepEqual(await forwarded.prepare(),await notification.prepare(),'native delivery survives deferred autonomy admission');
 assert.equal(bucket.display.length,displayCount,'model event input never becomes a user/display message');
 wiring.turnGate.release(bucket.gateToken);bucket.gateToken=undefined;

 const wsId = 'ws';
 const recipient = 'orchestrator:ws';
 const guidance = '仍需用户行动时，用 `host_ui_reminders({"action":"add","text":"待办事项"})` 记下具体事项。继续执行下面的唤醒指令。';
 const mailInstruction = '邮箱有新信。请调用 host.mail.read 读取。';
 let phase = 'idle', pendingQuestion = false;
 o.ctx.schedulerStatus = { get: () => ({ phase }) };
 o.ctx.orchestrator = {
   isBusy: () => bucket.busy,
   getHumanWait: () => pendingQuestion ? { questionId: 'question' } : null,
   send: (...args) => send(o, ...args)
 };
 const inputs = [];
 o.startTurn = async (_bucket, _ws, text, _images, _host, delivery) => {
   bucket.busy = true;
   inputs.push({ text, delivery });
   if (delivery) {
     const batch = await delivery.prepare();
     if (batch) await delivery.accepted(batch);
     delivery.settled?.();
   }
 };
 const finish = () => {
   bucket.busy = false;
   wiring.turnGate.release(bucket.gateToken);
   bucket.gateToken = undefined;
 };
 const requestWake = (id, text = mailInstruction, delivery) =>
   sendMailboxWake(o.ctx, recipient, wsId, text, id, () => true, delivery);

 const mailHold = wiring.turnGate.tryAcquire();
 const wake = requestWake('wake-while-idle');
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(wiring.gateQueue.pendingCount, 1);
 phase = 'needs_you';
 wiring.turnGate.release(mailHold);
 wiring.gateQueue.drain();
 assert.equal(await wake, true);
 await gatedSend;
 assert.equal(inputs.at(-1).text, `${guidance}\n\n${mailInstruction}`);
 assert.equal(bucket.display.at(-1).content, mailInstruction);
 finish();

 const resumeBatch = { ids: ['resume-id'], summary: '等待条件已触发', content: '[续接] 读取 Worker 的报告。\n继续执行原任务。' };
 let acceptedBatch;
 assert.equal(await requestWake('wait-resume', '', {
   prepare: () => resumeBatch,
   accepted: batch => { acceptedBatch = batch; }
 }), true);
 await gatedSend;
 assert.equal(inputs.at(-1).text, '');
 assert.deepEqual(acceptedBatch, { ...resumeBatch, content: `${guidance}\n\n${resumeBatch.content}` });
 finish();

 await send(o, '用户手动消息', wsId);
 assert.equal(inputs.at(-1).text, '用户手动消息');
 finish();
 await send(o, '普通宿主任务', wsId, undefined, { host: true, requireIdle: true });
 await gatedSend;
 assert.equal(inputs.at(-1).text, '普通宿主任务');
 finish();

 const idleHold = wiring.turnGate.tryAcquire();
 const idleWake = requestWake('wake-after-phase-clears');
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(wiring.gateQueue.pendingCount, 1);
 phase = 'idle';
 wiring.turnGate.release(idleHold);
 wiring.gateQueue.drain();
 assert.equal(await idleWake, true);
 await gatedSend;
 assert.equal(inputs.at(-1).text, mailInstruction);
 finish();

 const questionHold = wiring.turnGate.tryAcquire();
 const questionWake = requestWake('wake-before-question');
 await new Promise(resolve => setImmediate(resolve));
 assert.equal(wiring.gateQueue.pendingCount, 1);
 pendingQuestion = true;
 wiring.turnGate.release(questionHold);
 wiring.gateQueue.drain();
 assert.equal(await questionWake, false);
 await gatedSend;
 assert.equal(inputs.length, 5);
 console.log('mailbox-scheduler: deferred admission, original wake content, phase changes, and pending-question guard passed');
}finally{gateQueue?.dispose();fs.rmSync(tmp,{recursive:true,force:true});}
