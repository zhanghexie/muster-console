/** Real Pi session, edit tool and review hooks; only the model stream is offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-pi-session-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const { createPiReviewCaptureExtension } = await import(pathToFileURL(compile('main/agentSession/drivers/pi/reviewCaptureExtension.ts')));
const work = path.join(tmp, 'work'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'a'), 'one\ntwo\n');
const service = new TurnChangeService(path.join(tmp, 'store'));
const tracker = service.begin('gui:offline-pi', 'm', work, [work]);
let session;
try {
  const runtime = await ModelRuntime.create({ authPath: path.join(tmp, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(tmp, 'models-cache'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('review-test', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'offline-test-key',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = runtime.getModel('review-test', 'fixture');
  assert.ok(model);
  let requests = 0;
  runtime.streamSimple = () => {
    const stream = new AssistantMessageEventStream();
    const first = ++requests === 1;
    const reply = { role: 'assistant', content: first ? [{ type: 'toolCall', id: 'edit-1', name: 'edit',
      arguments: { path: 'a', edits: [{ oldText: 'one', newText: 'ONE' }, { oldText: 'two', newText: 'TWO' }] } }] : [],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply }); stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
    return stream;
  };
  let release, signalStart;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { signalStart = resolve; });
  const logs = [];
  const capture = createPiReviewCaptureExtension({
    async start(event) { signalStart(); await gate; await tracker.toolStart(event.toolCallId, event.toolName, event.input, undefined, true); },
    end: event => tracker.toolEnd(event.toolCallId, event.ok, undefined, true)
  }, message => logs.push(message));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: work, agentDir: tmp, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline review fixture.', extensionFactories: [capture] });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: work, agentDir: tmp, resourceLoader: loader, settingsManager: settings,
    modelRuntime: runtime, model, tools: ['edit'], sessionManager: SessionManager.create(work, path.join(tmp, 'sessions')), thinkingLevel: 'off' }));
  const run = session.prompt('Edit the file.');
  let timer;
  await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pi edit hook did not start')), 5000); })])
    .finally(() => clearTimeout(timer));
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'one\ntwo\n', 'the actual Pi tool must wait for capture');
  release(); await run;
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'ONE\nTWO\n');
  const summary = await tracker.finish();
  assert.equal(summary.files[0].revertible, true);
  assert.deepEqual(logs, []);
  assert.deepEqual((await service.revert(summary.id, 'gui:offline-pi', 'm', [work])).restored, ['a']);
  assert.equal(fs.readFileSync(path.join(work, 'a'), 'utf8'), 'one\ntwo\n');
  console.log('turn-changes-pi-session: real SDK session and edit hooks passed with offline model');
} finally {
  session?.dispose(); await tracker.ready; service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
