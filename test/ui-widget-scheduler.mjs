import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ui-scheduler-'));
try {
  const outfile = path.join(temp, 'host.cjs');
  await build({ stdin: { contents: `export { uiWidgetsHost } from './src/main/capabilities/hosts/uiWidgets';
    export * from './src/main/agent/agentScope';
    export * from './src/shared/uiWidgetSession';`, resolveDir: process.cwd() },
    outfile, bundle: true, platform: 'node', format: 'cjs', plugins: [{ name: 'host-fixture', setup(b) {
      b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      b.onResolve({ filter: /uiWidgetSmoke$/ }, () => ({ path: 'smoke', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: name === 'electron'
        ? `export const app = { getPath: () => ${JSON.stringify(temp)} };`
        : 'export const smokeUiWidgetReport = async () => ({warnings: [], diagnostics: []});' }));
    } }] });
  const { uiWidgetsHost: host, runAsAgentWorkspace, runAsSchedulerTool, runAsAgentSession,
    uiWidgetSessionDirectory: directory, uiWidgetSessionFromDirectory: identity } = createRequire(import.meta.url)(outfile);
  const workspace = '12345678-1234-1234-1234-123456789abc';
  const sid = `orchestrator:${workspace}`;
  const schedule = (fn, ws = workspace) => runAsAgentWorkspace(ws, () => runAsSchedulerTool(fn));
  const ctx = { getWindow: () => null, sessions: { get: () => undefined } };
  const input = { title: 'Probe', html: '<ma-text>Probe</ma-text>' };
  // First assertion deliberately exercises the original failure, before mapping-specific tests.
  const first = await schedule(() => host['ui.render'](ctx, input));
  assert.equal(first.version, 1);
  assert.equal(path.basename(path.dirname(path.dirname(first.link))), `orchestrator.${workspace}`);
  assert.equal(identity(directory(sid)), sid);
  assert.notEqual(directory(sid), directory(`orchestrator-${workspace}`), 'scheduler and Worker namespaces cannot collide');
  for (const invalid of ['', '../x', 'a/b', 'a\\b', 'C:x', sid + '/x', 'orchestrator:invalid', directory(sid), 'a'.repeat(65)]) {
    assert.throws(() => directory(invalid), undefined, invalid);
  }
  assert.equal(identity(`orchestratorX${workspace}`), `orchestratorX${workspace}`);
  for (const invalid of ['..', sid, 'C:\\x']) assert.throws(() => identity(invalid));
  for (const platform of [path.win32, path.posix]) {
    const root = platform.resolve('artifacts');
    assert.equal(platform.relative(root, platform.join(root, directory(sid))), directory(sid));
  }
  const updated = await schedule(() => host['ui.render'](ctx, { ...input, update: first.link }));
  assert.equal(updated.link, first.link); assert.equal(updated.version, 2);
  const listing = await schedule(() => host['ui.inspect'](ctx, {}));
  assert.equal(listing.widgets.length, 1); assert.equal(listing.widgets[0].version, 2);
  assert.equal((await schedule(() => host['ui.inspect'](ctx, { link: first.link }))).widgets.length, 1);
  const worker = await runAsAgentSession('worker-a', () => host['ui.render'](ctx, { ...input, sessionId: 'worker-b' }));
  assert.equal(path.basename(path.dirname(path.dirname(worker.link))), 'worker-a');
  const boundWorker = await host['ui.render'](ctx, { ...input, sessionId: 'legacy-cli' });
  assert.equal(path.basename(path.dirname(path.dirname(boundWorker.link))), 'legacy-cli');
  for (const link of [worker.link, boundWorker.link, path.join(temp, 'outside.inline.html'), path.join(path.dirname(first.link), 'nested', '01-x.inline.html')]) {
    await assert.rejects(schedule(() => host['ui.inspect'](ctx, { link })));
    await assert.rejects(schedule(() => host['ui.render'](ctx, { ...input, update: link })));
  }
  await assert.rejects(schedule(() => host['ui.inspect'](ctx, { link: first.link }), 'abcdef12-1234-1234-1234-123456789abc'));
  const spoof = await schedule(() => host['ui.render'](ctx, { ...input, sessionId: 'worker-a' }));
  assert.equal(path.dirname(spoof.link), path.dirname(first.link));
  await assert.rejects(host['ui.render'](ctx, input));
  await assert.rejects(runAsSchedulerTool(() => host['ui.render'](ctx, { ...input, sessionId: 'worker-a' })));
  console.log('ui-widget-scheduler: scheduler/Worker render, inspect, update, identity mapping and ownership passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
