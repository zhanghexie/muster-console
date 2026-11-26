import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface DocumentRequest {
  sourcePath: string; mode: 'images' | 'text'; startPage?: number; count?: number;
  maxChars?: number; maxImageBytes?: number; libreOfficePath?: string; offset?: number;
}
export interface DocumentResult {
  totalPages: number; pages: number[]; nextPage: number | null; partial: boolean;
  text: string; images: Array<{ page: number; data: string; mimeType: string }>;
  method: string; warning?: string; nextOffset?: number;
}
export const isPagedDocument = (name: string) => /\.(pdf|pptx?|odp)$/i.test(name);

/** Runs in the bounded attachment worker in production, with an isolated Office profile. */
export async function convertDocument(request: DocumentRequest): Promise<DocumentResult> {
  if (/\.pptx$/i.test(request.sourcePath) && request.mode === 'text') {
    const { unzipSync, strFromU8 } = await import('fflate');
    let expanded = 0;
    const slides = unzipSync(await fs.readFile(request.sourcePath), { filter: file => {
      if (!/^ppt\/(slides\/slide\d+\.xml|presentation\.xml|_rels\/presentation\.xml\.rels)$/.test(file.name)) return false;
      expanded += file.originalSize;
      if (expanded > 32 * 1048576) throw new Error('PPTX 文字展开超过 32 MiB');
      return true;
    } });
    let names = Object.keys(slides).filter(name => /^ppt\/slides\//.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (slides['ppt/presentation.xml'] && slides['ppt/_rels/presentation.xml.rels']) {
      const rels = new Map<string, string>();
      for (const match of strFromU8(slides['ppt/_rels/presentation.xml.rels']).matchAll(/<Relationship\b[^>]*>/g)) {
        const id = /\bId="([^"]+)"/.exec(match[0])?.[1], target = /\bTarget="([^"]+)"/.exec(match[0])?.[1];
        if (id && target) rels.set(id, path.posix.normalize(target.startsWith('/') ? target.slice(1) : `ppt/${target}`));
      }
      names = [...strFromU8(slides['ppt/presentation.xml']).matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)]
        .map(match => rels.get(match[1]) || '').filter(name => !!slides[name]);
    }
    const start = Math.max(1, Math.floor(request.startPage || 1));
    if (start > names.length) throw new Error('起始页超出 PPTX 幻灯片数量');
    const end = Math.min(names.length, start + Math.max(1, Math.min(16, request.count || 4)) - 1);
    const result: DocumentResult = { totalPages: names.length, pages: [], nextPage: start, partial: true,
      images: [], text: '', method: 'PPTX slide text; images/layout/notes omitted' };
    for (let p = start; p <= end; p++) {
      const offset = p === start ? Math.max(0, request.offset || 0) : 0;
      const raw = strFromU8(slides[names[p - 1]]).replace(/<\/a:p>/g, '\n').replace(/<[^>]*>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const text = `[Slide ${p}]\n${raw}`.slice(offset);
      const left = Math.max(0, (request.maxChars ?? 8000) - result.text.length);
      result.text += text.slice(0, left); result.pages.push(p);
      if (text.length > left) { result.nextPage = p; result.nextOffset = offset + left; return result; }
      result.nextPage = p < names.length ? p + 1 : null;
    }
    result.partial = start !== 1 || result.nextPage !== null;
    return result;
  }
  let pdfPath = request.sourcePath;
  let temp: string | undefined;
  try {
    if (!/\.pdf$/i.test(pdfPath)) {
      temp = await fs.mkdtemp(path.join(path.dirname(pdfPath), 'office-'));
      const profile = pathToFileURL(path.join(temp, 'profile')).href;
      await promisify(execFile)(request.libreOfficePath || 'soffice', [
        `-env:UserInstallation=${profile}`, '--headless', '--nologo', '--nodefault', '--norestore',
        '--convert-to', 'pdf:impress_pdf_Export', '--outdir', temp, pdfPath
      ], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
      pdfPath = path.join(temp, `${path.parse(pdfPath).name}.pdf`);
      if ((await fs.stat(pdfPath)).size > 256 * 1024 * 1024) throw new Error('Office 转换 PDF 超过 256 MiB');
    }
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(pdfPath)), useSystemFonts: true });
    const doc = await task.promise;
    try {
      const start = Math.max(1, Math.floor(request.startPage || 1));
      if (start > doc.numPages) throw new Error(`起始页 ${start} 超出总页数 ${doc.numPages}`);
      const end = Math.min(doc.numPages, start + Math.max(1, Math.min(16, request.count || 4)) - 1);
      const result: DocumentResult = { totalPages: doc.numPages, pages: [], nextPage: start, partial: true,
        text: '', images: [], method: request.mode === 'images' ? 'page images; layout preserved; no OCR' : 'page text; layout/images omitted' };
      let imageBytes = 0;
      const charLimit = Math.max(1, Math.min(200000, request.maxChars ?? 8000));
      for (let number = start; number <= end; number++) {
        const page = await doc.getPage(number);
        if (request.mode === 'images') {
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: Math.min(2, 1400 / Math.max(base.width, base.height)) });
          const { createCanvas } = await import('@napi-rs/canvas');
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({ canvas: canvas as any, canvasContext: canvas.getContext('2d') as any, viewport }).promise;
          const bytes = canvas.toBuffer('image/jpeg', 80);
          if (imageBytes + bytes.length > (request.maxImageBytes ?? 2 * 1048576)) { result.warning = 'Image byte budget reached'; break; }
          imageBytes += bytes.length;
          result.images.push({ page: number, data: bytes.toString('base64'), mimeType: 'image/jpeg' });
        } else {
          const content = await page.getTextContent();
          const pageOffset = number === start ? Math.max(0, request.offset || 0) : 0;
          const text = `[Page ${number}]\n${content.items.map(i => 'str' in i ? i.str : '').join(' ')}\n`.slice(pageOffset);
          const left = charLimit - result.text.length;
          result.text += text.slice(0, left);
          if (text.length > left) {
            result.pages.push(number); result.nextPage = number;
            result.nextOffset = pageOffset + left;
            result.warning = 'Text truncated within last page; continue with nextPage and nextOffset';
            return result;
          }
        }
        result.pages.push(number); result.nextPage = number < doc.numPages ? number + 1 : null;
        page.cleanup();
      }
      result.partial = start !== 1 || result.nextPage !== null;
      return result;
    } finally { await task.destroy(); }
  } finally { if (temp) await fs.rm(temp, { recursive: true, force: true }); }
}
