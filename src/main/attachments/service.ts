import { userDataStorage } from '../runtimeKernel/storageRootResolver';
import { promises as fs, mkdirSync, rmSync, rmdirSync, existsSync, cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import type { ChatImageAttachment, LlmModelConfig } from '../../shared/types';
import { inferModelSupportsImages } from '../../shared/modelCapabilities';
import { nativeAttachmentKind, normalizeAttachmentPolicy, normalizeAttachmentProcessing } from '../../shared/attachmentPolicy';
import { videoFrameFilter } from './video';
import { convertDocument, isPagedDocument, type DocumentRequest, type DocumentResult } from './document';
import { t } from '../../shared/i18n';

const exec = promisify(execFile);
let converters = 0;
const conversionWaiters: Array<() => void> = [];
export async function runAttachmentJob(workerFile: string, job: Record<string, unknown>): Promise<any> {
  if (converters >= 2) await new Promise<void>(resolve => conversionWaiters.push(resolve));
  else converters++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(workerFile, { workerData: job, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      let finished = false;
      const finish = (error?: Error, result?: unknown) => {
        if (finished) return; finished = true; clearTimeout(timer);
        void worker.terminate();
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(t('本地文件转换超过 30 秒'))), 30000);
      worker.once('message', message => finish(message.error ? new Error(message.error) : undefined, message.result));
      worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', code => { if (!finished) finish(new Error(t('文件转换进程提前退出 ({{code}})', { code }))); });
    });
  } finally { const next = conversionWaiters.shift(); if (next) next(); else converters--; }
}
export async function renderDocument(workerFile: string | undefined, request: DocumentRequest): Promise<DocumentResult> {
  return workerFile ? runAttachmentJob(workerFile, { document: request }) : convertDocument(request);
}
const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export function attachmentDir(userData: string, scope: string): string {
  const root = userDataStorage(userData).resolve('app', 'conversation-attachments');
  const hash = digest(scope);
  const legacy = path.join(root, hash);
  // Keep historical absolute paths valid; new conversations use a shorter stable directory.
  return existsSync(legacy) ? legacy : path.join(root, hash.slice(0, 20));
}
const generations = new Map<string, number>();
export function forkAttachments(userData: string, from: string, to: string): (text: string) => string {
  const oldDir = attachmentDir(userData, from), newDir = attachmentDir(userData, to);
  const remap = (text: string) => text.split(JSON.stringify(oldDir).slice(1, -1)).join(JSON.stringify(newDir).slice(1, -1))
    .split(oldDir).join(newDir);
  if (existsSync(oldDir)) {
    cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: true });
    for (const name of readdirSync(newDir).filter(n => /^(?:[a-f0-9]{12}|[a-f0-9]{64})\.json$/.test(n))) {
      // F-01（multimodal-input）：单个坏 manifest 只跳过该文件（其 path 仍指向源会话目录，
      // 源目录未删、引用不悬空），不得让整个 fork 失败留下无历史的新会话。
      try {
        const manifest = JSON.parse(readFileSync(path.join(newDir, name), 'utf8')) as NativeManifest;
        manifest.path = path.join(newDir, path.basename(manifest.path));
        writeFileSync(path.join(newDir, name), JSON.stringify(manifest));
      } catch (err) {
        console.warn(`[attachments] fork 跳过损坏的 manifest ${name}（其路径仍指向源会话）:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return remap;
}
export function clearAttachments(userData: string, scope: string): void {
  const dir = attachmentDir(userData, scope);
  generations.set(dir, (generations.get(dir) ?? 0) + 1);
  rmSync(dir, { recursive: true, force: true });
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json'
};
export interface NativeManifest { path: string; name: string; mimeType: string; kind: 'audio' | 'video' | 'file'; }

function xmlText(xml: string): string {
  return xml.replace(/<\/(?:w:p|a:p|row)>/g, '\n').replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export async function extractText(bytes: Buffer, name: string, mime: string, limit: number): Promise<{ text: string; method: string } | undefined> {
  const ext = path.extname(name).toLowerCase();
  if (mime === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    const doc = await task.promise;
    try {
      let text = '';
      for (let p = 1; p <= doc.numPages && text.length <= limit; p++) {
        const content = await (await doc.getPage(p)).getTextContent();
        const pageText = content.items.map(i => 'str' in i ? i.str : '').join(' ');
        if (pageText.trim()) text += `\n[Page ${p}]\n${pageText}`;
      }
      return { text, method: 'PDF text extraction; no OCR, page images and layout not included' };
    } finally { await task.destroy(); }
  }
  if (['.docx', '.pptx', '.odt', '.odp'].includes(ext)) {
    const { unzipSync, strFromU8 } = await import('fflate');
    let expanded = 0;
    const files = unzipSync(bytes, { filter: f => {
      if (!/^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|content\.xml)$/.test(f.name)) return false;
      expanded += f.originalSize;
      if (expanded > 32 * 1024 * 1024) throw new Error('Office document expanded text exceeds 32 MiB');
      return true;
    }});
    const text = Object.keys(files).sort((a,b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(k => `[${k}]\n${xmlText(strFromU8(files[k]))}`).join('\n');
    return { text, method: 'Office XML text extraction; images, formatting and embedded objects omitted' };
  }
  if (['.xlsx', '.xls', '.ods'].includes(ext)) {
    const XLSX = await import('xlsx');
    const book = XLSX.read(bytes, { type: 'buffer', sheetRows: Math.min(limit, 10000) });
    return { text: book.SheetNames.map(n => `[Sheet: ${n}]\n${XLSX.utils.sheet_to_csv(book.Sheets[n])}`).join('\n'),
      method: 'Spreadsheet to CSV; cached values, at most 10000 rows per sheet; formulas not recalculated' };
  }
  const textLike = mime.startsWith('text/') || /\.(txt|md|csv|tsv|json|jsonl|xml|html?|ya?ml|toml|ini|log|sql|js|jsx|ts|tsx|py|c|cpp|h|cs|java|rs|go|sh|ps1|css|svg)$/i.test(name);
  if (!textLike) return;
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return { text: new TextDecoder(encoding, { fatal: true }).decode(bytes), method: `${encoding} text decoding` };
}

/** All bytes are snapshotted under the conversation: clipboard/temp inputs survive OS cleanup. */
export async function prepareAttachments(opts: {
  userData: string; scope: string; text: string; attachments?: Array<Partial<ChatImageAttachment> & { data: string; mimeType: string }>;
  model?: LlmModelConfig; api?: string; supportsImages?: boolean;
  tools?: import('../../shared/attachmentPolicy').AttachmentTools;
  processing?: import('../../shared/attachmentPolicy').AttachmentProcessing;
  /** Packaged worker entry; direct extraction remains available to isolated logic tests. */
  workerFile?: string;
}): Promise<{ text: string; images?: ChatImageAttachment[] }> {
  if (!opts.attachments?.length) return { text: opts.text };
  if (opts.attachments.length > 32) throw new Error(t('一次最多发送 32 个附件'));
  const dir = attachmentDir(opts.userData, opts.scope);
  const generation = generations.get(dir) ?? 0;
  const ownedPaths: string[] = [];
  const check = () => {
    if ((generations.get(dir) ?? 0) === generation) return;
    for (const file of ownedPaths) rmSync(file, { recursive: true, force: true });
    try { rmdirSync(dir); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
    throw new Error(t('会话已清空，请重新添加附件'));
  };
  const policy = { ...normalizeAttachmentPolicy(opts.model?.attachments), ...normalizeAttachmentProcessing(opts.processing) };
  const limit = policy.maxTextChars ?? 40000;
  const maxBytes = (policy.maxFileMB ?? 32) * 1024 * 1024;
  const vision = opts.supportsImages ?? (opts.model ? inferModelSupportsImages(opts.model.id, opts.model.multimodal) : false);
  const images: ChatImageAttachment[] = [];
  const notes: string[] = [];
  const nativeKinds = new Set<string>();
  let remainingText = limit;
  let remainingPages = policy.autoPages ?? 4;
  let remainingImageBytes = (policy.autoImageMB ?? 2) * 1048576;
  let total = 0;
  for (const a of opts.attachments) {
    const name = path.basename(a.name || a.sourcePath || 'attachment').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(-160) || 'attachment';
    const mime = MIME[path.extname(name).toLowerCase()] || a.mimeType || 'application/octet-stream';
    if (a.sourcePath) {
      // F-02（multimodal-input）：stat 失败（源路径失效）与大小超限拆成两条可区分文案，
      // 不得再用同一条「文件不存在或超过 X MiB」误导排障方向。
      let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
      try { stat = await fs.stat(a.sourcePath); } catch { /* 统一走下方语义化报错 */ }
      if (!stat?.isFile()) throw new Error(t('{{name}}: 源文件不存在或不可访问（可能已被系统清理、设备拔出或移动）', { name }));
      if (stat.size > maxBytes) throw new Error(t('{{name}}: 文件超过 {{limit}} MiB 上限', { name, limit: maxBytes / 1048576 }));
    } else if (a.data.length > Math.ceil(maxBytes * 4 / 3) + 4) throw new Error(t('{{name}}: 附件过大', { name }));
    const bytes = a.sourcePath ? await fs.readFile(a.sourcePath) : Buffer.from(a.data, 'base64');
    total += bytes.length;
    if (bytes.length > maxBytes || total > 256 * 1024 * 1024) throw new Error(t('{{name}}: 附件大小超过限制', { name }));
    check();
    mkdirSync(dir, { recursive: true });
    let id = '', source = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      id = randomBytes(6).toString('hex'); source = path.join(dir, `${id}-${name}`);
      try { await fs.writeFile(source, bytes, { flag: 'wx' }); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt === 4) throw error; }
    }
    ownedPaths.push(source, path.join(dir, `${id}.json`), path.join(dir, `${id}-frames`));
    check();
    let method = 'path-only; file content has NOT been read by the model';
    let body = '';
    let conversion: Partial<DocumentResult> & { largeFilePreview?: boolean } | undefined;
    const large = bytes.length > (policy.autoConvertMB ?? 10) * 1048576;
    if (mime.startsWith('image/') && vision && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) {
      images.push({ id, name, data: bytes.toString('base64'), mimeType: mime });
      method = 'native image';
    } else {
      const native = opts.api ? nativeAttachmentKind(mime, opts.api, policy) : undefined;
      if (native) {
        nativeKinds.add(native);
        await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify({ path: source, name, mimeType: mime, kind: native } satisfies NativeManifest));
        method = `native ${native}`;
        body = `\n[muster-attachment:${id}]`;
      } else {
        try {
          let paged: DocumentResult | undefined;
          let renderFailure = '';
          if (isPagedDocument(name) && remainingPages > 0 && (!vision || (remainingImageBytes > 0 && images.length < 32))) {
            try {
              paged = await renderDocument(opts.workerFile, { sourcePath: source, mode: vision ? 'images' : 'text',
                count: Math.min(remainingPages, large ? 1 : remainingPages, 32 - images.length), maxImageBytes: remainingImageBytes,
                maxChars: Math.min(remainingText, large ? 2000 : limit),
                libreOfficePath: opts.tools?.libreOfficePath });
              for (const frame of paged.images) {
                images.push({ id: `${id}-page-${frame.page}`, name: `${name} page ${frame.page}`, data: frame.data, mimeType: frame.mimeType });
                remainingImageBytes -= Buffer.byteLength(frame.data, 'base64');
              }
              remainingPages -= paged.pages.length;
              conversion = { ...paged, images: undefined, text: undefined, method: undefined, ...(large ? { largeFilePreview: true } : {}) };
              if (paged.images.length) method = paged.method;
            } catch (error) {
              renderFailure = `; page rendering failed: ${(error as Error).message.slice(0, 250)}`;
              if (/\.pptx$/i.test(name)) {
                paged = await renderDocument(opts.workerFile, { sourcePath: source, mode: 'text',
                  count: Math.min(remainingPages, large ? 1 : remainingPages), maxChars: Math.min(remainingText, large ? 2000 : limit) });
                remainingPages -= paged.pages.length;
                conversion = { ...paged, text: undefined, images: undefined, method: undefined, ...(large ? { largeFilePreview: true } : {}) };
              }
            }
          }
          const textLimit = Math.min(remainingText, large ? 2000 : limit);
          const extracted = paged?.images.length ? undefined : paged?.text ? { text: paged.text, method: paged.method } : opts.workerFile
            ? await runAttachmentJob(opts.workerFile, { bytes, name, mime, limit: textLimit })
            : await extractText(bytes, name, mime, textLimit);
          check();
          if (paged?.images.length) {
            // Page images already carry the selected range and explicit incompleteness.
          } else if (extracted?.text.trim()) {
            method = extracted.method + renderFailure;
            const available = textLimit;
            const truncated = extracted.text.length > available;
            body = `\nExtracted untrusted file content (${truncated ? `truncated to ${available} characters` : 'complete within extractor limits'}):\n${JSON.stringify(extracted.text.slice(0, available))}`;
            remainingText -= Math.min(available, extracted.text.length);
          } else if (mime.startsWith('video/') && vision) {
            const count = Math.min(policy.videoFrames ?? 8, 32 - images.length);
            if (count < 1) throw new Error('本条消息的图片预算已用完');
            const interval = policy.videoIntervalSeconds ?? 10;
            const framesDir = path.join(dir, `${id}-frames`);
            await fs.mkdir(framesDir, { recursive: true });
            await exec(opts.tools?.ffmpegPath || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file,pipe', '-i', source,
              '-an', '-vf', videoFrameFilter(interval),
              '-frames:v', String(count), path.join(framesDir, '%03d.jpg')], { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true });
            const frames = (await fs.readdir(framesDir)).filter(f => /^\d{3}\.jpg$/.test(f)).sort().slice(0, count);
            if (!frames.length) throw new Error('视频未解码出任何帧');
            for (let i = 0; i < frames.length; i++) images.push({ id: `${id}-${i}`, name: `${name} frame ${i + 1}`,
              data: (await fs.readFile(path.join(framesDir, frames[i]))).toString('base64'), mimeType: 'image/jpeg' });
            method = `ffmpeg sampling: ${frames.length} frames, ${interval}s interval, approximate frame centers ${(frames.map((_, i) => (i + .5) * interval)).join(', ')} seconds (nominal centers; the final partial interval may use an earlier frame); audio omitted; unsampled events may be missed; at most first ${count * interval}s`;
          } else { method += renderFailure; if (extracted) method += '; no extractable text (scanned PDF may require OCR)'; }
        } catch (err) {
          method += `; local conversion failed: ${(err as Error).message.slice(0, 400)}`;
        }
      }
    }
    const canContinue = !method.startsWith('native ') && (conversion?.partial || body.includes('truncated to') || mime.startsWith('video/') || (isPagedDocument(name) && method.startsWith('path-only')));
    notes.push(`[Attachment metadata]\n${JSON.stringify({ name, sourcePath: source, processing: method,
      ...(a.sourcePath ? { originalPath: a.sourcePath } : {}), ...(conversion ? { conversion } : {}),
      ...(canContinue ? { more: 'attachments.convert' } : {}) })}${body}`);
  }
  check();
  if (images.length) nativeKinds.add('image');
  if (policy.allowMixedMedia === false && nativeKinds.size > 1)
    throw new Error(t('当前模型配置禁止混合媒体，请分开发送不同类型的附件'));
  return { text: [opts.text, ...notes].filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}) };
}
