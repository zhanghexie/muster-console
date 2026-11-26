/** Production CSS layout regression in a wide Chromium viewport and narrow local panes.
 * The DOM follows the real utility/extension/memory hosts; this proves CSS geometry,
 * while the production Electron capture separately exercises the full component/IPC tree.
 * Run: node test/utility-narrow-layout-visual.mjs
 * Negative control: --baseline recreates the squeezed, nonwrapping declarations and must fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
const output = path.join(root, 'output/color-system-narrow-layout');
const labels = ['安装扩展…', '安装到全局…', '从其他工作区导入…', '打开扩展目录', '刷新', '返回终端'];
const actions = ['更新…', '回退上一版本', '复制到全局扩展库', '添加到工具列表', '禁用', '详情', '卸载…'];
try {
  fs.mkdirSync(output, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(`<div id="extensions" style="position:relative;height:720px">
    <main class="prompt-task-panel ext-manager-panel">
      <header class="prompt-task-toolbar"><div><div class="task-eyebrow">实用功能</div><h1>扩展管理</h1><span>1 个扩展 · 目录 .muster/extensions/ · schema 见目录内 README.md</span></div>
        <div class="prompt-task-toolbar-actions">${labels.map(label => `<button class="ui-btn">${label}</button>`).join('')}</div></header>
      <div class="prompt-task-list"><div class="prompt-task-row ext-manager-row"><div class="ext-manager-row-main">
        <span class="ext-manager-icon">▦</span><div class="ext-manager-info"><div class="ext-manager-name-line"><span class="ext-manager-name">每日工作日报</span><span class="ext-manager-ver">v1.0.0</span><span class="ext-status on">已启用</span></div>
          <div class="ext-manager-meta"><code>daily-report</code><span class="ext-badge">动作 · 待确认</span></div><div class="ext-manager-desc">侧栏面板：日历 + 工作日报；标题和正文不能被操作按钮压成逐字竖排。</div></div>
        <div class="ext-manager-actions">${actions.map(label => `<button class="ui-btn tiny">${label}</button>`).join('')}</div>
      </div></div></div></main></div>
    <div id="usage" style="position:relative;height:200px"><main class="prompt-task-panel usage-panel"><header class="prompt-task-toolbar"><div><div class="task-eyebrow">实用功能</div><h1>使用统计</h1><span>今天 · 全部工作区 · 计数永久保留 · 明细 30 天 / 1000 条</span></div><div class="prompt-task-toolbar-actions"><button class="ui-btn">刷新</button><button class="ui-btn">返回终端</button></div></header></main></div>
    <div id="memory" style="display:flex;height:640px"><div class="memory-overview"><div class="memory-overview-body"><div class="memory-overview-card"><svg class="memory-overview-svg" style="width:1090px;height:700px" viewBox="50 8 1090 700"><foreignObject x="385" y="415" width="205" height="80"><div class="mflow-node"><div class="mflow-title">情景暂存池</div><div class="mflow-sub">记忆的排队区 · 不会自动带进对话</div></div></foreignObject></svg></div><aside class="mflow-feed"><div class="mflow-feed-head"><h3 class="mflow-feed-title">最近动态</h3></div><div class="mflow-feed-list"><p class="mflow-feed-empty">还没有动态。</p></div></aside></div></div></div>`);
  for (const name of ['base', 'ext', 'tasks', 'memory']) await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${name}.css`) });
  if (process.argv.includes('--baseline')) await page.addStyleTag({ content: `
    .prompt-task-toolbar { flex-wrap:nowrap }
    .prompt-task-toolbar > div:first-child { flex:0 1 auto }
    .prompt-task-toolbar-actions { flex-wrap:nowrap;flex:0 1 auto }
    .prompt-task-toolbar-actions > .ui-btn { flex:0 1 auto;white-space:normal }
    .ext-manager-row-main { flex-wrap:nowrap }
    .ext-manager-actions { flex:0 0 auto;flex-wrap:nowrap }
    .ext-manager-row-main > .ext-manager-info { flex:1 1 0 }
    .memory-overview { container:none }
  ` });
  for (const width of [320, 480, 720, 1200]) {
    await page.evaluate(width => {
      for (const id of ['extensions', 'usage', 'memory']) document.getElementById(id).style.width = `${width}px`;
    }, width);
    const layout = await page.evaluate(() => {
      const rect = el => { const r=el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height }; };
      const extension=document.querySelector('.ext-manager-panel'), row=document.querySelector('.ext-manager-row-main'), info=document.querySelector('.ext-manager-info'), actions=document.querySelector('.ext-manager-actions');
      const buttons=[...document.querySelectorAll('.prompt-task-toolbar-actions > .ui-btn,.ext-manager-actions > .ui-btn')].map(el=>({ text:el.textContent,rect:rect(el),pane:rect(el.closest('.prompt-task-panel')),whiteSpace:getComputedStyle(el).whiteSpace }));
      const svg=document.querySelector('.memory-overview-svg'), card=document.querySelector('.memory-overview-card'), feed=document.querySelector('.mflow-feed');
      return { extension:rect(extension),row:rect(row),info:rect(info),actions:rect(actions),buttons,bodyDirection:getComputedStyle(document.querySelector('.memory-overview-body')).flexDirection,card:rect(card),feed:rect(feed),svgScale:svg.getScreenCTM().a,subSize:parseFloat(getComputedStyle(svg.querySelector('.mflow-sub')).fontSize)*svg.getScreenCTM().a };
    });
    assert.ok(layout.info.width >= Math.min(180,width-88), `${width}: extension text was squeezed to ${layout.info.width}px`);
    for (const button of layout.buttons) {
      assert.equal(button.whiteSpace,'nowrap', `${width}: ${button.text} must stay on one line`);
      assert.ok(button.rect.height <= 42, `${width}: ${button.text} became a vertical ${button.rect.height}px button`);
      assert.ok(button.rect.x >= button.pane.x-1 && button.rect.right <= button.pane.right+1, `${width}: ${button.text} overflows its local pane`);
    }
    if (width <= 640) assert.ok(layout.actions.y >= layout.info.bottom+10, `${width}: extension actions must be below, not beside the text`);
    if (width < 1100) {
      assert.equal(layout.bodyDirection,'column', `${width}: local memory pane must stack independent cards`);
      assert.ok(layout.card.width >= width-34, `${width}: event feed still squeezes the brain canvas`);
      assert.ok(layout.feed.y >= layout.card.bottom+10, `${width}: event feed must follow the brain`);
    } else {
      assert.ok(layout.feed.x >= layout.card.right+10, `${width}: wide memory view keeps its original two columns`);
    }
    assert.ok(layout.svgScale >= 1 && layout.subSize >= 12, `${width}: memory labels shrink below their reading size`);
    await page.locator('#extensions').screenshot({ path:path.join(output,`${width}-extensions.png`) });
  }
  console.log('utility-narrow-layout-visual: OK (4 local widths; production CSS; full Electron evidence separate)');
} finally {
  await browser.close();
}
