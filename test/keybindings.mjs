/**
 * 快捷键纯函数自测。
 * 运行: node test/keybindings.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'src', 'shared', 'keybindings.ts');

function compile() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keybindings-'));
  const outFile = path.join(tmp, 'keybindings.mjs');
  const src = fs.readFileSync(entry, 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: entry
  });
  fs.writeFileSync(outFile, outputText, 'utf8');
  return { outFile, tmp };
}

const { outFile, tmp } = compile();
const kb = await import(pathToFileURL(outFile).href);

const chord = kb.parseChord('ctrl+shift+b');
assert.deepEqual(chord, { ctrl: true, alt: false, shift: true, meta: false, key: 'b' });
assert.equal(kb.serializeChord(chord), 'ctrl+shift+b');
assert.equal(kb.formatChord(chord), 'Ctrl+Shift+B');

assert.equal(kb.parseChord('escape').key, 'escape');
assert.equal(kb.formatChord(kb.parseChord('escape')), 'Esc');
assert.equal(kb.serializeChord(kb.parseChord('ctrl+,')), 'ctrl+,');
assert.equal(kb.formatChordSerialized('ctrl+backslash'), 'Ctrl+\\');

// meta 键平台映射（keybindings F-04）：Cmd/Super/Win 三口径，缺省 Win（无平台上下文）
assert.equal(kb.formatChord(kb.parseChord('meta+k'), 'MacIntel'), 'Cmd+K');
assert.equal(kb.formatChord(kb.parseChord('meta+k'), 'Darwin'), 'Cmd+K');
assert.equal(kb.formatChord(kb.parseChord('meta+k'), 'Linux x86_64'), 'Super+K');
assert.equal(kb.formatChord(kb.parseChord('meta+k'), 'Win32'), 'Win+K');
assert.equal(kb.formatChord(kb.parseChord('meta+k')), 'Win+K', '缺省平台按 Win');
assert.equal(kb.formatChordSerialized('meta+shift+k', 'MacIntel'), 'Shift+Cmd+K', '修饰键顺序固定（Shift 在 meta 前）');
assert.equal(kb.formatChordSerialized('ctrl+k', 'MacIntel'), 'Ctrl+K', '非 meta 修饰不受平台影响');
assert.equal(kb.parseChordLoose('ctrl shift b').key, 'b');
assert.equal(kb.parseChord('not-a-chord+plus+extra'), null);

const fromEv = kb.eventToChord({
  key: 'B',
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false
});
assert.equal(kb.serializeChord(fromEv), 'ctrl+shift+b');
assert.equal(kb.eventToChord({ key: 'Control', ctrlKey: true }), null);

// Real KeyboardEvent.key uses the glyph; defaults must match Host's canonical
// eventToChord -> serializeChord path, not only parse/display correctly.
const splitEvent = kb.eventToChord({ key: '\\', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });
assert.ok(splitEvent);
assert.equal(kb.serializeChord(splitEvent), 'ctrl+backslash');
assert.equal(kb.serializeChord(splitEvent), kb.resolveBinding('center.split'));

// Shift 修饰下 US 布局报告字形（Ctrl+Shift+\ 报 '|'）：必须归一回基准键，
// 否则 virtualScreen.toggle 默认和弦永不匹配（审计 keybindings F-01）。
const shiftedGlyph = kb.eventToChord({ key: '|', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
assert.ok(shiftedGlyph);
assert.equal(kb.serializeChord(shiftedGlyph), 'ctrl+shift+backslash');
assert.equal(kb.serializeChord(shiftedGlyph), kb.resolveBinding('virtualScreen.toggle'));

assert.equal(kb.resolveBinding('utility.tasks'), 'ctrl+shift+t');
assert.equal(kb.resolveBinding('utility.tasks', { 'utility.tasks': null }), null);
assert.equal(
  kb.resolveBinding('utility.tasks', { 'utility.tasks': 'ctrl+alt+t' }),
  'ctrl+alt+t'
);
assert.equal(kb.resolveBinding('utility.tasks', {}), 'ctrl+shift+t');

const cleaned = kb.normalizeKeybindingOverrides({
  'utility.tasks': 'Ctrl+Shift+Q',
  'unknown.action': 'ctrl+k',
  'overlay.close': 'not valid',
  'settings.open': null,
  garbage: 1
});
assert.deepEqual(cleaned, {
  'utility.tasks': 'ctrl+shift+q',
  'settings.open': null
});
assert.equal(kb.normalizeKeybindingOverrides(null), undefined);
assert.equal(kb.normalizeKeybindingOverrides({ nope: 'ctrl+k' }), undefined);

const conflicted = kb.findConflicts({
  'utility.memory': 'ctrl+shift+t',
  'utility.tasks': 'ctrl+shift+t'
});
assert.deepEqual(conflicted.get('ctrl+shift+t')?.sort(), ['utility.memory', 'utility.tasks']);
assert.equal(kb.findConflicts().size, 0);
// 同和弦但 when 不同（ctrl+f = files.find / chat.find）不算冲突；同 when 仍算
assert.ok(kb.findConflicts({ 'palette.goto': 'ctrl+shift+t' }).has('ctrl+shift+t'));

const rows = kb.resolveAllBindings();
assert.ok(rows.length === kb.KEYBINDING_ACTIONS.length);
assert.ok(rows.every((r) => r.title && r.group));

const byName = kb.matchKeybindingSearch('看板', rows);
assert.ok(byName.every((r) => r.id !== 'utility.board'));
assert.ok(byName.some((r) => r.id === 'globalBoard.toggle'));
assert.ok(!kb.KEYBINDING_ACTIONS.some((a) => a.id === 'utility.board'));

const byChord = kb.matchKeybindingSearch('ctrl+shift+g', rows);
assert.ok(byChord.some((r) => r.id === 'globalBoard.toggle'));

const byLoose = kb.matchKeybindingSearch('ctrl shift t', rows);
assert.ok(byLoose.some((r) => r.id === 'utility.tasks'));

assert.deepEqual(kb.findActionsByChord('ctrl+,', null), ['settings.open']);
assert.deepEqual(kb.findActionsByChord('escape'), ['overlay.close']);
assert.equal(kb.resolveBinding('terminal.releaseFocus'), 'ctrl+shift+f8');
assert.equal(kb.formatChordSerialized('ctrl+shift+f8'), 'Ctrl+Shift+F8');
assert.equal(kb.resolveBinding('palette.commands'), 'ctrl+shift+p');
assert.equal(kb.getKeybindingAction('palette.commands').when, 'always');
assert.equal(kb.resolveBinding('palette.goto'), 'ctrl+p');
assert.equal(kb.getKeybindingAction('palette.goto').when, 'notTyping');
assert.equal(kb.getKeybindingAction('files.quickOpen').when, 'notTyping');
assert.equal(kb.resolveBinding('files.quickOpen'), null);
assert.equal(kb.getKeybindingAction('files.findInFiles').title, '所有文件中搜索');
assert.equal(kb.getKeybindingAction('files.findInFiles').when, 'always');
assert.equal(kb.resolveBinding('files.findInFiles'), 'ctrl+shift+f');
assert.equal(kb.getKeybindingAction('chat.find').when, 'chatFind');
assert.equal(kb.resolveBinding('chat.find'), 'ctrl+f');
assert.equal(kb.getKeybindingAction('chat.find').title, '会话内查找');

console.log('keybindings: ok');
fs.rmSync(tmp, { recursive: true, force: true });
