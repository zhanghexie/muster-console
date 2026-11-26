/**
 * ① 左栏会话列表项左右边距对称性守卫（回归 2026-10-06 用户报单）。
 *
 * 曾给 .left-panel-scroll 加了 scrollbar-gutter: stable，
 * 在滚动容器右侧永久预留滚动槽（Windows 实测 10px）——列表内所有子元素
 * （.session-list / .utility-feature-list，padding: 0 var(--frame-gap)）
 * 右缘比左缘多出这条槽，会话行与左栏外元素（.left-ws-slot 等）左右不对齐。
 * overlay 滚动条环境下该属性只制造空槽、没有任何防跳动收益，已移除。
 *
 * 本守卫锁两件事：
 * 1. .left-panel-scroll 不得再声明 scrollbar-gutter: stable；
 * 2. .session-list 的左右 padding 必须对称（0 var(--frame-gap) 或 0），不允许单侧加边。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'postcss';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs.readFileSync(path.join(root, 'src/renderer/src/styles/left.css'), 'utf8');

function ruleBlock(selector) {
  const rules = [];
  parse(css).walkRules(rule => {
    if (rule.selectors.includes(selector)) rules.push(rule.toString());
  });
  assert.ok(rules.length, `left.css 缺少规则 ${selector}`);
  return rules.join('\n');
}

// 1) 滚动容器不得预留滚动槽，且不得回退到白名单之外；
const scrollBlock = ruleBlock('.left-panel-scroll');
assert.ok(
  !/scrollbar-gutter/.test(scrollBlock),
  `.left-panel-scroll 不得声明 scrollbar-gutter（stable 预留右侧 10px 槽，导致会话行左右边距不对称）。当前块：\n${scrollBlock}`
);
// 经典滚动条平台溢出时滚动槽同样占布局位（本机实测 10px），须整栏无滚动条才能产对称
assert.ok(
  /scrollbar-width:\s*none/.test(scrollBlock),
  `.left-panel-scroll 应声明 scrollbar-width:none（溢出时经典滚动条占 10px 布局位，会破坏左右对称；滚轮/键盘滚动不受影响）。当前块：\n${scrollBlock}`
);

// 2) 会话列表左右 padding 对称（同值 shorthand 或 0）
const listBlock = ruleBlock('.session-list');
const padding = /padding:\s*([^;]+);/.exec(listBlock)?.[1] ?? '';
assert.ok(
  /padding/.test(listBlock),
  `.session-list 需要显式 padding 声明以锁定对称性。当前块：\n${listBlock}`
);
assert.ok(
  !/padding-left|padding-right/.test(listBlock),
  `.session-list 不得用 padding-left/right 单侧加边（会破坏左右对称）。当前块：\n${listBlock}`
);
const parts = padding.trim().split(/\s+/);
assert.ok(
  parts.length <= 2,
  `.session-list 的 padding 应为对称形式（0 或 '0 var(--frame-gap)'），当前：${padding}`
);
if (parts.length === 2) {
  // 形如「0 <同一 token>」：上下 0、左右同值；不允许左右异值
  assert.ok(
    parts[0] === '0' && !parts[1].includes(' '),
    `.session-list padding 应形如「0 <同一 token>」，当前：${padding}`
  );
  assert.ok(
    parts[1].startsWith('var(') || /^0(\.\d+)?(px|rem|em)?$/.test(parts[1]),
    `.session-list 左右 padding 须是单个 token（推荐 var(--frame-gap)），当前：${padding}`
  );
}

console.log('left-panel-list-margin: 会话列表左右边距对称性守卫通过');
