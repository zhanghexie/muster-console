import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-turn-epoch-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(tmp, 'compiled'));
  const { DesktopTurnEpochGuard } = await import(pathToFileURL(compile('main/desktop/turnEpoch.ts')));
  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
  applyLocaleSetting('en');
  const guard = new DesktopTurnEpochGuard();
  guard.begin('session', 'turn-a');
  guard.continuation('session', 'turn-a', [{ waitId: 'wait-a', epoch: 'A', generation: 0, uncertain: false }], { epoch: 'A', generation: 0, anchor: 'approval-A' });
  guard.continuation('session', 'turn-a', [{ waitId: 'wait-a', epoch: 'A', generation: 0, uncertain: false }], { epoch: 'A', generation: 0, anchor: 'approval-A' });
  assert.equal(guard.assertWrite('session', 'turn-a', { epoch: 'A', generation: 0, anchor: 'approval-A' }, () => true), 'A');
  assert.throws(() => guard.assertWrite('session', 'turn-a', { epoch: 'A', generation: 0, anchor: 'approval-A' }, () => false), /expired/i);
  guard.continuation('session', 'turn-a', [{ waitId: 'wait-old', epoch: 'A', generation: 0, uncertain: false }], { epoch: 'B', generation: 0, anchor: 'approval-B' });
  assert.throws(() => guard.assertWrite('session', 'turn-a', { epoch: 'B', generation: 0, anchor: 'approval-B' }, () => true), /wait-old.*approval-B/);
  assert.throws(() => guard.assertWrite('session', 'turn-a', { epoch: 'A', generation: 0, anchor: 'approval-A' }, () => true), /wait-old.*approval-B/, 'conflict survives all further attempts this turn');
  guard.end('session', 'turn-a');
  guard.begin('session', 'turn-b');
  assert.equal(guard.assertWrite('session', 'turn-b', null, () => false), null, 'no epoch takes the ordinary first-approval path');
  guard.continuation('session', 'turn-b', [{ waitId: 'wait-no-epoch', epoch: null, generation: null, uncertain: false }], null);
  assert.equal(guard.assertWrite('session', 'turn-b', null, () => false), null);
  guard.continuation('session', 'turn-b', [{ waitId: 'wait-a2', epoch: 'A', generation: 0, uncertain: false }, { waitId: 'wait-c', epoch: 'C', generation: 0, uncertain: false }], null);
  assert.throws(() => guard.assertWrite('session', 'turn-b', null, () => true), /wait-a2.*wait-c/, 'mixed normal-delivery batch also conflicts');
  assert.throws(() => guard.assertWrite('session', 'wrong-turn', null, () => true), /turn/i);
  guard.end('session', 'turn-b');
  applyLocaleSetting('zh-CN');
  guard.begin('session', 'turn-c');
  guard.continuation('session', 'turn-c', [{ waitId: 'wait-A', epoch: 'A', generation: 0, uncertain: false }], { epoch: 'B', generation: 0, anchor: 'approval-B' });
  assert.throws(() => guard.assertWrite('session', 'turn-c', { epoch: 'B', generation: 0, anchor: 'approval-B' }, () => true), /epoch 冲突.*wait-A.*approval-B.*新桌面任务链/);
  guard.end('session', 'turn-c');
  guard.begin('session', 'turn-d');
  guard.continuation('session', 'turn-d', [{ waitId: 'wait-missing', epoch: null }], null);
  assert.throws(() => guard.assertWrite('session', 'turn-d', null, () => true), /wait-missing.*身份未知/, 'missing uncertainty never means no epoch');
  guard.end('session', 'turn-d');
  guard.begin('session', 'turn-e');
  guard.continuation('session', 'turn-e', [{ waitId: 'wait-unknown', epoch: null, generation: null, uncertain: true }], null);
  assert.throws(() => guard.assertWrite('session', 'turn-e', null, () => true), /wait-unknown.*身份未知/);
  guard.end('session', 'turn-e');
  guard.begin('session', 'turn-f');
  guard.continuation('session', 'turn-f', [{ waitId: 'wait-before-archive', epoch: 'worker-id', generation: 1, uncertain: false }],
    { epoch: 'worker-id', generation: 2, anchor: 'restored-worker' });
  assert.throws(() => guard.assertWrite('session', 'turn-f', { epoch: 'worker-id', generation: 2, anchor: 'restored-worker' }, () => true),
    /wait-before-archive.*restored-worker/, 'same session ID after archive is a different authorization generation');
  console.log('desktop turn epoch: mixed preemption, expiry, first-use and turn cleanup');
} finally {
  const resolved = fs.realpathSync(tmp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('desktop-turn-epoch-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5 });
}
