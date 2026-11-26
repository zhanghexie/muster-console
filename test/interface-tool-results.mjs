import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interface-results-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { projectInterfaceToolResult: project } = await import(pathToFileURL(compile('shared/interfaceToolResult.ts')).href);
  const { validateAppDefinition } = await import(pathToFileURL(compile('shared/agentApps.ts')).href);
  const active = { id: 'light', name: 'Light', appearance: 'light', colors: { ink: '#111' }, terminal: { background: '#fff' } };
  const list = { activeId: 'light', active, themes: [{ id: 'light', name: 'Light', appearance: 'light', builtin: true, preview: { bg: '#fff' } }],
    globalThemeId: 'dark', workspaceThemeId: 'light', activeWorkspaceId: 'ws', activeWorkspaceName: 'Workspace', dir: 'C:/themes' };
  const projected = project('host.themes.run', { action: 'list', params: {} }, list);
  assert.deepEqual(projected, { activeId: 'light', themes: list.themes, globalThemeId: 'dark', workspaceThemeId: 'light',
    activeWorkspaceId: 'ws', activeWorkspaceName: 'Workspace', dir: 'C:/themes' });
  assert.equal(list.active, active, 'the UI/event source is not mutated');
  assert.equal(project('host.themes.run', { action: 'get', params: { id: 'light' } }, active), active, 'full palette remains available');
  const mismatch = { ...list, activeId: 'other' };
  assert.equal(project('host.themes.run', { action: 'list' }, mismatch), mismatch, 'unrecognized/inconsistent shapes pass through');
  const partial = { ...list, active: { id: 'light' } };
  assert.equal(project('host.themes.run', { action: 'list' }, partial), partial, 'unknown theme shapes pass through');

  const file = 'C:/A path/shot.png';
  for (const [note, expected] of [
    [`截图已保存至 ${file}（界面可见；支持读图的模型可直接读取 path 查看画面）`, '界面可见；支持读图的模型可直接读取 path 查看画面'],
    [`Screenshot saved to ${file} (visible in the UI; vision-capable models can read path directly)`, 'Visible in the UI; vision-capable models can read path directly']
  ]) {
    const screenshot = { ok: true, path: file, previewPath: file, note };
    assert.deepEqual(project('host.browser.run', { action: 'screenshot', params: {} }, screenshot), { ok: true, path: file, note: expected });
    assert.equal(screenshot.previewPath, file, 'evidence and display retain original result');
  }
  const warning = { ok: true, path: file, previewPath: file, pendingDialogs: [{ id: 'dialog' }], note: 'Handle this dialog first.' };
  assert.deepEqual(project('host.browser.run', { action: 'screenshot' }, warning), { ok: true, path: file, pendingDialogs: warning.pendingDialogs, note: warning.note });
  const different = { ok: true, path: file, previewPath: 'C:/other.png' };
  assert.equal(project('host.browser.run', { action: 'screenshot' }, different), different, 'distinct preview is never removed');
  const failed = { ok: false, path: file, previewPath: file, note: 'Outcome unknown' };
  assert.equal(project('host.browser.run', { action: 'screenshot' }, failed), failed, 'failure shapes remain untouched');
  const posixPath = '/tmp/测试 image.png';
  const posix = { ok: true, path: posixPath, previewPath: posixPath,
    note: `Screenshot saved to ${posixPath} (visible in the UI; vision-capable models can read path directly)` };
  assert.deepEqual(project('host.browser.run', { action: 'screenshot' }, posix), { ok: true, path: posixPath,
    note: 'Visible in the UI; vision-capable models can read path directly' });
  assert.equal(project('host.browser.run', { action: 'recording' }, warning), warning, 'other actions are never projected');
  assert.equal(project('ext.browser.run', { action: 'screenshot' }, warning), warning, 'extension payload is opaque');

  const huge = 'x'.repeat(16000);
  const theme = { ...active, colors: { ink: huge }, terminal: { background: huge }, warning: 'saved with warning', futureEvidence: { source: 'saved' } };
  for (const action of ['create', 'update']) {
    const receipt = project('host.themes.run', { action, params: { id: 'light' } }, theme);
    assert.deepEqual(receipt, { id: 'light', name: 'Light', appearance: 'light', warning: theme.warning, futureEvidence: theme.futureEvidence });
    assert.ok(JSON.stringify(theme).length > 12000 && JSON.stringify(receipt).length < 1000, 'palette amplification is removed before serialization');
  }
  assert.equal(project('host.themes.run', { action: 'get' }, theme), theme, 'explicit large palette read survives');
  assert.equal(theme.colors.ink, huge, 'host palette is immutable');

  const appDefinition = (padding = '') => validateAppDefinition({ sdkVersion: 1, id: 'reader', name: 'Reader', version: 3,
    icon: 'R', description: 'Book reader', notificationHint: 'Review new books', permissions: [],
    collections: [{ id: 'books', title: 'Books', fields: [
      { id: 'title', label: 'Title', type: 'text', required: true },
      { id: 'archived', label: 'Archived', type: 'boolean' }
    ], titleField: 'title' }], commands: [
      { id: 'remove', title: 'Remove', handler: 'records.remove', collection: 'books' },
      { id: 'edit', title: 'Edit', handler: 'records.update', collection: 'books' },
      { id: 'archive', title: 'Archive', handler: 'records.update', collection: 'books', patch: { archived: true } }
    ], views: [
      { id: 'home', title: 'Reader', kind: 'custom', html: `<script>app.onPresent(() => {});</script>${padding}` },
      { id: 'books', title: 'Books', kind: 'list', collection: 'books', commands: ['remove', 'edit', 'archive'] }
    ], homeView: 'home' });
  const envelopeChars = result => JSON.stringify({ ok: true, result }).length;
  const ordinaryApp = appDefinition();
  const boundaryApp = appDefinition(' '.repeat(11900 - envelopeChars(ordinaryApp)));
  assert.equal(envelopeChars(boundaryApp), 11900, 'the old installation response fits the actual final envelope');
  const describedApp = { definition: boundaryApp, enabled: true, installedAt: 1794643200000,
    approvedDefinition: 'a'.repeat(64), libraryPrivate: false,
    library: { catalogId: '00000000-0000-0000-0000-000000000000', baseFingerprint: 'a'.repeat(64), private: false } };
  assert.ok(envelopeChars(describedApp) > 12000, 'the actual describe installation wrapper makes the same definition unreadable');
  const installed = { ...appDefinition(huge), warning: 'not rendered', futureEvidence: { catalogId: 'catalog' } };
  for (const definition of [ordinaryApp, boundaryApp, installed]) {
    const before = structuredClone(definition);
    const receipt = project('host.apps.run', { action: 'installFromLibrary', params: { catalogId: 'catalog' } }, definition);
    const { icon: _icon, description: _description, notificationHint: _hint, ...expected } = definition;
    assert.deepEqual(receipt, { ...expected, views: definition.views.map(({ html: _html, ...view }) => view) });
    assert.deepEqual(receipt.collections, definition.collections, 'library installation retains the accepted field schema');
    assert.deepEqual(receipt.commands, definition.commands, 'library installation retains handlers, fixed patches and synthesized presentation bindings');
    assert.ok(envelopeChars(receipt) < 4000, 'HTML is removed while the executable contract fits the final model envelope');
    assert.deepEqual(definition, before, 'installation data and host consumers keep the full definition');
    const direct = project('host.apps.run', { action: 'install', definition: before }, definition);
    const { collections: _collections, commands: _commands, views: _views, ...directExpected } = expected;
    assert.deepEqual(direct, directExpected, 'direct installation does not repeat the caller-supplied schema');
    assert.ok(envelopeChars(direct) < 1000);
  }
  for (const action of ['describe', 'query', 'call', 'publish', 'saveMailbox', 'future']) {
    assert.equal(project('host.apps.run', { action }, installed), installed, `${action} is not an install receipt`);
  }
  const unknownView = { ...installed, views: [null] };
  assert.equal(project('host.apps.run', { action: 'installFromLibrary' }, unknownView), unknownView,
    'an unrecognized library view shape passes through without being rewritten');
  const tabs = { activeId: 'a', nav: { back: true, forward: false }, tabs: [{ id: 'a', title: 'A', url: 'https://a.test',
    favicon: `data:image/png;base64,${huge}`, sessionId: 's', loading: false, crashed: true, futureEvidence: 'keep' }] };
  const { favicon, ...tabReceipt } = tabs.tabs[0];
  const tabResult = project('host.browser.run', { action: 'tabs' }, tabs);
  assert.deepEqual(tabResult, { ...tabs, tabs: [tabReceipt] });
  assert.ok(JSON.stringify(tabs).length > 12000 && JSON.stringify(tabResult).length < 1000);
  assert.equal(tabs.tabs[0].favicon, favicon);
  const largeRead = { ok: true, snapshot: huge, result: { body: huge }, image: { type: 'image', data: huge } };
  for (const [name, action] of [['host.browser.run', 'snapshot'], ['host.browser.run', 'evaluate'],
    ['host.desktop.run', 'look'], ['host.panel.run', 'list'], ['host.extensions.run', 'list'],
    ['ext.reader.read', undefined],
    ['host.config.get', undefined], ['host.instances.list', undefined], ['host.mcp.search', undefined],
    ['host.mcp.call', undefined], ['host.ui.render', undefined], ['host.ui.inspect', undefined]]) {
    assert.equal(project(name, { action }, largeRead), largeRead, `${name}/${action} explicit read, image, opaque result or evidence survives`);
  }
  for (const failure of [{ ...installed, ok: false, message: 'unknown result' }, { ...installed, error: 'denied' }]) {
    for (const action of ['install', 'installFromLibrary']) assert.equal(project('host.apps.run', { action }, failure), failure);
  }
  assert.equal(project('host.apps.run', { action: 'install' }, { id: 'new-shape' }).id, 'new-shape');
  console.log('interface tool result projections: ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
