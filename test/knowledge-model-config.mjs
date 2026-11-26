import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
const temp=fs.mkdtempSync(path.resolve('.tmp/knowledge-model-config-'));
try{
 const compile=createSharedCompiler(process.cwd(),path.join(temp,'compiled'));
 const {supportsMemoryModelApi,normalizeMemoryConsolidationConfig,resolveConsolidationTarget}=await import(pathToFileURL(compile('shared/memoryConsolidation.ts')));
 for(const api of [undefined,'openai-completions','openai-responses'])assert.equal(supportsMemoryModelApi(api),true);
 for(const api of ['anthropic-messages','google-generative-ai','azure-openai-responses','mistral-conversations'])assert.equal(supportsMemoryModelApi(api),false);
 const cfg=normalizeMemoryConsolidationConfig({enabled:true,providerId:'',modelId:''});
 assert.deepEqual(resolveConsolidationTarget(cfg,{providerId:'scheduler',modelId:'s-model'}),{providerId:'scheduler',modelId:'s-model'});
 assert.deepEqual(resolveConsolidationTarget({providerId:'chosen',modelId:'c-model'},{providerId:'scheduler',modelId:'s-model'}),{providerId:'chosen',modelId:'c-model'});
 console.log('knowledge-model-config: supported protocols, explicit selection and follow mode passed');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
