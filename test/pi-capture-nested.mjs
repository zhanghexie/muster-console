/** Real Pi session: nested screenshot calls cannot impersonate a direct call ID. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

const root = process.cwd(), prefix = 'pi-capture-nested-';
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', prefix));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { PiWorkerCaptureImages } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/captureImages.ts')));
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let session;
try {
  const modelRuntime = await ModelRuntime.create({ authPath: path.join(tmp, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(tmp, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'offline-test-key',
    models: [{ id: 'vision', name: 'Fixture', reasoning: false, input: ['text', 'image'], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = modelRuntime.getModel('fixture', 'vision'); assert.ok(model);
  let requests = 0, nestedEvent, nestedOutcome, backendCalls = 0;
  modelRuntime.streamSimple = () => {
    const first = ++requests === 1;
    // Pi's first nested ID will be parent/1, matching the second direct ID.
    const reply = { role: 'assistant', content: first ? [
      { type: 'toolCall', id: 'parent', name: 'outer', arguments: {} },
      { type: 'toolCall', id: 'parent/1', name: 'host_desktop_look', arguments: {} }
    ] : [], api: model.api, provider: model.provider, model: model.id, usage,
    stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
    return stream;
  };
  const capture = new PiWorkerCaptureImages(() => 1, () => true);
  const look = { name: 'host_desktop_look', label: 'Look', description: 'offline screenshot fixture', parameters: Type.Object({}),
    async execute(id, _args, signal) {
      capture.begin('host.desktop.look', _args, id, signal);
      backendCalls++;
      return { content: [{ type: 'text', text: 'unexpected backend call' }], details: {} };
    } };
  const outer = { name: 'outer', label: 'Outer', description: 'offline nested fixture', parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      nestedOutcome = await ctx.executeTool('host_desktop_look', {});
      return { content: [{ type: 'text', text: 'outer finished' }], details: {} };
    } };
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: tmp, agentDir: tmp, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline nested screenshot fixture.' });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: tmp, agentDir: tmp, resourceLoader: loader, settingsManager: settings,
    modelRuntime, model, tools: ['outer', 'host_desktop_look'], customTools: [outer, look],
    sessionManager: SessionManager.create(tmp, path.join(tmp, 'sessions')), thinkingLevel: 'off' }));
  session.agent.toolExecution = 'sequential';
  capture.attach(session.agent, settings);
  session.subscribe(event => {
    if (event.type !== 'tool_execution_start') return;
    capture.observeToolStart(event);
    if (event.parentToolCallId) nestedEvent = event;
  });
  await session.prompt('Run the offline nested fixture.');
  assert.equal(nestedEvent?.parentToolCallId, 'parent');
  assert.equal(nestedEvent?.toolCallId, 'parent/1');
  assert.equal(nestedEvent?.toolName, 'host_desktop_look');
  assert.equal(nestedOutcome?.isError, true);
  assert.match(nestedOutcome.result.content[0].text, /Nested Pi screenshots are unavailable/);
  assert.equal(backendCalls, 0, 'colliding nested identity must be rejected before screenshot capture');
  capture.close();
  console.log('pi-capture-nested: real Pi nested call and colliding ID are rejected');
} finally { session?.dispose(); removeWorkspaceFixture(tmp, prefix); }
