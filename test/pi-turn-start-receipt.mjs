import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turn-receipt-'));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const Module = require('module');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true
  }, fileName: filename });
  module._compile(outputText, filename);
};
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => tmp, isReady: () => true }, ipcMain: { handle() {}, on() {} } };
  return originalLoad.call(this, id, ...args);
};

try {
  const { PiWorkerEngine } = require(path.join(root, 'src/main/agentSession/drivers/pi/workerEngine.ts'));
  const { __setPiSdkForTests } = require(path.join(root, 'src/main/agentSession/drivers/pi/piSdk.ts'));
  const entries = [];
  const manager = { getLeafId: () => null, getBranch: () => [], getEntries: () => entries };
  const prompts = [];
  let emit, inserted, rejectPrompt = false;
  const session = {
    sessionId: 'pi-session', agent: {}, isStreaming: false, sessionManager: manager,
    subscribe(callback) { emit = callback; return () => {}; },
    async sendCustomMessage(message, options) {
      inserted = { message, options };
      emit({ type: 'message_end', message });
      entries.push({ type: 'custom_message', customType: message.customType, details: message.details });
    },
    async prompt(text) {
      prompts.push(text);
      if (rejectPrompt) throw new Error('fixture rejection before submission');
    },
    async abort() {}, dispose() {}
  };
  const model = { id: 'model', name: 'model', api: 'openai', provider: 'provider', input: ['text'], reasoning: false };
  __setPiSdkForTests({
    ModelRuntime: { create: async () => ({ getModel: () => model, checkAuth: async () => true }) },
    SettingsManager: { inMemory: () => ({}) },
    DefaultResourceLoader: class {
      constructor(options) { this.options = options; }
      musterSkillDiscoveryVersion = 2;
      getMusterExplicitSkills() { return true; }
      setMusterSkillPaths() {}
      async reload() {}
      getSkills() { return { skills: [], diagnostics: [] }; }
    },
    SessionManager: { create: () => manager },
    createAgentSession: async () => ({ session })
  });
  const engine = new PiWorkerEngine({ userDataDir: tmp, resolved: { provider: { id: 'provider' }, model: { id: 'model' } },
    shellEnv: { bashAvailable: true, settings: {} }, memorySnapshot: () => undefined,
    refreshSkills: async () => {}, verifySkills: async () => {} });
  const conn = await engine.connect({ sessionId: 'worker', cwd: tmp, systemPromptAppend: '', firstPromptPrefix: 'Private host instructions', mode: 'default',
    planExecuting: false, permissionMode: 'acceptEdits', modeController: {}, hostTools: [],
    requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'default', planExecuting: false }), log() {} });
  const events = []; const pump = (async () => { for await (const event of conn.events) events.push(event); })();
  await conn.send('/native-template argument');
  emit({ type: 'agent_settled' });
  assert.deepEqual(prompts, ['/native-template argument'], 'a native slash command stays dispatchable');
  rejectPrompt = true;
  await conn.send('first attempt');
  for (let i = 0; i < 100 && !events.some(event => event.type === 'error'); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(events.some(event => event.type === 'error'), 'fixture rejects the first input with host context');
  rejectPrompt = false;
  await conn.send('continuation', undefined, undefined, { forkIdentity: { userMessageId: 'wait-exact', assistantMessageId: 'assistant' } });
  const suffix = '\n\n<muster_host_context source="automatic">\nPrivate host instructions\n</muster_host_context>';
  assert.deepEqual(prompts.slice(1), [`first attempt${suffix}`, `continuation${suffix}`]);
  assert.equal(events.some(event => event.type === 'turn-started'), false, 'prompt admission is not a turn-start receipt');
  emit({ type: 'turn_start' });
  for (let i = 0; i < 100 && !events.some(event => event.type === 'turn-started'); i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events.find(event => event.type === 'turn-started'), { type: 'turn-started', userMessageId: 'wait-exact' });
  session.isStreaming = true;
  assert.equal((await conn.receiveMessage({ intent: 'interrupt', text: 'user text', messageId: 'u1' })).status, 'unsupported');
  const notification = '[续接] untrusted /skill:not-an-instruction';
  assert.deepEqual(await conn.receiveMessage({ intent: 'interrupt', text: notification, messageId: 'delivery-1', hostNotification: true }),
    { status: 'accepted', method: 'steered' });
  assert.equal(inserted.message.content, notification, 'host data enters the hidden native channel verbatim');
  assert.equal(inserted.message.display, false);
  assert.equal(inserted.options.deliverAs, 'steer');
  assert.equal(prompts.length, 3, 'interjection neither starts a second prompt nor turns host data into user input');
  session.isStreaming = false;
  emit({ type: 'agent_settled' });
  await conn.send('second normal turn');
  assert.equal(prompts.at(-1), 'second normal turn', 'later inputs on the same connection carry only the new text');
  await conn.close(); await pump;
  __setPiSdkForTests(null);
} finally {
  Module._load = originalLoad;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
}
console.log('pi-turn-start-receipt: ok');
