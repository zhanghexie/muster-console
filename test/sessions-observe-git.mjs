/** Explicit observe Git projection against real isolated repositories. */
import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';import {createSharedCompiler} from './helpers/shared-compile.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'observe-git-')),repo=path.join(tmp,'repo'),tree=path.join(tmp,'tree');
const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath='+path.join(tmp,'empty-hooks'),'-c','commit.gpgSign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid',...args],{cwd,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});
try {
 const compile=createSharedCompiler(process.cwd(),path.join(tmp,'compiled'));
 const {observeHost}=await import(pathToFileURL(compile('main/sessions/observe.ts')).href);
 const session={id:'s',name:'Worker',workspaceId:'w',runtime:'pi',type:'terminal',createdAt:1,lifecycle:'idle',phase:{value:'needs_you',ts:1},worktreePath:tree,worktreeBranch:'worker',worktreeSource:{mainRepo:repo}};
 const ctx={resolveBubbleWorkspaceId:()=> 'w',sessions:{get:()=>session,list:()=>[session],isChatRuntime:()=>true},agentSessions:{isBusy:()=>false,observe:()=>({busy:false,lastReply:null,updatedAt:1})},awareness:{getShare:()=>undefined,listFacts:()=>[]},config:{get:()=>assert.fail('default observation must not query Git/state configuration')}};
 assert.equal((await observeHost(ctx,{sessionId:'s'})).state,undefined);
 fs.mkdirSync(repo);git(repo,'init','-b','main');fs.writeFileSync(path.join(repo,'file.txt'),'base');git(repo,'add','.');git(repo,'commit','-m','base');git(repo,'worktree','add','-b','worker',tree);
 fs.writeFileSync(path.join(tree,'file.txt'),'worker');git(tree,'add','.');git(tree,'commit','-m','worker change');
 fs.writeFileSync(path.join(repo,'file.txt'),'main dirty');fs.writeFileSync(path.join(tree,'new.txt'),'uncommitted');
 ctx.config.get=()=>({workspaces:[{id:'w',path:repo}]});
 const detail=await observeHost(ctx,{sessionId:'s',includeGit:true});
 const dirty=detail.state.facts.find(f=>f.kind==='git.dirty'),commit=detail.state.facts.find(f=>f.kind==='git.commit');
 assert.equal(dirty.data.uncommittedCount,1);assert.equal(dirty.data.dirtyOverlap,true);assert.deepEqual(dirty.data.overlapFiles,['file.txt']);assert.equal(commit.data.aheadCount,1);assert.equal(commit.data.canFastForward,true);
 const filtered=await observeHost(ctx,{sessionId:'s',includeGit:true,facts:{path:'new.txt'}});
 assert.ok(filtered.state.facts.length);assert.ok(filtered.state.facts.every(f=>f.paths?.includes('new.txt')),'path filter reaches the common fact query');
 console.log('sessions-observe-git: OK (no default scan, explicit dirty/ahead/fast-forward/overlap, path filter)');
}finally{assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep+'observe-git-'));fs.rmSync(tmp,{recursive:true,force:true});}
