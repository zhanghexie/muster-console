// Opt in with MUSTER_TEST_CODEX_IMAGE=1. A real Codex model reads a synthetic
// screenshot through the host MCP gateway; no desktop or other user data is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { acquireTestLease } from './helpers/lease.mjs';
import { removeLiveProbeFixture, runWithProbeCleanup } from './helpers/live-probe-cleanup.mjs';
import { DESKTOP_IMAGE_EVENT_SUMMARY } from '../src/main/agentSession/drivers/codex/worker/appServerOutput.mjs';

if (process.env.MUSTER_TEST_CODEX_IMAGE !== '1') throw new Error('Set MUSTER_TEST_CODEX_IMAGE=1 for the real-model image probe');
acquireTestLease(process.cwd());
fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-live-image-'));
const savedTemp = Object.fromEntries(['TMPDIR', 'TEMP', 'TMP'].map(key => [key, process.env[key]]));
for (const key of Object.keys(savedTemp)) process.env[key] = temp;
let mcp;
await runWithProbeCleanup(async () => {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { setupCodexHostToolsMcp } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/hostToolsMcp.ts')));
  const { createCodexAppServerClient } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/appServerTransport.ts')));
  const { resolveCodexExecutable } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/executable.ts')));
  const { stageDesktopCaptureImage } = await import(pathToFileURL(compile('main/desktop/captureImageScope.ts')));
  const executable = await resolveCodexExecutable({ packaged: false });
  if (!executable.ok || !executable.executable) throw new Error('Codex native executable is unavailable');
  const shim = compile('main/inboundMcp/stdioEntry.ts');
  const code = String(randomInt(10000, 99999));
  const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="520" height="220"><rect width="100%" height="100%" fill="white"/><text x="50%" y="60%" text-anchor="middle" font-family="Arial" font-size="128" fill="black">${code}</text></svg>`);
  const large = process.env.MUSTER_TEST_CODEX_LARGE_IMAGE === '1';
  const image = large
    ? await sharp(randomBytes(1000 * 800 * 3), { raw: { width: 1000, height: 800, channels: 3 } })
      .composite([{ input: label, left: 240, top: 290 }]).png().toBuffer()
    : await sharp(label).png().toBuffer();
  if (large) assert.ok(image.length > 1024 * 1024, 'The large image probe must exceed the original native event limit');
  let workerPath = path.resolve('src/main/agentSession/drivers/codex/worker/native-worker.mjs');
  const diagnosticPath = path.join(temp, 'large-event-shape.jsonl');
  if (large) {
    const dir = path.join(temp, 'worker'); fs.mkdirSync(dir);
    const source = fs.readFileSync(workerPath, 'utf8');
    const marker = 'const frameBytes = Buffer.byteLength(frame);';
    if (!source.includes(marker)) throw new Error('The worker diagnostic hook could not be placed');
    const diagnostic = `
      if (frameBytes > 1024 * 1024) try {
        const value = JSON.parse(frame), item = value?.params?.item, result = item?.result;
        const safeKeys = object => object && typeof object === 'object' && !Array.isArray(object)
          ? Object.keys(object).filter(key => ['id','method','params','result','error','threadId','turnId','item','type','server','tool','status','content','structuredContent','_meta','data','mimeType','text'].includes(key)) : [];
        const shape = { frameBytes, method: /^[A-Za-z][A-Za-z0-9/_.-]{0,80}$/.test(value?.method ?? '') ? value.method : 'other',
          rootKeys: safeKeys(value), paramsKeys: safeKeys(value?.params), itemKeys: safeKeys(item), resultKeys: safeKeys(result),
          itemType: ['mcpToolCall','agentMessage','commandExecution'].includes(item?.type) ? item.type : 'other',
          hostTool: item?.server === 'muster' && item?.tool === 'host_desktop_look',
          failed: item?.status === 'failed', hasError: !!item?.error, isError: result?.isError === true,
          parts: Array.isArray(result?.content) ? result.content.map(part => ({ type: ['image','text'].includes(part?.type) ? part.type : 'other',
            keys: safeKeys(part), dataChars: typeof part?.data === 'string' ? part.data.length : 0, png: part?.mimeType === 'image/png',
            textChars: typeof part?.text === 'string' ? part.text.length : 0, startsJson: typeof part?.text === 'string' && part.text.startsWith('{'),
            hasPngHeader: typeof part?.text === 'string' && part.text.includes('iVBORw0KGgo'),
            markers: typeof part?.text === 'string' ? ['error','large','limit','truncat','image','json','fetch','invalid','exceed'].filter(word => part.text.toLowerCase().includes(word)) : [] })) : [] };
        fs.appendFileSync(${JSON.stringify(diagnosticPath)}, JSON.stringify(shape) + '\\n');
      } catch { /* never include native event contents in diagnostics */ }
    `;
    fs.copyFileSync(path.resolve('src/main/agentSession/drivers/codex/worker/appServerOutput.mjs'), path.join(dir, 'appServerOutput.mjs'));
    workerPath = path.join(dir, 'native-worker.mjs');
    fs.writeFileSync(workerPath, `import fs from 'node:fs';\n${source.replace(marker, `${marker}${diagnostic}`)}`);
  }
  let calls = 0, sawImageEvent = false, sawImageToolFailure = false;
  const hostTurn = 'host-image-probe';
  const tool = { id: 'host.desktop.look', label: 'Synthetic screenshot', description: 'Return a synthetic test image with a five-digit code. It does not capture or control the computer.',
    permissionClass: 'status', resultFormat: 'execute-result-json', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => { calls++; stageDesktopCaptureImage(image, () => true); return JSON.stringify({ ok: true, result: { fixture: true } }); } };
  const host = { sessionId: 'image-probe', cwd: temp, hostTools: [tool], getTurnId: () => hostTurn,
    requestApproval: async () => ({ approved: false, reason: 'Only the local fixture is permitted.' }),
    getPolicyState: () => ({ mode: 'standard', planExecuting: false }), log() {} };
  mcp = await setupCodexHostToolsMcp(host, { hostMcpScript: shim });
  if (!mcp) throw new Error('Codex host MCP gateway is unavailable');
  mcp.configFragment.mcp_servers.muster.tools = { host_desktop_look: { approval_mode: 'approve' } };
  const observeWorker = (...args) => {
    const child = spawn(...args), decoder = new StringDecoder('utf8');
    let buffered = '';
    child.stdout.on('data', chunk => {
      buffered += decoder.write(chunk);
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        try {
          const frame = JSON.parse(line), item = frame?.value?.params?.item;
          if (frame?.type === 'app-rpc' && frame.value?.method === 'item/completed' && item?.type === 'mcpToolCall' && item.tool === 'host_desktop_look') {
            sawImageEvent ||= Array.isArray(item.result?.content) && item.result.content.some(part => part?.type === 'text' && part.text === DESKTOP_IMAGE_EVENT_SUMMARY);
            sawImageToolFailure ||= item.status === 'failed' || !!item.error;
          }
        } catch { /* the transport reports malformed frames */ }
      }
      if (buffered.length > 2 * 1024 * 1024) buffered = '';
    });
    return child;
  };
  const client = createCodexAppServerClient({ executable: executable.executable, env: process.env, host, ephemeral: true,
    permissionMode: 'standard', hostMcpConfig: mcp.configFragment, expectedTools: mcp.catalog.tools.map(item => item.name),
    desktopDelivery: mcp.desktopDelivery }, { workerPath,
    jobPath: path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1'), spawnProcess: observeWorker });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 110_000);
  let completed = false, answer = '';
  try {
    const thread = client.startThread({ workingDirectory: temp, model: 'gpt-6.1-terra', modelReasoningEffort: 'max' });
    const { events } = await thread.runStreamed('Call mcp__muster__host_desktop_look exactly once with {}. Read the five-digit code in its synthetic image and reply with only those digits. Do not run commands, inspect files, or use other tools.', { signal: controller.signal });
    for await (const event of events) {
      if (event.type === 'turn.completed') completed = true;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text ?? '';
    }
  } catch (error) {
    if (large && fs.existsSync(diagnosticPath)) console.error('CODEX_LARGE_IMAGE_EVENT_SHAPE', fs.readFileSync(diagnosticPath, 'utf8').trim());
    throw error;
  } finally { clearTimeout(timer); }
  assert.equal(completed, true, 'The real Codex turn did not complete');
  assert.equal(calls, 1, 'The model did not call the synthetic screenshot tool exactly once');
  assert.equal(sawImageToolFailure, false, 'Codex reported a screenshot tool failure');
  assert.equal(sawImageEvent, true, 'The native completion event did not contain the image block');
  assert.equal(answer.trim(), code, 'The model did not read the random five-digit image code');
  console.log(`${large ? 'CODEX_REAL_LARGE_IMAGE_OK' : 'CODEX_REAL_IMAGE_OK'}: native MCP image event and model readback of synthetic image passed`);
}, async () => {
  try { mcp?.close(); }
  finally {
    for (const [key, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await removeLiveProbeFixture(temp, undefined, undefined, 'codex-live-image-');
  }
});
