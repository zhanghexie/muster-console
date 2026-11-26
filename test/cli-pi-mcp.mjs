/** Real MCP transport behind the Pi/OMP native extension: errors, cancellation and lifecycle. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import extension from '../src/main/runtime/builtins/scripts/_pi-host-mcp.mjs';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cli-mcp-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { startHostToolGateway } = await import(pathToFileURL(compile('main/agentSession/drivers/acp/hostToolGateway.ts')));
const previous = { ...process.env };
const tools = new Map(), hooks = new Map();
let started = false, aborted = false;
const tool = { id: 'sessions.readMessages', label: 'Read', description: 'Read', permissionClass: 'read', parameters: { type: 'object', properties: {} },
  async execute(args, input) {
    if (args.fail) throw new Error('fixture host refusal');
    if (!args.wait) return 'HOST_PROOF';
    started = true;
    await new Promise((_, reject) => input.signal.addEventListener('abort', () => { aborted = true; reject(new Error('cancelled')); }, { once: true }));
  } };
const gateway = await startHostToolGateway({ sessionId: 'fixture', cwd: tmp, hostTools: [tool], requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'default', planExecuting: false }), log() {} });
try {
  const catalog = path.join(tmp, 'catalog.json');
  fs.writeFileSync(catalog, JSON.stringify({ tools: [{ name: 'sessions_readMessages', description: 'Read', inputSchema: tool.parameters }] }));
  process.env.MUSTER_INBOUND_MCP_LAUNCH = JSON.stringify({ command: process.execPath, args: [compile('main/inboundMcp/stdioEntry.ts')] });
  process.env.MUSTER_HOST_TOOLS_CATALOG = catalog;
  process.env.MUSTER_HOST_TOOLS_URL = gateway.url;
  process.env.MUSTER_HOST_TOOLS_TOKEN = gateway.token;
  await extension({ registerTool(tool) { tools.set(tool.name, tool); }, on(name, callback) { hooks.set(name, callback); } });
  assert.equal(tools.size, 1);
  const registered = tools.get('sessions_readMessages');
  assert.deepEqual((await registered.execute('ordinary', {})).content, [{ type: 'text', text: 'HOST_PROOF' }]);
  await assert.rejects(registered.execute('refusal', { fail: true }), /fixture host refusal/);
  const controller = new AbortController();
  const waiting = registered.execute('waiting', { wait: true }, controller.signal);
  const rejected = assert.rejects(waiting, /cancelled/);
  for (let i = 0; i < 100 && !started; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(started); controller.abort(); await rejected;
  for (let i = 0; i < 100 && !aborted; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(aborted, 'extension forwards cancellation to the actual host request');
  hooks.get('session_shutdown')();
  await assert.rejects(registered.execute('closed', {}), /closed/);
  console.log('cli-pi-mcp: real stdio discovery/call, host refusal, cancellation and shutdown passed');
} finally {
  hooks.get('session_shutdown')?.(); gateway.close();
  for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
  Object.assign(process.env, previous);
  fs.rmSync(tmp, { recursive: true, force: true });
}
