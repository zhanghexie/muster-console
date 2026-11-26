// 一次性渲染脚本：icon-b1.svg → cmp-b.png（与 preview.mjs 同套路）
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(path.join(dir, 'icon-b1.svg'), 'utf8');

const cell = (size) =>
  `<div class="cell"><div class="icon" style="width:${size}px;height:${size}px">${svg}</div><span>${size}</span></div>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:1240px;height:860px;background:linear-gradient(180deg,#161616,#0e0e0e);
    font-family:"Segoe UI",system-ui,sans-serif;color:#7a7a7a;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:44px;
    -webkit-font-smoothing:antialiased}
  .big{width:400px;height:400px;filter:drop-shadow(0 26px 52px rgba(0,0,0,.6))}
  .icon svg{width:100%;height:100%;display:block}
  .row{display:flex;align-items:flex-end;gap:42px}
  .cell{display:flex;flex-direction:column;align-items:center;gap:10px;font-size:12px;color:#6a6a6a}
  .strip{display:flex;align-items:center;gap:18px;background:#1e1e1e;
    border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:10px 22px}
  .strip .fake{width:20px;height:20px;border-radius:6px;background:#2e2e2e}
</style></head><body>
  <div class="big icon">${svg}</div>
  <div class="row">${[128,48,24].map(cell).join('')}</div>
  <div class="strip"><div class="icon" style="width:24px;height:24px">${svg}</div>
    <i class="fake"></i><i class="fake"></i><i class="fake"></i>
  </div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 860,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const image = await win.webContents.capturePage();
  writeFileSync(path.join(dir, 'cmp-b.png'), image.toPNG());
  console.log('written', path.join(dir, 'cmp-b.png'), image.getSize());
  app.quit();
});
