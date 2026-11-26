import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'cua-transport-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { CuaTransport } = await import(pathToFileURL(compile('main/desktop/cuaTransport.ts')));
  const { ManagedStdioTransport } = await import(pathToFileURL(compile('main/desktop/managedStdioTransport.ts')));
  const jobPath = path.resolve('src/main/agentSession/drivers/codex/worker/windows-job.ps1');
  const calls = [];
  let closed = 0;
  const transport = { close: async () => { closed++; } };
  const client = { connect: async t => calls.push(['connect', t]),
    callTool: async (request, schema, options) => { calls.push(['call', request, options]); return { ok: true }; },
    listTools: async () => ({ tools: [{ name: 'set_value', inputSchema: { type: 'object', additionalProperties: false,
      properties: { delivery_mode: { type: 'string', enum: ['background', 'foreground'] } } } }] }),
    close: async () => { closed++; } };
  let options;
  const factory = o => { options = o; return { client, transport }; };
  assert.throws(() => new CuaTransport('relative', {}, factory), /absolute/);
  const cua = new CuaTransport(path.resolve('driver'), { PATH: 'safe', SECRET: 'must-not-leak', DISPLAY: ':1' }, factory);
  assert.deepEqual(options.env, { PATH: 'safe', DISPLAY: ':1', CUA_DRIVER_RS_TELEMETRY_ENABLED: '0', CUA_TELEMETRY_ENABLED: '0' });
  new CuaTransport(path.resolve('driver'), { WAYLAND_DISPLAY: 'wayland-0', CUA_DRIVER_RS_TELEMETRY_ENABLED: '1', SECRET: 'sensitive' }, factory);
  assert.equal(options.env.CUA_DRIVER_RS_ENABLE_WAYLAND, '1');
  assert.equal(options.env.CUA_DRIVER_RS_TELEMETRY_ENABLED, '0');
  assert.equal(options.env.SECRET, undefined);
  new CuaTransport(path.resolve('driver'), {}, factory, { embedded: true });
  assert.equal(options.env.CUA_DRIVER_EMBEDDED, '1');
  const envFixture = path.join(temp, 'env-fixture.cjs');
  fs.writeFileSync(envFixture, `process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'environment',params:{
    leaked:process.env.SENTINEL_SECRET !== undefined, telemetry:process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
    wayland:process.env.CUA_DRIVER_RS_ENABLE_WAYLAND}})+'\\n'); setInterval(() => {},1000);`);
  let receiveEnvironment;
  const actualEnvironment = new Promise(resolve => { receiveEnvironment = resolve; });
  const childFactory = ({ env }) => {
    const processTransport = new ManagedStdioTransport(process.execPath, env, 150, [envFixture], undefined, jobPath);
    processTransport.onmessage = receiveEnvironment;
    return { transport: processTransport, client: { connect: () => processTransport.start(), close: async () => {},
      callTool: async () => ({}), listTools: async () => ({ tools: [] }) } };
  };
  const child = new CuaTransport(path.resolve('driver'), { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
    WAYLAND_DISPLAY: 'wayland-0', SENTINEL_SECRET: 'secret-value' }, childFactory);
  await child.connect();
  assert.deepEqual((await actualEnvironment).params, { leaked: false, telemetry: '0', wayland: '1' });
  await child.close();
  await assert.rejects(cua.call('list_apps', {}), /not connected/);
  await cua.connect();
  assert.equal(await cua.setValueDelivery('win32'), 'mode-parameter');
  await assert.rejects(cua.setValueDelivery('freebsd'), /Unsupported/);
  await assert.rejects(cua.connect(), /twice/);
  const controller = new AbortController();
  assert.deepEqual(await cua.call('list_windows', { pid: 1 }, controller.signal), { ok: true });
  assert.equal(calls[1][1].name, 'list_windows');
  assert.equal(calls[1][2].signal, controller.signal);
  await assert.rejects(cua.call('shell', {}), /Unsupported/);
  controller.abort();
  await assert.rejects(cua.call('list_apps', {}, controller.signal));
  await cua.close();
  await cua.close();
  assert.equal(closed, 2, 'both client and underlying transport must be closed');
  await assert.rejects(cua.call('list_apps', {}), /not connected/);
  const brokenClient = { ...client, callTool: async () => { throw new Error('connection lost'); } };
  const broken = new CuaTransport(path.resolve('driver'), {}, () => ({ client: brokenClient, transport }));
  await broken.connect();
  await assert.rejects(broken.call('click', {}), /connection lost/);
  await assert.rejects(broken.call('click', {}), /not connected/, 'uncertain requests must not reuse the transport');
  const cleanupFailure = new CuaTransport(path.resolve('driver'), {}, () => ({
    client: { ...brokenClient, close: async () => { throw new Error('process did not exit'); } }, transport
  }));
  await cleanupFailure.connect();
  await assert.rejects(cleanupFailure.call('click', {}), /driver exit is unconfirmed/);
  await assert.rejects(cleanupFailure.close(), /process did not exit/, 'failed cleanup must remain observable');
  const detachedClient = new CuaTransport(path.resolve('driver'), {}, () => ({
    client: { ...client, close: async () => {} },
    transport: { close: async () => { throw new Error('owned tree is unknown'); } }
  }));
  await detachedClient.connect();
  await assert.rejects(detachedClient.close(), /owned tree is unknown/, 'an SDK-detached transport still needs reclamation');
  const mac = new CuaTransport(path.resolve('driver'), {}, () => ({ client: { ...client, listTools: async () => ({ tools: [
    { name: 'set_value', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  ] }) }, transport }));
  await mac.connect();
  assert.equal(await mac.setValueDelivery('darwin'), 'background-only');
  assert.equal(await mac.setValueDelivery('linux'), 'unavailable', 'missing schema capability must not be inferred on Linux');
  await mac.close();
  const missingTool = new CuaTransport(path.resolve('driver'), {}, () => ({ client: { ...client,
    listTools: async () => ({ tools: [] }) }, transport }));
  await missingTool.connect();
  assert.equal(await missingTool.setValueDelivery('win32'), 'unavailable');
  await missingTool.close();
  let finishListing;
  const delayedListing = new CuaTransport(path.resolve('driver'), {}, () => ({ client: { ...client,
    listTools: () => new Promise(resolve => { finishListing = resolve; }) }, transport }));
  await delayedListing.connect();
  const listing = delayedListing.setValueDelivery('win32');
  await delayedListing.close();
  finishListing({ tools: [{ name: 'set_value', inputSchema: { type: 'object', properties: {
    delivery_mode: { type: 'string', enum: ['background', 'foreground'] } } } }] });
  await assert.rejects(listing, /interrupted/, 'a late schema response cannot revive a closed driver');
  let finishClose;
  const closingClient = { ...client, close: () => new Promise(resolve => { finishClose = resolve; }) };
  const closing = new CuaTransport(path.resolve('driver'), {}, () => ({ client: closingClient, transport }));
  await closing.connect();
  const closeFirst = closing.close();
  let secondFinished = false;
  const closeSecond = closing.close().then(() => { secondFinished = true; });
  await Promise.resolve();
  assert.equal(secondFinished, false, 'concurrent close must await the same reclamation');
  finishClose();
  await Promise.all([closeFirst, closeSecond]);
  let finishCall;
  const slowClient = { ...client, callTool: () => new Promise(resolve => { finishCall = resolve; }) };
  const late = new CuaTransport(path.resolve('driver'), {}, () => ({ client: slowClient, transport }));
  await late.connect();
  const inFlight = late.call('click', {});
  await late.close();
  finishCall({ ok: true });
  await assert.rejects(inFlight, /outcome.*unknown/, 'a reply arriving after close cannot claim confirmed success');
  let finishConnect;
  const delayedClient = { ...client, connect: () => new Promise(resolve => { finishConnect = resolve; }) };
  const delayed = new CuaTransport(path.resolve('driver'), {}, () => ({ client: delayedClient, transport }));
  const connecting = delayed.connect();
  await assert.rejects(delayed.connect(), /twice/);
  await delayed.close();
  finishConnect();
  await assert.rejects(connecting, /closed while connecting/);
  await assert.rejects(delayed.call('list_apps', {}), /not connected/);
  if (process.env.MUSTER_TEST_CUA_BINARY) {
    const live = new CuaTransport(process.env.MUSTER_TEST_CUA_BINARY);
    await live.connect();
    try {
      const result = await live.call('list_apps', {});
      assert.notEqual(result.isError, true);
      if (process.platform === 'win32') assert.equal(await live.setValueDelivery(process.platform), 'mode-parameter');
    } finally { await live.close(); }
    console.log('Cua transport: real driver list_apps and confirmed exit passed');
  }
  console.log('Cua transport: lifecycle, tool allowlist, environment and cancellation passed');
} finally { removeWorkspaceFixture(temp, 'cua-transport-'); }
