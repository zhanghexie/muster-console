import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'codex-turn-token-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CodexRuntimeDriver } = await import(pathToFileURL(compile('main/agentSession/drivers/codex/driver.ts')));
  const runtime = () => ({
    startThread: () => ({ id: 'fixture-thread', async runStreamed() { return { events: (async function* () {
      yield { type: 'thread.started', thread_id: 'fixture-thread' }; yield { type: 'turn.completed' };
    })() }; } }),
    resumeThread: () => ({ id: 'fixture-thread', async runStreamed() { return { events: (async function* () {
      yield { type: 'turn.completed' };
    })() }; } })
  });
  {
    const tokens = [];
    const driver = new CodexRuntimeDriver({ sessions: { get: () => ({ workspaceId: 'ws' }) }, config: {} }, { userDataDir: temp }, {
      createAppServerClient: options => { tokens.push(options.hostMcpConfig.mcp_servers.muster.env.MUSTER_HOST_TOOLS_TOKEN); return runtime(); },
      resolveExecutable: async () => ({ ok: true, executable: process.execPath, packaged: false }),
      hostMcpScript: path.resolve('src/main/inboundMcp/stdioEntry.ts') });
    const input = { sessionId: 'token-native', cwd: temp, systemPromptAppend: '', hostTools: [], requestApproval: async () => ({ approved: true }),
      getTurnId: () => 'host-turn', log() {} };
    const connection = await driver.connect(input);
    try {
      await connection.send('first');
      await connection.send('second');
      assert.equal(tokens.length, 2, 'each native turn receives one configuration');
      assert.ok(tokens.every(token => typeof token === 'string' && token.length >= 32));
      assert.notEqual(tokens[0], tokens[1], 'old native processes must not reuse a later turn credential');
    } finally { await connection.close(); }
  }
  console.log('Codex GUI: app-server gateway credentials rotate per turn');
} finally { removeWorkspaceFixture(temp, 'codex-turn-token-'); }
