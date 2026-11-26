/**
 * 圆角页内容内收 + 会话选中项可辨（2026-09-28）。
 * 运行: node test/inset-content-css.mjs
 *
 * 1. 终端：.terminal-wrap 贴页圆角时首列/首行字被 12px 圆角裁掉 → 必须留 padding（垫色随 TUI 底色）；
 * 2. 浏览器：原生 WebContentsView 叠在渲染层之上、不受 CSS 圆角裁剪 → 宿主内收成圆角卡，
 *    主进程对视图 setBorderRadius；
 * 3. 会话与实用功能选中项：连续框底上使用同一中性哑光叠层，不加浮起描边。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const styles = path.join(root, 'src', 'renderer', 'src', 'styles');
const read = (f) => fs.readFileSync(path.join(styles, f), 'utf8').replace(/\r\n/g, '\n');

function block(file, selector) {
  const css = read(file);
  const i = css.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `${file} 应有 ${selector} 规则`);
  return css.slice(i, css.indexOf('}', i));
}

function px(decl) {
  return decl
    .trim()
    .split(/\s+/)
    .map((v) => Number.parseFloat(v));
}

// 1) 终端内收
const wrap = block('terminal.css', '.terminal-wrap');
const pad = /padding:\s*([^;]+);/.exec(wrap);
assert.ok(pad, '.terminal-wrap 应有 padding（贴圆角会裁字）');
const [top, , , left] = px(pad[1]);
assert.ok(top >= 4 && left >= 6, `.terminal-wrap 上/左内收不足（${pad[1]}）`);

// 2) 浏览器DOM裁切与统一标签正文平铺
const host = block('browser.css', '.browser-host');
assert.ok(/border-radius:\s*var\(--radius-card\)/.test(host), '.browser-host 应为圆角卡');
assert.ok(/overflow:\s*hidden/.test(host), '.browser-host 应裁剪快照等 DOM 内容');
assert.ok(/margin:\s*[^;0]/.test(host), '.browser-host 应从页边内收');
const tabs = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'tabs.ts'), 'utf8');
assert.doesNotMatch(tabs, /new WebContentsView\(/, '当前浏览器使用DOM webview，不应复活独立视图布局');
const browserPage = fs.readFileSync(path.join(root, 'src/renderer/src/components/BrowserPage.tsx'), 'utf8');
assert.match(browserPage, /<webview/, '真正网页图层参与DOM合成和工作面裁切');
const right = read('right-workspace.css');
assert.match(right, /\.right-workspace \.browser-host\s*\{[^}]*margin:\s*0;[^}]*border-radius:\s*0\s+0\s+max\(0px,\s*calc\(var\(--radius-page\)\s*-\s*2px\)\)/, '标签正文平铺并保持工作面下角裁切');


// 3) 会话与实用功能选中项
const active = block('left.css', '.session-item.active,\n.utility-feature-item.active');
assert.match(active, /background:\s*var\(--interaction-selected\)/, '选中底统一使用所在表面的 resolved token');
assert.match(active, /box-shadow:\s*none/, '选中项不应有浮起描边');
assert.match(block('left.css', '.utility-feature-list .utility-feature-item.active'), /background:\s*var\(--interaction-selected\)/, '磁贴的高特异性静息底不能盖掉选中底');
assert.ok(!/--ws-accent/.test(active), '选中不换色相（design.md §4）');
assert.ok(
  !/background:\s*color-mix\(in srgb, var\(--bg-panel\)/.test(active),
  '选中底不得回到页色叠层（框底上会失去辨识度）'
);

console.log('inset-content-css: OK');
