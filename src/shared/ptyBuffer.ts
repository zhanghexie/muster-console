export const PTY_MAX_BUFFER = 200_000;

export interface PtyChunkBuf {
  chunks: string[];
  len: number;
}

export function createPtyChunkBuf(): PtyChunkBuf {
  return { chunks: [], len: 0 };
}

/** 追加 chunk；超限从头部丢整块，必要时裁第一块。 */
export function appendPtyChunk(buf: PtyChunkBuf, data: string, max = PTY_MAX_BUFFER): void {
  if (!data) return;
  buf.chunks.push(data);
  buf.len += data.length;
  while (buf.len > max && buf.chunks.length > 1) {
    const dropped = buf.chunks.shift();
    if (dropped) buf.len -= dropped.length;
  }
  if (buf.len > max && buf.chunks.length === 1) {
    const only = buf.chunks[0] ?? '';
    const keep = only.slice(-max);
    buf.chunks[0] = keep;
    buf.len = keep.length;
  }
}

export function joinPtyChunks(buf: PtyChunkBuf): string {
  return buf.chunks.join('');
}
