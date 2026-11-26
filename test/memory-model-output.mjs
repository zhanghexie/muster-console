import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});const temp=fs.mkdtempSync(path.resolve('.tmp/memory-model-'));
const compile=createSharedCompiler(process.cwd(),temp);
const modules=['main/memory/flush.ts','main/memory/consolidation/model.ts'];
try {
  for(const file of modules){
    const m=await import(pathToFileURL(compile(file)));
    const create=m.createFetchFlushModelCall??m.createFetchConsolidationModelCall;
    const response={status:'completed',output:[
      {type:'reasoning',content:[{type:'reasoning_text',text:'Analysis that is not JSON'}]},
      {type:'message',role:'assistant',content:[{type:'output_text',text:'{"records":[]}'}]}
    ]};
    const call=create({baseUrl:'https://synthetic.invalid/v1',apiKey:'fixture-key',modelId:'fixture',api:'openai-responses',fetchImpl:async()=>new Response(JSON.stringify(response))});
    assert.equal(await call({system:'test',user:'test'}),'{"records":[]}');
    response.status='incomplete';
    await assert.rejects(call({system:'test',user:'test'}),/未完成/);
  }
  const {createFetchConsolidationModelCall:create}=await import(pathToFileURL(compile('main/memory/consolidation/model.ts')));
  for(const api of ['openai-responses','openai-completions']){
    const call=create({baseUrl:'https://synthetic.invalid/v1',apiKey:'fixture',modelId:'fixture',api,fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body);assert.equal(api==='openai-responses'?body.text.format.type:body.response_format.type,'json_object');
      assert.equal(body.max_output_tokens??body.max_tokens,8192);
      return new Response(JSON.stringify(api==='openai-responses'?{status:'incomplete',output:[]}:{choices:[{finish_reason:'length',message:{content:'{}'}}]}));
    }});await assert.rejects(call({system:'JSON',user:'test'}),/未完成/);
  }
  console.log('memory-model-output: final-message-only and incomplete-response regressions passed');
} finally {fs.rmSync(temp,{recursive:true,force:true});}
