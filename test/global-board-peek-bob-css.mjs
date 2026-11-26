/** 探出提醒：保留 bob 并叠加 Beam，悬停一起暂停；保留原生命中守卫。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles/board.css'), 'utf8');
const component = fs.readFileSync(path.join(root, 'src/renderer/src/panels/GlobalBoard.tsx'), 'utf8');

assert.ok(/\.g-board-overlay\[data-mp-stage='in'\] \.g-board-sheet\.is-peek\s*\{[^}]*animation: g-board-peek-bob var\(--peek-breath\) var\(--ease-loop\) infinite/.test(css), '保留原有上下浮动且不干扰 presence 进出场');
assert.ok(/@keyframes g-board-peek-bob[\s\S]*?--peek-bob/.test(css), '浮动幅度引用 token');
assert.ok(css.includes('--peek-bob: 20px'), '增加浮动幅度，让面板多露出 6px');
assert.ok(css.includes('--peek-breath: calc(var(--dur-breath) * 1.75)'), '浮动周期略缩短且沿用全局时长 token');
assert.ok(/\.g-board-overlay\[data-mp-stage='in'\] \.g-board-sheet\.is-peek:has\(\.g-board-peek-trigger:hover, \.g-board-peek-trigger:focus-visible\)\s*\{[^}]*animation-play-state: paused/.test(css), 'hover/focus 暂停浮动的优先级必须覆盖 bob 动画 shorthand');
assert.ok(css.includes('--peek-h: var(--board-ticker-h)'), '保留共用底栏高度');
assert.ok(/\.g-board-peek-beam\[data-beam\]\s*\{[^}]*position: relative;[^}]*height: 100%;[^}]*border-radius: inherit/.test(css),
  'Beam 包住整张面板内容，使用完整高度与圆角');
assert.ok(!component.includes('g-board-peek-beam-surface'), '不再添加空的底栏光效组件');
assert.ok(/\[data-beam-bloom\]\s*\{[^}]*pointer-events: none/.test(css), '仅装饰层不抢点击，面板内容仍可交互');
assert.ok(css.includes('.g-board-peek-trigger:focus-visible) .g-board-peek-beam::after'), '悬停和键盘聚焦都暂停伪元素');
assert.ok(css.includes('animation-play-state: paused !important'), '暂停必须覆盖库生成的循环样式');
assert.ok(css.includes('animation-play-state: paused, paused, paused, paused, paused, running !important'), '悬停暂停 line 的五条循环动画，最后的淡入继续');
assert.ok(/:not\(\[data-board-beam-active\]\) \{ animation: none !important; \}/.test(css), '展开或退出停止全部 Beam 循环');
assert.ok(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.g-board-peek-beam\[data-beam\] \{ animation: none !important; \}/.test(css),
  '减少动态时停止装饰，不隐藏内容容器');
assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.g-board-sheet\.is-peek \{ animation: none; \}/.test(css), '减少动态时关闭浮动');
// 悬停唤出已下线：组件里不应再有驻留展开计时器与捕获层
assert.ok(!component.includes('HOVER_EXPAND_MS'), '悬停驻留展开计时器应已移除');
assert.ok(!component.includes('g-board-peek-catcher'), '探出捕获层应已移除');
assert.ok(component.includes('g-board-peek-trigger'), '探出态应有整条统一入口');
assert.ok(!component.includes('g-board-peek-expand'), '探出条不再有右缘展开钮');
// Electron 的标题栏拖动命中独立于 DOM 层级，浮在顶栏上的通知必须显式排除拖动。
assert.ok(/\.g-board-sheet\s*\{[^}]*-webkit-app-region:\s*no-drag\s*;/.test(css),
  '通知面板位于原生标题栏上方，必须禁止窗口拖动，才能收到真实鼠标点击');
console.log('global-board-peek-bob-css: OK');
