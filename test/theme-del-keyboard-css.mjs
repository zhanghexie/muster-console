/**
 * 主题行内删除按钮的隐态不得用 visibility:hidden。
 * 背景：visibility:hidden 的元素会被 Tab 焦点遍历直接跳过，:focus-visible 显形
 * 规则永远不触发——键盘用户无法到达删除入口。隐态只许 opacity + pointer-events。
 * 运行: node test/theme-del-keyboard-css.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs
  .readFileSync(path.join(root, 'src/renderer/src/styles/settings.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(target) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(target)) return m[2];
  }
  return null;
}

const hidden = ruleBody('.theme-row-del');
assert.ok(hidden, 'settings.css 缺少 .theme-row-del 规则');
assert.match(hidden, /opacity:\s*0/, '隐态用 opacity');
assert.match(hidden, /pointer-events:\s*none/, '隐态收交互用 pointer-events');
assert.doesNotMatch(
  hidden,
  /visibility:\s*hidden/,
  '禁止 visibility:hidden——Tab 会跳过该按钮，键盘永不可达'
);

const reveal = ruleBody('.theme-row-del:focus-visible');
assert.ok(reveal, '缺少 :focus-visible 显形规则（键盘路径）');
assert.doesNotMatch(reveal, /visibility/, '显形规则不应依赖 visibility');
assert.match(reveal, /pointer-events:\s*auto/, '显形须恢复交互');

const rowFocus = ruleBody('.theme-row:focus-within .theme-row-del');
assert.ok(rowFocus, '行内任一元素获焦时删除按钮应显形（focus-within）');

console.log('theme-del-keyboard-css: 契约全部满足');
