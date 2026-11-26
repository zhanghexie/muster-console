/** Automatic boot setup and IPC: real registrar, isolated home, mocked Electron transport only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInboundCompiler } from './helpers/inbound-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-auto-ipc-'));
const userData = path.join(temporary, 'userData');
const home = path.join(userData, 'capability-home');
const compiled = path.join(temporary, 'compiled');
const compile = createInboundCompiler(root, compiled);
const entry = compile('main/ipc/inboundMcp.ts');
const { defaultInboundMcpEngineFiles } = await import(pathToFileURL(compile('main/inboundMcp/registrar.ts')));
const files = defaultInboundMcpEngineFiles(home);
const gemini = files.find(file => file.id === 'gemini').path;
fs.mkdirSync(path.dirname(gemini), { recursive: true }); fs.writeFileSync(gemini, '{broken fixture');
fs.writeFileSync(path.join(compiled, 'main/ipc/handle.mjs'), 'export function handle(channel, fn) { globalThis.__inboundAutoHandlers.set(channel, fn); }\n');
fs.writeFileSync(path.join(compiled, 'main/harnessIntegration/opencodeConfigProbe.mjs'), 'export async function probeOpenCodeMcpLayout() { throw new Error("sandbox setup should not spawn a CLI"); }\n');
fs.writeFileSync(path.join(compiled, 'main/inboundMcp/launch.mjs'), 'export function inboundMcpLaunch() { return globalThis.__inboundAutoLaunch; }\n');
const electron = path.join(compiled, 'node_modules/electron'); fs.mkdirSync(electron, { recursive: true });
fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
fs.writeFileSync(path.join(electron, 'index.cjs'), 'exports.app = { getPath() { return globalThis.__inboundAutoUserData; }, once(event, fn) { globalThis.__inboundAutoQuit = fn; } };\n');
globalThis.__inboundAutoHandlers = new Map();
globalThis.__inboundAutoLaunch = { command: process.execPath, args: [path.join(temporary, 'stdioEntry.mjs')] };
globalThis.__inboundAutoUserData = userData;
const previousSandbox = process.env.MUSTER_SANDBOX; process.env.MUSTER_SANDBOX = '1';
const notifications = [], messages = [], logs = [];
let sendFails = true, notificationFails = false, confirms = 0;
const previousLog = console.error;
console.error = (...args) => logs.push(args.map(String).join(' '));
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
try {
  const { registerInboundMcpIpc } = await import(pathToFileURL(entry));
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'src/main/runtime/builtins/registry.json'), 'utf8')).runtimes;
  let changed, configChanged; let config = {}; let registry = seed; let runtimeOff = 0, configOff = 0;
  const context = {
    runtimes: { list: () => registry, onChanged(fn) { changed = fn; return () => { runtimeOff++; }; } },
    config: { get: () => config, onChanged(fn) { configChanged = fn; return () => { configOff++; }; }, update() { throw new Error('automatic setup must not update AppConfig'); } },
    getWindow: () => ({ isDestroyed: () => false, webContents: { isDestroyed: () => false, send(channel, status) { messages.push([channel, status]); if (sendFails) throw new Error('fixture renderer transport unavailable'); } } }),
    ui: { confirm() { confirms++; throw new Error('automatic setup must never ask TOFU'); }, notify(title, detail) { notifications.push([title, detail]); if (notificationFails) throw new Error('fixture native notification failure'); } }
  };
  registerInboundMcpIpc(context);
  const status = globalThis.__inboundAutoHandlers.get('inboundMcp:status');
  const install = globalThis.__inboundAutoHandlers.get('inboundMcp:install');
  assert.ok(status); assert.ok(install);
  assert.equal((await status()).ok, false);
  assert.equal(fs.existsSync(files[0].path), false, 'read-only status must not install before the startup turn');
  // No page/status request is needed to trigger configuration on the next boot turn.
  for (let index = 0; index < 8 && !notifications.length; index++) await nextTurn();
  assert.equal(fs.existsSync(files[0].path), true); assert.equal(fs.existsSync(files[1].path), true);
  assert.equal(fs.readFileSync(gemini, 'utf8'), '{broken fixture');
  assert.equal(notifications.length, 1, 'broadcast failure cannot skip the native boot warning');
  assert.ok(logs.some(line => line.includes('status broadcast failed')));
  assert.deepEqual((await status()).engines.filter(engine => engine.state === 'error').map(engine => engine.id), ['gemini']);
  assert.ok((await status()).engines.some(engine => engine.state === 'session'));
  assert.ok(changed, 'runtime registry changes trigger reconciliation');
  assert.equal(confirms, 0);
  assert.ok(files.every(file => file.path.startsWith(home + path.sep)), 'sandbox setup stays under isolated home');
  const beforeRead = fs.statSync(files[0].path).mtimeMs; await status(); await status();
  assert.equal(fs.statSync(files[0].path).mtimeMs, beforeRead);
  fs.writeFileSync(gemini, '{"theme":"user-kept"}'); sendFails = false;
  const first = install(), second = install(); assert.equal(first, second, 'startup/manual retries share one in-flight ensure');
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  assert.equal((await status()).ok, true); assert.equal(JSON.parse(fs.readFileSync(gemini, 'utf8')).theme, 'user-kept');
  assert.equal(messages.at(-1)[0], 'inboundMcp:changed'); assert.equal(messages.at(-1)[1].ok, true);
  const stable = files.map(file => fs.statSync(file.path).mtimeMs);
  assert.equal((await install()).ok, true); assert.deepEqual(files.map(file => fs.statSync(file.path).mtimeMs), stable);
  fs.writeFileSync(gemini, '{again broken'); notificationFails = true;
  assert.equal((await install()).ok, false, 'notification failure never rejects or changes the real setup result');
  assert.equal((await status()).ok, false, 'failure remains visible independently of the toast transport');
  assert.ok(logs.some(line => line.includes('warning notification failed')));
  assert.equal(confirms, 0);
  fs.writeFileSync(gemini, '{}'); notificationFails = false;
  registry = [...seed, { id: 'fixture-custom', label: 'Fixture custom', enabled: true, integrations: { mcp: { strategy: 'config-file', format: 'json', base: 'config', path: 'fixture-harness/mcp.json' } } }];
  changed(); await nextTurn();
  const customFile = path.join(home, '.config/fixture-harness/mcp.json');
  assert.ok(fs.existsSync(customFile), 'runtime additions auto-configure their declared location inside the sandbox');
  registry.push({ id: 'fixture-workspace', label: 'Workspace harness', enabled: true, integrations: { mcp: { strategy: 'config-file', format: 'json', base: 'workspace', path: '.fixture/mcp.json' } } });
  changed(); await nextTurn();
  assert.ok((await status()).engines.some(engine => engine.state === 'pending-workspace'));
  const sourceA = path.join(home, 'workspace-a'), sourceB = path.join(home, 'workspace-b');
  config = { workspaces: [{ id: 'w', name: 'Fixture', roots: [{ id: 'a', path: sourceA }, { id: 'b', path: sourceB }] }] };
  configChanged(); await nextTurn();
  assert.ok(fs.existsSync(path.join(sourceA, '.fixture/mcp.json'))); assert.ok(fs.existsSync(path.join(sourceB, '.fixture/mcp.json')));
  const writes = messages.length; config = { ...config, locale: 'en' }; configChanged(); await nextTurn();
  assert.equal(messages.length, writes, 'ordinary config edits do not reconcile MCP');
  const queued = install();
  registry = [...registry, { id: 'during-setup', label: 'During setup', enabled: true, integrations: { mcp: { strategy: 'config-file', format: 'json', base: 'home', path: 'during-setup.json' } } }];
  changed();
  assert.equal((await queued).ok, true);
  assert.ok(fs.existsSync(path.join(home, 'during-setup.json')), 'setup uses the current registry without a CLI version response');
  globalThis.__inboundAutoQuit(); assert.equal(runtimeOff, 1); assert.equal(configOff, 1);
  console.log('inbound-mcp-auto-ipc: boot ensure, sandbox isolation, actual status, retry, idempotence and transport failures passed');
} finally {
  console.error = previousLog;
  if (previousSandbox === undefined) delete process.env.MUSTER_SANDBOX; else process.env.MUSTER_SANDBOX = previousSandbox;
  delete globalThis.__inboundAutoQuit; delete globalThis.__inboundAutoHandlers; delete globalThis.__inboundAutoLaunch; delete globalThis.__inboundAutoUserData;
  fs.rmSync(temporary, { recursive: true, force: true });
}
