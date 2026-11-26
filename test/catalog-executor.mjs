/** Native Catalog execution: confirmation and handler share the canonical name and arguments. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-executor-'));
const compile = createSharedCompiler(root, tmp);
try {
  const entry = compile('main/capabilities/executor.ts');
  const source = fs.readFileSync(path.join(root, 'src/main/capabilities/executor.ts'), 'utf8');
  // Keep the real automations handler; stub unrelated host modules to isolate external dependencies.
  for (const [, exports, filename] of source.matchAll(/import \{ ([^}]+) \} from '\.\/hosts\/([^']+)';/g)) {
    if (filename === 'services' || filename === 'desktop') continue;
    const body = exports.split(',').map((name) => `export const ${name.trim()} = {};`).join('\n');
    fs.writeFileSync(path.join(tmp, `main/capabilities/hosts/${filename}.mjs`), body);
  }
  const { executeTool, serializeModelToolResult, serializeResult } = await import(pathToFileURL(entry).href);
  const confirmations = [], effects = [], reviews = [];
  let allowed = false;
  const ctx = {
    effects, resolveBubbleWorkspaceId: () => 'ws', isOrchestratorBusy: () => true,
    workspaces: {list: () => [{id:'ws',name:'Workspace'}]},
    sessions: {list: () => []}, tasks: {get: () => ({name:'Scheduled report'}), enable: (id) => effects.push([id,true]), disable: (id) => effects.push([id,false]), update: (id, value) => { effects.push([id, value]); return value; }},
    safety: {authorize: async input => { reviews.push(input); return {allowed, cancelled: !allowed, reason: allowed ? 'reviewed' : 'denied'}; }},
    ui: {confirm: async (...args) => {confirmations.push(args);return false;}}
  };
  const args = JSON.stringify({automationId:'a',enabled:false});
  const result = await executeTool(ctx,'automations.setEnabled',args);
  assert.equal(result.ok,true);
  assert.deepEqual(effects,[['a',false]]);
  assert.deepEqual(result.result,{enabled:false,automationId:'a'});
  await executeTool(ctx,'automations.setEnabled',JSON.stringify({automationId:'a',enabled:true}));
  assert.deepEqual(effects,[['a',false],['a',true]]);
  const removed = await executeTool(ctx,'services.enable',JSON.stringify({serviceId:'a'}));
  assert.equal(removed.ok,false,'removed tool cannot reach confirmation or dispatch');
  const bad = await executeTool(ctx,'automations.setEnabled',JSON.stringify({automationId:'a',enabled:'false'}));
  assert.equal(bad.ok,false);
  assert.equal(effects.length,2,'invalid public argument cannot fall through to legacy behavior');
  assert.equal(reviews.length,0,'routine enable/disable does not require the independent high-risk review');
  const highRisk = JSON.stringify({automationId:'a',prompt:'new instructions'});
  const cancelled = await executeTool(ctx,'automations.update',highRisk);
  assert.equal(cancelled.cancelled,true);
  assert.equal(effects.length,2,'denied prompt update must not reach the handler');
  assert.equal(reviews[0].action,'automations.update');
  assert.equal(reviews[0].args.prompt,'new instructions');
  allowed = true;
  assert.equal((await executeTool(ctx,'automations.update',highRisk)).ok,true);
  assert.deepEqual(effects.at(-1),['a',{prompt:'new instructions'}]);
  assert.equal(confirmations.length,0,'the independent reviewer decided without a fallback dialog');
  const { runAsAgentWorkspace, runAsSchedulerTool } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const workspace = { id: 'ws', name: 'Workspace', path: tmp, controlRoot: tmp, defaultRootId: 'root', rootsRevision: 1,
    roots: [{ id: 'root', path: tmp }] };
  const desktopCtx = { ...ctx, config: { get: () => ({ activeWorkspaceId: 'ws', workspaces: [workspace] }) } };
  const runDesktop = (context, params) => runAsAgentWorkspace('ws', () => runAsSchedulerTool(
    () => executeTool(context, 'desktop.run', JSON.stringify(params))));
  const unavailable = { action: 'look', params: { surfaceId: 'display', ...(process.platform === 'win32' ? { mode: 'semantic', windowId: 'window' } : {}) } };
  const failedLook = await runDesktop(desktopCtx, unavailable);
  assert.equal(failedLook.ok, false, 'unsupported screenshot must fail at the public envelope');
  assert.equal(failedLook.code, 'capability_unsupported');
  for (const serialized of [serializeResult(failedLook), serializeModelToolResult(failedLook, 'host.desktop.run', unavailable)]) {
    const reply = JSON.parse(serialized);
    assert.equal(reply.ok, false);
    assert.equal(reply.code, 'capability_unsupported');
    assert.equal(reply.result.ok, false, 'older callers retain the operation details');
  }
  const list = await runDesktop(desktopCtx, { action: 'list', params: { view: 'applications' } });
  assert.equal(list.ok, false);
  assert.equal(list.code, 'capability_unsupported');
  if (process.platform === 'darwin') {
    const screenshot = await runDesktop({ ...desktopCtx, desktopScreen: () => assert.fail('must not capture when permissions are missing'),
      desktopTurns: () => assert.fail('must not start visible work when permissions are missing'),
      desktopMac: { status: () => ({ permissions: { screenRecording: false, accessibility: true } }) } }, unavailable);
    assert.equal(screenshot.ok, false);
    assert.equal(screenshot.code, 'permission_required');
    assert.deepEqual(screenshot.result.permissions, ['screenRecording']);
  }
  console.log('catalog-executor: ok');
} finally {
  assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('catalog-executor-'));
  fs.rmSync(tmp,{recursive:true,force:true});
}
