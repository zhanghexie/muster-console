import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-screen-ui-'));
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const { makeScreenReadConfirmation } = await import(pathToFileURL(compile('main/desktop/screenReadUi.ts')));
  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
  let reply = { confirmed: true, kind: 'allowOnce' }, captured;
  const confirm = makeScreenReadConfirmation({ confirm: async (...args) => { captured = args; return reply; } }, () => 'Session\nName');
  const target = { taskId: 't', surfaceId: 's', surfaceGeneration: 'g', geometryRevision: 'r', displayId: 1,
    bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 };
  applyLocaleSetting('zh-CN');
  assert.equal(await confirm('session', target), true);
  assert.match(captured[0], /扩展当前桌面任务链/);
  assert.match(captured[1], /所有显示器/);
  assert.match(captured[1], /当前任务有效/);
  assert.match(captured[1], /24 小时/);
  assert.match(captured[1], /Session Name/);
  assert.equal(captured[2].dangerous, true);
  applyLocaleSetting('en');
  assert.equal(await confirm('session', target), true);
  assert.match(captured[0], /Extend the current desktop task chain/);
  assert.match(captured[1], /every display/);
  assert.match(captured[1], /current task/);
  assert.match(captured[1], /24 hours/);
  reply = { confirmed: true, kind: 'deny' };
  assert.equal(await confirm('session', target), false, 'contradictory denial never grants');
  reply = { confirmed: true, kind: 'allowOnce', cancelledBy: 'esc' };
  assert.equal(await confirm('session', target), false, 'cancel never grants');
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(confirm('session', target, aborted.signal), /abort/i);
  console.log('screen capture confirmation: bilingual disclosure and fail-closed decisions passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
