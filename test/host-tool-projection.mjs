import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-projection-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { projectHostToolRoster } = await import(pathToFileURL(compile('shared/hostToolProjection.ts')));
  const { residentHostToolIds } = await import(pathToFileURL(compile('shared/toolDiscovery.ts')));
  for (const role of ['worker', 'scheduler']) {
    const original = residentHostToolIds(role), projected = projectHostToolRoster(original);
    assert.equal(projected.length, new Set(projected.map(tool => tool.name)).size);
    assert.ok(projected.every(tool => tool.name.startsWith('host.') || tool.name.startsWith('ext.')));
    assert.ok(original.every(source => projected.some(tool => tool.sources.includes(source))), `${role} source omitted`);
    assert.equal(projected.some(tool => tool.name === 'sessions.run'), false);
    assert.equal(projected.filter(tool => tool.name === 'host.sessions.update').length, 1);
    const llm = projected.find(tool => tool.name === 'host.llm.run');
    assert.deepEqual(llm.allowedActions, role === 'worker' ? ['quota'] : undefined);
  }
  const scheduler = projectHostToolRoster(residentHostToolIds('scheduler'));
  assert.deepEqual(scheduler.find(tool => tool.name === 'host.ask').sources.sort(), ['askQuestion', 'ui.confirm', 'ui.prompt'].sort());
  for (const name of ['host.sessions.select', 'host.sessions.recover', 'host.sessions.restart', 'host.sessions.update']) {
    assert.ok(scheduler.find(tool => tool.name === name)?.sources.includes('sessions.run'));
  }
  assert.deepEqual(projectHostToolRoster(['ext.third-party.run'])[0], { name: 'ext.third-party.run', sources: ['ext.third-party.run'] });
  assert.equal(projectHostToolRoster(['sessions.completeAndArchive', 'sessions.review']).length, 1);
  assert.equal(projectHostToolRoster(['sessions.run', 'sessions.recoverInterrupted']).filter(tool => tool.name === 'host.sessions.recover').length, 1);
  for (const ids of [['llm.quota', 'llm.run'], ['llm.run', 'llm.quota']]) assert.equal(projectHostToolRoster(ids)[0].allowedActions, undefined);
  assert.throws(() => projectHostToolRoster(['sessions.message', 'mail.send']), /collision/);
  assert.throws(() => projectHostToolRoster(['askQuestion', 'ask']), /collision/);
  console.log('host projection: resident coverage, merges, restricted worker quota and collision checks passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
