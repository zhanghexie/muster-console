/** Real vendor CLIs + production configuration writer + stdioEntry + host gateway.
 * Only model responses are local fixtures; a pass requires a real host tool execution and its result reaching the engine.
 * Run: node test/integration/builtin-mcp-native.mjs kimi pi mimo
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { acquireTestLease } from '../helpers/lease.mjs';
import { createInboundCompiler } from '../helpers/inbound-compile.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
let release;
for (let attempt = 0; !release; attempt++) {
  try { release = acquireTestLease(root); }
  catch (error) { if (attempt >= 60) throw error; if (attempt === 0) console.log('Waiting for the existing checkout test command to finish.'); await new Promise(resolve => setTimeout(resolve, 1000)); }
}
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-native-mcp-'));
const compile = createInboundCompiler(root, path.join(fixture, 'compiled'));
const load = relative => import(pathToFileURL(compile(relative)));
const { harnessMcpTargets } = await load('main/harnessIntegration/mcp.ts');
const { ensureInboundMcpSetup } = await load('main/inboundMcp/registrar.ts');
const { startHostToolGateway } = await load('main/agentSession/drivers/acp/hostToolGateway.ts');
const { bindInboundMcpPidRecord } = await load('main/inboundMcp/pidMap.ts');
const stdio = compile('main/inboundMcp/stdioEntry.ts');
const seeds = JSON.parse(fs.readFileSync(path.join(root, 'src/main/runtime/builtins/registry.json'))).runtimes;
const write = (filename, value) => { fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); };
const reports = [];
const requested = process.argv.slice(2).length ? process.argv.slice(2) : ['kimi', 'pi', 'mimo'];
const installed = (packageName, bin) => {
  const directory = path.join(root, '.tmp/builtin-mcp-tools/node_modules', packageName);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  return { command: process.execPath, args: [path.join(directory, typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[bin])], version: pkg.version };
};
let active;
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body; try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400).end(); return; }
  if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); res.end('{"object":"list","data":[{"id":"fixture","object":"model","owned_by":"fixture","created":1}]}'); return; }
  if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":10}'); return; }
  if (!active) { res.writeHead(503).end(); return; }
  const state = active;
  state.requests.push({ url: req.url, body });
  const available = (body.tools ?? []).flatMap(tool => tool.type === 'namespace' ? tool.tools.map(item => ({ ...item, namespace: tool.name })) : [tool])
    .map(tool => ({ name: tool.function?.name ?? tool.name, schema: tool.function?.parameters ?? tool.input_schema ?? tool.parameters, namespace: tool.namespace }));
  const target = available.find(tool => /sessions[_\.]readMessages$/.test(tool.name));
  const hasResult = JSON.stringify(body.messages ?? body.input ?? '').includes(state.proof);
  let call = !hasResult && target ? { name: target.name, namespace: target.namespace, args: { nonce: state.nonce } } : null;
  if (!hasResult && !target && available.some(tool => tool.name === 'mcp_tool_search')) {
    const foundSchema = (body.messages ?? []).some(message => message.role === 'tool' && JSON.stringify(message.content).includes('muster_sessions_readMessages'));
    call = foundSchema ? { name: 'mcp_tool_use', args: { name: 'muster_sessions_readMessages', arguments: { nonce: state.nonce } } }
      : { name: 'mcp_tool_search', args: { query: 'select:muster_sessions_readMessages' } };
  }
  if (!hasResult && !target && available.some(tool => tool.name === 'search_tool')) {
    const discovered = (body.messages ?? []).filter(message => message.role === 'tool').map(message => JSON.stringify(message.content)).join('\n').match(/(?:mcp__)?muster[._]+sessions_readMessages/);
    call = discovered ? { name: 'use_tool', args: { tool_name: discovered[0], tool_input: { nonce: state.nonce } } }
      : { name: 'search_tool', args: { query: 'muster readMessages', limit: 5 } };
  }
  if (!hasResult && !target && available.some(tool => tool.name === 'search_tools')) {
    const discovered = (body.messages ?? []).filter(message => message.role === 'tool').map(message => JSON.stringify(message.content)).join('\n').match(/mcp__muster__sessions_readMessages/);
    call = discovered ? { name: discovered[0], args: { nonce: state.nonce } } : { name: 'search_tools', args: { query: 'muster readMessages', max_results: 5 } };
  }
  if (!target && available.length === 1 && available[0].name === 'StructuredOutput') call = { name: 'StructuredOutput', args: { title: 'Fixture' } };
  if (available.length === 1 && available[0].name === 'session_title') call = { name: 'session_title', args: { title: 'Fixture' } };
  if (state.id === 'cline' && !target && !hasResult && available.some(tool => tool.name === 'read_files')) {
    // Cline connects MCP asynchronously. A bounded, harmless read advances the real agent loop while its client connects.
    if (state.requests.length < 6) {
      await new Promise(resolve => setTimeout(resolve, 750));
      call = { name: 'read_files', args: { files: [{ path: state.fixtureFile }] } };
    }
  }
  if (!target && !hasResult) state.missingTools = available;
  const text = hasResult ? 'MCP_NATIVE_CALL_CONFIRMED' : 'MCP_TOOL_NOT_VISIBLE';
  if (!hasResult && state.requests.length > 12) call = null;
  const id = `fixture_${state.requests.length}`;
  if (req.url.includes('/messages')) {
    res.setHeader('content-type', 'text/event-stream');
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('message_start', { message: { id, type: 'message', role: 'assistant', content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: call ? { type: 'tool_use', id: 'host_call', name: call.name, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } : { type: 'text_delta', text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    event('message_stop', {}); res.end();
  } else if (req.url.includes('chat/completions')) {
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: 'host_call', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: text };
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const delta = call ? { ...message, tool_calls: message.tool_calls.map(t => ({ index: 0, ...t })) } : message;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.end(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
    } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id, object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, message, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })); }
  } else if (req.url.includes('responses')) {
    res.setHeader('content-type', 'text/event-stream');
    let sequence = 0;
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`);
    const item = call ? { id: `fc_${id}`, type: 'function_call', call_id: `call_${id}`, name: call.namespace ? `${call.namespace}.${call.name}` : call.name, arguments: JSON.stringify(call.args), status: 'completed' }
      : { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(call ? { arguments: '' } : { content: [] }) } });
    if (call) {
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
      event('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
    }
    else {
      event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
      event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    }
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id, object: 'response', status: 'completed', model: body.model, output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    res.end();
  } else {
    state.unhandled = req.url; res.writeHead(400).end('{"error":{"message":"Unsupported fixture protocol"}}');
  }
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${model.address().port}/v1`;
const stop = child => new Promise(resolve => {
  if (child?.terminal) { child.terminal.kill(); resolve(); return; }
  if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  else { child.kill('SIGTERM'); resolve(); }
});
try {
  for (const id of requested) {
    let caseGateway;
    try {
    const home = path.join(fixture, id), cwd = path.join(home, 'project'); fs.mkdirSync(cwd, { recursive: true });
    const state = active = { id, nonce: `nonce_${id}_${Date.now()}`, proof: `HOST_RESULT_${id}_${Date.now()}`, calls: [], requests: [] };
    const tool = { id: 'sessions.readMessages', label: 'Read messages fixture', description: 'Read test messages; no side effects', permissionClass: 'read',
      parameters: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false },
      execute: async args => { assert.equal(args.nonce, state.nonce); state.calls.push(args); return JSON.stringify({ proof: state.proof }); } };
    const gateway = await startHostToolGateway({ sessionId: 'native-mcp-fixture', cwd, hostTools: [tool], requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'default', planExecuting: false }), log() {} });
    caseGateway = gateway;
    const catalog = path.join(home, 'catalog.json'); write(catalog, { tools: [{ name: 'sessions_readMessages', description: tool.description, inputSchema: tool.parameters }] });
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|SYSTEMDRIVE|PROGRAMFILES|PROGRAMFILES\(X86\)|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i.test(key)));
    const env = { ...inherited, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.data'), XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.state'),
      KIMI_CODE_HOME: path.join(home, '.kimi-code'), MIMOCODE_HOME: path.join(home, '.mimocode-home'), PI_CODING_AGENT_DIR: path.join(home, '.pi/agent'),
      GROK_HOME: path.join(home, '.grok'), COPILOT_HOME: path.join(home, '.copilot'), HERMES_HOME: path.join(home, '.hermes'),
      MUSTER_HOST_TOOLS_CATALOG: catalog, MUSTER_HOST_TOOLS_URL: gateway.url, MUSTER_HOST_TOOLS_TOKEN: gateway.token,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', KIMI_CODE_TRUST_WORKSPACE: '1', MIMOCODE_DISABLE_PROJECT_CONFIG: 'true', MIMOCODE_DISABLE_DEFAULT_PLUGINS: 'true',
      NO_PROXY: '127.0.0.1,localhost', OPENAI_API_KEY: 'fixture-local-only', XAI_API_KEY: 'fixture-local-only' };
    if (id === 'devin' && process.platform === 'win32') {
      // Rust known-folder discovery expands USERPROFILE/AppData independently of APPDATA.
      env.APPDATA = path.join(home, 'AppData/Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData/Local');
    }
    for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) fs.mkdirSync(env[key], { recursive: true });
    let launch = { command: process.execPath, args: [stdio], ...(id === 'muse' ? { env: { HOME: home, USERPROFILE: home } } : {}) };
    if (['cline', 'commandcode', 'hermes'].includes(id)) {
      const trace = path.join(home, 'mcp-trace.jsonl'), wrapper = path.join(home, 'stdio-probe.mjs');
      write(wrapper, `import fs from 'node:fs'; import {spawn} from 'node:child_process';
const trace=${JSON.stringify(trace)}; fs.appendFileSync(trace,JSON.stringify({event:'spawn'})+'\\n');
const child=spawn(process.execPath,[${JSON.stringify(stdio)}],{env:process.env,stdio:['pipe','pipe','inherit'],windowsHide:true});
let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){try{const m=JSON.parse(buffer.slice(0,i));fs.appendFileSync(trace,JSON.stringify({method:m.method,id:m.id})+'\\n')}catch{}buffer=buffer.slice(i+1)}child.stdin.write(chunk)});
child.stdout.pipe(process.stdout);process.stdin.on('end',()=>child.stdin.end());child.once('exit',code=>process.exit(code??1));process.once('SIGTERM',()=>child.kill());`);
      launch = { command: process.execPath, args: [wrapper] };
    }
    const runtimeId = { kimi: 'kimi-cli', mimo: 'mimo-code-cli', grok: 'grok-cli', cline: 'cline-cli', kilo: 'kilo-cli', copilot: 'github-copilot-cli', commandcode: 'commandcode-cli', muse: 'muse-cli', zcode: 'zcode-cli', hermes: 'hermes-cli', devin: 'devin-cli' }[id];
    if (runtimeId) {
      const targets = harnessMcpTargets(seeds.filter(seed => seed.id === runtimeId), { homeDir: home, env });
      assert.equal(targets.files.length, 1, `${runtimeId}: expected exactly one registered configuration target`);
      assert.equal(targets.statuses.length, 0, JSON.stringify(targets.statuses));
      const setup = ensureInboundMcpSetup(launch, { files: targets.files, ownershipFile: path.join(home, 'owned.json') });
      assert.equal(setup.ok, true, JSON.stringify(setup));
    }
    const prompt = `Call the sessions_readMessages MCP tool with nonce ${state.nonce}. Report its returned proof.`;
    state.fixtureFile = path.join(cwd, 'fixture.txt'); write(state.fixtureFile, 'MCP discovery fixture\n');
    let command, args, version;
    if (id === 'kimi') {
      write(path.join(env.KIMI_CODE_HOME, 'config.toml'), `default_model = "fixture"\ntelemetry = false\n[providers.fixture]\ntype = "openai"\nbase_url = "${baseURL}"\napi_key = "fixture-local-only"\n[models.fixture]\nprovider = "fixture"\nmodel = "fixture"\nmax_context_size = 128000\ncapabilities = ["tool_use"]\n[[permission.rules]]\ndecision = "allow"\npattern = "mcp__muster__*"\n`);
      command = process.env.KIMI_TEST_EXECUTABLE || path.join(process.env.USERPROFILE, '.kimi-code/bin/kimi.exe'); args = ['-p', prompt]; version = '2.4.1';
    } else if (['pi', 'omp', 'pi-gui', 'omp-gui'].includes(id)) {
      const isOmp = id.startsWith('omp');
      write(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), { providers: { fixture: { baseUrl: baseURL, api: 'openai-completions', apiKey: 'fixture-local-only', models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 4096 }] } } });
      env.MUSTER_INBOUND_MCP_LAUNCH = JSON.stringify(launch);
      const pkg = !isOmp ? { command: process.execPath, args: [path.join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')], version: '1.4.0' } : installed('@oh-my-pi/pi-coding-agent', 'omp');
      command = isOmp ? path.join(root, '.tmp/mcp-native-binaries/bun/package/bin/bun.exe') : pkg.command;
      let extension = path.join(root, 'src/main/runtime/builtins/scripts/_pi-host-mcp.mjs');
      if (id.endsWith('-gui')) {
        const { EXTERNAL_PI_BRIDGE_SOURCE } = await load('main/agentSession/drivers/externalPi/bridge.ts');
        extension = path.join(home, 'gui-bridge.mjs'); write(extension, EXTERNAL_PI_BRIDGE_SOURCE);
        env.MUSTER_EXTERNAL_PI_BRIDGE = path.join(home, 'bridge-config.json');
        write(env.MUSTER_EXTERNAL_PI_BRIDGE, { url: gateway.url, token: gateway.token, tools: JSON.parse(fs.readFileSync(catalog)).tools });
        delete env.MUSTER_INBOUND_MCP_LAUNCH;
      }
      args = [...pkg.args, '--no-session', '--no-extensions', '--extension', extension, '--provider', 'fixture', '--model', 'fixture', '--thinking', 'off', '-p', prompt]; version = pkg.version;
    } else if (id === 'mimo' || id === 'kilo') {
      const isMimo = id === 'mimo';
      const config = { model: 'fixture/fixture', provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Fixture', options: { baseURL, apiKey: 'fixture-local-only' }, models: { fixture: { name: 'Fixture', limit: { context: 128000, output: 4096 } } } } }, permission: { '*': 'allow' } };
      const filename = isMimo ? path.join(env.MIMOCODE_HOME, 'config/mimocode.json') : path.join(env.XDG_CONFIG_HOME, 'kilo/kilo.json');
      const current = JSON.parse(fs.readFileSync(filename));
      write(filename, { ...current, ...config });
      if (isMimo) { command = process.execPath; args = [path.join(process.env.APPDATA, 'npm/node_modules/@mimo-ai/cli/mimo.js'), 'run', '--pure', '--format', 'json', prompt]; version = '0.1.16'; }
      else { const pkg = installed('@kilocode/cli', 'kilo'); command = pkg.command; args = [...pkg.args, 'run', '--format', 'json', prompt]; version = pkg.version; }
    } else if (id === 'grok') {
      const filename = path.join(home, '.grok/config.toml');
      fs.appendFileSync(filename, `\n[models]\ndefault = "fixture"\n[model.fixture]\nmodel = "fixture"\nname = "Fixture"\nbase_url = "${baseURL}"\napi_key = "fixture-local-only"\napi_backend = "chat_completions"\n`);
      env.GROK_HOME = path.dirname(filename); env.GROK_MODELS_BASE_URL = baseURL; env.GROK_XAI_API_BASE_URL = baseURL; env.GROK_DISABLE_AUTOUPDATER = '1';
      command = path.join(process.env.USERPROFILE, '.grok/bin/grok.exe'); args = ['--model', 'fixture', '--permission-mode', 'bypassPermissions', '--max-turns', '5', '-p', prompt]; version = '1.0.70';
    } else if (id === 'commandcode') {
      env.CMD_LOCAL_ONLY = '1';
      env.COMMAND_CODE_API_KEY = 'fixture-local-only';
      write(path.join(home, '.commandcode/providers.json'), { provider: { fixture: { baseURL, apiKey: false, models: { fixture: { contextWindow: 128000, maxOutput: 4096 } } } } });
      const pkg = installed('command-code', 'command-code'); command = pkg.command; version = pkg.version;
      args = [...pkg.args, '--local-only', '--model', 'fixture/fixture', '--trust', '--permission-mode', 'yolo', '--no-session', '-p', prompt];
    } else if (id === 'copilot') {
      Object.assign(env, { COPILOT_PROVIDER_BASE_URL: baseURL, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'fixture-local-only', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_MODEL: 'fixture', COPILOT_PROVIDER_MODEL_ID: 'gpt-4.1', COPILOT_PROVIDER_WIRE_MODEL: 'fixture' });
      const pkg = installed('@github/copilot', 'copilot'); command = pkg.command; version = pkg.version;
      args = [...pkg.args, '--trust-folder', '--allow-all-tools', '--allow-all-mcp-server-instructions', '--disable-builtin-mcps', '-p', prompt];
    } else if (id === 'cline') {
      const pkg = installed('cline', 'cline'); command = pkg.command; version = pkg.version;
      await new Promise((resolve, reject) => execFile(command, [...pkg.args, 'auth', '--provider', 'openai', '--apikey', 'fixture-local-only', '--modelid', 'fixture', '--baseurl', baseURL], { cwd, env, windowsHide: true, timeout: 20000 }, error => error ? reject(error) : resolve()));
      args = [...pkg.args, '--provider', 'openai', '--model', 'fixture', '--auto-approve', 'true', '--json', '--timeout', '50', prompt];
    } else if (id === 'muse') {
      command = path.join(root, '.tmp/mcp-native-binaries/muse.exe'); version = '1.4.14-R7309.1';
      env.META_API_KEY = 'fixture-local-only';
      env.RUST_LOG = 'debug';
      args = ['exec', '--provider', 'meta', '--model', 'fixture', '--base-url', baseURL, '--no-session-log', '--disable-approval', '--disable-sandbox', '--trust-workspace', prompt];
    } else if (id === 'hermes') {
      env.CUSTOM_BASE_URL = baseURL;
      env.PYTHONUTF8 = '1'; env.PYTHONIOENCODING = 'utf-8';
      command = path.join(root, '.tmp/hermes-mcp-venv/Scripts/hermes.exe'); version = '0.19.0';
      args = ['--provider', 'custom', '--model', 'fixture', '--yolo', '--oneshot', prompt];
    } else if (id === 'devin') {
      command = path.join(root, '.tmp/mcp-native-binaries/devin/bin/devin.exe'); version = '3000.11.234';
      env.HOMEDRIVE = path.parse(home).root.slice(0, 2); env.HOMEPATH = home.slice(2); env.USERNAME = 'fixture';
      const filename = path.join(env.APPDATA, 'devin/config.json'); write(filename, { auto_update: false, read_config_from: { agents_standard: false, cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false } });
      const inspect = params => new Promise((resolve, reject) => execFile(command, ['--config', filename, ...params], { cwd, env, windowsHide: true, timeout: 15000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      assert.match(await inspect(['mcp', 'list']), /muster/, 'native Devin must recognize the production-generated configuration');
      if (/Not logged in/i.test(await inspect(['auth', 'status']))) {
        const error = new Error('Devin authentication required: native MCP configuration was recognized; tools/call remains unverified');
        write(path.join(home, 'failure.json'), { error: error.message, configurationRecognized: true, calls: [] });
        throw error;
      }
      args = ['--config', filename, '--respect-workspace-trust', 'false', '--permission-mode', 'dangerous', '-p', prompt];
    } else if (id === 'zcode') {
      write(path.join(home, '.zcode/v2/provider_config.json'), { schemaVersion: 1, config: {
        providerConfigRules: { providerRules: [{ providerId: 'fixture', providerName: 'Fixture', config: { group: 'standard-personal', access: { type: 'api-key', apiKey: 'fixture-local-only' }, api: { type: 'openai-chat-completions', baseUrl: baseURL }, personalModelIds: ['fixture'] } }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: { providerId: 'fixture', modelId: 'fixture' }
      } });
      command = process.execPath; version = '0.17.1 (official Desktop 3.17.1 bundle)';
      args = [path.join(root, '.tmp/mcp-native-binaries/zcode-cli/resources/glm/zcode.cjs'), '--mode', 'yolo', '--cwd', cwd, '--json', '--prompt', prompt];
    } else throw new Error(`Fixture model setup for ${id} is not implemented`);
    let child, output = '', code, unbind;
    try {
        child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        if (child.pid) unbind = bindInboundMcpPidRecord({ sessionId: `native-${id}`, ptyPid: child.pid, token: gateway.token, statusUrl: gateway.url, toolUrl: gateway.url, invokeStyle: true }, home);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-100000); });
      child.stderr.on('data', chunk => { output = (output + chunk).slice(-100000); });
      code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${id}: native MCP call timed out after 60s`)), 60000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', exit => { clearTimeout(timer); resolve(exit); });
      });
      assert.ok(state.calls.length > 0, `${id}: no real host tool call (exit ${code}): ${output.slice(-3000)}`);
      assert.ok(state.requests.some(request => JSON.stringify(request.body).includes(state.proof)), `${id}: host tool result did not reach the engine`);
      assert.equal(code, 0, output.slice(-2000));
      const report = { id, version, platform: process.platform, calls: state.calls.length, modelRequests: state.requests.length, resultReturnedToEngine: true };
      reports.push(report); console.log(JSON.stringify(report));
    } catch (error) {
      write(path.join(home, 'failure.json'), { error: error.message, output, requests: state.requests, missingTools: state.missingTools, calls: state.calls });
      console.error(`Native MCP failure artifacts: ${home}`); throw error;
    } finally { await stop(child); unbind?.(); gateway.close(); }
    } catch (error) {
      reports.push({ id, passed: false, error: error.message }); process.exitCode = 1;
      console.error(`${id}: ${error.message.slice(0, 800)}`);
    } finally { caseGateway?.close(); }
  }
} finally {
  model.closeAllConnections(); model.close(); release();
  write(path.join(fixture, 'results.json'), reports);
  console.log(`Native MCP artifacts: ${fixture}`);
}
