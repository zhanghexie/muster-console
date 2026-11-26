const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { zipSync, strToU8 } = require('fflate');
const XLSX = require('xlsx');
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
function makeWav(label) {
  const rate = 8000;
  const seconds = 1;
  const n = rate * seconds;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (label === "A" ? 220 : 660) * i) / rate) * 12000), i * 2);
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
function makeDocx(label) {
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
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>${label} DOCX</w:t></w:r></w:p>
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
function makePptx(label) {
  const slide = (texts) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${texts
      .map(
        (t, i) =>
          `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`
      )
      .join('')}</p:spTree></p:cSld></p:sld>`;
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
      ),
      'ppt/presentation.xml': strToU8('<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'),
      'ppt/slides/slide1.xml': strToU8(slide([label + " PPTX", '第一张幻灯片：全格式改造实测'])),
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
function makeTar(label) {
  const f1 = Buffer.from('tar member one\n');
  const f2 = Buffer.from('tar member two: MetaAgent 归档预览实测\n');
  return Buffer.concat([
    tarHeader(label + "-member-one.txt", f1.length),
    pad512(f1),
    tarHeader('member-two.txt', f2.length),
    pad512(f2),
    tarHeader('subdir/', 0, '5'),
    Buffer.alloc(1024)
  ]);
}


function makePdf(label) {
  const stream = 'BT /F1 20 Tf 40 100 Td (' + label + ' PDF) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream'];
  let content = '%PDF-1.4\n', offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(content)); content += (i+1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const xref = Buffer.byteLength(content);
  content += 'xref\n0 6\n0000000000 65535 f \n' + offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  content += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(content);
}
exports.writePreviewFixtures = (root, label) => {
  fs.mkdirSync(root, { recursive: true });
  const write = (name, bytes) => fs.writeFileSync(path.join(root, name), bytes);
  write('same.txt', label + ' text'); write('same.md', '# ' + label + ' markdown\n\n[relative](same.txt)');
  write('same.html', '<h1>' + label + ' HTML</h1>');
  write('same.png', makePng(64, 64, label === 'A' ? [220, 20, 20] : [20, 20, 220], [255, 255, 255]));
  write('same.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><text>' + label + '</text></svg>');
  write('same.wav', makeWav(label)); write('same.pdf', makePdf(label));
  write('same.docx', makeDocx(label)); write('same.pptx', makePptx(label));
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['来源','值'], [label, '中文']]), label + '-sheet');
  write('same.xlsx', XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  write('same.xls', XLSX.write(book, { type: 'buffer', bookType: 'biff8' }));
  write('same.csv', '来源,值\n' + label + ',中文');
  write('same.zip', zipSync({ [label + '-member.txt']: strToU8('payload') }));
  const tar = makeTar(label); write('same.tar', tar); write('same.tgz', zlib.gzipSync(tar)); write('same.gz', zlib.gzipSync(Buffer.from(label + ' gz')));
  write('same.exe', Buffer.from([77,90,0])); write('same.unknown', Buffer.from([0,1,2,0,3]));
};
