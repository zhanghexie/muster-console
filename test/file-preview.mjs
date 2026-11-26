/**
 * 文件预览能力自测：分类矩阵 / zip-tar-pptx 解析 / 外部文件 URL / MIME 表。
 * 运行: node test/file-preview.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync, strToU8, unzipSync, inflateSync } from 'fflate';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// 编译 shared TS 到 <repo>/node_modules/.ma-preview-test/：
// 产物里 `import ... from 'fflate'` 需要从 node_modules 的父目录解析，os.tmpdir 下不行
const outDir = path.join(root, 'node_modules', '.ma-preview-test');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function compile(name) {
  const src = fs.readFileSync(path.join(root, 'src', 'shared', name), 'utf8');
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: name
  });
  // ESM 需要显式扩展名：相对导入补 .mjs（bare import 如 'fflate' 不动）
  const fixed = outputText.replace(
    /(from\s+')(\.[^']*)(')/g,
    (_, a, spec, b) => `${a}${spec.endsWith('.mjs') ? spec : spec + '.mjs'}${b}`
  );
  fs.writeFileSync(path.join(outDir, name.replace(/\.ts$/, '.mjs')), fixed, 'utf8');
}

for (const name of [
  'protocolSchemes.ts',
  'filePreview.ts',
  'archiveZip.ts',
  'archiveTar.ts',
  'pptxOutline.ts',
  'mediaKinds.ts'
]) {
  compile(name);
}

const {
  previewKindForPath,
  isTextPreviewKind,
  isParsePreviewKind,
  fileIconKindForPath,
  buildExternalFileUrl,
  parseExternalFileUrl,
  DOC_PREVIEW_CAP
} = await import(pathToFileURL(path.join(outDir, 'filePreview.mjs')).href);
const { listZipEntries, readZipEntry } = await import(
  pathToFileURL(path.join(outDir, 'archiveZip.mjs')).href
);
const { listTarEntries, listGzipEntries } = await import(
  pathToFileURL(path.join(outDir, 'archiveTar.mjs')).href
);
const { pptxOutline } = await import(pathToFileURL(path.join(outDir, 'pptxOutline.mjs')).href);
const { mimeForPath } = await import(pathToFileURL(path.join(outDir, 'mediaKinds.mjs')).href);

let passed = 0;
function ok(desc, fn) {
  fn();
  passed++;
  console.log(`PASS  ${desc}`);
}

/* ---------- 1. 预览分类矩阵 ---------- */
ok('分类：文本族', () => {
  for (const p of ['a.ts', 'b.js', 'c.py', 'd.css', 'e.json', 'f', 'g.log', 'h.txt', 'noext', 'README']) {
    assert.equal(previewKindForPath(p), 'text', p);
  }
  assert.equal(previewKindForPath('a.md'), 'markdown');
  assert.equal(previewKindForPath('a.mdxx'), 'text');
  assert.equal(previewKindForPath('sub/dir/a.html'), 'html');
});

ok('分类：媒体族（既有扩展名不变）', () => {
  for (const p of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.svg', 'a.ico', 'a.avif']) {
    assert.equal(previewKindForPath(p), 'image', p);
  }
  for (const p of ['a.mp3', 'a.wav', 'a.ogg', 'a.m4a', 'a.aac', 'a.flac', 'a.opus']) {
    assert.equal(previewKindForPath(p), 'audio', p);
  }
  for (const p of ['a.mp4', 'a.webm', 'a.mov', 'a.mkv', 'a.m4v', 'a.ogv']) {
    assert.equal(previewKindForPath(p), 'video', p);
  }
  assert.equal(previewKindForPath('a.pdf'), 'pdf');
});

ok('分类：Office / 归档 / 不支持', () => {
  assert.equal(previewKindForPath('报告.docx'), 'word');
  assert.equal(previewKindForPath('数据.xlsx'), 'sheet');
  assert.equal(previewKindForPath('老表.xls'), 'sheet');
  assert.equal(previewKindForPath('表.csv'), 'sheet');
  assert.equal(previewKindForPath('deck.pptx'), 'slides');
  assert.equal(previewKindForPath('包.zip'), 'archive');
  assert.equal(previewKindForPath('备份.tar'), 'archive');
  assert.equal(previewKindForPath('日志.gz'), 'archive');
  assert.equal(previewKindForPath('打包.tgz'), 'archive');
  assert.equal(previewKindForPath('setup.exe'), 'unsupported');
  assert.equal(previewKindForPath('old.doc'), 'unsupported');
  assert.equal(previewKindForPath('old.ppt'), 'unsupported');
  assert.equal(previewKindForPath('lib.so'), 'unsupported');
  assert.equal(previewKindForPath('font.woff2'), 'unsupported');
});

ok('族判定辅助', () => {
  assert.ok(isTextPreviewKind('text') && isTextPreviewKind('markdown') && isTextPreviewKind('html'));
  assert.ok(!isTextPreviewKind('image') && !isTextPreviewKind('word'));
  assert.ok(isParsePreviewKind('word') && isParsePreviewKind('archive'));
  assert.ok(!isParsePreviewKind('pdf'));
  assert.ok(DOC_PREVIEW_CAP.sheet < DOC_PREVIEW_CAP.archive);
});

ok('图标分类：比预览分类更细（code/config/text/font）', () => {
  assert.equal(fileIconKindForPath('a.tsx'), 'code');
  assert.equal(fileIconKindForPath('a.html'), 'code');
  assert.equal(fileIconKindForPath('a.yml'), 'config');
  assert.equal(fileIconKindForPath('a.json'), 'config');
  assert.equal(fileIconKindForPath('a.log'), 'text');
  assert.equal(fileIconKindForPath('a.md'), 'markdown');
  assert.equal(fileIconKindForPath('a.png'), 'image');
  assert.equal(fileIconKindForPath('a.mp4'), 'video');
  assert.equal(fileIconKindForPath('a.docx'), 'word');
  assert.equal(fileIconKindForPath('a.xlsx'), 'sheet');
  assert.equal(fileIconKindForPath('a.pptx'), 'slides');
  assert.equal(fileIconKindForPath('a.pdf'), 'pdf');
  assert.equal(fileIconKindForPath('a.zip'), 'archive');
  assert.equal(fileIconKindForPath('a.ttf'), 'font');
  assert.equal(fileIconKindForPath('a.weirdext'), 'file');
  assert.equal(fileIconKindForPath('a.exe'), 'file');
  assert.equal(fileIconKindForPath('noext'), 'file');
});

/* ---------- 2. 外部文件 URL ---------- */
ok('muster-ext URL 构造/解析往返', () => {
  for (const abs of [
    'E:\\Projects\\我的 文件\\报告 v2.docx',
    'C:\\Program Files\\App\\data.bin',
    '/home/user/file with space.png',
    '\\\\server\\share\\folder\\x.pdf'
  ]) {
    const parsed = parseExternalFileUrl(buildExternalFileUrl(abs));
    assert.ok(parsed, abs);
    assert.equal(parsed.absPath, abs.replace(/\\/g, '/'), abs);
  }
  assert.equal(parseExternalFileUrl('muster-ws://ws/a.png'), null);
  assert.equal(parseExternalFileUrl('metaagent-ext://f/E%3A%2Flegacy.png'), null);
  assert.equal(parseExternalFileUrl('http://f/x'), null);
});

/* ---------- 3. ZIP 解析（fflate 构造 → 自研解析） ---------- */
ok('zip：列目录 + 读条目往返', () => {
  const content = 'MetaAgent zip preview ✓ 你好'.repeat(50);
  const contentBytes = strToU8(content).length;
  const zipped = zipSync({
    'hello.txt': strToU8(content),
    'docs/readme.md': strToU8('# hi'),
    'data/bin.dat': new Uint8Array([0, 1, 2, 0, 0, 255])
  });
  const entries = listZipEntries(zipped);
  assert.equal(entries.length, 3);
  const hello = entries.find((e) => e.name === 'hello.txt');
  assert.ok(hello);
  assert.equal(hello.size, contentBytes);
  assert.equal(new TextDecoder().decode(readZipEntry(zipped, hello, inflateSync)), content);
  const bin = entries.find((e) => e.name === 'data/bin.dat');
  assert.deepEqual([...readZipEntry(zipped, bin, inflateSync)], [0, 1, 2, 0, 0, 255]);
});

ok('zip：坏包报错（可转错误卡片）', () => {
  assert.throws(() => listZipEntries(new Uint8Array([1, 2, 3])));
  assert.throws(() => readZipEntry(new Uint8Array([1, 2, 3]), {
    name: 'x', size: 1, method: 8, isDir: false, lastModified: '', localHeaderOffset: 0, compressedSize: 1
  }, inflateSync));
});

/* ---------- 4. TAR 解析（手工构造 ustar） ---------- */
function tarHeader(name, size, type = '0') {
  const buf = new Uint8Array(512);
  const enc = new TextEncoder();
  buf.set(enc.encode(name).subarray(0, 100), 0);
  buf.set(enc.encode('0000644'), 100);
  buf.set(enc.encode('0000000'), 108);
  buf.set(enc.encode('0000000'), 116);
  buf.set(enc.encode(size.toString(8).padStart(11, '0')), 124);
  buf.set(enc.encode(Math.floor(1700000000).toString(8).padStart(11, '0')), 136);
  buf.set(enc.encode(type), 156);
  buf.set(enc.encode('ustar'), 257);
  buf.set(enc.encode('00'), 263);
  // checksum：头 512 字节全 0 后计算
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[i];
  buf.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
  return buf;
}

function pad512(bytes) {
  const blocks = Math.ceil(bytes.length / 512) || 1;
  const out = new Uint8Array(blocks * 512);
  out.set(bytes);
  return out;
}

ok('tar：文件+目录条目', () => {
  const body = strToU8('tar body');
  const parts = [
    tarHeader('a.txt', body.length),
    pad512(body),
    tarHeader('sub/', 0, '5'),
    new Uint8Array(1024) // 结束零块
  ];
  const total = parts.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    tar.set(p, at);
    at += p.length;
  }
  const entries = listTarEntries(tar);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].name, 'a.txt');
  assert.equal(entries[0].size, body.length);
  assert.ok(!entries[0].isDir);
  assert.equal(entries[1].name, 'sub');
  assert.ok(entries[1].isDir);
});

ok('tar：GNU 长名（type L）', () => {
  const longName = 'deep/'.repeat(20) + 'final-file-with-a-very-long-name.txt';
  const nameBytes = strToU8(longName + '\0');
  const parts = [
    tarHeader('././@LongLink', nameBytes.length, 'L'),
    pad512(nameBytes),
    tarHeader('short.txt', 0),
    new Uint8Array(1024)
  ];
  const tar = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) {
    tar.set(p, at);
    at += p.length;
  }
  const entries = listTarEntries(tar);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, longName);
});

ok('tar.gz：gunzip 后列清单（DecompressionStream）', async () => {
  const body = strToU8('gz body');
  const parts = [tarHeader('inner.txt', body.length), pad512(body)];
  const tar = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const p of parts) {
    tar.set(p, at);
    at += p.length;
  }
  const gz = new Uint8Array(zlib.gzipSync(tar));
  const entries = await listGzipEntries(gz, 'inner.txt.gz');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'inner.txt');
});

ok('gz：非 tar 内容按单文件条目', async () => {
  const gz = new Uint8Array(zlib.gzipSync(strToU8('plain content')));
  const entries = await listGzipEntries(gz, 'notes.txt.gz');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'notes.txt');
  assert.equal(entries[0].size, 'plain content'.length);
});

/* ---------- 5. PPTX 大纲 ---------- */
ok('pptx：大纲提取（slideN.xml → 文本段）', () => {
  const slideXml = (texts) =>
    `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>${texts
      .map((s) => `<a:p><a:r><a:t>${s}</a:t></a:r></a:p>`)
      .join('')}</p:spTree></p:cSld></p:sld>`;
  const zipped = zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'ppt/presentation.xml': strToU8('<p/>'),
    'ppt/slides/slide2.xml': strToU8(slideXml(['第二页标题', '第二页 &amp; 正文', 'x&lt;y'])),
    'ppt/slides/slide1.xml': strToU8(slideXml(['第一页标题'])),
    'ppt/slides/_rels/slide1.xml.rels': strToU8('<R/>')
  });
  const slides = pptxOutline(zipped, inflateSync);
  assert.equal(slides.length, 2);
  assert.deepEqual(slides.map((s) => s.n), [1, 2]);
  assert.deepEqual(slides[0].texts, ['第一页标题']);
  assert.deepEqual(slides[1].texts, ['第二页标题', '第二页 & 正文', 'x<y']);
});

/* ---------- 6. MIME 表 ---------- */
ok('MIME：新增 office/归档条目', () => {
  assert.match(mimeForPath('a.docx'), /wordprocessingml/);
  assert.match(mimeForPath('a.xlsx'), /spreadsheetml/);
  assert.match(mimeForPath('a.pptx'), /presentationml/);
  assert.match(mimeForPath('a.zip'), /zip/);
  assert.match(mimeForPath('a.gz'), /gzip/);
  assert.match(mimeForPath('a.csv'), /text\/csv/);
});

/* ---------- 7. 解压能力兜底（unzipSync 全量解压仍可用，验证 fflate 通路） ---------- */
ok('fflate：unzipSync 与自研读取结果一致', () => {
  const zipped = zipSync({ 'a.txt': strToU8('roundtrip') });
  const entries = listZipEntries(zipped);
  const mine = new TextDecoder().decode(readZipEntry(zipped, entries[0], inflateSync));
  const ref = new TextDecoder().decode(unzipSync(zipped)['a.txt']);
  assert.equal(mine, ref);
});

console.log(`\nfile-preview: ${passed} 组断言全部通过`);
