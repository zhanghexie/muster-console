import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-image-delivery-'));
let gateway;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { stageDesktopCaptureImage, withDesktopCaptureImageScope } = await import(pathToFileURL(compile('main/desktop/captureImageScope.ts')));
  const { createGuiHostToolGateway } = await import(pathToFileURL(compile('main/agentSession/tools/gateway.ts')));
  const { startHostToolGateway } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/hostToolGateway.ts')));
  const { dispatchInboundMcpTool } = await import(pathToFileURL(compile('shared/inboundMcp.ts')));
  const { executeSchedulerPiTool } = await import(pathToFileURL(compile('main/agent/schedulerPiDelivery.ts')));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=', 'base64');
  let valid = true, reads = 0, staleAtHttp = false, failResult = false;
  const tool = { id: 'host.desktop.look', label: 'look', description: 'fixture screenshot', permissionClass: 'read',
    resultFormat: 'execute-result-json', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      await withDesktopCaptureImageScope(async () => {
        stageDesktopCaptureImage(png, () => valid && (!staleAtHttp || ++reads < 3));
      });
      return JSON.stringify(failResult ? { ok: false, error: 'fixture failed' } : { ok: true, result: { artifactId: 'fixture' } });
    } };
  const input = { sessionId: 'fixture', cwd: temp, hostTools: [tool], getTurnId: () => 'turn',
    requestApproval: async () => ({ approved: false }), getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} };
  const direct = createGuiHostToolGateway(input, { captureImages: true });
  const result = await direct.invoke('host.desktop.look', {}, { id: 'one' });
  assert.equal(result.ok, true);
  assert.equal(result.image?.mimeType, 'image/png');
  assert.equal(result.image?.data, png.toString('base64'));
  assert.equal(result.imageCurrent(), true);
  failResult = true;
  const failed = await direct.invoke('host.desktop.look', {}, { id: 'failed' });
  assert.equal(failed.ok, false);
  assert.equal(failed.image, undefined, 'failed tool calls must not disclose staged images');
  failResult = false;
  valid = false;
  const revoked = await direct.invoke('host.desktop.look', {}, { id: 'revoked' });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.image, undefined);
  valid = true;

  gateway = await startHostToolGateway(input, { captureImages: true });
  const call = async () => {
    const response = await fetch(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: gateway.token, name: 'host_desktop_look', arguments: {} }) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  };
  const response = await call(), http = { postJson: async () => response };
  const resultMcp = await dispatchInboundMcpTool('host_desktop_look', {}, { invokeStyle: true, token: 'fixture', toolUrl: 'fixture' }, http, []);
  assert.equal(resultMcp.isError, undefined);
  assert.equal(resultMcp.content.length, 2);
  assert.deepEqual(resultMcp.content[1], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  const wrongTool = await dispatchInboundMcpTool('host_sessions_observe', {}, { invokeStyle: true, token: 'fixture', toolUrl: 'fixture' }, http, []);
  assert.equal(wrongTool.isError, true, 'a non-desktop tool cannot smuggle an image into MCP output');
  const malformed = { postJson: async () => ({ ok: true, status: 200, text: JSON.stringify({ text: 'ok', image: { type: 'image', mimeType: 'image/png', data: 'bad' } }) }) };
  assert.equal((await dispatchInboundMcpTool('host_desktop_look', {}, { invokeStyle: true, token: 'fixture', toolUrl: 'fixture' }, malformed, [])).isError, true);
  staleAtHttp = true; reads = 0;
  const stale = JSON.parse((await call()).text);
  assert.equal(stale.isError, true, 'the final HTTP boundary rechecks screenshot authorization');
  assert.equal(stale.image, undefined);
  staleAtHttp = false;
  const scheduler = await executeSchedulerPiTool({ delivery: { run: (_id, _name, _signal, execute) => execute() },
    id: 'scheduler-image', name: 'host_desktop_look', params: {}, supportsCaptureImages: () => true, resolve: args => ({ ok: true, args }),
    execute: async () => { stageDesktopCaptureImage(png, () => valid); return { ok: true, result: { artifactId: 'fixture' } }; },
    serialize: JSON.stringify });
  assert.deepEqual(scheduler.content[1], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  const schedulerError = await executeSchedulerPiTool({ delivery: { run: (_id, _name, _signal, execute) => execute() },
    id: 'scheduler-error', name: 'host_desktop_look', params: {}, supportsCaptureImages: () => true, resolve: args => ({ ok: true, args }),
    execute: async () => { stageDesktopCaptureImage(png, () => valid); return { ok: false, error: 'fixture failed' }; },
    serialize: JSON.stringify });
  assert.equal(schedulerError.content.length, 1, 'failed scheduler calls must not disclose staged images');
  const textOnly = await executeSchedulerPiTool({ delivery: { run: (_id, _name, _signal, execute) => execute() },
    id: 'scheduler-text', name: 'host_desktop_look', params: {}, supportsCaptureImages: () => false, resolve: args => ({ ok: true, args }),
    execute: async () => { stageDesktopCaptureImage(png, () => valid); return { ok: true, result: { artifactId: 'fixture' } }; },
    serialize: JSON.stringify });
  assert.equal(textOnly.content.length, 1, 'text-only models must not receive image content');
  console.log('desktop image delivery: nested host scope, MCP image, invalidation and isolation passed');
} finally { gateway?.close(); removeWorkspaceFixture(temp, 'desktop-image-delivery-'); }
