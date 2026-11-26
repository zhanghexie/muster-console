import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import * as XLSX from 'xlsx';
import { createSharedCompiler } from './helpers/shared-compile.mjs';
const root = process.cwd();
const tmp = fs.mkdtempSync(path.join(root, '.tmp-attachments-'));
try {
  const compile = createSharedCompiler(root, tmp);
  const { prepareAttachments, clearAttachments, attachmentDir, extractText, forkAttachments } = await import(pathToFileURL(compile('main/attachments/service.ts')));
  const { expandAttachmentPayload, installAttachmentPayload } = await import(pathToFileURL(compile('main/attachments/piExtension.ts')));
  const { normalizeAttachmentPolicy, nativeAttachmentKind } = await import(pathToFileURL(compile('shared/attachmentPolicy.ts')));
  assert.equal(nativeAttachmentKind('video/mp4', 'openai-completions', { nativeVideo: true }), undefined);
  assert.equal(nativeAttachmentKind('video/mp4', 'openai-completions', { nativeVideo: true, videoTransport: 'data-url' }), 'video');
  const { clipboardFilePaths } = await import(pathToFileURL(compile('main/attachments/clipboard.ts')));
  assert.deepEqual(clipboardFilePaths(['FileNameW'], () => Buffer.from('C:\\Temp\\a.txt\0C:\\Temp\\b.pdf\0\0', 'utf16le')), ['C:\\Temp\\a.txt', 'C:\\Temp\\b.pdf']);
  assert.throws(() => clipboardFilePaths(['FileNameW'], () => Buffer.from(Array.from({ length: 33 }, (_, i) => `C:\\${i}.txt`).join('\0') + '\0\0', 'utf16le')), /最多发送 32 个附件/);
  const drop = Buffer.alloc(20); drop.writeUInt32LE(20); drop.writeUInt32LE(1, 16);
  assert.deepEqual(clipboardFilePaths(['CF_HDROP'], () => Buffer.concat([drop, Buffer.from('C:\\a.txt\0\0', 'utf16le')])), ['C:\\a.txt']);
  const sampleUri = pathToFileURL(path.join(tmp, 'file with space.png')).href;
  for (const format of ['text/uri-list', 'x-special/gnome-copied-files', 'public.file-url'])
    assert.deepEqual(clipboardFilePaths([format], () => Buffer.from(`copy\n${sampleUri}\n`)), [fileURLToPath(sampleUri)]);
  const plist = '<?xml version="1.0"?><plist version="1.0"><array><string>/Users/test/A &amp; B.png</string><string>/Users/test/C.txt</string></array></plist>';
  assert.deepEqual(clipboardFilePaths(['NSFilenamesPboardType'], () => Buffer.from(plist)), ['/Users/test/A & B.png', '/Users/test/C.txt']);
  assert.throws(() => clipboardFilePaths(['NSFilenamesPboardType'], () => Buffer.from('bplist00invalid')), /拖入或选择文件/);
  assert.deepEqual(normalizeAttachmentPolicy({ nativeAudio: true, maxFileMB: 999, videoFrames: 0, mimeTypes: ['audio/*', '../secret'] }),
    { nativeAudio: true, mimeTypes: ['audio/*'] });
  const opts = { userData: tmp, scope: 'gui:test', text: 'Analyze', model: { id: 'text-only', multimodal: false } };
  const file = (name, data, mimeType = 'application/octet-stream') => ({ id: name, name, mimeType, data: Buffer.from(data).toString('base64') });
  const { applyLocaleSetting } = await import(pathToFileURL(compile('shared/i18n/index.ts')));
  applyLocaleSetting('en');
  try {
    await assert.rejects(() => prepareAttachments({ ...opts, attachments: Array.from({ length: 33 }, () => file('x.txt', 'x')) }), /Send up to 32 attachments/);
    await assert.rejects(() => prepareAttachments({ ...opts, processing: { maxFileMB: 1 }, attachments: [file('大文件.txt', Buffer.alloc(1100000))] }), /大文件.txt: Attachment is too large/);
    await assert.rejects(() => prepareAttachments({ ...opts, api: 'openai-completions', model: { id: 'vision', multimodal: true, attachments: { nativeAudio: true, allowMixedMedia: false } }, attachments: [file('a.png', 'image', 'image/png'), file('a.wav', 'audio', 'audio/wav')] }), /Mixed media is disabled/);
  } finally { applyLocaleSetting('zh-CN'); }
  const result = await prepareAttachments({ ...opts, attachments: [file('hello.txt', '你好，世界')] });
  assert.match(result.text, /你好，世界/); assert.match(result.text, /utf-8 text decoding/);
  assert.equal(result.images, undefined);
  const source = JSON.parse(result.text.split('\n')[3]).sourcePath;
  assert.equal(fs.readFileSync(source, 'utf8'), '你好，世界');
  const original = path.join(tmp, 'temp-source.txt'); fs.writeFileSync(original, 'keep me');
  const copied = await prepareAttachments({ ...opts, attachments: [{ name: 'temp-source.txt', sourcePath: original, data: '', mimeType: 'text/plain' }] });
  fs.unlinkSync(original); assert.match(copied.text, /keep me/);
  assert.match((await prepareAttachments({ ...opts, attachments: [file('asset.bin', Buffer.from([0, 1, 2]))] })).text, /path-only/);
  const doc = zipSync({ 'word/document.xml': strToU8('<w:p><w:t>Office &amp; 中文</w:t></w:p>') });
  assert.match((await extractText(Buffer.from(doc), 'a.docx', '', 40000)).text, /Office & 中文/);
  // Build a real tiny PDF with an embedded text stream and a correct xref table.
  const stream = 'BT /F1 12 Tf 10 50 Td (PDF local text) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  assert.match((await extractText(Buffer.from(pdf), 'test.pdf', 'application/pdf', 40000)).text, /PDF local text/);
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['名字', '值'], ['a', 42]]), 'Sheet1');
  assert.match((await extractText(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'a.xlsx', '', 40000)).text, /a,42/);
  assert.match((await prepareAttachments({ ...opts, processing: { maxTextChars: 1000 }, attachments: [file('long.txt', 'x'.repeat(1100))] })).text, /truncated to 1000/);
  assert.match((await prepareAttachments({ ...opts, attachments: [file('a.png', 'image', 'image/png')] })).text, /path-only/);
  assert.equal((await prepareAttachments({ ...opts, model: { id: 'vision', multimodal: true }, attachments: [file('a.png', 'image', 'image/png')] })).images.length, 1);
  const photo = await prepareAttachments({ ...opts, model: { id: 'vision', multimodal: true }, attachments: [file('image.png', 'image', 'image/png')] });
  const meta = JSON.parse(photo.text.split('\n')[3]);
  assert.deepEqual(Object.keys(meta), ['name', 'sourcePath', 'processing']);
  assert.match(path.basename(meta.sourcePath), /^[a-f0-9]{12}-image\.png$/);
  assert.equal(path.basename(path.dirname(meta.sourcePath)).length, 20);
  const secondPhoto = await prepareAttachments({ ...opts, model: { id: 'vision', multimodal: true }, attachments: [file('image.png', 'second', 'image/png')] });
  assert.notEqual(JSON.parse(secondPhoto.text.split('\n')[3]).sourcePath, meta.sourcePath);
  assert.equal(fs.readFileSync(meta.sourcePath, 'utf8'), 'image');
  const legacyScope = 'gui:legacy';
  const legacyDir = path.join(tmp, 'conversation-attachments', createHash('sha256').update(legacyScope).digest('hex'));
  fs.mkdirSync(legacyDir, { recursive: true });
  const legacyId = 'a'.repeat(64), legacySource = path.join(legacyDir, `${legacyId}-old.wav`);
  fs.writeFileSync(legacySource, 'old audio');
  fs.writeFileSync(path.join(legacyDir, `${legacyId}.json`), JSON.stringify({ path: legacySource, name: 'old.wav', mimeType: 'audio/wav', kind: 'audio' }));
  assert.equal(attachmentDir(tmp, legacyScope), legacyDir);
  const legacyPayload = { messages: [{ role: 'user', content: `[muster-attachment:${legacyId}]` }] };
  const legacyExpanded = await expandAttachmentPayload(legacyPayload, 'openai-completions', attachmentDir(tmp, legacyScope));
  assert.equal(legacyExpanded.messages[0].content[1].input_audio.data, Buffer.from('old audio').toString('base64'));
  const legacyRemap = forkAttachments(tmp, legacyScope, 'gui:legacy-fork');
  assert.ok(fs.existsSync(legacyRemap(legacySource)));
  clearAttachments(tmp, legacyScope); assert.equal(fs.existsSync(legacyDir), false);
  await assert.rejects(() => prepareAttachments({ ...opts, api: 'openai-completions', model: { id: 'vision', multimodal: true, attachments: { nativeAudio: true, allowMixedMedia: false } },
    attachments: [file('a.png', 'image', 'image/png'), file('a.wav', 'audio', 'audio/wav')] }), /禁止混合媒体/);
  for (const [api, name, mime, flag, expected] of [
    ['openai-completions', 'a.wav', 'audio/wav', 'nativeAudio', 'input_audio'],
    ['openai-responses', 'a.pdf', 'application/pdf', 'nativeFiles', 'input_file'],
    ['anthropic-messages', 'a.pdf', 'application/pdf', 'nativeFiles', 'document'],
    ['google-generative-ai', 'a.mp4', 'video/mp4', 'nativeVideo', undefined]
  ]) {
    const prepared = await prepareAttachments({ ...opts, api, model: { id: 'native', attachments: { [flag]: true } }, attachments: [file(name, 'original bytes', mime)] });
    assert.match(prepared.text, /muster-attachment:/);
    const key = api === 'google-generative-ai' ? 'contents' : api.includes('responses') ? 'input' : 'messages';
    const content = api === 'google-generative-ai' ? 'parts' : 'content';
    const request = { [key]: [{ role: 'user', [content]: [{ type: 'text', text: prepared.text }] }], config: { callback() {} } };
    const expanded = await expandAttachmentPayload(request, api, attachmentDir(tmp, opts.scope));
    assert.equal(expanded.config, request.config); assert.equal(expanded[key][0][content][1].type, expected);
    assert.match(request[key][0][content][0].text, /muster-attachment:/);
    assert.doesNotMatch(expanded[key][0][content][0].text, /muster-attachment:/);
    await assert.rejects(() => expandAttachmentPayload(request, api, attachmentDir(tmp, 'gui:other')));
  }
  if (process.env.ATTACHMENT_FFMPEG_TEST === '1') {
    const video = path.join(tmp, 'sample.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x80:r=30:d=3.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-y', video], { windowsHide: true });
    const videoOptions = { ...opts, model: { id: 'vision', multimodal: true }, attachments: [{ sourcePath: video, name: 'sample.mp4', mimeType: 'video/mp4', data: '' }] };
    const decoded = await prepareAttachments({ ...videoOptions, processing: { videoIntervalSeconds: 1, videoFrames: 2 } });
    assert.equal(decoded.images.length, 2); assert.match(decoded.text, /audio omitted/);
    const short = await prepareAttachments(videoOptions);
    for (const ext of ['mkv', 'avi', 'm4v']) {
      const clipboardVideo = path.join(tmp, `clipboard.${ext}`);
      fs.copyFileSync(video, clipboardVideo);
      const sampled = await prepareAttachments({ ...videoOptions, attachments: [{ sourcePath: clipboardVideo, name: `clipboard.${ext}`, mimeType: 'application/octet-stream', data: '' }] });
      assert.equal(sampled.images?.length, 1, `${ext} clipboard path triggers automatic video sampling`);
      assert.match(sampled.text, /audio omitted/);
    }
    assert.equal(short.images.length, 1, '3.3s video yields a frame with default 10s interval');
    const videoSource = JSON.parse(short.text.split('\n')[3]).sourcePath;
    const { convertAttachment } = await import(pathToFileURL(compile('main/attachments/convert.ts')));
    const continued = await convertAttachment(tmp, opts.scope, { sourcePath: videoSource, mode: 'video', count: 8 });
    assert.equal(continued.images.length, 1, 'on-demand uses the same full-range and short-clip handling');
    for (const image of [Buffer.from(short.images[0].data, 'base64'), fs.readFileSync(continued.images[0].path)]) {
      assert.equal(image.readUInt16BE(0), 0xffd8, 'valid JPEG header');
      assert.ok(image.length > 100);
    }
  }
  const failed = await prepareAttachments({ ...opts, model: { id: 'vision', multimodal: true }, tools: { ffmpegPath: 'missing-ffmpeg-test' }, attachments: [file('bad.mp4', 'not a video', 'video/mp4')] });
  assert.match(failed.text, /local conversion failed/);
  const remap = forkAttachments(tmp, opts.scope, 'gui:fork');
  assert.ok(remap(source).startsWith(attachmentDir(tmp, 'gui:fork')));
  const native = await prepareAttachments({ ...opts, api: 'openai-completions', model: { id: 'native', attachments: { nativeAudio: true } }, attachments: [file('late.wav', 'audio', 'audio/wav')] });
  const session = { agent: { onPayload: async payload => ({ ...payload, previousHook: true }) } };
  installAttachmentPayload(session, tmp, opts.scope);
  const request = { messages: [{ role: 'user', content: native.text }] };
  const response = await session.agent.onPayload(request, { api: 'openai-completions' });
  assert.equal(response.previousHook, true); assert.equal(response.messages[0].content[1].type, 'input_audio');
  clearAttachments(tmp, opts.scope); assert.equal(fs.existsSync(attachmentDir(tmp, opts.scope)), false);
  assert.equal(fs.readFileSync(remap(source), 'utf8'), '你好，世界', 'fork owns source bytes independently');
  await assert.rejects(() => session.agent.onPayload(request, { api: 'openai-completions' }), /ENOENT/, 'missing native input must fail the request, not silently drop it');
  // F-01（multimodal-input）：单个坏 manifest 只跳过该文件，fork 不整体失败
  const badScope = 'gui:badmanifest';
  const badDir = attachmentDir(tmp, badScope);
  fs.mkdirSync(badDir, { recursive: true });
  const goodId = 'b'.repeat(12), brokenId = 'c'.repeat(12);
  fs.writeFileSync(path.join(badDir, `${goodId}-good.wav`), 'good audio');
  fs.writeFileSync(path.join(badDir, `${goodId}.json`), JSON.stringify({ path: path.join(badDir, `${goodId}-good.wav`), name: 'good.wav', mimeType: 'audio/wav', kind: 'audio' }));
  fs.writeFileSync(path.join(badDir, `${brokenId}.json`), '{corrupt'); // 原实现：整个 fork 抛 SyntaxError
  const badRemap = forkAttachments(tmp, badScope, 'gui:badmanifest-fork');
  const badForkDir = attachmentDir(tmp, 'gui:badmanifest-fork');
  assert.equal(fs.readFileSync(path.join(badForkDir, `${goodId}.json`), 'utf8'),
    JSON.stringify({ path: path.join(badForkDir, `${goodId}-good.wav`), name: 'good.wav', mimeType: 'audio/wav', kind: 'audio' }), '好 manifest 重写指向新目录');
  assert.equal(fs.readFileSync(path.join(badForkDir, `${brokenId}.json`), 'utf8'), '{corrupt', '坏 manifest 保留原样（跳过不失败）');
  assert.ok(badRemap(path.join(badDir, 'x.txt')).includes(badForkDir), 'remap 正常返回');
  // F-02：stat 失败与超限拆成两条可区分文案
  await assert.rejects(() => prepareAttachments({ ...opts, attachments: [{ name: 'gone.txt', sourcePath: path.join(tmp, 'no-such-file.txt'), data: '', mimeType: 'text/plain' }] }), /源文件不存在或不可访问/);
  const bigFile = path.join(tmp, 'big.bin'); fs.writeFileSync(bigFile, Buffer.alloc(2 * 1024 * 1024));
  await assert.rejects(() => prepareAttachments({ ...opts, processing: { maxFileMB: 1 }, attachments: [{ name: 'big.bin', sourcePath: bigFile, data: '', mimeType: 'application/octet-stream' }] }), /文件超过/);
  // F-03：会话清空后续读 convert → 语义化报错而非裸 ENOENT
  const { convertAttachment: convertForError } = await import(pathToFileURL(compile('main/attachments/convert.ts')));
  await assert.rejects(() => convertForError(tmp, 'gui:cleared-session', { sourcePath: 'x.txt', mode: 'text' }), /会话已清空，附件不可用/);
  console.log('attachments: routing, Office extraction, source retention, limits, native payloads, isolation and cleanup passed');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
