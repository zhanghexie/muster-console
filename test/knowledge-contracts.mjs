import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {createSharedCompiler} from './helpers/shared-compile.mjs';
fs.mkdirSync('.tmp',{recursive:true});const dir=fs.mkdtempSync(path.resolve('.tmp/knowledge-contracts-'));
try{
 const compile=createSharedCompiler(process.cwd(),dir);
 for(const name of ['AGENTS.md','CLAUDE.md'])assert.doesNotMatch(fs.readFileSync(name,'utf8'),/<!-- (?:metaagent|muster)(?:-memory)?:begin -->/);
 const memorySkill=fs.readFileSync('resources/skills/memory/SKILL.md','utf8');
 assert.match(memorySkill,/memory.search/);
 assert.match(memorySkill,/Use .*host\.memory\.journal.* only for decisions, findings, or handoff details worth revisiting\. Skip routine turns/);
 assert.doesNotMatch(memorySkill,/every substantive turn|Before the final response, do both/);
 assert.match(memorySkill,/~\/\.muster\/skills\/memory\/SKILL\.md/);
 assert.doesNotMatch(memorySkill,/\.agents\/skills\/memory/);
 const {TOOLS_MEMORY_INTENT_TOOL_DEFS}=await import(pathToFileURL(compile('main/capabilities/catalog/toolsMemoryIntent.ts')));
 assert.ok(!TOOLS_MEMORY_INTENT_TOOL_DEFS.some(t=>t.name==='scheduler.memory.write'));
 assert.ok(TOOLS_MEMORY_INTENT_TOOL_DEFS.find(t=>t.name==='memory.search').parameters.properties.mode);
 for(const name of ['memory.note','memory.remember']){const schema=TOOLS_MEMORY_INTENT_TOOL_DEFS.find(t=>t.name===name).parameters;assert.ok(!schema.properties.repoKey);assert.ok(schema.required.includes('searchKeys'));assert.equal(schema.properties.searchKeys.minItems,1);}
 const {buildGuiWorkerSystemPrompt}=await import(pathToFileURL(compile('shared/guiWorkerPrompt.ts')));
 for(const memorySection of ['',undefined,'some effective memory'])assert.match(buildGuiWorkerSystemPrompt({cwd:process.cwd(),mode:'auto',tools:[{id:'host.memory.remember',description:'host memory'}],memorySection}),/Read ~\/\.muster\/skills\/memory\/SKILL\.md before your first memory tool call/,'an available memory tool must point to the skill even when the snapshot is empty');
 assert.doesNotMatch(buildGuiWorkerSystemPrompt({cwd:process.cwd(),mode:'auto',tools:[]}),/~\/\.muster\/skills\/memory\/SKILL\.md/,'a transport without host tools must not promise unavailable memory calls');
 const runtime=fs.readFileSync('src/main/memory/runtime.ts','utf8');assert.ok(!runtime.includes('runConsolidationSweep')&&!runtime.includes('runUserProfileSweep')&&!runtime.includes('runMemoryFlushTurn'));
 const ipc=fs.readFileSync('src/main/ipc.ts','utf8');assert.ok(ipc.includes('registerKnowledgeIpc(ctx)')&&!ipc.includes('registerMemoryIpc(ctx)'));
 console.log('knowledge-contracts: host-scoped guidance, no whole-file write, host scope and production routes passed');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
