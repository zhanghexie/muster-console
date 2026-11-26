// E5 对比表：三色候选（大图）+ 底色深度测试（仿任务栏）+ 小尺寸梯队
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => readFileSync(path.join(dir, f), 'utf8');

const colors = [
  { key: '薄荷', file: 'icon-e5-mint.svg', hex: '#45D0A0' },
  { key: '科技蓝', file: 'icon-e5-blue.svg', hex: '#58A6FF' },
  { key: '蓝紫', file: 'icon-e5-violet.svg', hex: '#8B7CFF' }
];

const cell = (svg, size) => `<div class="icon" style="width:${size}px;height:${size}px">${svg}</div>`;

const row1 = colors
  .map(
    (p) => `<div class="cell">
      ${cell(load(p.file), 300)}
      <div class="name">${p.key} <code>${p.hex}</code></div>
    </div>`
  )
  .join('');

// 底色深度测试：三块 44px 图标放进仿任务栏（#1F1F1F）
const tiles = [
  { key: '#000000', file: 'icon-e5-tile-black.svg' },
  { key: '#101010', file: 'icon-e5-mint.svg' },
  { key: '#1A1A1A', file: 'icon-e5-tile-app.svg' }
];
const taskbar = `<div class="taskbar">
  <i class="fake"></i><i class="fake"></i>
  ${tiles.map((t) => `<div class="tb">${cell(load(t.file), 44)}<span>${t.key}</span></div>`).join('')}
  <i class="fake"></i><i class="fake"></i><i class="fake"></i>
</div>`;

const row3 = colors
  .map(
    (p) => `<div class="pill">${cell(load(p.file), 48)}${cell(load(p.file), 24)}${cell(load(p.file), 16)}<span>${p.key}</span></div>`
  )
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:1500px;height:960px;background:#0c0c0c;
    font-family:"Segoe UI",system-ui,sans-serif;color:#9a9a9a;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:38px;
    -webkit-font-smoothing:antialiased}
  .icon svg{width:100%;height:100%;display:block}
  .row{display:flex;gap:64px;align-items:flex-start}
  .cell{display:flex;flex-direction:column;align-items:center;gap:12px}
  .cell .icon{filter:drop-shadow(0 18px 36px rgba(0,0,0,.6))}
  .name{font-size:20px}
  .name code{font-size:16px;color:#5f5f5f;font-family:Consolas,monospace}
  .taskbar{display:flex;align-items:center;gap:26px;background:#1f1f1f;
    border:1px solid rgba(255,255,255,.05);border-radius:16px;padding:12px 28px}
  .taskbar .fake{width:44px;height:44px;border-radius:10px;background:#2c2c2c}
  .tb{display:flex;flex-direction:column;align-items:center;gap:6px}
  .tb span{font-size:13px;color:#6a6a6a;font-family:Consolas,monospace}
  .strip{display:flex;gap:26px}
  .pill{display:flex;align-items:center;gap:12px;background:#1a1a1a;
    border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:12px 18px}
  .pill span{font-size:15px;color:#6a6a6a;margin-left:4px}
</style></head><body>
  <div class="row">${row1}</div>
  ${taskbar}
  <div class="strip">${row3}</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500,
    height: 960,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const image = await win.webContents.capturePage();
  writeFileSync(path.join(dir, 'preview-e5.png'), image.toPNG());
  console.log('written', path.join(dir, 'preview-e5.png'), image.getSize());
  app.quit();
});
