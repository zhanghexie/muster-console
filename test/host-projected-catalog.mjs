import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projected-catalog-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = p => import(pathToFileURL(compile(p)).href);
  const { schedulerProjectedCatalog, workerProjectedCatalog, workerPresetProjectedCatalog, ptyProjectedCatalog } = await load('main/capabilities/catalog/projectedCatalog.ts');
  const { projectHostDescriptions } = await load('main/capabilities/catalog/projectedDescriptions.ts');
  const { routeProjectedHostCall } = await load('main/capabilities/projectedHostRoute.ts');
  const scheduler = schedulerProjectedCatalog();
  assert.ok(scheduler.some(entry => entry.name === 'host.mail.read'));
  assert.ok(scheduler.some(entry => entry.name === 'host.ask'));
  assert.ok(!scheduler.some(entry => entry.name === 'sessions.readMessages'));
  assert.equal(scheduler.length, new Set(scheduler.map(entry => entry.name)).size);
  const description = scheduler.find(entry => entry.name === 'host.feedback.propose').def.description;
  assert.match(description, /host\.feedback\.history/);
  assert.doesNotMatch(description, /(?<!host\.)\bfeedback\.history\b/);
  const session = scheduler.find(entry => entry.name === 'host.sessions.create').def;
  assert.match(JSON.stringify(session.parameters), /host\.mail\.send/);
  const rewritten = projectHostDescriptions([{ name: 'host.feedback.history', sources: ['feedback.history'], def: {
    name: 'host.feedback.history', description: 'Use feedback.history. Keep host.feedback.history and /feedback.history.', dangerous: false,
    parameters: { type: 'object', properties: { value: { enum: ['feedback.history'], description: 'See feedback.history.' } } }
  } }])[0].def;
  assert.equal(rewritten.description, 'Use host.feedback.history. Keep host.feedback.history and /feedback.history.');
  assert.deepEqual(rewritten.parameters.properties.value.enum, ['feedback.history']);
  assert.equal(rewritten.parameters.properties.value.description, 'See host.feedback.history.');
  const browserDescription = projectHostDescriptions([{ name: 'host.browser.run', sources: ['browser.run'], def: {
    name: 'host.browser.run', description: 'Use browser.snapshot then browser.run.', dangerous: false,
    parameters: { type: 'object', properties: {} }
  } }])[0].def.description;
  assert.equal(browserDescription, 'Use host.browser.run (action: snapshot) then host.browser.run.');
  const sourceNames = [...new Set(scheduler.flatMap(entry => entry.sources))].filter(name => name !== 'sessions.run');
  const descriptions = value => Array.isArray(value) ? value.flatMap(descriptions) : value && typeof value === 'object'
    ? Object.entries(value).flatMap(([key, item]) => key === 'description' && typeof item === 'string' ? [item] : descriptions(item)) : [];
  for (const entry of scheduler) for (const source of sourceNames) {
    const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const oldName = new RegExp(`(?<![\\w./])${escaped}(?![\\w]|\\.[A-Za-z_])`);
    for (const text of [entry.def.description, ...descriptions(entry.def.parameters)]) {
      assert.doesNotMatch(text, oldName, `${entry.name} description still mentions ${source}`);
    }
  }
  const restricted = schedulerProjectedCatalog({ groups: ['automations', 'llm'], tools: ['sessions.create'] });
  assert.ok(!restricted.some(entry => ['host.automations.run', 'host.llm.run', 'host.sessions.create'].includes(entry.name)));
  const tools = [
    { id: 'sessions.rename', description: 'rename visible', parameters: { type: 'object', properties: { name: { type: 'string' } } } },
    { id: 'node_repl.js', description: 'session repl', parameters: { type: 'object', properties: { code: { type: 'string' } } } }
  ];
  const worker = workerProjectedCatalog(tools, true);
  assert.deepEqual(worker.map(entry => entry.name), ['host.sessions.update', 'host.node_repl.js', 'host.ask']);
  assert.deepEqual(worker.find(entry => entry.name === 'host.node_repl.js').def.parameters, tools[1].parameters);
  assert.equal(worker.find(entry => entry.name === 'host.node_repl.js').def.description, 'session repl');
  assert.ok(!workerProjectedCatalog(tools, false).some(entry => entry.name === 'host.ask'));
  assert.throws(() => workerProjectedCatalog([tools[0], tools[0]], true), /Duplicate/);
  const pty = ptyProjectedCatalog(true);
  for (const catalog of [scheduler, workerPresetProjectedCatalog('gui-full', true), workerPresetProjectedCatalog('acp-subset', true)]) {
    const tool = catalog.find(entry => entry.name === 'host.turnChanges.trackFiles');
    assert(tool, 'explicit review capture reaches each supported model surface');
    assert.deepEqual(tool.sources, ['turnChanges.trackFiles']);
    assert.equal(routeProjectedHostCall(catalog, catalog === scheduler ? 'scheduler' : 'worker', tool.name,
      { action: 'begin', paths: ['src/a.ts'] }).target, 'turnChanges.trackFiles');
  }
  assert.ok(!pty.some(entry => entry.name === 'host.turnChanges.trackFiles'), 'plain PTY has no review turn tracker');
  for (const catalog of [scheduler, pty, workerPresetProjectedCatalog('gui-full', true), workerPresetProjectedCatalog('acp-subset', true)]) {
    // 域壳化：panel/desktop 各只投影一个 run 入口，原动作名保留为内部真源。
    for (const domain of ['panel', 'desktop', 'github']) {
      const shell = catalog.find(entry => entry.name === `host.${domain}.run`);
      assert.ok(shell, `${domain}.run is registered in each host surface`);
      assert.deepEqual(shell.sources, [`${domain}.run`]);
      assert.ok(!catalog.some(entry => new RegExp(`^host\\.${domain}\\.(?!run$)`).test(entry.name)),
        `${domain} actions stay internal`);
    }
    const route = routeProjectedHostCall(catalog, catalog === scheduler ? 'scheduler' : 'worker', 'host.panel.run', { action: 'open', params: { kind: 'browser', browserId: 'b', placement: 'center' } });
    assert.equal(route.kind, 'direct');
    // 路由层只解析到 run 入口；action 展开与逐 action 判档在 policy/gateway。
    assert.equal(route.target, 'panel.run');
    assert.equal(route.permissionSource, 'panel.run');
  }
  assert.ok(pty.some(entry => entry.name === 'host.ask'));
  assert.ok(pty.some(entry => entry.name === 'host.mail.read'));
  assert.ok(!pty.some(entry => entry.name === 'host.node_repl.js'));
  assert.ok(!ptyProjectedCatalog(false).some(entry => entry.name === 'host.ask'));
  console.log('projected catalog: scheduler roster and exact worker surface passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
