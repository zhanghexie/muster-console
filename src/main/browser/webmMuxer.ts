/**
 * 最小 WebM 复用器：把带毫秒时间戳、已经编码的 VP8 帧封装为 Matroska 容器。
 * 每帧一个 Cluster，Segment 使用开放尺寸。browserRecording 先经 WebCodecs 把
 * CDP 的 JPEG 截屏转换为 VP8，再把编码块交给本模块；JPEG 不能直接作为 VP8 载荷。
 *
 * 格式依据：https://www.matroska.org/technical/notes.html#simpleblock-structure
 * 与 https://www.matroska.org/technical/elements.html（Duration 为浮点数）。
 */
import { randomBytes } from 'node:crypto';

export interface ScreencastFrame {
  /** 帧字节；muxWebm 的输入必须是 VP8 编码块，录屏采集阶段可暂存 JPEG。 */
  data: Uint8Array;
  /** 相对录制起点的毫秒时间戳（screencastFrame metadata.timestamp 差值） */
  timestampMs: number;
  /** 帧像素宽（首帧值写入 TrackEntry/Video；ffmpeg demuxer 建流需要） */
  width?: number;
  /** 帧像素高 */
  height?: number;
  /** 是否关键帧（缺省按关键帧写；VP8 delta 帧必须标 0 否则播放器解码失败） */
  key?: boolean;
}

/** 校验与归一化帧序列：≥1 帧、时间戳 clamp 非负、排序、同毫秒去重。 */
export function normalizeFrames(frames: ScreencastFrame[]): ScreencastFrame[] {
  if (!frames.length) throw new Error('webm: 至少需要一帧才能合成视频');
  const sorted = [...frames].sort((a, b) => a.timestampMs - b.timestampMs);
  const out: ScreencastFrame[] = [];
  let last = -1;
  for (const f of sorted) {
    const ts = Math.max(0, Math.round(f.timestampMs));
    if (ts === last) continue;
    out.push({ data: f.data, timestampMs: ts, ...(f.width && f.height ? { width: f.width, height: f.height } : {}), ...(f.key === false ? { key: false } : {}) });
    last = ts;
  }
  return out;
}

/** EBML 元素：id + 变长 size + payload。 */
function element(id: number[], payload: Uint8Array): Uint8Array {
  const sizeBytes = encodeSize(payload.length);
  const out = new Uint8Array(id.length + sizeBytes.length + payload.length);
  out.set(Uint8Array.from(id), 0);
  out.set(sizeBytes, id.length);
  out.set(payload, id.length + sizeBytes.length);
  return out;
}

/** EBML 变长 size 编码（1–8 字节，首字节前导 1 的个数即长度）。 */
function encodeSize(value: number): Uint8Array {
  for (let len = 1; len <= 8; len++) {
    const capacity = 2 ** (7 * len) - 1; // All value bits set is the reserved unknown-size marker.
    if (value < capacity) {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = len - 1; i >= 1; i--) {
        out[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      out[0] = (0x80 >> (len - 1)) | v;
      return out;
    }
  }
  throw new Error(`webm: 元素尺寸超限 ${value}`);
}

/** EBML 无符号整数存储（固定长度，高位在前）。 */
function ebmlUint(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  if (v > 0) throw new Error(`webm: 整数 ${value} 超出 ${length} 字节`);
  return out;
}

function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function ebmlFloat64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** 合成完整 .webm 字节流。 */
export function muxWebm(frames: ScreencastFrame[]): Uint8Array {
  const norm = normalizeFrames(frames);
  const chunks: Uint8Array[] = [];

  // ── EBML 头（DocType=webm, v1, MaxIDLength 4 / MaxSizeLength 8）──
  chunks.push(
    element(
      [0x1a, 0x45, 0xdf, 0xa3],
      concat([
        element([0x42, 0x86], ebmlUint(1, 1)),
        element([0x42, 0xf7], ebmlUint(1, 1)),
        element([0x42, 0xf2], ebmlUint(4, 1)),
        element([0x42, 0xf3], ebmlUint(8, 1)),
        element([0x42, 0x82], toUtf8('webm')),
        element([0x42, 0x87], ebmlUint(2, 1)),
        element([0x42, 0x85], ebmlUint(2, 1))
      ])
    )
  );

  // ── Segment（流式开放尺寸 01 FF*8：内容长度未知，播放器按子元素解析）──
  chunks.push(Uint8Array.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));

  const segmentBody: Uint8Array[] = [];

  // Info：TimecodeScale=1ms、MuxingApp、SegmentUID、Duration（末帧 +33ms）
  const durationMs = norm[norm.length - 1].timestampMs + 33;
  segmentBody.push(
    element(
      [0x15, 0x49, 0xa9, 0x66],
      concat([
        element([0x2a, 0xd7, 0xb1], ebmlUint(1_000_000, 4)),
        element([0x4d, 0x80], toUtf8('muster-browser')),
        element([0x73, 0xa4], randomBytes(16)),
        element([0x44, 0x89], ebmlFloat64(durationMs))
      ])
    )
  );

  // Tracks：TrackNumber=1 / UID=1 / Type=video(1) / CodecID=V_VP8 + Video(PixelWidth/Height)
  // —— Video master 与尺寸是 ffmpeg demuxer 建流的必要元素（实测缺失即报
  //    DEMUXER_ERROR_NO_SUPPORTED_STREAMS）
  const first = norm[0];
  const videoChildren: Uint8Array[] = [];
  if (first.width && first.height) {
    videoChildren.push(element([0xb0], ebmlUint(first.width, 2)));
    videoChildren.push(element([0xba], ebmlUint(first.height, 2)));
  }
  segmentBody.push(
    element(
      [0x16, 0x54, 0xae, 0x6b],
      element(
        [0xae],
        concat([
          element([0xd7], ebmlUint(1, 1)),
          element([0x73, 0xc5], ebmlUint(1, 1)),
          element([0x83], ebmlUint(1, 1)),
          element([0x86], toUtf8('V_VP8')),
          ...(videoChildren.length ? [element([0xe0], concat(videoChildren))] : [])
        ])
      )
    )
  );

  // Clusters：每帧一个（Timecode=绝对 ms，SimpleBlock 帧内相对 0 + 关键帧 flag）
  for (const f of norm) {
    const simpleHeader = Uint8Array.from([0x81, 0x00, 0x00, f.key === false ? 0x00 : 0x80]); // track vint=1, signed int16 timecode=0, flags
    const block = element([0xa3], concat([simpleHeader, f.data]));
    const cluster = element(
      [0x1f, 0x43, 0xb6, 0x75],
      concat([element([0xe7], ebmlUint(f.timestampMs, Math.max(2, Math.ceil((Math.log2(f.timestampMs + 1) || 1) / 8))) ), block])
    );
    segmentBody.push(cluster);
  }

  chunks.push(concat(segmentBody));
  return concat(chunks);
}
