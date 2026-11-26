/** Actual Pi SDK archive restore outside Vitest's isolated ESM contexts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gui-fork-seed-sdk-'));
try{
  const compile=createSharedCompiler(process.cwd(),path.join(directory,'compiled'));
  const {writePiSeedArchive}=await import(pathToFileURL(compile('main/agentSession/piSeedArchive.ts')).href);
  const {createForkContextSpool,readForkContextSpool}=await import(pathToFileURL(compile('main/agentSession/forkContextSpool.ts')).href);
  const owner=randomUUID();
  const descriptor=createForkContextSpool(directory,owner,(function*(){for(let index=0;index<1000;index++)yield{role:index%2?'assistant':'user',text:`seed ${index}`,ts:index+1};})());
  let maximum=0;
  const archive=writePiSeedArchive({SessionManager},{sessionId:owner,cwd:directory,directory,seeds:readForkContextSpool(directory,owner,descriptor),
    model:{api:'openai-completions',provider:'fixture',id:'fixture'},onScratchSize:count=>{maximum=Math.max(maximum,count);}});
  assert.equal(maximum,1);assert.equal(archive.count,1000);
  const context=SessionManager.open(archive.file,directory).buildSessionContext();
  assert.equal(context.messages.length,1000);assert.equal(context.messages[0].content,'seed 0');
  assert.deepEqual(context.messages.at(-1).content,[{type:'text',text:'seed 999'}]);
  console.log('gui fork seed archive SDK: ok');
}finally{
  assert.equal(path.dirname(directory),os.tmpdir());assert.ok(path.basename(directory).startsWith('gui-fork-seed-sdk-'));
  fs.rmSync(directory,{recursive:true,force:true});
}
