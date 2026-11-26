import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = process.cwd();
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'codex-turn-receipt-'));
try {
  const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
  const { CodexRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/driver.ts')).href);
  let release, running = false;
  const gate = new Promise(resolve => { release = resolve; });
  const client = { startThread: () => { throw new Error('unexpected new thread'); }, resumeThread: id => ({
    id, async runStreamed() { running = true; return { events: (async function* () {
      await gate;
      yield { type: 'turn.started' };
      yield { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } };
    })() }; }
  }) };
  const driver = new CodexRuntimeDriver({ sessions: { get: () => ({ workspaceId: 'ws' }) }, config: { effectiveMcp: () => ({ enabled: false, servers: [] }) } },
    { userDataDir: tmp }, { createClient: () => client, resolveExecutable: async () => ({ ok: true, packaged: false }),
      hostMcpScript: path.join(root, 'src/main/inboundMcp/stdioEntry.ts') });
  const conn = await driver.connect({ sessionId: 'worker', cwd: tmp, resumeToken: 'thread-id', systemPromptAppend: '',
    mode: 'default', planExecuting: false, permissionMode: 'acceptEdits', modeController: {}, hostTools: [],
    requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'default', planExecuting: false }), log() {} });
  const events = []; const pump = (async () => { for await (const event of conn.events) events.push(event); })();
  const sending = conn.send('continuation', undefined, undefined, { forkIdentity: { userMessageId: 'wait-exact', assistantMessageId: 'assistant' } });
  for (let i = 0; i < 100 && !running; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(running, true);
  assert.equal(events.some(event => event.type === 'turn-started'), false, 'admission before the native turn is not a receipt');
  release(); await sending;
  for (let i = 0; i < 100 && !events.some(event => event.type === 'turn-started'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events.find(event => event.type === 'turn-started'), { type: 'turn-started', userMessageId: 'wait-exact' });
  await conn.close(); await pump;
} finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); }
console.log('codex-turn-start-receipt: ok');
