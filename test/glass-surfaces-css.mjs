/**
 * 工作面实底守卫（2026-09-29）。
 * 运行: node test/glass-surfaces-css.mjs
 *
 * 约定：主工作面、设置页与浮层均为不透明实底，不挂背景模糊。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(__dirname, '..', 'src', 'renderer', 'src', 'styles');
const read = (f) => fs.readFileSync(path.join(stylesDir, f), 'utf8').replace(/\r\n/g, '\n');

function block(file, selector) {
  const css = read(file);
  const blocks = [];
  let i = -1;
  while ((i = css.indexOf(`\n${selector} {`, i + 1)) >= 0) blocks.push(css.slice(i, css.indexOf('}', i)));
  assert.ok(blocks.length, `${file} 应有 ${selector} 规则`);
  return blocks.join('\n');
}

// 0) token
const base = read('base.css');
for (const t of ['--glass-sheet', '--glass-float', '--glass-blur']) {
  assert.ok(new RegExp(`${t}:`).test(base), `base.css :root 应定义 ${t}`);
}
assert.match(base, /--glass-blur:\s*none/);
assert.match(base, /--glass-float:\s*var\(--surface-canvas\)/);

// 1) 主工作面和设置页连续实底
const workSurfaces = [
  ['base.css', '.center-panel'],
  ['side.css', '.side-tools-panel']
];
for (const [f, sel] of workSurfaces) {
  const b = block(f, sel);
  assert.match(b, /background:\s*var\(--surface-canvas\)/, `${sel} 应以实底连成工作面`);
  assert.doesNotMatch(b, /backdrop-filter/, `${sel} 不应挂 backdrop-filter`);
}
assert.match(block('settings.css', '.settings-sheet'), /background:\s*var\(--surface-canvas\)/);
assert.match(block('left.css', '.left-panel::before'), /background:\s*transparent/);

// 1b) 页投影 token 保持有界兼容，但设置页和工作面当前不挂外投影。
const pageShadow = /--shadow-page:\s*([^;]+);/.exec(base);
assert.ok(pageShadow, 'base.css :root 应定义 --shadow-page');
for (const layer of pageShadow[1].split(/,(?![^(]*\))/)) {
  const blur = Number((/^\s*\S+\s+\S+\s+(\d+)px/.exec(layer) || [])[1] || 0);
  assert.ok(blur <= 8, `--shadow-page 各层模糊半径不得超过页间缝 8px：${layer.trim()}`);
}
const pages = [
  ['settings.css', '.settings-sheet']
];
for (const [f, sel] of pages) {
  assert.doesNotMatch(block(f, sel), /box-shadow:\s*(?!none)/, `${sel} 不应挂外投影`);
}
assert.match(base, /--elevation-sheet:\s*none/);
assert.match(block('base.css', '.terminal-page > .center-panel,\n.git-page > .side-tools-panel,\n.settings-page > .settings-sheet'), /box-shadow:\s*var\(--elevation-sheet\)/);
assert.match(block('left.css', '.left-panel'), /box-shadow:\s*none/);

// 2) 悬浮层：实底、无毛玻璃
const floating = [
  ['left.css', 'html.is-narrow .sessions-column .left-panel::before'],
  ['float.css', '.agent-float-panel'],
  ['board.css', '.g-board-sheet'],
  ['responsive.css', 'html.is-narrow .git-page']
];
for (const [f, sel] of floating) {
  const b = block(f, sel);
  assert.doesNotMatch(b, /backdrop-filter/, `${sel} 不应挂背景模糊`);
  assert.ok(/var\(--(?:surface-canvas|surface-overlay|surface-board-column|glass-float)\)/.test(b), `${sel} 悬浮层应以实底兼容 token 为底`);
}

// 3) 看板：探出态逐帧浮动，不得模糊；整层 opacity 动画会截断面板模糊，只许淡遮罩
const board = read('board.css');
assert.ok(!/backdrop-filter/.test(block('board.css', '.g-board-sheet')), '.g-board-sheet 基础规则（含探出态）不得模糊');
for (const m of board.matchAll(/([^{}]*is-peek[^{}]*)\{([^}]*)\}/g)) {
  assert.ok(!/backdrop-filter/.test(m[2]), `探出态规则不得挂 backdrop-filter：${m[1].trim()}`);
}
assert.ok(
  !/\n\.g-board-overlay:is\(\.is-entering, \.is-expand\) \{\s*animation/.test(board),
  '.g-board-overlay 整层不得做 opacity 进场动画（改淡 ::before 遮罩）'
);

// 4) 中栏工具层：不涂底，改为藏起底下的终端/对话视图
assert.ok(!/background/.test(block('base.css', '.center-utility-layer')), '.center-utility-layer 不得涂底');
const hide = block('base.css', ".center-panel:has(> .center-utility-layer.utility-placement-center:not([data-mp-stage='out'])) > .xfade,\n.center-panel:has(> .center-utility-layer.utility-placement-center:not([data-mp-stage='out'])) > .right-dock-home > .right-dock-surface > .xfade");
assert.ok(/visibility:\s*hidden/.test(hide), '工具层在场时应藏起底下的终端/对话视图');

// 5) 页内结构面板根不自涂实底
const roots = [
  ['git.css', '.git-panel'],
  ['files.css', '.files-panel'],
  ['files.css', '.file-tree'],
  ['browser.css', '.browser-page'],
  ['board.css', '.board-utility-panel'],
  ['tasks.css', '.prompt-task-panel'],
  ['ext.css', '.ext-panel'],
  ['ext.css', '.ext-panel-body']
];
for (const [f, sel] of roots) {
  assert.ok(!/background:\s*var\(--surface-canvas\)/.test(block(f, sel)), `${sel} 不得自涂 --bg-panel（会盖死页的玻璃底）`);
}

// 5b) GUI 会话：视图根不涂底；输入条垫底实色遮挡滚动消息。
assert.ok(!/background/.test(block('agent-chat.css', '.agent-chat-view')), '.agent-chat-view 不得自涂底（会盖死中栏页玻璃）');
assert.ok(/--composer-fade:\s*var\(--surface-canvas\)/.test(block('agent-chat.css', '.chat-surface-view')), '输入条垫底应为 resolver 的实际工作面');
assert.doesNotMatch(read('agent-chat.css'), /\.agent-chat-view \.agent-chat-composer-wrap::before/, '不再挂模糊层');

// 6) 框底由单一纯色提供，不挂渐变背景组件。
assert.match(block('base.css', '.app-shell'), /background:\s*var\(--workspace-frame-color, var\(--surface-frame\)\)/);

console.log('glass-surfaces-css: OK');
