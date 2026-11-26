// 固定到右侧（rightDock.tsx）给中栏会话视图多包了两层 display:contents 父级。
// 凡以 `.center-panel … > 会话视图根` 直接子选择器表达的规则，都必须在同一条规则里写出包装后的路径，
// 否则单屏打开工具层时被包住的终端/GUI 视图不再被藏起（2026-10-28 回归）。
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../src/renderer/src/styles/', import.meta.url);
const WRAP = ' > .right-dock-home > .right-dock-surface > ';
const VIEW = /^(.*\.center-panel[^>]*(?:>[^>]*\))?[^>]*?)\s*>\s*(\.(?:xfade|terminal-wrap|agent-chat-view)\b.*)$/;
let checked = 0;
for (const name of readdirSync(dir).filter(file => file.endsWith('.css'))) {
  const css = readFileSync(new URL(name, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, selectorText] of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    // 按顶层逗号拆分（:has(...) 内的逗号不拆）
    const selectors = []; let depth = 0, start = 0;
    for (let i = 0; i < selectorText.length; i++) {
      const c = selectorText[i];
      if (c === '(') depth++; else if (c === ')') depth--;
      else if (c === ',' && depth === 0) { selectors.push(selectorText.slice(start, i)); start = i + 1; }
    }
    selectors.push(selectorText.slice(start));
    const normalized = selectors.map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    for (const selector of normalized) {
      if (selector.includes('.right-dock-surface')) continue;
      const match = VIEW.exec(selector);
      if (!match) continue;
      checked++;
      const wrapped = `${match[1].trim()}${WRAP}${match[2]}`;
      assert.ok(normalized.includes(wrapped), `${name}: 「${selector}」缺少固定到右侧包装路径「${wrapped}」`);
    }
  }
}
assert.ok(checked >= 4, `应至少检查到工具层遮挡、分屏显隐、层级和查找偏移四类规则，实际 ${checked}`);
console.log(`right-dock-css: OK (${checked} selectors)`);
