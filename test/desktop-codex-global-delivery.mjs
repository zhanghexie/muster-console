import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-global-delivery-'));
const opened = new Set();
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { GlobalDesktopWriteBarrier } = await import(pathToFileURL(compile('main/desktop/globalDesktopWriteBarrier.ts')));
  const { GlobalVisibleActionDispatcher, scopedGlobalVisibleRequestId } = await import(pathToFileURL(compile('main/desktop/globalVisibleActionDispatcher.ts')));
  const { createGlobalDeliveryEvidenceVault } = await import(pathToFileURL(compile('main/desktop/globalDeliveryEvidenceVault.ts')));
  const { setupCodexHostToolsMcp } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/hostToolsMcp.ts')));
  const { captureCodexCuaDeliverySlot, captureCodexWin32DeliverySlot } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/desktopDelivery.ts')));
  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const { runAsGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const fence = { isQuiescent: () => true, allLegacyRootsEnumerated: () => true, allOutboxesEnumerated: () => true,
    legacyWritersPermanentlyExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
    verifyLegacyDelivery: () => true, verifyLegacyResolution: () => true };
  const hostTurn = 'host-turn', desktopTurn = 'desktop-turn', fingerprint = 'a'.repeat(64);

  // Real SQLite, actual host gateway and app-server transport. The worker below
  // is a deterministic app-server substitute; it does not call a real model.
  for (const [scenario, kind] of [['success', 'cua'], ['success-win32', 'win32'], ['early-native-event', 'cua'], ['wrong-arguments', 'cua'],
    ['wrong-result', 'cua'], ['gateway-only', 'cua'], ['model-text', 'cua'], ['cancel', 'cua'],
    ['cancel-inflight', 'cua'], ['gateway-result-mismatch', 'cua']]) {
    const root = path.join(temp, `data-${scenario}`), home = path.join(temp, `home-${scenario}`);
    fs.mkdirSync(home);
    const lease = new AbortController(), diagnostics = [], bindings = [];
    let barrier, mcp, calls = 0, earlyAcks = 0, engineAcks = 0, issued = 0, gatewayError;
    const vault = createGlobalDeliveryEvidenceVault(() => barrier.inspect());
    const authority = { legacyWritersExcluded: () => true, legacyAutomaticContinuationsExcluded: () => true,
      verifyDelivery: vault.verifier.verifyDelivery, executorStopped: () => true, verifyRecovery: () => true, verifyAbandonedLock: () => true };
    barrier = await GlobalDesktopWriteBarrier.activate({ root, legacyRoots: [], legacyOutboxes: [], fence, authority });
    const close = () => { mcp?.close(); vault.close(); barrier.close(); opened.delete(close); };
    opened.add(close);
    const dispatcher = new GlobalVisibleActionDispatcher(barrier, {
      resolveLogicalOperationId: r => scopedGlobalVisibleRequestId(r.sessionId, r.taskId, r.requestId),
      classifyResult: (_request, value) => ({ outcome: 'known', value }), deliveryEvidence: vault.verifier.deliveryEvidence
    });
    const globalDelivery = {
      stager: { ...vault.stager, bindOutput(stage, input) { bindings.push(input.binding); vault.stager.bindOutput(stage, input); } },
      issuer: { withVerifiedEvent(stage, observed, acknowledge) { issued++; return vault.issuer.withVerifiedEvent(stage, observed, acknowledge); } },
      inspectMarker: () => barrier.inspect()
    };
    const actor = { sessionId: 'fixture', taskId: 'task', turnId: desktopTurn, isCurrent: () => !lease.signal.aborted };
    const effect = kind === 'cua'
      ? { ok: true, delivery: 'foreground', effect: 'unverifiable', verification: 'not_performed' }
      : { delivery: 'dispatched', effect: 'unverifiable', verification: 'not_performed', pid: 42 };
    const tool = { id: 'host.probe', label: 'probe', description: 'A simulated, non-desktop action.', permissionClass: 'status',
      resultFormat: 'execute-result-json', parameters: { type: 'object', properties: { requestId: { type: 'string' } },
        required: ['requestId'], additionalProperties: false },
      execute: async args => runAsGuiExecutionTurn({ sessionId: 'fixture', turnId: hostTurn, desktopTurnId: desktopTurn,
        isCurrent: () => true, isDesktopCurrent: () => !lease.signal.aborted }, async () => {
        const slotContext = { lease: { owner: 'fixture', turnId: desktopTurn, signal: lease.signal, isCurrent: () => !lease.signal.aborted },
          indicatorEpoch: 1, isIndicatorCurrent: () => true, isTargetCurrent: () => true, onUnknown() {} };
        const slot = kind === 'cua' ? captureCodexCuaDeliverySlot({ actor, hostWindowId: 'window', requestId: args.requestId,
          fingerprint, action: 'click', targetGeneration: 'generation', isTargetCurrent: () => true, isCurrent: () => true }, slotContext)
          : captureCodexWin32DeliverySlot(actor, slotContext);
        const actionContext = { sessionId: actor.sessionId, taskId: actor.taskId, target: 'window', action: 'cua.click', indicatorEpoch: 1,
          isCurrent: slot.lease.isCurrent, isIndicatorCurrent: () => true, signal: slot.lease.signal };
        const dispatched = await dispatcher.run(actionContext, args.requestId, fingerprint, async () => { calls++; return effect; });
        assert.equal(dispatched.reply.outcome, 'dispatched');
        await slot.stageDelivery(dispatched.reply.invocationId, dispatched.reply.value, async () => {
          engineAcks++;
          if (scenario === 'cancel-inflight') lease.abort();
          return dispatched.acknowledge();
        });
        const premature = await dispatched.acknowledge();
        assert.equal(premature.outcome, 'unknown'); earlyAcks++;
        assert.equal(barrier.inspect().operationId, dispatched.reply.invocationId);
        const body = kind === 'cua' ? { outcome: 'dispatched', ...effect, invocationId: dispatched.reply.invocationId }
          : { outcome: 'dispatched', invocationId: dispatched.reply.invocationId, value: effect };
        if (scenario === 'gateway-result-mismatch') body.effect = 'altered';
        return JSON.stringify({ ok: true, result: body });
      }) };
    const host = { sessionId: 'fixture', cwd: temp, hostTools: [tool], getTurnId: () => hostTurn,
      requestApproval: async () => ({ approved: false }), getPolicyState: () => ({ mode: 'auto', planExecuting: false }),
      log: (_level, text) => diagnostics.push(text) };
    mcp = await setupCodexHostToolsMcp(host, { hostMcpScript: path.resolve('test/helpers/readonly-probe-mcp.mjs'), globalDelivery });
    assert.ok(mcp);
    const config = mcp.configFragment.mcp_servers.muster.env;
    const nativeItemId = `native-item-${scenario}`, worker = path.join(temp, `worker-${scenario}.mjs`), trace = path.join(temp, `trace-${scenario}.json`);
    fs.writeFileSync(worker, `
import readline from 'node:readline';
import fs from 'node:fs';
const send = value => console.log(JSON.stringify(value));
const rpc = value => send({type:'app-rpc',value});
send({type:'ready'});
readline.createInterface({input:process.stdin}).on('line', async line => {
  const msg = JSON.parse(line);
  if (msg.type === 'identity-challenge') return send({type:'identity-response',nonce:msg.nonce});
  if (msg.type === 'abort') return process.exit(0);
  if (msg.type !== 'app-rpc' || !msg.value.id) return;
  const q = msg.value;
  if (q.method === 'turn/start') {
    if (${JSON.stringify(scenario)}!=='early-native-event') rpc({id:q.id,result:{turn:{id:'native-turn'}}});
    const args={requestId:${JSON.stringify(scenario)}};
    const response=await fetch(${JSON.stringify(config.MUSTER_HOST_TOOLS_URL)}, {method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({token:${JSON.stringify(config.MUSTER_HOST_TOOLS_TOKEN)},name:'host_probe',arguments:args})});
    const result=await response.json();
    fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({isError:!!result.isError}));
    const eventArgs=${JSON.stringify(scenario)}==='wrong-arguments'?{requestId:'different'}:args;
    const text=${JSON.stringify(scenario)}==='wrong-result'?result.text+' changed':result.text;
    const item={id:${JSON.stringify(nativeItemId)},type:${JSON.stringify(scenario)}==='model-text'?'agentMessage':'mcpToolCall',server:'muster',tool:'host_probe',arguments:eventArgs,
      status:'completed',error:null,result:{content:[{type:'text',text}],structuredContent:null,_meta:null}};
    if (${JSON.stringify(scenario)}!=='gateway-only') rpc({method:'item/completed',params:{threadId:'thread',turnId:'native-turn',item}});
    if (${JSON.stringify(scenario)}==='early-native-event') rpc({id:q.id,result:{turn:{id:'native-turn'}}});
    if (${JSON.stringify(scenario)}==='success') rpc({method:'item/completed',params:{threadId:'thread',turnId:'native-turn',item}});
    rpc({method:'turn/completed',params:{threadId:'thread',turn:{id:'native-turn',status:'completed'}}});
    return;
  }
  let result={};
  if (q.method==='initialize') result={userAgent:'codex/0.166.0',codexHome:${JSON.stringify(home)}};
  if (q.method === 'permissionProfile/list') result = {data:[{id:':workspace',allowed:true}],nextCursor:null};
  if (q.method==='thread/start') result={thread:{id:'thread'},approvalPolicy:'never',approvalsReviewer:'user',sandbox:{type:'dangerFullAccess'}};
  if (q.method==='mcpServerStatus/list') result={data:[{name:'muster',runtimeStatus:'connected',tools:{}}]};
  rpc({id:q.id,result});
});
`);
    const bridge = mcp.desktopDelivery;
    const delivery = { begin: bridge.begin.bind(bridge), bind: bridge.bind.bind(bridge), end: bridge.end.bind(bridge),
      async observe(turn, event) { if (scenario === 'cancel') lease.abort(); await bridge.observe(turn, event); } };
    const client = createCodexAppServerClient({ executable: process.execPath, env: { ...process.env, CODEX_HOME: home }, host,
      hostMcpConfig: mcp.configFragment, expectedTools: [], desktopDelivery: delivery },
    { workerPath: worker, jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1') });
    const { events } = await client.startThread({ workingDirectory: temp }).runStreamed('fixture');
    let finished = false;
    for await (const event of events) if (event.type === 'turn.completed') finished = true;
    assert.equal(finished, true, scenario);
    gatewayError = JSON.parse(fs.readFileSync(trace, 'utf8')).isError;
    assert.equal(calls, 1, scenario); assert.equal(earlyAcks, 1, scenario);
    if (scenario === 'success' || scenario === 'success-win32' || scenario === 'early-native-event') {
      assert.equal(gatewayError, false);
      assert.equal(engineAcks, 1, 'one actual matching fixture event may acknowledge only once');
      assert.equal(issued, 1);
      assert.equal(barrier.inspect(), null);
      assert.equal(bindings.length, 1);
      assert.match(bindings[0].toolCallId, /^acp-mcp-/);
      assert.notEqual(bindings[0].toolCallId, nativeItemId, 'gateway identity is not the native item identity');
      const db = new DatabaseSync(path.join(root, 'global-desktop-write.sqlite'), { readOnly: true });
      assert.equal(db.prepare('SELECT phase FROM global_desktop_history').get().phase, 'confirmed'); db.close();
    } else {
      assert.equal(engineAcks, scenario === 'cancel-inflight' ? 1 : 0, scenario);
      assert.equal(issued, scenario === 'cancel-inflight' ? 1 : 0, scenario);
      assert.equal(barrier.inspect().phase, 'known', `${scenario}: unconfirmed result must retain the durable marker`);
      if (scenario === 'gateway-result-mismatch') assert.equal(gatewayError, true);
    }
    close();
  }
  console.log('Codex global delivery: real SQLite and gateway with simulated app-server; mismatch, cancellation and replay passed');
} finally {
  for (const close of opened) { try { close(); } catch {} }
  removeWorkspaceFixture(temp, 'codex-global-delivery-');
}
