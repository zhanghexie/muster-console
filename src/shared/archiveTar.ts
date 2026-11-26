/**
 * TAR 只读解析（纯函数）：ustar 头逐块走，支持 GNU 长名（type L）与 PAX path 覆盖（type x）。
 * gz 解压走标准 DecompressionStream（渲染层与 Node ≥18 都有）；非 tar 的 gz 当单文件条目。
 */
export interface TarEntry {
  name: string;
  size: number;
  isDir: boolean;
  /** '0' 文件 / '5' 目录 / 'L' GNU 长名 / 'x' PAX 扩展头（后者两类不进结果） */
  type: string;
  lastModified: string;
}

const BLOCK = 512;

function parseOctal(buf: Uint8Array, at: number, len: number): number {
  // GNU tar 大文件用 base-256（首字节最高位置 1，其余大端）
  if (buf[at] & 0x80) {
    let v = buf[at] & 0x7f;
    for (let i = 1; i < len; i++) v = v * 256 + buf[at + i];
    return v;
  }
  let v = 0;
  for (let i = 0; i < len; i++) {
    const c = buf[at + i];
    if (c === 0 || c === 0x20) break;
    if (c < 0x30 || c > 0x37) return 0;
    v = v * 8 + (c - 0x30);
  }
  return v;
}

function readName(buf: Uint8Array, at: number): string {
  let end = at;
  const max = at + 100;
  while (end < max && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(at, end));
}

function isZeroBlock(buf: Uint8Array, at: number): boolean {
  for (let i = 0; i < BLOCK; i++) {
    if (buf[at + i] !== 0) return false;
  }
  return true;
}

function formatTime(epoch: number): string {
  const d = new Date(epoch * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 遍历 tar 块流。损坏输入抛错，由预览层转错误卡片 */
export function listTarEntries(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  let at = 0;
  while (at + BLOCK <= buf.length) {
    if (isZeroBlock(buf, at)) break;
    let name = readName(buf, at);
    const size = parseOctal(buf, at + 124, 12);
    const type = String.fromCharCode(buf[at + 156] === 0 ? 0x30 : buf[at + 156]);
    const mtime = parseOctal(buf, at + 136, 12);
    // ustar：magic "ustar" 在 257，prefix 字段 345..455 与 name 拼接
    const magic = new TextDecoder().decode(buf.subarray(at + 257, at + 262));
    const prefix = magic === 'ustar' ? readName(buf, at + 345) : '';
    if (prefix && type === '0') name = `${prefix}/${name}`;

    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buf.length) throw new Error('TAR: truncated archive');

    if (type === 'L') {
      // GNU 长名：数据体就是下一个条目的名字（去掉结尾 NUL）
      pendingLongName = new TextDecoder().decode(buf.subarray(dataStart, dataEnd)).replace(/\0+$/, '');
    } else if (type === 'x' || type === 'g') {
      // PAX 扩展头："len key=value\n" 行序列；只关心 path
      const text = new TextDecoder().decode(buf.subarray(dataStart, dataEnd));
      const m = /(?:^|\n)\d+ path=([^\n]*)/.exec(text);
      if (m && type === 'x') pendingPaxPath = m[1];
    } else if (type === '0' || type === '\0' || type === '5' || type === '2' || type === '1') {
      const finalName = pendingLongName ?? pendingPaxPath ?? name;
      pendingLongName = null;
      pendingPaxPath = null;
      out.push({
        name: finalName.replace(/\/+$/, ''),
        size,
        isDir: type === '5' || finalName.endsWith('/'),
        type: type === '5' ? '5' : type,
        lastModified: formatTime(mtime)
      });
    }
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/** gzip 解压（渲染层 DecompressionStream；调用方负责捕获不支持场景） */
export async function gunzip(buf: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!DS) throw new Error('gzip decompression is not supported in this environment');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    }
    // DOM 类型把 pipeThrough 的 writable 元素定为 BufferSource，这里只能 any 桥接
  }).pipeThrough(new DS('gzip') as never);
  const out = await new Response(stream as never).arrayBuffer();
  return new Uint8Array(out);
}

/** tgz/gz 顶层入口：gunzip 后是 tar 就列清单，否则作为单文件条目返回 */
export async function listGzipEntries(buf: Uint8Array, fileName: string): Promise<TarEntry[]> {
  const raw = await gunzip(buf);
  // tar 头：第 257 位起是 "ustar"
  const magic = new TextDecoder().decode(raw.subarray(257, 262));
  if (magic === 'ustar') return listTarEntries(raw);
  const base = fileName.replace(/\.(t?gz|gzip)$/i, '') || 'content';
  return [
    {
      name: base,
      size: raw.length,
      isDir: false,
      type: '0',
      lastModified: ''
    }
  ];
}
