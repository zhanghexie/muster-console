/** Production first-send and busy-redirect routes share concrete runtime policy. SDK/IO boundaries are isolated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { builtinHarnessFixtures } from './helpers/harness-fixtures.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryParent = os.tmpdir();
const temporary = fs.mkdtempSync(path.join(temporaryParent, 'metaagent-skill-target-routing-'));
const require = createRequire(import.meta.url);
const bundle = path.join(temporary, 'routing.mjs');
const boundaries = [
  [/agentSession[\\/]host[\\/]base\.ts$/, `export const applyInjectQueueChange=()=>{},applySignal=()=>{},cancelStreamingPersist=()=>{},log=()=>{},persistEntry=()=>{},push=()=>{},syncEntry=()=>{},getDriver=()=>({supportsImages:false});`],
  [/agentSession[\\/]host[\\/]workspaceContext\.ts$/, `export const beginWorkspaceContext=()=>{},endWorkspaceContext=()=>{};`],
  [/agentSession[\\/]host[\\/]usage\.ts$/, `export const pushContext=()=>{},rejectImagesForSessionModel=()=>null;`],
  [/agentSession[\\/]host[\\/]events\.ts$/, `export const stampCompactionTokens=()=>{};`],
  [/agentSession[\\/]host[\\/]approvals\.ts$/, `export const resolveApprovalInternal=()=>{},resolveUserQuestionInternal=()=>{},takePlanApprovedFeedback=()=>null,rejectSubagentApprovalsFor=()=>{},cancelPlanApproval=()=>{};`],
  [/agentSession[\\/]host[\\/]plan\.ts$/, `export const updatePlanAfterTurn=()=>{};`],
  [/agentSession[\\/]host[\\/]connection\.ts$/, `export const ensureConnection=async(_host,entry)=>entry.connection; export const assertConnectionConfigurationCurrent=()=>{};`],
  [/agentSession[\\/]host[\\/]modelParameters\.ts$/, `export const parameterSnapshot=async()=>({values:{}});`],
  [/agentSession[\\/]host[\\/]readStateTrack\.ts$/, `export const takeReadStateHint=()=>null;`],
  [/agent[\\/]skillInject\.ts$/, `export const prepareEngineSkillText=async(text,options)=>{globalThis.__routingRequests.push({text,...options});return {text:'expanded:'+options.target, injectedIds:[]}}; export const skillTurnBook=()=>({beginTurn:()=>({}),current:()=>({}),injectedOf:()=>[],noteInjected:()=>{},endTurn:()=>{}});`],
  [/workspaceExecutionContext\.ts$/, `export const captureWorkspaceExecutionContext=()=>({roots:[],mappings:[]}); export const assertWorkspaceExecutionContextCurrent=()=>{};`],
  [/git[\\/]worktreeTaskOperation\.ts$/, `export const assertTaskWorktreeOperationIdle=()=>{};`],
  [/memory[\\/]runtime\.ts$/, `export const flushBeforeCompaction=async()=>{}; export const getMemoryService=()=>undefined,resolveMemoryWorkspaceRoot=()=>undefined;`],
  [/agentSession[\\/]host[\\/]fileChanges\.ts$/, `export const beginFileChanges=async()=>{},finishFileChanges=()=>{},markFileChangeExecution=()=>{},liveTurnRepository=()=>undefined;`],
  [/browser[\\/]turnShotCapture\.ts$/, `export const captureTurnShots=async()=>{};`]
];
try {
  await require('esbuild').build({ stdin: { contents: `export { startTurn } from './src/main/agentSession/host/turn'; export { send } from './src/main/agentSession/host/messaging';`,
    resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'isolated-host-boundaries', setup(build) {
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app={getPath:()=>${JSON.stringify(temporary)}}; export const ipcMain={handle(){},on(){}}; export const shell={},dialog={},webContents={},clipboard={},nativeImage={},protocol={},session={}; export class BrowserWindow{} export class WebContentsView{} export class Notification{}`, loader: 'js' }));
      for (const [filter, contents] of boundaries) build.onLoad({ filter }, () => ({ contents, loader: 'ts' }));
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path === 'electron') return { path: 'electron-fixture', namespace: 'fixture' };
        if (args.path.startsWith('node:') || builtinModules.includes(args.path)) return;
        return { path: import.meta.resolve(args.path), external: true };
      });
    } }] });
  const { startTurn, send } = await import(pathToFileURL(bundle).href);
  globalThis.__routingRequests = [];
  for (const [runtimeId, target] of [['claude','claude-gui'], ['codex-gui','codex-gui'], ['acp','runtime:acp'], ['pi','pi-gui']]) {
    const payloads = []; const redirects = [];
    const entry = { sessionId: `fixture-${runtimeId}`, runtimeId, cwd: temporary, closed: false, clearing: false, busy: false,
      messages: [], queue: [], assistant: null, forkTranscript: null, lastSteeredTexts: [],
      connection: { send: async text => { payloads.push(text); }, redirect: text => { redirects.push(text); return true; } } };
    const host = { entries: new Map([[entry.sessionId, entry]]), modelAdmission: { assert() {} }, ctx: { runtimes: { list: builtinHarnessFixtures }, config: { get: () => ({ workspaces: [] }) },
      sessions: { get: () => ({ id: entry.sessionId, runtime: runtimeId, cwd: temporary }), touchUsed: () => {} }, bgTasks: null } };
    await startTurn(host, entry, { text: '/skill:fixture first' });
    assert.deepEqual(payloads, [`expanded:${target}`], 'first send uses concrete engine policy: ' + entry.messages.at(-1)?.error);
    const response = await send(host, entry.sessionId, '/skill:fixture steer', undefined, { fromInject: true });
    if (runtimeId === 'pi') {
      assert.equal(response.steered, true);
      assert.deepEqual(redirects, ['expanded:' + target], 'busy redirect uses the same concrete engine policy');
    } else {
      assert.equal(response.queued, true, JSON.stringify(response));
      assert.deepEqual(redirects, []);
      assert.equal(entry.queue[0]?.text, '/skill:fixture steer');
    }
    const requests = globalThis.__routingRequests.filter(request => request.sessionId === entry.sessionId);
    assert.deepEqual(requests.map(request => request.target), [target, target]);
  }
  process.stdout.write('actual first-send and busy routing passed for Claude, Codex, ACP and Pi\n');
} finally {
  delete globalThis.__routingRequests;
  assert.equal(path.dirname(temporary), temporaryParent);
  fs.rmSync(temporary, { recursive: true, force: true });
}
