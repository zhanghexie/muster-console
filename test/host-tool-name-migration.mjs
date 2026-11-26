import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-tool-names-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { migrateHostToolName: migrate } = await import(pathToFileURL(compile('shared/hostToolNames.ts')));
  const { residentHostToolIds } = await import(pathToFileURL(compile('shared/toolDiscovery.ts')));
  const { TOOL_DEFS } = await import(pathToFileURL(compile('main/capabilities/catalog/registry.ts')));
  for (const [before, after] of Object.entries({
    'sessions.restartConversation': 'host.sessions.restart', 'sessions.recoverInterrupted': 'host.sessions.recover',
    'sessions.message': 'host.mail.send', 'sessions.readMessages': 'host.mail.read',
    'memory.journalGet': 'host.memory.journalRead', 'memory.correctionStatus': 'host.memory.correction',
    'app.getConfig': 'host.config.get', 'app.instances': 'host.instances.list', 'git.refreshRepos': 'host.repos.refresh',
    'browser.run': 'host.browser.run', 'intent': 'host.intent', 'waitFor': 'host.waitFor'
  })) assert.deepEqual(migrate(before), { kind: 'rename', name: after });
  for (const name of ['sessions.rename', 'sessions.setPinned', 'sessions.setArchived', 'sessions.setModel', 'sessions.setThinking', 'sessions.setOrchestrated']) {
    assert.deepEqual(migrate(name), { kind: 'combined', name: 'host.sessions.update' });
  }
  for (const name of ['askQuestion', 'ui.confirm', 'ui.prompt']) assert.deepEqual(migrate(name), { kind: 'combined', name: 'host.ask' });
  assert.deepEqual(migrate('llm.quota'), { kind: 'combined', name: 'host.llm.run' });
  assert.deepEqual(migrate('sessions.completeAndArchive'), { kind: 'combined', name: 'host.sessions.review' });
  assert.deepEqual(migrate('sessions.run'), { kind: 'action-routing', name: 'host.sessions' });
  assert.deepEqual(migrate('ext.sample.test'), { kind: 'extension', name: 'ext.sample.test' });
  assert.throws(() => migrate('host.browser.run'), /unprefixed/);
  for (const def of TOOL_DEFS) {
    const result = migrate(def.name);
    assert.ok(result.name.startsWith('host.') || result.kind === 'extension', def.name);
  }
  for (const role of ['worker', 'scheduler']) {
    const reverse = new Map();
    for (const oldName of residentHostToolIds(role)) {
      const result = migrate(oldName);
      assert.ok(result.name.startsWith('host.') || result.kind === 'extension', oldName);
      if (result.kind === 'action-routing') continue;
      const prior = reverse.get(result.name);
      if (prior) assert.ok(prior.kind === 'combined' || result.kind === 'combined', `${oldName} collides with ${prior.oldName}`);
      else reverse.set(result.name, { ...result, oldName });
    }
  }
  console.log('host tool names: resident mappings and intentional merge collisions passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
