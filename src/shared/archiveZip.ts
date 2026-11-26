/**
 * ZIP 只读解析（纯函数，零依赖——inflate 由调用方注入，渲染层传 fflate 的 inflateSync）：
 * 列目录 + 读单个条目。只解析中央目录（EOCD/zip64 EOCD 定位），不解压整个包——
 * 归档预览只列清单，pptx 大纲按需解压个别 XML（方法 0 stored / 8 deflate）。
 */
export type ZipInflate = (data: Uint8Array) => Uint8Array;

export interface ZipEntry {
  name: string;
  /** 未压缩字节数 */
  size: number;
  /** 压缩方法：0 stored / 8 deflate（其余值也能列出，读取时报错） */
  method: number;
  isDir: boolean;
  lastModified: string;
  /** 中央目录里的原始偏移等字段，readZipEntry 用 */
  localHeaderOffset: number;
  compressedSize: number;
}

const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const SIG_LOC64 = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;

function dosDateTime(time: number, date: number): string {
  const y = 1980 + (date >> 9);
  const mo = (date >> 5) & 0xf;
  const d = date & 0x1f;
  const h = time >> 11;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}

function findEocd(buf: Uint8Array): number {
  // EOCD 最短 22 字节，注释上限 65535；从尾部往前扫签名
  const min = 22;
  const start = Math.max(0, buf.length - min - 0xffff);
  for (let i = buf.length - min; i >= start; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      return i;
    }
  }
  throw new Error('ZIP: end of central directory not found (not a zip or truncated)');
}

function listZip64(buf: Uint8Array, dv: DataView, eocd: number): {
  count: number;
  cdOffset: number;
} | null {
  // zip64 定位器固定在 EOCD 前 20 字节
  if (eocd < 20) return null;
  const at = eocd - 20;
  if (dv.getUint32(at, true) !== SIG_LOC64) return null;
  const eocd64Offset = Number(dv.getBigUint64(at + 8, true));
  if (dv.getUint32(eocd64Offset, true) !== SIG_EOCD64) {
    throw new Error('ZIP: corrupted zip64 EOCD');
  }
  return {
    count: Number(dv.getBigUint64(eocd64Offset + 32, true)),
    cdOffset: Number(dv.getBigUint64(eocd64Offset + 48, true))
  };
}

/** 列出 zip 全部条目（中央目录顺序）。坏包/非 zip 抛错，由预览层转错误卡片 */
export function listZipEntries(buf: Uint8Array): ZipEntry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const eocd = findEocd(buf);
  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const z64 = listZip64(buf, dv, eocd);
    if (!z64) throw new Error('ZIP: zip64 required but zip64 EOCD not found');
    count = z64.count;
    cdOffset = z64.cdOffset;
  }

  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CEN) {
      throw new Error('ZIP: corrupted central directory');
    }
    const method = dv.getUint16(p + 10, true);
    const mtime = dv.getUint16(p + 12, true);
    const mdate = dv.getUint16(p + 14, true);
    let compressedSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localHeaderOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    // zip64：单条目 0xFFFFFFFF 时真实值在 extra field 0x0001（顺序 fixed：offset,size,csize）
    if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = dv.getUint16(e, true);
        const sz = dv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let f = e + 4;
          if (size === 0xffffffff) {
            size = Number(dv.getBigUint64(f, true));
            f += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(dv.getBigUint64(f, true));
            f += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(dv.getBigUint64(f, true));
          }
          break;
        }
        e += 4 + sz;
      }
    }
    out.push({
      name,
      size,
      method,
      isDir: name.endsWith('/'),
      lastModified: dosDateTime(mtime, mdate),
      localHeaderOffset,
      compressedSize
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读出单个条目的解压后字节（stored / deflate；目录返回空） */
export function readZipEntry(
  buf: Uint8Array,
  entry: ZipEntry,
  inflate: ZipInflate
): Uint8Array {
  if (entry.isDir) return new Uint8Array(0);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const at = entry.localHeaderOffset;
  if (at + 30 > buf.length || dv.getUint32(at, true) !== SIG_LOC) {
    throw new Error(`ZIP: corrupted local header (${entry.name})`);
  }
  const nameLen = dv.getUint16(at + 26, true);
  const extraLen = dv.getUint16(at + 28, true);
  const dataStart = at + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflate(raw);
  throw new Error(`ZIP: unsupported compression method ${entry.method} (${entry.name})`);
}
