/**
 * 命令面板查询前缀 / 分组 / 回车语义 / 跳转条目。
 * 运行: node test/command-palette.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-palette-'));
const compile = createSharedCompiler(root, tmp);
const outFile = compile('shared/commandPalette.ts');
const p = await import(pathToFileURL(outFile).href);

assert.deepEqual(p.parsePaletteQuery(''), { command: false, search: '' });
assert.deepEqual(p.parsePaletteQuery('src/app'), { command: false, search: 'src/app' });
assert.deepEqual(p.parsePaletteQuery('>'), { command: true, search: '' });
assert.deepEqual(p.parsePaletteQuery('>看板'), { command: true, search: '看板' });
assert.deepEqual(p.parsePaletteQuery('foo>bar'), { command: false, search: 'foo>bar' });

assert.equal(p.resolveListMode('', 'goto'), 'goto');
assert.equal(p.resolveListMode('', 'file'), 'file');
assert.equal(p.resolveListMode('', 'content'), 'content');
assert.equal(p.resolveListMode('', 'command'), 'goto');
assert.equal(p.resolveListMode('>看板', 'goto'), 'command');
assert.equal(p.resolveListMode('>看板', 'file'), 'command');
assert.equal(p.resolveListMode('foo', 'file'), 'file');
assert.equal(p.resolveListMode('foo', 'content'), 'content');

assert.equal(p.initialPaletteQuery('goto'), '');
assert.equal(p.initialPaletteQuery('file'), '');
assert.equal(p.initialPaletteQuery('command'), '');
assert.equal(p.setPaletteMode('src/a', 'command'), 'src/a');
assert.equal(p.setPaletteMode('>看板', 'goto'), '看板');
assert.equal(p.setPaletteMode('>', 'file'), '');
assert.equal(p.setPaletteMode('foo', 'file'), 'foo');

assert.equal(p.modeToFilter('goto'), 'all');
assert.equal(p.modeToFilter('file'), 'files');
assert.equal(p.modeToFilter('content'), 'content');
assert.equal(p.modeToFilter('command'), 'commands');
assert.equal(p.cyclePaletteFilter('all', 1), 'sessions');
assert.equal(p.cyclePaletteFilter('sessions', 1), 'workspaces');
assert.equal(p.cyclePaletteFilter('files', 1), 'content');
assert.equal(p.cyclePaletteFilter('content', 1), 'commands');
assert.equal(p.cyclePaletteFilter('all', -1), 'settings');
assert.equal(p.effectivePaletteFilter('>x', 'files'), 'commands');
assert.equal(p.effectivePaletteFilter('x', 'files'), 'files');
assert.equal(p.paletteNeedsFiles('all', ''), false);
assert.equal(p.paletteNeedsFiles('all', 'app'), true);
assert.equal(p.paletteNeedsFiles('files', ''), true);
assert.equal(p.paletteNeedsFiles('sessions', 'app'), false);
assert.equal(p.paletteNeedsFiles('content', 'app'), false);
assert.equal(p.paletteNeedsContent('content'), true);
assert.equal(p.paletteNeedsContent('files'), false);
assert.equal(p.paletteNeedsContent('all'), false);
assert.equal(p.isSettingsCommand('settings.open', '打开设置'), true);
assert.equal(p.isSettingsCommand('files.find', '当前文件查找'), false);

assert.deepEqual(
  p.splitHighlight('关卡设置套娃', '设'),
  [
    { text: '关卡', mark: false },
    { text: '设', mark: true },
    { text: '置套娃', mark: false }
  ]
);
assert.deepEqual(p.splitHighlight('hello', ''), [{ text: 'hello', mark: false }]);

assert.deepEqual(p.markPreviewHits('const Foo = 1', 'foo', false), [
  { text: 'const ', mark: false },
  { text: 'Foo', mark: true },
  { text: ' = 1', mark: false }
]);
assert.deepEqual(p.markPreviewHits('const Foo = 1', 'foo', true), [
  { text: 'const Foo = 1', mark: false }
]);
assert.deepEqual(p.markPreviewHits('aa-aa', 'aa', false), [
  { text: 'aa', mark: true },
  { text: '-', mark: false },
  { text: 'aa', mark: true }
]);
assert.deepEqual(p.markPreviewHits('plain', '', false), [{ text: 'plain', mark: false }]);

const grouped = p.groupByPreservingOrder(
  [
    { id: 'a', group: '应用' },
    { id: 'b', group: '文件' },
    { id: 'c', group: '应用' }
  ],
  (x) => x.group
);
assert.deepEqual(
  grouped.map((g) => ({ group: g.group, ids: g.items.map((x) => x.id) })),
  [
    { group: '应用', ids: ['a', 'c'] },
    { group: '文件', ids: ['b'] }
  ]
);

assert.equal(p.isPaletteRowEnabled('overlay.close', false), true);
assert.equal(p.isPaletteRowEnabled('files.find', false), false);
assert.equal(p.isPaletteRowEnabled('files.find', true), true);

assert.deepEqual(p.paletteConfirmAction('palette.goto'), {
  kind: 'switch-mode',
  mode: 'goto'
});
assert.deepEqual(p.paletteConfirmAction('files.quickOpen'), {
  kind: 'switch-mode',
  mode: 'file'
});
assert.deepEqual(p.paletteConfirmAction('files.findInFiles'), {
  kind: 'switch-mode',
  mode: 'content'
});
assert.deepEqual(p.paletteConfirmAction('palette.commands'), {
  kind: 'switch-mode',
  mode: 'command'
});
assert.deepEqual(p.paletteConfirmAction('overlay.close'), { kind: 'close' });
assert.deepEqual(p.paletteConfirmAction('settings.open'), { kind: 'run' });

assert.equal(p.sessionKindLabel({ type: 'scheduled' }), '定时');
assert.equal(p.sessionKindLabel({ type: 'terminal', launchKind: 'shell' }), 'Shell');
assert.equal(p.sessionKindLabel({ type: 'terminal' }), 'Agent');

const ws = [
  { id: 'w1', name: 'Alpha', path: 'D:\\a' },
  { id: 'w2', name: 'Beta', path: 'D:\\b' }
];
const sessions = [
  {
    id: 's1',
    name: '修看板',
    type: 'terminal',
    workspaceId: 'w1',
    createdAt: 2
  },
  {
    id: 's2',
    name: 'Shell',
    type: 'terminal',
    launchKind: 'shell',
    workspaceId: 'w2',
    createdAt: 1
  }
];

const empty = p.collectGotoHits(ws, sessions, '', 'w1', 's1');
assert.equal(empty.workspaces[0].id, 'w1');
assert.equal(empty.workspaces[0].current, true);
assert.equal(empty.sessions[0].id, 's1');
assert.ok(empty.sessions.some((h) => h.id === 's2'));

const byName = p.collectGotoHits(ws, sessions, '看板', 'w1', 's1');
assert.equal(byName.sessions.length, 1);
assert.equal(byName.sessions[0].id, 's1');
assert.equal(byName.workspaces.length, 0);

const byWs = p.collectGotoHits(ws, sessions, 'Beta', 'w1', null);
assert.ok(byWs.workspaces.some((h) => h.id === 'w2'));
assert.ok(byWs.sessions.some((h) => h.id === 's2'));

assert.equal(p.SETTINGS_TABS.length, 14);
assert.ok(p.SETTINGS_TABS.some(tab => tab.id === 'channels' && tab.group === 'connect'));
assert.equal(p.normalizeSettingsTab('channels'), 'channels');
assert.equal(p.normalizeSettingsTab('feishu'), 'remoteAccess');
assert.equal(p.collectSettingsHits('消息源').find(hit => hit.id === 'channels-main')?.tab, 'channels');
assert.equal(p.collectSettingsHits('远程输入').find(hit => hit.id === 'remote-messaging')?.tab, 'remoteAccess');
for (const id of ['feishu-scan', 'feishu-bind', 'feishu-commands']) {
  assert.ok(!p.SETTINGS_ITEMS.some(item => item.id === id), `removed Feishu entry must not remain searchable: ${id}`);
}
assert.equal(p.collectSettingsHits('飞书').find(hit => hit.id === 'channels-main')?.tab, 'channels');
assert.ok(!p.SETTINGS_TABS.some(tab => tab.id === 'feedback'));
assert.equal(p.normalizeSettingsTab('feedback'), 'about');
assert.equal(p.collectSettingsHits('反馈').find(hit => hit.id === 'feedback')?.tab, 'about');
assert.equal(p.SETTINGS_TABS.find(tab => tab.group === 'ai')?.id, 'worker');
assert.equal(p.SETTINGS_TABS.find(tab => tab.id === 'worker')?.label, 'Harness 接入');
assert.equal(p.normalizeSettingsTab('integrations'), 'capabilityManagement');
assert.equal(p.normalizeSettingsTab('general'), 'general');
assert.equal(p.normalizeSettingsTab('nonexistent'), 'general');
assert.ok(p.SETTINGS_TABS.some(tab => tab.id === 'capabilityManagement' && tab.group === 'ai'));
assert.equal(p.collectSettingsHits('技能管理').find(hit => hit.id === 'skills-manager')?.tab, 'capabilityManagement');
assert.equal(p.collectSettingsHits('MCP').find(hit => hit.id === 'mcp-servers')?.tab, 'capabilityManagement');
assert.ok(p.SETTINGS_TABS.some((t) => t.id === 'general'));
// 每个页签都归属到已声明的导航分组，且每组至少一页
const groupIds = new Set(p.SETTINGS_GROUPS.map((g) => g.id));
assert.ok(p.SETTINGS_TABS.every((t) => groupIds.has(t.group)));
assert.ok(p.SETTINGS_GROUPS.every((g) => p.SETTINGS_TABS.some((t) => t.group === g.id)));
// 搬到「通用」页的设置项：搜索命中后跳 general 页（focusItem id 不变）
assert.equal(p.collectSettingsHits('休眠').find((h) => h.id === 'worker-keep-awake')?.tab, 'general');
assert.ok(p.SETTINGS_TABS.some((t) => t.id === 'memory'));
assert.ok(p.SETTINGS_TABS.some((t) => t.id === 'textTools'));
assert.ok(p.SETTINGS_TABS.some((t) => t.id === 'about'));
assert.ok(p.SETTINGS_TABS.some((t) => t.id === 'notify'));
assert.ok(p.SETTINGS_ITEMS.some((i) => i.id === 'about-update'));
assert.ok(p.SETTINGS_ITEMS.some((i) => i.id === 'mcp-enabled'));
const emptySettings = p.collectSettingsHits('');
assert.ok(emptySettings.length >= p.SETTINGS_TABS.length);
assert.ok(emptySettings.some((h) => h.tab === 'remoteAccess' && h.title === '远程访问'));
assert.ok(emptySettings.some((h) => h.tab === 'textTools' && h.title === '文本工具'));
const mcpHits = p.collectSettingsHits('MCP');
assert.ok(mcpHits.some((h) => h.id === 'mcp-enabled'));
assert.ok(mcpHits.some((h) => h.id === 'mcp-servers'));
const themeExtra = p.themeGroupsToSettingsItems([
  { id: 'bg', label: '背景海拔', keys: [{ key: 'bg-canvas', label: '画布底（终端/编辑器）' }] }
]);
const canvasHits = p.collectSettingsHits('画布底', themeExtra);
assert.ok(canvasHits.some((h) => h.id === 'theme-color:bg-canvas'));

// 搜索跳转契约：每个 SETTINGS_FIELDS id 在设置页源码里都有同名跳转锚点
// （data-settings-item="…" 或 shared.tsx 原语的 item="…"），否则命中后既不滚动也不闪烁
const settingsDir = path.join(root, 'src/renderer/src/components/settings');
const anchorIds = new Set();
for (const f of fs.readdirSync(settingsDir)) {
  if (!f.endsWith('.tsx')) continue;
  const src = fs.readFileSync(path.join(settingsDir, f), 'utf8');
  for (const m of src.matchAll(/(?:data-settings-item|\bitem)="([^"]+)"/g)) anchorIds.add(m[1]);
}
const tabIds = new Set(p.SETTINGS_TABS.map((t) => t.id));
const missingAnchors = p.SETTINGS_ITEMS.filter((i) => !tabIds.has(i.id) && !anchorIds.has(i.id)).map((i) => i.id);
assert.deepEqual(missingAnchors, [], `设置搜索项缺少跳转锚点: ${missingAnchors.join(', ')}`);

console.log('command-palette: ok');
fs.rmSync(tmp, { recursive: true, force: true });
