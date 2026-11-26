/**
 * 总览脑图样式契约（memory-panel-comprehension-plan 条目 11 + M3 条目 1B + 2026-09-27 用户裁决）。
 *
 * 布局契约（2026-09-27）：脑图**背景**不限宽（4K 撑满面板），**内容**才限宽居中；
 * 「最近动态」独立圆角卡钉在最右，不与脑图共背景、不遮挡脑图。
 *
 * 历史契约（保留意图）：
 * - 内容不得在 4K 下无限放大；默认按宽高适配，用户可自由缩放，放大后滚动阅读。
 * - SVG 使用组件计算的显式尺寸，CSS 不再强制最小宽度。
 * - viewBox 须容得下脑形 path（scale 29.2 后右缘 ~1074）：1010 会裁掉右脑叶。
 *
 * 卡片内缘契约（2026-09-27 贴边事故）：.memory-row 基类无 padding，凡内部不走
 * .memory-row-main 的卡必须进 padding 组；试验台输入行 flex 子项须 min-width:0，
 * 否则「检索」按钮被挤出卡外裁掉。
 *
 * 运行: node test/memory-overview-css.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const css = fs
  .readFileSync(path.join(root, 'src/renderer/src/styles/memory.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

function ruleBody(target) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(target)) return m[2];
  }
  return null;
}

// —— 布局契约：背景不限宽，内容限宽居中（2026-09-27 用户裁决）——
const card = ruleBody('.memory-overview-card');
assert.ok(card, '缺少 .memory-overview-card 规则');
assert.doesNotMatch(
  card,
  /max-width:\s*(?!none)\d/,
  '脑图卡背景不得限宽（4K 撑满面板；内容限宽在 .memory-overview-svg）'
);

const body = ruleBody('.memory-overview-body');
assert.ok(body, '缺少 .memory-overview-body 规则（横向双栏：脑图卡 + 最近动态独立卡）');
assert.match(body, /display:\s*flex/, 'overview-body 须横向 flex 双栏');
assert.match(body, /gap:\s*\d+px/, 'overview-body 两栏须留缝（事件流不得贴脑图）');

const svg = ruleBody('.memory-overview-svg');
assert.ok(svg, '缺少 .memory-overview-svg 规则');
assert.match(svg, /flex:\s*none/, '缩放尺寸不得被 flex 压缩');
assert.match(svg, /margin:\s*auto/, '图像在可用宽高内居中，溢出时起点可滚到');
assert.doesNotMatch(svg, /clamp\(1090px/, '禁止固定最小阅读宽度阻止缩小');
assert.match(svg, /aspect-ratio:\s*1090\s*\/\s*700/, '保持 viewBox 比例');
assert.match(card, /overflow:\s*auto/, '放大后须能滚到整个脑图');
const stage = ruleBody('.memory-overview-stage');
assert.match(stage, /min-height:\s*100%/, '画布必须占满高度才能纵向居中');
assert.match(stage, /width:\s*max-content/, '放大后扩展滚动范围');

// 「最近动态」独立圆角卡：不得 absolute 叠在脑图上，须自带圆角与背景
const feed = ruleBody('.mflow-feed');
assert.ok(feed, '缺少 .mflow-feed 规则（最近动态独立卡）');
assert.doesNotMatch(feed, /position:\s*absolute/, '最近动态不得 absolute 叠在脑图上（须独立成卡）');
assert.match(feed, /border-radius:/, '最近动态须自带圆角矩形背景');
assert.match(feed, /background:/, '最近动态须自带背景（不与脑图共背景）');
assert.match(feed, /width:\s*2\d{2}px/, '最近动态固定宽 ~280px');
assert.match(feed, /flex:\s*none/, '最近动态不得被压扁（flex:none 钉在最右）');

// —— 动画规约属性白名单：.score-bar i 不得过渡 width（transition 只许 transform/
// opacity/grid-template-rows；2026-09-27 复审指出的越白名单写法，还原即红）——
const scoreBar = ruleBody('.score-bar i');
assert.ok(scoreBar !== null, '缺少 .score-bar i 规则');
assert.doesNotMatch(
  scoreBar,
  /transition:[^;}]*(width|height|all)/,
  '.score-bar i 不得 transition width（动画规约：属性白名单只许 transform/opacity/grid-template-rows）'
);

// —— 卡片内缘契约：自定义卡 padding 组（贴边事故，还原即红）——
const padRule = (() => {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].split(',').map((s) => s.trim());
    if (sel.includes('.review-card') && sel.includes('.lab')) return { sel, body: m[2] };
  }
  return null;
})();
assert.ok(padRule, '缺少 .review-card/.lab 等自定义卡的共用 padding 组');
for (const need of ['.review-card', '.approval-card', '.intent-card', '.recycle-card', '.index-card', '.staging-card', '.lab']) {
  assert.ok(padRule.sel.includes(need), `${need} 必须进自定义卡 padding 组（.memory-row 基类无 padding，漏进即贴卡缘）`);
}
assert.match(padRule.body, /padding:\s*14px\s+16px/, '自定义卡 padding 组必须 14px 16px');

// —— 试验台输入行：input 可收缩，按钮不得被挤出（贴边+裁切事故）——
const labInput = ruleBody('.lab-input-row .ui-input');
assert.ok(labInput, '缺少 .lab-input-row .ui-input 规则');
assert.match(labInput, /flex:\s*1\s+1\s+0/, '试验台 input 须 flex:1 1 0（flex:1 的 basis 0% 写法等价，但 min-width 必须另给）');
assert.match(labInput, /min-width:\s*0/, '试验台 input 须 min-width:0（flex 子项默认 min-width:auto 会撑破行宽，把「检索」挤出裁掉）');
const labBtn = ruleBody('.lab-input-row .ui-btn');
assert.ok(labBtn, '缺少 .lab-input-row .ui-btn 规则');
assert.match(labBtn, /flex:\s*none/, '试验台「检索」按钮须 flex:none，不得被压缩');

console.log('memory-overview-css: 契约全部满足');
