/** Exercise the real catalog IPC handler and deadline helper with a short test deadline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript'), Module = require('node:module');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function compile(file, mocks = {}) {
  const filename = path.join(root, file), mod = new Module(filename);
  mod.require = name => Object.hasOwn(mocks, name) ? mocks[name] : {};
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
  return mod.exports;
}
const bounded = compile('src/main/agentSession/processReclamation.ts');
const handlers = new Map();
let locale = 'en', target = () => Promise.resolve({ workspaceId: 'w', cwd: '/workspace', sourceRoot: { rootId: 'r' } }), probe = () => new Promise(() => {});
const translations = { '运行目录检查': 'Working directory check', 'ACP 检测': 'ACP check', '外部引擎检测': 'External engine check' };
function t(key, params) {
  if (locale === 'en' && key === '{{operation}} 超时') return `${params.operation} timed out.`;
  if (locale === 'en' && key === '{{operation}} 已取消') return `${params.operation} was cancelled.`;
  if (locale === 'en') return translations[key] ?? key;
  return key.replace('{{operation}}', params?.operation ?? '');
}
const sent = [];
const mocks = {
  './handle': { handle: (name, cb) => handlers.set(name, cb), ipcCaller: () => ({ id: 1, isAlive: () => true }) },
  './chatSearch': { registerHistorySearchIpc: () => {} },
  '../../shared/i18n': { t },
  electron: { app: { getPath: () => root } },
  '../agentSession/processReclamation': bounded,
  '../agentSession/drivers/acp/models': {
    boundedAcpRequest: (promise, _ms, label, signal) => bounded.boundedAcpRequest(promise, 5, label, signal),
    listAcpModels: async () => ({ ok: true, items: [{ id: 'model-a', name: 'Model A' }] })
  },
  '../sessions/targets': { resolveSessionTarget: (...args) => target(...args), assertSessionTargetCurrent: () => {} },
  '../turnChanges/ipc': { registerTurnChangesIpc: () => {} },
  '../agentSession/refreshHarnessCatalogs': { refreshHarnessCatalogs: async (_ctx, _dir, _signal, observers) => {
    const row = { id: '0', name: 'Test', source: 'Source', state: 'queued' };
    observers.availability();
    observers.catalogs('Workspace', [row]);
    const done = { ...row, state: 'done', models: 2 };
    observers.progress(done);
    observers.updated('acp', await target(), 'test');
    return { workspace: 'Workspace', rows: [done] };
  } },
  '../agentSession/harnessModelSelectionStore': { HarnessModelSelectionStore: class {} },
  '../../shared/harnessCatalog': { HARNESS_CATALOG: [] },
  '../safety/redact': { collectEnvSecrets: () => [], redactSafetyText: value => value }
};
const { registerAgentSessionIpc } = compile('src/main/ipc/agentSession.ts', mocks);
registerAgentSessionIpc({
  config: { get: () => ({}) },
  runtimes: { get: () => ({ enabled: true }) },
  agentSessions: { probeRuntime: (...args) => probe(...args), getDriver: () => ({}) },
  getWindow: () => ({ webContents: { send: (...args) => sent.push(args) } })
});
const source = { workspaceId: 'w', rootId: 'r' };
const acp = args => handlers.get('agentSession:listAcpModels')({}, { source, agentId: 'test', requestId: 'acp', ...args });
const local = args => handlers.get('agentSession:listLocalHarnessModels')({}, { source, runtimeId: 'claude', requestId: 'local', ...args });
// Keep Node alive for the intentionally unref'ed real timeout timer.
const keepAlive = setInterval(() => {}, 1000);
try {
  target = () => new Promise(() => {});
  assert.deepEqual(await acp({}), { ok: false, error: 'Working directory check timed out.' });
  target = () => Promise.resolve({ workspaceId: 'w', cwd: '/workspace', sourceRoot: { rootId: 'r' } });
  assert.deepEqual(await acp({ refresh: true }), { ok: false, error: 'ACP check timed out.' });
  assert.deepEqual(await local({ refresh: true }), { ok: false, error: 'External engine check timed out.' });
  locale = 'zh-CN'; target = () => new Promise(() => {});
  assert.deepEqual(await acp({}), { ok: false, error: '运行目录检查 超时' });
  const pending = acp({}); locale = 'en';
  assert.deepEqual(await pending, { ok: false, error: 'Working directory check timed out.' }, 'language is resolved when the timeout is displayed');
  locale = 'en';
  target = () => Promise.reject(new Error('外部原始错误'));
  assert.deepEqual(await acp({}), { ok: false, error: '外部原始错误' }, 'upstream errors stay untouched');
  target = () => Promise.reject(new Error('运行目录检查 超时'));
  assert.deepEqual(await acp({}), { ok: false, error: '运行目录检查 超时' }, 'identical upstream text is not a host timeout');
  locale = 'en';
  target = () => Promise.resolve({ workspaceId: 'w', cwd: '/workspace', sourceRoot: { rootId: 'r' } });
  probe = () => Promise.resolve({ status: 'available' });
  const refreshed = await acp({ refresh: true });
  assert.equal(refreshed.ok, true);
  assert.deepEqual(sent.at(-1), ['agentSession:modelCatalogUpdated', {
    runtimeId: 'acp', agentId: 'test', workspaceId: 'w', rootId: 'r', cwd: '/workspace', requestId: 'acp'
  }], 'a manual refresh broadcasts the shared catalog update');
  const batch = await handlers.get('agentSession:refreshHarnessModelCatalogs')({}, 'batch-test');
  assert.equal(batch.ok && batch.rows[0].models, 2);
  assert.deepEqual(sent.slice(-4).map(([channel]) => channel), ['runtimes:availabilityChanged',
    'agentSession:harnessCatalogRefreshProgress', 'agentSession:harnessCatalogRefreshProgress', 'agentSession:modelCatalogUpdated']);
  assert.equal(sent.at(-2)[1].requestId, 'batch-test');
} finally { clearInterval(keepAlive); }
console.log('agent-session catalog i18n: actual IPC deadlines and upstream errors verified');
