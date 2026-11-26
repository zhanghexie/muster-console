import { createPosixPtyNative, reclaimPosixPtySession, signalPinnedPosixGroup } from './interactivePosix';

const CHILD = String.raw`
const { spawn } = require('node:child_process');
const createNative = __NATIVE__;
for (const signal of ['SIGINT','SIGQUIT','SIGTSTP','SIGTTIN','SIGTTOU']) process.on(signal, () => {});
let native, configured = false, launched = false, nonce;
const send = value => { if (process.connected) process.send(value); };
process.on('message', message => {
  if (message.type === 'cancel') { process.exit(0); return; }
  if (message.type === 'configure' && !configured) {
    configured = true; nonce = message.nonce;
    try {
      native = createNative(require(message.koffiPath), process.platform, require('node:fs').readdirSync, require('node:os').constants.errno.ESRCH);
      const error = native.joinGroup(message.group);
      if (error) { send({ type:'join-failed', errno:error, nonce }); process.exitCode=95; process.disconnect(); return; }
      send({ type:'joined', pid:process.pid, session:native.sessionId(0), group:native.groupId(0), nonce });
    } catch (error) { send({ type:'failed', error:String(error), nonce }); process.exitCode=96; process.disconnect(); }
  } else if (message.type === 'run' && configured && !launched) {
    launched = true;
    try {
      const child = spawn(message.command, message.args, {cwd:message.cwd, env:message.env, stdio:'inherit', detached:false});
      child.once('spawn', () => send({type:'started',nonce}));
      child.once('error', error => send({type:'failed',error:String(error),nonce}));
      child.once('close', (code,signal) => send({type:'completed',code:code === null ? 1 : code,signal,nonce}));
    } catch (error) { send({type:'failed',error:String(error),nonce}); }
  }
});
// Keep this controlled process-group member alive until the owner reclaims it.
`;

export const INTERACTIVE_PTY_BOOTSTRAP = String.raw`
const net=require('node:net'), fs=require('node:fs'), {spawn}=require('node:child_process'), {randomBytes}=require('node:crypto');
const createNative=__NATIVE__, reclaimSession=__RECLAIM__, signalPinned=__SIGNAL__, childSource=__CHILD__;
const endpoint=process.env.MUSTER_PTY_OWNER_ENDPOINT, token=process.env.MUSTER_PTY_OWNER_TOKEN, koffiPath=process.env.MUSTER_PTY_OWNER_KOFFI;
const socket=net.createConnection(endpoint); socket.setEncoding('utf8');
for(const signal of ['SIGINT','SIGQUIT','SIGTSTP','SIGTTIN','SIGTTOU']) process.on(signal,()=>{});
let native, capabilityError, input='', launched=false, closing=false, cleanupPromise, launchOperation, generation=0;const helpers=new Set();
if(process.platform!=='win32') { try { native=createNative(require(koffiPath),process.platform,fs.readdirSync,require('node:os').constants.errno.ESRCH);native.assertLeader(process.pid);native.groups(process.pid); } catch(error) {capabilityError=String(error);} }
const send=value=>{if(!socket.destroyed)socket.write(JSON.stringify(value)+'\n');};
const bounded=(promise,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(label+' timed out')),7000);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
function controlledChild(group, interactive=false) {
  const nonce=randomBytes(16).toString('hex');
  const child=spawn(process.execPath,['-e',childSource],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:interactive?['inherit','inherit','inherit','ipc']:['ignore','ignore','inherit','ipc'],detached:false,windowsHide:true});
  child.on('error',()=>{});
  let exited=false;const closed=new Promise(resolve=>child.once('close',()=>{exited=true;resolve();}));
  const joined=bounded(new Promise((resolve,reject)=>{child.on('message',message=>{if(message.nonce!==nonce)return;if(message.type==='joined'||message.type==='join-failed')resolve(message);else if(message.type==='failed')reject(Error(message.error));});child.once('error',reject);child.once('close',()=>reject(Error('PTY group guard exited before proof')));child.once('spawn',()=>child.send({type:'configure',group,koffiPath,nonce}));}),'PTY group pin');
  const record={child,nonce,closed,joined,userStarted:false,alive:()=>!exited&&child.exitCode===null&&child.signalCode===null,cancelAndWait:async()=>{if(!exited&&child.connected){try{child.send({type:'cancel'},()=>{});}catch{}}await bounded(closed,'PTY helper cancellation');}};
  helpers.add(record);child.once('close',()=>helpers.delete(record));return record;
}
async function pin(group) {
  const guard=controlledChild(group);
  try {
    const proof=await guard.joined;
    if(proof.type==='join-failed') {await bounded(guard.closed,'PTY rejected group close');if(!native.groups(process.pid).includes(group))return null;throw Error('Cannot pin owned PTY group '+group+' (errno '+proof.errno+')');}
    if(proof.pid!==guard.child.pid||proof.session!==process.pid||proof.group!==group)throw Error('Invalid PTY group pin proof');
    const lease={signalled:false};
    return {session:proof.session,group:proof.group,signalAndWait:async()=>{
      try {await signalPinned({lease,leader:process.pid,group,guardPid:guard.child.pid,assertLeader:()=>native.assertLeader(process.pid),alive:guard.alive,sessionId:native.sessionId,groupId:native.groupId,
        signal:pgid=>{try{process.kill(-pgid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}},waitClosed:()=>bounded(guard.closed,'PTY pinned group close')});}
      catch(error){await guard.cancelAndWait();throw error;}
    }};
  } catch(error) {try{await guard.cancelAndWait();}catch(cleanup){throw new AggregateError([error,cleanup],'PTY group pin and helper closure failed');}throw error;}
}
function cleanup(){
  if(cleanupPromise)return cleanupPromise;closing=true;generation++;
  cleanupPromise=Promise.resolve().then(async()=>{
    const results=await Promise.allSettled([...helpers].filter(helper=>!helper.userStarted).map(helper=>helper.cancelAndWait()));
    const failed=results.filter(result=>result.status==='rejected');if(failed.length)throw new AggregateError(failed.map(result=>result.reason),'PTY bootstrap helpers did not close');
    if(launchOperation)await launchOperation.catch(()=>{});
    if(process.platform!=='win32'&&launched){if(!native)throw Error(capabilityError||'POSIX native ownership unavailable');await reclaimSession({leader:process.pid,assertLeader:()=>native.assertLeader(process.pid),groups:()=>native.groups(process.pid),pin,timeoutMs:7000});}
  }).finally(()=>{cleanupPromise=undefined;});return cleanupPromise;
}
function abandon(){if(process.platform==='win32'){process.exit(92);return;}void cleanup().then(()=>process.kill(-process.pid,'SIGKILL'),error=>process.stderr.write('[pty] owned session cleanup failed: '+String(error)+'\n'));}
socket.on('connect',()=>send({type:'hello',token,pid:process.pid,capabilityError}));socket.on('error',abandon);socket.on('close',abandon);
socket.on('data',chunk=>{input+=chunk;if(input.length>16777216){abandon();return;}let end;while((end=input.indexOf('\n'))>=0){const line=input.slice(0,end);input=input.slice(end+1);let message;try{message=JSON.parse(line);}catch{abandon();return;}
 if(message.type==='challenge')send({type:'proof',nonce:message.nonce,pid:process.pid});
 else if(message.type==='cleanup')void cleanup().then(()=>send({type:'cleaned',nonce:message.nonce,pid:process.pid}),error=>send({type:'cleanup-failed',nonce:message.nonce,error:String(error),pid:process.pid}));
 else if(message.type==='run'&&!launched&&!closing){launched=true;const launchGeneration=++generation;const env={...message.env};delete env.MUSTER_PTY_OWNER_ENDPOINT;delete env.MUSTER_PTY_OWNER_TOKEN;delete env.MUSTER_PTY_OWNER_KOFFI;
  if(capabilityError){send({type:'failed',error:capabilityError});continue;}
  launchOperation=(async()=>{const helper=controlledChild(0,true),proof=await helper.joined;if(closing||generation!==launchGeneration){await helper.cancelAndWait();return;}if(proof.type!=='joined'||proof.pid!==helper.child.pid||proof.session!==process.pid||proof.group!==helper.child.pid){await helper.cancelAndWait();throw Error('Invalid interactive shell group');}native.foreground(process.pid,helper.child.pid);helper.child.on('message',frame=>{if(frame.nonce!==helper.nonce)return;if(frame.type==='started'||frame.type==='completed'||frame.type==='failed')send(frame);});helper.userStarted=true;helper.child.send({type:'run',command:message.command,args:message.args,cwd:message.cwd,env});})();void launchOperation.catch(error=>send({type:'failed',error:String(error)}));
 }
}});
`.replaceAll('__NATIVE__', `(${createPosixPtyNative.toString()})`)
  .replace('__RECLAIM__', `(${reclaimPosixPtySession.toString()})`)
  .replace('__SIGNAL__', `(${signalPinnedPosixGroup.toString()})`)
  .replace('__CHILD__', JSON.stringify(CHILD.replace('__NATIVE__', `(${createPosixPtyNative.toString()})`)));
