import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-definition-projection-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { projectHostDefinitions } = await import(pathToFileURL(compile('main/capabilities/catalog/hostProjection.ts')));
  const { TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/registry.ts')));
  const { HOST_TOOL_METAS } = await import(pathToFileURL(compile('shared/hostTools/index.ts')));
  const { residentHostToolIds } = await import(pathToFileURL(compile('shared/toolDiscovery.ts')));
  const { assertToolArguments } = await import(pathToFileURL(compile('main/capabilities/schemaValidation.ts')));
  const resolve = name => TOOL_DEFS.find(def => def.name === name) ?? (() => {
    const meta = HOST_TOOL_METAS.find(item => item.id === name);
    return meta?.schema && { name, description: name, dangerous: false, parameters: meta.schema };
  })();
  const schedulerIds = residentHostToolIds('scheduler');
  const scheduler = projectHostDefinitions('scheduler', schedulerIds, resolve);
  const worker = projectHostDefinitions('worker', residentHostToolIds('worker'), resolve, { hasQuestionChannel: true });
  for (const entries of [scheduler, worker]) {
    assert.equal(entries.length, new Set(entries.map(entry => entry.def.name)).size);
    assert.ok(entries.every(entry => entry.def.name === entry.name && entry.name.startsWith('host.')));
    assert.ok(entries.some(entry => entry.name === 'host.ask'));
    assert.ok(entries.some(entry => entry.name === 'host.sessions.update'));
    for (const entry of entries) {
      try { assertToolArguments(entry.def.parameters, {}, entry.name); }
      catch (error) { if (String(error.message).startsWith('Invalid schema')) throw error; }
    }
  }
  const get = (entries, name) => entries.find(entry => entry.name === name).def;
  for (const entries of [scheduler, worker]) {
    const ask = get(entries, 'host.ask');
    assertToolArguments(ask.parameters, { kind: 'choice', questions: [{ question: 'Choose?', options: [{ label: 'A' }] }] }, ask.name);
    for (const args of [
      { kind: 'choice', questions: [] }, { kind: 'choice', questions: [{}] },
      { kind: 'choice', questions: [{ question: 'Choose?', options: [{}] }] },
      { kind: 'confirm', title: 'Proceed?', questions: [{ question: 'Unexpected' }] }
    ]) assert.throws(() => assertToolArguments(ask.parameters, args, ask.name), /Invalid parameters/);
  }
  assert.equal(get(scheduler, 'host.sessions.restart').dangerous, true);
  assert.equal(get(scheduler, 'host.sessions.review').dangerous, true);
  assert.ok(get(scheduler, 'host.sessions.review').parameters.properties.decision.enum.includes('processed'));
  const review = get(scheduler, 'host.sessions.review');
  assert.match(review.description, /clears dimension gates/);
  assertToolArguments(review.parameters, { sessionId: 'a', decision: 'processed' }, review.name);
  assertToolArguments(review.parameters, { sessionIds: ['a', 'b'], decision: 'processed' }, review.name);
  for (const args of [
    { sessionIds: ['a'], decision: 'passed' }, { sessionIds: [], decision: 'processed' },
    { sessionId: 'a', sessionIds: ['a'], decision: 'processed' },
    { sessionIds: ['a'], decision: 'processed', skipDimensionGate: true },
    { sessionIds: ['a'], decision: 'processed', workspaceId: 'forged' }
  ]) assert.throws(() => assertToolArguments(review.parameters, args, review.name), /Invalid parameters/);
  assert.deepEqual(get(worker, 'host.llm.run').parameters.properties.action.enum, ['quota']);
  assert.ok(get(scheduler, 'host.llm.run').parameters.properties.action.enum.includes('upsertProvider'));
  const quotaOnly = projectHostDefinitions('scheduler', ['llm.quota'], resolve);
  assert.deepEqual(get(quotaOnly, 'host.llm.run').parameters.properties.action.enum, ['quota'], 'a filtered roster cannot grant provider mutations');
  const providerOnly = projectHostDefinitions('scheduler', ['llm.run'], resolve);
  assert.ok(!get(providerOnly, 'host.llm.run').parameters.properties.action.enum.includes('quota'), 'a filtered roster cannot gain quota access');
  const renameOnly = projectHostDefinitions('worker', ['sessions.rename'], resolve);
  assert.deepEqual(Object.keys(get(renameOnly, 'host.sessions.update').parameters.properties).sort(), ['name', 'sessionId']);
  assert.deepEqual(Object.keys(get(worker, 'host.sessions.update').parameters.properties).sort(), ['archived', 'name', 'sessionId']);
  const confirmOnly = projectHostDefinitions('scheduler', ['ui.confirm'], resolve);
  assert.deepEqual(get(confirmOnly, 'host.ask').parameters.properties.kind.enum, ['confirm']);
  assert.equal(get(confirmOnly, 'host.ask').parameters.oneOf.length, 1);
  assertToolArguments(get(confirmOnly, 'host.ask').parameters, { kind: 'confirm', title: 'Proceed?' }, 'host.ask');
  assert.throws(() => assertToolArguments(get(confirmOnly, 'host.ask').parameters, { kind: 'text', title: 'Proceed?' }, 'host.ask'), /Invalid parameters/);
  assertToolArguments(get(renameOnly, 'host.sessions.update').parameters, { name: 'name' }, 'host.sessions.update');
  assert.throws(() => assertToolArguments(get(renameOnly, 'host.sessions.update').parameters, { name: 'name', pinned: true }, 'host.sessions.update'), /Invalid parameters/);
  assert.throws(() => projectHostDefinitions('scheduler', ['sessions.completeAndArchive'], resolve), /original review permission/);
  assert.ok(!projectHostDefinitions('worker', residentHostToolIds('worker'), resolve).some(entry => entry.name === 'host.ask'));
  assert.throws(() => projectHostDefinitions('worker', ['askQuestion'], resolve), /channel is unavailable/);
  assert.throws(() => projectHostDefinitions('scheduler', ['browser.run'], () => undefined), /Missing schema/);
  const synthetic = name => ({ name, description: name, dangerous: false, parameters: { type: 'object', properties: {} } });
  assert.throws(() => projectHostDefinitions('scheduler', ['domain.foo_bar', 'domain.foo.bar'], synthetic), /API name collision/);
  assert.throws(() => projectHostDefinitions('unknown', [], resolve), /Invalid/);
  console.log('host definition projection: role schemas, merged actions and fail-closed lookup passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
