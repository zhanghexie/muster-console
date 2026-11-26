/** 浅色可读性回归：实际 CSS、内置主题、SVG 缩放后的字体和透明叠层。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { createSharedCompiler } from './helpers/shared-compile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-light-reading-'));
const compile = createSharedCompiler(root, tmp);
const { builtinTheme } = await import(pathToFileURL(compile('shared/theme.ts')));
const { resolveAppearance } = await import(pathToFileURL(compile('shared/resolvedAppearance.ts')));
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.setContent(`<button class="settings-nav-item">字体继承</button><input class="font-probe"><textarea class="font-probe"></textarea><select class="font-probe"><option>字体</option></select><main style="background:var(--bg-raised)">
    <div class="s-row-d">需要阅读的设置说明</div>
    <button class="board-card-act">通过</button>
    <div class="board-card-review is-deferred"><div class="board-card-review-row">稍后处理的验收摘要</div></div>
    <div class="stage-row is-discarded"><div class="stage-text">已丢弃的记忆仍可阅读</div><button class="ui-btn">撤销</button></div>
    ${['green','yellow','red','blue','purple'].map(t => `<span class="status" style="color:var(--${t});background:color-mix(in srgb,var(--${t}) 12%,var(--bg-raised))">${t}</span>`).join('')}
  </main>
  <aside style="background:var(--bg-frame)"><span class="metadata" style="color:var(--text-3)">分组与时间信息</span></aside>
  <div class="chat-input-shell" style="flex:none"><input style="background:var(--bg-input)" placeholder="输入内容"></div>
  <div id="board-probe" class="g-board-overlay is-open" style="position:relative;inset:auto;height:100px">
    <main class="board-utility-panel" style="background:var(--bg-panel)">
      <div class="board-view-switch"><button class="board-view-tab" aria-selected="true">状态</button><button class="board-view-tab" aria-selected="false">自由</button></div>
      <div style="flex:1"></div>
      <div class="board-ticker"><span class="board-ticker-line is-empty">2 个需要处理 · 2 未读</span></div>
    </main>
  </div>
  <div class="memory-overview-body" style="width:1100px;height:680px">
    <div class="memory-overview-card"><svg class="memory-overview-svg" style="width:1090px;height:700px" viewBox="50 8 1090 700"><foreignObject x="385" y="415" width="205" height="64"><div class="mflow-node"><div class="mflow-title">情景暂存池</div><div class="mflow-sub">记忆的排队区 · 不会自动带进对话</div></div></foreignObject></svg></div><aside class="mflow-feed"></aside>
  </div>`);
  for (const name of ['base', 'settings', 'board', 'memory', 'chat']) {
    await page.addStyleTag({ path: path.join(root, `src/renderer/src/styles/${name}.css`) });
  }
  await page.evaluate(({ colors, cssVars }) => {
    document.documentElement.dataset.theme = 'light';
    for (const [k, v] of Object.entries(colors)) document.documentElement.style.setProperty(`--${k}`, v);
    for (const [k, v] of Object.entries(cssVars)) document.documentElement.style.setProperty(k, v);
  }, { colors: builtinTheme('light').colors, cssVars: resolveAppearance(builtinTheme('light')).cssVars });
  await page.evaluate(async () => {
    // Contrast pairs describe the settled theme. A control can still be
    // transitioning its background after the foreground color has changed.
    void document.documentElement.offsetWidth;
    await Promise.all(document.getAnimations().filter(animation => animation instanceof CSSTransition)
      .map(animation => animation.finished.catch(() => {})));
  });
  const controlFonts = await page.locator('.settings-nav-item,.font-probe').evaluateAll(els => els.map(el => ({
    tag: el.tagName, actual: getComputedStyle(el).fontFamily, expected: getComputedStyle(document.body).fontFamily
  })));
  for (const f of controlFonts) check(f.actual === f.expected, `${f.tag} 未继承界面字体: ${f.actual}`);
  const results = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    const rgba = color => { ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].map((v,i)=>i===3?v/255:v); };
    const mix = (fg,bg,alpha=fg[3]??1) => fg.slice(0,3).map((v,i)=>v*alpha+bg[i]*(1-alpha));
    const lum = rgb => rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
    const ratio = (a,b) => { const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05); };
    return [...document.querySelectorAll('.s-row-d,.board-card-act,.board-card-review-row,.stage-text,.stage-row .ui-btn,.status,.metadata')].map(el=>{
      const ancestry=[];for(let p=el;p;p=p.parentElement)ancestry.unshift(p);
      let bg=[255,255,255];let opacity=1;
      for(const p of ancestry){const s=getComputedStyle(p);bg=mix(rgba(s.backgroundColor),bg);opacity*=Number(s.opacity);}
      const s=getComputedStyle(el);const fg=mix(rgba(s.color),bg,opacity);
      return {label:el.textContent,size:parseFloat(s.fontSize),contrast:ratio(fg,bg)};
    });
  });
  for (const r of results) {
    check(r.contrast >= 4.5, `${r.label}: 对比度 ${r.contrast.toFixed(2)} < 4.5`);
    const min = r.label === '需要阅读的设置说明' ? 13 : 12;
    check(r.size >= min, `${r.label}: ${r.size}px < ${min}px`);
  }
  for (const width of [620, 1100, 2800]) {
    await page.locator('.memory-overview-body').evaluate((el,w)=>{el.style.width=`${w}px`;},width);
    const sizes = await page.locator('.memory-overview-svg').evaluate(el=>{
      const scale=el.getScreenCTM().a;
      return {scale,sub:parseFloat(getComputedStyle(el.querySelector('.mflow-sub')).fontSize)*scale};
    });
    check(sizes.sub >= 12, `总览容器 ${width}px: 实际说明 ${sizes.sub.toFixed(2)}px < 12px`);
    check(sizes.scale <= 1400/1090+.01, `总览容器 ${width}px: 4K 下仍须限制图的放大`);
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.evaluate(({ colors, cssVars }) => {
      for (const [k,v] of Object.entries(colors)) document.documentElement.style.setProperty(`--${k}`,v);
      for (const [k,v] of Object.entries(cssVars)) document.documentElement.style.setProperty(k,v);
    }, { colors: builtinTheme(theme).colors, cssVars: resolveAppearance(builtinTheme(theme)).cssVars });
    const input = await page.locator('.chat-input-shell').evaluate(el => {
      const css=getComputedStyle(el);
      return {bg:css.backgroundColor,shadow:css.boxShadow,border:css.borderTopWidth,frame:getComputedStyle(document.querySelector('aside')).backgroundColor};
    });
    if (theme === 'light') {
      check(input.bg === 'rgb(242, 243, 245)', '浅色输入区应使用浅灰输入表面');
      check(input.frame === 'rgb(240, 243, 249)', '浅色导航框应为冷灰蓝');
      check(input.shadow === 'none' && input.border === '1px', '输入区须保留单层细描边且不叠阴影');
    } else {
      check(input.bg === 'rgb(35, 35, 38)' && input.shadow === 'none', '切回深色应恢复原输入材质');
    }
    await page.locator('.board-view-switch').evaluate(async el => {
      void el.offsetWidth;
      await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));
    });
    const selection = await page.locator('.board-view-switch').evaluate(el => {
      const chosen = getComputedStyle(el.querySelector('[aria-selected="true"]'));
      const container = getComputedStyle(el);
      const lum = color => color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const contrast = (a,b) => (Math.max(lum(a),lum(b))+.05)/(Math.min(lum(a),lum(b))+.05);
      return { fillContrast:contrast(chosen.backgroundColor,container.backgroundColor), textContrast:contrast(chosen.color,chosen.backgroundColor), fg:chosen.color,bg:chosen.backgroundColor,container:container.backgroundColor };
    });
    check(selection.fillContrast >= 3, `${theme}: 看板选中底色需可辨识，当前 ${selection.fillContrast.toFixed(2)}`);
    check(selection.textContrast >= 4.5, `${theme}: 看板选中文字需可读`);
    for (const state of ['is-open', 'is-peek']) {
      await page.locator('#board-probe').evaluate((el,state)=>{el.className=`g-board-overlay ${state}`;},state);
      const ticker = await page.locator('.board-ticker').evaluate(el=>{
        const line=el.querySelector('.board-ticker-line').getBoundingClientRect();
        return { height:el.getBoundingClientRect().height, lineHeight:line.height };
      });
      check(ticker.height === 28 && ticker.lineHeight === 28, `${theme}/${state}: 底栏和摘要行高度都应为 28px`);
    }
  }
  assert.deepEqual(failures, [], '阅读与看板样式回归');
  console.log('light-readability-visual: OK (contrast, type roles, diagram, board selected states and compact ticker in both themes)');
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
