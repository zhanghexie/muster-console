import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-control-i18n-'));
let control;
try {
  const compile = createSharedCompiler(process.cwd(), path.join(temp, 'compiled'));
  const load = file => import(pathToFileURL(compile(file)).href);
  const { applyLocaleSetting } = await load('shared/i18n/index.ts');
  const { desktopIndicatorLabels } = await load('main/desktop/desktopIndicatorLabels.ts');
  const { Win32ControlRuntime } = await load('main/desktop/win32ControlRuntime.ts');
  applyLocaleSetting('en');
  assert.deepEqual(desktopIndicatorLabels(), { active: 'AI is using your computer', stopping: 'Stopping computer use',
    unknown: 'Computer action outcome unknown', escape: 'Press Esc to stop', stop: 'Stop', escapeUnavailable: 'Use Stop to end' });
  const prompts = [];
  const ui = { confirm: async (...args) => { prompts.push(args); return { confirmed: false, kind: 'deny' }; },
    confirmWithReceipt: async (...args) => { prompts.push(args); return { decision: { confirmed: false, kind: 'deny' } }; } };
  control = new Win32ControlRuntime(path.join(temp, 'data'), ui, point => point, point => point, async value => value,
    () => ({ observe: () => '1', current: () => true, release() {}, close() {} }));
  const actor = { sessionId: 'fixture', taskId: 'fixture-task', isCurrent: () => true };
  await assert.rejects(control.launch(actor, 'C:\\Apps\\example.exe', 'launch-1'), /declined/);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0], 'Allow desktop operations?');
  assert.equal(prompts[0][1], 'Allow computer use for this turn. Later desktop actions in this turn will not ask again.');
  assert.equal(prompts[0][2].confirmLabel, 'Allow');
  assert.equal(prompts[0][2].cancelLabel, 'Deny');
  applyLocaleSetting('zh-CN');
  assert.equal(desktopIndicatorLabels().escape, '按 Esc 停止');
  console.log('desktop control i18n: English confirmation and app interpolation passed');
} finally { control?.close(); fs.rmSync(temp, { recursive: true, force: true }); }
