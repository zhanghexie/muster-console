// Opt in with MUSTER_TEST_CODEX_DELIVERY=1. This calls the configured Codex
// model once, using an ephemeral native thread and a local no-op tool; it never
// controls the desktop and prints no model response or tool arguments. A test-only
// proxy marks this no-op read-only; the acknowledgement callback is a test double.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeLiveProbeFixture, runWithProbeCleanup } from './helpers/live-probe-cleanup.mjs';

if (process.env.MUSTER_TEST_CODEX_DELIVERY !== '1') throw new Error('Set MUSTER_TEST_CODEX_DELIVERY=1 to run this real-model probe');
fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-live-delivery-'));
const savedTemp = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
for (const key of Object.keys(savedTemp)) process.env[key] = temp;
let mcp;
await runWithProbeCleanup(async () => {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { setupCodexHostToolsMcp } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/hostToolsMcp.ts')));
  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const { resolveCodexExecutable } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/executable.ts')));
  const { captureCodexCuaDeliverySlot } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/desktopDelivery.ts')));
  const { runAsGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  const executable = await resolveCodexExecutable({ packaged: false });
  if (!executable.ok || !executable.executable) throw new Error('Codex native executable is unavailable');
  const shim = path.resolve('out/main/inboundMcp/stdioEntry.mjs');
  if (!fs.existsSync(shim)) throw new Error('Built inbound MCP shim is unavailable');
  const readonlyProbeShim = path.resolve('test/helpers/readonly-probe-mcp.mjs');
  const lease = new AbortController(), hostTurn = 'host-probe-turn', desktopTurn = 'desktop-probe-turn';
  let calls = 0, acknowledged = 0;
  const diagnostics = [], serverRequests = [];
  const effect = { ok: true, delivery: 'foreground', effect: 'unverifiable', verification: 'not_performed' };
  const tool = { id: 'host.probe', label: 'probe', description: 'A local no-op receipt test. It does not control the computer.',
    permissionClass: 'status', resultFormat: 'execute-result-json',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    execute: async () => runAsGuiExecutionTurn({ sessionId: 'probe', turnId: hostTurn, desktopTurnId: desktopTurn,
      isCurrent: () => !lease.signal.aborted, isDesktopCurrent: () => !lease.signal.aborted }, async () => {
      calls++;
      const invocationId = randomUUID();
      const slot = captureCodexCuaDeliverySlot({ actor: { sessionId: 'probe', taskId: 'probe', turnId: desktopTurn, isCurrent: () => !lease.signal.aborted },
        hostWindowId: 'fixture', requestId: 'probe', fingerprint: 'probe', action: 'click', targetGeneration: 'fixture',
        isTargetCurrent: () => true, isCurrent: () => true }, {
        lease: { owner: 'probe', turnId: desktopTurn, signal: lease.signal, isCurrent: () => !lease.signal.aborted },
        indicatorEpoch: 1, isIndicatorCurrent: () => true, isTargetCurrent: () => true });
      await slot.stageDelivery(invocationId, effect, async () => { if (slot.lease.signal.aborted) return { outcome: 'unknown' }; acknowledged++; return { outcome: 'acknowledged' }; });
      return JSON.stringify({ ok: true, result: { outcome: 'dispatched', invocationId, ...effect } });
    }) };
  const host = { sessionId: 'probe', cwd: temp, hostTools: [tool], getTurnId: () => hostTurn,
    requestApproval: async () => ({ approved: false, reason: 'This probe allows only the local no-op tool.' }),
    getPolicyState: () => ({ mode: 'standard', planExecuting: false }), log: (_level, message) => diagnostics.push(message) };
  mcp = await setupCodexHostToolsMcp(host, { hostMcpScript: readonlyProbeShim });
  if (!mcp) throw new Error('Codex host MCP gateway is unavailable');
  mcp.configFragment.mcp_servers.muster.env.MUSTER_PROBE_INBOUND_SCRIPT = shim;
  const token = mcp.configFragment.mcp_servers.muster.env.MUSTER_HOST_TOOLS_TOKEN;
  // Observe method names and limited shape flags, never model text or tool arguments.
  const observeWorker = (...args) => {
    const child = spawn(...args), decoder = new StringDecoder('utf8');
    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered += decoder.write(chunk);
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          const frame = JSON.parse(line), value = frame?.value;
          if (frame?.type === 'app-rpc' && value?.id != null && typeof value.method === 'string' &&
              /^[a-zA-Z][a-zA-Z0-9/_-]{0,100}$/.test(value.method) && serverRequests.length < 32) {
            const request = { method: value.method };
            if (value.method === 'mcpServer/elicitation/request') {
              const params = value.params ?? {}, schema = params.requestedSchema ?? {};
              const message = typeof params.message === 'string' ? params.message : '';
              request.mode = ['form', 'openai/form', 'openaiForm', 'url'].includes(params.mode) ? params.mode : 'other';
              request.ismuster = params.serverName === 'muster';
              request.hasTurnId = typeof params.turnId === 'string' && !!params.turnId;
              request.mentionsProbe = /host_probe/i.test(message);
              request.mentionsApproval = /approv|permission|authori[sz]/i.test(message);
              request.schemaKeys = Object.keys(schema.properties ?? {}).filter(key => /^[a-zA-Z0-9_-]{1,50}$/.test(key)).slice(0, 16);
            }
            serverRequests.push(request);
          }
        } catch { /* The transport reports malformed frames. */ }
      }
      if (buffered.length > 4 * 1024 * 1024) buffered = '';
    });
    return child;
  };
  const client = createCodexAppServerClient({ executable: executable.executable, env: process.env, host, ephemeral: true,
    permissionMode: 'standard', hostMcpConfig: mcp.configFragment, expectedTools: mcp.catalog.tools.map(item => item.name),
    desktopDelivery: mcp.desktopDelivery }, { workerPath: path.resolve('src/main/agentSession/drivers/codex/worker/native-worker.mjs'),
    jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1'), spawnProcess: observeWorker });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110_000);
  let completed = false;
  const eventSummary = [];
  try {
    const thread = client.startThread({ workingDirectory: temp, model: 'gpt-6.1-terra', modelReasoningEffort: 'max' });
    const { events } = await thread.runStreamed('Use the MCP tool mcp__muster__host_probe exactly once with arguments {"value":"receipt-check"}. This is a harmless local no-op tool needed for this test. Then reply done. Do not run commands, inspect files, or use other tools.', { signal: controller.signal });
    for await (const event of events) {
      if (event.type === 'turn.completed') completed = true;
      if ((event.type === 'item.started' || event.type === 'item.completed') && event.item?.type === 'mcp_tool_call') {
        const error = event.item.error ? JSON.stringify(event.item.error).split(token).join('[redacted]').slice(0, 800) : undefined;
        eventSummary.push({ type: event.type, server: event.item.server, tool: event.item.tool, status: event.item.status, ...(error ? { error } : {}) });
      }
    }
  } finally { clearTimeout(timer); }
  assert.equal(completed, true, 'The real Codex turn did not complete');
  assert.equal(calls, 1, `The real model did not call the no-op tool exactly once; tool events: ${JSON.stringify(eventSummary)}; server requests: ${JSON.stringify(serverRequests)}`);
  assert.equal(acknowledged, 1, `The exact app-server result was not acknowledged (${diagnostics.join('; ').slice(0, 400)})`);
  console.log('CODEX_REAL_DELIVERY_OK: actual app-server result matched a read-only no-op; acknowledgement is a test callback');
}, async () => {
  try { mcp?.close(); }
  finally {
    for (const [key, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await removeLiveProbeFixture(temp);
  }
});
