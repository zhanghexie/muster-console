import ts from 'typescript';
/** Production executor + review handler: ordinary outcomes avoid dialogs; merges use the shared host gate. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-approval-'));
try {
  const compile = createSharedCompiler(root, temp), entry = compile('main/capabilities/executor.ts');
  const source = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
  for (const [, exports, name] of source.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
    if (name === 'sessions') continue;
    const body = (name === 'awareness' ? "export const queryRuntimeState = () => ({});\n" : "") + (name === 'chat' ? "export const buildBriefWithNamedSkills = () => ({});\n" : "") + exports.split(',').map(value => `export const ${value.trim()} = {};`).join('\n');
    fs.writeFileSync(path.join(temp, `main/capabilities/hosts/${name}.mjs`), body);
  }
  fs.writeFileSync(path.join(temp, 'main/capabilities/hosts/creation.mjs'), "export async function createSessionWithTask() { throw new Error('not used in this test'); }\n");
  fs.writeFileSync(compile('main/messages/assignment.ts'), "export const sendSessionMail = async (ctx,args) => {ctx.injected.push(args);return {stored:true};};");
  const { executeTool } = await import(pathToFileURL(entry).href);
  const { shouldSkipReviewConfirm } = await import(pathToFileURL(compile('shared/confirmDialog.ts')).href);
  for (const decision of ['passed', 'processed', 'rejected', 'deferred', 'invalid', undefined]) {
    assert.equal(shouldSkipReviewConfirm('sessions.review', { decision }), ['rejected', 'deferred'].includes(decision));
    assert.equal(shouldSkipReviewConfirm('sessions.delete', { decision }), false);
  }
  const session = { id: 'review', name: 'Review', type: 'terminal', phase: {value:'needs_you'}, worktreePath:'tree', worktreeBranch:'ao/review' };
  const confirmations = [], acceptances = [], injected = [], merged = [], businessReviews = [], processed = [];
  let allowMerge = false;
  const serviceSource=ts.createSourceFile('sessions.ts',fs.readFileSync(path.join(root,'src/main/sessions.ts'),'utf8'),ts.ScriptTarget.Latest,true);
  const declaration=serviceSource.statements.find(node=>ts.isClassDeclaration(node)&&node.name?.text==='SessionsService');
  const method=declaration.members.find(node=>node.name?.getText(serviceSource)==='integrateWorktree');
  const emitted=ts.transpileModule(`class Gate { ${method.getText(serviceSource)} }; exports.Gate=Gate;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const gateExports={};new Function('exports','integrateSessionWorktree','usesTaskWorktreeLifecycle','beginTaskWorktreeOperation','createSafetyGitEvidenceCollector',emitted)(gateExports,async()=>{merged.push(true);return {merged:true};},()=>false,()=>({release(){}}),()=>({capture(){},finish:()=>({}),clear(){}}));
  const ctx = { injected, resolveBubbleWorkspaceId: () => 'ws', isOrchestratorBusy: () => true,
    workspaces: {list: () => [{id:'ws',name:'Workspace'}]},
    ui: {confirm: async (...args) => { confirmations.push(args); return {confirmed:false,cancelledBy:'timeout'}; }},
    sessions: {get: () => session, list: () => [session], resolveSessionRef: () => ({id:session.id}),
      recordAcceptance: (_id, value) => acceptances.push(value), setReviewDeferred: (_id, value) => {session.reviewDeferred=value;},
      clearDimensionGates: () => {}, markProcessed: id => processed.push(id),
      integrateWorktree: gateExports.Gate.prototype.integrateWorktree, integrateCtx: () => ({}),
      approvalSnapshot: async () => 'bound repository evidence', resolveWorkspaceId: () => 'ws',
      businessApproval: async (...args) => {businessReviews.push(args);return allowMerge;} }
  };
  for (const decision of ['rejected','deferred']) {
    const r = await executeTool(ctx, 'sessions.review', JSON.stringify({sessionId:session.id,decision,note:'review evidence'}));
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.result.decision, decision);
  }
  assert.equal(confirmations.length, 0, 'low-risk decisions must never wait for UI approval');
  assert.equal(injected.length, 1, 'reject still reaches the actual continuation handler');
  assert.equal(session.reviewDeferred, true); assert.deepEqual(acceptances.map(x=>x.decision), ['rejected','deferred']);
  const passed = await executeTool(ctx,'sessions.review',JSON.stringify({sessionId:session.id,decision:'passed',approval:'auto'}));
  assert.equal(passed.ok,false);assert.match(passed.error,/approval denied/);assert.equal(merged.length,0,'service denial prevents review from merging');
  assert.equal(businessReviews.length,1,'passed review delegates to shared host business gate');
  const processedResult=await executeTool(ctx,'sessions.review',JSON.stringify({sessionId:session.id,decision:'processed'}));
  assert.equal(processedResult.ok,true);assert.equal(processed.length,1,'ordinary processed state executes without model or human review');assert.equal(businessReviews.length,1);
  const normalIntegrate=await executeTool(ctx,'sessions.integrate',JSON.stringify({sessionId:session.id}));
  assert.equal(normalIntegrate.ok,false);assert.equal(businessReviews.length,2,'direct integration uses the same service approval');assert.equal(merged.length,0);
  allowMerge=true;
  assert.equal((await executeTool(ctx,'sessions.review',JSON.stringify({sessionId:session.id,decision:'passed'}))).ok,true);
  assert.equal(merged.length,1,'approved review merges exactly once');assert.equal(businessReviews.length,3);
  const { sessionsHost } = await import(pathToFileURL(compile('main/capabilities/hosts/sessions.ts')).href);
  allowMerge=false;
  assert.equal((await sessionsHost['sessions.review'](ctx,{sessionId:session.id,decision:'passed'},{initiatedBy:'human'})).ok,true);
  assert.equal(merged.length,2,'the trusted human review entry merges without a second review');
  assert.equal(businessReviews.length,3);
  const forged=await executeTool(ctx,'sessions.review',JSON.stringify({sessionId:session.id,decision:'passed',initiatedBy:'human'}));
  assert.equal(forged.ok,false,'tool arguments cannot impersonate the human IPC entry');
  assert.equal(merged.length,2); assert.equal(businessReviews.length,4);
  assert.equal(confirmations.length,0,'ordinary outcomes and structured denial never add a routine confirmation dialog');
  console.log('ok: review outcomes avoid routine dialogs and merges require shared host approval');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
