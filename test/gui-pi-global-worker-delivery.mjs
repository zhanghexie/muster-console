/** Production workerHost + Pi worker, local SSE, real gateway/Cua and global SQLite evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Type } from '@earendil-works/pi-ai';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd(), prefix = 'gui-pi-global-worker-delivery-';
const missingId = process.env.GUI_PI_GLOBAL_MISSING_ID === '1';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix)), bundleDir = path.join(tmp, 'bundle', 'pi');
fs.mkdirSync(bundleDir, { recursive: true });
const abs = relative => path.join(root, relative).replaceAll('\\', '/');
const wrapper = path.join(tmp, 'entry.ts');
fs.writeFileSync(wrapper, [
  `export { createPiWorkerConnection } from '${abs('src/main/agentSession/drivers/pi/workerHost.ts')}';`,
  `export { captureGuiPiCuaDeliverySlot } from '${abs('src/main/agentSession/drivers/pi/desktopDelivery.ts')}';`,
  `export { setSkillsManagementService } from '${abs('src/main/capabilityManagement/runtimeSkills.ts')}';`,
  `export { DesktopActivityRuntime } from '${abs('src/main/desktop/desktopActivityRuntime.ts')}';`,
  `export { CuaSemanticRuntime } from '${abs('src/main/desktop/cuaSemanticRuntime.ts')}';`,
  `export { createCuaVisibleAction } from '${abs('src/main/desktop/cuaVisibleAction.ts')}';`,
  `export { GlobalDesktopWriteBarrier } from '${abs('src/main/desktop/globalDesktopWriteBarrier.ts')}';`,
  `export { GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId } from '${abs('src/main/desktop/globalVisibleActionDispatcher.ts')}';`,
  `export { createGlobalDeliveryEvidenceVault } from '${abs('src/main/desktop/globalDeliveryEvidenceVault.ts')}';`
].join('\n'));
await build({ entryPoints: [wrapper], bundle: true, platform: 'node', format: 'cjs', packages: 'external',
  outfile: path.join(bundleDir, 'host.cjs'), logLevel: 'silent' });
await build({ entryPoints: [path.join(root, 'src/main/agentSession/drivers/pi/worker.ts')], bundle: true,
  platform: 'node', format: 'cjs', packages: 'external', outfile: path.join(bundleDir, 'worker.cjs'), logLevel: 'silent',
  plugins: missingId ? [{ name: 'omit-native-tool-id', setup(builder) {
    builder.onLoad({ filter: /childDesktopDelivery\.ts$/ }, args => {
      const source = fs.readFileSync(args.path, 'utf8');
      const needle = 'invoke({ id, args, toolCallId,';
      assert.ok(source.includes(needle), 'the fixture must actually strip the private IPC call identity');
      return { contents: source.replace(needle, 'invoke({ id, args, toolCallId: undefined,'), loader: 'ts', resolveDir: path.dirname(args.path) };
    });
  } }] : [] });
if (process.platform === 'win32') {
  const guardian = path.join(tmp, 'bundle', 'codex', 'worker'); fs.mkdirSync(guardian, { recursive: true });
  fs.copyFileSync(path.join(root, 'src/main/agentSession/drivers/codex/worker/windows-job.ps1'), path.join(guardian, 'windows-job.ps1'));
}
const require = createRequire(import.meta.url), Module = require('node:module'), originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.apply(this, arguments);
};
const { createPiWorkerConnection, captureGuiPiCuaDeliverySlot, setSkillsManagementService,
  DesktopActivityRuntime, CuaSemanticRuntime, createCuaVisibleAction,
  GlobalDesktopWriteBarrier, GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId, createGlobalDeliveryEvidenceVault } =
  require(path.join(bundleDir, 'host.cjs'));
setSkillsManagementService({ additionalSkillPaths: () => [], prepareRuntimeSkillFilter: async () => skills => skills });

let requests = 0;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    const request = JSON.parse(body), first = !request.messages.some(message => message.role === 'tool');
    requests++;
    const chunk = (delta, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 0,
      model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
    const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (first) {
      send(chunk({ tool_calls: [{ index: 0, id: 'call-worker-1', type: 'function',
        function: { name: 'host_desktop_act', arguments: '{"requestId":"first"}' } }] }));
      send(chunk({}, 'tool_calls'));
    } else { send(chunk({ role: 'assistant', content: 'done' })); send(chunk({}, 'stop')); }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const userData = path.join(tmp, 'userdata'), home = path.join(userData, 'muster-core');
fs.mkdirSync(home, { recursive: true });
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
fs.writeFileSync(path.join(home, 'models.json'), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-fixture',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512, cost }]
} } }));
fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ fixture: { type: 'api_key', key: 'offline-fixture' } }));
const owner = 'fixture', desktopTurn = 'desktop-turn', taskId = 'task';
let barrier;
const vault = createGlobalDeliveryEvidenceVault(() => barrier.inspect());
const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
  legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
  verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
barrier = await GlobalDesktopWriteBarrier.activate({ root: path.join(tmp, 'global'), legacyRoots: [], legacyOutboxes: [], fence,
  authority: { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyDelivery: vault.verifier.verifyDelivery, executorStopped: () => true, verifyRecovery: () => true, verifyAbandonedLock: () => true } });
const dispatcher = new GlobalVisibleActionDispatcher(barrier, {
  resolveLogicalOperationId: value => scopedGlobalVisibleRequestId(value.sessionId, value.taskId, value.requestId),
  classifyResult: (_request, value) => ({ outcome: 'known', value }), deliveryEvidence: vault.verifier.deliveryEvidence
});
const activity = new DesktopActivityRuntime({ labels: { active: 'Using', stopping: 'Stopping', unknown: 'Unknown',
  escape: 'Esc', stop: 'Stop', escapeUnavailable: 'Use button' },
  createIndicator: () => ({ show: async () => {}, close() {} }), releaseAll: async () => {} });
let active = true, lease, calls = 0, acknowledgements = 0, connection;
const diagnostics = [];
const actor = { sessionId: owner, taskId, turnId: desktopTurn, isCurrent: () => active };
const persist = createCuaVisibleAction(dispatcher, request => {
  const slot = captureGuiPiCuaDeliverySlot(request, { lease, indicatorEpoch: activity.visibilityEpoch(),
    isIndicatorCurrent: epoch => activity.visibilityEpoch() === epoch, isTargetCurrent: () => active });
  return { ...slot, stageDelivery(id, value, acknowledge) {
    return slot.stageDelivery(id, value, async receipt => { acknowledgements++; return acknowledge(receipt); });
  } };
});
const semantic = new CuaSemanticRuntime({ resolveTarget: () => ({ pid: 12, windowId: 34, generation: 'fixture-generation', isCurrent: () => active }),
  createConnection: () => ({ async connect() {}, async setValueDelivery() { return 'mode-parameter'; },
    async call(name) {
      if (name === 'get_window_state') return { structuredContent: { pid: 12, window_id: 34, snapshot_id: 's00000001',
        elements_complete: true, elements: [{ element_token: 's00000001:0', role: 'Button', label: 'Open', actions: ['invoke'] }] } };
      calls++; return { structuredContent: { effect: 'confirmed' } };
    }, async close() {} }), runPersistedAction: persist });
activity.turns.noteUserInstruction(owner, 'message');
activity.turns.begin(owner, desktopTurn, () => active, true, 'message');
const tool = { id: 'host.desktop.act', label: 'desktop', description: 'offline fixture', permissionClass: 'write',
  resultFormat: 'execute-result-json', parameters: Type.Object({ requestId: Type.String() }),
  async execute(args, ctx) {
    const page = await activity.turns.use(owner, desktopTurn, 'window', signal => semantic.observe(actor, 'window', signal), false);
    const result = await activity.turns.use(owner, desktopTurn, 'window', (seatSignal, currentLease) => {
      lease = currentLease;
      return semantic.act(actor, { snapshotId: page.snapshotId, ref: page.elements[0].ref,
        requestId: args.requestId, action: 'click' }, AbortSignal.any([ctx.signal, seatSignal]));
    });
    return JSON.stringify({ ok: true, result });
  } };
try {
  connection = await createPiWorkerConnection({ sessionId: owner, cwd: tmp, systemPromptAppend: '', nativeTools: [],
    modeController: { mode: 'auto', executing: false, planSteps: [] }, hostTools: [tool],
    getTurnId: () => active ? 'host-turn' : undefined, getDesktopTurnId: () => active ? desktopTurn : undefined,
    getPolicyState: () => ({ mode: 'auto', planExecuting: false }), requestApproval: async () => ({ approved: true }),
    log: (level, message) => diagnostics.push(`${level}: ${message}`) },
  { ctx: { usage: { recordModelCall() {} } }, userDataDir: userData, providerId: 'fixture', modelId: 'fixture',
    shellEnv: { settings: { retry: { enabled: false }, compaction: { enabled: false } }, bashAvailable: true }, secrets: [],
    globalDelivery: { stager: vault.stager, issuer: vault.issuer, inspectMarker: () => barrier.inspect() } });
  await connection.send('Run the offline fixture.');
  const events = [];
  for await (const event of connection.events) {
    events.push(event);
    if (event.type === 'turn-complete' || event.type === 'error') break;
  }
  assert.equal(events.at(-1)?.type, 'turn-complete', JSON.stringify({ events, diagnostics }));
  assert.equal(calls, missingId ? 0 : 1, 'missing native Pi call identity must reject before the desktop backend');
  assert.equal(acknowledgements, missingId ? 0 : 1); assert.equal(requests, 2);
  assert.equal(JSON.stringify(events).includes('desktopDeliveryProof'), false);
  assert.equal(JSON.stringify(events).includes('deliveryToken'), false);
  assert.equal(barrier.inspect(), null, 'only the real Pi tracker receipt clears the global SQLite marker');
  if (missingId) console.log('gui-pi-global-worker-delivery: missing native IPC call identity is rejected before dispatch');
} finally {
  active = false;
  await connection?.close(); await semantic.close(); await activity.dispose(); vault.close(); barrier.close();
  await new Promise(resolve => server.close(resolve)); setSkillsManagementService(undefined); Module._load = originalLoad;
  removeWorkspaceFixture(tmp, prefix);
}
if (!missingId) {
  const child = spawnSync(process.execPath, [process.argv[1]], { cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, GUI_PI_GLOBAL_MISSING_ID: '1' } });
  assert.equal(child.status, 0, `missing identity regression failed: ${child.stderr}`);
  assert.match(child.stdout, /missing native IPC call identity is rejected/);
  console.log('gui-pi-global-worker-delivery: real supervisor, local SSE, global SQLite and missing native ID passed');
}
