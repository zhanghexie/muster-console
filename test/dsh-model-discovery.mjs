/** DSH discovery must still return models, with native session writes isolated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-discovery-test-'));
const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
const load = entry => import(pathToFileURL(compile(entry)).href);
const normal = path.join(temp, 'normal-history');
const control = path.join(temp, 'control.json');
const trace = path.join(temp, 'trace.json');
const fixture = path.join(temp, 'dsh-fixture.mjs');
fs.mkdirSync(normal);
fs.writeFileSync(path.join(normal, 'keep.json'), 'existing session');
fs.writeFileSync(fixture, `
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import { pathToFileURL } from 'node:url';
const control = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const overlayPath = process.argv[process.argv.lastIndexOf('--patch') + 1];
const overlay = overlayPath && overlayPath.endsWith('.json') ? JSON.parse(fs.readFileSync(overlayPath, 'utf8')) : [];
const sessions = control.mode === 'ignored-session-overlay' ? control.normal : overlay.find(row => row.id === 'session-persistence-jsonl')?.config.root ?? control.normal;
const storage = control.mode === 'ignored-storage-overlay' ? control.normal : overlay.find(row => row.id === 'storage-json')?.config.root ?? control.normal;
const receipt = { sessions, storage, methods: [] };
const save = () => fs.writeFileSync(control.trace, JSON.stringify(receipt));
save();
if (control.mode !== 'no-proof') {
  const plugin = overlay.find(row => row.insert)?.insert[0].name;
  if (plugin) {
    try { (await import(plugin)).apply({ sessionPersistence: { root: sessions }, storage: { backend: { get: () => ({ root: storage }) } } }); }
    catch { process.exitCode = 1; }
  }
}
let selected = 'a';
const options = () => [
  { id: 'model', type: 'select', currentValue: selected, options: ['a', 'b'].map(value => ({ value, name: value })) },
  { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: selected === 'b' ? 'max' : 'low', options: ['low', 'max'].map(value => ({ value, name: value })) }
];
readline.createInterface({ input: process.stdin }).on('line', line => {
 const { id, method, params } = JSON.parse(line); receipt.methods.push(method); save();
 let result;
 if (method === 'initialize') result = { protocolVersion: 1 };
 else if (method === 'session/new') {
  for (const root of [sessions, storage]) { fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(path.join(root, 'new-session.json'), '{}'); }
  if (control.mode === 'protocol-failure') { console.log(JSON.stringify({ id, error: { code: -32000, message: 'fixture failed after session creation' } })); return; }
  result = { sessionId: 'discovery-session', configOptions: options() };
 } else if (method === 'session/set_config_option') { selected = params.value; result = { configOptions: options() }; }
 else throw Error('Unexpected method: ' + method);
 console.log(JSON.stringify({ id, result }));
});
`);
const entry = compile('main/agentSession/drivers/acp/models.ts');
const agents = compile('main/agentSession/drivers/acp/agents.ts');
fs.copyFileSync(agents, path.join(path.dirname(agents), 'real-agents.mjs'));
fs.writeFileSync(agents, `
export { wrapCmdShimIfNeeded } from './real-agents.mjs';
const args = ${JSON.stringify([fixture, control])};
export const getAcpPresets = () => [{ id: 'deepseek', args }];
export const resolveAcpLaunch = () => ({ command: ${JSON.stringify(process.execPath)}, executable: ${JSON.stringify(process.execPath)}, args });
`);
const { listAcpModels } = await import(pathToFileURL(entry));
const { createDshModelDiscovery } = await load('main/agentSession/drivers/acp/dshModelDiscovery.ts');
const { localizeGuiHostError } = await load('shared/guiHostError.ts');
const { applyLocaleSetting } = await load('shared/i18n/index.ts');
const { shutdownControlledChildren } = await load('main/agentSession/process/controlledChild.ts');
const readTrace = () => JSON.parse(fs.readFileSync(trace, 'utf8'));
const prepare = mode => { fs.rmSync(trace, { force: true }); fs.writeFileSync(control, JSON.stringify({ mode, normal, trace })); };
const discover = options => listAcpModels({ cwd: temp, agentId: 'deepseek', refresh: true, ...options });
const assertNormal = () => {
  assert.deepEqual(fs.readdirSync(normal), ['keep.json'], 'discovery must never create an empty session in normal storage');
  assert.equal(fs.readFileSync(path.join(normal, 'keep.json'), 'utf8'), 'existing session');
};
const assertRemoved = receipt => {
  assert.notEqual(receipt.sessions, normal, 'native session logs must use a dedicated temporary root');
  assert.notEqual(receipt.storage, normal, 'projection cache must use dedicated temporary storage');
  assert.equal(fs.existsSync(path.dirname(receipt.sessions)), false, 'temporary overlay, plugin, logs and projections are removed after reclaim');
  assertNormal();
};
try {
  prepare('success');
  const batch = await discover({ allModels: true });
  assert.equal(batch.ok, true, batch.error);
  assert.deepEqual(batch.items.map(model => model.id), ['a', 'b']);
  assert.deepEqual(batch.coverage, { total: 2, read: 2 });
  assert.equal(batch.reasoning.currentValue, 'low');
  assert.deepEqual(readTrace().methods, ['initialize', 'session/new', 'session/set_config_option']);
  assertRemoved(readTrace());
  const methods = readTrace().methods;
  const cached = await discover({ refresh: false, modelId: 'b' });
  assert.equal(cached.ok, true, cached.error);
  assert.equal(cached.reasoning.currentValue, 'max');
  assert.deepEqual(readTrace().methods, methods, 'ordinary reads still reuse the cache');

  prepare('success');
  const selected = await discover({ modelId: 'b' });
  assert.equal(selected.ok, true, selected.error);
  assert.equal(selected.reasoning.currentValue, 'max', 'model-specific parameter discovery still works');
  assertRemoved(readTrace());

  for (const mode of ['ignored-session-overlay', 'ignored-storage-overlay']) {
    prepare(mode);
    const result = await discover();
    assert.equal(result.ok, false, 'ignored overlays must never fall back to normal storage');
    assert.match(result.error, /临时存储/);
    applyLocaleSetting('en');
    assert.match(localizeGuiHostError(result.error), /^DeepSeek could not confirm temporary discovery storage/);
    assert.match(localizeGuiHostError('DeepSeek 临时探测存储确认 超时'), /DeepSeek temporary discovery storage verification.*timed out/);
    applyLocaleSetting('zh-CN');
    assert.deepEqual(readTrace().methods, [], 'no ACP requests before live storage proof');
    assertNormal();
    const isolated = readTrace().sessions === normal ? readTrace().storage : readTrace().sessions;
    assert.equal(fs.existsSync(path.dirname(isolated)), false);
  }

  prepare('protocol-failure');
  const failed = await discover();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /fixture failed/);
  assertRemoved(readTrace());

  prepare('no-proof');
  const abort = new AbortController();
  const pending = discover({ signal: abort.signal });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(trace)) { if (Date.now() > deadline) throw Error('DSH fixture did not start'); await new Promise(resolve => setTimeout(resolve, 20)); }
  abort.abort();
  const cancelled = await pending;
  assert.equal(cancelled.ok, false);
  assert.deepEqual(readTrace().methods, [], 'cancellation while waiting for proof cannot create a session');
  assertRemoved(readTrace());

  for (const platform of ['win32', 'darwin', 'linux']) {
    const executable = platform === 'win32' ? 'C:\\Program Files\\DeepSeek\\dsh.cmd' : '/opt/DeepSeek Harness/bin/dsh';
    const isolation = createDshModelDiscovery({ command: platform === 'win32' ? 'cmd.exe' : executable, executable, args: ['previously-wrapped'] }, ['--profile', 'acp', '--patch', 'user config.json'], platform);
    const joined = isolation.launch.args.join(' ');
    assert.match(joined, /--profile/); assert.match(joined, /user config.json/); assert.match(joined, /discovery.patch.json/);
    assert.doesNotMatch(joined, /previously-wrapped/);
    assert.equal(isolation.launch.command, platform === 'win32' ? 'cmd.exe' : executable);
    isolation.dispose(false);
    assert.equal(fs.existsSync(isolation.directory), true, 'failed reclaim must retain storage until ownership is released');
    isolation.dispose(true);
    assert.equal(fs.existsSync(isolation.directory), false);
  }
  assert.throws(() => createDshModelDiscovery({ command: 'C:\\100%\\dsh.cmd', args: [] }, ['--profile', 'acp'], 'win32'), /%/);
  console.log('DSH discovery: models, reasoning, batch, cache, live storage proof, ignored overlays, protocol failure, cancellation, cleanup and three-platform argv passed');
} finally {
  await shutdownControlledChildren();
  fs.rmSync(temp, { recursive: true, force: true });
}
