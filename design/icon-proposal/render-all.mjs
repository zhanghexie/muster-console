// 一次性渲染脚本：六个提案拼一张对比总表 preview-all.png
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => readFileSync(path.join(dir, f), 'utf8');

const proposals = [
  { key: 'A', file: 'icon.svg', name: '门拱 M', desc: '临床单色 · 名字 + 拱下 agent 点' },
  { key: 'B', file: 'icon-b1.svg', name: '岔流', desc: '调度点分岔出三条并行轨（git 分支语言）' },
  { key: 'C', file: 'icon-c.svg', name: '终端', desc: '提示符 > + 光标块 · CLI 本色' },
  { key: 'D', file: 'icon-d.svg', name: '蜂巢', desc: '三格蜂房并行工位 · 中间活跃琥珀格' },
  { key: 'E', file: 'icon-e.svg', name: '环轨', desc: '任务控制中心 · 三颗 agent 在途、绿点扫过' },
  { key: 'F', file: 'icon-f.svg', name: '星门', desc: '渐变活力 · 断环 + 入轨彗星（派发进工作流）' }
];

const cell = (p, size) =>
  `<div class="icon" style="width:${size}px;height:${size}px">${load(p.file)}</div>`;

const bigCells = proposals
  .map(
    (p) => `<div class="cell">
      ${cell(p, 320)}
      <div class="name">${p.key} · ${p.name}</div>
      <div class="desc">${p.desc}</div>
    </div>`
  )
  .join('');

const smallCells = proposals
  .map(
    (p) => `<div class="pill">
      ${cell(p, 48)}${cell(p, 24)}${cell(p, 16)}
      <span>${p.key}</span>
    </div>`
  )
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:1180px;height:1060px;background:linear-gradient(180deg,#161616,#0e0e0e);
    font-family:"Segoe UI",system-ui,sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:42px;
    -webkit-font-smoothing:antialiased}
  .icon svg{width:100%;height:100%;display:block}
  .grid{display:grid;grid-template-columns:repeat(3,320px);gap:46px 50px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:12px}
  .cell .icon{filter:drop-shadow(0 18px 36px rgba(0,0,0,.55))}
  .name{font-size:22px;color:#9a9a9a;margin-top:6px}
  .desc{font-size:15px;color:#5f5f5f}
  .strip{display:flex;gap:26px}
  .pill{display:flex;align-items:center;gap:12px;background:#1e1e1e;
    border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:12px 18px}
  .pill span{font-size:15px;color:#6a6a6a;margin-left:4px}
</style></head><body>
  <div class="grid">${bigCells}</div>
  <div class="strip">${smallCells}</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1180,
    height: 1060,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 900));
  const image = await win.webContents.capturePage();
  writeFileSync(path.join(dir, 'preview-all.png'), image.toPNG());
  console.log('written', path.join(dir, 'preview-all.png'), image.getSize());
  app.quit();
});
