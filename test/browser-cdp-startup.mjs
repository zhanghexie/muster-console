import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-cdp-boot-'));
const fixtureKey = '__browserCdpBootFixture';
const previousFixture = globalThis[fixtureKey];
const previousPort = process.env.MUSTER_DEVTOOLS_PORT;
const switches = [];
let disabledFeatures = 'ExistingFeature';
let enabledFeatures = '';
const explicitAutomation = new Set();
globalThis[fixtureKey] = {
  app: { getPath: () => userData, commandLine: {
    appendSwitch: (...args) => switches.push(args),
    getSwitchValue: name => name === 'disable-blink-features' ? disabledFeatures : name === 'enable-blink-features' ? enabledFeatures : '',
    hasSwitch: name => explicitAutomation.has(name)
  } }
};

async function importBundle(entry, mockElectron = false) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false,
    logLevel: 'silent', plugins: mockElectron ? [{ name: 'electron-fixture', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const app = globalThis.${fixtureKey}.app` }));
    } }] : [] });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

let server, ownedServer;
try {
  const { configureBrowserCdpAtBoot, getBrowserCdpBootState, selectBrowserCdpBootState } =
    await importBundle('src/main/browser/cdpBoot.ts', true);
  const { cdpEndpointHasTarget, readDevToolsActivePort, waitForOwnedCdpEndpoint } = await importBundle('src/main/browser/cdpEndpoint.ts');

  assert.deepEqual(selectBrowserCdpBootState(undefined, true), { kind: 'enabled', port: 0 });
  assert.deepEqual(selectBrowserCdpBootState(undefined, false), { kind: 'disabled', port: 0 });
  assert.deepEqual(selectBrowserCdpBootState('9333', false), { kind: 'enabled', port: 9333 });
  for (const value of ['0', '-1', '65536', 'hello', '3.5']) {
    assert.equal(selectBrowserCdpBootState(value, true).kind, 'error', `invalid explicit port ${value}`);
  }

  delete process.env.MUSTER_DEVTOOLS_PORT;
  configureBrowserCdpAtBoot();
  const automatic = getBrowserCdpBootState();
  assert.equal(automatic.kind, 'enabled');
  assert.equal(automatic.port, 0);
  assert.deepEqual(switches.splice(0), [
    ['disable-blink-features', 'ExistingFeature,AutomationControlled'],
    ['remote-debugging-port', '0']
  ]);
  for (const flag of ['enable-automation', 'headless', 'remote-debugging-pipe']) {
    explicitAutomation.add(flag);
    configureBrowserCdpAtBoot();
    assert.deepEqual(switches.splice(0), [['remote-debugging-port', '0']], `preserve explicit ${flag}`);
    explicitAutomation.delete(flag);
  }
  enabledFeatures = 'OtherFeature,AutomationControlled<Trial';
  configureBrowserCdpAtBoot();
  assert.deepEqual(switches.splice(0), [['remote-debugging-port', '0']], 'preserve an explicitly enabled Blink feature');
  enabledFeatures = '';
  disabledFeatures = 'ExistingFeature,AutomationControlled';
  configureBrowserCdpAtBoot();
  assert.deepEqual(switches.splice(0), [
    ['disable-blink-features', 'ExistingFeature,AutomationControlled'],
    ['remote-debugging-port', '0']
  ]);
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ browser: { cdpEnabled: false } }));
  configureBrowserCdpAtBoot();
  assert.deepEqual(getBrowserCdpBootState(), { kind: 'disabled', port: 0 });
  assert.equal(switches.length, 0);
  process.env.MUSTER_DEVTOOLS_PORT = '9333';
  configureBrowserCdpAtBoot();
  assert.deepEqual(getBrowserCdpBootState(), { kind: 'enabled', port: 9333 });
  assert.deepEqual(switches.pop(), ['remote-debugging-port', '9333']);
  const oldConsoleError = console.error;
  try {
    console.error = () => {};
    process.env.MUSTER_DEVTOOLS_PORT = '0';
    configureBrowserCdpAtBoot();
    assert.equal(getBrowserCdpBootState().kind, 'error');
    assert.equal(switches.length, 0);
    process.env.MUSTER_DEVTOOLS_PORT = '9333';
    globalThis[fixtureKey].app.commandLine.appendSwitch = () => { throw new Error('fixture failure'); };
    configureBrowserCdpAtBoot();
    assert.match(getBrowserCdpBootState().detail, /fixture failure/);
  } finally { console.error = oldConsoleError; }

  let targetIds = ['our-window'];
  let mode = 'normal';
  server = http.createServer((_req, res) => {
    if (mode === 'hang') return;
    if (mode === 'invalid') { res.end('{'); return; }
    if (mode === 'large') { res.end('x'.repeat(1024 * 1024 + 1)); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(targetIds.map(id => ({ id }))));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  assert.equal(await cdpEndpointHasTarget(port, 'our-window'), true);
  assert.equal(await cdpEndpointHasTarget(port, 'other-window'), false);
  assert.equal(await waitForOwnedCdpEndpoint(port, () => 'our-window', { attempts: 1 }), port);
  await assert.rejects(waitForOwnedCdpEndpoint(port, () => 'other-window', { attempts: 2, intervalMs: 5 }), /not owned by this app/);
  let ownerChecks = 0;
  await assert.rejects(waitForOwnedCdpEndpoint(port, () => ++ownerChecks === 1 ? 'our-window' : 'new-window',
    { attempts: 1 }), /not owned by this app/, 'a replaced window must not validate a stale target');
  for (const candidate of ['invalid', 'large', 'hang']) {
    mode = candidate;
    assert.equal(await cdpEndpointHasTarget(port, 'our-window', 100), false, `${candidate} response must fail closed`);
  }
  mode = 'normal';
  targetIds = ['unrelated-window'];
  ownedServer = http.createServer((_req, res) => res.end('[{"id":"our-window"}]'));
  ownedServer.listen(0, '127.0.0.1');
  await once(ownedServer, 'listening');
  const ownedPort = ownedServer.address().port;
  const activeFile = path.join(userData, 'DevToolsActivePort');
  assert.equal(readDevToolsActivePort(activeFile), null);
  fs.writeFileSync(activeFile, '0\n');
  assert.equal(readDevToolsActivePort(activeFile), null);
  fs.writeFileSync(activeFile, `${port}\n/stale`);
  await assert.rejects(waitForOwnedCdpEndpoint(() => readDevToolsActivePort(activeFile), () => 'our-window',
    { attempts: 1 }), /not owned by this app/, 'a stale file must not connect to another process');
  setTimeout(() => fs.writeFileSync(activeFile, `${ownedPort}\n/current`), 20);
  assert.equal(await waitForOwnedCdpEndpoint(() => readDevToolsActivePort(activeFile), () => 'our-window',
    { attempts: 20, intervalMs: 10 }), ownedPort, 'retry must discover the updated Chromium port');
  let portReads = 0;
  await assert.rejects(waitForOwnedCdpEndpoint(() => ++portReads === 1 ? ownedPort : port, () => 'our-window',
    { attempts: 1 }), /not owned by this app/, 'a changed port must not validate a stale endpoint');
  console.log('browser-cdp-startup: OS-assigned port, preserved flags, explicit port, stale discovery and ownership passed');
} finally {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  ownedServer?.closeAllConnections();
  if (ownedServer) await new Promise(resolve => ownedServer.close(resolve));
  if (previousPort === undefined) delete process.env.MUSTER_DEVTOOLS_PORT;
  else process.env.MUSTER_DEVTOOLS_PORT = previousPort;
  if (previousFixture === undefined) delete globalThis[fixtureKey];
  else globalThis[fixtureKey] = previousFixture;
  const configPath = path.join(userData, 'config.json');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  const activeFile = path.join(userData, 'DevToolsActivePort');
  if (fs.existsSync(activeFile)) fs.unlinkSync(activeFile);
  fs.rmdirSync(userData);
}
