import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { simpleGit } from 'simple-git';
import ts from 'typescript';
const source=ts.createSourceFile('service.ts',fs.readFileSync('src/main/git/service.ts','utf8'),ts.ScriptTarget.Latest,true);
const declaration=source.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='GitService');
const method=declaration.members.find(member=>member.name?.getText(source)==='approvalEvidence').getText(source);
const code=ts.transpileModule(`class Probe { ${method} }; exports.Probe=Probe;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
let activeReads=0, maximumReads=0;
const fsOps={...fsp,open:async(...args)=>{const handle=await fsp.open(...args);maximumReads=Math.max(maximumReads,++activeReads);return {stat:()=>handle.stat(),createReadStream:opts=>handle.createReadStream(opts),close:async()=>{try {await handle.close();}finally {activeReads--;}}};}};
const exports={};new Function('exports','fs','path','createHash',code)(exports,fsOps,path,createHash);
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'approval-git-'));
const outside=fs.mkdtempSync(path.join(os.tmpdir(),'approval-private-'));
try {
 const git=(...args)=>execFileSync('git',args,{cwd:folder,encoding:'utf8'});
 git('init','-b','main');git('config','user.email','fixture@example.com');git('config','user.name','Fixture');
 fs.writeFileSync(path.join(folder,'code.txt'),'base');git('add','.');git('commit','-m','base');git('checkout','-b','feature');
 fs.writeFileSync(path.join(folder,'code.txt'),`feature\n${'large diff line\n'.repeat(5000)}end-of-complete-diff`);git('commit','-am','feature');
 const probe=new exports.Probe();probe.assertAllowed=async()=>folder;probe.client=()=>simpleGit(folder);probe.status=async()=>{const s=await simpleGit(folder).status();return {branch:s.current,files:s.files};};
 let captured;
 const before=await probe.approvalEvidence(folder,'main','feature',value=>{captured=value;});
 assert.match(before.diff.text,/feature/);assert.notEqual(before.source,before.target);assert.equal(before.tests.status,'not-collected');
 assert.equal(before.diff.truncated,true);assert.equal(before.diff.text.length,48000);
 assert.match(captured.diff,/end-of-complete-diff/,'the request-local tool can read beyond the old preview');
 assert.equal(createHash('sha256').update(captured.diff).digest('hex'),before.diff.sha256);
 fs.writeFileSync(path.join(folder,'code.txt'),'changed during review');
 const working=await probe.approvalEvidence(folder,'main','feature');assert.notEqual(working.workingDiff.sha256,before.workingDiff.sha256);
 fs.writeFileSync(path.join(folder,'untracked.txt'),'first');const first=await probe.approvalEvidence(folder,'main','feature');
 fs.writeFileSync(path.join(folder,'untracked.txt'),'other');const other=await probe.approvalEvidence(folder,'main','feature');assert.notEqual(first.untrackedFiles[0].sha256,other.untrackedFiles[0].sha256);
 git('commit','-am','changed');const committed=await probe.approvalEvidence(folder,'main','feature');assert.notEqual(committed.source,before.source);assert.notEqual(committed.head,before.head);
 git('checkout','--detach','main');
 const detached=await probe.approvalEvidence(folder,'main','feature');
 assert.equal(detached.source,committed.source);assert.equal(detached.target,committed.target);assert.notEqual(detached.head,committed.head,'checked-out HEAD is bound independently of source/target refs');
 for(let i=0;i<20;i++) fs.writeFileSync(path.join(folder,`read-${i}.txt`),'bounded');
 await probe.approvalEvidence(folder,'main','feature');assert.equal(maximumReads,1,'untracked file reads are serial');assert.equal(activeReads,0);
 const secret=path.join(outside,'secret.txt');fs.writeFileSync(secret,'private bytes');
 const link=path.join(folder,'outside-link');let linked=false;
 try {fs.symlinkSync(secret,link,'file');linked=true;} catch(error) {if(process.platform!=='win32'||!['EPERM','EACCES'].includes(error.code)) throw error;console.log('symlink real-file check unavailable: Windows symlink privilege required');}
 if(linked) {
  const beforeLink=(await probe.approvalEvidence(folder,'main','feature')).untrackedFiles.find(file=>file.path==='outside-link');
  assert.equal(beforeLink.type,'symlink');assert.equal(beforeLink.sha256,createHash('sha256').update(secret).digest('hex'));
  fs.writeFileSync(secret,'changed private bytes');
  const afterLink=(await probe.approvalEvidence(folder,'main','feature')).untrackedFiles.find(file=>file.path==='outside-link');
  assert.deepEqual(afterLink,beforeLink,'link evidence hashes target text without reading outside content');
  fs.unlinkSync(link);fs.symlinkSync(path.join(outside,'absent'),link,'file');
  assert.equal((await probe.approvalEvidence(folder,'main','feature')).untrackedFiles.find(file=>file.path==='outside-link').type,'symlink','dangling link never opens target');
 }
 if(process.platform!=='win32') {
  execFileSync('mkfifo',[path.join(folder,'device-pipe')]);
  // Git can omit special nodes from --others; force its result to exercise the real FIFO lstat guard.
  const client=probe.client;probe.client=()=>{const real=client();return new Proxy(real,{get(target,key){if(key==='raw')return args=>args[0]==='ls-files'?Promise.resolve('device-pipe\0'):target.raw(args);const value=target[key];return typeof value==='function'?value.bind(target):value;}});};
  await assert.rejects(probe.approvalEvidence(folder,'main','feature'),/non-regular/);probe.client=client;
 }
 console.log('ok session-approval-git-evidence');
} finally {fs.rmSync(folder,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
