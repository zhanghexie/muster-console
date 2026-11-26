/**
 * PPTX 大纲提取（纯函数）：pptx 是 zip 包，逐张 ppt/slides/slideN.xml 抽 <a:t> 文本段。
 * 不做版式还原——幻灯片预览以「大纲卡」形态呈现（序号 + 首段为题 + 其余正文）。
 */
import { listZipEntries, readZipEntry, type ZipInflate } from './archiveZip';

export interface PptxSlide {
  /** 1-based 幻灯片序号（slideN.xml 的 N） */
  n: number;
  /** 按 XML 出现顺序的文本段（已解码 XML 实体） */
  texts: string[];
}

export function pptxOutline(buf: Uint8Array, inflate: ZipInflate): PptxSlide[] {
  const entries = listZipEntries(buf);
  const slides: PptxSlide[] = [];
  const decoder = new TextDecoder();
  for (const e of entries) {
    const m = /^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name);
    if (!m || e.isDir) continue;
    const xml = decoder.decode(readZipEntry(buf, e, inflate));
    const texts: string[] = [];
    for (const tm of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) {
      const s = decodeXmlEntities(tm[1]);
      if (s) texts.push(s);
    }
    slides.push({ n: Number(m[1]), texts });
  }
  return slides.sort((a, b) => a.n - b.n);
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}
