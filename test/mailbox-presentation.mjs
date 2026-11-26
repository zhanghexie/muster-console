/** Presentation is emitted once after commit, never on history/read/retry or while the app is backgrounded. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Production must retain the approved prototype curves and overlapping CSS tracks.
const studyCss=fs.readFileSync(path.join(root,'docs/prototypes/envelope-send/envelope-send.css'),'utf8');
const productCss=fs.readFileSync(path.join(root,'src/renderer/src/styles/mail-envelope.css'),'utf8');
const rule=(css,scope,name)=>css.split(`${scope} .${name} {`)[1]?.split('}')[0]??'';
for(const name of ['es-flight','es-top','es-bottom','es-insert','es-sheet-scale','es-lid-pivot']){
  const transition=(css,scope)=>/transition:\s*([^;]+);/.exec(rule(css,scope,name))?.[1];
  const approved=transition(studyCss,'#envelope-send-study');
  assert(approved,`missing prototype track: ${name}`);
  assert.equal(transition(productCss,'.mail-envelope-scene'),approved,`${name} preserves timing and easing`);
}
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mail-presentation-'));
const compile=createSharedCompiler(root,tmp);
const load=rel=>import(pathToFileURL(compile(rel)).href);
const store=await load('main/metaAgent/messageStore.ts');
const {attachMailboxPresentation}=await load('main/messages/presentation.ts');
const {deliverAgentMessage}=await load('main/messages/deliver.ts');
const {setMailDepartureViewport, launchMailDepartures, storeMailAtDeparture}=await load('main/messages/departure.ts');
const review=await load('shared/boardReview.ts');
const events=[];let focused=true,visible=true;
store.setAgentMessagesUserDataDir(tmp);
const win=Object.assign(new EventEmitter(), {isDestroyed:()=>false,isVisible:()=>visible,isFocused:()=>focused,
  webContents:Object.assign(new EventEmitter(),{send:(...args)=>events.push(args)})});
const ctx={getWindow:()=>win,resolveBubbleWorkspaceId:()=>'ws',workspaces:{list:()=>[{id:'ws',path:tmp}]},
  sessions:{get:id=>({id,name:id,workspaceId:'ws',archived:id==='b'}),broadcastMessagesChanged:()=>{}}};
const off=attachMailboxPresentation(ctx);
const input={id:'mail-11111111-1111-1111-1111-111111111111',from:'a',to:'b',fromName:'甲',toName:'乙',
  subject:'检查结果',text:'完整正文'.repeat(1500),ts:1,kind:'ask',receipt:'stored'};
try{
  await store.appendAgentMessageToStore(tmp,'ws',input);
  assert.equal(events.length,1);assert.equal(events[0][0],'messages:activity');
  assert.equal(events[0][1].text,input.text.slice(0,1400));assert.equal(events[0][1].totalChars,input.text.length);
  assert.equal(store.readAgentMessageLedger(tmp,'ws').messages[0].read,false,'visual presentation cannot read mail');
  store.readAgentMessageLedger(tmp,'ws');assert.equal(events.length,1,'history does not replay');
  await store.appendAgentMessageToStore(tmp,'ws',input);assert.equal(events.length,1,'idempotent retry does not animate');
  await store.markAgentMessagesReadInStore(tmp,'ws',[input.id]);assert.equal(events.length,1,'read receipt is not new mail');
  assert.equal(store.readAgentMessageLedger(tmp,'ws').messages[0].read,true);
  focused=false;await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,text:'while backgrounded'});
  focused=true;visible=false;await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,text:'while hidden'});
  assert.equal(events.length,1);visible=true;
  await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,to:'scheduler',text:'调度信'});
  assert.equal(events[1][1].to,'orchestrator:ws');
  await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,from:'human',text:'manual answer'});
  await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,to:'a',text:'self mail'});
  assert.equal(events.length,2);
  const pairText='前'.repeat(1399)+'😀结尾';
  await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,text:pairText});
  assert.equal(events.length,3);
  assert.equal(events[2][1].text,'前'.repeat(1399),'a UTF-16 pair is never split at the preview boundary');
  assert.equal(events[2][1].totalChars,pairText.length);
  const session={id:'a',name:'等验收',type:'terminal',launchKind:'agent',runtime:'pi',createdAt:1,lifecycle:'idle',status:'running',
    phase:{value:'needs_you',source:'model',ts:1}};
  assert.equal(store.readAgentMessageLedger(tmp,'ws').messages.some(m=>m.kind==='ask'&&!m.read),true);
  assert.equal(review.boardNeedsReason(session),'review','unanswered mail is not a human question');
  assert.equal(review.canReviewSession(session),true);assert.equal(review.canCompleteAndArchiveSession(session),true);
  assert.equal('risks' in review.reviewFactsOf(session),false,'mail is not listed as a review risk');
  // Legacy callers passing a derived ask list cannot resurrect the removed gate.
  assert.equal(review.boardNeedsReason(session,Date.now(),[{tag:'question',question:'无需回信'}]),'review');
  assert.equal(review.boardNeedsReason({...session,activity:{kind:'waiting_input',ts:1}}),'question','actual user input still matters');
  assert.equal(review.boardNeedsReason({...session,activity:{kind:'blocked',ts:1}}),'approval','actual approvals stay protected');

  const departures=()=>events.filter(([channel])=>channel==='messages:departure').map(([,payload])=>payload);
  const saved=subject=>store.readAgentMessageLedger(tmp,'ws').messages.find(mail=>mail.subject===subject);
  const send=(from,subject,key)=>deliverAgentMessage(ctx,{from,to:'b',text:subject,subject,idempotencyKey:key});
  setMailDepartureViewport(win,'view-a','a',true);
  const staged=send('a','pending before launch','same');
  const retry=send('a','pending before launch','same');
  const { requestId, letter: preview }=departures()[0];
  assert.equal(saved('pending before launch'),undefined,'preview is absent from the durable mailbox');
  assert.equal(departures().length,1,'concurrent retries share the pending departure');
  assert.equal(await launchMailDepartures(win,'other-view',[requestId]),false);
  assert.equal(saved('pending before launch'),undefined);

  await send('c','background sender with focused window');
  assert.ok(saved('background sender with focused window'),'background mail bypasses a pending foreground letter to the same ledger');
  assert.equal(departures().length,1);
  assert.equal(await launchMailDepartures(win,'view-a',[requestId]),true);
  const [receipt,retryReceipt]=await Promise.all([staged,retry]);
  assert.equal(receipt.messageId,retryReceipt.messageId);
  assert.equal(receipt.messageId,preview.id);
  assert.equal(events.filter(([channel,mail])=>channel==='messages:activity'&&mail.id===preview.id).length,1);
  await send('a','pending before launch','same');assert.equal(departures().length,1,'stored retries have no departure');

  const blurred=send('a','send on blur');
  assert.equal(saved('send on blur'),undefined);
  focused=false;win.emit('blur');await blurred;
  assert.ok(saved('send on blur'));
  const beforeHidden=departures().length;
  await send('a','while window is unfocused');
  assert.equal(departures().length,beforeHidden);
  focused=true;

  const closed=send('a','send on pane close');
  assert.equal(saved('send on pane close'),undefined);
  setMailDepartureViewport(win,'view-a','a',false);await closed;
  assert.ok(saved('send on pane close'));
  assert.equal(await launchMailDepartures(win,'view-a',[departures().at(-1).requestId]),false,'a late launch cannot replay a fallback send');

  setMailDepartureViewport(win,'view-a','a',true);
  const failed=storeMailAtDeparture(ctx,{...preview,id:'failed'},async()=>{throw new Error('disk failure');});
  const rejected=assert.rejects(failed,/disk failure/);
  assert.equal(await launchMailDepartures(win,'view-a',[departures().at(-1).requestId]),false,'failed commits cannot launch the envelope');
  await rejected;
  const reload=send('a','send when renderer reloads');
  win.webContents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});await reload;
  assert.ok(saved('send when renderer reloads'));
  const beforeDispose=events.length;
  off();await store.appendAgentMessageToStore(tmp,'ws',{...input,id:undefined,text:'after dispose'});assert.equal(events.length,beforeDispose);
  console.log('mailbox-presentation: durable launch, foreground admission, immediate fallback and idempotency passed');
}finally{off();assert(path.dirname(tmp)===os.tmpdir());fs.rmSync(tmp,{recursive:true,force:true});}
