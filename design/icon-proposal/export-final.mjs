// 定稿图标导出：SVG → 各尺寸 PNG → build/icon.ico + build/icon.png
// 用法：node_modules\.bin\electron.cmd design\icon-proposal\export-final.mjs
// ≤32px 用 final-small.svg（加粗版），其余用 final.svg。
// 单窗口复用 + 临时文件加载（data: URL 连续建窗在本机会 ERR_FAILED）。
// 透明度关键：不走 capturePage（offscreen 窗口不透明，透明区被合成成白底），
// 改在页面里把 SVG 画进 canvas 再 toDataURL —— canvas 位图自带 alpha，
// 且按目标尺寸直接栅格化，无 DPI 重采样环节。
import { app, BrowserWindow } from 'electron';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(dir, '..', '..');
const finalSvg = readFileSync(path.join(dir, 'final.svg'), 'utf8');
const smallSvg = readFileSync(path.join(dir, 'final-small.svg'), 'utf8');
const tmpHtml = path.join(os.tmpdir(), 'metaagent-icon-capture.html');

const pngSize = (buf) => buf.readUInt32BE(16); // PNG IHDR width @16
const pngHeight = (buf) => buf.readUInt32BE(20);
const pngColorType = (buf) => buf[25]; // 6 = RGBA（带 alpha）

// 空白宿主页：仅承载 executeJavaScript，渲染全部发生在 canvas 里
const blankHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
</style></head><body></body></html>`;

function svgDataUrl(svg, size) {
  const withSize = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(withSize);
}

function renderScript(svg, size) {
  return `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(svgDataUrl(svg, size))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = ${size};
    c.height = ${size};
    c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
    return c.toDataURL('image/png');
  })()`;
}

let win;

async function renderPng(svg, size) {
  const dataUrl = await win.webContents.executeJavaScript(renderScript(svg, size), true);
  const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (pngSize(buf) !== size || pngHeight(buf) !== size) {
    throw new Error(`尺寸不符：要 ${size}，得 ${pngSize(buf)}x${pngHeight(buf)}`);
  }
  if (pngColorType(buf) !== 6) throw new Error(`colorType=${pngColorType(buf)}，alpha 丢失`);
  return buf;
}

app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({
      width: 64,
      height: 64,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: { offscreen: true, backgroundThrottling: false }
    });
    writeFileSync(tmpHtml, blankHtml, 'utf8');
    for (let attempt = 1; ; attempt++) {
      try {
        await win.loadURL('file:///' + tmpHtml.replace(/\\/g, '/'));
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
    const out = [];
    for (const size of sizes) {
      const svg = size <= 32 ? smallSvg : finalSvg;
      const buf = await renderPng(svg, size);
      out.push({ size, buf });
      console.log('rendered', size);
    }
    const ico = makeIco(out.filter((p) => p.size <= 256));
    writeFileSync(path.join(repoRoot, 'build', 'icon.ico'), ico);
    writeFileSync(path.join(repoRoot, 'build', 'icon.png'), out.find((p) => p.size === 1024).buf);
    console.log(
      'written build/icon.ico',
      ico.length,
      'bytes; build/icon.png 1024 RGBA; ico sizes:',
      out.filter((p) => p.size <= 256).map((p) => p.size).join('/')
    );
  } finally {
    app.quit();
  }
});

function makeIco(pngs) {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);
  const entries = Buffer.alloc(16 * count);
  const datas = [];
  let offset = 6 + 16 * count;
  pngs.forEach((p, i) => {
    const e = entries.subarray(i * 16, (i + 1) * 16);
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(p.buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += p.buf.length;
    datas.push(p.buf);
  });
  return Buffer.concat([header, entries, ...datas]);
}
