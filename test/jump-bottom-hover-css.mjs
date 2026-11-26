/**
 * 「滚动到底部 / 回到最新」浮钮 hover 不得把实心底换成半透明叠白。
 * 背景：--hover-fill-strong 是 rgba(250,250,250,0.1)，整段替换 --bg-overlay
 * 后按钮近乎消失。反馈只许用 token 提亮边（border-color），底色保持不透明。
 * 调度面板与 GUI 会话共用 .chat-jump-bottom。
 * 运行: node test/jump-bottom-hover-css.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadCss(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

function ruleBody(css, target) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (selectors.includes(target)) return m[2];
  }
  return null;
}

const must = (cond, msg) => assert.ok(cond, msg);

function assertOpaqueJumpHover(css, baseSel, hoverSel, fileLabel) {
  const base = ruleBody(css, baseSel);
  must(base, `${fileLabel} 缺少规则 ${baseSel}`);
  must(
    /background:\s*var\(--surface-overlay\)/.test(base),
    `${baseSel} 必须用 --surface-overlay 实心底（浮在会话流上，半透明会透底）`
  );

  const hover = ruleBody(css, hoverSel);
  must(hover, `${fileLabel} 缺少规则 ${hoverSel}`);
  must(
    !/background\s*:/.test(hover),
    `${hoverSel} 不得改 background（--hover-fill-strong 半透明叠白会把按钮抹没）`
  );
  must(
    /border-color:\s*var\(--[a-z0-9-]+\)/.test(hover),
    `${hoverSel} 必须用 token 提亮边（border-color: var(--…)），不得写字面量色值`
  );
}

assertOpaqueJumpHover(
  loadCss('src/renderer/src/styles/agent-chat.css'),
  '.chat-jump-bottom',
  '.chat-jump-bottom:hover',
  'agent-chat.css'
);

console.log('jump-bottom-hover-css: 契约全部满足');
