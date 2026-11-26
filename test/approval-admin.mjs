import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Execute the actual IPC callbacks with a reviewer that must never be reached.
const source = ts.createSourceFile('workspaces.ts', fs.readFileSync('src/main/ipc/workspaces.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const callbacks = new Map();
const find = node => {
  if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[1]) callbacks.set(node.arguments[0].text, node.arguments[1]);
  ts.forEachChild(node, find);
};
find(source);
let config = {}, calls = [], invalidations = 0;
const ctx = {
  tasks: {
    get: id => id === 'missing' ? null : { id, name: 'old', workspaceId: 'ws' },
    create: opts => { calls.push(['create', opts]); return opts; },
    update: (id, patch) => { calls.push(['update', id, patch]); return patch; }
  },
  runtimes: {
    get: id => ({ id, label: 'old' }),
    update: async (id, patch) => { calls.push(['runtime', id, patch]); return { id, ...patch }; },
    changed: () => calls.push(['changed'])
  },
  config: { get: () => config, update: patch => (config = { ...config, ...patch }) },
  safety: { authorize: async () => { throw new Error('human action unexpectedly reviewed'); } },
  getWindow: () => null
};
function handler(name) {
  const callback = callbacks.get(name); assert.ok(callback, `${name} registered`);
  const code = ts.transpileModule(`exports.handler=${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  new Function('exports', 'ctx', 'path', 't', 'invalidateRuntimeAvailability', 'approveAdministrativeChange', 'safetyRisk', 'runtimeApprovalState', 'previewScript', code)(
    exports, ctx, path, value => value, () => { invalidations++; },
    () => { throw new Error('human action unexpectedly reviewed'); }, () => 'high', () => ({}), () => ''
  );
  return exports.handler;
}
const create = handler('services:create'), update = handler('services:update');
assert.deepEqual(await create(null, { workspaceId: 'ws', name: 'job' }), { workspaceId: 'ws', name: 'job' });
assert.deepEqual(await update(null, 'job', { schedule: 'daily' }), { schedule: 'daily' });
assert.throws(() => update(null, 'missing', { schedule: 'daily' }), /不存在/);
const runtime = handler('runtimes:update');
assert.deepEqual(await runtime(null, { id: 'runtime', scriptSource: 'export {}' }), { ok: true, entry: { id: 'runtime', scriptSource: 'export {}' } });
const externalPi = handler('runtimes:setExternalPiExecutable');
const executable = path.resolve('fixture-cli');
assert.equal((await externalPi(null, { id: 'pi-external', executable })).externalPi['pi-external'].executable, executable);
const externalHarness = handler('runtimes:setExternalHarnessExecutable');
assert.equal((await externalHarness(null, { id: 'muse-gui', executable })).externalHarness['muse-gui'].executable, executable);
assert.equal(invalidations, 1);
assert.equal((await externalHarness(null, { id: 'muse-gui', executable: 'relative' })).ok, false);
assert.deepEqual(calls.slice(0, 3).map(call => call[0]), ['create', 'update', 'runtime']);
console.log('administrative IPC: human changes bypass review while retaining validation');
