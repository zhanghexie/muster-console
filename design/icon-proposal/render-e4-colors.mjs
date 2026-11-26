// E4 六色候选对比表 preview-e4-colors.png
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const load = (f) => readFileSync(path.join(dir, f), 'utf8');

const variants = [
  { key: 'C1', file: 'icon-e4-c1.svg', name: '青', hex: '#4FB3C9' },
  { key: 'C2', file: 'icon-e4-c2.svg', name: '科技蓝', hex: '#58A6FF' },
  { key: 'C3', file: 'icon-e4-c3.svg', name: '蓝紫', hex: '#8B7CFF' },
  { key: 'C4', file: 'icon-e4-c4.svg', name: '琥珀', hex: '#F5A83C' },
  { key: 'C5', file: 'icon-e4-c5.svg', name: '薄荷', hex: '#45D0A0' },
  { key: 'C6', file: 'icon-e4-c6.svg', name: '纯白', hex: '#FFFFFF' }
];

const cell = (p, size) => `<div class="icon" style="width:${size}px;height:${size}px">${load(p.file)}</div>`;

const bigCells = variants
  .map(
    (p) => `<div class="cell">
      ${cell(p, 300)}
      <div class="name">${p.name} <code>${p.hex}</code></div>
    </div>`
  )
  .join('');

const smallCells = variants
  .map((p) => `<div class="pill">${cell(p, 48)}${cell(p, 24)}<span>${p.key}</span></div>`)
  .join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0}
  body{width:2280px;height:560px;background:linear-gradient(180deg,#161616,#0e0e0e);
    font-family:"Segoe UI",system-ui,sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:36px;
    -webkit-font-smoothing:antialiased}
  .icon svg{width:100%;height:100%;display:block}
  .row{display:flex;gap:48px;align-items:flex-start}
  .cell{display:flex;flex-direction:column;align-items:center;gap:12px}
  .cell .icon{filter:drop-shadow(0 18px 36px rgba(0,0,0,.55))}
  .name{font-size:20px;color:#9a9a9a}
  .name code{font-size:16px;color:#5f5f5f;font-family:Consolas,monospace}
  .strip{display:flex;gap:24px}
  .pill{display:flex;align-items:center;gap:12px;background:#1e1e1e;
    border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:12px 18px}
  .pill span{font-size:15px;color:#6a6a6a;margin-left:4px}
</style></head><body>
  <div class="row">${bigCells}</div>
  <div class="strip">${smallCells}</div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 2280,
    height: 560,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 800));
  const image = await win.webContents.capturePage();
  writeFileSync(path.join(dir, 'preview-e4-colors.png'), image.toPNG());
  console.log('written', path.join(dir, 'preview-e4-colors.png'), image.getSize());
  app.quit();
});
