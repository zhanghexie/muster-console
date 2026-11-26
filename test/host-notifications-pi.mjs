/** Real installed PI session/persistence/preflight; only the LLM stream is an offline fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-notifications-pi-'));
let session;
try {
  const target = path.join(tmp, 'delivery.mjs');
  await build({ entryPoints: ['src/main/agent/providers/hostNotification.ts'], outfile: target, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { sendHostNotification } = await import(pathToFileURL(target));
  const runtime = await ModelRuntime.create({ authPath: path.join(tmp, 'auth.json'), modelsPath: null, modelsStorePath: path.join(tmp, 'models-cache'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('host-test', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'offline-test-key',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  const model = runtime.getModel('host-test', 'fixture');
  assert.ok(model);
  const inputs = [];
  runtime.streamSimple = (_model, context) => {
    inputs.push(structuredClone(context));
    const stream = new AssistantMessageEventStream();
    const reply = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply }); stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); });
    return stream;
  };
  let preflight = 0;
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: tmp, agentDir: tmp, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline host event fixture.', extensionFactories: [api => api.on('before_agent_start', () => { preflight++; })] });
  await loader.reload();
  const manager = SessionManager.create(tmp, path.join(tmp, 'sessions'));
  ({ session } = await createAgentSession({ cwd: tmp, agentDir: tmp, resourceLoader: loader, settingsManager: settings,
    modelRuntime: runtime, model, tools: [], sessionManager: manager, thinkingLevel: 'off' }));
  let consumed = 0, started = 0;
  const visible = [], payload = '模型专用：三个 RSS 条目的正文与可执行参数。';
  await sendHostNotification(session, { prepare: () => ({ ids: ['event'], content: payload, summary: '收到 3 条 RSS 更新' }), accepted: () => { consumed++; },
    started: batch => { assert.equal(consumed, 1); assert.deepEqual(batch.ids, ['event']); started++; } },
    summary => visible.push(summary), true, '当前任务：关注 API 兼容性。');
  assert.equal(preflight, 1, 'real before_agent_start hook still runs');
  assert.equal(consumed, 1);
  assert.equal(started, 1, 'receipt is raised only when the real Pi agent turn starts');
  assert.deepEqual(visible, ['收到 3 条 RSS 更新']);
  assert.equal(inputs.length, 1, 'one model request, no mailbox-reading turn');
  assert.ok(JSON.stringify(inputs[0]).includes(payload), 'actual model stream receives event data');
  assert.ok(JSON.stringify(inputs[0]).includes('关注 API 兼容性'));
  const reopened = SessionManager.open(manager.getSessionFile(), path.join(tmp, 'sessions'));
  const entry = reopened.getEntries().find(e => e.type === 'custom_message' && e.customType === 'muster.host-notification');
  assert.equal(entry.display, false);
  assert.equal(entry.content, payload);
  assert.equal(entry.details.summary, visible[0]);
  const interjectTarget = path.join(tmp, 'interject.mjs');
  await build({ entryPoints: ['src/main/agentSession/piInterject.ts'], outfile: interjectTarget, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const { interjectHostNotification } = await import(pathToFileURL(interjectTarget));
  let releaseFirst, signalFirst;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  const interjectInputs = [];
  runtime.streamSimple = (_model, context) => {
    interjectInputs.push(structuredClone(context));
    const stream = new AssistantMessageEventStream();
    const reply = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    const finish = () => { stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply); };
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: reply });
      if (interjectInputs.length === 1) { releaseFirst = finish; signalFirst(); } else finish();
    });
    return stream;
  };
  const working = session.prompt('existing work');
  await firstStarted;
  const urgent = '[续接] fireInstanceId: fire-real-pi; urgent event';
  let interjectAccepted = 0, beforeSubmit = 0;
  const sendCustom = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (...args) => {
    assert.equal(beforeSubmit, 1, 'desktop source must be intersected before native Pi submission');
    return sendCustom(...args);
  };
  const interjecting = interjectHostNotification(session, {
    prepare: () => ({ ids: ['delivery'], summary: 'urgent', content: urgent }),
    beforeSubmit: () => { beforeSubmit++; },
    accepted: () => { interjectAccepted++; }
  }, () => true, () => {});
  await new Promise(resolve => setImmediate(resolve));
  releaseFirst();
  let receiptTimer;
  const accepted = await Promise.race([interjecting, new Promise((_, reject) => {
    receiptTimer = setTimeout(() => reject(new Error('Pi interjection receipt timed out')), 5000);
  })]).finally(() => clearTimeout(receiptTimer));
  await working;
  assert.equal(accepted, true);
  assert.equal(interjectAccepted, 1);
  assert.ok(interjectInputs.slice(1).some(input => JSON.stringify(input).includes(urgent)), 'real Pi model context sees the interjected event');
  assert.ok(manager.getEntries().some(item => item.type === 'custom_message' && item.content === urgent && item.display === false));
  console.log('host-notifications-pi: real Pi hidden input, mode preflight, durable replay and live interjection with offline model passed');
} finally {
  session?.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
}
