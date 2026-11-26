/** Opt in: installed TUIs + production PTY + local fake model. No account calls.
 * node test/integration/builtin-tui-native.mjs codex opencode claude-code
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import { acquireTestLease } from '../helpers/lease.mjs';
import { createSharedCompiler } from '../helpers/shared-compile.mjs';
import { pause, connectRpc } from '../../src/main/runtime/builtins/scripts/_native.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const release = acquireTestLease(root);
const fixture = fs.mkdtempSync(path.join(root, '.tmp', 'builtin-tui-native-'));
const compile = createSharedCompiler(root, path.join(fixture, 'compiled'));
const pidModule = compile('main/inboundMcp/pidMap.ts');
const identityModule = compile('shared/inboundMcp.ts');
const { bindSessionProcessRoots } = await import(pathToFileURL(pidModule));
const require = createRequire(import.meta.url), ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
}).outputText.replace(/\bimport\.meta\.url\b/g, '__filename'), filename);
const { PtyManager } = require(path.join(root, 'src/main/pty/manager.ts'));
const { typeAndSubmit } = require(path.join(root, 'src/main/pty/submit.ts'));
const deadline = setTimeout(() => { console.error('Native TUI smoke timed out:', fixture); process.exit(1); }, 120_000);
const envBefore = { ...process.env };
const waitFor = async (condition, label, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await condition()) return; await pause(50); }
  throw Error(`Timeout: ${label}; artifacts: ${fixture}`);
};
const input = text => ({ intent: 'normal', messageId: `fixture-${Date.now()}`, text,
  sessionId: '', hostSessionId: 'fixture', cwd: fixture, signal: new AbortController().signal, isCurrent: () => true });
let held;
let activeEngine = '';
const requests = [];
let responseNumber = 0;
let longCommand, longCommandSent = false, longPid;
const model = http.createServer(async (req, res) => {
  if (!activeEngine || !req.url.startsWith(`/${activeEngine}/`)) { res.writeHead(410).end(); return; }
  let text = ''; for await (const chunk of req) text += chunk;
  let body;
  try { body = JSON.parse(text || '{}'); } catch { res.writeHead(400).end(); return; }
  if (req.url.includes('/count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1}'); return; }
  if (!req.url.includes('responses') && !req.url.includes('chat/completions') && !req.url.includes('/messages')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{}'); return; }
  requests.push({ url: req.url, body });
  const id = `resp_${++responseNumber}`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  const message = { id: `msg_${responseNumber}`, type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'NATIVE_PROTOCOL_OK', annotations: [] }] };
  const finish = () => {
    if (req.url.includes('/messages')) {
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'NATIVE_PROTOCOL_OK' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {}); res.end();
    } else if (req.url.includes('chat/completions')) {
      res.end(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'NATIVE_PROTOCOL_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else {
      event('response.output_item.added', { output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
      event('response.content_part.added', { item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: message.id, output_index: 0, content_index: 0, delta: 'NATIVE_PROTOCOL_OK' });
      event('response.output_item.done', { output_index: 0, item: message });
      event('response.completed', { response: { id, object: 'response', status: 'completed', model: 'fixture', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
      res.end();
    }
  };
  if (req.url.includes('/messages')) event('message_start', { message: { id, type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
  else if (!req.url.includes('chat/completions')) event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
  const turns = body.messages ?? body.input;
  const lastUser = Array.isArray(turns) ? [...turns].reverse().find(turn => turn.role === 'user') : undefined;
  const userParts = typeof lastUser?.content === 'string' ? [lastUser.content] : (lastUser?.content ?? []).map(part => part.text ?? '');
  if (activeEngine === 'claude-code' && longCommand && !longCommandSent && userParts.some(text => text.trim() === 'NATIVE_LONG') && !/haiku/i.test(body.model ?? '')) {
    longCommandSent = true;
    event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'long-command', name: 'Bash', input: {} } });
    event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: longCommand, timeout: 120000, description: 'Local interrupt regression fixture' }) } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {}); res.end(); return;
  }
  // Claude may make an API-key/title/permission preflight using its small model.
  // Holding that request would test the warmup, whose cancellation differs from a user turn.
  if (userParts.some(text => text.trim() === 'NATIVE_HOLD') && !/haiku/i.test(body.model ?? '')) {
    held = { response: res, finish };
  } else finish();
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${model.address().port}/v1`;
try {
  for (const id of process.argv.slice(2).length ? process.argv.slice(2) : ['codex', 'opencode']) {
    activeEngine = id;
    const caseBaseURL = baseURL.replace('/v1', `/${id}/v1`);
    const useClaudeChannel = id === 'claude-code' && process.env.MUSTER_TEST_CLAUDE_CHANNEL === '1';
    const cwd = path.join(fixture, id); fs.mkdirSync(cwd);
    const home = path.join(cwd, 'home'); fs.mkdirSync(home);
    const codexIsolation = path.join(home, 'codex-isolated'); fs.mkdirSync(codexIsolation);
    process.env.CODEX_HOME = codexIsolation; process.env.OPENAI_API_KEY = 'fixture-local-only';
    fs.writeFileSync(path.join(codexIsolation, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-local-only' }));
    fs.writeFileSync(path.join(codexIsolation, 'config.toml'), `model = "fixture"\nmodel_provider = "local_fixture"\n[model_providers.local_fixture]\nname = "Local fixture"\nbase_url = "${caseBaseURL}"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\n`);
    const manager = new PtyManager(() => null);
    let output = '', exited = false, launch, observedThreadId, releaseBackend;
    const activities = [];
    const hostEnv = { MUSTER_NATIVE_FIXTURE: 'backend-env-preserved', MUSTER_SESSION_TOKEN: 'fixture-worker-token',
      MUSTER_STATUS_URL: 'http://fixture/status', MUSTER_TOOL_URL: 'http://fixture/tool' };
    manager.getHostEnv = () => hostEnv;
    manager.onData = (_id, data) => { output += data; };
    manager.onExit = () => { exited = true; };
    let control;
    const confirmed = new Set();
    try {
      if (id === 'codex' || id === 'codex-legacy') {
        process.env.CODEX_HOME = home; process.env.OPENAI_API_KEY = 'fixture-local-only';
        fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'fixture-local-only' }));
        fs.writeFileSync(path.join(home, 'config.toml'), `model = "fixture"\nmodel_provider = "local_fixture"\n[model_providers.local_fixture]\nname = "Local fixture"\nbase_url = "${caseBaseURL}"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\n`);
        const proof = path.join(cwd, 'mcp-identity.json'), sidecar = path.join(cwd, 'mcp-fixture.mjs');
        fs.writeFileSync(sidecar, `import fs from 'node:fs'; import readline from 'node:readline';
import { readInboundMcpPidRecord, parentPidOf } from ${JSON.stringify(pathToFileURL(pidModule).href)};
import { resolveInboundIdentity } from ${JSON.stringify(pathToFileURL(identityModule).href)};
fs.writeFileSync(${JSON.stringify(proof)}, JSON.stringify({ env: process.env.MUSTER_NATIVE_FIXTURE,
  toolUrl: process.env.MUSTER_TOOL_URL,
  identity: resolveInboundIdentity({ env: {}, pid: process.pid, ppid: process.ppid,
    lookup: pid => readInboundMcpPidRecord(pid, ${JSON.stringify(home)}), parentOf: parentPidOf }) }));
for await (const line of readline.createInterface({input:process.stdin})) {
  const m=JSON.parse(line); if(m.id===undefined)continue;
  const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'identity-fixture',version:'1'}}:m.method==='tools/list'?{tools:[]}:{};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
}
`);
        fs.appendFileSync(path.join(home, 'config.toml'), `\n[mcp_servers.identity_fixture]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(sidecar)}]\nenv_vars = ["MUSTER_NATIVE_FIXTURE", "MUSTER_TOOL_URL"]\n`);
        process.env.MUSTER_TOOL_URL = 'http://127.0.0.1:59407/stale-instance';
        const runtime = await import('../../src/main/runtime/builtins/scripts/codex.mjs');
        if (id === 'codex') {
          launch = await runtime.resolveLaunch({ mode: 'start', sessionId: 'codex-pending-fixture', cwd, extraArgs: [], WebSocket, env: hostEnv });
          assert.ok(launch.processIds?.length, 'native backend declares its owned identity root');
          assert.equal(typeof launch.onActivity, 'function', 'native activity must not depend on the Worker HTTP endpoint');
          launch.onActivity((kind, event) => activities.push({ kind, event }));
          releaseBackend = bindSessionProcessRoots('fixture-worker', launch.processIds, hostEnv, home);
          launch.onSessionId(id => { observedThreadId = id; });
          const argsText = launch.args.join(' ');
          const remote = argsText.match(/ws:\/\/127\.0\.0\.1:\d+/)[0];
          control = await connectRpc(WebSocket, remote, launch.env.MUSTER_CODEX_TOKEN);
          await control.request('initialize', { clientInfo: { name: 'fixture-observer', version: '1' }, capabilities: {} });
          control.notify('initialized', {});
        } else {
          const { prepareCodexTui } = await import('../../src/main/runtime/builtins/scripts/_codex-native.mjs');
          launch = await prepareCodexTui({ cwd, extraArgs: [] }, args => runtime.resolveLaunch({
            probe: true, mode: 'start', sessionId: 'codex-pending-fixture', extraArgs: args,
          }), { probeCli: async () => '--no-daemon' });
          assert.match(launch.args.join(' '), /--no-daemon/);
          manager.onPtyPid = (_sessionId, pid) => {
            if (pid) releaseBackend = bindSessionProcessRoots('fixture-worker', [pid], hostEnv, home);
            else releaseBackend?.();
          };
        }
      } else if (id === 'opencode') {
        process.env.XDG_CONFIG_HOME = path.join(home, 'config'); process.env.XDG_DATA_HOME = path.join(home, 'data');
        process.env.XDG_CACHE_HOME = path.join(home, 'cache'); process.env.XDG_STATE_HOME = path.join(home, 'state');
        process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'openai/fixture', enabled_providers: ['openai'],
          provider: { openai: { options: { baseURL: caseBaseURL, apiKey: 'fixture-local-only' }, models: { fixture: { name: 'Fixture', limit: { context: 100000, output: 1000 } } } } } });
        const runtime = await import('../../src/main/runtime/builtins/scripts/opencode.mjs');
        const allocated = await runtime.allocate({ cwd });
        launch = await runtime.resolveLaunch({ ...allocated, cwd, extraArgs: [] });
      } else if (id === 'claude-code') {
        process.env.DISABLE_AUTOUPDATER = '1';
        process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
        // Some npm CLI updates temporarily remove global shims. A fixture-local shim
        // may use the already-installed native binary without changing the installation.
        if (process.platform === 'win32') {
          const binary = path.join(process.env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe');
          if (fs.existsSync(binary)) {
            const bin = path.join(cwd, 'bin'); fs.mkdirSync(bin);
            const pinned = path.join(bin, 'claude.exe'); fs.copyFileSync(binary, pinned);
            fs.writeFileSync(path.join(bin, 'claude.cmd'), `@"${pinned}" %*\r\n`);
            process.env.PATH = `${bin};${process.env.PATH}`;
          }
        }
        process.env.CLAUDE_CONFIG_DIR = home;
        process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-fixture-local-only';
        process.env.ANTHROPIC_BASE_URL = caseBaseURL.replace(/\/v1$/, '');
        process.env.DISABLE_TELEMETRY = '1'; process.env.DISABLE_ERROR_REPORTING = '1';
        const trusted = Object.fromEntries([cwd, root].flatMap(p => [p, p.replaceAll('\\', '/'), p.toLowerCase(), p.replaceAll('\\', '/').toLowerCase()])
          .map(p => [p, { hasTrustDialogAccepted: true }]));
        fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 1,
          projects: trusted,
          customApiKeyResponses: { approved: [process.env.ANTHROPIC_API_KEY.slice(-20)], rejected: [] },
        }));
        const runtime = await import('../../src/main/runtime/builtins/scripts/claude-code.mjs');
        launch = await runtime.resolveLaunch({ mode: 'start', sessionId: '11111111-1111-4111-8111-111111111111', cwd,
          extraArgs: ['--model', 'opus', '--permission-mode', 'default', '--allowedTools', 'Bash', ...(useClaudeChannel ? ['--dangerously-load-development-channels', 'server:muster-mailbox'] : [])] });
        launch.interruptInput = runtime.interruptInput();
        launch.prepareInterrupt = runtime.prepareInterrupt;
      } else throw Error(`Unsupported fixture ${id}`);
      manager.spawn(id, launch, cwd, 100, 30, launch.dispose);
      await waitFor(() => output.includes(id.startsWith('codex') ? 'Ask Codex' : id === 'claude-code' ? 'Claude' : 'opencode') || output.length > 6000 || exited, `${id} TUI startup`);
      assert.equal(exited, false, output);
      if (id === 'codex' || id === 'codex-legacy') {
        const proof = path.join(cwd, 'mcp-identity.json');
        let trusted = false;
        await waitFor(() => {
          if (id === 'codex-legacy' && !trusted && output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, '').includes('Trustthisfolder?')) {
            trusted = true; manager.write(id, '\r');
          }
          return fs.existsSync(proof);
        }, 'Codex same-server MCP startup');
        const observed = JSON.parse(fs.readFileSync(proof, 'utf8'));
        assert.equal(observed.env, hostEnv.MUSTER_NATIVE_FIXTURE, 'backend receives the worker host environment');
        assert.equal(observed.toolUrl, hostEnv.MUSTER_TOOL_URL, 'backend MCP inherits the live endpoint, not the parent process stale snapshot');
        assert.equal(observed.identity?.sessionId, 'fixture-worker', 'native MCP PID ancestry resolves this worker');
        assert.equal(observed.identity?.token, hostEnv.MUSTER_SESSION_TOKEN);
        if (id === 'codex-legacy') { console.log('ok: Codex legacy no-daemon TUI retains the worker MCP identity'); continue; }
      }
      const native = { ...input('NATIVE_HOLD'), cwd, sessionId: launch.externalSessionId || 'same-native-session' };
      let receipt;
      await waitFor(async () => {
        if (exited) throw new Error(`${id} exited before native admission: ${output.slice(-2000)}`);
        if (id === 'claude-code') {
          const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
          const compact = plain.replace(/\s/g, '');
          if (compact.includes('DoyouwanttousethisAPIkey?') && !confirmed.has('fixture-key')) {
            confirmed.add('fixture-key'); manager.write(id, '\x1b[A'); await pause(250); manager.write(id, '\r'); await pause(200);
          }
          // Only authorize the disposable fixture directory/key/MCP, preserving real UI gates.
          for (const gate of ['Yes, I trust this folder', 'Yes, use this API key', 'Yes, I understand', 'Press Enter to continue']) {
            if (plain.replace(/\s/g, '').includes(gate.replace(/\s/g, '')) && !confirmed.has(gate)) {
              confirmed.add(gate);
              if (gate === 'Yes, I trust this folder') { manager.write(id, '\x1b[B'); await pause(250); }
              manager.write(id, '\r'); await pause(200);
            }
          }
        }
        receipt = await launch.receiveMessage(native);
        return receipt.status === 'accepted' || id === 'claude-code' && !useClaudeChannel && receipt.status === 'unsupported';
      }, `${id} native first message`);
      if (id === 'claude-code' && !useClaudeChannel) {
        await typeAndSubmit(manager, id, native.text, { enterCount: 1 });
        receipt = { method: 'written' };
      }
      const codexQueue = id === 'codex' && receipt.method === 'queued';
      assert.equal(receipt.method, id === 'claude-code' ? 'written' : codexQueue ? 'queued' : 'sent');
      await waitFor(() => !!held, `${id} local model request`);
      if (id === 'codex') await waitFor(() => activities.some(activity => activity.kind === 'active' && activity.event === 'codex-turn'), 'Codex native active without HTTP status');
      const normal = await launch.receiveMessage({ ...native, text: 'NATIVE_NORMAL', messageId: 'normal' });
      assert.equal(normal.status, id === 'claude-code' ? useClaudeChannel ? 'accepted' : 'unsupported' : codexQueue ? 'accepted' : 'deferred', 'normal does not steer or stop the running CLI');
      if (codexQueue) assert.equal(normal.method, 'queued');
      const priority = await launch.receiveMessage({ ...native, text: 'NATIVE_PRIORITY', messageId: 'priority', intent: 'interrupt' });
      assert.equal(priority.status, id === 'claude-code' ? 'unsupported' : 'accepted');
      if (id === 'codex') {
        assert.equal(priority.method, 'steered');
        if (id === 'codex') assert.equal(held.response.destroyed, false, 'Codex native steering leaves the current response alive');
        if (!held.response.destroyed) held.finish();
      } else if (id === 'claude-code') {
        assert.equal(held.response.destroyed, false, 'channel does not pretend to cancel');
        manager.write(id, launch.interruptInput);
        await waitFor(() => held.response.destroyed, 'Claude native request actually stopped');
        if (useClaudeChannel) assert.equal((await launch.receiveMessage({ ...native, text: 'NATIVE_PRIORITY', messageId: 'priority-after-stop' })).method, 'written');
        else await typeAndSubmit(manager, id, 'NATIVE_PRIORITY', { enterCount: 1 });
      } else assert.equal(priority.method, 'stopped-and-sent');
      await waitFor(() => requests.some(request => JSON.stringify(request.body).includes('NATIVE_PRIORITY')), `${id} engine consumed priority`);
      await waitFor(() => output.includes('NATIVE_PROTOCOL_OK'), `${id} TUI renders the same engine's answer`);
      if (id === 'codex') await waitFor(() => activities.some(activity => activity.kind === 'idle' && activity.event === 'codex-turn'), 'Codex native idle without HTTP status');
      if (control) {
        const snapshot = await control.request('thread/read', { threadId: observedThreadId, includeTurns: false });
        assert.equal(snapshot.thread.id, observedThreadId);
      }
      console.log(`ok: ${id} real TUI, ${id === 'claude-code' && !useClaudeChannel ? 'confirmed-stop terminal fallback' : 'native normal/priority'}, same-session model input and answer`);
      if (id === 'claude-code' && !useClaudeChannel) {
        const proof = path.join(cwd, 'long-command.pid');
        const script = path.join(cwd, 'long-command.cjs');
        fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(proof)}, String(process.pid)); setTimeout(()=>{},90000);`);
        longCommand = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`;
        await pause(500);
        await typeAndSubmit(manager, id, 'NATIVE_LONG', { enterCount: 1 });
        await waitFor(() => fs.existsSync(proof), 'Claude actually starts the 90 second command');
        longPid = Number(fs.readFileSync(proof, 'utf8'));
        const confirmStopped = await launch.prepareInterrupt({ cwd, sessionId: '11111111-1111-4111-8111-111111111111' });
        assert.equal(await confirmStopped(), false, 'old interruptions must not confirm this running command');
        manager.write(id, launch.interruptInput);
        await waitFor(() => { try { process.kill(longPid, 0); return false; } catch { return true; } }, 'Claude Esc terminates the running command', 15000);
        longPid = undefined;
        await waitFor(confirmStopped, 'Claude native transcript confirms this interruption');
        await typeAndSubmit(manager, id, 'AFTER_LONG_INTERRUPT', { enterCount: 1 });
        await waitFor(() => requests.some(request => JSON.stringify(request.body).includes('AFTER_LONG_INTERRUPT')), 'Claude consumes follow-up after command interruption');
        console.log('ok: claude-code real 90 second Bash command stopped by Esc, subsequent input consumed');
      }
    } finally {
      if (longPid) { try { process.kill(longPid); } catch {} longPid = undefined; }
      fs.writeFileSync(path.join(cwd, 'terminal.log'), output);
      fs.writeFileSync(path.join(cwd, 'requests-summary.json'), JSON.stringify(requests.map(({url, body}) => ({ url,
        model: body.model, stream: body.stream, system: String(body.instructions ?? body.system ?? body.messages?.find(m => m.role === 'system')?.content ?? '').slice(0, 220),
        firstInput: typeof body.input === 'string' ? body.input.slice(0, 200) : body.input?.slice(0, 2).map(item => ({ role: item.role, type: item.type, content: JSON.stringify(item.content).slice(0, 220) })),
        hold: JSON.stringify(body).includes('NATIVE_HOLD'), priority: JSON.stringify(body).includes('NATIVE_PRIORITY'),
      })), null, 2));
      control?.dispose();
      if (manager.isRunning(id)) {
        await pause(500);
        manager.write(id, id === 'claude-code' ? '/exit\r' : '/quit\r');
        await pause(150); if (!exited) manager.write(id, '\r');
        for (let n = 0; n < 160 && !exited; n++) await pause(50);
        if (!exited) manager.kill(id);
      }
      launch?.dispose?.();
      releaseBackend?.();
      held?.response.destroy(); held = undefined;
      activeEngine = '';
      requests.length = 0;
    }
  }
} finally {
  for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
  Object.assign(process.env, envBefore);
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  clearTimeout(deadline); release();
  console.log('Native TUI artifacts:', fixture);
}
