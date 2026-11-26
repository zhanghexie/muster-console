/**
 * 设置页滚动裁切回归（2026-09-27）：展开长列表（注入清单等）后视觉被截断、
 * 滚动条却已在底——根因是 details.settings-subsection.collapsible 被写成
 * display:flex，展开体作 flex item 不撑高 details 盒，祖先滚动容器
 * scrollHeight 偏小。契约：collapsible 的 details 必须保持 block。
 *
 * 运行: node test/settings-css.mjs
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
    if (m[1].split(',').map((s) => s.trim()).includes(target)) return m[2];
  }
  return null;
}

const collapsible = ruleBody('.settings-subsection.collapsible');
assert.ok(collapsible, '缺少 .settings-subsection.collapsible 规则');
assert.match(
  collapsible,
  /display:\s*block/,
  'details.collapsible 必须 display:block——flex 会让展开体不撑高 details，长列表滚不到底'
);
assert.doesNotMatch(
  collapsible,
  /display:\s*flex/,
  'details.collapsible 不得 display:flex（滚动裁切回归）'
);

// 头行/展开体各自 flex，不影响 details 本身保持 block
const head = ruleBody('.settings-subsection-head');
assert.ok(head && /display:\s*flex/.test(head), 'summary 头行仍应 flex 排布');

const body = ruleBody('.settings-subsection.collapsible > .collapsible-body');
assert.ok(body && /display:\s*flex/.test(body), 'collapsible-body 仍应 flex 纵排');

// 页签叠放栈：外层页卡 overflow:hidden，滚动下放到各 tabpane
const sheet = ruleBody('.settings-sheet');
assert.ok(sheet && /overflow:\s*hidden/.test(sheet), 'settings-sheet 应 overflow:hidden（滚动下放）');
const tabpane = ruleBody('.settings-tabpane');
assert.ok(tabpane && /overflow-y:\s*auto/.test(tabpane), 'settings-tabpane 应 overflow-y:auto');

// 分区（2026-10-19 第二轮）：序号已按用户意见去掉；折叠行三种列表共用一套规格。
const secNum = ruleBody('.s-sec-h h2::before');
assert.equal(secNum, null, '节标题不再带序号（用户裁决：01/02 不好看）');

const summary = ruleWithSelector('.s-adv > summary');
assert.ok(summary, '缺少折叠行 summary 规则');
assert.match(summary, /min-height:\s*40px/, '折叠行应统一 40 高');
assert.match(summary, /font-size:\s*var\(--font-control\)/, '折叠行标题应走 control 字阶');
assert.match(summary, /font-weight:\s*500/, '折叠行标题应为 500');
assert.match(summary, /display:\s*flex/, '折叠行应为 flex 排布');
assert.doesNotMatch(summary, /width:\s*max-content/, '折叠行不得 max-content（hover 底铺不满块宽）');
assert.ok(
  ruleWithSelector('.rt-row > summary') && ruleWithSelector('.llm-provider > summary'),
  'Worker / 供应商折叠行必须与 .s-adv 同组同规格'
);

// 单个折叠也由分区内容框包裹，标题保留可点击区域。
assert.ok(ruleWithSelector('.s-sec-body > .s-adv > summary'), '节内折叠标题应保持对齐');

// 模型与输入页不得再把滚动下放到页内（会留死区 + 硬切半行）
const agentPane = ruleBody(".settings-tabpane[data-settings-item='agent']");
assert.ok(agentPane, '缺少模型与输入页签规则');
assert.match(agentPane, /overflow-y:\s*auto/, '模型与输入应与其它页一致，在 tabpane 内滚动');
assert.doesNotMatch(agentPane, /overflow:\s*hidden/, '模型与输入不得 tabpane overflow:hidden');

// 短数值不占整行：文件预处理那 7 个阈值走设置行 + 窄输入
const numInput = ruleWithSelector('.s-input.is-num');
assert.ok(numInput, '缺少短数值窄输入规则（.s-input.is-num）');
assert.match(numInput, /width:\s*104px/, '短数值输入应定宽，不占整行');
assert.match(numInput, /margin:\s*0/, '行内数值输入不应带字段行的上外边距');

const paneTitle = ruleBody('.settings-pane-title');
assert.ok(paneTitle, '缺少 .settings-pane-title 规则');
assert.match(paneTitle, /position:\s*static/, '页头应随页面滚动');
assert.doesNotMatch(paneTitle, /position:\s*(sticky|fixed)/, '页头不得吸顶或固定');
assert.match(paneTitle, /border-bottom:\s*0/, '页头不得画下划线');
const titleRule = ruleBody('.settings-pane-title::after');
assert.equal(titleRule, null, '页头不得通过伪元素画下划线');

// 选择器含 :is(...)，不能按逗号切分匹配，这里按「整条选择器包含标记」找规则。
function ruleWithSelector(fragment) {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].includes(fragment)) return m[2];
  }
  return null;
}

const heading = ruleBody('.settings-page .s-sec-h');
assert.ok(heading && /border:\s*0/.test(heading), '二级标题不应有下划线');
const groupBody = ruleBody('.settings-page .settings-group-body');
assert.ok(groupBody, '整组内容应有共同边框');
assert.match(groupBody, /border:\s*1px solid var\(--border-subtle\)/, '分区使用主题边框');
assert.match(groupBody, /border-radius:\s*var\(--radius-card\)/, '分区使用卡片圆角');
assert.match(groupBody, /padding:\s*12px/, '分区内容保留内边距');
const flatRows = ruleWithSelector("[data-settings-layout='flat'] :is(.s-rows");
assert.ok(flatRows && /border:\s*0/.test(flatRows), '框内行组不再重复描边');

// 分区间距 48px，资源详情为 32px；直接挂在内容列的分区扣除已有 26px gap。
assert.match(css, /\.settings-page\s*\{[^}]*--settings-section-gap:\s*48px/, '设置页主分区间距应为 48px');
const resourceCss = fs.readFileSync(path.join(root, 'src/renderer/src/components/settings/settings-resource.css'), 'utf8');
assert.match(resourceCss, /\.settings-page\s+\.settings-resource-detail\s*\{[^}]*--settings-section-gap:\s*32px/, '资源详情分区间距应为 32px');
const secGap = ruleBody('.s-sec + .s-sec');
assert.match(secGap, /margin-top:\s*var\(--settings-section-gap,\s*48px\)/, '相邻节复用 48px 分区留白');
const colSecGap = ruleBody('.settings-col > .s-sec + .s-sec');
assert.match(colSecGap, /margin-top:\s*calc\(var\(--settings-section-gap,\s*48px\)\s*-\s*26px\)/, '直接分区扣除列 gap，实际节距仍为 48px');

// 节级动作按钮不能被 flex 纵排拉成整行
const secBtn = ruleWithSelector('.s-sec-body > :is(.btn, .ui-btn)');
assert.ok(secBtn && /align-self:\s*flex-start/.test(secBtn), '节内直接放置的按钮不应拉伸整行');
assert.ok(ruleBody('.s-sec-actions'), '缺少 .s-sec-actions 动作行');

// 规则行摘要必须块级截断，否则长文本会顶到右侧动作上
const ruleLine = ruleBody('.cap-rule-line');
assert.match(ruleLine, /display:\s*block/, '.cap-rule-line 需 display:block 才能省略号截断');

const row = ruleBody('.s-row');
assert.ok(row, '缺少 .s-row 规则');
assert.doesNotMatch(row, /^\s*border(-top|-bottom)?:/m, '.s-row 不得带回行间分隔线');

const navGroups = ruleBody('.settings-nav-groups');
assert.match(navGroups, /gap:\s*36px/, '导航分组应靠 36px 留白分开（不画线）');

console.log('settings-css: ok');
