import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { removeWorkspaceFixture } from './helpers/workspace-fixture.mjs';

fs.mkdirSync('.tmp', { recursive: true });
const temp = fs.mkdtempSync(path.resolve('.tmp', 'gateway-turn-binding-'));
let gateway;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  // Reproduce the old implementation only in this fixture's temporary output;
  // the same assertion must fail when the header snapshot is omitted.
  const originalRead = fs.readFileSync;
  let reverted = false, gatewayModule;
  if (process.env.MUSTER_TEST_ORIGINAL_WAIT_SOURCE === '1') fs.readFileSync = function(file, ...args) {
    const value = originalRead.call(this, file, ...args);
    if (typeof value !== 'string' || !String(file).replaceAll('\\', '/').endsWith('/drivers/acp/hostToolGateway.ts')) return value;
    const expected = `const execute = () => hostTools.invoke(name, call, { id, signal: request.signal,\n            desktopTurnSnapshot: { id: desktopTurnId, isCurrent: () => !closed && !request.signal.aborted &&\n              !!desktopTurnId && input.getDesktopTurnId?.() === desktopTurnId } });`;
    const normalized = value.replaceAll('\r\n', '\n');
    assert.ok(normalized.includes(expected), 'original-source control must replace the exact snapshot code');
    reverted = true;
    return normalized.replace(expected, 'const execute = () => hostTools.invoke(name, call, { id, signal: request.signal });');
  };
  try { gatewayModule = compile('main/agentSession/drivers/acp/hostToolGateway.ts'); }
  finally { fs.readFileSync = originalRead; }
  if (process.env.MUSTER_TEST_ORIGINAL_WAIT_SOURCE === '1') assert.equal(reverted, true);
  const { startHostToolGateway } = await import(pathToFileURL(gatewayModule));
  const { currentGuiExecutionTurn } = await import(pathToFileURL(compile('main/agent/agentScope.ts')));
  let turn = 'old-turn', desktopTurn = 'desktop-old', entered, executions = 0, throwGetter = false;
  const observed = [];
  const tool = { id: 'host.fixture', label: 'fixture', description: 'fixture', permissionClass: 'status',
    parameters: { type: 'object', additionalProperties: false, properties: {} }, execute: async () => {
      executions++; const scope = currentGuiExecutionTurn();
      observed.push({ desktopTurnId: scope?.desktopTurnId, current: scope?.isDesktopCurrent?.() }); return 'done';
    } };
  const desktopTool = { ...tool, id: 'host.desktop.fixture' };
  gateway = await startHostToolGateway({ sessionId: 'fixture', cwd: temp, hostTools: [tool, desktopTool],
    getTurnId: () => { if (throwGetter) throw new Error('getter failed'); entered?.(); entered = undefined; return turn; },
    getDesktopTurnId: () => desktopTurn,
    requestApproval: async () => ({ approved: true }), getPolicyState: () => ({ mode: 'auto', planExecuting: false }), log() {} });
  const bodyFor = name => JSON.stringify({ token: gateway.token, name, arguments: {} });
  const slow = async (name, change) => {
    const initialHeaders = new Promise(resolve => { entered = resolve; });
    const body = bodyFor(name);
    let request;
    const response = new Promise((resolve, reject) => {
      request = http.request(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
        let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve(JSON.parse(text)));
      });
      request.on('error', reject);
    });
    request.write(body.slice(0, 5));
    let timer;
    await Promise.race([initialHeaders, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('request headers were not bound to their turn')), 2000); })]);
    clearTimeout(timer);
    change();
    request.end(body.slice(5));
    return response;
  };
  const stale = await slow('host_fixture', () => { turn = 'new-turn'; });
  assert.equal(stale.isError, true);
  assert.equal(executions, 0, 'a request opened in the previous turn cannot execute in the next turn');
  const current = await fetch(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyFor('host_fixture') });
  assert.equal((await current.json()).isError, false);
  assert.equal(executions, 1, 'a fresh request in the new turn still executes');
  const steered = await slow('host_desktop_fixture', () => { desktopTurn = 'desktop-new'; });
  assert.equal(steered.isError, true);
  assert.equal(executions, 1, 'a desktop request cannot cross a user steer within the same execution turn');
  const unrelated = await slow('host_fixture', () => { desktopTurn = 'desktop-later'; });
  assert.equal(unrelated.isError, false, 'desktop instruction changes must not cancel unrelated host tools');
  assert.equal(executions, 2);
  assert.deepEqual(observed.at(-1), { desktopTurnId: 'desktop-new', current: false },
    'a non-desktop tool may run, but its source stays bound to request headers rather than the later instruction');
  const oldCredentialBody = bodyFor('host_fixture'), oldCredential = gateway.token;
  const nextCredential = gateway.rotateToken();
  assert.ok(nextCredential !== oldCredential, 'rotating a credential must change it');
  const replay = await fetch(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oldCredentialBody });
  assert.equal(replay.status, 403, 'an old process credential is rejected even if its headers arrive in the new turn');
  assert.equal(executions, 2);
  const rotated = await fetch(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyFor('host_fixture') });
  assert.equal((await rotated.json()).isError, false);
  assert.equal(executions, 3);
  throwGetter = true;
  const unavailable = await fetch(gateway.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyFor('host_fixture') });
  assert.equal(unavailable.status, 503, 'an unavailable host turn must not crash the HTTP server');
  assert.equal((await unavailable.json()).isError, true);
  console.log('host tool gateway: delayed body remains bound to its original turn');
} finally { gateway?.close(); removeWorkspaceFixture(temp, 'gateway-turn-binding-'); }
