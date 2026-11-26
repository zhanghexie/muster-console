import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});const tmp=fs.mkdtempSync(path.resolve('.tmp/knowledge-evidence-'));
const compile=createSharedCompiler(process.cwd(),path.join(tmp,'compiled'));
const {TurnChangeService}=await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const repo=path.join(tmp,'repo'),other=path.join(tmp,'other'),snapshots=path.join(tmp,'snapshots');
fs.mkdirSync(repo);fs.mkdirSync(other);fs.mkdirSync(snapshots);
const service=new TurnChangeService(snapshots);
const image=text=>({text,stamp:'fixture',mode:420});
const snapshot=(id,turn,diff)=>({owner:'gui:session',messageId:turn,roots:[{path:repo,physical:fs.realpathSync(repo)}],
  summary:{id,state:'ready',files:[],warnings:[],repository:{root:repo,branch:'main',baseCommit:'base',endCommit:'end',scopeStable:true}},
  files:[{abs:path.join(repo,'app.ts'),view:{path:'app.ts',kind:'modified',added:1,removed:1,revertible:false},before:image('old'),after:image(diff),diff}]});
try {
 const a=randomUUID(),b=randomUUID();await service.save(snapshot(a,'turn-1','-old\n+first'));await service.save(snapshot(b,'turn-2','-first\n+second'));
 assert.equal(service.evidence(a,'gui:session','turn-1',[repo],repo,'main','app.ts').diff,'-old\n+first');
 assert.equal(service.evidence(b,'gui:session','turn-2',[repo],repo,'main','app.ts').diff,'-first\n+second');
 assert.throws(()=>service.evidence(a,'gui:other','turn-1',[repo],repo,'main'),/不属于/);
 assert.throws(()=>service.evidence(a,'gui:session','turn-2',[repo],repo,'main'),/不属于/);
 assert.throws(()=>service.evidence(a,'gui:session','turn-1',[repo],repo,'dev'),/范围/);
 assert.throws(()=>service.evidence(a,'gui:session','turn-1',[repo],other,'main'),/范围/);
 assert.throws(()=>service.evidence(a,'gui:session','turn-1',[other],repo,'main','app.ts'),/授权/);
 const meta=service.evidence(a,'gui:session','turn-1',[repo],repo,'main');
 assert.equal(meta.files.length,1);assert.equal(meta.files[0].beforeHash.length,64);assert.equal(meta.diff,undefined);
 fs.unlinkSync(path.join(snapshots,`${a}.json`));
 assert.throws(()=>service.evidence(a,'gui:session','turn-1',[repo],repo,'main'),/没有文件改动快照/);
 console.log('knowledge-evidence: real snapshot identity, branch, permission, hashes and missing evidence passed');
}finally{fs.rmSync(tmp,{recursive:true,force:true});}
