/**
 * 在 Electron 主进程 Node（20.x）下自测 Pi：patch → createAgentSession → prompt。
 * 用法：set ELECTRON_RUN_AS_NODE=1 && npx electron test/pi-electron-smoke.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// --- patch（与 src/main/agent/piElectronCompat.ts 一致）---
const wt = require('node:worker_threads');
if (typeof wt.markAsUncloneable !== 'function') {
  wt.markAsUncloneable = function markAsUncloneable() {};
}

const cfgPath = path.join(process.env.APPDATA, 'muster-console', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
if (!cfg.openai?.apiKey) {
  console.error('FAIL: no apiKey in config');
  process.exit(1);
}

const agentDir = path.join(os.homedir(), '.pi', 'agent');
fs.mkdirSync(agentDir, { recursive: true });
let base = (cfg.openai.baseUrl || '').replace(/\/+$/, '');
if (!/\/v\d+$/i.test(base)) base += '/v1';
const providerId = /deepseek/i.test(base) ? 'deepseek' : 'muster';
const modelId = cfg.openai.model;
fs.writeFileSync(
  path.join(agentDir, 'models.json'),
  JSON.stringify(
    {
      providers: {
        [providerId]: {
          baseUrl: base,
          api: 'openai-completions',
          apiKey: cfg.openai.apiKey,
          authHeader: true,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ['text'],
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    },
    null,
    2
  )
);
let auth = {};
try {
  auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
} catch {
  /* empty */
}
auth[providerId] = { type: 'api_key', key: cfg.openai.apiKey };
fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify(auth, null, 2));

console.log('node', process.versions.node, 'electron', process.versions.electron || 'n/a');
console.log('loading pi…');

const { ModelRuntime, createAgentSession, SessionManager } = await import(
  '@earendil-works/pi-coding-agent'
);
const mr = await ModelRuntime.create();
const model = mr.getModel(providerId, modelId);
if (!model) {
  console.error('FAIL: model not found', providerId, modelId);
  process.exit(1);
}

const { session } = await createAgentSession({
  cwd: cfg.workspace || 'd:\\MetaApp',
  model,
  modelRuntime: mr,
  sessionManager: SessionManager.inMemory(cfg.workspace || 'd:\\MetaApp'),
  tools: ['read', 'bash']
});

let out = '';
const unsub = session.subscribe((event) => {
  if (event?.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    out += event.assistantMessageEvent.delta;
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt('用一句话回答：1+1等于几？只输出数字。');
  console.log('\n---');
  if (!out.trim()) {
    console.error('FAIL: empty response');
    process.exit(1);
  }
  console.log('OK: got response');
  process.exit(0);
} catch (e) {
  console.error('\nFAIL:', e);
  process.exit(1);
} finally {
  unsub();
  session.dispose();
}
