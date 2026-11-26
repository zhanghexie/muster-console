/**
 * 文件预览全格式实测驱动：需要 dev 实例开着 MUSTER_DEVTOOLS_PORT=9333。
 *   MUSTER_DEVTOOLS_PORT=9333 npm run dev   （另开终端）
 *   node test/preview-cdp.mjs
 * 生成真实样例文件（png/wav/webm/docx/xlsx/pptx/zip/tar/gz/csv/...）→
 * 经 workspaces.open 开进沙箱 → DOM 点文件树逐个打开 → 断言预览 DOM → CDP 截图存证。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { zipSync, strToU8 } from 'fflate';
import { PNG } from 'playwright-core/lib/utilsBundle';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const XLSX = require('xlsx');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const CDP_BASE = process.env.MUSTER_CDP || 'http://127.0.0.1:9333';
const WS_DIR = path.join(root, '.dev-sandbox', 'preview-ws');
const EXT_DIR = path.join(root, '.dev-sandbox', 'preview-external');
const SHOT_DIR = path.join(root, '.dev-sandbox', 'preview-shots');

fs.rmSync(WS_DIR, { recursive: true, force: true });
fs.rmSync(EXT_DIR, { recursive: true, force: true });
fs.mkdirSync(WS_DIR, { recursive: true });
fs.mkdirSync(EXT_DIR, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

/* ================= 样例文件生成（全部真实字节） ================= */

// --- 最小 PNG 编码器（64x64 双色块） ---
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, colorA, colorB) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const c = (x < w / 2) !== (y < h / 2) ? colorA : colorB;
      raw[row + 1 + x * 3] = c[0];
      raw[row + 1 + x * 3 + 1] = c[1];
      raw[row + 1 + x * 3 + 2] = c[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// --- WAV（440Hz 正弦 1 秒，16bit PCM） ---
function makeWav() {
  const rate = 8000;
  const seconds = 1;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// --- 最小 DOCX（OOXML zip） ---
function makeDocx() {
  const files = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    ),
    'word/_rels/document.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    ),
    'word/document.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>MetaAgent DOCX 预览验证</w:t></w:r></w:p>
<w:p><w:r><w:t>这一段由 docx-preview 渲染：文档预览全格式改造实测样例（2026-09-04）。</w:t></w:r></w:p>
<w:p><w:r><w:t>The quick brown fox jumps over the lazy dog. 0123456789.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
</w:body></w:document>`
    ),
    'word/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
</w:styles>`
    )
  };
  return Buffer.from(zipSync(files));
}

// --- PPTX（slide1/slide2 大纲） ---
function makePptx() {
  const slide = (texts) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${texts
      .map(
        (t, i) =>
          `<p:sp><p:txBody><a:p><a:r><a:t>${i === 0 ? `<a:rPr b="1"/>${t}` : t}</a:t></a:r></a:p></p:txBody></p:sp>`
      )
      .join('')}</p:spTree></p:cSld></p:sld>`;
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
      ),
      'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
      'ppt/slides/slide1.xml': strToU8(slide(['MetaAgent PPTX 大纲预览', '第一张幻灯片：全格式改造实测'])),
      'ppt/slides/slide2.xml': strToU8(slide(['第二张：边界与限制', '旧版 .ppt 不支持，请转 pptx']))
    })
  );
}

// --- TAR（复用离线测试的构造） ---
function tarHeader(name, size, type = '0') {
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();
  buf.set(enc.encode(name).subarray(0, 100), 0);
  buf.set(enc.encode('0000644'), 100);
  buf.set(enc.encode('0000000'), 108);
  buf.set(enc.encode('0000000'), 116);
  buf.set(enc.encode(size.toString(8).padStart(11, '0')), 124);
  buf.set(enc.encode('00000000000'), 136);
  buf.set(enc.encode(type), 156);
  buf.set(enc.encode('ustar'), 257);
  buf.set(enc.encode('00'), 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[i];
  buf.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return Buffer.from(buf);
}
function pad512(buf) {
  const out = Buffer.alloc(Math.max(512, Math.ceil(buf.length / 512) * 512));
  buf.copy(out);
  return out;
}
function makeTar() {
  const f1 = Buffer.from('tar member one\n');
  const f2 = Buffer.from('tar member two: MetaAgent 归档预览实测\n');
  return Buffer.concat([
    tarHeader('member-one.txt', f1.length),
    pad512(f1),
    tarHeader('member-two.txt', f2.length),
    pad512(f2),
    tarHeader('subdir/', 0, '5'),
    Buffer.alloc(1024)
  ]);
}

fs.writeFileSync(path.join(WS_DIR, 'sample.ts'), `export const answer = 42; // MetaAgent 预览实测\n`);
fs.writeFileSync(
  path.join(WS_DIR, 'readme.md'),
  '# 预览实测\n\n支持 **Markdown** 渲染。\n\n- 列表项一\n- 列表项二\n\n```\nconst code = true;\n```\n'
);
fs.writeFileSync(
  path.join(WS_DIR, 'page.html'),
  '<!doctype html><html><body style="margin:0;min-height:100vh;background:rgb(12,148,88)"><h1>MetaAgent HTML 预览实测</h1><p>iframe sandbox 渲染。</p></body></html>'
);
fs.writeFileSync(path.join(WS_DIR, 'data.json'), JSON.stringify({ ok: true, tool: 'preview' }, null, 2));
fs.writeFileSync(path.join(WS_DIR, 'table.csv'), 'name,qty,note\napple,3,新鲜\nbanana,5,"带,逗号"\ncherry,7,\n');
fs.writeFileSync(path.join(WS_DIR, 'pic.png'), makePng(64, 64, [207, 102, 121], [82, 142, 220]));
fs.writeFileSync(path.join(WS_DIR, 'tone.wav'), makeWav());
fs.writeFileSync(path.join(WS_DIR, 'doc.docx'), makeDocx());
fs.writeFileSync(path.join(WS_DIR, 'deck.pptx'), makePptx());
fs.writeFileSync(path.join(WS_DIR, 'bundle.zip'), Buffer.from(zipSync({
  'hello.txt': strToU8('inside zip'),
  'docs/nested.md': strToU8('# nested')
})));
fs.writeFileSync(path.join(WS_DIR, 'archive.tar'), makeTar());
fs.writeFileSync(path.join(WS_DIR, 'logs.gz'), zlib.gzipSync(Buffer.from('gz payload: 压缩单文件实测\n')));
fs.writeFileSync(path.join(WS_DIR, 'tool.exe'), Buffer.from([0x4d, 0x5a, 0x90, 0x00, ...Array(64).fill(0)]));
fs.writeFileSync(path.join(WS_DIR, 'book.xlsx'), 'placeholder'); // SheetJS 下方写真实文件

// XLSX（SheetJS 生成真实文件）
{
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['项目', '数量', '备注'],
    ['apple', 3, '实测数据'],
    ['banana', 5, ''],
    ['cherry', 7, 'SheetJS 生成']
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const ws2 = XLSX.utils.aoa_to_sheet([['第二张表', true]]);
  XLSX.utils.book_append_sheet(wb, ws2, 'Extra');
  XLSX.writeFile(wb, path.join(WS_DIR, 'book.xlsx'));
}

// 外部文件（工作区外）+ 内链它的 md
const extPng = path.join(EXT_DIR, 'OUTSIDE.png');
fs.writeFileSync(extPng, makePng(48, 48, [40, 160, 90], [220, 170, 40]));
const extUri = `file:///${path.resolve(extPng).replace(/\\/g, '/')}`;
fs.writeFileSync(
  path.join(WS_DIR, 'external-link.md'),
  `# 外部链接\n\n[打开工作区外的图片](${extUri})\n`
);

/* ================= CDP 驱动 ================= */

let msgId = 0;
let ws;
const pending = new Map();

function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(expression, { awaitPromise = true } = {}) {
  const r = await rpc('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (r.exceptionDetails) {
    throw new Error(`evaluate 异常: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description ?? '')}`);
  }
  return r.result?.value;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(desc, fn, timeoutMs = 15000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`等待超时: ${desc}`);
    await sleep(intervalMs);
  }
}

async function connect() {
  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${CDP_BASE}/json/list`);
      targets = await res.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      /* dev 未起，继续等 */
    }
    await sleep(1000);
  }
  const page = targets?.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到应用页面（dev 实例未起或端口不对）');
  ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  });
  await rpc('Runtime.enable');
  await rpc('Page.enable');
}

async function screenshot(name) {
  try {
    await rpc('Page.bringToFront');
  } catch {
    /* 已在前台则忽略 */
  }
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
}

async function clickTreeRow(rel) {
  const ok = await evalJs(
    `(async () => {
      const row = document.querySelector('[data-file-tree-row="' + ${JSON.stringify(rel)} + '"]');
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      row.click();
      return true;
    })()`
  );
  if (!ok) throw new Error(`文件树找不到行: ${rel}`);
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS  ${name} (${Date.now() - t0}ms)`);
    console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push(`FAIL  ${name}: ${e.message}`);
    console.error(`FAIL  ${name}: ${e.message}`);
    await screenshot(`FAIL-${name.replace(/[^\w-]/g, '_')}`);
  }
}

async function main() {
  await connect();

  // webm：MediaRecorder 录 canvas 三帧（真实可解码视频），base64 回传写盘
  await step('生成 webm（MediaRecorder）', async () => {
    const b64 = await evalJs(
      `(async () => {
        // 关键：canvas 必须挂载渲染，captureStream(0) + requestFrame 手动喂帧——
        // 不挂载/靠定时器产帧时 MediaRecorder 会产出只有 EBML 头的空视频
        const c = document.createElement('canvas');
        c.width = 160; c.height = 90;
        c.style.cssText = 'position:fixed;left:-9999px;top:0;';
        document.body.appendChild(c);
        const ctx = c.getContext('2d');
        const stream = c.captureStream(0);
        const track = stream.getVideoTracks()[0];
        const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
        const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 500000 });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const stopped = new Promise((r) => (rec.onstop = r));
        rec.start();
        const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        for (let i = 0; i < 15; i++) {
          ctx.fillStyle = ['#224488', '#448822', '#884422'][i % 3];
          ctx.fillRect(0, 0, 160, 90);
          ctx.font = '20px sans-serif';
          ctx.fillStyle = '#fff';
          ctx.fillText('f' + i, 60, 50);
          if (track.requestFrame) track.requestFrame();
          await raf();
        }
        rec.stop();
        await stopped;
        c.remove();
        const buf = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(bin);
      })()`,
      { awaitPromise: true }
    );
    if (!b64) throw new Error('MediaRecorder 产出为空');
    fs.writeFileSync(path.join(WS_DIR, 'clip.webm'), Buffer.from(b64, 'base64'));
  });

  // 开工作区 + 确保 Files 页签
  await step('打开工作区', async () => {
    const res = await evalJs(
      `window.api.workspaces.open({ path: ${JSON.stringify(WS_DIR)}, name: 'preview-samples' })`
    );
    if (!res?.ok) throw new Error(`workspaces.open 失败: ${JSON.stringify(res)}`);
    await waitFor('文件树出现', async () =>
      evalJs(`Boolean(document.querySelector('[data-file-tree-row]'))`)
    );
  });

  await step('打开虚拟屏（Ctrl+\ → Git 页可见）', async () => {
    try {
      await rpc('Page.bringToFront');
    } catch {
      /* ignore */
    }
    await sleep(300);
    await rpc('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, code: 'Backslash', key: '\\', windowsVirtualKeyCode: 220 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, code: 'Backslash', key: '\\', windowsVirtualKeyCode: 220 });
    await sleep(900);
    const visible = await evalJs(
      `(() => { const el = document.querySelector('.files-panel'); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 100; })()`
    );
    if (!visible) throw new Error('Files 面板不可见（虚拟屏未开）');
  });

  await step('确保 Files 页签可见', async () => {
    const visible = await evalJs(`Boolean(document.querySelector('[data-file-tree-row="sample.ts"]'))`);
    if (!visible) {
      const clicked = await evalJs(
        `(async () => {
          const btn = [...document.querySelectorAll('button')].find((b) => /文件|Files/.test(b.textContent) && b.offsetParent);
          if (!btn) return false;
          btn.click();
          return true;
        })()`
      );
      if (!clicked) throw new Error('找不到 Files 页签按钮');
      await waitFor('sample.ts 行出现', async () =>
        evalJs(`Boolean(document.querySelector('[data-file-tree-row="sample.ts"]'))`)
      );
    }
  });

  const openAndCheck = (file, cond, desc, shot) =>
    step(desc, async () => {
      await clickTreeRow(file);
      await waitFor(`${desc} 条件`, cond, 20000);
      await sleep(400);
      await screenshot(shot);
    });

  const q = (sel) => `Boolean(document.querySelector('${sel}'))`;
  const textHas = (sel, needle) =>
    `Boolean(document.querySelector('${sel}') && document.querySelector('${sel}').textContent.includes(${JSON.stringify(needle)}))`;

  await openAndCheck(
    'sample.ts',
    () => evalJs(textHas('.file-editor-pane.is-shown .cm-content', 'answer = 42')),
    '代码文件（CM 只读预览）',
    'code-ts'
  );
  await openAndCheck(
    'readme.md',
    () => evalJs(textHas('.file-editor-md-body', '预览实测')),
    'Markdown 预览',
    'md'
  );
  await openAndCheck(
    'page.html',
    () => evalJs(`(document.querySelector('iframe.file-editor-preview-html')?.getAttribute('srcdoc') ?? '').includes('HTML 预览实测')`),
    'HTML 预览（sandbox iframe）',
    'html'
  );
  await step('HTML 实际绘制像素（srcdoc 在位不能算通过）', async () => {
    const rect = await evalJs(`(() => { const r = document.querySelector('iframe.file-editor-preview-html').getBoundingClientRect(); return {x:Math.ceil(r.x),y:Math.ceil(r.y),width:Math.floor(r.width-1),height:Math.floor(r.height-1),scale:1}; })()`);
    if (rect.width < 10 || rect.height < 10) throw new Error('HTML 预览不可见');
    await rpc('Page.bringToFront');
    const shot = await rpc('Page.captureScreenshot', { format: 'png', clip: rect });
    const png = PNG.sync.read(Buffer.from(shot.data, 'base64'));
    const offset = (Math.min(160, png.height - 5) * png.width + Math.floor(png.width / 2)) * 4;
    if (png.data[offset] !== 12 || png.data[offset + 1] !== 148 || png.data[offset + 2] !== 88) throw new Error('HTML DOM 已加载但预览像素未绘制');
  });
  await openAndCheck(
    'data.json',
    () => evalJs(textHas('.file-editor-pane.is-shown .cm-content', '"tool": "preview"')),
    'JSON（文本通道）',
    'json'
  );
  await openAndCheck(
    'pic.png',
    () => evalJs(`(() => { const i = document.querySelector('img.file-media-img'); return i && i.naturalWidth > 0 && i.src.startsWith('muster-ws://'); })()`),
    '图片 PNG（muster-ws 协议）',
    'png'
  );
  await openAndCheck(
    'tone.wav',
    () => evalJs(`(() => { const a = document.querySelector('audio.file-media-audio'); return a && isFinite(a.duration) && a.duration > 0.5; })()`),
    '音频 WAV（时长元数据）',
    'wav'
  );
  await openAndCheck(
    'clip.webm',
    // MediaRecorder 产出的 webm 常无时长元数据（duration=Infinity），用 videoWidth+readyState 兜底
    () => evalJs(`(() => { const v = document.querySelector('video.file-media-video'); return v && v.readyState >= 1 && ((isFinite(v.duration) && v.duration > 0.2) || v.videoWidth > 0); })()`),
    '视频 WebM（MediaRecorder 产物可解码）',
    'webm'
  );
  await openAndCheck(
    'doc.docx',
    () => evalJs(textHas('.file-doc-word', 'MetaAgent DOCX 预览验证')),
    'Word DOCX（docx-preview 版式渲染）',
    'docx'
  );
  await openAndCheck(
    'book.xlsx',
    () => evalJs(textHas('.file-doc-sheet', '实测数据')),
    '表格 XLSX（SheetJS → HTML 表格）',
    'xlsx'
  );
  await step('XLSX 第二张表页签', async () => {
    const ok = await evalJs(
      `(async () => {
        const tab = [...document.querySelectorAll('.file-doc-sheet-tab')].find((b) => b.textContent === 'Extra');
        if (!tab) return false;
        tab.click();
        return true;
      })()`
    );
    await waitFor('第二张表内容', () => evalJs(textHas('.file-doc-sheet', '第二张表')));
    await screenshot('xlsx-tab2');
    if (!ok) throw new Error('找不到 Extra 页签');
  });
  await openAndCheck(
    'table.csv',
    () => evalJs(textHas('.file-doc-sheet', '新鲜')),
    'CSV 表格视图',
    'csv'
  );
  await openAndCheck(
    'deck.pptx',
    () => evalJs(`(() => { const s = document.querySelectorAll('.file-doc-slide'); return s.length === 2; })()`),
    '幻灯片 PPTX（大纲卡）',
    'pptx'
  );
  await openAndCheck(
    'bundle.zip',
    () => evalJs(`(() => { const rows = document.querySelectorAll('.file-doc-archive tbody tr'); return rows.length === 2; })()`),
    '压缩包 ZIP（条目清单）',
    'zip'
  );
  await openAndCheck(
    'archive.tar',
    () => evalJs(`(() => { const rows = document.querySelectorAll('.file-doc-archive tbody tr'); return rows.length === 3; })()`),
    '压缩包 TAR（条目清单）',
    'tar'
  );
  await openAndCheck(
    'logs.gz',
    () => evalJs(textHas('.file-doc-archive', 'logs')),
    '压缩包 GZ（单文件条目）',
    'gz'
  );
  await openAndCheck(
    'tool.exe',
    () => evalJs(`${q('.file-media-error')} && ${textHas('.file-media-error-title', '暂不支持预览此格式')}`),
    '未知二进制（优雅错误卡 + 资源管理器按钮）',
    'exe'
  );
  await step('错误卡片「在资源管理器中显示」按钮在场', async () => {
    const has = await evalJs(`Boolean(document.querySelector('.file-media-reveal-btn'))`);
    if (!has) throw new Error('reveal 按钮缺失');
  });

  // 外部文件：md 预览里点 file:/// 绝对链接 → 闸口判外部 → muster-ext 只读预览
  await openAndCheck(
    'external-link.md',
    () => evalJs(textHas('.file-editor-md-body', '外部链接')),
    '外部链接 md 打开',
    'external-md'
  );
  await step('外部图片（muster-ext 只读通道）', async () => {
    await evalJs(`document.querySelector('.file-editor-md-body a.ws-file-link').click()`);
    await waitFor(
      '外部图片加载',
      () =>
        evalJs(
          `(() => { const i = document.querySelector('img.file-media-img'); return i && i.naturalWidth > 0 && i.src.startsWith('muster-ext://'); })()`
        ),
      20000
    );
    await sleep(400);
    await screenshot('external-png');
  });

  // 聊天链接美化：FileLink（图标）组件与 GUI 会话共用，md 预览同构验证
  await openAndCheck(
    'readme.md',
    () => evalJs(textHas('.file-editor-md-body', '预览实测')),
    '链接图标验证前重开 md',
    'md-again'
  );
  await step('文件链接带类型图标（FileLink）', async () => {
    // readme.md 无链接 → 用 external-link.md（它有 file:/// 链接）
    await clickTreeRow('external-link.md');
    await waitFor('链接出现', () => evalJs(`Boolean(document.querySelector('.file-editor-md-body a.ws-file-link svg.fti'))`), 15000);
    const kinds = await evalJs(
      `[...document.querySelectorAll('.file-editor-md-body a.ws-file-link svg.fti')].map((s) => [...s.classList].find((c) => c.startsWith('fti-')))`
    );
    if (!kinds?.length) throw new Error('链接里没有类型图标');
    await screenshot('link-icons');
  });
}

try {
  await main();
} finally {
  console.log('\n===== 实测结果 =====');
  for (const r of results) console.log(r);
  const failed = results.filter((r) => r.startsWith('FAIL'));
  console.log(`\n${results.length - failed.length}/${results.length} 通过；截图目录: ${SHOT_DIR}`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(failed.length ? 1 : 0);
}
