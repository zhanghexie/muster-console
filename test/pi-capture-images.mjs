/** Snapshot identity, screenshot integrity and per-call resize isolation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd(), prefix = 'pi-capture-images-';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { PiWorkerCaptureImages } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/captureImages.ts')));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=';
const image = { type: 'image', mimeType: 'image/png', data: png };
const screenshotText = JSON.stringify({ ok: true, result: { width: 1, height: 1 } });
const signal = new AbortController().signal;
let generation = 1, connected = true, release, started;
const paused = new Promise(resolve => { release = resolve; });
const entered = new Promise(resolve => { started = resolve; });
const resizeValues = [];
const settings = { getImageAutoResize: () => true };
const directIds = ['screen', 'altered', 'changed', 'text', 'virtual', 'dimensions', 'limited', 'cancelled', 'spoofed'];
const agent = { signal, state: { model: { id: 'vision', provider: 'fixture', api: 'openai-completions', input: ['text', 'image'] },
  messages: [{ role: 'assistant', content: directIds.map(id => ({ type: 'toolCall', id, name: 'host_desktop_look' })) }] },
  async afterToolCall(context) {
    resizeValues.push([context.toolCall.id, settings.getImageAutoResize()]);
    if (context.toolCall.id === 'screen') { started(); await paused; }
    if (context.toolCall.id === 'altered') return { content: [{ type: 'text', text: 'changed' }, image] };
  } };
try {
  const capture = new PiWorkerCaptureImages(() => generation, () => connected);
  capture.attach(agent, settings);
  const first = capture.begin('host.desktop.look', {}, 'screen', signal);
  assert.equal(first.supported, true);
  assert.throws(() => capture.begin('host.desktop.look', {}, 'nested', signal), /Nested Pi screenshots/);
  capture.observeToolStart({ toolCallId: 'spoofed', toolName: 'host_desktop_look', parentToolCallId: 'parent' });
  assert.throws(() => capture.begin('host.desktop.look', {}, 'spoofed', signal), /Nested Pi screenshots/,
    'a nested id matching an assistant call must still be rejected');
  capture.stage(first, screenshotText, image);
  assert.deepEqual(capture.content('host.desktop.look', 'screen', signal, screenshotText), [image]);
  const screening = agent.afterToolCall({ toolCall: { id: 'screen', name: 'host_desktop_look' },
    result: { content: [{ type: 'text', text: screenshotText }, image] }, isError: false });
  await entered;
  await agent.afterToolCall({ toolCall: { id: 'other', name: 'other' }, result: { content: [] }, isError: false });
  release(); assert.equal(await screening, undefined);
  assert.deepEqual(resizeValues, [['screen', false], ['other', true]], 'resize policy must be isolated per async call');
  assert.equal(settings.getImageAutoResize(), true);
  const captured = { role: 'toolResult', toolCallId: 'screen', toolName: 'host_desktop_look', isError: false,
    content: [{ type: 'text', text: screenshotText }, image] };
  assert.equal((await agent.transformContext([captured]))[0], captured);
  const changedLater = { ...captured, content: [{ type: 'text', text: 'extension changed metadata' }, image] };
  const filtered = (await agent.transformContext([changedLater]))[0];
  assert.equal(filtered.isError, true); assert.ok(filtered.content.every(part => part.type !== 'image'));
  for (const changedIdentity of [{ ...captured, toolCallId: 'different' }, { ...captured, toolName: 'different' }]) {
    const result = (await agent.transformContext([changedIdentity]))[0];
    assert.equal(result.isError, true); assert.ok(result.content.every(part => part.type !== 'image'));
  }

  const altered = capture.begin('host.desktop.look', {}, 'altered', signal);
  capture.stage(altered, screenshotText, image); capture.content('host.desktop.look', 'altered', signal, screenshotText);
  const rejected = await agent.afterToolCall({ toolCall: { id: 'altered', name: 'host_desktop_look' },
    result: { content: [{ type: 'text', text: screenshotText }, image] }, isError: false });
  assert.equal(rejected.isError, true); assert.ok(rejected.content.every(part => part.type !== 'image'));

  const changed = capture.begin('host.desktop.look', {}, 'changed', signal);
  agent.state.model = { ...agent.state.model, id: 'another' };
  assert.throws(() => capture.stage(changed, 'text', image), /context changed/);
  agent.state.model = { ...agent.state.model, id: 'text-only', input: ['text'] };
  const textOnly = capture.begin('host.desktop.look', {}, 'text', signal);
  assert.equal(textOnly.supported, false);
  capture.stage(textOnly, '{"ok":true}', undefined);
  assert.match(capture.content('host.desktop.look', 'text', signal, '{"ok":true}')[0].text, /不支持/);
  agent.state.model = { ...agent.state.model, id: 'router', api: 'pi-virtual', input: ['text', 'image'] };
  const virtual = capture.begin('host.desktop.look', {}, 'virtual', signal);
  assert.equal(virtual.supported, false, 'a virtual selection cannot prove the next physical model');
  assert.throws(() => capture.stage(virtual, screenshotText, image), /dimensions are invalid/);
  agent.state.model = { ...agent.state.model, api: 'openai-completions' };
  const badDimensions = capture.begin('host.desktop.look', {}, 'dimensions', signal);
  assert.throws(() => capture.stage(badDimensions, JSON.stringify({ ok: true, result: { width: 2, height: 1 } }), image), /dimensions are invalid/);
  agent.state.model = { ...agent.state.model, inputLimits: { images: { resize: { maxBytes: 20 } } } };
  const limited = capture.begin('host.desktop.look', {}, 'limited', signal);
  assert.throws(() => capture.stage(limited, screenshotText, image), /model image limits/);
  const abort = new AbortController(); agent.signal = abort.signal;
  agent.state.model = { ...agent.state.model, inputLimits: undefined };
  const cancelled = capture.begin('host.desktop.look', {}, 'cancelled', abort.signal);
  capture.stage(cancelled, screenshotText, image); capture.content('host.desktop.look', 'cancelled', abort.signal, screenshotText);
  abort.abort();
  const stopped = await agent.afterToolCall({ toolCall: { id: 'cancelled', name: 'host_desktop_look' },
    result: { content: [{ type: 'text', text: screenshotText }, image] }, isError: false });
  assert.equal(stopped.isError, true); assert.ok(stopped.content.every(part => part.type !== 'image'));
  connected = false; assert.throws(() => capture.begin('host.desktop.look', {}, 'closed', signal), /unavailable/);
  capture.close();
  console.log('pi-capture-images: model identity, integrity and isolated resize passed');
} finally { removeWorkspaceFixture(tmp, prefix); }
