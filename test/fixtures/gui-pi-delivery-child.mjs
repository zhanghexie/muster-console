/** Controlled IPC peer with the real Pi AgentSession, tool adapter and receipt tracker. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssistantMessageEventStream, Type } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

const pending = new Map();
let next = 1;
let active = 1;
let finished = false;
function call(method, args, signal) {
  if (!process.connected || signal?.aborted) return Promise.reject(new Error('cancelled'));
  const id = next++;
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); process.send?.({ type: 'cancel', id }); reject(new Error('cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, { resolve, reject, cleanup: () => signal?.removeEventListener('abort', abort) });
    process.send({ type: 'call', id, generation: active, method, args });
  });
}
process.on('message', message => {
  if (message.type === 'reply') {
    const item = pending.get(message.id); if (!item) return;
    pending.delete(message.id); item.cleanup();
    if (message.ok) item.resolve(message.result); else item.reject(new Error(message.error));
  } else if (message.type === 'start') {
    void run(message).catch(error => { process.send?.({ type: 'failure', message: error.stack }); process.exitCode = 1; });
  }
});
process.once('disconnect', () => process.exit(finished ? 0 : 2));

async function run({ mode, compiled, dir }) {
  const { PiWorkerDesktopDelivery, createPiWorkerToolExecutor } = await import(pathToFileURL(path.join(compiled, 'main/agentSession/drivers/pi/childDesktopDelivery.mjs')));
  const { buildPiCustomTools } = await import(pathToFileURL(path.join(compiled, 'main/agentSession/drivers/pi/customTools.mjs')));
  const delivery = new PiWorkerDesktopDelivery(() => active, () => !!process.connected,
    (proof, signal) => call('desktop.deliveryAck', proof, signal),
    proof => { void call('desktop.deliveryAbandon', proof).catch(() => {}); });
  const host = { id: 'host.desktop.act', label: 'desktop', description: 'offline fixture', permissionClass: 'write',
    parameters: Type.Object({ requestId: Type.String() }),
    execute: createPiWorkerToolExecutor('host.desktop.act', delivery, () => active, (args, signal) => call('tool', args, signal)) };
  const [tool] = buildPiCustomTools([host], { sessionId: 'fixture', cwd: dir });
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost };
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null,
    modelsStorePath: path.join(dir, 'models'), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('fixture', { api: 'openai-completions', baseUrl: 'http://127.0.0.1:9', apiKey: 'offline-fixture',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 16000, maxTokens: 512, cost }] });
  const model = runtime.getModel('fixture', 'fixture');
  let requests = 0;
  runtime.streamSimple = () => {
    const first = ++requests === 1;
    const content = first ? [{ type: 'toolCall', id: 'call-1', name: tool.name, arguments: { requestId: 'first' } }] : [];
    if (first && mode === 'parallel') content.push({ type: 'toolCall', id: 'call-2', name: tool.name, arguments: { requestId: 'second' } });
    const reply = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage, stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now() };
    const stream = new AssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: 'start', partial: reply });
      stream.push({ type: 'done', reason: reply.stopReason, message: reply }); stream.end(reply); });
    return stream;
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const rewrite = api => api.on('message_end', event => event.message.role === 'toolResult'
    ? { message: { ...event.message, content: [{ type: 'text', text: 'rewritten by extension' }] } } : undefined);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: 'Offline fixture.', extensionFactories: mode === 'rewrite' ? [rewrite] : [] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, resourceLoader: loader, settingsManager,
    modelRuntime: runtime, model, tools: [tool.name], customTools: [tool],
    sessionManager: SessionManager.create(dir, path.join(dir, 'sessions')), thinkingLevel: 'off' });
  session.agent.subscribe(event => {
    if (event.type === 'tool_execution_end') {
      process.send({ type: 'phase', name: 'tool_execution_end' });
      if (mode === 'exit') process.exit(71);
    }
    if (event.type === 'turn_end' && mode === 'missing-result') {
      session.agent.state.messages = session.agent.state.messages.filter(message => message.role !== 'toolResult');
    }
  });
  delivery.attach(session.agent);
  try {
    await session.prompt('Run the offline fixture.');
    const messages = session.agent.state.messages.filter(message => message.role === 'toolResult');
    process.send({ type: 'done', messages: JSON.stringify(messages), requests }, () => { finished = true; process.disconnect(); });
  } finally {
    delivery.close(); session.dispose();
  }
}
