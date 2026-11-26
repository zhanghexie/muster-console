import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'desktop-claude-image-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { stageDesktopCaptureImage } = await import(pathToFileURL(compile('main/desktop/captureImageScope.ts')));
  const { buildClaudeMcpServer } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/hostTools.ts')));
  const { createClaudeStreamState, mapClaudeUser } = await import(pathToFileURL(compile('main/agentSession/drivers/claude/streamMap.ts')));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=', 'base64');
  let capture = png, width = 1, height = 1;
  let valid = true, expiresBeforeSend = false, reads = 0, fail = false;
  const tool = { id: 'host.desktop.look', label: 'look', description: 'fixture screenshot', permissionClass: 'read',
    resultFormat: 'execute-result-json', parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      stageDesktopCaptureImage(capture, () => valid && (!expiresBeforeSend || ++reads < 3));
      return JSON.stringify(fail ? { ok: false, error: 'fixture failed' } : { ok: true, result: { artifactId: 'fixture', width, height } });
    } };
  const captured = [];
  const sdk = { tool: (name, _description, _schema, handler) => { const item = { name, handler }; captured.push(item); return item; },
    createSdkMcpServer: config => config };
  const input = { sessionId: 'fixture', cwd: temp, hostTools: [tool], getTurnId: () => 'turn', getDesktopTurnId: () => 'desktop-turn',
    requestApproval: async () => ({ approved: false }), getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} };
  await buildClaudeMcpServer({ sdk, input, isCurrent: () => true });
  const handler = captured.find(item => item.name === 'host_desktop_look').handler;
  const result = await handler({}, {});
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.content[2], { type: 'image', mimeType: 'image/png', data: png.toString('base64') });
  assert.deepEqual(JSON.parse(result.content[1].text).imageView, { width: 1, height: 1, captureWidth: 1, captureHeight: 1 });
  width = 1920; height = 1080;
  capture = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const resized = await handler({}, {}), resizedInfo = JSON.parse(resized.content[1].text).imageView;
  assert.deepEqual(resizedInfo, { width: 1456, height: 819, captureWidth: 1920, captureHeight: 1080 });
  const resizedPng = await sharp(Buffer.from(resized.content[2].data, 'base64')).metadata();
  assert.deepEqual({ width: resizedPng.width, height: resizedPng.height }, { width: 1456, height: 819 });
  width = 1200; height = 1000;
  capture = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).png().toBuffer();
  assert.ok(capture.toString('base64').length > 4_000_000);
  const large = await handler({}, {}), largeInfo = JSON.parse(large.content[1].text).imageView;
  assert.ok(large.content[2].data.length <= 4_000_000);
  assert.ok(largeInfo.width < width && largeInfo.height < height, 'oversized encoded images are reduced with an explicit mapping');
  width++;
  const mismatched = await handler({}, {});
  assert.equal(mismatched.isError, true, 'image dimensions must match host screenshot metadata');
  assert.equal(mismatched.content.length, 1);
  width = 1; height = 1; capture = png;
  fail = true;
  const failed = await handler({}, {});
  assert.equal(failed.isError, true);
  assert.equal(failed.content.length, 1);
  fail = false; expiresBeforeSend = true; reads = 0;
  const revoked = await handler({}, {});
  assert.equal(revoked.isError, true, 'Claude rechecks the capture before delivering to its SDK');
  assert.equal(revoked.content.length, 1);
  const state = createClaudeStreamState();
  const mapped = mapClaudeUser(state, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'id',
    content: [{ type: 'image', source: { type: 'base64', data: 'private-pixels' } }] }] } });
  assert.equal(mapped[0].output, '[Image omitted]');
  assert.ok(!JSON.stringify(mapped).includes('private-pixels'), 'host events must not contain image bytes');
  console.log('Claude screenshot delivery: MCP image, final revocation and image-only event redaction passed');
} finally { removeWorkspaceFixture(temp, 'desktop-claude-image-'); }
