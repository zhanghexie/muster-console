import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-terminal-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { OrchestratorEventPump } = await import(pathToFileURL(compile('main/orchestrator/events.ts')));
  for (const terminal of ['archived', 'done']) {
    for (const guard of ['needs_you_stale', 'heartbeat_stale']) {
      let now = 31 * 60_000;
      const s = { id: 's', name: 'worker', workspaceId: 'ws', type: 'terminal', launchKind: 'agent',
        orchestrated: true, lifecycle: 'working', ...(guard === 'needs_you_stale' ? { phase: { value: 'needs_you', ts: 0 } } : {}) };
      const ctx = { sessions: { get: () => s, list: () => [s], listByWorkspace: () => [s] },
        config: { get: () => ({ workspaces: [{ id: 'ws', path: tmp }] }) },
        orchestrator: { isBusy: () => true } };
      const pump = new OrchestratorEventPump({ ctx, now: () => now, setTimeout: () => 0, clearTimeout() {} });
      pump.tickGuards();
      assert.equal(pump.peek('ws').filter(e => e.kind === guard).length, 1, 'active guard fires');
      assert.equal(await pump.flush('ws'), 'hold', 'busy scheduler retains alert');
      if (terminal === 'archived') s.archived = true;
      else s.phase = { value: 'done', ts: now };
      assert.equal(await pump.flush('ws'), 'skip', `${terminal}: queued ${guard} must not be delivered`);
      pump.tickGuards();
      assert.deepEqual(pump.peek('ws'), [], 'terminal tick stays silent');
      pump.onFlip({ sessionId: 's', workspaceId: 'ws', trigger: 'needs_you', ts: now });
      pump.onTurnFailed('s', { error: 'late failure' });
      assert.deepEqual(pump.peek('ws'), [], 'late phase/failure ignored');
      delete s.archived;
      s.phase = guard === 'needs_you_stale' ? { value: 'needs_you', ts: now } : undefined;
      now += 31 * 60_000;
      pump.tickGuards();
      assert.equal(pump.peek('ws').filter(e => e.kind === guard).length, 1, 'reactivated session must fire again');
      pump.stop();
    }
  }
  // Digest and explicit done policies keep their contract, but archive invalidates queued signals.
  {
    const s = { id: 's', workspaceId: 'ws', orchestrated: true };
    const ctx = { sessions: { get: () => s }, orchestrator: { isBusy: () => true } };
    const pump = new OrchestratorEventPump({ ctx, setTimeout: () => 0, clearTimeout() {},
      policyFor: () => ({ version: 1, timing: {}, guards: {}, rules: [{ id: 'all', match: { kind: 'turn_end' }, action: 'digest' }] }) });
    pump.onTurnEnd('s');
    assert.equal(pump.peekDigest('ws').length, 1);
    s.archived = true;
    pump.onTurnEnd('s');
    await pump.flush('ws');
    assert.equal(pump.peekDigest('ws').length, 0, 'archived digest discarded');
    // Workspace risk events are not worker execution signals, even with a session reference.
    pump.enqueue({ kind: 'merge_blocked', workspaceId: 'ws', sessionId: 's' });
    assert.equal(await pump.flush('ws'), 'hold');
    assert.equal(pump.peek('ws').length, 1, 'merge risk survives archival');
    pump.stop();
  }
  console.log('ok: terminal queue suppression and reactivation (both guards, archived/done)');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
