import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
import { zipSync, strToU8 } from 'fflate';
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(root, '.tmp-attachment-pages-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { prepareAttachments, attachmentDir, clearAttachments } = await import(pathToFileURL(compile('main/attachments/service.ts')));
  const { convertAttachment } = await import(pathToFileURL(compile('main/attachments/convert.ts')));
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let p = 1; p <= 3; p++) {
    const stream = `BT /F1 12 Tf 10 50 Td (Page ${p} specific content) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const file = { name: 'slides.pdf', data: Buffer.from(pdf).toString('base64'), mimeType: 'application/pdf' };
  const workerFile = process.env.ATTACHMENT_WORKER_TEST === '1' ? path.join(root, 'out/main/attachments/worker.mjs') : undefined;
  const opts = { userData: tmp, scope: 'gui:pages', workerFile, text: 'Review', model: { id: 'vision', multimodal: true }, processing: { autoPages: 1 }, attachments: [file] };
  const first = await prepareAttachments(opts);
  assert.equal(first.images.length, 1);
  assert.equal(Buffer.from(first.images[0].data, 'base64')[0], 0xff, 'real JPEG image');
  const metadata = JSON.parse(first.text.split('\n')[3]);
  assert.deepEqual(metadata.conversion.pages, [1]); assert.equal(metadata.conversion.totalPages, 3);
  assert.equal(metadata.conversion.partial, true); assert.equal(metadata.conversion.nextPage, 2);
  assert.equal(metadata.more, 'attachments.convert');
  assert.equal(metadata.continuation, undefined);
  const next = await convertAttachment(tmp, opts.scope, { sourcePath: metadata.sourcePath, mode: 'images', startPage: 2, count: 1 });
  assert.deepEqual(next.pages, [2]); assert.equal(next.nextPage, 3); assert.ok(fs.existsSync(next.images[0].path));
  const text = await convertAttachment(tmp, opts.scope, { sourcePath: metadata.sourcePath, mode: 'text', startPage: 3, count: 1 });
  assert.match(text.text, /Page 3 specific/); assert.doesNotMatch(text.text, /Page 1 specific/);
  const slice = await convertAttachment(tmp, opts.scope, { sourcePath: metadata.sourcePath, mode: 'text', startPage: 1, count: 1, maxChars: 10 });
  assert.equal(slice.nextPage, 1); assert.equal(slice.nextOffset, 10);
  const remainder = await convertAttachment(tmp, opts.scope, { sourcePath: metadata.sourcePath, mode: 'text', startPage: 1, count: 1, offset: slice.nextOffset });
  assert.equal(slice.text + remainder.text, '[Page 1]\nPage 1 specific content\n');
  await assert.rejects(() => convertAttachment(tmp, opts.scope, { sourcePath: path.join(root, 'package.json'), mode: 'text' }), /当前会话/);
  const large = await prepareAttachments({ ...opts, processing: { autoPages: 4, autoConvertMB: 1 },
    attachments: [{ ...file, data: Buffer.concat([Buffer.from(pdf), Buffer.alloc(1100000, 32)]).toString('base64') }] });
  assert.equal(large.images.length, 1); assert.match(large.text, /largeFilePreview":true/);
  const ppt = zipSync({ 'ppt/slides/slide1.xml': strToU8('<a:p><a:t>slide text fallback</a:t></a:p>'),
    'ppt/slides/slide2.xml': strToU8('<a:p><a:t>first visible slide</a:t></a:p>'),
    'ppt/presentation.xml': strToU8('<p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst>'),
    'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>') });
  const fallback = await prepareAttachments({ ...opts, tools: { libreOfficePath: 'missing-soffice-test' },
    attachments: [{ name: 'slides.pptx', data: Buffer.from(ppt).toString('base64'), mimeType: 'application/octet-stream' }] });
  assert.match(fallback.text, /page rendering failed/); assert.match(fallback.text, /PPTX slide text/); assert.match(fallback.text, /missing-soffice-test/); assert.match(fallback.text, /first visible slide/);
  const pptSource = JSON.parse(fallback.text.split('\n')[3]).sourcePath;
  const pptPage = await convertAttachment(tmp, opts.scope, { sourcePath: pptSource, mode: 'text', startPage: 1, count: 1 });
  assert.match(pptPage.text, /first visible slide/); assert.doesNotMatch(pptPage.text, /slide text fallback/);
  clearAttachments(tmp, opts.scope); assert.equal(fs.existsSync(next.images[0].path), false);
  assert.equal(fs.existsSync(attachmentDir(tmp, opts.scope)), false);
  console.log('attachment pages: real PDF rendering, bounded previews, continuation, text ranges, PPT fallback, isolation and cleanup passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
