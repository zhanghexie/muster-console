/**
 * 悬浮输入条：列宽对齐走 CSS（与 .agent-chat-col 同 max-width + margin:auto），
 * 禁止 JS getBoundingClientRect 写 left/width（调度浮窗进场 scale 会量脏）；
 * wrap 贴 viewport 底但 padding-bottom 留出视觉间距，
 * 且 wrap 实色背景盖住 padding 区（防下面漏字）。禁止顶沿渐隐遮罩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const css = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/styles/agent-chat.css'),
  'utf8'
);
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');

const wrap = stripped.match(/\.agent-chat-composer-wrap\s*\{([^}]+)\}/);
assert.ok(wrap, '找不到 .agent-chat-composer-wrap 规则');
const wrapBody = wrap[1];

assert.match(wrapBody, /pointer-events:\s*none/);
assert.match(wrapBody, /left:\s*0/, 'abspos 居中：left/right 置 0，宽度用 min()，margin:auto 吃剩余');
assert.match(wrapBody, /right:\s*0/);
const sharedWidth = stripped.match(/:is\(\.agent-chat-composer-wrap, \.chat-history-pos\)\s*\{([^}]+)\}/);
assert.ok(sharedWidth, '会话历史与输入条共用列宽');
assert.match(
  sharedWidth[1],
  /width:\s*min\(\s*var\(--chat-col-max/,
  'wrap 与消息列同宽：min(阅读上限, 100% - 2*inset)'
);
assert.match(sharedWidth[1], /var\(--chat-col-inset/);
assert.match(wrapBody, /margin:\s*0 auto/, '与 .agent-chat-col 同一居中');
assert.doesNotMatch(
  wrapBody,
  /--composer-col-left|--composer-col-width/,
  '禁止再靠 JS 量 .agent-chat-col 的视口坐标写 left/width'
);
assert.match(wrapBody, /bottom:\s*0/, 'wrap 锚 viewport 底，用 padding 留视觉间距');
assert.match(
  wrapBody,
  /padding:[^;]*var\(--composer-dock-inset/,
  'dock-inset 走 padding-bottom，输入条不贴边'
);
assert.match(
  wrapBody,
  /background:\s*var\(--composer-fade\)/,
  'wrap 实色背景必须盖住底 padding 区，防漏字'
);
assert.match(
  wrapBody,
  /border-radius:\s*var\(--radius-composer\)\s+var\(--radius-composer\)\s+0\s+0/,
  '遮挡层上沿圆角须与 chat-input-shell 同用 --radius-composer'
);
assert.doesNotMatch(stripped, /\.agent-chat-composer-wrap\s*>\s*\.agent-composer::before/);

const surface = stripped.match(/\.chat-surface-view\s*\{([^}]+)\}/);
assert.ok(surface, '找不到 .chat-surface-view 规则');
assert.match(
  surface[1],
  /--composer-fade:\s*var\(--surface-canvas\)/,
  '对话页 dock 使用阅读面实底'
);
assert.doesNotMatch(stripped, /\.agent-chat-view \.agent-chat-composer-wrap::before|backdrop-filter/, '输入区不再使用模糊层');
assert.match(surface[1], /--chat-col-max:\s*760px/, '阅读列上限与 .agent-chat-col 同源');
assert.match(surface[1], /--chat-col-inset:\s*12px/, '左右 inset 与 .chat-list padding 同源');

const col = stripped.match(/\.agent-chat-col\s*\{([^}]+)\}/);
assert.ok(col, '找不到 .agent-chat-col 规则');
assert.match(col[1], /max-width:\s*var\(--chat-col-max/);
assert.match(col[1], /margin:\s*0 auto/);

const composerInner = stripped.match(
  /\.agent-chat-composer-wrap\s*>\s*\.agent-composer\s*\{([^}]+)\}/
);
assert.ok(composerInner, '找不到 wrap > .agent-composer 规则');
assert.match(composerInner[1], /width:\s*100%/, '内层铺满已居中的 wrap，不再各自量宽');


const listPad = stripped.match(/\.chat-surface-view\s+\.chat-list\s*\{([^}]+)\}/);
assert.ok(listPad);
assert.match(listPad[1], /var\(--composer-scroll-gap,\s*24px\)/);
assert.match(
  listPad[1],
  /padding-left:\s*calc\(var\(--chat-col-inset,\s*12px\)\s*\+\s*var\(--chat-sb,\s*0px\)\)/,
  'scrollbar-gutter 只在右留槽：左 padding 须补一槽宽，消息列中轴才恒等于视口中线'
);
assert.match(listPad[1], /padding-right:\s*var\(--chat-col-inset/);
assert.doesNotMatch(
  listPad[1],
  /composer-dock-inset/,
  'dock-inset 已进 overlay-h 计量，转写 padding 勿重复加'
);

// 滚动条槽宽补偿合同：槽宽只能用实测 --chat-sb，禁止 CSS 写死（thin 随引擎/系统变）
const coverRule = stripped.match(
  /:is\(\.agent-chat-view, \.agent-float-panel\) :is\(\.agent-chat-composer-wrap, \.chat-history-pos\)\s*\{([^}]+)\}/
);
assert.ok(coverRule, '找不到 GUI 会话 wrap 覆盖规则');
assert.doesNotMatch(
  coverRule[1],
  /right:\s*\d+px/,
  '禁止写死 right 让槽宽（旧 right:8px 与实际 thin 槽不符即错位）'
);
assert.match(
  coverRule[1],
  /--composer-dock-inset/,
  '输入条左右可见边距=底边悬浮间距（dock-inset），压到最窄时三边一致（2026-10-10 用户定稿）'
);
assert.doesNotMatch(
  coverRule[1],
  /--chat-sb/,
  '宽度不再按滚动条槽宽收缩（三边一致由 dock-inset 对齐；dock>槽宽仍留滚出空隙）'
);

const surfaceViewSrc = fs
  .readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/renderer/src/chatSurface/ChatSurfaceView.tsx'
    ),
    'utf8'
  )
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');
assert.doesNotMatch(
  surfaceViewSrc,
  /--composer-col-left|--composer-col-width|getBoundingClientRect/,
  'ChatSurfaceView 禁止再量列几何写 left/width（浮窗 scale 会把视口坐标量脏）'
);
assert.match(
  surfaceViewSrc,
  /syncChatSurfaceLayout\(root\)/,
  '渲染视图必须调用共享布局测量'
);
const layoutSrc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/chatSurface/chatSurfaceLayout.ts'), 'utf8');
assert.match(layoutSrc, /--chat-sb/, '滚动条槽宽必须布局时实测写入 --chat-sb（CSS 写死会错位）');
assert.match(
  layoutSrc,
  /offsetWidth\s*-\s*list\.clientWidth/,
  '槽宽取 list.offsetWidth-list.clientWidth（含 scrollbar-gutter 常驻槽）'
);

const floatCss = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/renderer/src/styles/float.css'),
  'utf8'
);
assert.match(
  floatCss,
  /\.agent-float-panel\.is-entering\s*\{[^}]*transform:[^;}]*scale\(/,
  '调度浮窗进场仍带 scale——列对齐必须走布局坐标/CSS，不能靠视口测量'
);

console.log('composer-overlay: 底 padding 实色遮挡 + CSS 列居中');
