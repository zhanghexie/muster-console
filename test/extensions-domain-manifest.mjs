import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compile = createSharedCompiler(repo, path.join(repo, '.tmp', 'extensions-manifest-compile'));
const { validateExtensionManifest } = await import(pathToFileURL(compile('shared/extensionManifest.ts')));

const base = {
  id: 'bookshelf',
  name: '书架',
  scope: 'global',
  surface: { kind: 'sidebar', entry: 'ui/panel.html', title: '书架' },
  domain: {
    entry: 'domain/runtime.mjs',
    queries: ['books.list', 'books.getSummary'],
    commands: ['books.moveBook'],
    events: ['state.changed', 'action.completed'],
    queryDefs: [
      { id: 'books.list', title: '列出书籍', description: '读取当前书架。', parameters: { type: 'object' }, permission: 'read' },
      { id: 'books.getSummary', title: '读取摘要', parameters: { type: 'object', properties: { id: { type: 'string' } } }, permission: 'read' }
    ],
    commandDefs: [
      { id: 'books.moveBook', title: '移动书籍', description: '调整书籍位置。', parameters: { type: 'object', required: ['id', 'target'] }, permission: 'edit' }
    ]
  },
  agent: { profile: 'scheduler-pi', systemPrompt: 'agent/system.md', skills: ['agent/skills/bookshelf'], mcp: ['agent/mcp/bookshelf.mjs'] },
  data: { workspace: true, shared: false },
  permissions: ['data', 'agent.state', 'agent.commands', 'agent.mcp', 'theme'],
  theme: { accent: 'purple', tokens: { 'surface-card': '#fff' } }
};

const valid = validateExtensionManifest(base, 'bookshelf');
assert.equal(valid.ok, true, valid.error);
assert.equal(valid.manifest.surface.kind, 'sidebar');
assert.deepEqual(valid.manifest.data, { workspace: true, shared: false });
const builtinIcon = validateExtensionManifest({ ...base, icon: 'builtin-extension:archive', surface: { ...base.surface, icon: 'builtin-extension:document' } }, 'bookshelf');
assert.equal(builtinIcon.ok, true, builtinIcon.error);
const standalonePanel = validateExtensionManifest({ ...base, agent: undefined, permissions: ['data', 'theme'] }, 'bookshelf');
assert.equal(standalonePanel.ok, true, standalonePanel.error);
assert.equal(standalonePanel.manifest.agent, undefined);

const toolbar = validateExtensionManifest({
  id: 'quick-note',
  name: 'Quick note',
  scope: 'global',
  surface: { kind: 'toolbar', command: 'open' },
  commandEntry: 'commands.mjs',
  commands: [{ id: 'open', title: 'Open', handler: 'open' }],
  data: { workspace: true, shared: false },
  permissions: ['data']
}, 'quick-note');
assert.equal(toolbar.ok, true, toolbar.error);

for (const invalid of [
  { ...base, oldSchemaVersion: 5 },
  { ...base, surface: { kind: 'sidebar' } },
  { ...base, domain: undefined },
  { ...base, agent: { profile: 'invalid' } },
  { ...base, permissions: ['data', 'agent.commands', 'agent.mcp'] },
  { ...base, surface: { kind: 'toolbar', command: 'open' } },
  { ...base, permissions: ['data'] },
  { ...base, domain: { ...base.domain, commands: ['books.moveBook'] }, permissions: ['data', 'agent.state'] },
  { ...base, agent: { ...base.agent, mcp: ['data/mcp.mjs'] } },
  { ...base, theme: { tokens: { BadKey: '#fff' } } },
  { ...base, surface: { ...base.surface, entry: '../panel.html' } },
  { ...base, project: { kind: 'mapped', key: 'bad key' } },
  { ...base, domain: { ...base.domain, queryDefs: [{ id: 'books.unknown' }] } },
  { ...base, domain: { ...base.domain, commandDefs: [{ id: 'books.moveBook', permission: 'dangerous' }, { id: 'books.moveBook', permission: 'edit' }] } },
  { ...base, icon: 'builtin-extension:missing' },
  { ...base, id: 'other' }
]) {
  assert.equal(validateExtensionManifest(invalid, 'bookshelf').ok, false, JSON.stringify(invalid));
}

const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
const { localizeExtensionReason } = await import(pathToFileURL(compile('shared/extensionReason.ts')));
const badEntry = validateExtensionManifest({ ...base, surface: { ...base.surface, entry: '../panel.html' } }, 'bookshelf');
const duplicateOperation = validateExtensionManifest({ ...base, domain: { ...base.domain, queries: ['books.list', 'books.list'] } }, 'bookshelf');
assert.equal(badEntry.error, 'surface.entry 必须是扩展包内 .html 相对路径');
assert.equal(duplicateOperation.error, 'domain.queries 不能重复');
applyLocaleSetting('en');
assert.equal(localizeExtensionReason(badEntry.error), 'surface.entry must be a relative path to an .html file within the extension.');
assert.equal(localizeExtensionReason(duplicateOperation.error), 'domain.queries must contain unique entries.');
assert.equal(localizeExtensionReason('domain.unknown 不能重复'), 'domain.unknown 不能重复');
assert.equal(localizeExtensionReason("Error invoking remote method 'extensionCenter:uninstall': Error: 请先关闭所有工作区中的该扩展后再卸载"),
  "Error invoking remote method 'extensionCenter:uninstall': Error: Disable this extension in every workspace before uninstalling.");
applyLocaleSetting('zh-CN');
assert.equal(localizeExtensionReason(badEntry.error), badEntry.error);

console.log('extensions-manifest: validation and localized display reasons passed');



