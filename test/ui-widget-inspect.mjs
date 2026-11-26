import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const folder = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'ui-inspect-'));
try {
  const output = path.join(folder, 'inspect.cjs');
  await build({ entryPoints: ['src/main/uiWidgetInspect.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { inspectUiWidgets } = createRequire(import.meta.url)(output);
  const widget = { path: '/data/agent-sessions/a/ui/01-test.inline.html', title: '公开数据', artifactVersion: 2,
    state: { modelContent: { records: Array.from({ length: 3000 }, (_, i) => 'id-' + i), text: '"'.repeat(20000), 'a/b~c': 7 }, privateContent: { values: { secret: 'PRIVATE_MUST_STAY_LOCAL' } }, presentation: { collapsed: false }, revision: 3 },
    receipt: { status: 'rendered', visible: true, updatedAt: 0 } };
  const root = inspectUiWidgets([widget], { link: widget.path });
  assert.equal(root.widgets[0].requiresInspect, true); assert.equal(root.widgets[0].modelContent, null);
  assert.equal(root.content.entries.find(entry => entry.key === 'records').requiresInspect, true);
  const page = inspectUiWidgets([widget], { link: widget.path, pointer: '/records', offset: 50, limit: 25 });
  assert.equal(page.content.total, 3000); assert.equal(page.content.entries[0].value, 'id-50'); assert.equal(page.content.nextOffset, 75);
  const escaped = inspectUiWidgets([widget], { link: widget.path, pointer: '/a~1b~0c' }); assert.equal(escaped.content.value, 7);
  const text = inspectUiWidgets([widget], { link: widget.path, pointer: '/text', offset: 100, limit: 4096 });
  assert.ok(text.content.nextOffset > 100); assert.ok(JSON.stringify(text).length < 12000);
  for (const pointer of ['/secret', '/privateContent', '/__proto__', '/records/constructor']) assert.throws(() => inspectUiWidgets([widget], { link: widget.path, pointer }), /路径不存在/);
  assert.throws(() => inspectUiWidgets([widget], { pointer: '/records' }), /需要指定 link/);
  assert.throws(() => inspectUiWidgets([widget], { offset: -1 }), /整数/);
  const listed = inspectUiWidgets(Array.from({ length: 20 }, (_, i) => ({ ...widget, title: '界面 ' + i })), {});
  assert.equal(listed.widgets.length, 4); assert.equal(listed.nextOffset, 4);
  assert.ok(!JSON.stringify(listed).includes('PRIVATE_MUST_STAY_LOCAL')); assert.ok(JSON.stringify(listed).length < 12000);
  console.log('ui-widget-inspect: bounded metadata/arrays/text/JSON Pointer/privacy/pagination checks passed');
} finally { fs.rmSync(folder, { recursive: true, force: true }); }
