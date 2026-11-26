/**
 * 中栏层级路径面包屑视觉验证（子代理通用化 D2）。
 * 用途：确认面包屑与既有中栏标题栏的观感协调、层级标签可读、分隔符朝向正确。
 * 运行: node test/visual/center-pane-crumbs-look.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'test', 'visual', 'out');
fs.mkdirSync(outDir, { recursive: true });

const splitCss = fs.readFileSync(path.join(root, 'src/renderer/src/styles/split.css'), 'utf8');
const crumbCss = (() => {
  const i = splitCss.indexOf('/* 层级路径面包屑');
  const j = splitCss.indexOf('.center-pane-trailing', i);
  return splitCss.slice(i, j < 0 ? splitCss.length : j);
})();

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root {
    --fg-primary: #e6e6e6; --fg-secondary: #b4b4b4; --fg-muted: #8a8a8a;
    --fg-disabled: #5a5a5a;
    --bg-app: #1e1e1e; --bg-panel: #252526;
    --surface-alt: #2d2d30; --accent: #4a9eff; --accent-soft: rgba(74,158,255,0.16);
    --border-subtle: #3a3a3c; --border-focus: #4a9eff;
    --interaction-hover: rgba(255,255,255,0.06);
    --radius-control: 6px; --radius-small: 4px;
    --dur-micro: 120ms; --ease-standard: cubic-bezier(0.2,0,0,1);
    --ease-hover: cubic-bezier(0.2,0,0,1);
    --font-ui: 13px system-ui, sans-serif; --font-caption: 12px;
  }
  body { margin:0; background: var(--bg-app); color: var(--fg-primary); font: var(--font-ui); }
  .bar {
    display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden;
    padding: 6px 10px; background: var(--bg-panel); border-bottom: 1px solid var(--border-subtle);
  }
  .center-pane-leading { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
  .center-pane-status { display: inline-flex; align-items: center; gap: 5px; flex: none; white-space: nowrap; color: var(--fg-secondary); font-size: 12px; }
  .center-pane-progress { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-muted); font-size: 12px; }
  .center-split-handle-name { min-width: 0; color: var(--fg-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ${crumbCss}
</style></head>
<body>
  <div class="bar" id="bar1"></div>
  <div class="bar" id="bar2"></div>
  <div class="bar" id="bar3"></div>
</body></html>`;

const crumb = (kind, name, isCurrent) => `
  <span class="center-pane-crumb${isCurrent ? ' is-current' : ''}"${isCurrent ? ' aria-current="true"' : ''}>
    <span class="center-pane-crumb-kind">${kind}</span>
    <span class="center-pane-crumb-name">${name}</span>
  </span>`;

const sep = `<span class="center-pane-crumb-sep" aria-hidden>
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
</span>`;

// 三种形态：顶层会话（单标题）、子代理、两级子代理
const bar1 = `<div class="center-pane-leading">
  <span class="center-split-handle-name">工作面板 22</span>
  <span class="center-pane-status"><span>已完成</span></span>
  <span class="center-pane-progress">子代理测试完成，全链路跑通</span>
</div>`;

const bar2 = `<div class="center-pane-leading">
  <nav class="center-pane-crumbs">
    <span class="center-pane-crumb-wrap">${crumb('会话', '工作面板 22', false)}${sep}
      ${crumb('子代理', '子代理测试-统计 docs', true)}</span>
  </nav>
  <span class="center-pane-status"><span>已完成</span></span>
  <span class="center-pane-progress">这是一次代理功能测试</span>
</div>`;

const bar3 = `<div class="center-pane-leading">
  <nav class="center-pane-crumbs">
    <span class="center-pane-crumb-wrap">${crumb('会话', '工作面板 22', false)}${sep}
      ${crumb('子代理', '子代理测试-统计 docs', false)}${sep}
      ${crumb('孙代理', '核对并发用例', true)}</span>
  </nav>
  <span class="center-pane-status"><span>工作中</span></span>
  <span class="center-pane-progress">正在跑用例</span>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 560, height: 150 }, deviceScaleFactor: 2 });
await page.setContent(html
  .replace('<div class="bar" id="bar1"></div>', `<div class="bar" id="bar1">${bar1}</div>`)
  .replace('<div class="bar" id="bar2"></div>', `<div class="bar" id="bar2">${bar2}</div>`)
  .replace('<div class="bar" id="bar3"></div>', `<div class="bar" id="bar3">${bar3}</div>`));
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(outDir, 'center-pane-crumbs.png') });

// 量一下：分隔符朝向（IconChevronDown 基础朝下 + rotate(-90deg) → 应朝右）
const sepAngle = await page.evaluate(() => {
  const el = document.querySelector('.center-pane-crumb-sep');
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
});
console.log('分隔符旋转角（-90 = 朝右 ›）:', sepAngle);

await browser.close();
console.log('screenshot →', outDir);
