/** Minimal native-protocol subprocess for the review driver integration test. */
const fs = require('node:fs');
const readline = require('node:readline');
const path = require('node:path');
const mode = process.argv.includes('serve') ? 'muse' : 'zcode';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ jsonrpc:'2.0', id, result });
const notify = (method, params) => send({ jsonrpc:'2.0', method, params });
let sequence = 0;
readline.createInterface({ input:process.stdin }).on('line', line => {
  const message = JSON.parse(line), params = message.params ?? {};
  if (message.id == null) return;
  if (mode === 'zcode') {
    if (message.method === 'session/create') return reply(message.id, { protocol:{name:'ZCode Protocol',version:2}, session:{sessionId:'z-session'}, settings:{mode:{current:'build'}} });
    if (message.method === 'session/subscribe') return reply(message.id, {});
    if (message.method === 'session/send') {
      reply(message.id, {accepted:true});
      const emit = payload => notify('session/event', { sessionId:'z-session', turnId:'z-turn', eventId:`z-${++sequence}`, payload });
      setTimeout(() => {
        emit({type:'turn.started',inputId:params.inputId});
        emit({type:'tool.updated',kind:'started',toolCallId:'z-edit',toolName:'write'});
        emit({type:'tool.updated',kind:'scheduled',toolCallId:'z-edit',toolName:'write',input:{path:'zcode.txt',content:'after\n'}});
        setTimeout(() => {
          fs.writeFileSync(path.join(process.cwd(),'zcode.txt'),'after\n');
          emit({type:'tool.updated',kind:'result',toolCallId:'z-edit',toolName:'write',result:{success:true,content:'ok'}});
          fs.writeFileSync(path.join(process.cwd(),'z-late.txt'),'after\n');
          emit({type:'tool.updated',kind:'result',toolCallId:'z-late',toolName:'write',result:{success:true,content:'ok'}});
          emit({type:'turn.completed',inputId:params.inputId,resultType:'success'});
        }, 250);
      }, 30);
      return;
    }
    return reply(message.id, {});
  }
  if (message.method === 'initialize') return reply(message.id, {grantedCapabilities:['sessionMcp']});
  if (message.method === 'session/start') return reply(message.id, {session:{sessionId:'m-session'}});
  if (message.method === 'turn/start') {
    reply(message.id, {status:'accepted',commandId:params.commandId,turnId:'m-turn'});
    const emit = (method, item) => notify(method, {sessionId:'m-session',turnId:'m-turn',item});
    setTimeout(() => {
      emit('item/started', {itemId:'m-edit',turnId:'m-turn',kind:'toolCall',tool:'write',args:'{}'});
      emit('item/updated', {itemId:'m-edit',turnId:'m-turn',kind:'toolCall',tool:'write',args:JSON.stringify({path:'muse.txt',content:'after\n'})});
      setTimeout(() => {
        fs.writeFileSync(path.join(process.cwd(),'muse.txt'),'after\n');
        emit('item/completed', {itemId:'m-edit',turnId:'m-turn',kind:'toolCall',tool:'write',status:'completed'});
        fs.writeFileSync(path.join(process.cwd(),'m-late.txt'),'after\n');
        emit('item/completed', {itemId:'m-late',turnId:'m-turn',kind:'toolCall',tool:'write',args:JSON.stringify({path:'m-late.txt',content:'after\n'}),status:'completed'});
        notify('turn/completed', {sessionId:'m-session',turnId:'m-turn',terminal:'completed'});
      }, 250);
    }, 30);
    return;
  }
  reply(message.id, {});
});
