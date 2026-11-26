import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projected-route-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { projectHostDefinitions } = await import(pathToFileURL(compile('main/capabilities/catalog/hostProjection.ts')));
  const { routeProjectedHostCall: route, resolveProjectedHostApiName } = await import(pathToFileURL(compile('main/capabilities/projectedHostRoute.ts')));
  const { TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/registry.ts')));
  const { HOST_TOOL_METAS } = await import(pathToFileURL(compile('shared/hostTools/index.ts')));
  const resolve = name => TOOL_DEFS.find(def => def.name === name) ?? (() => {
    const meta = HOST_TOOL_METAS.find(item => item.id === name);
    return meta?.schema && { name, description: name, dangerous: false, parameters: meta.schema };
  })();
  const ids = ['sessions.readMessages', 'sessions.run', 'llm.quota', 'ui.confirm'];
  const catalog = projectHostDefinitions('scheduler', ids, resolve);
  const reviewCatalog = projectHostDefinitions('scheduler', ['sessions.review', 'sessions.completeAndArchive'], resolve);
  assert.deepEqual(route(reviewCatalog, 'scheduler', 'host.sessions.review', { sessionIds: ['a', 'b'], decision: 'processed' }),
    { kind: 'direct', target: 'sessions.review', permissionSource: 'sessions.review', args: { sessionIds: ['a', 'b'], decision: 'processed' } });
  assert.deepEqual(route(catalog, 'scheduler', 'host.mail.read', {}),
    { kind: 'direct', target: 'sessions.readMessages', permissionSource: 'sessions.readMessages', args: {} });
  assert.deepEqual(route(catalog, 'scheduler', 'host.mail.read', { __actorSessionId: 'forged', __browserOwner: { sessionId: 'forged' } }).args, {},
    'model-provided identity cannot survive route planning');
  assert.deepEqual(route(catalog, 'scheduler', 'host.sessions.restart', { sessionId: 'one' }),
    { kind: 'direct', target: 'sessions.restartConversation', permissionSource: 'sessions.run', args: { sessionId: 'one' } });
  assert.deepEqual(route(catalog, 'scheduler', 'host.llm.run', { action: 'quota', params: {} }),
    { kind: 'direct', target: 'llm.quota', permissionSource: 'llm.quota', args: {} });
  assert.deepEqual(route(catalog, 'scheduler', 'host.llm.run', { action: 'quota', params: { __actorSessionId: 'forged' } }).args, {});
  assert.throws(() => route(catalog, 'scheduler', 'host.llm.run', { action: 'upsertProvider', params: {} }), /Invalid parameters/);
  const providerOnly = projectHostDefinitions('scheduler', ['llm.run'], resolve);
  assert.throws(() => route(providerOnly, 'scheduler', 'host.llm.run', { action: 'quota', params: {} }), /Invalid parameters/);
  assert.deepEqual(route(catalog, 'scheduler', 'host.ask', { kind: 'confirm', title: 'Proceed?' }),
    { kind: 'ask', route: { tool: 'ui.confirm', args: { title: 'Proceed?' } }, permissionSource: 'ui.confirm' });
  assert.throws(() => route(catalog, 'scheduler', 'sessions.readMessages', {}), /Unknown host tool/);
  assert.throws(() => route(catalog, 'scheduler', 'host.ask', { kind: 'text', title: 'X' }), /Invalid parameters/);
  const worker = projectHostDefinitions('worker', ['sessions.rename', 'sessions.setArchived'], resolve, { hasQuestionChannel: true });
  assert.equal(route(worker, 'worker', 'host.ask', { kind: 'text', title: 'X' }).permissionSource, 'askQuestion');
  assert.deepEqual(route(worker, 'worker', 'host.sessions.update', { name: 'X' }),
    { kind: 'session-update', args: { name: 'X' }, sources: ['sessions.rename', 'sessions.setArchived'] });
  assert.throws(() => route(worker, 'worker', 'host.sessions.update', { name: 'X', pinned: true }), /Invalid parameters/);
  assert.throws(() => route(catalog, 'invalid', 'host.mail.read', {}), /role/);
  assert.equal(resolveProjectedHostApiName(catalog, 'host_mail_read'), 'host.mail.read');
  const repl = [{ name: 'host.node_repl.js' }];
  assert.equal(resolveProjectedHostApiName(repl, 'host_node_repl_js'), 'host.node_repl.js', 'underscores in a domain are not guessed as separators');
  assert.equal(resolveProjectedHostApiName(repl, 'host.node_repl.js'), 'host.node_repl.js');
  assert.equal(resolveProjectedHostApiName(repl, 'node_repl_js'), undefined, 'legacy names are not aliases');
  console.log('projected host route: filtered names, schema validation and permission sources passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
