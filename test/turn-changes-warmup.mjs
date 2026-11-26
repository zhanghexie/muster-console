/** Cold turns start immediately and no workspace-prewarm production hooks remain. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd(); fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(root, '.tmp', 'turn-cold-'));
const compile = createSharedCompiler(root, path.join(tmp, 'compiled'));
const { TurnChangeService } = await import(pathToFileURL(compile('main/turnChanges/service.ts')));
const work = path.join(tmp, 'work'); fs.mkdirSync(work); fs.writeFileSync(path.join(work, 'a'), 'before');
const service = new TurnChangeService(path.join(tmp, 'store')); const trackers = [];
try {
  assert.equal(fs.existsSync(path.join(root, 'src/main/turnChanges/baseline.ts')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/main/turnChanges/workspaceWarmup.ts')), false);
  for (const source of ['src/main/index.ts', 'src/main/ipc.ts', 'src/main/ipc/workspaces.ts', 'src/main/turnChanges/ipc.ts',
    'src/main/agentSession/host/lifecycle.ts', 'src/preload/index.ts', 'src/renderer/src/chatSurface/orchestratorSurface.tsx']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, source), 'utf8'), /prewarm(?:Workspace|Session|Scheduler|Turn)|workspaceWarmup|startTurnBaselineIdleRelease/);
  }
  const cold = service.begin('gui:a', 'cold', work, [work]); trackers.push(cold);
  assert(cold.summary.id); assert.equal(cold.summary.state, 'collecting');
  await cold.toolStart('write', 'write', { path: 'a', content: 'after' }, undefined, true);
  fs.writeFileSync(path.join(work, 'a'), 'after'); await cold.toolEnd('write', true, undefined, true);
  const s = await cold.finish(); assert.equal(s.files[0].revertible, true, 'no identity or cache wait is needed for a real pre-write hook');
  assert.deepEqual((await service.revert(s.id, 'gui:a', 'cold', [work])).restored, ['a']);
  const observed = service.begin('gui:a', 'observed', work, [work]); trackers.push(observed);
  await observed.toolStart('late', 'file_change', { changes: [{ path: 'a' }] });
  fs.writeFileSync(path.join(work, 'a'), 'unknown'); await observed.toolEnd('late', true);
  const captured = await observed.finish(); assert.equal(captured.files.length, 1);
  assert.equal(captured.files[0].origin, 'observed-tool');
  assert.equal(captured.files[0].revertible, false);
  assert(captured.warnings.some(w => w.includes('写前时机无法确认')));
  console.log('turn-changes-warmup: cold capture and prewarm removal passed');
} finally {
  await Promise.allSettled(trackers.map(t => t.ready)); service.dispose();
  assert.equal(path.dirname(tmp), path.join(root, '.tmp'));
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
