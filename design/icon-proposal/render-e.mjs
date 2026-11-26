// E 环轨四变体对比表 preview-e.png
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => readFileSync(path.join(dir, f), 'utf8');

const variants = [
  { key: 'E1', file: 'icon-e1.svg', name: '青色卫星', desc: '冷调青与藏蓝底同族' },
  { key: 'E2', file: 'icon-e2.svg', name: '灰绿卫星', desc: '降饱和鼠尾草绿，收敛刺眼' },
  { key: 'E3', file: 'icon-e3.svg', name: '全单色', desc: '活跃卫星纯白+半透白弧，最临床' },
  { key: 'E4', file: 'icon-e4.svg', name: '去弧', desc: '灰绿卫星、删扫过弧，验证弧的影响' }
];

const cell = (p, size) => `<div class="icon" style="width:${size}px;height:${size}px">${load(p.file)}</div>`;

const bigCells = variants
  .map(
    (p) => `<div class="cell">
      ${cell(p, 340)}
      <div class="name">${p.key} · ${p.name}</div>
      <div class="desc">${p.desc}</div>
    </div>`
  )
  .join('');

const smallCells = variants
  .map((p) => `<div class="pill">${cell(p, 48)}${cell(p, 24)}<span>${p.key}</span></div>`)
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:1600px;height:660px;background:linear-gradient(180deg,#161616,#0e0e0e);
    font-family:"Segoe UI",system-ui,sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;
    -webkit-font-smoothing:antialiased}
  .icon svg{width:100%;height:100%;display:block}
  .row{display:flex;gap:56px;align-items:flex-start}
  .cell{display:flex;flex-direction:column;align-items:center;gap:12px}
  .cell .icon{filter:drop-shadow(0 18px 36px rgba(0,0,0,.55))}
  .name{font-size:22px;color:#9a9a9a;margin-top:6px}
  .desc{font-size:15px;color:#5f5f5f}
  .strip{display:flex;gap:26px}
  .pill{display:flex;align-items:center;gap:12px;background:#1e1e1e;
    border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:12px 18px}
  .pill span{font-size:15px;color:#6a6a6a;margin-left:4px}
</style></head><body>
  <div class="row">${bigCells}</div>
  <div class="strip">${smallCells}</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600,
    height: 660,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const image = await win.webContents.capturePage();
  writeFileSync(path.join(dir, 'preview-e.png'), image.toPNG());
  console.log('written', path.join(dir, 'preview-e.png'), image.getSize());
  app.quit();
});
