/** Real ACP discovery stdio must enter the creation-time container, then close its descendants. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-catalog-owner-'));
const compile = createSharedCompiler(process.cwd(), folder);
const entry = compile('main/agentSession/drivers/acp/models.ts');
const commandEntry = compile('main/agentSession/process/ownedCommand.ts');
const original = fs.readFileSync(commandEntry, 'utf8');
const instrumented = original.replace('export async function startOwnedCommand(options) {', 'export async function startOwnedCommand(options) { globalThis.__acpCatalogOwnedStarts = (globalThis.__acpCatalogOwnedStarts || 0) + 1;');
assert.notEqual(instrumented, original, 'instrument the real container entry without replacing its protocol');
fs.writeFileSync(commandEntry, instrumented);
const fixture = path.join(folder, 'agent.cjs');
fs.writeFileSync(fixture, `const fs=require('node:fs'),{spawn}=require('node:child_process'),readline=require('node:readline');
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(process.argv[2],JSON.stringify({root:process.pid,descendant:descendant.pid}));
if(process.argv[3]==='exit-on-start')process.stderr.write('Error: cannot load provider config\\n',()=>process.exit(9));
readline.createInterface({input:process.stdin}).on('line',line=>{const request=JSON.parse(line);if(request.method==='session/prompt')throw Error('discovery must never infer');
const mode=process.argv[3];
if(request.method==='session/new'&&mode==='hermes-denied'){
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'Internal error',data:{details:"[Errno 1] Operation not permitted: 'logs/agent.log' ("+process.env.MUSTER_TEST_CATALOG_TOKEN+")"}}})+'\\n');return;
}
if(request.method==='session/create'&&(mode==='exit-with-error'||mode==='exit-silent')){
  if(mode==='exit-silent')process.exit(2);
  process.stderr.write('Unrelated diagnostic log\\nError: listen EPERM: operation not permitted broker.sock token='+process.env.MUSTER_TEST_CATALOG_TOKEN+'\\n',()=>process.exit(1));return;
}
let result;if(request.method==='initialize')result={protocolVersion:2};else if(request.method==='session/new'){if(process.argv[3]==='hang')return;result={sessionId:'fixture-session',models:{currentModelId:'fixture-model',availableModels:[{modelId:'fixture-model',name:'Fixture model'}]}};}
else if(request.method==='session/create')result={protocol:{name:'ZCode Protocol',version:2},settings:{mode:{current:'build'},model:{available:process.argv[3]==='empty'?[]:[{label:'ZCode fixture',ref:{providerId:'fixture',modelId:'model'}}]}}};
else throw Error(request.method);
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});`);
const agentsEntry = compile('main/agentSession/drivers/acp/agents.ts');
fs.writeFileSync(agentsEntry, `export function getAcpPresets(){return [{id:'opencode'},{id:'hermes'}];}
export function lookOnPath(){return null;}
export function resolveAcpLaunch(){return {command:${JSON.stringify(process.execPath)},args:[${JSON.stringify(fixture)},globalThis.__acpCatalogMarker,globalThis.__acpCatalogMode]};}`);
const { listAcpModels } = await import(pathToFileURL(entry));
const { listZCodeModels } = await import(pathToFileURL(compile('main/agentSession/drivers/zcode/process.ts')));
const { ModelCatalogCache } = await import(pathToFileURL(compile('main/agentSession/modelCatalogCache.ts')));
const { nativeExecutableVersion } = await import(pathToFileURL(compile('main/agentSession/drivers/nativeExecutableVersion.ts')));
const { shutdownControlledChildren } = await import(pathToFileURL(compile('main/agentSession/process/controlledChild.ts')));
const assertGone = marker => { for (const pid of Object.values(JSON.parse(fs.readFileSync(marker, 'utf8')))) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); };
const secret = 'sensitive-catalog-test-value';
const previousSecret = process.env.MUSTER_TEST_CATALOG_TOKEN;
process.env.MUSTER_TEST_CATALOG_TOKEN = secret;
try {
  globalThis.__acpCatalogMarker = path.join(folder, 'success.json'); globalThis.__acpCatalogMode = 'normal';
  const result = await listAcpModels({ cwd: folder, agentId: 'opencode', refresh: true });
  assert.equal(result.ok, true, result.error); assert.equal(result.items[0].id, 'fixture-model');
  assert.equal(globalThis.__acpCatalogOwnedStarts, 1, 'ACP discovery must actually call the creation-time owner, never bare spawn/taskkill');
  assertGone(globalThis.__acpCatalogMarker);
  globalThis.__acpCatalogMarker = path.join(folder, 'cancel.json'); globalThis.__acpCatalogMode = 'hang';
  const controller = new AbortController();
  const pending = listAcpModels({ cwd: folder, agentId: 'opencode', refresh: true, signal: controller.signal });
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(globalThis.__acpCatalogMarker)) { if (Date.now() > deadline) throw Error('ACP fixture did not start'); await new Promise(resolve => setTimeout(resolve, 10)); }
  controller.abort();
  const cancelled = await pending; assert.equal(cancelled.ok, false); assert.equal(cancelled.cleanupFailed, undefined);
  assertGone(globalThis.__acpCatalogMarker);

  const zcodeMarker = path.join(folder, 'zcode.json');
  const executable = path.join(folder, process.platform === 'win32' ? 'zcode-fixture.exe' : 'zcode-fixture');
  fs.copyFileSync(process.execPath, executable);
  fs.chmodSync(executable, 0o755);
  const zcodeFixture = mode => fs.writeFileSync(path.join(folder, 'app-server'),
    `process.argv[2]=${JSON.stringify(zcodeMarker)};process.argv[3]=${JSON.stringify(mode)};\n${fs.readFileSync(fixture, 'utf8')}`);
  zcodeFixture('configured');
  const zcode = await listZCodeModels({ cwd: folder, executableOverride: executable, refresh: true });
  assert.equal(zcode.ok, true, zcode.error);
  assert.equal(zcode.items[0].name, 'ZCode fixture');
  assert.ok(zcode.nativeConfig?.options[0]?.choices.some(choice => choice.value === 'build'));
  assert.equal(globalThis.__acpCatalogOwnedStarts, 3, 'ZCode discovery must use the creation-time owner as well');
  assertGone(zcodeMarker);

  zcodeFixture('empty');
  const empty = await listZCodeModels({ cwd: folder, executableOverride: executable, refresh: true });
  assert.equal(empty.ok, false, 'an empty ZCode catalog is not a successful refresh');
  assert.match(empty.error, /ZCode 未返回可用模型/);
  assertGone(zcodeMarker);
  const cached = await listZCodeModels({ cwd: folder, executableOverride: executable });
  assert.deepEqual(cached, zcode, 'an empty refresh preserves the last successful model catalog');
  new ModelCatalogCache('zcode').set(JSON.stringify([folder, executable, process.env.ZCODE_DATA_BASE_DIR,
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
    nativeExecutableVersion(executable, 'zcode-protocol-v1')]), { ok: true, items: [] });
  const oldEmpty = await listZCodeModels({ cwd: folder, executableOverride: executable });
  assert.deepEqual(oldEmpty, empty, 'an old empty snapshot cannot appear as a successful read');

  const desktop = path.join(folder, 'ZCode Desktop');
  const resources = path.join(desktop, process.platform === 'darwin' ? 'Resources' : 'resources');
  const desktopExe = process.platform === 'win32' ? path.join(desktop, 'ZCode.exe')
    : process.platform === 'darwin' ? path.join(desktop, 'MacOS', 'ZCode') : path.join(desktop, 'zcode');
  const keyringDir = path.join(resources, 'app.asar', 'node_modules', '@napi-rs', 'keyring');
  const providerDir = path.join(resources, 'config', 'provider');
  const glmDir = path.join(resources, 'glm');
  for (const dir of [path.dirname(desktopExe), keyringDir, providerDir, glmDir]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(process.execPath, desktopExe);
  fs.chmodSync(desktopExe, 0o755);
  fs.writeFileSync(path.join(providerDir, 'zcode-builtin.json'), '{}');
  fs.writeFileSync(path.join(glmDir, '.node-bundle-meta.json'), JSON.stringify({ runtime: 'electron-node', entry: 'zcode.cjs' }));
  fs.writeFileSync(path.join(keyringDir, 'index.js'), 'exports.AsyncEntry = class AsyncEntry {};');
  const desktopEntry = path.join(glmDir, 'zcode.cjs');
  fs.writeFileSync(desktopEntry, `import('@napi-rs/keyring').then(({ AsyncEntry }) => {
    if (typeof AsyncEntry !== 'function') throw Error('Packaged credential store unavailable');
    process.argv[2]=${JSON.stringify(zcodeMarker)};process.argv[3]='configured';
    ${fs.readFileSync(fixture, 'utf8')}
  });`);
  const desktopCatalog = await listZCodeModels({ cwd: folder, executableOverride: desktopEntry, refresh: true });
  assert.deepEqual(desktopCatalog, zcode, 'the desktop CLI can load its packaged Windows/macOS/Linux keyring module');
  assertGone(zcodeMarker);

  globalThis.__acpCatalogMarker = path.join(folder, 'hermes-denied.json');
  globalThis.__acpCatalogMode = 'hermes-denied';
  const hermes = await listAcpModels({ cwd: folder, agentId: 'hermes', refresh: true });
  assert.equal(hermes.ok, false);
  assert.match(hermes.error, /Hermes Agent.*权限.*Operation not permitted.*logs\/agent\.log/);
  assert.ok(!hermes.error.includes(secret));
  assertGone(globalThis.__acpCatalogMarker);

  const zcodeDiscovery = { cwd: folder, executableOverride: executable, refresh: true };
  zcodeFixture('configured');
  assert.deepEqual(await listZCodeModels(zcodeDiscovery), zcode);
  zcodeFixture('exit-with-error');
  const exit = await listZCodeModels(zcodeDiscovery);
  assert.equal(exit.ok, false);
  assert.match(exit.error, /ZCode.*listen EPERM: operation not permitted broker\.sock/);
  assert.ok(!exit.error.includes(secret) && !exit.error.includes('Unrelated diagnostic log'));
  assertGone(zcodeMarker);

  zcodeFixture('exit-on-start');
  const startup = await listZCodeModels(zcodeDiscovery);
  assert.equal(startup.ok, false);
  assert.match(startup.error, /ZCode.*cannot load provider config/);
  assertGone(zcodeMarker);

  zcodeFixture('exit-silent');
  const silent = await listZCodeModels(zcodeDiscovery);
  assert.equal(silent.ok, false);
  assert.match(silent.error, /ZCode.*退出.*状态码 2/);
  assertGone(zcodeMarker);
  assert.deepEqual(await listZCodeModels({ ...zcodeDiscovery, refresh: false }), zcode);
  console.log(`model-discovery-owner: OK (${process.platform}; process reclamation, discovery errors and cache preservation)`);
} finally {
  await shutdownControlledChildren();
  fs.rmSync(folder, { recursive: true, force: true });
  delete globalThis.__acpCatalogOwnedStarts; delete globalThis.__acpCatalogMarker; delete globalThis.__acpCatalogMode;
  if (previousSecret === undefined) delete process.env.MUSTER_TEST_CATALOG_TOKEN;
  else process.env.MUSTER_TEST_CATALOG_TOKEN = previousSecret;
}
