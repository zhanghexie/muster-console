import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ui-render-'));
try {
  const compile = createSharedCompiler(process.cwd(), temp);
  const { validateUiRender, scanHtmlViolations } = await import(pathToFileURL(compile('shared/uiRender.ts')).href);
  const { getToolDef } = await import(pathToFileURL(compile('main/capabilities/catalog.ts')).href);
  const good = { title: '选择方案', html: '<ma-table source="plans"></ma-table>' };
  assert.deepEqual(validateUiRender(good), []);
  assert.deepEqual(validateUiRender({ ...good, mode: 'browser', note: '来源', update: 'E:/existing.html' }), []);
  for (const value of [null, [], 'html']) assert.ok(validateUiRender(value).some(issue => issue.path === 'params'));
  for (const key of ['title', 'html']) {
    for (const value of [undefined, '', '  ', 7]) assert.ok(validateUiRender({ ...good, [key]: value }).some(issue => issue.path === key));
  }
  for (const preset of ['table', 'kv', 'stats', 'compare', 'chart', 'steps', 'checklist', 'controls', 'group']) {
    assert.ok(validateUiRender({ ...good, preset, data: {} }).some(issue => issue.path === 'preset' && /不再支持/.test(issue.message)), 'every old preset is rejected even with valid HTML');
  }
  for (const key of ['sessionId', 'unknown']) assert.ok(validateUiRender({ ...good, [key]: 'x' }).some(issue => issue.path === key));
  assert.ok(validateUiRender({ ...good, mode: 'panel' }).some(issue => issue.path === 'mode'));
  for (const key of ['note', 'update']) assert.ok(validateUiRender({ ...good, [key]: 7 }).some(issue => issue.path === key));
  const schema = getToolDef('ui.render').parameters;
  assert.deepEqual(schema.required, ['title', 'html']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['html', 'mode', 'note', 'title', 'update']);
  assert.deepEqual(scanHtmlViolations('<ma-text style="color:var(--ink)">x</ma-text>'), []);
  assert.equal(scanHtmlViolations('<b style="color:#ff0000">x</b>').length, 1);
  assert.equal(scanHtmlViolations('<b style="background:rgba(0,0,0,.5)">x</b>').length, 1);
  assert.equal(scanHtmlViolations('<b style="font-size:30px">x</b>').length, 1);
  assert.deepEqual(scanHtmlViolations('<b style="font-size:13px">x</b>'), []);
  assert.deepEqual(scanHtmlViolations('<ma-badge tone="success">通过</ma-badge><ma-text tone="neutral">0</ma-text>'), []);
  const toneWarnings = scanHtmlViolations('<ma-badge tone="positive">通过</ma-badge><ma-text tone=negative>0</ma-text>');
  assert.equal(toneWarnings.length, 2);
  assert.ok(toneWarnings.every(warning => warning.includes('success/danger/warning/info/neutral')), 'invalid tones name the supported values');
  console.log('ui-render: canonical HTML schema/validation and removal of all preset inputs passed');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
