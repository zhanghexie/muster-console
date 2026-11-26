/**
 * 会话树视觉验证：真实 CSS 渲染，截图对比改前/改后。
 * 用途：确认缩进紧凑度、箭头 hover 覆盖状态点、样式与既有会话列表一致。
 * 运行: node test/visual/session-tree-look.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = path.join(root, 'test', 'visual', 'out');
fs.mkdirSync(outDir, { recursive: true });

/** 从真实 CSS 里取需要的规则（避免另写一份样式导致验证失真） */
function readCss(file, from, to) {
  const s = fs.readFileSync(path.join(root, file), 'utf8');
  const i = s.indexOf(from);
  if (i < 0) throw new Error(`CSS 里找不到 ${from}`);
  const j = to ? s.indexOf(to, i) : s.length;
  return s.slice(i, j < 0 ? s.length : j);
}

const leftCss = readCss('src/renderer/src/styles/left.css', '.session-list {', '/* 会话行略高于普通列表行');
const treeCss = readCss('src/renderer/src/styles/left.css', '/* 会话树（子代理通用化）', '.session-item {');

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root {
    --fg-primary: #e6e6e6; --fg-muted: #8a8a8a; --fg-selected-primary: #fff;
    --bg-app: #1e1e1e; --bg-panel: #252526; --bg-elevated: #2d2d30;
    --border-subtle: #3a3a3c; --radius-control: 6px;
    --interaction-hover: rgba(255,255,255,0.06);
    --interaction-selected: rgba(255,255,255,0.10);
    --dur-micro: 120ms; --ease-standard: cubic-bezier(0.2,0,0,1);
    --ease-hover: cubic-bezier(0.2,0,0,1);
    --font-ui: 13px system-ui, sans-serif;
  }
  body { margin:0; background: var(--bg-app); color: var(--fg-primary); font: var(--font-ui); }
  .wrap { width: 300px; background: var(--bg-panel); padding: 8px; }
  .session-item {
    position: relative; display: flex; align-items: center; gap: 8px;
    box-sizing: border-box; min-height: 36px; padding: 7px 10px;
    border-radius: var(--radius-control); cursor: pointer; margin: 0 0 2px 0;
    font-size: var(--font-ui); transition: background-color var(--dur-micro) var(--ease-hover);
  }
  .session-item:hover { background: var(--interaction-hover); }
  .session-state {
    width:16px; height:16px; flex-shrink:0; display:inline-flex;
    align-items:center; justify-content:center; color: var(--fg-primary); opacity:1;
    transition: opacity var(--dur-micro) var(--ease-standard);
  }
  .session-state-idle { color: var(--fg-muted); }
  .dot { width:9px; height:9px; border-radius:50%; background: currentColor; }
  .check { width:11px; height:11px; border-radius:50%; border:2px solid #4ec9b0; }
  .moon { width:11px; height:11px; border-radius:50%; border:1.5px solid var(--fg-muted); }
  .rail { flex:1; min-width:0; display:flex; align-items:center; gap:6px; }
  .name { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pill { font-size:11px; color: var(--fg-muted); border:1px solid var(--border-subtle);
          border-radius:9px; padding:0 6px; white-space:nowrap; }
  .time { font-size:11px; color: var(--fg-muted); }
  ${treeCss}
</style></head>
<body><div class="wrap" id="wrap"></div></body></html>`;

const rows = [
  { level: 0, name: '工作面板 22', pill: '子代理测试完成，全链路…', time: '31m', state: 'check' },
  { level: 1, name: '子代理测试-统计 docs', pill: '', time: '32m', state: 'check' },
  { level: 2, name: '孙代理-回归', pill: '', time: '33m', state: 'moon' },
  { level: 0, name: '测试小米', pill: '', time: '36m', state: 'moon' },
  { level: 1, name: '子代理测试-用例', pill: '', time: '34m', state: 'moon' },
  { level: 0, name: '工作面板 20', pill: '空闲', time: '1h', state: 'moon' }
];

function rowHtml(r) {
  const indent = r.level > 0 ? `<span class="session-tree-indent" style="width:${r.level * 12}px" aria-hidden></span>` : '';
  const hasChildren = r.level === 0 && r.name === '工作面板 22';
  // 与工作会话分组折叠同一个 IconChevronDown（14px，viewBox 0 0 16 16）
  const twisty = hasChildren
    ? `<button type="button" class="session-tree-twisty is-open" tabindex="-1" aria-hidden="true">
         <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>
       </button>`
    : '';
  return `<div class="session-item"${hasChildren ? ' data-has-children="true"' : ''}>
    ${indent}
    <span class="session-state-slot">
      <span class="session-state"><span class="${r.state === 'check' ? '' : 'session-state-idle'}"><span class="${r.state}"></span></span></span>
      ${twisty}
    </span>
    <span class="rail"><span class="name">${r.name}</span>${r.pill ? `<span class="pill">${r.pill}</span>` : ''}</span>
    <span class="time">${r.time}</span>
  </div>`;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 320, height: 260 }, deviceScaleFactor: 2 });
await page.setContent(html.replace('<div class="wrap" id="wrap"></div>', `<div class="wrap" id="wrap">${rows.map(rowHtml).join('')}</div>`));
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(outDir, 'session-tree-idle.png') });

// hover 到有子会话的行 → 箭头应浮现并盖住状态点
await page.hover('.session-item[data-has-children]');
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, 'session-tree-hover.png') });

// 量一下缩进位移（子行相对父行左边缘的差）
const metrics = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.session-item')];
  const box = (i) => {
    const el = items[i];
    const slot = el.querySelector('.session-state-slot');
    return { name: el.querySelector('.name').textContent, slotLeft: slot.getBoundingClientRect().left };
  };
  return items.map((_, i) => box(i));
});
const byName = Object.fromEntries(metrics.map((m) => [m.name, m.slotLeft]));
const levelShift = {
  '子代理测试-统计 docs': byName['子代理测试-统计 docs'] - byName['工作面板 22'],
  '孙代理-回归': byName['孙代理-回归'] - byName['子代理测试-统计 docs']
};
console.log('缩进位移（每层）:', JSON.stringify(levelShift));

await browser.close();
console.log('screenshot →', outDir);

// —— 追加：量箭头与状态点的中心是否重合 ——
const b2 = await chromium.launch();
const p2 = await b2.newPage({ viewport: { width: 320, height: 260 }, deviceScaleFactor: 2 });
await p2.setContent(html.replace('<div class="wrap" id="wrap"></div>', `<div class="wrap" id="wrap">${rows.map(rowHtml).join('')}</div>`));
await p2.waitForTimeout(150);
const centers = await p2.evaluate(() => {
  const item = document.querySelector('.session-item[data-has-children]');
  const slot = item.querySelector('.session-state-slot');
  const state = item.querySelector('.session-state');
  const twisty = item.querySelector('.session-tree-twisty');
  const c = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
  return {
    slot: c(slot), slotW: slot.getBoundingClientRect().width,
    state: c(state), stateW: state.getBoundingClientRect().width,
    twisty: c(twisty), twistyW: twisty.getBoundingClientRect().width
  };
});
console.log('中心偏差（箭头 vs 状态点）:', (centers.twisty - centers.state).toFixed(2), 'px');
console.log('宽度:', JSON.stringify(centers));
await b2.close();

// —— 收起态：箭头应朝右 ——
const b3 = await chromium.launch();
const p3 = await b3.newPage({ viewport: { width: 320, height: 120 }, deviceScaleFactor: 2 });
const collapsed = rows.map(rowHtml).join('').replace('session-tree-twisty is-open', 'session-tree-twisty');
await p3.setContent(html.replace('<div class="wrap" id="wrap"></div>', `<div class="wrap" id="wrap">${collapsed}</div>`));
await p3.waitForTimeout(150);
await p3.hover('.session-item[data-has-children]');
await p3.waitForTimeout(300);
await p3.screenshot({ path: path.join(outDir, 'session-tree-collapsed.png') });
await b3.close();
console.log('collapsed screenshot ok');
